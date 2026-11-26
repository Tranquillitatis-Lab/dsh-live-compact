# 1.1.5 开放问题核对与发布回复依据

2026-11-11 候选记录；来源为本轮逐条读取的 30 个开放 issue 及全部评论。这里的“候选已修”只表示代码、复核和列明的回归证据，不表示已发布或现场关闭。#25 已按用户授权关闭，独立 Win11 非提权 1.1.4 复测不并入新版本成果。

代码安全复核：GPT-6.1 SOL MAX PASS；主门禁 551/551、离线 live-fill 214/214；隔离 DSH 0.2.2-rc.1 / Cordis 4.1.0 settings 20/20 与主门禁 551/551。最终同包 Windows run 42856576241 的 x64/ARM 13 阶段均 PASS，详见 [验收证据](release-1.1.5-verification.json)。旧 run 不覆盖后来的代码，新结论只适用于本冻结包。

| Issue | 分类 | 当前处理和证据 | 未解决边界／回复要求 |
|---|---|---|---|
| [#1](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/1) | 社区移植 | Pi 移植与署名记录，保留讨论。 | 不是本仓库待修 BUG；不代替对方发布。 |
| [#2](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/2) | 宿主边界 | README 保留 DSH-TUI 不接管预设的说明。 | TUI / 第三方 dsh-ops 共存未承诺支持，不为清单改宿主。 |
| [#5](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/5) | 既有修复 | web/Desktop isolate 预设替换与失败回退继续由 gate 和 settings-integration 验证。 | 不扩大到 TUI；原预设显式配置优先。 |
| [#6](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/6) | 既有修复与后续设计 | 卡片标明来源，助手状态不作已确认事实；工具调用/后台任务保留编号与状态。 | 不宣称能判定所有自然语言事实真伪；语义意图索引仍待 Windows 稳定后实现。 |
| [#8](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/8) | 维持已定策略 | 65 万绝对停切线保留。 | 维护者已选择固定阈值，不为关闭提案改动态窗口或默认参数。 |
| [#9](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/9) | 既有修复 | local 不越过最后用户消息，卡片和工具配对边界持续回归。 | 不牺牲本地前缀稳定性凑切段。 |
| [#10](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/10) | 后续提案 | goal/todos 切点继续作为独立设计讨论。 | 本轮仍按工具轮，不实现任务完成推断。 |
| [#11](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/11) | 既有可配置路径 | SPINE_CHUNK_MIN/MAX 可调，保留默认 1000/32000。 | Pi 小工具轮实验不代表 DSH 应统一改默认值；额外 redactor 未实现。 |
| [#12](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/12) | 既有修复 | spine-checkpoint、卡片地板与官方 checkpoint 冷却继续回归。 | 不对已完成卡片重复压缩。 |
| [#14](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/14) | 既有安全修复 | Windows DACL、卡片指针不写备份路径、工具事实与用户约束覆盖检查保留门禁。 | 不把所有助手叙述当硬事实；旧备份此前暴露的内容不能撤回。 |
| [#15](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/15) | 既有修复 | 配置、环境变量、文档和作者信息沿用已发布处理。 | 本轮再次核对 README 当前行为，历史只留 CHANGELOG。 |
| [#16](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/16) | 后续提案 | 现有 shadow-search 只供显式调用；typed recall / 意图索引另列规划。 | 默认不自动回读，不跨 session，不存原始 thinking，不伪造 turn1。 |
| [#19](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/19) | 已讨论定策 | 最新卡片作地板，drain 连切只记一次 rewrite，最近轮留原文。 | 不新增收益门槛或越卡片回切；无需重复通知已核对的用户。 |
| [#22](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/22) | 历史 Windows 缺陷 | icacls /restore 路径已移除，ACL 拒绝转警告/熔断。 | 与 #23/#25 独立复测交叉核对；本轮不是新修复证明。 |
| [#23](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/23) | 独立正面复测 | 用户报告普通 Windows 用户在 1.1.2 不再复现。 | 可以依据该条实测讨论关单；不能推广成所有 Windows 长会话 PASS。 |
| [#24](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/24) | 历史 Windows 缺陷 | 与 #22/#28 同源的非提权 fatal ACL 路径已移除。 | 保留具体版本与独立复测边界，发布后按对应证据回复。 |
| [#27](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/27) | P0，候选已修／现场待验 | 默认/shared 根保持 full scan，容量轮换和发布事务进入按 root 串行、可回收的 worker；原有锁/围栏保持。 | 最终同包 11,078 文件 x64/ARM 已干净复跑；worker 主线程 maxGap 为 14/16ms。原用户 1.1.1+补丁回退证据仍有效；旧 writer/alias/双进程同规模与严格重叠证明未齐，保持 Open。 |
| [#28](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/28) | 历史 Windows 缺陷 | 同 #22/#24；权限失败保留输出并熔断，宿主继续。 | 不再使用 icacls /restore，不把失败吞成成功备份。 |
| [#29](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/29) | 本轮候选修复 | 忽略 accountLaunchURL 空白哨兵，恢复公网地址 cloud 兜底；保留精确通知白名单。 | 此前三项用户已确认；真实用户消息与未知通知不越界。 |
| [#30](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/30) | 观察／指标解释 | 本地缓存命中须连同正确性、上下文、复用 token 和预填充比较。 | 83% 单一数值不足以定 BUG，不承诺固定命中率或启动付费预热。 |
| [#32](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/32) | 部分既有配置与后续提案 | 现有小切设置和环境变量继续支持；Config/模式和卡片合并讨论独立保留。 | 本轮不新增成本门槛、自动主题分类或改变默认切点。 |
| [#33](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/33) | 本轮候选修复 | 206981a：完整诊断放不进预算就保留原段；已知失败不走 pointer-only；JSON 额外字段参加完整性检查。 | 10 条诊断测试、local/cloud 真实运行入口及 551 项门禁通过；成功/unknown 输出原策略保留。 |
| [#34](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/34) | P0，候选已修／现场待验 | finishTurn 不等待整批 catch-up；分批恢复/补抓，切片只核验所选 raw，首个 hash 不可重认。 | 包含 c4a5e3f/206981a 的最终同包 9,430-event / 29-turn x64/ARM 已通过；原用户冷装/回退仍待现场验证，保持 Open。 |
| [#35](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/35) | 本轮候选修复 | 有效 PID+token owner 在旧进程明确死亡且无 shared 围栏时可重建，再完整校准。 | 旧格式、PID 不明/活跃、既有 shared 继续全扫；父线程/worker 生命周期可能触发 shared，不保证一直 estimate。 |
| [#36](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/36) | 本轮候选修复 | 从最新卡片之后统计 keepRounds，避免 floorCard 与保留轮双重饥饿。 | checkpoint、最后用户边界与工具配对不变。 |
| [#37](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/37) | 本轮候选修复 | 宿主 super.summarize 空/不可用时明确警告并保留原段，不再静默空转。 | 采用 issue 中可接受的显式拒绝路径；未增加独立摘要后端，不保证与所有接管插件并用。 |
| [#38](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/38) | 本轮候选修复 | 重启恢复只读 raw/meta；cursor 仍有单文件 ACL 校验，raw 用于修剪或切片前再有限重新授权。共享权限熔断跨 worker，重新授权保留首次 hash。 | 最终同包 223 文件恢复为 x64 17ms / ARM 52ms，全 hash 通过；读回通过不等于所有历史 ACL 已修。 |
| [#40](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/40) | 社区移植 | OpenCode 移植与公开对照评测保留。 | 学习其固定协议、原始数据和限制披露，不把一次对照全部收益归因插件。 |
| [#41](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/41) | 本轮文档交付 | README 保留当前行为、安装和设置，历史版本/测评原文留根 CHANGELOG，并纳入 npm files。 | 合入 Cursor 分支的拆分意图；无可合并 PR 时不声称已点 Merge。 |
| [#42](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/42) | 本轮候选修复 | ca99fc2：current.fiber ?? current.ctx?.fiber 身份核验后释放服务；listener 断言用初始基线加一。 | DSH 0.2.2-rc.1 / Cordis 4.1.0：settings 20/20、gate 551/551；旧 rc.2/4.0.x 基线同样通过。 |

发布回复必须等 GitHub / npm / 下载镜像和页面读回完成，再写确切版本、对应修复、验证范围与复测方法。#27/#34 保持 Open 等原用户复测；其他问题只按各自证据处理，不批量关单。历史已修、社区移植、指标讨论与后续 RFC 不算本轮新修 BUG，也不因仍 Open 就重做已完成项。
