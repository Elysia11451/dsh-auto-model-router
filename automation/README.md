# 无人值守自动化（automation/）

> 给"离开期间（上学）"准备的每日巡检脚本集。**全部只读**：不改 `src/`、不 commit、不碰生产配置（纪律见仓库任务要求）。

## 快速开始（用户回来后每天手动跑一次，或配 cron）

```sh
cd /storage/emulated/0/Documents/dsh-auto-model-router
sh automation/compat-check.sh   # 任务A：兼容性版本比对
sh automation/run-tests.sh      # 任务B：npm test 回归（约需几分钟）
sh automation/log-stats.sh      # 任务C：auto-router.jsonl 异常统计
sh automation/summary.sh        # 汇总 + 按日期归档
```

跑完看 [`daily-reports/daily-summary.md`](../daily-reports/daily-summary.md) 即可。

## 脚本一览

| 脚本 | 对应任务 | 做什么（只读） | 产出 |
| --- | --- | --- | --- |
| `compat-check.sh` | A（08:00） | `npm view` 最新版 vs profile 已装版：DSH 宿主、@xmanrui/dsh-im；记录 our-free-model（link 本地包，npm 无发布）、自身版本、dsh-cron/auto-continue 状态 | `daily-reports/compatibility-report.md` |
| `run-tests.sh` | B（09:00） | `timeout 900 npm test`，记退出码 + 断言统计；失败时附全量日志 `test-daily-full.log` | `daily-reports/test-daily.md` |
| `log-stats.sh` | C（10:00） | 扫描 `~/.dsh/logs/auto-router.jsonl`：三个重点 reason 计数 + error 行 + reason/keepReason Top25 | `daily-reports/log-stats-daily.md` |
| `summary.sh` | 汇总 | 抽三份报告的 `summary` 块合成 `daily-summary.md`（建议：单测❌/兼容🔄⚠️/日志 error 行才需人工看；已知降级计数不触发），并归档到 `archive/YYYY-MM-DD/` | `daily-reports/daily-summary.md` |

## 定时怎么接（用户回来后二选一）

1. **等 dsh-cron 兼容 0.2.x**：当前 v0.14.3 peer 锁 `^0.1.x`，宿主拒绝挂载（详见 [issues.md](./issues.md#1)）。
   新版发布后按其 README 用 cron 表达式注册三个 `command` 任务，argv 直接指向上表脚本。
2. **或试 Jesse-njx/dsh-routines**：YAML 例程 + headless 单独 profile 运行，digest 落文件；
   同样先在 0.2.0-rc.2 上实测后再信任。

## 插件评估结论（第一步产出，摘要）

- **调度层**：dsh-cron（squirrel20, v0.14.3, L5 Run tested）功能最贴（cron/command/agent 三触发×三任务、at-most-once、overlap/misfire 策略、侧栏面板），
  但与 DSH 0.2.0-rc.2 peer 不兼容 → 暂缓；备选 dsh-routines（YAML 例程、安全默认值好：approval never/无嵌套调度/至多一次追赶）待验证。
  titanwings/dsh-automation（★100）、yangyongzhen/dsh-scheduler（可推送通知）、chicheng-cron（侧栏管理）均为 0.1.0-rc.8 时代核对，
  未做 0.2.x 实测，不首选。
- **兼容测试层**：upstream-radar（MicroMilo, npm 0.45.0）是重型 CI 审计流水线，手机单机跑不了 → 降级为 compat-check.sh 版本比对；
  dsh-upgrade-guard / dsh-safe / dsh-refix 需动生产配置或版本过旧 → 不装。
- **执行保障层**：dsh-auto-continue 0.5.2 已在生产 profile 启用（autoContinue, continueMax 100，our-free-model 兜底链），不断线；
  自动放行类（dsh-auto / approval-gate / auto-review）未经授权不装——脚本只读，无需放行。
- **日志记录层**：本目录 + `daily-reports/` 即记录层，四份 Markdown + 日期归档。

## 状态（2026-10-07 首跑）

- 兼容性：DSH 0.2.0-rc.2、dsh-im 4.36.1 均无更新；our-free-model 2.0.0 本地包；结论 ✅ 全部通过。
- 单测：138 断言全绿，0 失败。
- 日志：system-retry-skipped ×9、downgrade-cooldown-blocked ×7、chat-chain-empty ×8（已知降级/跳过路径），error 行 0。
- 汇总建议：无需人工介入。
