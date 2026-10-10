# dsh-auto-model-router

> DSH 插件：按会话自动切换 Chat / Work 两个档位。闲聊用便宜的 Chat 档省 token，干活用免费池最强的 Work 档 deep 推理。

## 产品理念

平时闲聊和干活对模型的要求完全不同：闲聊要便宜、快；干活要强、能深度推理。手动换模型又麻烦又容易忘，切错了要么浪费钱、要么干不好活。

这个插件就是帮你自动分流：你只管说话，它按会话判断该走哪个档。只做路由注解，不改工具参数、不打断干活；你手动选过的模型，它一律让路不覆盖。

## 实际功能（v0.8.7 预发行版，已验证）

- **双档路由**：IM 闲聊 → Chat 档（light，自填便宜模型）；主界面直用 / IM 明确干活（装插件/跑命令/写代码） → Work 档（deep，免费池最强）。
- **三层判定**：会话状态机 → 关键词兜底 → 默认 chat。状态机一旦记住你是干活还是闲聊，关键词不再反向覆盖；连 3 轮闲聊才从 work 降回 chat。
- **首轮弹窗（仅 DSH 主界面）**：新会话首轮弹 Chat/Work 选择；选 Chat 承诺本会话永不自动升 Work，选 Work 可再降回。IM 通道（QQ/微信/TG）弹不出窗，见限制 NTR 5。
- **方向性冷却**：chat→work 升档直通不等待；work→chat 降档受 `switchCooldownMs`（默认 5s）约束，防来回横跳。
- **手动绝对优先**：会话里你亲手选过的模型（durable 选择），路由一律不覆盖，只注解 `kept`。
- **Chat 档干活只问一次**：Chat 会话里调到生产型工具（写文件/跑命令，非 read/grep/glob）弹窗问一次：同意切 work 并翻承诺，拒绝/超时则本会话粘住 chat 不再问。

## 工作原理

| 能力 | 接缝 | 说明 |
|------|------|------|
| 来源判断 | `exec.agent.source / exec.meta` | 微信/QQ/TG 等 IM 渠道 → `im`，其余 → `main`（`src/router.js: sourceFromMeta`） |
| 任务分类 | 关键词表 | 命中"装插件/跑命令/写代码/操作文件…" → `agent-work`，否则 `chat`（`src/router.js: classifyTask`） |
| 档位决策 | 三层判定 | 状态机在位直接用 → 失效走关键词兜底 → 双失效落默认 chat（`src/router.js: decideRoute` + 会话状态机） |
| 真切落盘 | `sessionController.selectModel` | 期望档位经 fire-and-forget 落到会话本地选择，全局默认保持 report-only 不污染 |

数据流一句话：`tools/pre-execute` 链路上做非侵入式路由注解——读来源与任务类型、算期望档位、写 `exec.autoModelRouter` 旁路字段并真切，绝不改写工具参数、不阻断工具链。

状态机一句话：每会话持久化 `mode/chatTurns/tool`（JSONL 侧车 + 热 Map），task 命中钉 work、连 3 轮无工具无关键词才降 chat，首轮默认 chat 放行。

## 安装

```sh
dsh plugin --profile web add github:Elysia11451/dsh-auto-model-router
```

安装后重进 DSH（或冷启动一次）即生效；`dump-config` 应出现 `auto-model-router` 条目且无 WARN。

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `chatMode` | `auto` | `manual` 固定 `manualChatModel`；`auto` 走 `chatModelPriority` 链 |
| `manualChatModel` | `""` | 仅 manual 生效，格式 `provider/model` |
| `chatModelPriority` | `[]` | **空数组**——不预设 provider，用户按 `provider/model` 自填（便宜优先）；空时回退 `workModelFallback`，日志 `reason=chat-chain-empty` |
| `workModelFallback` | `mimo-v2.6-flash-free` | 链全不中 / 清单未就绪时的最终回退值 |
| `workModelPriority` | `mimo…/glm…/deepseek…` | 静态降级链（动态榜不可用时按序挑可用者） |
| `chatEffort / workEffort` | `light / deep` | 推理档位 |
| `enableDynamicRanking` | `true` | `false` = 不请求 OpenRouter，直接走静态链 |
| `reclaimUnknownModel` | `true` | 台账外未知模型强制纠偏回路由；`false` = 保守不动 |
| `manualWorkModel / manualWorkModelLocked` | `"" / false` | 锁定 work 模型后跳过动态榜 |
| `firstTurnPrompt / firstTurnPromptTimeoutMs` | `true / 60000` | 首轮弹窗开关与超时（超时回退 chat） |
| `switchCooldownMs` | `5000` | 同会话切换冷却（升档直通，降档受限） |
| `enableGroupHint / hintCooldownMs` | `false / 300000` | 群聊 work 档**诊断日志**开关与节流（v0.8.7 P0-3：只写日志，不发消息） |

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

- **已验（153 用例全绿）**：`npm test` = router 53 / session-mode 7 / crash 51 / leaderboard 31 / first-turn 11，`exit 0`（含新增 `chat-chain-empty` 回退断言）。
- **离线（纯函数探针）**：`classifyTask/decideRoute/sourceFromMeta` 20 条判定 17/20 正确，3 条为关键词覆盖缺口（见已知限制），无逻辑缺陷。
- **端到端（生产 profile web）**：冷启动后 DSH 存活、`dump-config` 条目 present、`link` 版本一致、QQ 新会话 `route=chat` 真切可查（`~/.dsh/logs/auto-router.jsonl`）。

## 已知限制（v0.8.7 预发行版，用前必读）

- **IM 首轮弹窗未触发**：现状——QQ/微信新会话首轮弹不出 Chat/Work 选择窗，降级为静默 chat，次轮靠关键词纠正。影响——IM 新用户首轮一定走 Chat 档，干活需求次轮才升 Work。计划——IM 往返整体留后续版本。
- **首轮选 Chat 不立即切换**：现状——新会话选 Chat 后，第一轮模型仍继承 Work 档模型（`first-turn-pending` 分支在真切前短路）。影响——首轮答案仍由 Work 模型回答，发第二条消息才纠正。计划——v0.9.0 主打修复（settle 后追加主动 realSwitch）。
- **Work 档手选 Chat 档 API 模型被覆盖**：现状——Work 会话里手动指定 Chat 档 API 模型会被路由强制覆盖。影响——想省钱手切便宜模型会被盖回去。计划——尚未诊断，待排查。
- **首轮承诺无独立测试用例**：现状——initialMode 承诺机制（首轮选 Chat 永不自动升 Work）无独立断言覆盖，只靠集成测试。影响——改动首轮逻辑时可能漏回归。计划——后续版本补单测。
- **3 条边界关键词仍误判**：现状——`查一下当前目录` / `跑一下测试` / `调用工具试试` 仍判 chat 档（NTR 4，分类器无此三条）。影响——这三句话首轮走 Chat，次轮才升 Work。计划——本版未修，后续补关键词。
- **IM 往返未实现**：现状——群聊 work 档只写诊断日志，不实际发送消息（缺 dsh-im 运行环境）。影响——IM 里收不到路由提示消息。计划——留后续版本，需用户在设置页提供 botId/targetId 后另起时间盒。

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
