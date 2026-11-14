# DSH GLM 5.3 Flash 长任务测评（2026-11-14）

固定 20 个 WebUniverse 长任务，原版与 dsh-live-compact 1.1.7 使用同一题集、同一 fixture 和同一 verifier。缓存命中率按 `cacheReadTokens / (cacheReadTokens + inputTokens)` 计算。

| 指标 | DSH 原版 | DSH + Live Compact 1.1.7 |
|---|---:|---:|
| 整题通过 | 9/20 (45%) | 13/20 (65%) |
| Rubric | 370/391 (94.6%) | 383/391 (98.0%) |
| Reward | 18.8862 | 19.5533 |
| 缓存读取 token | 40,100,736 | 38,464,640 |
| 未命中输入 token | 1,303,017 | 948,520 |
| 缓存命中率 | 96.85% | 97.59% |
| 总耗时 | 7,559.6 秒 | 8,243.4 秒 |
| 最大观测 totalTokens | 127,459 | 129,585 |

插件版相对原版：整题通过 +4、Rubric +13、Reward +0.6671、缓存命中率 +0.74 个百分点。

## 逐题结果

| # | 题目 | 原版 | 插件版 | 原版 rubric | 插件版 rubric | 插件版最大 totalTokens |
|---:|---|---|---|---:|---:|---:|
| 1 | `webuniverse-11057` | pass | pass | 30/30 | 30/30 | 76,047 |
| 2 | `webuniverse-00732` | fail | pass | 19/24 | 24/24 | 116,116 |
| 3 | `webuniverse-03875` | pass | pass | 22/22 | 22/22 | 66,775 |
| 4 | `webuniverse-09595` | fail | fail | 19/21 | 20/21 | 110,192 |
| 5 | `webuniverse-11860` | pass | pass | 21/21 | 21/21 | 100,741 |
| 6 | `webuniverse-04806` | pass | pass | 21/21 | 21/21 | 129,585 |
| 7 | `webuniverse-12054` | fail | fail | 20/21 | 20/21 | 68,224 |
| 8 | `webuniverse-13500` | fail | fail | 19/20 | 19/20 | 97,309 |
| 9 | `webuniverse-00841` | fail | pass | 19/20 | 20/20 | 126,945 |
| 10 | `webuniverse-12954` | pass | pass | 19/19 | 19/19 | 67,689 |
| 11 | `webuniverse-11099` | pass | pass | 18/18 | 18/18 | 102,577 |
| 12 | `webuniverse-06559` | fail | pass | 17/18 | 18/18 | 124,727 |
| 13 | `webuniverse-06972` | fail | pass | 17/18 | 18/18 | 126,412 |
| 14 | `webuniverse-09805` | pass | pass | 18/18 | 18/18 | 79,511 |
| 15 | `webuniverse-12059` | pass | fail | 17/17 | 16/17 | 100,999 |
| 16 | `webuniverse-05683` | pass | pass | 17/17 | 17/17 | 120,520 |
| 17 | `webuniverse-14033` | fail | fail | 16/17 | 16/17 | 121,576 |
| 18 | `webuniverse-10340` | fail | fail | 15/17 | 16/17 | 86,426 |
| 19 | `webuniverse-08083` | fail | pass | 14/16 | 16/16 | 126,027 |
| 20 | `webuniverse-00219` | fail | fail | 12/16 | 14/16 | 75,975 |

## 失败检查项

### DSH stock

- `webuniverse-00219` `tc_3`：The checkout summary lists every crate row
- `webuniverse-00219` `sc_2`：Checkout initially presents market-converted shipping choices and the correct total
- `webuniverse-00219` `sc_3`：Selecting partner lab pickup updates the checkout total
- `webuniverse-00219` `tc_5`：A valid submission produces the complete confirmation state
- `webuniverse-06972` `vf_1`：The JSON workspace uses the requested two-column layout
- `webuniverse-10340` `tc_4`：Inspector edits create undoable history
- `webuniverse-10340` `tc_13`：A new mutation after undo clears the redo history
- `webuniverse-13500` `sc_8`：Planner state is retained across navigation without a full app reset
- `webuniverse-00841` `tc_7`：PerformancePage provides the required return link
- `webuniverse-09595` `sc_5`：Saving with a non-empty snapshot name appends and selects a trimmed plan
- `webuniverse-09595` `sc_6`：Saving with an empty snapshot name uses the required default naming rule
- `webuniverse-08083` `tc_2`：PricingPage shows the required initial controls and empty import state
- `webuniverse-08083` `tc_3`：Importing the sample price sheet renders the pricing table
- `webuniverse-00732` `sc_8`：Confirming deletion removes the packet from the current vault page and shows the required toast
- `webuniverse-00732` `sc_9`：Deleted packets remain excluded after reload
- `webuniverse-00732` `sc_10`：Deleted packets are removed from collection displays
- `webuniverse-00732` `sc_11`：Saved-search runs exclude deleted packets
- `webuniverse-00732` `sc_12`：Relation lists exclude deleted packets
- `webuniverse-12054` `tc_1`：The app initially opens on the Studio route
- `webuniverse-14033` `sc_1`：Opening the sent dispatch portal marks it viewed and logs the portal open event
- `webuniverse-06559` `mp_2`：The Builder page includes the finishing details panel in the requested location

### DSH + Live Compact 1.1.7

- `webuniverse-00219` `sc_2`：Checkout initially presents market-converted shipping choices and the correct total
- `webuniverse-00219` `tc_5`：A valid submission produces the complete confirmation state
- `webuniverse-12059` `sc_1`：Submitting a valid activity records the selected values, resets the specified fields, and shows success
- `webuniverse-10340` `tc_13`：A new mutation after undo clears the redo history
- `webuniverse-13500` `sc_8`：Planner state is retained across navigation without a full app reset
- `webuniverse-09595` `sc_5`：Saving with a non-empty snapshot name appends and selects a trimmed plan
- `webuniverse-12054` `tc_1`：The app initially opens on the Studio route
- `webuniverse-14033` `sc_1`：Opening the sent dispatch portal marks it viewed and logs the portal open event

## 可复核文件

- 结构化逐题数据：`benchmark-dsh-glm53-2026-11-14.json`
- 本报告不包含 API key、session ID、原始模型 stdout 或临时 workspace。
