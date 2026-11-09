import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

assert.equal(process.platform, 'win32', 'issue34-long requires native Windows');
const targetEvents = 15000;
const targetToolResults = 356;
const baseShadow = process.env.SPINE_SHADOW_DIR;
assert.ok(baseShadow, 'SPINE_SHADOW_DIR is required');
const shadow = join(baseShadow, 'issue34-15k');
mkdirSync(shadow, { recursive: true });
process.env.SPINE_SHADOW_DIR = shadow;
const { default: Spine } = await import('../../index.js');

const surfaceEventTypes = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

function append(session, type, data) {
  return surfaceEventTypes.has(type)
    ? session.append(type, data, { surfaceOp: 'append' })
    : session.append(type, data);
}

function makeSession() {
  const session = Session.create(`issue34-${Date.now()}-${process.pid}`);
  append(session, 'system/message', { message: createSystemMessage('issue34 synthetic Windows latency probe') });
  append(session, 'user/message', createUserMessage({
    content: [{ type: 'text', text: 'Run the bounded issue 34 synthetic history probe.' }],
    source: { kind: 'user' },
  }));
  let count = 2;
  let toolResults = 0;
  while (count < targetEvents) {
    if (toolResults < targetToolResults && count % 42 === 0 && count + 2 <= targetEvents) {
      const id = `issue34-${toolResults}`;
      append(session, 'assistant/message', { turn: 1, message: createAssistantMessage({
        content: [{ type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ file_path: 'synthetic.log' }) }],
        source: { provider: 'issue34', model: 'synthetic' },
      }) });
      append(session, 'tool/result', { turn: 1, message: createToolResultMessage({
        callId: id,
        content: [{ type: 'text', text: `synthetic raw payload ${toolResults}` }],
        isError: false,
      }) });
      count += 2;
      toolResults += 1;
      continue;
    }
    append(session, 'assistant/message', { turn: 1, message: createAssistantMessage({
      content: [{ type: 'text', text: 'synthetic filler event' }],
      source: { provider: 'issue34', model: 'synthetic' },
    }) });
    count += 1;
  }
  append(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  return { session, toolResults };
}

function makeEngine() {
  const ctx = new Context();
  ctx.logger = { info() {}, debug() {}, warn() {} };
  ctx.sessions = { flush: async () => {} };
  ctx.tokenMeter = { measure: () => ({ totalTokens: 0, nodes: [] }), estimateMessage: () => 200 };
  ctx.llm = { listProviders() { return []; } };
  ctx.provide('toolResultPruner', { pruneSession() {} });
  const engine = new Spine(ctx.isolate('compaction'), { auto: false, minTokens: 100000000 });
  engine.engineFor = () => ({ engine: 'local', source: 'issue34-windows' });
  return { ctx, engine };
}

async function waitSettled(engine, deadlineMs = 12 * 60 * 1000) {
  const deadline = Date.now() + deadlineMs;
  while (engine.pendingCatchups?.size || [...engine.sessionState.values()].some((state) => state.warming)) {
    if (Date.now() > deadline) throw new Error('issue34 stage timed out waiting for catch-up');
    await yieldImmediate();
  }
}

function inspectRaw(engine, session, toolResults) {
  let rawOk = 0;
  let metaOk = 0;
  let hashOk = 0;
  for (let index = 0; index < toolResults; index += 1) {
    const toolCallId = `issue34-${index}`;
    const record = engine.rawSeen.get(engine.rawKey(session, toolCallId));
    if (record?.ok && record.path && existsSync(record.path)) {
      rawOk += 1;
      const body = readFileSync(record.path);
      const metaPath = `${record.path}.meta.json`;
      if (body.length === record.bytes && createHash('sha256').update(body).digest('hex') === record.sha256) hashOk += 1;
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (meta.toolCallId === toolCallId && meta.bytes === record.bytes && meta.sha256 === record.sha256 && statSync(record.path).size === meta.bytes) metaOk += 1;
      }
    }
  }
  const cursorPath = engine.captureCursorFile(session.id);
  const cursor = engine.readCaptureCursor(session.id);
  const cursorJson = JSON.parse(readFileSync(cursorPath, 'utf8'));
  const retryableEntries = [...engine.rawSeen.entries()]
    .filter(([key, record]) => key.startsWith(`${session.id}\0`) && record?.retryable);
  const retryable = retryableEntries.length;
  return {
    rawOk,
    metaOk,
    hashOk,
    retryable,
    retryableIds: retryableEntries.map(([key]) => key.slice(session.id.length + 1)),
    maxCaptureRetryAttempts: engine.captureRetryStats?.get(session.id) || 0,
    cursor,
    cursorKeyMatches: cursorJson.key === session.id,
    cursorFilePresent: existsSync(cursorPath),
  };
}

async function runPhase(label, engine, ctx, session, toolResults, cursor) {
  if (cursor !== undefined) engine.captureCursor.set(session.id, cursor);
  const telemetry = { turnEnd: performance.now(), maintenanceEnter: null, finishEnter: null, finishReturn: null };
  const original = engine.finishTurn.bind(engine);
  engine.finishTurn = async (...args) => {
    telemetry.finishEnter = performance.now();
    try {
      return await original(...args);
    } finally {
      telemetry.finishReturn = performance.now();
    }
  };
  const agent = {
    session,
    runMaintenance(fn) {
      telemetry.maintenanceEnter = performance.now();
      return fn(new AbortController().signal);
    },
  };
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 20);
  try {
    ctx.emit('agent/status', { agent, status: 'idle' });
    await waitSettled(engine);
  } finally {
    clearInterval(timer);
  }
  const finished = performance.now();
  const evidence = inspectRaw(engine, session, toolResults);
  const phase = {
    label,
    eventCount: session.snapshotEvents().length,
    toolResults,
    turnEndToMaintenanceMs: telemetry.maintenanceEnter === null ? null : Number((telemetry.maintenanceEnter - telemetry.turnEnd).toFixed(2)),
    finishTurnReturnMs: telemetry.finishReturn === null ? null : Number((telemetry.finishReturn - telemetry.turnEnd).toFixed(2)),
    catchupMs: Number((finished - telemetry.turnEnd).toFixed(2)),
    maxEventLoopGapMs: Number(maxGap.toFixed(2)),
    ...evidence,
  };
  assert.ok(phase.eventCount >= targetEvents, `${label}: event count`);
  assert.equal(phase.rawOk, toolResults, `${label}: all raw bodies readable`);
  assert.equal(phase.metaOk, toolResults, `${label}: all raw metadata readable`);
  assert.equal(phase.hashOk, toolResults, `${label}: raw hashes and bytes`);
  assert.equal(phase.retryable, 0, `${label}: retryable captures remain: ${phase.retryableIds.join(',')}`);
  assert.equal(phase.cursor, phase.eventCount, `${label}: cursor reaches event tail`);
  assert.equal(phase.cursorKeyMatches, true, `${label}: cursor key`);
  assert.equal(phase.cursorFilePresent, true, `${label}: cursor file`);
  assert.ok(phase.turnEndToMaintenanceMs < 5000, `${label}: maintenance entered too slowly: ${phase.turnEndToMaintenanceMs}ms`);
  assert.ok(phase.finishTurnReturnMs < 5000, `${label}: finishTurn returned too slowly: ${phase.finishTurnReturnMs}ms`);
  assert.ok(phase.maxEventLoopGapMs < 5000, `${label}: event loop blocked too long: ${phase.maxEventLoopGapMs}ms`);
  assert.ok(phase.catchupMs < 30 * 1000, `${label}: catch-up exceeded 30 seconds: ${phase.catchupMs}ms`);
  return phase;
}

const { session, toolResults } = makeSession();
const first = makeEngine();
const phaseA = await runPhase('capture', first.engine, first.ctx, session, toolResults, 0);
await first.ctx.fiber.dispose();

const second = makeEngine();
const phaseB = await runPhase('restart-recovery', second.engine, second.ctx, session, toolResults);
await second.ctx.fiber.dispose();

const result = {
  status: 'PASS',
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  eventCount: session.snapshotEvents().length,
  toolResults,
  phases: [phaseA, phaseB],
  noRetryable: true,
};
const evidencePath = process.env.PROBE_ISSUE34_EVIDENCE;
if (evidencePath) writeFileSync(evidencePath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
