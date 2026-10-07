# dsh-auto-model-router

一个按会话来源自动切换模型与推理档位的 DSH 插件。

## 核心特性

1. **双档路由**：IM 闲聊走 Chat 档（省 token），Agent 干活走 Work 档（免费池动态最强，effort deep）。
2. **三层判定**：状态机 → 关键词兜底 → 默认 chat，关键词不反向覆盖状态机。
3. **首轮弹窗**：新会话首轮弹出 Chat/Work 选择（DSH 主界面已验证，IM 通道待 v0.8.6）。
4. **方向性冷却**：chat→work 升档直通，降档受 switchCooldownMs 冷却约束。
5. **手动绝对优先**：用户 durable 选择非本路由来源时一律不覆盖（reclaimUnknownModel 开关管外部漂移纠偏）。

## 安装

```sh
dsh plugin --profile web add dsh-auto-model-router
```

## 工作原理

插件在 `tools/pre-execute` 链路上做**非侵入式路由注解**：

1. 从 `exec.agent.source / exec.meta` 判断会话来源（`router.js: sourceFromMeta`）：微信/QQ/TG 等 IM 渠道 → `im`，其余 → `main`。
2. 用关键词表判断任务类型（`router.js: classifyTask`）：命中"装插件/跑命令/写代码/操作文件…"等 Agent 关键词 → `agent-work`，否则 → `chat`。
3. 决策（`router.js: decideRoute`）：
   - 规则一：IM 聊天 → 期望 `chat` 档（`chatProvider/chatModel`，effort `light`；若目标模型无 effort 菜单自动省略 effort 重试；`chatModel` 支持 `provider/model` 格式，**留空则回退 `workProvider/workModelFallback`** 并打限频警告）。
   - 规则二：主界面直用，或 IM 中明确要求工作 → 期望 `work` 档：**动态最强**——OpenRouter Agent 强度榜（`?sort=agentic-high-to-low`，免 Key，1h 内存缓存 + `.cache/rankings.json` 文件缓存，抓取 5s 硬超时）与本地 `our-free-model` 可用清单求交，取排名最高者；榜单不可用/超时/`enableDynamicRanking: false` 时回退 **静态降级链 `workModelPriority`**（按序对可用清单挑，链头优先），链全不中才落 `workModelFallback`，effort `deep`。
   - 规则二之二（手动绝对优先，v0.5.1）：会话存在 durable 选择（`model/selection` 投影或 durable `request/header`）且**来源非本路由** → 路由**一律不覆盖**，只注解 `kept` + `keepReason: user-manual-selection-kept`（跨模型/跨类型同样保留；状态读不出时保守保留）。来源判定用路由自有切换台账 `lastSwitch`（仅本插件真切成功时写入）：durable 态与台账一致 = 路由自己切的（chat/work 四象限继续工作），不一致 = 用户改过（绝对保持）；同类型再叠加 `same-kind-kept` 短路（参考 `@argszero/cordis-plugin-session-model` 的 composition-pin 语义）。
   - 规则二之三（手动锁定 work 模型，v0.5.1）：`manualWorkModelLocked: true` 且 `manualWorkModel: 'provider/model'` → work 档直接用锁定模型，**跳过动态榜请求**（`lbFetchCount` 零增长），日志 `reason=manual-work-model-locked`；锁关闭或值为空则按规则二走动态/回退。
   - 规则三：群聊 + 当前工作模型 → 日志提示切换（5 分钟节流，可配 `hintCooldownMs`）。
4. 把期望档位写进 `exec.autoModelRouter` 旁路字段，**绝不改写工具参数、不阻断工具链**。
5. 真切（fire-and-forget，不阻塞工具链）：注解目标经 `sessionController.selectModel` 落到会话本地选择（`model/selection` 事件）；全局默认通过 `agentDefaultModel.saveSelection` 拦截保持 report-only，**不污染全局默认**；成功后读回 `model/selection` 投影做 UI 同步确认（前端选择器经投影 broadcast 自动刷新）。

## 安装

前置：`our-free-model >= 1.4.0` 已安装且版本兼容。缺失时插件降级为纯日志模式并输出明确警告，不静默失败。

```sh
dsh plugin --profile web add <git-url-or-path-of-dsh-auto-model-router>
```

## 配置（15 个 volatile 字段 + 首轮弹窗）

`chatModelPriority` 默认**空数组**——不预设任何 provider，用户按 `provider/model` 自行配置（按成本从低到高）。空数组时 chat 路由回退 `workModelFallback`，日志 `reason=chat-chain-empty`。

在 profile patch 行上覆盖（与 `cordis.patch.yml` 同 id）：

```yaml
- insert:
    - id: auto-model-router
      name: 'dsh-auto-model-router'
      config:
        chatProvider: zai-coding-cn
        chatModel: glm-5.3-flash       # 也支持 'prov/mod' 整串格式；留空回退 workModelFallback
        chatEffort: 'light'
        workProvider: our-free-model
        workModelFallback: mimo-v2.6-flash-free   # 链全不中/清单未就绪时的最终回退值
        workModelPriority:              # 静态降级链（v0.7.0；动态榜不可用时按序挑可用者）
          - mimo-v2.6-flash-free
          - glm-5.3-flash
          - deepseek-v4.1-flash
        workEffort: deep
        hintCooldownMs: 300000
        enableDynamicRanking: true     # false = 不请求 OpenRouter，直接走 workModelPriority 静态链
        reclaimUnknownModel: true      # 台账外未知模型（外部漂移）强制纠偏回路由；false = 保守不动
        privateChatWorkStrategy: free  # free=免费池动态最强；owned=自有 API（workEffortOwned 档）
        manualWorkModel: ''            # 手动锁定的 work 模型，'provider/model'；锁定后忽略动态榜
        manualWorkModelLocked: false   # true = 启用手动锁定（需 manualWorkModel 非空）
```

插件表单（设置 → 插件 → 插件配置）可直接改：`chatModel`、`workModelFallback`、`workModelPriority`、`hintCooldownMs`、`enableDynamicRanking`、`reclaimUnknownModel`、`privateChatWorkStrategy`、`manualWorkModel`、`manualWorkModelLocked`；`chatProvider/workProvider/effort` 等进阶键在 patch 行覆盖。

## 使用

- IM 里闲聊 → 自动期望聊天模型（省 token）。
- 主界面直接用，或 IM 里说"装插件/跑命令/写代码…" → 自动期望工作模型（**动态最强**，当前通常是 `space-bunny` 系；榜单不可用时回退 `workModel`）。
- 会话里手动选过模型 → **绝对优先，路由永不覆盖**（`kept` + `user-manual-selection-kept` 注解）。唯一例外 `reclaimUnknownModel: true`（默认开）：新值既非聊天目标也非配置干活对（外部漂移，如被宿主拽到别的免费模型）时强制纠偏回路由，日志 `reason=reclaim-unknown-model`。
- 配了 `manualWorkModelLocked` → work 档恒用锁定模型，不请求动态榜。
- 群聊多人且当前工作模型 → 日志提示切换回聊天模型。

## 验证

```sh
npm test                            # = 逐文件直跑下列三套
node test/router.test.mjs       # 纯逻辑 33 用例（含 resolveChatTarget / parseManualWorkLock / isWorkModelRef / isColdStartCrossKind / isUnknownDrift）
node test/crash.test.mjs        # 防崩溃 31 用例（含 durable 手动不覆盖/来源判定/锁生效/锁回退/冷启动跨类放行/未知漂移纠偏开关）
node test/leaderboard.test.mjs  # 排行榜 19 用例（含 OpenRouter 真数据交集回放）
```

隔离真机验证（iso2，真 sessionController + 真投影读回，分 r1–r8 八回合）：IM 聊天真切、免费池/自有 API 工作档、群聊提示+冷却、手动选择尊重、群工作、UI 同步确认、全局防污染、chatModel 空值回退、动态榜关闭零请求、手动锁生效/锁回退、四象限内部模拟 s1–s6（真实投影 + 提示计数 + 全局三读）、冷启动空台账跨类放行 t13–t14（台账为空 + durable 在位 + 跨类真切 + cold-start 日志）——t1–t14 + s1–s6 共 20 项断言全绿，详见 CHANGELOG。

## 已知限制

- **IM 首轮弹窗待 v0.8.6**：QQ/微信新会话首轮弹窗未触发（IM 桥 session 绑定时机问题），降级为静默 chat + 次轮 keyword-upgrade 自然纠正；DSH 主界面已验证可弹。
- **首轮手动选择被覆盖（ISSUE-W1）**：手选 work 档模型 + 首轮 route=chat 时，首轮默认 chat 真切会覆盖一次，弹窗选 Work 后可纠回。
- **关键词覆盖不足（ISSUE-P3-1）**：`查一下当前目录`/`跑一下测试`/`调用工具试试` 3 条边界误判 chat 档，次轮可升 work。
- 移动端 DSH 存在孤儿进程占用 3080 端口的已知问题。若遇冷启动白屏，先执行 `bash scripts/clean-port.sh` 释放端口，再启动 DSH。若脚本无效，物理重启手机。
- 群聊提示只到日志层，未做 IM 对话内 at 提示（需要 IM bridge 的发送能力，后续版本再接）。
- 动态榜单依赖公网访问 `openrouter.ai`；无网络时自动回退本地 `workModelFallback`。

## 隐私声明

使用 `our-free-model` 时，请求数据可能发往 OpenCode Zen 等第三方免费模型网关。请不要发送密码、密钥、个人身份信息等敏感内容。

## 依赖与致谢

本插件的完整功能依赖以下两个社区插件，特此致谢：

- [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) by **@Ebony-Vinyl**
  Work 档的免费模型池来源。没有它，Work 档无法动态选模型。

- [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) by **@xmanrui**
  IM 通道桥接。没有它，微信/QQ/TG 无法接收路由结果。

感谢两位作者的无私开源，让这个插件有机会站在巨人的肩膀上。

---

本项目由零代码基础开发者在无电脑、无 Root 的 Android 设备上完成，累计消耗约 2 亿免费 token。

## License

MIT — 见 [LICENSE](./LICENSE)。
