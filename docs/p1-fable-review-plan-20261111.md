# P1 Fable Review Follow-up Plan

Base: PR #44 head `5d0fba8` (Live Compact isolated-group takeover, Deep PTC fixture, and P0 boundary fixes).

This branch is a new P1 candidate. It must not merge PR #44 or publish a release. The Fable review was static and targeted the older `1.1.5` main tree; items already fixed in PR #44 are carried as evidence, not reimplemented.

## Already closed by the current PR44 base

- `isCheckpoint()` no longer accepts an arbitrary event containing `Spine extract.` as a boundary; legacy text fallback is restricted to a leading marker on `user/message`.
- Idle and retry maintenance only accepts the latest `turn/start` → `turn/end` completion, so an earlier completed turn cannot trigger a cut for a newer unfinished turn.
- Deep PTC v1.8.2's isolated `compaction` + `toolResultPruner` group is covered by inline and Include integration tests.

## P1 implementation groups

### A. Raw identity and selection correctness

1. **Implemented:** detect same-session reuse of a `toolCallId` with different raw content. Identical duplicate events remain idempotent; conflicting content becomes a non-retryable fail-closed record and cannot be pruned or used for a cut.
2. **Implemented:** if a selected long-read cut fails pairing, pointer, failure-diagnostic, or card validation, fall back to the ordinary legal cut search instead of returning no cut immediately.
3. **Implemented:** keep `keptTokens` and `tailBeyondKept` in the same coordinate system for long-read cuts.
4. **Implemented:** reset `maxTurnGrowth` and settle `turnBase` after accepted or early-return maintenance paths so one large turn does not permanently force projected drains.
5. **Implemented:** narrow assistant decision protection so region/model/version strings do not become unresolved decisions; adversarial fixtures cover `us-east-1`, `claude-3-5`, `方案A`, and source-labelled facts.

### B. Raw/meta transaction and recovery

1. **Implemented:** each raw and meta file is staged privately, permission-checked before secret bytes, fsynced, and atomically renamed; meta is published second and acts as the completion marker.
2. **Implemented:** incomplete raw/meta pairs are rebuilt when the current event still has the original body; malformed or hash-mismatched pairs remain fail-closed.
3. Preserve ACL checks, root coordination, first verified hash/bytes, and fail-closed behavior for ambiguous replacement or permission failures.
4. Test partial body, missing meta, meta-first, crash-window recovery, duplicate event replay, and restart capture.

### C. Retry, rotation, and worker liveness

1. **Implemented:** separate transient `EAGAIN`/`EBUSY`/`EINTR`/`EIO` failures from permanent evidence failures; bounded retryable failures retain the first retryable cursor and make progress in batches.
2. **Implemented:** shadow worker requests have a 30-second timeout and terminate the failed worker; durable lock ownership and fence checks remain unchanged. Lock acquisition backoff is deferred because the current async catch-up already retries `ESHADOWBUSY` without blocking the host thread.
3. **Covered by existing tests:** keep PID plus lifecycle nonce/fence checks; reuse and stale-lock cases remain fail-closed.
4. Keep raw capture and rotation capacity semantics explicit; do not silently introduce an unverified hard quota or shared-root estimate.

### D. Windows ACL and prompt-boundary follow-up

1. **Deferred:** apply the existing recovery ACL cap consistently to commit/recovery paths or batch the helper invocation; preserve process-wide fail-closed ACL fuse semantics. The current patch preserves the fuse, parent ACL inheritance, and per-file identity checks but does not claim Windows batch performance.
2. Preserve `[tool]` provenance and the card disclaimer. Do not treat tool imperatives as user authorization. Any further reduction to structured facts needs separate fixtures for facts, commands, errors, and ordinary prose.
3. **Implemented:** Thunder facts retain `[user]`, `[tool]`, or `[unknown]` provenance labels in the summary-model input without changing transcript semantics.

## Acceptance gates

- Focused tests for every changed group, including crash/restart fixtures.
- `node test/p0-gate.mjs` and all relevant Node regression suites pass.
- Cordis 4.1 isolated environment: `npm run test:compat41` passes with the current dependency matrix.
- `npm run test:live-gate` passes with clean counters.
- `git diff --check`, package dry-run, and public-export checks pass.
- No merge, release, or default TUI compatibility claim. Windows x64/ARM and real Deep PTC/TUI joint evidence remain separate acceptance gates.

## Delivery

Push this branch as a new PR candidate with the complete diff and evidence. Leave it open for review; do not merge.
