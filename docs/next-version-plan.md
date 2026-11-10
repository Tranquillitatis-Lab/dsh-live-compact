# 下一版本规划：语义归档索引与冷会话恢复

这份规划建立在 1.1.4 当前实现之上。公开的 #27 和 #34 仍未关闭；在它们的真实 Windows 长会话复测通过前，不把本 RFC 接入默认收尾路径，也不以受控小夹具的通过代替现场复测。

## 当前版本必须先完成

1. **#34 调用契约**：`finishTurn` 不等待整批 catch-up。捕获、恢复和权限检查进入可恢复队列；切分提交只等待被选 span 的目标 raw，目标未就绪就保留 span，后台继续追赶。
2. **#27 shared-root 容量安全**：为共享备份根增加带 root identity、generation、文件身份/大小、pending reservation 和 dirty 状态的持久账本。账本损坏、外部写入、旧 writer、锁或目录身份变化都必须转 full reconcile 或 fail-closed，不能把点检查当成绝对证明。
3. **异步轮换与统一写路径**：rotation、raw/meta/cursor/card 写入和旧文件 ACL 修复使用可恢复、可分片的 root writer；raw 写不得绕过容量 reservation。
4. **真实验收**：默认 shared root，11k 文件和 9,430/5,079、15k-event 长会话，Windows x64/ARM，冷热重启、并发 writer、旧 writer、外部 create/delete/overwrite/rename 及阶段强杀。必须记录 finishTurn 延迟、event-loop stall、capture lag、full-scan 次数、bytes/hash 和误删/超额计量。

## 下一版本 RFC：语义归档索引

### 目标

让 codemode/PTC 小程序在调用工具前用固定 marker 写下“想做什么”，插件把这个意图和工具结果绑定到已有会话 `seq` 与备份编号。卡片默认只留短意图、结果状态和指针；需要时通过显式 typed API 召回工具结果。

### 建议记录

```json
{
  "schema": 1,
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
  "archive": "raw-...txt",
  "summaryHash": "sha256:..."
}
```

- marker 固定为单行 `// spine-intent:v1 {"ref":"repo-status","summary":"inspect repository status"}`，只接受锚定在 PTC 调用前的 marker；正则识别 envelope 后必须用 `JSON.parse` 校验。`ref`、摘要长度和控制字符都要限额，解析失败、重复 marker 或跨调用歧义均忽略并退回现有规则。
- `intent` 只是模型声明，不代表成功；卡片必须把意图、实际结果（状态、退出码、错误摘要）和 `seq`/备份编号分开。
- 索引只保存关联关系和摘要指针，工具正文继续由现有 raw 备份、哈希和 ACL 机制管理；使用原子追加/替换和 root writer，索引损坏时只丢语义标签，不影响原始 raw 备份。
- 召回必须是显式 API，例如 `spine.recall({ intentRef, kind: "result", maxItems, maxBytes })`。默认不自动注入上下文，也不把结果重新写成 user/assistant 消息；跨会话、哈希不符、找不到或超限时返回 `unavailable`。
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

该 RFC 在 #27/#34 的真实 Windows 门槛通过后再进入实现评审；在此之前只维护文档、离线原型和测试夹具。
