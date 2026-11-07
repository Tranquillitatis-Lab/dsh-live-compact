# Pre-run scoring grammar decisions — 1.1.2

These corrections precede new candidate runs. No model calls are authorized or
performed here. Historical public/synthetic-format streams are schema and
format regression evidence only, never release scores or completed cells.

## Acceptance checks

- FILL still needs exactly one explicit, labeled, correct whole-integer WARN
  answer and the unique exact expected NOTICE original line or NONE. Bold,
  bullets, code fences, simple two-column Markdown tables, `NOTICE 原文行` /
  `NOTICE original line`, and line/count annotations are presentation. Counts
  cannot be numeric substrings, floats, leading-zero guesses or alternatives.
  NOTICE original text cannot acquire a false suffix, even punctuation.
- Supporting prose does not supply missing answers. Supplemental log-table
  rows and `Line N: …` citations are not second answer fields. Their concrete
  NOTICE text and counts must agree with fixture truth. Explicitly labeled
  duplicate answers, extra false NOTICE lines, conflicts and uncertainty fail.
  A clearly historical sequence such as `part2→part5 的 WARN 条数为 5→6→7→8`
  is context outside the current answer field. Current/answer labels override
  this exemption; it cannot hide a second current WARN field.
- Recall/hidden/status still require every manifest fact. Chinese/English
  label synonyms, tables, labeled lists and field headings with following
  values are accepted. Equivalent minute/month unit spellings and bounded
  contextual annotations (obsolete port, reviewer/title reminders) preserve the
  same values. Supporting prose cannot replace any missing field. Explicit
  contradictory prose and wrong or uncertain field values fail. A combined
  error-code/shard field or a labeled exact diagnostic may supply both facts;
  exit 3 alone never supplies the missing E1729 token.
- Turn 28 allows zero tools; no on-disk recall file is required. Turn 29 still
  requires the real hidden artifact and a source explanation. Turn 30 still
  requires the actual flat TOML config, all ten frozen keys/values, and actual
  notes with the ticket title, Bluebird and `Reviewer: Okafor`. No extra plan
  filename or invented interpretation of (a)–(d) is required. Turn 31 retains
  its status, config and notes checks. Prose promises cannot replace artifacts.
- Once-only check evidence requires a paired completed bash result, the exact
  original diagnostic as a complete line, fixture cwd, and code 3. Audited
  commands are `./check.sh`, `sh ./check.sh`, `bash ./check.sh`, stdout/stderr
  file redirections (`>`, `>>`, explicit fd 1/2), and fd duplication 2>&1 or
  1>&2. Capture forms are an immediate `echo "EXIT_CODE=$?"` (or lowercase),
  or `code=$?` followed by `echo "exit_code=$code"` (a simple variable name is
  allowed). Optional diagnostic cats read only the exact redirected files;
  optional echo headings are literal stdout/stderr headings. Captured output
  must have exactly one matching code-3 line and no nonzero enclosing-shell
  marker. Direct execution must have exactly one actual code-3 exit marker.
  Matching command text alone never proves execution. Literal mentions,
  echo/cat/printf, opaque shell wrappers, substitutions, pipelines, unrelated
  commands, fabricated/altered diagnostics and repeated executions cannot pass.
- Only the observed rc.2 read-before-write rejection is reclassified:
  `Error: cannot modify "<path>": file has not been read — read the file, then retry`.
  It must match the paired edit/write tool, the exact observed string argument
  keys and the same file path, without truncation or extra message text. It
  increments `model_tool_errors` and remains a quality failure. The runner
  continues to collect subsequent real evidence and usage. Every other tool
  error, malformed/unpaired event, timeout, nonzero CLI exit or transport/retry
  diagnostic keeps its existing failure behavior. No generic `status:error`
  exception or successful-follow-up amnesty exists.
- Built-in grep's actual `path` argument participates in the same .env and
  turn-29-onward part-log reread prohibitions as read/file and shell paths.
  Its frozen read-proof schema and exact fixture-output checks are unchanged.

## Bounded historical regression evidence

Read only group-1 t1/t2/t4/t28/t30 streams under the four explicitly authorized
`/tmp/lc111{f,n}-{ds,glm}/runs/spine-1` roots: 20 streams total. No other groups,
turns, profiles or credentials were inspected. Deterministic tests encode the
format cases; they never read these old logs or depend on their availability.

All 20 streams use the known rc.2 projection. They contain 83 paired tool calls
and eight projection truncation flags, including text/thinking projections.
The observed read-before-write error uses three edit calls and one write call.
Aggregate findings after the corrections:

| Turn | Regression finding, not a release score |
| --- | --- |
| 1 | All four actual once-only check forms have paired exact diagnostic/code-3 evidence; the redirected/captured forms now validate. |
| 2, 4 | All eight sampled FILL formats validate against unchanged fixture answers, including supporting prose, NOTICE labels, tables and citations. |
| 28 | One response genuinely omits E1729; another invokes a forbidden tool. Those failures remain. Three responses contain all required facts; only two also respect zero tools. |
| 30 | Four model-side read-before-write rejections remain counted quality failures. Three final config texts established by bounded successful read/write/edit evidence omit `ratelimit_per_minute` and `monthly_budget_usd`. A fourth has a later shell mutation without independently established final readback in this bounded review; its final artifact state is unverified. |

Additional turn-30 behavior categories remain visible: two notes retain `v2`,
which fails the unchanged notes check. Eight shell inputs reference part logs
and trigger the existing literal part-path gate: six are listing/move-shaped;
two contain log globs and `read_text`. Two shell inputs reference `.env` and
trigger the unchanged access check. These are tool-input categories, not a
claim that every reference read file contents. This correction adds grep-path
coverage; it does not rewrite those existing shell/path or notes constraints.

These streams lack the current attempt/process/snapshot/fingerprint package.
No `score_cell` release result was generated for them, no absent snapshots were
invented, and no historical artifact completeness or cache claim follows.

## Frozen boundary and offline verification

`manifest.json`, `prompts.json`, `prompts.py`, `mkfx.py`, `contract.py` and
`synthetic.py` are unchanged. The prompt SHA remains
`6b7e1d54d72af05533505905419b3b92940eae27faad52e899a1eb85a69e7d29`.
The independent original-fixture inventory test remains unchanged. Dimensions
remain 10 × 31 / 230 FILL; cache formulas, budgets and expected values remain
unchanged. Existing attempt fingerprints intentionally become stale when scorer
code changes; old attempts cannot be relabeled as current evidence.

Run the complete offline suite from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/live-fill -p 'test_*.py' -v
```

The new regressions cover correct explanatory Markdown, conflicts, all wrong
recall values, missing fields, historical sequences, execution versus mention,
actual local shell redirections/captures, wrong error/code/cwd, paired error
classification/recovery, retained full-cell counters/usage, forbidden grep
paths, turn-28 zero tools, and every required turn-30 config key/artifact.
The existing fake-DSH end-to-end test still runs all 310 turns and scores the
fixed 230 FILL denominator. No staging, commit, push, UI or profile changes are
part of this work.

Final offline validation: **65 tests passed in 34.846 seconds**, including the
310-turn fake-DSH execution/scorer CLI, frozen-fixture inventory, retained
validation-error counters/usage, actual local check-command forms, and cache
comparison budgets. `git diff --check` passed; the index is unchanged. All source
edits are confined to `test/live-fill`.
