# 1.1.6 开放问题核对

本版首条变更是 billion-context 共存让位，随后包含隔离组接管、checkpoint/turn 边界修复、P1 原始结果与压缩路径加固，以及 #45 的 model-level provider endpoint 修复。

| Issue | 1.1.6 状态 | 发布边界 |
| --- | --- | --- |
| [#45](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/45) | 已在 PR46 修复 | 按精确 provider + model catalog 地址判断 cloud/local；不改变宿主请求路由。发布后回复已修复。 |
| [#43](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/43) | Live Compact 侧已合并 | TUI 侧 PR 已合并，但真实 TUI × Live Compact 联合验收仍待完成，issue 保持开放。 |
| [#27](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/27) | 受控回归通过，现场未关闭 | 原用户 Windows 冷装与同规模 shadow 目录复测仍待完成。 |
| [#34](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/34) | 受控回归通过，现场未关闭 | 原用户 Windows 长会话与回退场景仍待复测。 |
| [#38](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/38) | 受控修复已发布 | 历史旧文件 ACL 边界仍按原 issue 说明保留。 |
| [#48](https://github.com/Tranquillitatis-Lab/dsh-live-compact/issues/48) | 不纳入本版 | 手动指定切点是 feature request，后续版本评估。 |

本审计不把受控测试替代原用户现场结论，也不把 TUI 联合验收写成已完成。
