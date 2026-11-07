import contextlib
import copy
import json
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from contract import HERE, FILL, MANIFEST, read_json, sha, validate_contract
from mkfx import build_log, write_workspace
from rubric import fill_answer, fields, behavior
from score import compare, normalize_usage, parse_turn, score_cell, ratios
from synthetic import RECALL, HIDDEN, STATUS, cell, events, write_events


class GrammarTests(unittest.TestCase):
    def test_exact_answers(self):
        for turn in FILL:
            expected = 'WARN: '+str(3+turn%9)+'\n'+MANIFEST['notices'].get(str(turn), 'NONE')
            self.assertEqual(fill_answer(expected, turn), [])

    def test_substrings_and_ambiguity(self):
        for text in ('WARN: 15\nNONE', 'WARN: 50\nNONE', 'part5.log\nNONE',
                     'not WARN: 5\nNONE', 'WARN: 5 or 6\nNONE', 'WARN: 5\nWARN: 5\nNONE',
                     'WARN: 5\nNONE\nNOTICE unexpected', 'WARN: 5?\nNONE',
                     'WARN: 5\nNOTICE: NONE maybe', 'WARN: 5\nNOTICE unexpected NONE'):
            with self.subTest(text=text):
                self.assertTrue(fill_answer(text, 2))
        self.assertTrue(fill_answer('WARN: 7\nNOTICE cache layer pinned to sqlite extra', 4))
        self.assertTrue(fill_answer('WARN: 7\nNOTICE cache layer pinned to sqlite\nNONE', 4))

    def test_memory_rubric(self):
        for name, text in [('recall',RECALL), ('hidden',HIDDEN), ('status',STATUS)]:
            self.assertEqual(fields(text, name), [])
        self.assertTrue(fields(RECALL.replace('port: 9310', 'port: 19310'), 'recall'))
        self.assertTrue(fields(RECALL+'port: 8642\n', 'recall'))
        self.assertTrue(fields(STATUS.replace('still failing','resolved'), 'status'))
        self.assertTrue(fields(HIDDEN.replace('9f2c71ab', '9f2c71ae'), 'hidden'))

    def test_fixture_and_prompts_frozen(self):
        prompts = validate_contract()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/'work'
            inventory = write_workspace(root)
            self.assertNotIn('truth.json', inventory)
            for turn in FILL:
                self.assertEqual((root/f'part{turn}.log').read_text(), build_log(turn)[0])
            self.assertIn('batch_size=250', prompts[12]['prompt'])
            self.assertEqual((root/'part13.log').read_text().splitlines()[300], 'INFO hidden batch_size 250')
            # Original non-oracle files only. Frozen independently against d9391c5.
            original = {k:v for k,v in inventory.items() if k != 'part13.log'}
            digest = sha(json.dumps(original, sort_keys=True).encode())
            self.assertEqual(digest, ORIGINAL_FIXTURES_SHA256)

    def test_cache_write_and_weighting(self):
        data = [dict(inputTokens=10,cacheReadTokens=990,cacheWriteTokens=100,outputTokens=1),
                dict(inputTokens=90,cacheReadTokens=10,cacheWriteTokens=0,outputTokens=1)]
        result = ratios(data)
        self.assertAlmostEqual(result['read_over_read_plus_input'], 1000/1100)
        self.assertAlmostEqual(result['actual_prompt_read_ratio'], 1000/1200)
        self.assertEqual(result['cacheWriteTokens'], 100)
        data[0].pop('cacheWriteTokens')
        self.assertIsNone(ratios(data)['actual_prompt_read_ratio'])


class UsageNormalizationTests(unittest.TestCase):
    def test_one_or_both_omitted_zero_buckets(self):
        cases = [
            (dict(inputTokens=10, outputTokens=3, totalTokens=13),
             ('cacheReadTokens', 'cacheWriteTokens')),
            (dict(inputTokens=10, outputTokens=3, cacheReadTokens=90, totalTokens=103),
             ('cacheWriteTokens',)),
            (dict(inputTokens=10, outputTokens=3, cacheWriteTokens=7, totalTokens=20),
             ('cacheReadTokens',)),
            (dict(inputTokens=0, outputTokens=0, totalTokens=0),
             ('cacheReadTokens', 'cacheWriteTokens'))]
        for raw, omitted in cases:
            with self.subTest(raw=raw):
                before = copy.deepcopy(raw)
                normalized, proof = normalize_usage(raw)
                self.assertEqual(proof, omitted)
                self.assertEqual(normalized, dict(raw, **{k: 0 for k in omitted}))
                self.assertEqual(raw, before)
                self.assertIsNot(normalized, raw)

    def test_positive_residual_never_infers_positive_or_zero(self):
        for known in ({}, {'cacheReadTokens': 90}, {'cacheWriteTokens': 7}):
            raw = dict(inputTokens=10, outputTokens=3, **known)
            raw['totalTokens'] = sum(raw.values()) + 1
            with self.subTest(raw=raw):
                self.assertEqual(normalize_usage(raw), (raw, ()))
                result = ratios([raw])
                self.assertIsNone(result['actual_prompt_read_ratio'])
                for key in ('cacheReadTokens', 'cacheWriteTokens'):
                    if key not in raw:
                        self.assertIsNone(result[key])
                        self.assertEqual(result['usage_normalization']['unknown_fields'][key], 1)
                self.assertEqual(result['usage_normalization']['proven_zero_steps'], 0)

    def test_missing_total_leaves_omissions_unknown(self):
        for known in ({}, {'cacheReadTokens': 90}, {'cacheWriteTokens': 7}):
            raw = dict(inputTokens=10, outputTokens=3, **known)
            with self.subTest(raw=raw):
                self.assertEqual(normalize_usage(raw), (raw, ()))
                result = ratios([raw])
                self.assertIsNone(result['actual_prompt_read_ratio'])
                self.assertEqual(result['usage_normalization']['proven_zero_steps'], 0)

    def test_negative_residual_and_inconsistent_explicit_totals_fail(self):
        for known in ({}, {'cacheReadTokens': 90}, {'cacheWriteTokens': 7},
                      {'cacheReadTokens': 90, 'cacheWriteTokens': 7}):
            raw = dict(inputTokens=10, outputTokens=3, **known)
            raw['totalTokens'] = sum(raw.values()) - 1
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(ValueError, 'inconsistent totalTokens'):
                    ratios([raw])
        for delta in (-1, 1):
            raw = dict(inputTokens=10, outputTokens=3, cacheReadTokens=90,
                       cacheWriteTokens=7, totalTokens=110 + delta)
            with self.assertRaisesRegex(ValueError, 'inconsistent totalTokens'):
                normalize_usage(raw)

    def test_all_known_counters_must_be_nonnegative_integers(self):
        for key in ('inputTokens', 'outputTokens', 'cacheReadTokens',
                    'cacheWriteTokens', 'totalTokens', 'reasoningTokens'):
            for invalid in (-1, 1.5, True, False, None, '0'):
                with self.subTest(key=key, invalid=invalid):
                    raw = dict(inputTokens=10, outputTokens=3, totalTokens=13)
                    raw[key] = invalid
                    with self.assertRaises(ValueError):
                        normalize_usage(raw)
        for raw in (None, [], {}, {'inputTokens': 10}, {'outputTokens': 3}):
            with self.assertRaises(ValueError):
                normalize_usage(raw)

    def test_explicit_nonzero_counters_and_ratios_are_preserved(self):
        raw = dict(inputTokens=10, outputTokens=3, cacheReadTokens=90,
                   cacheWriteTokens=7, totalTokens=110, reasoningTokens=2)
        self.assertEqual(normalize_usage(raw), (raw, ()))
        result = ratios([raw])
        self.assertEqual(result['read_over_read_plus_input'], .9)
        self.assertEqual(result['actual_prompt_read_ratio'], 90/107)
        self.assertEqual(result['cacheWriteTokens'], 7)
        self.assertEqual(result['usage_normalization']['proven_zero_steps'], 0)
        raw.pop('totalTokens')
        self.assertEqual(ratios([raw])['actual_prompt_read_ratio'], 90/107)

    def test_reasoning_is_already_in_output(self):
        raw = dict(inputTokens=10, outputTokens=3, reasoningTokens=2, totalTokens=13)
        self.assertEqual(normalize_usage(raw)[1], ('cacheReadTokens', 'cacheWriteTokens'))
        raw['totalTokens'] += 2
        self.assertEqual(normalize_usage(raw)[1], ())

    def test_weighted_metrics_and_separate_proof_counts(self):
        data = [dict(inputTokens=10, outputTokens=2, cacheReadTokens=90, totalTokens=102),
                dict(inputTokens=8, outputTokens=2, totalTokens=10),
                dict(inputTokens=2, outputTokens=0, cacheReadTokens=0, cacheWriteTokens=3, totalTokens=5)]
        before = copy.deepcopy(data)
        result = ratios(data)
        self.assertEqual(data, before)
        self.assertEqual(result['read_over_read_plus_input'], 90/110)
        self.assertEqual(result['actual_prompt_read_ratio'], 90/113)
        self.assertEqual(result['usage_normalization'], dict(
            proven_zero_steps=2,
            proven_zero_fields=dict(cacheReadTokens=1, cacheWriteTokens=2),
            explicit_fields=dict(cacheReadTokens=2, cacheWriteTokens=1),
            unknown_fields=dict(cacheReadTokens=0, cacheWriteTokens=0)))
        data.append(dict(inputTokens=1, outputTokens=1, totalTokens=3))
        result = ratios(data)
        self.assertIsNone(result['cacheReadTokens'])
        self.assertIsNone(result['cacheWriteTokens'])
        self.assertIsNone(result['read_over_read_plus_input'])
        self.assertIsNone(result['actual_prompt_read_ratio'])
        self.assertEqual(result['usage_normalization']['proven_zero_steps'], 2)
        self.assertEqual(result['usage_normalization']['unknown_fields'],
                         dict(cacheReadTokens=1, cacheWriteTokens=1))

    def test_empty_metrics_do_not_invent_evidence(self):
        result = ratios([])
        self.assertEqual(result['steps'], 0)
        self.assertIsNone(result['cacheReadTokens'])
        self.assertIsNone(result['actual_prompt_read_ratio'])
        self.assertEqual(result['usage_normalization']['proven_zero_steps'], 0)

    def parse_usage(self, usage, answer=None):
        with tempfile.TemporaryDirectory() as tmp:
            cwd, path = Path(tmp)/'work', Path(tmp)/'turn.jsonl'
            items = events(2, cwd, 'sid')
            for ev in items:
                if ev.get('phase') == 'step_end':
                    ev['usage'] = copy.deepcopy(usage)
            if answer is not None:
                items[-1]['text'] = answer
            write_events(path, items)
            original = path.read_bytes()
            result = parse_turn(path, 2, cwd, 'sid')
            self.assertEqual(path.read_bytes(), original)
            return result

    def test_parser_logs_proofs_without_rewriting_raw_usage(self):
        usage = dict(inputTokens=10, outputTokens=3, totalTokens=13)
        result = self.parse_usage(usage)
        self.assertEqual(result['evidence_errors'], [])
        self.assertEqual(result['usage'], [usage, usage])
        self.assertEqual(result['first_step_usage'], usage)
        self.assertEqual(result['last_step_usage'], usage)
        self.assertEqual(result['usage_zero_proofs'], [dict(
            step=step, fields=['cacheReadTokens', 'cacheWriteTokens'],
            totalTokens=13, knownTokens=13, residual=0) for step in (1, 2)])

    def test_parser_keeps_unresolved_omissions_unknown(self):
        for usage in (dict(inputTokens=10, outputTokens=3),
                      dict(inputTokens=10, outputTokens=3, totalTokens=14)):
            result = self.parse_usage(usage)
            self.assertEqual(result['evidence_errors'], [])
            self.assertEqual(result['usage_zero_proofs'], [])
            self.assertIsNone(ratios(result['usage'])['actual_prompt_read_ratio'])

    def test_parser_rejects_inconsistent_totals_with_omissions(self):
        for usage in (dict(inputTokens=10, outputTokens=3, totalTokens=12),
                      dict(inputTokens=10, outputTokens=3, totalTokens=-1),
                      dict(inputTokens=10, outputTokens=3, cacheReadTokens=90,
                           cacheWriteTokens=7, totalTokens=111)):
            with self.assertRaises(ValueError):
                self.parse_usage(usage)

    def test_proven_zeros_cannot_excuse_wrong_answers(self):
        result = self.parse_usage(dict(inputTokens=10, outputTokens=3, totalTokens=13),
                                  answer='WARN: 15\nNONE')
        self.assertEqual(result['evidence_errors'], [])
        self.assertTrue(result['usage_zero_proofs'])
        self.assertTrue(result['quality_errors'])


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path(self.tmp.name)/'work'
        self.cwd.mkdir()
        self.path = Path(self.tmp.name)/'turn.jsonl'
        self.items = events(2, self.cwd, 'sid')

    def check_bad(self, items=None):
        write_events(self.path, items if items is not None else self.items)
        try:
            parsed = parse_turn(self.path, 2, self.cwd, 'sid')
        except (ValueError, KeyError, TypeError):
            return
        self.assertTrue(parsed['evidence_errors'] or parsed['quality_errors'])

    def grep_events(self, turn=2, pattern='WARN'):
        items = events(turn, self.cwd, 'sid')
        call = next(x for x in items if x['type'] == 'tool_call')
        result = next(x for x in items if x['type'] == 'tool_result')
        call.update(tool='grep', input={'path': str(self.cwd/f'part{turn}.log'), 'pattern': pattern})
        prefixes = ('WARN', 'NOTICE') if pattern == '(?i)warn|notice' else (pattern,)
        rows = [f'Line {n}: {line}' for n, line in enumerate(build_log(turn)[0].splitlines(), 1)
                if line.startswith(prefixes)]
        result['result'] = (f'Found {len(rows)} matches\n\npart{turn}.log\n' + '\n'.join(rows)
                            if rows else 'No matches found')
        return items, call, result

    def parse_items(self, items, turn=2):
        write_events(self.path, items)
        return parse_turn(self.path, turn, self.cwd, 'sid')

    def test_builtin_grep_frozen_matches(self):
        for turn in FILL:
            for pattern in ('WARN', 'NOTICE', '(?i)warn|notice'):
                if pattern == 'NOTICE' and str(turn) not in MANIFEST['notices']:
                    continue
                for ending in ('', '\n'):
                    with self.subTest(turn=turn, pattern=pattern, ending=repr(ending)):
                        items, _, result = self.grep_events(turn, pattern)
                        result['result'] += ending
                        parsed = self.parse_items(items, turn)
                        self.assertTrue(parsed['expected_read'])
                        self.assertEqual(parsed['evidence_errors'], [])
                        self.assertEqual(parsed['quality_errors'], [])

    def test_builtin_grep_no_match_requires_nonempty_proof(self):
        items, _, _ = self.grep_events(pattern='NOTICE')
        parsed = self.parse_items(items)
        self.assertFalse(parsed['expected_read'])
        self.assertEqual(parsed['evidence_errors'], ['no successful correlated read of expected file'])
        self.assertEqual(parsed['quality_errors'], [])
        # Historical turn 2: WARN, absent NOTICE, then combined search.
        for pattern in ('WARN', '(?i)warn|notice'):
            _, call, result = self.grep_events(pattern=pattern)
            call['callId'] = result['callId'] = pattern
            items[3:3] = [call, result]
        parsed = self.parse_items(items)
        self.assertTrue(parsed['expected_read'])
        self.assertEqual(parsed['evidence_errors'], [])

    def test_builtin_grep_rejects_wrong_paths_and_arguments(self):
        invalid = [dict(path=str(self.cwd/'part3.log')),
                   dict(path=str(self.cwd.parent/'part2.log')),
                   dict(path=str(self.cwd)), dict(path=str(self.cwd/'part*.log')),
                   dict(path=None), dict(pattern=None), dict(pattern=['WARN']),
                   dict(pattern='WARN|NOTICE'), dict(pattern='^(a+)+$'),
                   dict(pattern=''), dict(include='*.log'), dict(context=1)]
        for changes in invalid:
            with self.subTest(changes=changes):
                items, call, _ = self.grep_events()
                call['input'].update(changes)
                self.check_bad(items)
        for key in ('path', 'pattern'):
            items, call, _ = self.grep_events()
            del call['input'][key]
            self.check_bad(items)
        items, call, _ = self.grep_events()
        call['tool'] = 'custom_grep'
        self.check_bad(items)

    def test_builtin_grep_rejects_fabricated_output(self):
        body = self.grep_events()[2]['result']
        first = 'Line 181: WARN ledger drift turn=2 n=0'
        second = 'Line 188: WARN ledger drift turn=2 n=1'
        invalid = [body.replace('part2.log', 'part3.log'),
                   body.replace('part2.log', str(self.cwd/'part2.log')),
                   body.replace('\n\npart2.log', '\npart2.log'),
                   body.replace(first, first+' altered'),
                   body.replace('Line 181:', 'Line 0:'),
                   body.replace('Line 181:', 'Line 521:'),
                   body.replace(first, 'Line 1: '+build_log(2)[0].splitlines()[0]),
                   body.replace(second, first), body.replace(second+'\n', ''),
                   body.replace(first+'\n'+second, second+'\n'+first),
                   body+'\n'+first, body+'\n\n', body+'\nextra output',
                   body.replace('Line 181:', 'Line 0181:')]
        invalid += [body.replace('Found 5 matches', f'Found {count} matches')
                    for count in ('0', '4', '6', '-5', '5.0', '05', '9'*5000)]
        for index, forged in enumerate(invalid):
            for truncated in (False, True):
                with self.subTest(case=index, truncated=truncated):
                    items, _, result = self.grep_events()
                    result.update(result=forged, truncated=truncated)
                    parsed = self.parse_items(items)
                    self.assertFalse(parsed['expected_read'])
                    self.assertTrue(parsed['evidence_errors'])
        items, _, result = self.grep_events(pattern='NOTICE')
        result['result'] = body
        self.assertFalse(self.parse_items(items)['expected_read'])

    def test_builtin_grep_projection_prefix_requires_complete_match(self):
        body = self.grep_events()[2]['result']
        second = body.index('Line 188:')
        for end in (second, second+12):
            with self.subTest(end=end):
                items, _, result = self.grep_events()
                result.update(result=body[:end], truncated=True)
                parsed = self.parse_items(items)
                self.assertTrue(parsed['expected_read'])
                self.assertEqual(parsed['evidence_errors'], [])
                self.assertEqual(parsed['projection_truncations'], 1)
                result.pop('truncated')
                self.assertFalse(self.parse_items(items)['expected_read'])
        for prefix in ('', 'Found 5 matches\n\npart2.log\n', body[:second-2],
                       body[:second+12]+'fabricated'):
            items, _, result = self.grep_events()
            result.update(result=prefix, truncated=True)
            self.assertFalse(self.parse_items(items)['expected_read'])

    def test_builtin_grep_keeps_pairing_and_infrastructure_failures(self):
        for change in ('unpaired', 'missing', 'duplicate', 'error', 'timeout', 'event', 'essential'):
            with self.subTest(change=change):
                items, call, result = self.grep_events()
                if change == 'unpaired':
                    result['callId'] = 'other'
                elif change == 'missing':
                    items.remove(result)
                elif change == 'duplicate':
                    items.insert(5, copy.deepcopy(result))
                elif change == 'error':
                    result['status'] = 'error'
                elif change == 'timeout':
                    result['result'] += '\n[Command timed out]'
                elif change == 'event':
                    items.insert(5, dict(type='error'))
                else:
                    call['truncated'] = True
                self.check_bad(items)

    def test_builtin_grep_does_not_relax_answer_grammar(self):
        for answer in ('WARN: 15\nNONE', 'WARN: 5 or 6\nNONE',
                       'WARN: 5\nNONE\nNOTICE invented'):
            items, _, _ = self.grep_events()
            items[-1]['text'] = answer
            parsed = self.parse_items(items)
            self.assertTrue(parsed['expected_read'])
            self.assertEqual(parsed['evidence_errors'], [])
            self.assertTrue(parsed['quality_errors'])

    def test_empty_final(self):
        self.items[-1]['text'] = ''
        self.check_bad()

    def test_missing_final(self):
        self.check_bad(self.items[:-1])

    def test_numeric_substring(self):
        self.items[-1]['text'] = 'WARN: 15\nNONE'
        self.check_bad()

    def test_tool_result_id_mismatch(self):
        next(x for x in self.items if x['type']=='tool_result')['callId'] = 'other'
        self.check_bad()

    def test_wrong_expected_filename(self):
        next(x for x in self.items if x['type']=='tool_call')['input']['file_path'] = 'part3.log'
        self.check_bad()

    def test_result_filename_mismatch(self):
        tool = next(x for x in self.items if x['type']=='tool_result')
        tool['result'] = tool['result'].replace('part2.log','part3.log')
        self.check_bad()

    def test_fake_read_unrelated_output(self):
        next(x for x in self.items if x['type']=='tool_result')['result'] = '5'
        self.check_bad()

    def test_tool_error(self):
        next(x for x in self.items if x['type']=='tool_result')['status'] = 'error'
        self.check_bad()

    def test_missing_usage(self):
        next(x for x in self.items if x.get('phase')=='step_end').pop('usage')
        self.check_bad()

    def test_optional_fields_are_optional(self):
        for ev in self.items:
            if 'usage' in ev:
                for key in ('cacheReadTokens','cacheWriteTokens','totalTokens'):
                    ev['usage'].pop(key)
        write_events(self.path, self.items)
        result = parse_turn(self.path,2,self.cwd,'sid')
        self.assertEqual(result['evidence_errors'], [])
        self.assertIsNone(ratios(result['usage'])['read_over_read_plus_input'])
        self.assertIsNone(result['transport_retries'])
        self.assertIsNone(result['request_finish_reason'])

    def test_completed_shell_nonzero_is_failure(self):
        self.items.insert(3,dict(type='tool_call',callId='shell',tool='bash',input={'command':'false'}))
        self.items.insert(4,dict(type='tool_result',callId='shell',status='completed',result='[exit code: 7]'))
        self.check_bad()

    def test_projection_truncation_preserves_real_read_proof(self):
        result=next(x for x in self.items if x['type']=='tool_result')
        result['truncated']=True
        result['result']=result['result'].split('\n</content>')[0]+'\n2: INFO incomplete pro'
        write_events(self.path,self.items)
        parsed=parse_turn(self.path,2,self.cwd,'sid')
        self.assertEqual(parsed['evidence_errors'],[])
        self.assertEqual(parsed['projection_truncations'],1)
        next(x for x in self.items if x['type']=='tool_call')['truncated']=True
        self.check_bad()

    def test_missing_first_usage_never_becomes_second_step(self):
        next(x for x in self.items if x.get('phase')=='step_end').pop('usage')
        write_events(self.path,self.items)
        parsed=parse_turn(self.path,2,self.cwd,'sid')
        self.assertTrue(parsed['usage'])
        self.assertIsNone(parsed['first_step_usage'])
        self.assertTrue(parsed['evidence_errors'])

    def test_missing_last_usage_never_uses_earlier_request(self):
        steps=[x for x in self.items if x.get('phase')=='step_end']
        steps[-1].pop('usage')
        write_events(self.path,self.items)
        parsed=parse_turn(self.path,2,self.cwd,'sid')
        self.assertIsNotNone(parsed['first_step_usage'])
        self.assertIsNone(parsed['last_step_usage'])
        self.assertTrue(parsed['evidence_errors'])

    def test_session_reset(self):
        self.items[0]['sessionId']='new-session'
        self.check_bad()

    def test_malformed_events(self):
        for raw in ('{broken}\n', 'banner\n', '{"type":"session","type":"final"}\n',
                    '{"type":"status","usage":NaN}\n', '[]\n', '{"type":"error"}'):
            self.path.write_text(raw)
            with self.assertRaises((ValueError, KeyError, TypeError)):
                parse_turn(self.path,2,self.cwd,'sid')

    def test_step_pairing_and_turn_termination(self):
        for index, change in [(1,{'turn':1}), (2,{'step':9}), (-2,{'reason':{'kind':'error'}})]:
            items = copy.deepcopy(self.items)
            items[index].update(change)
            self.check_bad(items)

    def test_double_final_and_unknown_type(self):
        self.check_bad(self.items + [dict(type='final',text='WARN: 5\nNONE')])
        self.check_bad(self.items[:-1]+[dict(type='made_up')]+self.items[-1:])


class FullCellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)/'candidate'
        cls.stock = Path(cls.tmp.name)/'stock'
        cell(cls.root)
        cell(cls.stock,'stock')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @contextlib.contextmanager
    def changed(self, path, data):
        old = path.read_bytes() if path.exists() else None
        path.write_bytes(data)
        try:
            yield
        finally:
            if old is None:
                path.unlink()
            else:
                path.write_bytes(old)

    @contextlib.contextmanager
    def bad_answer(self, root, answer='WARN: 15\nNONE'):
        path = root/'runs/spine-1/t2.jsonl'
        items = [json.loads(x) for x in path.read_text().splitlines()]
        items[-1]['text'] = answer
        data = ''.join(json.dumps(x)+'\n' for x in items).encode()
        with contextlib.ExitStack() as stack:
            stack.enter_context(self.changed(path, data))
            for suffix in ('.meta.json','.process.json'):
                target=path.with_suffix(suffix)
                meta=read_json(target);meta['stdout_sha256']=sha(data)
                stack.enter_context(self.changed(target,json.dumps(meta).encode()))
            yield

    def test_complete_fixed_denominator(self):
        report=score_cell(self.root)
        self.assertTrue(report['gate_pass'], report['evidence_errors'][:3]+report['quality_errors'][:3])
        self.assertEqual((report['complete_turns'],report['planned_turns'],report['fill_correct'],report['planned_fill']), (310,310,230,230))
        self.assertEqual(report['groups'][0]['t27_last_request_totalTokens'],1011)
        self.assertEqual(report['groups'][0]['t31_last_request_totalTokens'],1010)
        self.assertGreater(report['first_step']['read_over_read_plus_input'],report['all_steps']['read_over_read_plus_input'])
        self.assertFalse(report['cache_release_pass'])
        self.assertFalse((self.root/'work/spine-1/recall.md').exists())

    def test_complete_cell_allows_proven_archive_but_still_rejects_reads(self):
        group = self.root/'runs/spine-1'
        cwd = self.root/'work/spine-1'
        path = group/'t30.jsonl'
        original = [json.loads(x) for x in path.read_text().splitlines()]
        command = 'mkdir -p trash; mv part*.log trash/'
        with contextlib.ExitStack() as snapshots:
            # Carry the verified movement through both remaining snapshots.
            for turn in (30, 31):
                target = group/f't{turn}.snapshot.json'
                snap = read_json(target)
                for name in list(snap['files']):
                    if name.startswith('part'):
                        snap['files']['trash/'+name] = snap['files'].pop(name)
                data = json.dumps(snap).encode()
                snapshots.enter_context(self.changed(target, data))
                target = group/f't{turn}.meta.json'
                meta = read_json(target);meta['snapshot_sha256'] = sha(data)
                snapshots.enter_context(self.changed(target, json.dumps(meta).encode()))
            for shell, allowed in ((command, True), (command+'; cat trash/part2.log', False)):
                with self.subTest(shell=shell), contextlib.ExitStack() as logs:
                    items = copy.deepcopy(original)
                    items[3:3] = [dict(type='tool_call', callId='archive', tool='bash',
                                      input={'command':shell, 'workdir':str(cwd)}),
                                  dict(type='tool_result', callId='archive', status='completed',
                                       result='[exit code: 0]')]
                    data = ''.join(json.dumps(x)+'\n' for x in items).encode()
                    logs.enter_context(self.changed(path, data))
                    for suffix in ('.meta.json', '.process.json'):
                        target = path.with_suffix(suffix)
                        meta = read_json(target);meta['stdout_sha256'] = sha(data)
                        logs.enter_context(self.changed(target, json.dumps(meta).encode()))
                    report = score_cell(self.root)
                    self.assertTrue(report['evidence_pass'], report['evidence_errors'])
                    self.assertEqual(report['gate_pass'], allowed, report['quality_errors'])
                    self.assertEqual((report['complete_turns'], report['planned_turns'],
                                      report['fill_correct'], report['planned_fill']), (310, 310, 230, 230))
                    if not allowed:
                        self.assertIn('g1/t30: forbidden part log reread', report['quality_errors'])

    def test_turn29_import_aliases_cannot_hide_reads_in_complete_evidence(self):
        group = self.root/'runs/spine-1'
        path = group/'t29.jsonl'
        original = [json.loads(x) for x in path.read_text().splitlines()]
        for alias in ('str', 'print', 'open', 'reader', 'read_text'):
            command = (f"python3 -c 'from pathlib import Path as {alias}; "
                       f'{alias}("part" + "14.log").read_text()' + "'")
            with self.subTest(alias=alias), contextlib.ExitStack() as logs:
                items = copy.deepcopy(original)
                items[3:3] = [dict(type='tool_call', callId='alias-read', tool='bash',
                                  input={'command':command, 'workdir':str(self.root/'work/spine-1')}),
                              dict(type='tool_result', callId='alias-read', status='completed',
                                   result='[exit code: 0]')]
                data = ''.join(json.dumps(x)+'\n' for x in items).encode()
                logs.enter_context(self.changed(path, data))
                for suffix in ('.meta.json', '.process.json'):
                    target = path.with_suffix(suffix)
                    meta = read_json(target);meta['stdout_sha256'] = sha(data)
                    logs.enter_context(self.changed(target, json.dumps(meta).encode()))
                report = score_cell(self.root)
                self.assertTrue(report['evidence_pass'], report['evidence_errors'])
                self.assertEqual((report['complete_turns'],report['fill_correct']), (310,230))
                self.assertFalse(report['hard_quality_pass'])
                self.assertFalse(report['gate_pass'])
                self.assertTrue(any(x.startswith('g1/t29: unauditable tool behavior;')
                                    for x in report['tool_behavior_errors']))

    def test_candidate_wrong_nonzero_stock_wrong_reported(self):
        for root in (self.root,self.stock):
            with self.bad_answer(root):
                report=score_cell(root)
                self.assertTrue(report['evidence_pass'])
                self.assertEqual(report['fill_correct'],229)
                self.assertFalse(report['answer_pass'])
                self.assertEqual(report['gate_pass'],root == self.stock)

    def test_sample_cannot_hide_wrong_count_in_complete_cell(self):
        answer = 'WARN: 5\nNONE\nThere are 6 WARN lines. Example: WARN ledger drift turn=2 n=0'
        with self.bad_answer(self.root, answer):
            report = score_cell(self.root)
            self.assertTrue(report['evidence_pass'])
            self.assertFalse(report['gate_pass'])
            self.assertEqual((report['complete_turns'], report['planned_turns'],
                              report['fill_correct'], report['planned_fill']), (310, 310, 229, 230))
            self.assertEqual((report['warn_correct'], report['notice_correct']), (229, 230))

    def test_wrong_candidate_cli_nonzero(self):
        with self.bad_answer(self.root):
            result=subprocess.run([sys.executable,str(HERE/'score.py'),'--root',str(self.root)],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
            self.assertEqual(result.returncode,1,result.stderr.decode())
            self.assertFalse(json.loads(result.stdout)['gate_pass'])

    def test_artifact_text_must_match_actual_file_hash(self):
        path=self.root/'runs/spine-1/t29.snapshot.json'
        meta_path=self.root/'runs/spine-1/t29.meta.json'
        snap=read_json(path);snap['files'].pop('hidden.md')
        data=json.dumps(snap).encode()
        meta=read_json(meta_path);meta['snapshot_sha256']=sha(data)
        with self.changed(path,data),self.changed(meta_path,json.dumps(meta).encode()):
            self.assertFalse(score_cell(self.root)['gate_pass'])

    def test_model_validation_error_is_quality_and_preserves_cell_accounting(self):
        path = self.root/'runs/spine-1/t2.jsonl'
        items = [json.loads(x) for x in path.read_text().splitlines()]
        target = str(self.root/'work/spine-1/conf/settings.local.toml')
        items[3:3] = [dict(type='tool_call', callId='validation', tool='edit',
                          input={'file_path':target, 'old_string':'port = 8642', 'new_string':'port = 9310'}),
                      dict(type='tool_result', callId='validation', status='error',
                           result=f'Error: cannot modify "{target}": file has not been read — read the file, then retry')]
        data = ''.join(json.dumps(x)+'\n' for x in items).encode()
        with contextlib.ExitStack() as stack:
            stack.enter_context(self.changed(path, data))
            for suffix in ('.meta.json', '.process.json'):
                target_meta = path.with_suffix(suffix)
                meta = read_json(target_meta);meta['stdout_sha256'] = sha(data)
                stack.enter_context(self.changed(target_meta, json.dumps(meta).encode()))
            report = score_cell(self.root)
            self.assertTrue(report['evidence_pass'])
            self.assertEqual((report['complete_turns'], report['planned_turns']), (310, 310))
            self.assertEqual((report['expected_reads'], report['warn_correct'], report['notice_correct']), (230, 230, 230))
            self.assertEqual((report['model_tool_errors'], report['fill_correct']), (1, 229))
            self.assertEqual(report['all_steps']['steps'], 540)
            self.assertFalse(report['gate_pass'])

    def test_stale_group_marker_rejected(self):
        with self.changed(self.root/'runs/spine-1/DONE',b'DONE\n'):
            self.assertFalse(score_cell(self.root)['gate_pass'])

    def test_missing_turn_not_skipped(self):
        path=self.root/'runs/spine-1/t31.jsonl'
        old=path.read_bytes();path.unlink()
        try:
            report=score_cell(self.root)
            self.assertFalse(report['gate_pass'])
            self.assertEqual(report['planned_turns'],310)
            self.assertEqual(report['complete_turns'],309)
        finally:
            path.write_bytes(old)

    def test_stock_incomplete_rejected(self):
        path=self.stock/'runs/spine-1/t2.jsonl'
        with self.changed(path,b'{}\n'):
            self.assertFalse(score_cell(self.stock)['gate_pass'])

    def test_stale_done_and_changed_code(self):
        with self.changed(self.root/'DONE',b'DONE\n'):
            self.assertFalse(score_cell(self.root)['gate_pass'])
        path=self.root/'attempt.json';run=read_json(path)
        run['fingerprints']['score.py']='bad'
        with self.changed(path,json.dumps(run).encode()):
            with self.assertRaises(ValueError):
                score_cell(self.root)

    def test_late_turn_rubric_and_no_tools(self):
        group=self.root/'runs/spine-1'
        initial=read_json(group/'initial.json')
        for turn in (29,30,31):
            snap=read_json(group/f't{turn}.snapshot.json')
            self.assertEqual(behavior(turn,[],snap,initial),[])
            key={29:'hidden.md',30:'conf/settings.local.toml',31:'docs/STATUS.md'}[turn]
            snap['texts'][key]=''
            self.assertTrue(behavior(turn,[],snap,initial))
        snap=read_json(group/'t28.snapshot.json')
        call=dict(tool='read',input={'file_path':'recall.md'})
        self.assertTrue(behavior(28,[call],snap,initial))
        for call in (dict(tool='bash',input={'command':'./check.sh'}), dict(tool='read',input={'file_path':'part22.log'})):
            self.assertTrue(behavior(29,[call],snap,initial))

    def test_cache_comparability_and_frozen_budgets(self):
        a,b=score_cell(self.root),score_cell(self.stock)
        report=compare(a,b)
        self.assertTrue(report['cache_comparison_pass'],report)
        self.assertFalse(report['cache_release_pass'])
        for key in ('model','route','host','dependencies','parameters','cache_warmup','usage_semantics','package_sha256'):
            bad=copy.deepcopy(b);bad['spec'][key]='different'
            self.assertFalse(compare(a,bad)['cache_comparison_pass'],key)
        bad=copy.deepcopy(a);bad['first_step']['read_over_read_plus_input']=.98
        self.assertFalse(compare(bad,b)['cache_comparison_pass'])
        bad=copy.deepcopy(a);bad['all_steps']['inputTokens']*=1.051
        self.assertFalse(compare(bad,b)['cache_comparison_pass'])
        bad=copy.deepcopy(a);bad['all_steps']['cacheWriteTokens']=None
        self.assertFalse(compare(bad,b)['cache_comparison_pass'])
        bad=copy.deepcopy(b);bad['evidence_pass']=False
        self.assertFalse(compare(a,bad)['cache_comparison_pass'])

    @contextlib.contextmanager
    def changed_usage(self, root, usage):
        # Rewrite synthetic test evidence only, including its integrity records.
        path = root/'runs/spine-1/t2.jsonl'
        items = [json.loads(x) for x in path.read_text().splitlines()]
        for ev in items:
            if ev.get('phase') == 'step_end':
                ev['usage'] = copy.deepcopy(usage)
        data = ''.join(json.dumps(x)+'\n' for x in items).encode()
        with contextlib.ExitStack() as stack:
            stack.enter_context(self.changed(path, data))
            for suffix in ('.meta.json', '.process.json'):
                target = path.with_suffix(suffix)
                meta = read_json(target)
                meta['stdout_sha256'] = sha(data)
                stack.enter_context(self.changed(target, json.dumps(meta).encode()))
            yield
            self.assertEqual(path.read_bytes(), data)

    def test_proven_zero_metrics_are_comparable_to_explicit_zeros(self):
        omitted = dict(inputTokens=10, outputTokens=8, cacheReadTokens=990, totalTokens=1008)
        explicit = dict(omitted, cacheWriteTokens=0)
        with self.changed_usage(self.root, omitted), self.changed_usage(self.stock, explicit):
            a, b = score_cell(self.root), score_cell(self.stock)
            self.assertTrue(a['gate_pass'])
            self.assertEqual(a['first_step']['usage_normalization']['proven_zero_steps'], 1)
            self.assertEqual(a['all_steps']['usage_normalization']['proven_zero_steps'], 2)
            self.assertEqual(b['all_steps']['usage_normalization']['proven_zero_steps'], 0)
            self.assertEqual(a['usage_zero_proofs'], [dict(
                group=1, turn=2, step=step, fields=['cacheWriteTokens'],
                totalTokens=1008, knownTokens=1008, residual=0) for step in (1, 2)])
            for section in ('first_step', 'all_steps'):
                for key in ('read_over_read_plus_input', 'actual_prompt_read_ratio'):
                    self.assertEqual(a[section][key], b[section][key])
            report = compare(a, b)
            self.assertTrue(report['cache_comparison_pass'], report['errors'])
            self.assertFalse(report['cache_release_pass'])
            self.assertEqual(report['usage_metrics']['candidate']['all_steps'], a['all_steps'])
            self.assertEqual(report['usage_metrics']['stock']['all_steps'], b['all_steps'])

    def test_unresolved_omissions_block_comparison(self):
        cases = [dict(inputTokens=10, outputTokens=8, cacheReadTokens=990),
                 dict(inputTokens=10, outputTokens=8, cacheReadTokens=990, totalTokens=1009),
                 dict(inputTokens=10, outputTokens=8, cacheWriteTokens=0, totalTokens=19)]
        for usage in cases:
            with self.subTest(usage=usage), self.changed_usage(self.root, usage):
                a, b = score_cell(self.root), score_cell(self.stock)
                self.assertTrue(a['evidence_pass'])
                self.assertEqual(a['usage_zero_proofs'], [])
                self.assertIsNone(a['all_steps']['actual_prompt_read_ratio'])
                self.assertFalse(compare(a, b)['cache_comparison_pass'])

    def test_inconsistent_usage_fails_fixed_denominator_evidence(self):
        usage = dict(inputTokens=10, outputTokens=8, totalTokens=17)
        with self.changed_usage(self.root, usage):
            a, b = score_cell(self.root), score_cell(self.stock)
            self.assertFalse(a['evidence_pass'])
            self.assertTrue(a['metrics_partial'])
            self.assertEqual((a['complete_turns'], a['planned_turns'], a['planned_fill']), (309, 310, 230))
            self.assertFalse(compare(a, b)['cache_comparison_pass'])

    def test_proven_zero_comparison_still_requires_correctness(self):
        usage = dict(inputTokens=10, outputTokens=8, cacheReadTokens=990, totalTokens=1008)
        with self.changed_usage(self.root, usage), self.bad_answer(self.root):
            a, b = score_cell(self.root), score_cell(self.stock)
            self.assertTrue(a['evidence_pass'])
            self.assertEqual(a['fill_correct'], 229)
            self.assertFalse(a['gate_pass'])
            self.assertIn('candidate quality failed', compare(a, b)['errors'])

    def test_scoring_requires_verified_disjoint_usage_contract(self):
        path = self.root/'attempt.json'
        run = read_json(path)
        run['spec']['usage_semantics'] = 'unknown'
        with self.changed(path, json.dumps(run).encode()):
            with self.assertRaisesRegex(ValueError, 'unverified usage semantics'):
                score_cell(self.root)


# Filled from original d9391c5 generator, excluding its leaked truth.json.
ORIGINAL_FIXTURES_SHA256 = 'c2e032ec2e217bbf89e8949b59e29d8c73ebad932a137160187e1ee7c0b0a1e5'
