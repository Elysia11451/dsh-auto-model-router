# 无人值守自动化 — 问题记录（issues）

> 只记录、不卡住。所有条目均有替代方案，生产环境未动。

## 1. dsh-cron v0.14.3 与 DSH 0.2.0-rc.2 peer 不兼容（调度层暂缓）✅ 已处理

- 现象：`dsh plugin --profile web add <dsh-cron tgz>` pnpm 安装成功，但宿主拒绝挂载：
  `peerDependencies {"@deepseek-ai/dsh-agent":"^0.1.1-rc.2 || ^0.1.5-rc.2 || ^0.1.7-rc.2", ...}` 不满足 0.2.0-rc.2，
  安装器自动回滚 package.json / pnpm-lock.yaml。
- 清理：node_modules 下残留孤儿目录 `dsh-cron/`（0.14.3），已用
  `dsh plugin --profile web install` 对账清除（pnpm `Packages: -58`）。profile package.json / lock / cordis.patch.yml
  均无残留，生产插件 dsh-auto-model-router link（0.8.5）完好。
- 决定：不申请 `--accept-risk` 版本豁免（peer 跨大版本，agent/session/storage/tools 六个宿主包全不满足，
  强装有 crash / 数据丢失风险，且无人值守期间无人救火）。
- 替代：定时三任务已沉淀为 `automation/` 下可直接跑的脚本（见 README）；
  待 dsh-cron 发布兼容 0.2.x 的版本，或换 Jesse-njx/dsh-routines（YAML 例程 + 宿主外 headless 运行，
  同样需实测 0.2.x 兼容性）后再接入调度。用户回来后手动配 cron 或等插件更新即可。

## 2. dsh-routines 未实装（待用户回来验证）

- 原因：时间盒内优先保证"脚本可用 + 生产干净"，未再做第二次插件安装尝试。
- 替代：同上，脚本先行；dsh-routines 的 YAML 例程文件可直接引用 automation/*.sh。

## 3. upstream-radar 未接入（兼容测试层降级为版本比对）

- 原因：upstream-radar 是"精确发布物隔离复测 + Agent 审计"的重型流水线（CI + 隔离环境 + LLM 审查），
  在手机 Termux 单机上无隔离 CI 可跑，且其 npm 包名为 `upstream-radar`（非 dsh- 前缀，需确认 bundle 接入方式），
  45 分钟盒内接入风险高。
- 替代：compat-check.sh 做轻量只读版本比对（npm view vs 已装版本），满足"发现更新只记录不升级"的需求。

## 4. dsh-upgrade-guard / dsh-safe / dsh-refix 未安装（暂缓）

- 原因：均需实际改动生产 profile（升级巡检/坏插件禁用/看门狗自修复），与"绝不碰生产配置"纪律冲突，
  且三者核对版本均为 0.1.x（rc.8 / rc.2 时代），0.2.0-rc.2 兼容性未知。
- 替代：不装；兼容性报告只读记录，真有不兼容等用户回来处理。

## 5. dsh-auto-driving / dsh-approval-gate / dsh-auto-review 未安装（暂缓）

- 原因：自动放行权限 = 无人值守期间无人确认高风险操作，用户未明确授权白名单前不装。
- 现状：dsh-auto-continue 0.5.2（github:cglyvip/dsh-auto-model-router…实为 cglyvip/dsh-auto-continue）
  已在 profile 中 `enabled: true, autoContinue: true, continueMax: 100`，断线续跑已有覆盖。
- 替代：脚本全部只读（set -u、无写操作、无批准需求），不需要自动放行插件即可跑。

## 6. npm test 基线：138 断言全绿，但有噪音（非阻塞）

- 现象：测试输出中大量 `[auto-model-router] free-list refresh failed (ENOENT ... our-free-model/catalog.json)`，
  系测试隔离 tmp 目录无 catalog 文件，插件按设计降级为空列表，测试本身通过。
- 建议（用户回来后）：测试脚手架可预置空 catalog 以消噪；不属本次任务范围，未改代码。
