// 等价性验证台：固定语料与驱动逻辑。
// 每个 case 确定性驱动一段会话：固定文本、固定 token 预算、固定时钟；
// 云端 case 用固定 CANNED_SUMMARY 顶替真实摘要（summarizeOfficial 是插件自身边界），
// 使差分只反映插件行为，不引入模型噪声。
import { makeFixture, makeRuntime } from "./harness.mjs";

export const CORPUS_VERSION = "1";

export const CANNED_SUMMARY = [
  "## 已完成",
  "- 读取了日志并确认当前任务状态。",
  "## 关键事实",
  "- 工具轮已结束，卡片与指针内容已固定。",
  "## 下一步",
  "- 继续当前任务。",
].join("\n");

const growth = (step, count, tokens, text = "INFO growth probe heartbeat ok") =>
  Array.from({ length: count }, (_, index) => ({ id: `grow-${step}-${index}`, tokens, text }));

export const CASES = [
  { name: "tiny-below-min", kind: "local", totalTokens: 19999, steps: [{ finishTurn: true }] },
  { name: "small-cut-local", kind: "local", totalTokens: 24000, steps: [{ finishTurn: true }] },
  { name: "small-cut-cloud", kind: "cloud", totalTokens: 24000, steps: [{ finishTurn: true }] },
  {
    name: "multiround-medium", kind: "local", totalTokens: 16000,
    steps: [
      { finishTurn: true },
      { rounds: growth(1, 3, 2600), finishTurn: true },
      { rounds: growth(2, 3, 2600, "INFO second growth probe"), finishTurn: true },
    ],
  },
  {
    name: "pointer-over-32000", kind: "cloud", totalTokens: 24000,
    long: { tokens: 40000, text: "INFO pointer probe heartbeat ok\n".repeat(4000) },
    steps: [{ finishTurn: true }],
  },
  { name: "big-gate-skip", kind: "local", totalTokens: 660000, steps: [{ finishTurn: true }] },
  { name: "thunder-on", kind: "cloud", totalTokens: 24000, env: { SPINE_THUNDER: "1" }, steps: [{ finishTurn: true }] },
  {
    name: "cooldown-window", kind: "cloud", totalTokens: 24000, config: { cooldownMs: 300000 },
    steps: [
      { officialCheckpoint: true, finishTurn: true },
      { clockAdvance: 300001, rounds: growth(1, 2, 2600), finishTurn: true },
    ],
  },
  {
    name: "failure-oversized", kind: "local", totalTokens: 24000,
    long: { isError: true, tokens: 33000, text: "ERROR oversized failure probe\n".repeat(3300) },
    steps: [{ finishTurn: true }],
  },
  {
    name: "keeprounds-drain-cloud", kind: "cloud", totalTokens: 20000,
    steps: [
      { finishTurn: true },
      { rounds: growth(1, 4, 4000), finishTurn: true },
    ],
  },
];

export async function drive(caseDef, { src, clock }) {
  const h = makeRuntime({ src });
  try {
    for (const [key, value] of Object.entries(caseDef.env || {})) process.env[key] = value;
    const kind = caseDef.kind || "local";
    const { engine } = h.engine(caseDef.config || {}, kind);
    const f = h.use(makeFixture({ totalTokens: caseDef.totalTokens ?? 24000, long: caseDef.long || {}, longLast: caseDef.longLast }));
    h.capture(engine, f);
    const originalSummarize = engine.summarize.bind(engine);
    engine.summarize = async (input, agent, signal) => {
      h.summarizeInputs.push(((input && input.messages) || []).map((message) => ({
        role: message?.role ?? message?.message?.role ?? null,
        text: src.plan.messageText(message),
      })));
      return originalSummarize(input, agent, signal);
    };
    if (kind === "cloud") {
      engine.summarizeOfficial = async () => ({
        summary: [{ type: "text", text: CANNED_SUMMARY }],
        provider: "canned",
        model: "canned",
        rawOutput: [],
      });
    }
    for (const step of caseDef.steps || []) {
      if (step.clockAdvance) clock.advance(step.clockAdvance);
      if (step.officialCheckpoint) f.user("官方压缩检查点：保留当前进度。", { kind: "compact-checkpoint" });
      for (const spec of step.rounds || []) {
        f.round(spec.id, { name: "read", tokens: spec.tokens ?? 2600, text: spec.text || "INFO growth probe heartbeat ok", turn: 2 });
      }
      if (step.finishTurn) await engine.finishTurn(f.agent());
    }
    return { h, f, engine, kind };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}
