# 版本规划：语义归档索引与冷会话恢复

这份规划建立在 1.1.4 当前实现之上，已列入当前版本规划，但只记录设计、开关和验收边界。公开的 #27 和 #34 仍未关闭；在它们的真实 Windows 长会话复测通过前，不把本 RFC 接入默认收尾路径，也不以受控小夹具的通过代替现场复测。

## 当前版本必须先完成

1. **#34 调用契约**：`finishTurn` 不等待整批 catch-up。捕获、恢复和权限检查进入可恢复队列；切分提交只等待被选 span 的目标 raw，目标未就绪就保留 span，后台继续追赶。
2. **#27 shared-root 容量安全**：为共享备份根增加带 root identity、generation、文件身份/大小、pending reservation 和 dirty 状态的持久账本。账本损坏、外部写入、旧 writer、锁或目录身份变化都必须转 full reconcile 或 fail-closed，不能把点检查当成绝对证明。
3. **异步轮换与统一写路径**：rotation、raw/meta/cursor/card 写入和旧文件 ACL 修复使用可恢复、可分片的 root writer；raw 写不得绕过容量 reservation。
4. **真实验收**：默认 shared root，11k 文件和 9,430/5,079、15k-event 长会话，Windows x64/ARM，冷热重启、并发 writer、旧 writer、外部 create/delete/overwrite/rename 及阶段强杀。必须记录 finishTurn 延迟、event-loop stall、capture lag、full-scan 次数、bytes/hash 和误删/超额计量。

## Windows 稳定后的实现条目：语义归档索引

### 目标

让 codemode/PTC 小程序在调用工具前用固定 marker 写下“想做什么”，插件把这个意图和工具结果绑定到已有会话 `seq` 与备份编号。卡片默认只留短意图、结果状态和指针；需要时通过显式 typed API 召回工具结果。

### 建议记录

```json
{
  "schema": 1,
  "sessionId": "session-...",
  "seq": 1842,
  "intentKey": "repo-status",
  "ref": "repo-status",
  "intent": "查找并修复配置加载失败",
  "assistantSeq": 1842,
  "parentCallId": "call_...",
  "resultSeqs": [1847],
  "toolCallIds": ["call_..."],
  "result": {
    "status": "ok",
    "exitCode": 0,
    "summary": "修改 2 个文件并通过测试"
  },
  "archive": "opaque-archive-id",
  "summaryHash": "sha256:..."
}
```

- marker 固定为单行 `// spine-intent:v1 {"ref":"repo-status","summary":"inspect repository status"}`，只接受锚定在 PTC 调用前的 marker；正则识别 envelope 后必须用 `JSON.parse` 校验。`ref`、摘要长度和控制字符都要限额，解析失败、重复 marker 或跨调用歧义均忽略并退回现有规则。
- `intent` 只是模型声明，不代表成功；卡片必须把意图、实际结果（状态、退出码、错误摘要）和 `seq`/备份编号分开。
- 索引键必须包含 `sessionId`，模型提供的 `ref` 只作标签，不能作为跨会话身份。索引只保存关联关系和摘要指针，工具正文继续由现有 raw 备份、哈希和 ACL 机制管理；`archive` 只能是 opaque id，不能暴露本地路径。使用原子追加/替换和 root writer，索引损坏时只丢语义标签，不影响原始 raw 备份。
- 召回必须绑定当前 session/agent，且是显式 API，例如 `spine.recall({ sessionId, intentRef, kind: "result", maxItems, maxBytes })`。默认不自动注入上下文，也不把结果重新写成 user/assistant 消息；跨会话、哈希不符、找不到或超限时返回 `unavailable`。
- 原始 thinking/reasoning 不纳入下一版；若未来支持，必须是独立宿主策略、独立开关、明确用户请求、限额和脱敏。

### 冷会话点火与状态重构

可取部分是把切片后的状态重构成一个可验证的旁路索引：保留 checkpoint、当前任务进度、工具调用/结果索引和来源 `seq`，让引擎按需从最小状态恢复，而不是重新读整段历史。

不采用状态重构消息系列，也不伪造 `turn1` 或任何宿主生命周期事件；它会污染 transcript、checkpoint、tool pairing、prefix cache 和官方压缩边界。冷会话点火只做内部 lazy hydrate：引擎初始化或第一个真实事件到来时分批读取索引，索引缺失就降级为无意图索引模式。

### 开关与回退

- `SPINE_INTENT_INDEX=0` 默认关闭；开启后默认只有 `result` 召回，先以离线索引和只读召回实验验证。出现格式错误、索引撕裂、召回超时或恢复失败，立即退回现有卡片和 `shadow-search` 路径。
- 新字段必须向后兼容：旧卡片没有 `intent`、`archive` 或 `seedId` 时照旧读取，不重做已完成的压缩。
- 任何召回失败都保留原始 span，不因语义索引失败而丢失工具结果。

### 最小验收矩阵

1. 注释存在、缺失、重复、超长、恶意伪造；解析失败均能安全回退。
2. 成功、非零退出码、超时、部分输出、重试和重启后恢复；每条记录的 `seq`、toolCallId、archive 与实际 raw 一致。
3. 默认不自动召回；显式 `kind:"result"` 召回验证数量/字节限制、跨会话拒绝和哈希一致性；`kind:"thinking"` 明确返回拒绝。
4. 冷会话 lazy hydrate 的重启、重复消费、乱序和旧 schema；不得产生重复真实事件、错误计费或错误 cooldown。
5. 多进程 shared-root 与账本/rotation 同时运行；语义索引不可绕过 reservation、ACL 或 fail-closed 规则。

### 副作用硬门禁

- **旁路零污染**：索引只能写 shadow 旁路文件；不得 `session.append` user/assistant/turn/compaction 事件，不得把索引 seq 放入 `sourceEventSeqs`，不得影响 checkpoint、prefix cache、官方 compaction 或 cooldown。开关 on/off 时 event hash、surface nodes、prefix fingerprint、压缩数量和 cooldown 状态必须一致。
- **可信归因**：只解析同一 assistant message 中紧邻父调用前的单行 marker；user/tool/result 文本里的 marker、重复/跨调用/歧义 marker 全部忽略。意图只表示声明，`status/exitCode/error` 必须来自可信 tool metadata 和已校验 raw；marker 不能触发工具、路径、命令、压缩或召回。
- **最小泄露面**：索引不保存 arguments、环境变量、headers、token、绝对路径或 raw 正文；摘要限长并按策略脱敏，archive 只用 opaque id。raw 召回仍走 ACL/hash/bytes 校验，损坏或缺失返回 `unavailable`，不回退表面文本；thinking 默认拒绝。
- **绑定与配额**：主键使用可信 `(sessionId, parentCallId/assistantSeq, generated intentKey)`；recall 必须绑定当前 session/agent capability，拒绝跨会话、跨 agent 和同 ref 猜测。每条记录、每 session 和全局设置字节/条数上限；超额或 Windows I/O stall 时只禁用当前 session 索引，现有 raw/compaction 继续。
- **崩溃与重放**：raw 成功且 hash/meta 验证后才写语义行；版本化 checksum + temp/fsync/rename 或 journal，幂等键包含 session、父调用、toolCallId 和 resultSeq。强杀、重启、并发 writer 和旧 schema 只能丢索引，不能误报成功、重复映射或改 transcript。
- **关闭零差异**：`SPINE_INTENT_INDEX=0` 时不解析 marker、不创建索引文件、不新增 I/O 或事件；旧卡片缺少新字段时照旧读取。宿主没有 recall API 时返回 `unavailable`，不能崩溃或阻塞。
- **冷会话边界**：只做内部 lazy hydrate/first-real-event hook；禁止状态重构消息系列、synthetic turn1、synthetic user/assistant/tool 事件，以及把 raw/result/thinking 自动注入上下文。

该条目在 #27/#34 的真实 Windows 门槛通过后再进入实现评审；在此之前只维护文档、离线原型和测试夹具，不改变当前版本默认行为。

## 2026-11-10 验收状态

- 公开 `v1.1.4` tag 与后续专用候选链必须分开报告；`152402e`、`34a00b4`、`de6ed70`、`839aab9`、`69bb3ce` 和 `66417c4` 尚未证明已进入公开 tag。
- Windows hosted run `42763949342` 的 Windows 2022 job 通过，但 Windows 11 ARM 的 29-turn replay 以 exit code 1 失败；不能宣称 1.1.4 在 Windows 全部修复 #34。必须保留 ARM annotation 和标准用户 stage 证据，直到同一候选的 ARM 干净复跑。
- 下一轮验证必须包含真实 9,430-event/29-turn、86 existing raw/meta 的冷启动/重启场景，以及 15,001-event/356-tool-result 的首次 capture + restart recovery。记录 `finishReturnMs`、maintenance entry、后台 catch-up、最大 event-loop gap、cursor、retryable、raw/meta/hash 完整性；任何持续秒级静默都保持 HOLD。
- catch-up 的 visible-existing 阶段只能把 `tighten:false` 且 hash/meta 完整的 raw 放入非 retryable cache；missing/corrupt/pruned/fuse 记录必须可回退到 retryable capture 或 fail-closed，不能让持久 cursor 越过失败结果。选中 span 的目标 raw 仍需按当前 ACL 策略重新授权，不能把只读恢复当成 ACL 证明。
- #27 的 `69bb3ce` 只移除 rotation 中冗余的 raw 首行读取；shared/default root 仍会 `readdir/stat` 全量计量，尚无 11k 文件 native Windows p95/p99 证据，继续保持未解决 P0/P1 边界。

## 2026-11-10 最终候选复测补充

- `42794155039` 的 ARM 与 Windows 2022 都失败，但两边失败点均是 hard-9430 合成 watchdog 的 `<100ms` 门槛：x64 观测约 279ms、ARM 约 441ms；candidate、223-file recovery、29-turn replay、重启和 native rotation 均已通过。该 run 保留为 harness 阈值失败证据，不能作为 #34 修复证明。
- 最终候选 `b3325e7` 使用 `<1000ms` watchdog 后，`42801602112` 的 ARM/x64 两 job 均成功。x64：223-file recovery 39ms/maxStall 0，29 turns，hard-9430 `finishReturnMs=7.95`、`catchupMs=578.82`、`maxGapMs=285`、86/86 raw、retryable 0、cursor 9430；ARM：223-file recovery 56ms/maxStall 0，29 turns，hard-9430 `finishReturnMs=6.17`、`catchupMs=749.94`、`maxGapMs=380`、86/86 raw、retryable 0、cursor 9430。
- 这证明当前候选在受控 Windows x64/ARM 场景通过了代码和 harness 门槛；公开 #27/#34 仍保持 Open，#27 仍缺 11k shared-root native 证据，#34 仍缺公开原始用户冷装/同规模回退证据，不能自动关闭 issue 或把公开 1.1.4 tag 改写成已修复。
- #27 的首轮 native telemetry run `42806335173` 已在 Windows 2022 x64 与 Windows 11 ARM 均通过：shared/default root、20 sessions、11,078 files、8 次 full scan、每次 11,078 stat（总 88,624），estimate=false。x64 p50/p95/p99 为 272.89/320.84/320.84ms，max event-loop gap 311ms；ARM 为 216.27/257.73/257.73ms，max gap 248ms。used/deleted/freed 保持 460258/0/0，未删除或低估。该数据确认 #27 的同步 full scan 已达到阻塞门槛，下一步必须进入完整串行 root-writer 设计；shared/default 继续 HOLD，不能开启 estimate。
