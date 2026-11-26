import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from contract import HERE, fingerprints, read_json, write_json
from run import init_attempt, run_group, finish
from score import score_cell
from synthetic import spec

FAKE = str(HERE/'fake_dsh.py')


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'attempt'
        self.spec=spec(self.root)
        init_attempt(self.root,self.spec)

    def run_fake(self, mode='good', timeout=5):
        with patch.dict(os.environ, {'FAKE_DSH_MODE':mode, 'PYTHONDONTWRITEBYTECODE':'1'}):
            with contextlib.redirect_stdout(io.StringIO()):
                return run_group(self.root,1,FAKE,timeout=timeout)

    def test_full_group_no_prompt_or_oracle_write(self):
        before=(HERE/'prompts.json').read_bytes()
        self.assertTrue(self.run_fake())
        group=self.root/'runs/spine-1'
        self.assertEqual(len(list(group.glob('*.meta.json'))),31)
        self.assertTrue(read_json(group/'result.json')['answer_pass'])
        self.assertEqual(before,(HERE/'prompts.json').read_bytes())
        self.assertFalse((self.root/'work/spine-1/truth.json').exists())
        self.assertFalse((self.root/'work/spine-1/recall.md').exists())
        self.assertFalse((self.root/'DONE').exists())
        self.assertFalse(Path(self.spec['dsh_home']).exists())
        self.assertFalse(Path(self.spec['shadow_dir']).exists())
        # Process record retains the actual child exit, independent of parsed output.
        self.assertEqual(read_json(group/'t31.process.json')['exit_code'],0)

    def test_infra_failure_stops_and_preserves_logs(self):
        for mode in ('exit','nonzero_final','empty_final','malformed','missing_usage','transport','retry'):
            with self.subTest(mode=mode):
                root=Path(self.tmp.name)/mode
                init_attempt(root,spec(root))
                with patch.dict(os.environ, {'FAKE_DSH_MODE':mode, 'PYTHONDONTWRITEBYTECODE':'1'}),contextlib.redirect_stdout(io.StringIO()):
                    self.assertFalse(run_group(root,1,FAKE,timeout=5))
                group=root/'runs/spine-1'
                self.assertTrue((root/'FAILED.json').exists())
                self.assertTrue((group/'t1.process.json').exists())
                self.assertTrue((group/'t1.jsonl').exists())
                self.assertTrue((group/'t1.stderr').exists())
                self.assertFalse((group/'t2.jsonl').exists())
                self.assertFalse((group/'result.json').exists())

    def test_timeout_kills_task_owned_child(self):
        self.assertFalse(self.run_fake('timeout',timeout=0.5))
        group=self.root/'runs/spine-1'
        meta=read_json(group/'t1.meta.json')
        self.assertEqual(meta['termination'],'timeout')
        self.assertEqual(meta['cleanup'],'complete')
        self.assertLess(meta['ended']-meta['started'],3)
        self.assertIsNotNone(meta['pid'])
        self.assertTrue((self.root/'work/spine-1/child.pid').exists(), 'fake child must have actually started')
        time.sleep(0.9)
        self.assertFalse((self.root/'work/spine-1/child-survived').exists())
        self.assertFalse((group/'t2.jsonl').exists())

    def test_session_reset_stops_at_second_turn(self):
        self.assertFalse(self.run_fake('session_reset'))
        group=self.root/'runs/spine-1'
        self.assertEqual(read_json(group/'t2.meta.json')['requested_session'],'fake-spine-1')
        self.assertEqual(read_json(group/'t2.meta.json')['observed_session'],'reset-session')
        self.assertFalse((group/'t3.jsonl').exists())

    def test_existing_results_never_overwritten(self):
        with self.assertRaises(FileExistsError):
            init_attempt(self.root,self.spec)
        (self.root/'runs/spine-1').mkdir()
        marker=self.root/'runs/spine-1/DONE'
        marker.write_text('stale')
        with self.assertRaises(FileExistsError):
            self.run_fake()
        self.assertEqual(marker.read_text(),'stale')

    def test_incomplete_finish_fails_without_done(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(finish(self.root),1)
        self.assertFalse(read_json(self.root/'result.json')['gate_pass'])
        with self.assertRaises(FileExistsError),contextlib.redirect_stdout(io.StringIO()):
            finish(self.root)
        self.assertFalse((self.root/'ALL_DONE').exists())

    def test_count_override_rejected_before_execution(self):
        command=[sys.executable,str(HERE/'run.py'),'group','--root',str(self.root),'--group','1','--dsh',FAKE]
        env=os.environ.copy();env['SPINE_COUNT']='1'
        result=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'runs/spine-1').exists())

    def test_missing_executable_is_preserved_failure(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(run_group(self.root,1,'/nonexistent/live-fill-fake',timeout=1))
        self.assertEqual(read_json(self.root/'runs/spine-1/t1.meta.json')['termination'],'spawn_error')


class CommandTests(unittest.TestCase):
    def test_exact_offline_fake_all_and_score_commands(self):
        # Real runner entrypoints, 310 fresh fake subprocesses, zero model/network calls.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'cell'
            specfile=Path(tmp)/'spec.json'
            write_json(specfile,spec(root))
            env=os.environ.copy();env['PYTHONDONTWRITEBYTECODE']='1';env['FAKE_DSH_MODE']='good'
            env.pop('SPINE_COUNT',None)
            result=subprocess.run([sys.executable,str(HERE/'run.py'),'all','--root',str(root),
                                   '--spec',str(specfile),'--dsh',FAKE],env=env,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=55)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            report=read_json(root/'result.json')
            self.assertEqual(report['complete_turns'],310)
            self.assertEqual(report['fill_correct'],230)
            command=[sys.executable,str(HERE/'score.py'),'--root',str(root)]
            result=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            # Output path reuse cannot hide a failing scorer or replace an old report.
            result=subprocess.run(command+['--output',str(root/'result.json')],env=env,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(read_json(root/'result.json')['fill_correct'],230)
