## 每日汇总 - 2026-10-07

> 生成时间：2026-10-07 10:43:20 CST · 由 automation/summary.sh 自动汇总

### 兼容性
| 组件 | 已装 | 最新/基准 | 状态 |
| --- | --- | --- | --- |
| DSH 宿主 | 0.2.0-rc.2 | 0.2.0-rc.2 | ✅ 无更新 |
| @xmanrui/dsh-im | 4.36.1 | 4.36.1 | ✅ 无更新 |
| dsh-our-free-model | 2.0.0 | npm 未发布（link 本地包） | ✅ 本地包，跳过远端比对 |
| dsh-auto-model-router（自身） | 0.8.5 | 未发布 | ℹ️ v0.8.6 预览版尚未发布/研究中，不做发布比对 |
| dsh-cron（调度） | unknown | — | ℹ️ 未安装（与 DSH 0.2.0-rc.2 peer 不兼容，暂缓，见 automation/issues.md） |
| dsh-auto-continue（续跑） | 0.5.2 | — | ✅ 已安装 |

### 结论
- ✅ 全部通过

### 单测
- 执行：`npm test`（5 个测试文件串联）
- 结果：✅ 通过（退出码 0）
- 断言：通过 138 条，异常行 0 条，输出共 238 行

### 结论
- ✅ 138 条断言通过，0 失败

### 日志异常
| 重点 reason | 次数 |
| --- | --- |
| system-retry-skipped | 9 |
| downgrade-cooldown-blocked | 7 |
| chat-chain-empty | 8 |
| error 关键字行 | 0 |

- 日志总行数：9578（3.5M），最后一条：2026-10-07T02:30:34.630Z

### 结论
- 异常详情：system-retry-skipped × 9，downgrade-cooldown-blocked × 7，chat-chain-empty × 8，error 行 0 条（详见下表，属已知降级/跳过路径，仅记录）

### 建议
- 无需人工介入
