# dsh-auto-model-router

> DSH 插件：按会话自动切换 Chat / Work 两个档位。闲聊用便宜的 Chat 档省 token，干活用免费池最强的 Work 档 deep 推理。

## 产品理念

平时闲聊和干活对模型的要求完全不同：闲聊要便宜、快；干活要强、能深度推理。手动换模型又麻烦又容易忘，切错了要么浪费钱、要么干不好活。

这个插件就是帮你自动分流：你只管说话，它按会话判断该走哪个档。只做路由注解，不改工具参数、不打断干活；你手动选过的模型，它一律让路不覆盖。

## 实际功能（v0.8.7.1 预发行版，已验证）

- **双档路由**：IM 闲聊 → Chat 档（light，自填便宜模型）；主界面直用 / IM 明确干活（装插件/跑命令/写代码） → Work 档（deep，免费池最强）。
- **三层判定**：会话状态机 → 关键词兜底 → 默认 chat。状态机一旦记住你是干活还是闲聊，关键词不再反向覆盖；连 3 轮闲聊才从 work 降回 chat。
- **首轮弹窗（仅 DSH 主界面）**：新会话首轮弹 Chat/Work 选择；选 Chat 承诺本会话永不自动升 Work，选 Work 可再降回。IM 通道（QQ/微信/TG）弹不出窗，见限制 NTR 5。
- **方向性冷却**：chat→work 升档直通不等待；work→chat 降档受 `switchCooldownMs`（默认 5s）约束，防来回横跳。
- **手动绝对优先**：会话里你亲手选过的模型（durable 选择），路由一律不覆盖，只注解 `kept`。
- **Chat 档干活只问一次**：Chat 会话里调到生产型工具（写文件/跑命令，非 read/grep/glob）弹窗问一次：同意切 work 并翻承诺，拒绝/超时则本会话粘住 chat 不再问。

## 工作原理

| 能力 | 接缝 | 说明 |
|------|------|------|
| 来源判断 | `exec.agent.source / exec.meta` | 微信/QQ/TG 等 IM 渠道 → `im`，其余 → `main`（`src/routing-policy/impl/classifier.js: sourceFromMeta`） |
| 任务分类 | 关键词表 | 命中"装插件/跑命令/写代码/操作文件…" → `agent-work`，否则 `chat`（`src/routing-policy/impl/classifier.js: classifyTask`） |
| 档位决策 | 三层判定 | 状态机在位直接用 → 失效走关键词兜底 → 双失效落默认 chat（`src/routing-policy/impl/decider.js: decideRoute` + 会话状态机） |
| 真切落盘 | `sessionController.selectModel` | 期望档位经 fire-and-forget 落到会话本地选择，全局默认保持 report-only 不污染 |

数据流一句话：`tools/pre-execute` 链路上做非侵入式路由注解——读来源与任务类型、算期望档位、写 `exec.autoModelRouter` 旁路字段并真切，绝不改写工具参数、不阻断工具链。

状态机一句话：每会话持久化 `mode/chatTurns/tool`（JSONL 侧车 + 热 Map），task 命中钉 work、连 3 轮无工具无关键词才降 chat，首轮默认 chat 放行。

## 安装

```sh
dsh plugin --profile web add github:Elysia11451/dsh-auto-model-router
```

安装后重进 DSH（或冷启动一次）即生效；`dump-config` 应出现 `auto-model-router` 条目且无 WARN。

## 配置

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | 布尔 | `true` | 总开关，关了只记日志不切模型 |
| `priorityMode` | `manual`/`auto` | `manual` | 手动优先：你手选的模型永远不动；路由优先：该切就切 |
| `workMode` | `manual`/`auto` | `auto` | 手动：固定用下行填的模型；自动：排行榜加降级链自动挑 |
| `manualWorkModel` | 字符串 | `""` | 只在手动模式用，格式 `provider/model`，空着等于没锁 |
| `workModelPriority` | 字符串数组 | `mimo…/glm…/deepseek…` | 排行榜拿不到时按顺序挑能用的 |
| `workModelFallback` | 字符串 | `mimo-v2.6-flash-free` | 链上全不中时的最后一个兜底 |
| `enableDynamicRanking` | 布尔 | `true` | 关了就不联网抓榜，直接走静态链 |
| `rankingRefreshSeconds` | 数字 | `3600` | 排行榜多久刷一次，30到3600秒 |
| `chatMode` | `manual`/`auto` | `auto` | 手动：固定用自填模型；自动：按降级链从便宜往贵挑 |
| `manualChatModel` | 字符串 | `""` | 只在手动模式用，格式 `provider/model` |
| `chatModelPriority` | 字符串数组 | `[]` | 空数组，自填你的便宜模型；空着回退兜底并打警告 |
| `switchCooldownMs` | 数字 | `5000` | 同一会话连着切时降档要等多久，升档不等 |
| `reclaimUnknownModel` | 布尔 | `true` | 当前模型两头都不认识时拉回路由目标；关了就不动 |
| `firstTurnPrompt` | 布尔 | `true` | 新会话首条消息弹 Chat/Work 选择；关了默认走 Chat |
| `firstTurnPromptTimeoutMs` | 数字 | `60000` | 弹窗多久没人选就自动走 Chat |
| `promptOnWorkTool` | 布尔 | `true` | Chat 档碰到写文件跑命令时问一次要不要切 Work，拒绝本会话不再问 |
| `enableRouteLog` | 布尔 | `true` | 路由诊断日志开关，关了不落盘只留控制台 |
| `routeLogMaxBytes` | 数字 | `5242880` | 日志超多大就归档，磁盘占用有上限 |
| `chatEffort / workEffort` | 字符串 | `light / deep` | 推理档位，旧配置残留照用 |

```yaml
- insert:
    - id: auto-model-router
      name: 'dsh-auto-model-router'
      config:
        chatMode: auto
        chatModelPriority: []          # 自填，如 ['deepseek/deepseek-flash']
        workModelFallback: mimo-v2.6-flash-free
        workModelPriority:
          - mimo-v2.6-flash-free
          - glm-5.3-flash
          - deepseek-v4.1-flash
        enableDynamicRanking: true
        firstTurnPrompt: true
        switchCooldownMs: 5000
```

## 使用

日常零操作：IM 里闲聊自动走 Chat 档省 token，说"帮我装插件/写个脚本/跑一下测试"自动升 Work 档 deep 推理；会话里手动选过模型，路由自动让路不再覆盖。

```sh
# 新会话首轮会弹 Chat/Work 选择，选 Work 后干活全程走免费池最强模型 deep 档
dsh plugin --profile web exec auto-model-router.selftest
```

## 验证

- **已验（159 用例全绿）**：`npm test` = router 53 / session-mode 7 / crash 51 / leaderboard 31 / first-turn 17，`exit 0`（含新增 `chat-chain-empty` 回退断言）。
- **离线（纯函数探针）**：`classifyTask/decideRoute/sourceFromMeta` 20 条判定 17/20 正确，3 条为关键词覆盖缺口，无逻辑缺陷。
- **端到端（生产 profile web）**：冷启动后 DSH 存活、`dump-config` 条目 present、`link` 版本一致、QQ 新会话 `route=chat` 真切可查（`~/.dsh/logs/auto-router.jsonl`）。

## 已知限制（v0.8.7.1 预发行版，用前必读）

- **IM 首轮弹窗未触发**：现状——QQ/微信新会话首轮弹不出 Chat/Work 选择窗，降级为静默 chat，次轮靠关键词纠正。影响——IM 新用户首轮一定走 Chat 档，干活需求次轮才升 Work。计划——IM 往返整体留后续版本。
- **首轮选 Chat 不立即切换**（v0.8.7.1 已修复）：现状——此前新会话选 Chat 后，第一轮模型仍继承 Work 档模型（`first-turn-pending` 分支在真切前短路）。修复——pre-step 返回 reject + 答案落定后 steer 重发，首轮零请求、零泄露。
- **首轮承诺无独立测试用例**：现状——initialMode 承诺机制（首轮选 Chat 永不自动升 Work）无独立断言覆盖，只靠集成测试。影响——改动首轮逻辑时可能漏回归。计划——后续版本补单测。
- **极端情况下首轮消息可能丢失**：现状——当 `@deepseek-ai/dsh-llm` 动态加载失败（极小概率）时，插件仅切换模型但不重发留存消息，导致用户选档后消息消失。影响——首轮消息需手动重发一次。缓解——重发上一条消息即可。

补充说明：同模型不同 effort（chat=light vs work=deep）也会真切，属预期行为；动态榜只取 `available` 模型，不可用条目静默跳过；移动端未做真机窄屏专项验证，设置页 UI 以桌面为准。

## 依赖与致谢

本插件的完整功能依赖以下两个社区插件，特此致谢：

- [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) by **@Ebony-Vinyl**
  Work 档的免费模型池来源。没有它，Work 档无法动态选模型。

- [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) by **@xmanrui**
  IM 通道桥接。没有它，微信/QQ/TG 无法接收路由结果。

感谢两位作者的无私开源，让这个插件有机会站在巨人的肩膀上。

## 关于作者

一个零基础开发者，用 AI 辅助完成了人生第一个开源项目。在这个过程中，最大的收获是学会了如何清晰地表达需求、如何把想法拆解成 AI 能理解的任务。

本项目从设计到实现，大量使用了 AI 工具。

## License

MIT — 见 [LICENSE](./LICENSE)。
