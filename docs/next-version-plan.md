# 下一版本规划：语义归档索引与冷会话恢复

这份规划建立在 1.1.4 当前实现之上。公开的 #27 和 #34 仍未关闭；在它们的真实 Windows 长会话复测通过前，不把本 RFC 接入默认收尾路径，也不以受控小夹具的通过代替现场复测。

## 当前版本必须先完成

1. **#34 调用契约**：`finishTurn` 不等待整批 catch-up。捕获、恢复和权限检查进入可恢复队列；切分提交只等待被选 span 的目标 raw，目标未就绪就保留 span，后台继续追赶。
2. **#27 shared-root 容量安全**：为共享备份根增加带 root identity、generation、文件身份/大小、pending reservation 和 dirty 状态的持久账本。账本损坏、外部写入、旧 writer、锁或目录身份变化都必须转 full reconcile 或 fail-closed，不能把点检查当成绝对证明。
3. **异步轮换与统一写路径**：rotation、raw/meta/cursor/card 写入和旧文件 ACL 修复使用可恢复、可分片的 root writer；raw 写不得绕过容量 reservation。
4. **真实验收**：默认 shared root，11k 文件和 9,430/5,079、15k-event 长会话，Windows x64/ARM，冷热重启、并发 writer、旧 writer、外部 create/delete/overwrite/rename 及阶段强杀。必须记录 finishTurn 延迟、event-loop stall、capture lag、full-scan 次数、bytes/hash 和误删/超额计量。

## 下一版本 RFC：语义归档索引

### 目标

让 codemode/PTC 小程序在调用工具前用固定注释写下“想做什么”，插件把这个意图和工具结果绑定到已有会话 `seq` 与备份编号。卡片默认只留短意图、结果状态和指针；需要时按 `seq` 召回工具结果，模型明确请求后才召回思考块。

### 建议记录

```json
{
  "schema": 1,
  "seq": 1842,
  "intent": "查找并修复配置加载失败",
  "toolCallId": "call_...",
  "result": {
    "status": "ok",
    "exitCode": 0,
    "summary": "修改 2 个文件并通过测试"
  },
  "archive": "raw-...txt",
  "thoughtArchive": null
}
```

- 注释格式固定为 `# intent: ...`（后续可增加等价的语言注释），解析失败时退回现有体量/失败形态规则。
- `intent` 只是模型声明，不代表成功；卡片必须把意图、实际结果（状态、退出码、错误摘要）和 `seq`/备份编号分开。
- 归档索引写入现有 shadow 根的会话目录，使用原子追加/替换和 root writer；索引损坏时只丢语义标签，不影响原始 raw 备份。
- 默认只返回工具结果；思考块单独存放、显式请求才读，且不进入默认摘要或卡片。
- 召回内容追加在当前消息尾部，不能改写已经缓存的前缀；召回响应必须带 `seq` 和结果状态，防止“想修复”被误读成“已修复”。

### 冷会话点火与状态重构

可取部分是把切片后的状态重构成一个可验证的恢复种子：保留 checkpoint、当前任务进度、工具调用/结果索引和来源 `seq`，让新会话从最小状态恢复，而不是重新读整段历史。

不采用直接伪造宿主生命周期事件的做法。若需要 `turn1` 形态，只生成带 `source: "recovery-seed"`、`seedId`、原始 `seq` 列表和 schema 版本的合成恢复消息；它不能冒充真实 user/assistant/tool 事件，不能参与计费、重试、冷却或官方 compaction 边界判断。默认不放入思考块，不伪造工具调用和结果。

### 开关与回退

- 默认关闭，先以离线索引和只读召回实验验证；出现格式错误、索引撕裂、宿主不接受 seed 或召回超时，立即退回现有卡片和 `shadow-search` 路径。
- 新字段必须向后兼容：旧卡片没有 `intent`、`archive` 或 `seedId` 时照旧读取，不重做已完成的压缩。
- 任何召回失败都保留原始 span，不因语义索引失败而丢失工具结果。

### 最小验收矩阵

1. 注释存在、缺失、重复、超长、恶意伪造；解析失败均能安全回退。
2. 成功、非零退出码、超时、部分输出、重试和重启后恢复；每条记录的 `seq`、toolCallId、archive 与实际 raw 一致。
3. 结果召回默认不带思考块；显式请求才读取思考归档，并验证大小上限与尾部追加。
4. 冷会话 seed 重启、重复消费、乱序和旧 schema；不得产生重复真实事件、错误计费或错误 cooldown。
5. 多进程 shared-root 与账本/rotation 同时运行；语义索引不可绕过 reservation、ACL 或 fail-closed 规则。

该 RFC 在 #27/#34 的真实 Windows 门槛通过后再进入实现评审；在此之前只维护文档、离线原型和测试夹具。
