"""Pre-run answer grammar. Truth remains in the frozen manifest/fixtures."""
import re
import shlex
import json
from pathlib import Path
from contract import FILL, MANIFEST, NOTICE
from command_audit import bash_input_errors, tool_errors
from mkfx import build_log


def lines(text):
    return [re.sub(r"^(?:>\s*|[-*+] |\d+[.)] )", "", x.strip()).replace("**", "").replace("`", "").strip()
            for x in text.splitlines() if x.strip() and not x.strip().startswith("```")]


UNCERTAIN = r"\b(?:maybe|perhaps|guess|probably|possibly|uncertain|unsure|unclear)\b|\bnot sure\b|可能|猜测|不确定|大概|也许|[?？]"
ALTERNATIVE = r'\bor\b|或者|或'
WARN_LABEL = r"(?:(?:当前|本次|current(?: turn)?)\s*)?WARN(?:\s*(?:条数|数量|count))?"
NOTICE_LABEL = r"NOTICE(?:\s*(?:原文行?|original(?: line)?|line))?"
# Consume numeric-looking tokens whole, including malformed/unsupported forms.
# A count noun may be adjacent; other ASCII suffixes remain part of the token.
NUMERIC_TOKEN = r'(?<![a-zA-Z0-9_.+−-])[+−-]?(?:\d|\.\d)(?:(?!(?:WARN|NOTICE)\b)[a-zA-Z0-9_.+−,，-])*'


def cells(line):
    """Only simple Markdown tables; separator/header rows never supply facts."""
    if line.startswith('|') and line.endswith('|'):
        return [x.strip() for x in line[1:-1].split('|')]
    return None


def historical_context(line, turn):
    """Remove only bounded, fixture-verified sequences, never the whole row."""
    sequence = (r'(?<![a-zA-Z0-9_])part([1-9]\d*)(?:\.log)?\s*(?:→|–|->|至|\bto\b)\s*'
                r'part([1-9]\d*)(?:\.log)?\s*(?:的\s*)?WARN\s*(?:条数|数量|count)?\s*'
                r'(?:[:：=为]|\bis\b)\s*((?:0|[1-9]\d*)(?:\s*(?:→|–|->)\s*(?:0|[1-9]\d*))+)'
                r'(?=\s*(?:[;；。|)）]|[，,]|\.(?:\s|$)|$))')

    def verified(match):
        first, last = int(match[1]), int(match[2])
        values = [int(x) for x in re.split(r'\s*(?:→|–|->)\s*', match[3])]
        expected = [3 + n % 9 for n in FILL if first <= n <= last]
        # A current/answer label in this clause is never historical context.
        prefix = re.split(r'[;；。|]', line[:match.start()])[-1]
        current = re.search(r'当前|本次|本轮|现在|current|答案|answer', prefix, re.I)
        if first in FILL and last in FILL and first < last <= turn and values == expected and not current:
            return ' '
        return match[0]

    return re.sub(sequence, verified, line, flags=re.I)


def notice_label(label):
    label = re.sub(r"[（(](?:(?:第\s*)?\d+\s*(?:行|条|lines?)|仅|，|,|\s)+[）)]", "", label, flags=re.I)
    return bool(re.fullmatch(NOTICE_LABEL, label.strip(), re.I))


def answer_value(value):
    """A whole value plus a parenthesized explanation, never a numeric prefix."""
    match = re.fullmatch(r"(.+?)(?:\s*[（(]([^\n]*)[）)])?[。.]?", value.strip())
    return (match[1].strip(), match[2] or '') if match else (value.strip(), '')


def warn_value(value, expected):
    """A whole count with only balanced, bounded explanatory annotations."""
    match = re.fullmatch(r'(0|[1-9]\d*)\s*(?:条|lines?)?\s*(.*?)[。.]?', value.strip(), re.I)
    if not match or match[1] != str(expected):
        return False
    suffix = match[2]
    stack, explanation = [], []
    for char in suffix:
        if char in '(（':
            stack.append(')' if char == '(' else '）')
            explanation.append(' ')
        elif char in ')）':
            if not stack or stack.pop() != char:
                return False
            explanation.append(' ')
        elif stack:
            explanation.append(char)
        elif not char.isspace():
            return False
    if stack:
        return False
    # Log excerpts were removed separately. Digits, alternatives, second count
    # assertions and arbitrary qualifiers cannot hide in these explanations.
    annotation = (r'(?:all(?: WARN (?:lines?|entries))?(?: are)?\s+)?ledger drift\b|'
                  r'(?:均为|全部为|全是|都是)\s*(?:同一类\s*)?ledger drift\b|'
                  r'same (?:category|kind)\b|同一类|同类|'
                  r'e\.g\.?|for example\b|example\b|例如|示例|'
                  r'(?:行号|line numbers?)\s*(?:\d+\s*[,，、\s]*)+')
    return bool(re.fullmatch(r'(?:\s|[,，;；:：.。“”"\'‘’]|'+annotation+r')*',
                             ''.join(explanation), re.I))


def warn_claim_values(line):
    """Sentence/clause delimiters inside an annotation cannot truncate its audit."""
    for match in re.finditer(WARN_LABEL + r'\s*(?:[:：=为共]|\bis\b|\bare\b)\s*', line, re.I):
        value = line[match.end():]
        depth = 0
        for index, char in enumerate(value):
            if char in '(（':
                depth += 1
            elif char in ')）':
                depth = max(0, depth - 1)
            if depth == 0 and (char in '。;；' or
                               (char == '.' and (index + 1 == len(value) or value[index + 1].isspace())
                                and value[:index].lower()[-3:] != 'e.g')):
                value = value[:index]
                break
        yield value


def counts_before_warn(line):
    """Audit adjacent annotations on both sides of the whole counted noun."""
    def annotation_end(start):
        # Locate nested spans; warn_value checks bracket pairing and content.
        end, depth = start, 0
        while end < len(line):
            char = line[end]
            if char in '(（':
                depth += 1
            elif depth and char in ')）':
                depth -= 1
            elif not depth and not char.isspace():
                break
            end += 1
        return end

    noun = re.compile(r'(?:条目|条|行)?\s*WARN(?![a-zA-Z0-9_])'
                      r'(?:\s*(?:条目|条|行)|\s+(?:lines?|entr(?:y|ies)|rows?|records?|messages?)\b)?', re.I)
    # A signed, fractional, grouped or exponential number must never donate
    # its last digit sequence as a separate integer count.
    for match in re.finditer(NUMERIC_TOKEN, line, re.I):
        before_end = annotation_end(match.end())
        counted = noun.match(line, before_end)
        if counted:
            after_end = annotation_end(counted.end())
            # A nearby alternative belongs to this claim; stop at sentence or
            # clause boundaries rather than consuming unrelated later prose.
            alternative = re.match(r'[,，:：]?\s*(?:'+ALTERNATIVE+r'|/)\s*\S+',
                                   line[after_end:], re.I)
            if alternative:
                after_end += alternative.end()
            yield match[0], line[match.start():before_end] + line[counted.end():after_end]


def notice_count_values(line):
    """Audit whole count clauses, including annotations and continuations."""
    clauses, start, stack = [], 0, []
    for index, char in enumerate(line):
        if char in '(（':
            stack.append(char)
        elif char in ')）' and stack:
            stack.pop()
        numeric_comma = (char in ',，' and index > 0 and index+1 < len(line)
                         and line[index-1].isdigit() and line[index+1].isdigit())
        if not stack and not numeric_comma and (char in ',，;；。|' or
                          (char == '.' and (index + 1 == len(line) or line[index + 1].isspace()))):
            clauses.append(line[start:index])
            start = index + 1
    clauses.append(line[start:])
    previous = None
    for clause in clauses:
        # A separator does not turn an alternate value into unrelated prose.
        values = []
        continuation = (r'\s*(?:[（(]|'+ALTERNATIVE+r'|/|(?:but\s+)?'
                        r'(?:[+−-]?\d|not\b|actually\b|而是|实为|(?:(?:the\s+)?count|条数|数量)\s*(?:[:：=为]|\bis\b)))')
        if previous is not None and re.match(continuation, clause, re.I):
            values.append(previous+' '+clause)
        for match in re.finditer(r'NOTICE\s*(?:(?:(?:lines?|rows?|entries|matches)\s+)?count|条数|数量)\s*(?:[:：=为]|\bis\b)\s*', clause, re.I):
            values.append(clause[match.end():])
        for match in re.finditer(NUMERIC_TOKEN, clause, re.I):
            end, depth = match.end(), 0
            while end < len(clause):
                char = clause[end]
                if char in '(（':
                    depth += 1
                elif depth and char in ')）':
                    depth -= 1
                elif not depth and not char.isspace():
                    break
                end += 1
            noun = re.match(r'(?:条\s*)?NOTICE\b(?:\s*(?:lines?|rows?|entries|matches)\b)?', clause[end:], re.I)
            if noun:
                value = clause[match.start():end]+clause[end+noun.end():]
                alternative = re.search(r'\d+\s*(?:'+ALTERNATIVE+r'|/)\s*$', clause[:match.start()], re.I)
                values.append(clause[alternative.start():match.start()]+value if alternative else value)
        yield from values
        previous = values[-1] if values else None


def notice_count_value(value, expected):
    match = re.fullmatch(r'(0|[1-9]\d*)(?![\w.])\s*(.*)', value.strip())
    if not match or match[1] != str(expected):
        return False
    suffix = match[2]
    stack, explanation = [], []
    for char in suffix:
        if char in '(（':
            stack.append(')' if char == '(' else '）')
            explanation.append(' ')
        elif char in ')）':
            if not stack or stack.pop() != char:
                return False
            explanation.append(' ')
        elif stack:
            explanation.append(char)
        elif not char.isspace():
            return False
    # Only bounded explanations, including references, may accompany a count.
    # Arbitrary words can assert a second count just as digits can.
    annotation = (r'fixture verified\b|verified\b|read in full\b|no extra lines\b|'
                  r'checked\s+(?:part[1-9]\d*\.log|line\s+[1-9]\d*)\b|'
                  r'read WARN or NOTICE entries\b|已核实|已完整读取文件')
    return not stack and bool(re.fullmatch(r'(?:\s|[,，;；:：.。]|'+annotation+r')*',
                                           ''.join(explanation), re.I))


def citation_numbers_after_label(line, position):
    tail = line[position:].lstrip()
    tail = re.sub(r'^(?:[:：=]\s*)', '', tail)
    if tail.startswith(('(', '（')):
        opening, closing = tail[0], ')' if tail[0] == '(' else '）'
        depth = 0
        for index, char in enumerate(tail):
            if char == opening:
                depth += 1
            elif char == closing:
                depth -= 1
                if depth == 0:
                    return [int(x) for x in re.findall(r'\d+', tail[1:index])]
        return [int(x) for x in re.findall(r'\d+', tail[1:])]
    match = re.match(r'[0-9０-９][0-9０-９\s,，、]*', tail)
    return [int(x) for x in re.findall(r'\d+', match[0])] if match else []


def warn_citation_errors(text, turn):
    fixture_lines = build_log(turn)[0].splitlines()
    warn_lines = {n for n, text_line in enumerate(fixture_lines, 1)
                  if text_line.startswith('WARN ')}
    bad = []
    for line in lines(text):
        for note in re.finditer(r'(?:行号|line numbers?)', line, re.I):
            cited = citation_numbers_after_label(line, note.end())
            if not cited:
                continue
            if (not cited or len(set(cited)) != len(cited) or
                    any(n not in warn_lines for n in cited)):
                bad.append('WARN false supplemental citation')
        for citation in re.finditer(r'\bWARN ledger drift turn=(\d+) n=(\d+)\b', line):
            if int(citation[1]) != turn or int(citation[2]) >= 3 + turn % 9:
                bad.append('WARN false supplemental citation')
    return bad


def fill_answer(text, turn):
    warn, notice = [], []
    cited_notice = []
    bad = warn_citation_errors(text, turn)
    for line in lines(text):
        # Explicit count prose must consume the complete token. This prevents
        # malformed values, word alternatives, and adjacent nouns from being
        # silently skipped by the narrower extraction helpers below.
        for malformed in re.finditer(r'(?<![\d])(?:[+−-]{2,}\d+|\d+[.，,]\d+|\d+[a-zA-Z_]+|\d+\.)\s*(?:条\s*)?(?:WARN|NOTICE)', line, re.I):
            bad.append(('WARN' if 'WARN' in malformed[0].upper() else 'NOTICE') + ' contradictory supplemental count')
        for malformed in re.finditer(r'(?<![\d])\d+(WARN|NOTICE)(?:条|行|lines?)', line, re.I):
            bad.append(malformed[1].upper() + ' contradictory supplemental count')
        for malformed in re.finditer(r'\b(WARN|NOTICE)(?:[+−-]{2,}\d|[+−-]?\d)(?:条|行|lines?)', line, re.I):
            bad.append(malformed[1].upper() + ' contradictory supplemental count')
        for malformed in re.finditer(r'\b(WARN|NOTICE)[+−-]{2,}\d', line, re.I):
            bad.append(malformed[1].upper() + ' contradictory supplemental count')
        if re.search(r'\b(?:WARN|NOTICE)\b.*?[，,；;。]\s*[+−-]{2,}\d', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.search(r'(?:共有|本轮共有|there\s+are|the\s+(?:WARN|NOTICE)\s+count\s+is)\s+(?:nine|zero|one)\s*(?:或|or)\b', line, re.I) or re.search(r'(?:共有|本轮共有|there\s+are|the\s+(?:WARN|NOTICE)\s+count\s+is)\s+(?:\d+)\s*(?:或|or)\s*(?:nine|zero|one)\b', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.search(r'(?:共有|本轮共有|there\s+are|the\s+(?:WARN|NOTICE)\s+count\s+is)\s+\d+\s*(?:或|或者|or|/)\s*(?:nine|zero|one)\s*(?:条\s*)?(?:WARN|NOTICE)\b', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.search(r'\b(?:nine|zero|one)\s*(?:或|或者|or)\s*\d+\s*(?:条\s*)?(?:WARN|NOTICE)\b', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.search(r'\b(?:nine|zero|one)\s*/\s*\d+\s*(?:条\s*)?(?:WARN|NOTICE)\b', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.search(r'\b\d+\s*(?:或|或者|or|/)\s*(?:nine|zero|one)\s*(?:条\s*)?(?:WARN|NOTICE)\b', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.search(r'(?:WARN|NOTICE)\s*(?:条|lines?|entries)?\s*[，,]\s*[+−-]+\d', line, re.I):
            bad.append('WARN contradictory supplemental count' if 'WARN' in line.upper() else 'NOTICE contradictory supplemental count')
        if re.fullmatch(r'\d+(?:\s*(?:or|或|/)\s*\d+)?\s*(?:条)?[。.]?', line):
            bad.append('WARN ambiguous unlabeled numeric answer')
        summary = re.fullmatch(r'已读取 (?:\./)?part([1-9]\d*)\.log（(\d+) 行，已做大小写不敏感复核，(\d+) 处匹配 = (\d+) 条 WARN \+ (\d+) 条 NOTICE）：', line)
        if summary:
            w, n = 3 + turn % 9, int(turn in NOTICE)
            if summary.groups() != tuple(map(str, (turn, 520, w+n, w, n))):
                bad.append('WARN/NOTICE contradictory summary')
            continue
        row = cells(line)
        label = row[0] if row else re.split(r'[:：=]', line, maxsplit=1)[0]
        if notice_label(label):
            counts = re.findall(r'(\d+)\s*(?:条|lines?)', label)
            if any(x != str(int(turn in NOTICE)) for x in counts):
                bad.append('NOTICE contradictory label count')
        if row:
            if len(row) == 2 and (re.fullmatch(WARN_LABEL, row[0], re.I) or notice_label(row[0])):
                line = ': '.join(row)
            else:
                # Log excerpts and explanations are not additional answer fields.
                # Still inspect their NOTICE content for fabricated original lines.
                if len(row) == 2 and row[0].isdigit() and row[1].startswith('NOTICE '):
                    if row[1] != NOTICE.get(turn):
                        bad.append('NOTICE false supplemental row')
                    continue
                line = ' '.join(row)
        before_history = line
        line = historical_context(line, turn)
        match = re.fullmatch(WARN_LABEL + r"(?:\s*[:：=为共]\s*|\s+is\s+|\s+)(0|[1-9]\d*)\s*(?:条|lines?)?[。.]?", line, re.I)
        if match:
            warn.append(match[1])
            continue
        # Only the recognized log excerpt is context. Audit surrounding count
        # claims even when they share its citation/table row; keep NOTICE intact.
        supplemental, excerpts = re.subn(r'\bWARN ledger drift turn=\d+ n=\d+\b', ' ', line)
        if re.search(r"WARN", supplemental, re.I):
            for value in warn_claim_values(supplemental):
                # A removed inline example can leave only its comma/label/quotes.
                citation_value = re.fullmatch(r'(\d+)\s*(?:条|lines?)?\s*[,，]\s*(?:e\.g\.?|for example|example|例如|示例)\s*[:：]?\s*[“”"\'‘’\s]*', value, re.I)
                if excerpts and citation_value:
                    value = citation_value[1]
                value = re.sub(r'[:：]\s*$', '', value)
                if not warn_value(value, 3 + turn % 9):
                    bad.append('WARN ambiguous/contradictory current answer')
                elif re.match(WARN_LABEL + r'\s*(?:[:：=为共]|\bis\b)', supplemental, re.I):
                    warn.append(str(3 + turn % 9))
            if re.search(r'(?:not|不是|并非)\s*WARN|WARN\s*(?:不是|并非|isn.t)', supplemental, re.I):
                bad.append('WARN contradictory current answer')
            if re.search(UNCERTAIN, supplemental, re.I):
                bad.append('WARN uncertain current answer')
            if re.match(r'^WARN\s*\d', supplemental) or (re.search(r'WARN\s*(?:条数|数量|count)?\s*\d', supplemental, re.I)
                                                     and re.search(UNCERTAIN, supplemental, re.I)):
                bad.append('WARN ambiguous/uncertain current answer')
            if (re.search(r'\d+\s*(?:' + ALTERNATIVE + r'|/)\s*\d+\s*(?:条\s*)?WARN\b', supplemental, re.I) or
                    re.search(r'\b(?:nine|zero|one)\s+WARN\b.*(?:' + ALTERNATIVE + r')', supplemental, re.I) or
                    re.search(r'\bWARN\b.*(?:' + ALTERNATIVE + r')\s*(?:nine|zero|one)', supplemental, re.I)):
                bad.append('WARN ambiguous supplemental count')
            for token, count in counts_before_warn(supplemental):
                if not re.fullmatch(r'0|[1-9]\d*', token) or not warn_value(count, 3 + turn % 9):
                    bad.append('WARN contradictory supplemental count')
        if line != before_history:
            # Only an empty, verified history clause may precede a citation.
            # Keep the complete cited original and any suffix for exact audit.
            line = re.sub(r'^\s*(?:(?:历史趋势|Earlier trend)\s*[:：])?\s*[;；]\s*(?=Line \d+:\s*NOTICE )',
                          '', line, flags=re.I)
        cited = re.fullmatch(r'Line \d+:\s*(NOTICE .+)', line)
        if cited:
            cited_notice.append(cited[1])
            if cited[1] != NOTICE.get(turn):
                bad.append('NOTICE false supplemental citation')
            continue
        candidate = line
        labeled = re.match(r"^(.+?)\s*[:：=]\s*(.*)$", candidate)
        if labeled and notice_label(labeled[1]):
            candidate = labeled[2].strip()
            if not candidate:  # label introduces the following original line
                continue
        elif notice_label(candidate.rstrip(':：')):
            continue
        core, explanation = answer_value(candidate)
        if core == 'NONE':
            notice.append(None)
            if explanation and (re.search(UNCERTAIN, explanation, re.I) or
                                not re.fullmatch(r"(?:已(?:按|做)大小写不敏感(?:复核|复查)，\s*)?(?:文件中)?(?:没有任何|无|没有)\s*(?:NOTICE|notice)\s*(?:行|条目|字样)|(?:对\s*WARN/NOTICE\s*行做了全文件匹配，\s*)?未命中任何\s*NOTICE\s*行|(?:case-insensitive\s+)?no\s+notice\s+(?:lines?|entries)", explanation, re.I)):
                bad.append('NOTICE ambiguous explanation')
        elif core.startswith('NOTICE ') and not re.match(r'NOTICE\s+(?:(?:lines?|rows?|count|matches|entries|is|was|has|original|in|text|answer)\b|条数|数量|不存在|存在|为)', core, re.I):
            notice.append(candidate)  # original NOTICE bytes, including any false suffix
        elif labeled and notice_label(labeled[1]):
            bad.append('NOTICE ambiguous/contradictory current answer')
        elif re.search(r"NOTICE", line, re.I):
            # Ordinary prose isn't an answer field. Concrete extra originals,
            # counts, absence/presence claims and uncertainty are still audited.
            # Consume the complete Chinese verb first: the affirmative 有
            # inside 没有 must never become an independent presence claim.
            for claim in re.finditer(r'(没有|不存在|无|有)\s*(?:任何\s*)?(?:[一1]\s*(?:条\s*)?)?NOTICE(?![a-zA-Z0-9_])', line, re.I):
                if (claim[1] == '有') != (turn in NOTICE):
                    bad.append('NOTICE contradictory supplemental claim')
            for claim in re.finditer(r'NOTICE\s*(不存在|存在|为\s*NONE)', line, re.I):
                if (claim[1] == '存在') != (turn in NOTICE):
                    bad.append('NOTICE contradictory supplemental claim')
            if ((re.search(r'\b(?:no|not|without)\s+NOTICE\b', line, re.I) and turn in NOTICE) or
                    (re.search(r'\bthere is\s+(?:one|1)\s+NOTICE\b', line, re.I) and turn not in NOTICE)):
                bad.append('NOTICE contradictory supplemental claim')
            for claim in re.finditer(r'\bNOTICE\s+is\s+(not\s+)?(present|absent|NONE)\b', line, re.I):
                exists = (claim[2].lower() == 'present') != bool(claim[1])
                if exists != (turn in NOTICE):
                    bad.append('NOTICE contradictory supplemental claim')
            negative_notice = bool(re.search(r'(?:没有|不存在|无|\bno\b)\s*(?:任何\s*)?(?:[一1]\s*(?:条\s*)?)?NOTICE', line, re.I))
            negative_notice = negative_notice and not bool(re.search(r'(?:NOTICE\b.*\bcount\b|NOTICE\s+(?:数量|条数)\b|(?:共有|本轮共有|there\s+are)\s+\d+\s*(?:条\s*)?NOTICE\b)', line, re.I))
            if (re.search(r'\b(?:nine|zero|one)\s+NOTICE\b.*(?:' + ALTERNATIVE + r'|/)', line, re.I) or
                    re.search(r'\bNOTICE\b.*(?:' + ALTERNATIVE + r'|/)\s*(?:nine|zero|one)', line, re.I)):
                bad.append('NOTICE ambiguous alternative claim')
            if not negative_notice:
                for value in notice_count_values(line):
                    if not notice_count_value(value, int(turn in NOTICE)):
                        bad.append('NOTICE contradictory supplemental count')
            for original in re.finditer(r'NOTICE\s+([a-zA-Z]+)', line, re.I):
                if not re.match(r'(?:lines?|rows?|count|matches|entries|is|was|has|original|in|text|answer)\b', original[1], re.I):
                    bad.append('NOTICE extra original claim')
            if re.search(r'NOTICE\s*[:：=]', line, re.I):
                bad.append('NOTICE ambiguous extra answer')
            extra_line = re.search(r'NOTICE\s+(?:original line|line)\s*(?:is|为|[:：=])\s*(.+)', line, re.I)
            if extra_line and extra_line[1] != (NOTICE.get(turn) or 'NONE'):
                bad.append('NOTICE false supplemental original')
            if re.search(r'(?:NOTICE\s*(?:存在|不存在)|NOTICE\s+is\s+(?:not\s+)?(?:present|absent)|(?:有|没有|不存在|无)\s*(?:任何\s*)?(?:[一1]\s*)?NOTICE)', line, re.I) and re.search(r'(?:'+ALTERNATIVE+r'|/)', line, re.I):
                bad.append('NOTICE ambiguous alternative claim')
            if re.search(UNCERTAIN, line, re.I):
                bad.append('NOTICE uncertain current answer')
        elif re.search(r'\bNONE\b', line):
            bad.append('NOTICE ambiguous extra NONE')
    if warn != [str(3 + turn % 9)]:
        bad.append("WARN not unique exact labeled count")
    if not notice and cited_notice:
        notice = list(dict.fromkeys(cited_notice))
    if notice != [NOTICE.get(turn)]:
        bad.append("NOTICE not unique exact original line/NONE")
    return bad


def normal_fill_answer(text, turn):
    """Judge current facts while allowing ordinary Markdown and explanations."""
    expected_warn = 3 + turn % 9
    errors = []
    counts = []
    invalid_count = False
    history = r'历史|此前|早前|趋势|earlier|previous|history'

    def historical_claim(line, position):
        prefix = re.split(r'[；;。.,，→>\n）)]', line[:position])[-1]
        return bool(re.search(history, prefix, re.I)) and not bool(
            re.search(r'当前|本轮|实际|now|current|this\s+round', prefix, re.I))

    count_patterns = (
        r'\bWARN\b\s*(?:条数|数量|count|matches|总数)\s*(?:[:：=为]|is)\s*([^\s，；;。|`*（）()]+)',
        r'\bWARN\s*[:：]\s*([^\s，；;。|`*（）()]+)',
        r'(?:共有|本轮共有|there\s+are)\s+([^\s，；;。|`*（）()]+)\s*(?:条\s*)?WARN\b',
    )
    def strip_markdown_emphasis(value):
        result = []
        code_delimiter = None
        index = 0
        while index < len(value):
            char = value[index]
            if char == '`':
                end = index + 1
                while end < len(value) and value[end] == '`':
                    end += 1
                delimiter = value[index:end]
                result.append(delimiter)
                if code_delimiter is None:
                    code_delimiter = delimiter
                elif delimiter == code_delimiter:
                    code_delimiter = None
                index = end
            elif code_delimiter is None and value.startswith('**', index):
                index += 2
            else:
                result.append(char)
                index += 1
        return ''.join(result)

    raw_lines = [strip_markdown_emphasis(re.sub(r"^(?:>\s*|[-*+] |\d+[.)] )", "", x.strip())).strip()
                 for x in text.splitlines() if x.strip() and not x.strip().startswith("```")]
    for line in raw_lines:
        for pattern in count_patterns:
            for match in re.finditer(pattern, line, re.I):
                if historical_claim(line, match.start()):
                    continue
                token = match[1]
                if not re.fullmatch(r'(?:0|[1-9][0-9]*(?:,[0-9]{3})*)', token):
                    invalid_count = True
                    continue
                counts.append(int(token.replace(',', '')))
    if invalid_count:
        errors.append('WARN current count invalid')
    if not counts:
        errors.append('WARN current count missing')
    elif set(counts) != {expected_warn}:
        errors.append('WARN current count incorrect or contradictory')

    expected_notice = NOTICE.get(turn)
    notice_none = 0
    notice_values = []
    ignored_labels = {'original', 'line', 'rows', 'count', 'matches', 'entries',
                      'is', 'was', 'has', 'in', 'text', 'answer'}

    def clean_notice(value, strip_closing=True):
        value = value.strip()
        # A labelled citation is extracted from inside its opening backtick,
        # so remove only that one closing delimiter. Preserve literal `*` and
        # other punctuation that belongs to the cited line.
        if strip_closing and value.endswith('`') and not value.startswith('`'):
            value = value[:-1].rstrip()
        while len(value) >= 2 and value[0] == value[-1] and value[0] in '`*_':
            value = value[1:-1].strip()
        return value.strip()

    def segment(value):
        code_delimiter = None
        index = 0
        while index < len(value):
            char = value[index]
            if char == '`':
                end = index + 1
                while end < len(value) and value[end] == '`':
                    end += 1
                delimiter = value[index:end]
                if code_delimiter is None:
                    code_delimiter = delimiter
                elif delimiter == code_delimiter:
                    code_delimiter = None
                index = end
                continue
            if code_delimiter is None and char in '；;。':
                return value[:index], index
            index += 1
        return value, len(value)

    def segment_prefix(value):
        code_delimiter = None
        start = 0
        index = 0
        while index < len(value):
            char = value[index]
            if char == '`':
                end = index + 1
                while end < len(value) and value[end] == '`':
                    end += 1
                delimiter = value[index:end]
                if code_delimiter is None:
                    code_delimiter = delimiter
                elif delimiter == code_delimiter:
                    code_delimiter = None
                index = end
                continue
            if code_delimiter is None and char in '；;。':
                start = index + 1
            index += 1
        return value[start:]

    def find_closing_delimiter(value, start, delimiter):
        index = start
        while index < len(value):
            if value[index] != '`':
                index += 1
                continue
            end = index + 1
            while end < len(value) and value[end] == '`':
                end += 1
            if value[index:end] == delimiter:
                return index
            index = end
        return -1

    for line in raw_lines:
        skip_until = -1
        for occurrence in re.finditer(r'\bNOTICE\b', line, re.I):
            prefix_text = segment_prefix(line[:occurrence.start()])
            if occurrence.start() < skip_until or historical_claim(line, occurrence.start()):
                continue
            if re.search(r'(?:当前|本轮|实际|this\s+round|now|current).{0,20}(?:没有|不存在|未找到|不是|并非|not|without|no)\s*`*\s*$',
                         prefix_text, re.I):
                notice_values.append('__NEGATED_NOTICE__')
                skip_until = occurrence.end()
                continue
            if re.search(r'(?:没有|不存在|未找到|查找|全文.*(?:0|没有|匹配|查找|大小写)|只有|同样|得到|命中|全文中的|这条|次数|数量|\bsearched\b|\bsearch\b|\bno\b|\bwithout\b)', prefix_text, re.I):
                continue
            if re.search(r'(?:不是|并非|没有|不存在|未找到|not|without|no)\s*`+\s*$', prefix_text, re.I):
                notice_values.append('__NEGATED_NOTICE__')
                skip_until = occurrence.end()
                continue
            if occurrence.start() > 0 and line[occurrence.start() - 1] == '`':
                opening = occurrence.start() - 1
                while opening > 0 and line[opening - 1] == '`':
                    opening -= 1
                delimiter = line[opening:occurrence.start()]
                close = find_closing_delimiter(line, occurrence.end(), delimiter)
                if close != -1:
                    if re.search(r'(?:不是|并非|没有|不存在|未找到|not|without|no)\s*`?\s*$',
                                 line[:occurrence.start()], re.I):
                        notice_values.append('__NEGATED_NOTICE__')
                        skip_until = close + 1
                        continue
                    notice_values.append(line[occurrence.start():close])
                    skip_until = close + 1
                    continue
            rest = line[occurrence.end():]
            if (re.search(r'全文|匹配|大小写', prefix_text, re.I)
                    and re.search(r'命中\s*0|0\s*条|未找到|没有', rest, re.I)):
                continue
            labelled = re.match(
                r'\s*(?:原文行?(?:（[^）]*）)?|original(?:\s+line)?|line)?\s*[:：=]\s*(.*)$',
                rest, re.I)
            if labelled:
                raw_body, consumed = segment(labelled[1])
                if re.match(r'\s*(?:NONE|无)(?=\s|[（(]|$)', raw_body, re.I):
                    notice_none += 1
                    skip_until = len(line)
                    continue
                raw_text = None
                raw_prefix = ''
                if not re.match(r'\s*(?:NONE|无)\b', raw_body, re.I):
                    for raw_match in re.finditer(r'\bNOTICE\b', raw_body, re.I):
                        opening = raw_match.start() - 1
                        while opening > 0 and raw_body[opening - 1] == '`':
                            opening -= 1
                        delimiter = raw_body[opening:raw_match.start()]
                        if delimiter:
                            close = find_closing_delimiter(raw_body, raw_match.end(), delimiter)
                            if close != -1:
                                raw_text = raw_body[raw_match.start():close]
                                raw_prefix = raw_body[:raw_match.start()]
                                break
                    if raw_text is None:
                        raw_match = re.search(r'\bNOTICE\b.*$', raw_body, re.I)
                        if raw_match:
                            raw_text = raw_match[0]
                            raw_prefix = raw_body[:raw_match.start()]
                if raw_text and re.search(r'(?:不是|并非|没有|不存在|未找到|not|without|no)\s*`*\s*$',
                                          raw_prefix, re.I):
                    notice_values.append('__NEGATED_NOTICE__')
                    skip_until = occurrence.end() + labelled.start(1) + consumed
                    continue
                body = clean_notice(raw_text if raw_text is not None else raw_body,
                                    strip_closing=raw_text is None)
                if re.fullmatch(r'NONE(?:\s*[（(].*)?', body, re.I) or body == '无':
                    notice_none += 1
                elif body and (body.upper().startswith('NOTICE ') or not re.search(
                        r'第|行|条|line|original|count', body, re.I)):
                    notice_values.append(body if body.upper().startswith('NOTICE ') else 'NOTICE ' + body)
                skip_until = occurrence.end() + labelled.start(1) + consumed
                continue
            raw_body, _ = segment(rest)
            body = clean_notice(raw_body)
            if not body:
                continue
            if re.search(r'(?:不是|并非|没有|不存在|未找到|not|without|no)\s+NOTICE\b', body, re.I):
                notice_values.append('__NEGATED_NOTICE__')
                continue
            if re.search(r'^(?:这次|本次|此次|该次).*(?:出现|一条|缓存|配置|记录)', body, re.I):
                continue
            first = body.split()[0].lower()
            if first in ignored_labels:
                continue
            if re.fullmatch(r'NONE(?:\s*[（(].*)?', body, re.I) or body == '无':
                notice_none += 1
            else:
                notice_values.append(body if body.upper().startswith('NOTICE ') else 'NOTICE ' + body)

    if expected_notice:
        if notice_none or notice_values != [expected_notice]:
            errors.append('NOTICE current answer missing or contradictory')
    else:
        if notice_values or notice_none != 1:
            errors.append('NOTICE current answer missing or contradictory')
    return errors


def normal_recall_errors(text):
    """Check frozen recall facts without accepting historical values."""
    expected_by_key = {
        '缓存|cache': r'\bSQLite\b',
        '当前端口|端口|port': r'(?<![\d.+\-eE])9310(?![\d.,eE])',
        '限流|ratelimit': r'(?<![\d.+\-eE])37(?![\d.,eE])\s*(?:次\s*)?/(?:分钟|min)|(?<![\d.+\-eE])37(?![\d.,eE])\s+per\s+minute',
        '告警阈值|阈值|threshold': r'(?<![\d.,+\-eE])0\.875(?![\d.,eE])',
        '失败的测试|测试|test': r'\btests/test_ledger\.py\b',
        '审核人|reviewer': r'\bOkafor\b',
        '名字|name': r'\bBluebird\b',
        '金额格式|currency': r'\bUSD\b(?=.*(?:两位小数|2\s*decimals?|two\s+decimal\s+places))',
        '区域|region': r'\beu-west-3\b',
        '值班人|oncall': r'@mirela\b',
        '工单|ticket': r'\bLED-4471\b',
        '成本上限|budget': r'(?<![\d.,+\-eE$])\$?412(?![\d.,eE])',
        '报错码|code': r'\bE1729\b',
        '分片|shard': r'\b0x3F\b',
    }
    errors = []
    old = r'旧值|旧|此前|早前|废弃|停用|old|former|previous|deprecated'
    numeric_keys = {'当前端口|端口|port', '告警阈值|阈值|threshold', '成本上限|budget'}
    for key, expected in expected_by_key.items():
        label = ALIASES.get(key, key)
        if key == '名字|name':
            label = r'名字(?:（(?:项目)?代号）)?|名称|代号|name'
        elif key == '报错码|code':
            label = r'(?:check\.sh\s*(?:的)?\s*)?(?:报错码|错误码|报错原文|报错|error code|code)'
        present = False
        wrong = False
        text_lines = lines(text)
        for index, line in enumerate(text_lines):
            label_matches = list(re.finditer(
                r'(?<!\w)(?:' + label + r')(?![A-Za-z0-9_])\s*(?:[:：=]|为|is)?',
                line, re.I))
            for match_index, match in enumerate(label_matches):
                prefix = re.split(r'[；;。,，]', line[:match.start()])[-1]
                if re.search(old, prefix, re.I):
                    continue
                end = (label_matches[match_index + 1].start()
                       if match_index + 1 < len(label_matches) else len(line))
                tail = re.split(r'[；;。]', line[match.end():end], maxsplit=1)[0]
                for clause in (tail,):
                    old_marker = re.search(old, clause, re.I)
                    current = clause.strip()
                    if not current:
                        continue
                    if key == '报错码|code':
                        codes = re.findall(r'\bE\d+\b', current, re.I)
                        value_match = re.search(expected, current, re.I)
                        if value_match and re.search(r'不是|并非|非|not|without', current[:value_match.start()], re.I):
                            wrong = True
                        elif any(code.upper() != 'E1729' for code in codes):
                            wrong = True
                        elif value_match:
                            if old_marker and value_match.start() >= old_marker.end():
                                wrong = True
                            elif (old_marker and value_match.start() < old_marker.start()
                                  and re.search(r'(?:为|是)\s*(?:旧值|旧|此前|早前|废弃|停用|old|former|previous|deprecated)',
                                                current[value_match.end():old_marker.end()], re.I)):
                                wrong = True
                            elif (old_marker and value_match.start() < old_marker.start()
                                  and re.search(old, current[value_match.end():old_marker.end()], re.I)
                                  and not re.search(r'\bE\d+\b', current[old_marker.end():], re.I)):
                                wrong = True
                            present = True
                        elif re.search(r'原文|raw|error|check', current, re.I) and not old_marker:
                            following = '\n'.join(text_lines[index + 1:index + 3])
                            follow_codes = re.findall(r'\bE\d+\b', following, re.I)
                            if (re.search(expected, following, re.I)
                                    and not re.search(r'不是|并非|非|not|without', following, re.I)
                                    and not re.search(old, following, re.I)
                                    and not any(code.upper() != 'E1729' for code in follow_codes)):
                                present = True
                            elif follow_codes or re.search(old, following, re.I):
                                wrong = True
                        elif not codes and not value_match:
                            wrong = True
                        continue
                    value_match = re.search(expected, current, re.I)
                    if value_match:
                        if old_marker and key in numeric_keys:
                            after_old = clause[old_marker.end():]
                            if (re.search(r'\d', after_old)
                                    and (value_match.start() >= old_marker.end()
                                         or re.search(r'当前|本轮|实际|now|current|this\s+round|为|是',
                                                      after_old, re.I))):
                                wrong = True
                        if old_marker and value_match.start() >= old_marker.end():
                            wrong = True
                        if old_marker and value_match.start() < old_marker.start():
                            after_value = clause[value_match.end():old_marker.end()]
                            if re.search(r'(?:为|是)\s*(?:旧值|旧|此前|早前|废弃|停用|old|former|previous|deprecated)',
                                         after_value, re.I):
                                wrong = True
                        before = current[:value_match.start()]
                        after = current[value_match.end():]
                        if (re.search(r'不是|并非|非|无|not|without|except', before, re.I)
                                or re.search(r'(?:为|是)\s*$', after, re.I)):
                            wrong = True
                        else:
                            present = True
                    elif key in numeric_keys and re.search(r'\d', current):
                        wrong = True
                    elif key == '分片|shard' and re.search(r'0x[0-9A-Fa-f]+', current):
                        wrong = True
                    else:
                        wrong = True
        if not present or wrong:
            errors.append(f'recall: missing or incorrect {key}')
    return errors


# Label synonyms change presentation only; keys/expected values remain frozen.
ALIASES = {
    '缓存|cache': r'缓存(?:方式|类型)?|cache(?: backend)?',
    '限流|ratelimit': r'限流(?:速率)?|rate[ _-]?limit',
    '当前端口|端口|port': r'当前端口|端口|current port|port',
    '告警阈值|阈值|threshold': r'告警阈值|阈值|alert threshold|threshold',
    '失败的测试|测试|test': r'失败(?:的)?测试(?:文件)?|测试(?:文件)?|failing test|test',
    '审核人|reviewer': r'审核人(?:（Reviewer）)?|审阅人|reviewer',
    '名字|name': r'名字(?:（代号）)?|名称|代号|name',
    '金额格式|currency': r'金额格式|currency(?: format)?',
    '值班人|oncall': r'值班人|on[ -]?call',
    '成本上限|budget': r'成本上限|月度预算|monthly budget|budget',
    '报错码|code': r'(?:check\.sh\s*(?:的)?\s*)?(?:报错码|错误码)|error code|code',
    '校验|validation': r'校验(?:状态|问题)?|validation(?: status)?',
}
COMBINED_ERROR = r'(?:check\.sh\s*(?:的)?\s*)?(?:(?:报错码|错误码)\s*(?:与|和|/)\s*分片|(?:error code|code)\s*(?:and|/)\s*shard)'


def field_value(value, expected, key):
    if re.search(UNCERTAIN + '|' + ALTERNATIVE, value, re.I):
        return False
    core, explanation = answer_value(value)
    # Common punctuation and equivalent unit spellings do not change facts.
    core = re.sub(r'^Reviewer:\s*', '', core, flags=re.I) if 'reviewer' in key else core
    core = re.sub(r'^USD[，,]\s*', 'USD ', core)
    core = re.sub(r'^(\d+)\s*/\s*(?:minutes?|分钟)$', r'\1/min', core, flags=re.I)
    core = re.sub(r'^(\$?\d+) per month$', r'\1/month', core, flags=re.I)
    if not re.fullmatch(expected, core, re.I):
        return False
    if not explanation:
        return True
    # These bounded annotations occur in recall; arbitrary qualifiers, guesses
    # and second current values do not become part of a correct core value.
    allowed = {
        '当前端口|端口|port': r'早期为 8642，已废弃，不再使用|原 8642 已作废|旧值 8642 已弃用',
        '审核人|reviewer': r'(?:发布说明(?:需|须)含\s*)?Reviewer:\s*Okafor',
        '名字|name': r'不(?:许叫|叫) v2',
        '区域|region': r'默认区域',
        '工单|ticket': r'(?:必须|须|要)写进标题',
    }
    return bool(re.fullmatch(allowed.get(key, r'(?!)'), explanation, re.I))


def supplemental_fields(line, spec):
    """Audit explicit prose assertions without using them to fill missing facts."""
    for key, expected in spec.items():
        claims = re.finditer(r'(?<![a-zA-Z_])(?:' + ALIASES.get(key, key) + r')\s*(?:[:：=]|\bis\b|\bare\b|为|是)\s*(.+?)(?=。|[;；]|\.(?:\s|$)|$)', line, re.I)
        for claim in claims:
            if re.search(UNCERTAIN, line, re.I) or not field_value(claim[1], expected, key):
                return True
    return False


def fields(text, name):
    spec = MANIFEST["rubric"][name]
    seen = {key: [] for key in spec}
    diagnostic = {}
    bad = []
    pending = None
    for line in lines(text):
        heading = re.match(r'^#{1,6}\s+(.+)$', line)
        if heading:
            label = heading[1]
            pending = next((k for k in spec if re.fullmatch(ALIASES.get(k, k), label, re.I)), None)
            if re.fullmatch(COMBINED_ERROR, label, re.I):
                pending = 'combined'
            if pending is None and supplemental_fields(label, spec):
                bad.append(f'{name}: contradictory supplemental assertion')
            continue
        row = cells(line)
        if row and len(row) == 2:
            label, value = row
            line = label + ': ' + value
        else:
            match = re.match(r'^(.+?)\s*[:：=]\s*(.*)$', line)
            if pending and pending != 'combined' and not (match and any(
                    re.fullmatch(ALIASES.get(k, k), match[1], re.I) for k in spec)):
                label, value = pending, line
            elif match:
                label, value = match.groups()
            elif pending:
                label, value = pending, line
            else:
                # Prose cannot supply a field, but explicit assertions in prose
                # can contradict one. Do not ignore "the port is 8642".
                if supplemental_fields(line, spec):
                    bad.append(f'{name}: contradictory supplemental assertion')
                continue
        if label == 'combined' or re.fullmatch(COMBINED_ERROR, label, re.I):
            # Match the entire bounded combined value. Merely finding both
            # tokens can hide contradictory assertions later in this field.
            combined = bool(re.fullmatch(r'E1729\s*(?:/|,|，|;|；|and|与|和)\s*(?:shard\s+)?0x3F', value, re.I))
            combined = combined or value == 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)'
            for key in ('报错码|code', '分片|shard'):
                if key in seen:
                    seen[key].append(combined)
            pending = None
            continue
        # A quoted full original check diagnostic also explicitly supplies code
        # and shard; it does not supply unrelated facts from unstructured prose.
        if label == '报错原文':
            if value == 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)':
                for key in ('报错码|code', '分片|shard'):
                    diagnostic[key] = True
                pending = None
                continue
            if label == '报错原文':
                bad.append(f'{name}: incorrect original diagnostic')
        for key, expected in spec.items():
            if label == key or re.fullmatch(ALIASES.get(key, key), label, re.I):
                # A code-labeled original diagnostic must actually name E1729.
                if key == '报错码|code' and re.fullmatch(r'退出码 3；报错原文：E1729 shard 0x3F \(expected 9f2c71ab, got 9f2c71ae\)', value):
                    seen[key].append(True)
                    if '分片|shard' in seen:
                        seen['分片|shard'].append(True)
                else:
                    seen[key].append(field_value(value, expected, key) or
                                     (key == '分片|shard' and value == '0x3F；期望 9f2c71ab，实际 9f2c71ae'))
                pending = None
                break
        else:
            if supplemental_fields(line, spec):
                bad.append(f'{name}: contradictory supplemental assertion')
    for key, values in seen.items():
        if not values and diagnostic.get(key):
            values = [True]
        if values != [True]:
            bad.append(f"{name}: missing, duplicate or incorrect {key}")
    return bad



def parse_settings(text):
    """The fixture's flat TOML subset; no version-dependent TOML dependency."""
    result = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r"\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*=\s*(.*)", line)
        if not match or match[1] in result:
            raise ValueError('invalid/duplicate flat setting')
        token = re.fullmatch(r'''("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[-+]?[0-9]+(?:\.[0-9]+)?)\s*(?:#.*)?''', match[2])
        if not token:
            raise ValueError('unsupported/ambiguous flat setting')
        raw = token[1]
        result[match[1]] = raw[1:-1] if raw.startswith("'") else json.loads(raw)
    return result


def check_command(command):
    return check_plan(command) is not None


def check_plan(command):
    """Bounded shell subset: one invocation, redirections, captured status, cats.

    Never execute/expand shell text. Pipelines, substitutions, control flow,
    wrappers, chained checks and commands with unauditable side effects fail.
    """
    if not isinstance(command, str) or re.search(r"'[^'\n]*\$(?:\?|[a-zA-Z_])[^'\n]*'|\\\$|\$\(|`", command):
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|<>')
        lexer.whitespace_split = True
        lexer.commenters = ''
        words = list(lexer)
    except (ValueError, TypeError):
        return None
    segments = [[]]
    for word in words:
        if word == ';':
            segments.append([])
        else:
            segments[-1].append(word)
    if not segments[-1]:
        segments.pop()
    if not segments or any(not x for x in segments):
        return None
    head = segments.pop(0)
    if head[:2] in (['sh', './check.sh'], ['bash', './check.sh']):
        head = head[2:]
    elif head[:1] == ['./check.sh']:
        head = head[1:]
    else:
        return None
    redirected = set()
    while head:
        fd = head.pop(0) if head[0] in ('1', '2') else '1'
        if len(head) < 2:
            return None
        op, target = head[:2]
        head = head[2:]
        if op == '>&' and target in ('1', '2'):
            continue
        if op not in ('>', '>>') or not target or re.search(r'[\s$`;&|<>]', target):
            return None
        if fd not in ('1', '2'):
            return None
        redirected.add(target)
    if not segments:
        return {'capture': None, 'redirected': redirected}
    variable = None
    if len(segments[0]) == 1 and re.fullmatch(r'[a-zA-Z_][a-zA-Z_0-9]*=\$\?', segments[0][0]):
        variable = segments.pop(0)[0].split('=')[0]
    if not segments:
        return None
    marker = segments.pop(0)
    status = '$'+variable if variable else '$?'
    if len(marker) != 2 or marker[0] != 'echo' or marker[1] not in ('EXIT_CODE='+status, 'exit_code='+status):
        return None
    used = set()
    for diag in segments:
        if len(diag) == 2 and diag[0] == 'cat' and diag[1] in redirected - used:
            used.add(diag[1])
        elif len(diag) == 2 and diag[0] == 'echo' and re.fullmatch(r'--- (?:stdout|stderr) ---', diag[1]):
            continue
        else:
            return None
    return {'capture': marker[1].split('=')[0], 'redirected': redirected}


def check_evidence(command, body):
    plan = check_plan(command)
    original = 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)'
    if plan is None or body.splitlines().count(original) != 1:
        return False
    exits = re.findall(r'\[(?:exit code: |Command finished with exit code |shell exited: code )(-?\d+)\]', body)
    captures = re.findall(r'(?m)^(?:EXIT_CODE|exit_code)=(.*)$', body)
    if plan['capture']:
        return captures == ['3'] and bool(re.search(r'(?m)^'+plan['capture']+r'=3$', body)) and exits in ([], ['0'])
    return exits == ['3'] and not captures


def check_activity(command):
    """Mentions/read-only diagnostics aren't executions; opaque shells aren't proof."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|<>\n')
        lexer.whitespace_split = True
        lexer.commenters = ''
        words = list(lexer)
    except ValueError:
        return 'check.sh' in command
    if not any('check.sh' in x for x in words):
        return False
    if re.search(r'\$\(|`', command):
        return True
    segments = [[]]
    for word in words:
        if word and all(x in ';&|\n' for x in word):
            segments.append([])
        else:
            segments[-1].append(word)
    for segment in segments:
        if not segment or not any('check.sh' in x for x in segment):
            continue
        if segment[0] not in ('echo', 'printf', 'cat', 'sed', 'grep', 'ls', 'head', 'tail'):
            return True
    return False


def archival_move(call, files, initial, cwd):
    """Recognize only literal, non-reading moves into the workspace trash/.

    The frozen part*.log glob is the sole allowed shell expansion. Match raw
    syntax, not shlex-normalized text that loses quoting/escaping information.
    Every selected fixture must be absent at source and byte-identical at target.
    """
    args = call.get('input')
    if call.get('tool') != 'bash' or bash_input_errors(args, cwd):
        return False
    dest = r'(?:\./)?trash/?'
    source = r'(?:\./)?part(?:[0-9]+|\*)\.log'
    match = re.fullmatch(
        rf'[ \t]*(?:mkdir[ \t]+-p[ \t]+{dest}[ \t]*(?:;|&&)[ \t]*)?'
        rf'mv[ \t]+(?:--[ \t]+)?(?P<sources>{source}(?:[ \t]+{source})*)'
        rf'[ \t]+{dest}[ \t]*;?[ \t]*', args['command'])
    if not match:
        return False
    selected = []
    for token in match['sources'].split():
        name = token.removeprefix('./')
        if name == 'part*.log':
            selected += [p for p in initial if re.fullmatch(r'part[0-9]+\.log', p)]
        else:
            selected.append(name)
    return (bool(selected) and len(selected) == len(set(selected)) and
            all(p in initial and p not in files and files.get('trash/'+p) == initial[p]
                for p in selected))


def behavior(turn, calls, snapshot, initial, cwd=None):
    bad = []
    files = snapshot["files"]
    for path, digest in initial.items():
        if path in ("conf/settings.toml", "check.sh", "tests/test_ledger.py") or path.startswith("part"):
            moved_to_trash = (turn >= 30 and path.startswith("part") and path not in files
                              and files.get("trash/" + path) == digest)
            if files.get(path) != digest and not moved_to_trash:
                bad.append("protected fixture changed: " + path)
    if any(p.startswith("vendor/") or p == ".env" or p == "Makefile" or p == "truth.json" for p in files):
        bad.append("forbidden workspace artifact")
    for path, first in snapshot["python_headers"].items():
        if path not in initial and first != "# owner: team-kestrel":
            bad.append("new Python file missing owner header")
    check_runs = 0
    for call in calls:
        args = call["input"]
        command = args.get("command", "") if isinstance(args, dict) else ""
        path = args.get("path" if call.get('tool') == 'grep' else "file_path", "") if isinstance(args, dict) else ""
        command = command if isinstance(command, str) else ""
        path = path if isinstance(path, str) else ""
        # Keep the two existing narrow exceptions, including their exact-byte
        # and once-only checks. Everything else must be observable and audited.
        if not (turn >= 30 and archival_move(call, files, initial, cwd)):
            plan = check_plan(command) if call.get('tool') == 'bash' else None
            bad += tool_errors(call, turn, cwd, check_paths=plan['redirected'] if plan else None, files=files)
        if re.search(r"(?:^|/)\.env$", path) or re.search(r"(?<![\w.])\.env(?![\w.])", command):
            bad.append("forbidden .env access")
        if command and check_activity(command):
            check_runs += 1
            if turn != 1 or not check_command(command):
                bad.append("repeated or unauditable check.sh execution")
        if turn >= 29 and (re.search(r"part[^\s/]*\.log", command) or
                           re.search(r"part[^\s/]*\.log", path)) and not (
                               turn >= 30 and archival_move(call, files, initial, cwd)):
            bad.append("forbidden part log reread")
    if check_runs > 1:
        bad.append('repeated or unauditable check.sh execution')
    if turn == 28:
        if calls:
            bad.append("turn 28 forbids all tools")
    if turn == 29:
        bad += fields(snapshot["texts"].get("hidden.md", ""), "hidden")
    if turn >= 30:
        try:
            config = parse_settings(snapshot["texts"].get("conf/settings.local.toml", ""))
        except ValueError:
            config = {}
        for key, value in MANIFEST["rubric"]["config"].items():
            actual = config.get(key)
            if isinstance(actual, str):
                actual = actual.lower()
            if type(actual) is not type(value) or actual != value:
                bad.append("config: incorrect " + key)
        notes = snapshot["texts"].get("docs/NOTES.md", "")
        if not re.search(r"(?m)^# .*\bLED-4471\b.*$", notes):
            bad.append("release notes title lacks ticket")
        if "Reviewer: Okafor" not in notes or not re.search(r"\bBluebird\b", notes) or re.search(r"\bv2\b", notes):
            bad.append("release notes name/reviewer")
    if turn == 31:
        status = snapshot["texts"].get("docs/STATUS.md", "")
        bad += fields(status, "status")
        if not re.search(r"(?m)^# .*\bLED-4471\b.*$", status):
            bad.append("status title lacks ticket")
    return bad
