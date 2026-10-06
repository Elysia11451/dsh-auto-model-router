# Changelog

## 0.7.1 — 2026-10-06

系统重试消息过滤（isHumanInput，commit 99d2be0）：

- **根因**：`dsh-auto-continue` 的失败重试通知把 `source.kind` 伪造成 `"user"`（为了在聊天界面渲染气泡），旧 `extractUserText` 只看 `role==='user'`，把重试通知当真人指令做路由决策，导致失败重试轮次误触发模型切换。
- **修复**：新增 `isHumanInput(m)`——`source.kind==='user'` 且无 `producer` 署名且 `form!=='notice'` 才算真人；`extractUserText` 返回 `{text, skipReason, rejectedText}`，末条 user 形消息是非人注入时返回 `skipReason='system-retry-skipped'`，`agent/pre-step` 整轮跳过路由（`return next()`，不切换），并落 `agent/pre-step/skip` 日志（`reason=system-retry-skipped`，含被拒原文前 300 字供取证，每轮只记一次）。无文本非人消息仍走旧形状探针路径。
- **测试**：`test/crash.test.mjs` +3（auto-continue 重试通知形状 → 跳过不切换 / 非 user kind → 旧探针路径 / 真人消息 → 正常路由切 chat），npm test 101 全绿（router 36 / crash 35 / leaderboard 30）。
- **生产状态不变**：`disabled: true`，不部署。

## 0.7.0 — 2026-10-06

FreeTierError 应对 + 排行榜补完（m00002 规格）：

- **背景**：our-free-model 免费层上游 403 FreeTierError，免费池真机验证不再可行（上游策略，不绕）。策略调整为「动态榜只是加分项，静态链才是底线」：代码开发照常，free 层真机测试停做。
- **`leaderboard.js` 补完（v0.7.0 重写）**：恢复被 0.7.0 中期裁掉的全套导出——`rankIntersection` / `pickTop` / `fetchRankOrder` / `createLeaderboardCache` / `DEFAULT_WORK_MODEL` / `CACHE_TTL_MS` / `OR_URL`（此前 `src/index.js:18` 与两个测试文件仍 import 这些名字，仓库处于坏中间态，crash/leaderboard 测试在 import 处即炸 `SyntaxError: ... does not provide an export named 'CACHE_TTL_MS'`）。
- **数据源换公开榜**：`OR_URL = https://openrouter.ai/api/v1/models?sort=agentic-high-to-low`（免 Key），`fetchRankOrder` 全异步 + `FETCH_TIMEOUT_MS=5000` 硬超时（AbortController + Promise.race，超时/非 2xx/结构异常/网络抛一律 null 不抛），失败调用方立即走静态链，绝不阻塞主线程。
- **两级归一化对名 `matchesNorm`**：等值或一端为另一端前缀——`space-bunny-alpha ↔ space-bunny`、`nemotron-3-ultra-550b-a55b ↔ nemotron-3-ultra` 前缀抹平；`deepseek-v4.1-flash ≠ deepseek-v4-flash`（第 11 位 `.` vs `f` 分叉）不误配，`deepseek-v4-flash-0731` 前缀命中。纯 exact 只能中 6/10。
- **静态降级链 `workModelPriority`（新配置键）**：`DEFAULT_WORK_MODEL_PRIORITY = ['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash']`，`router.js DEFAULTS` 链入（单一事实源在 leaderboard.js），Config schema `Schema.array(Schema.string())` 不带默认值（validate 缺失不带键，DEFAULTS 兜底，防盖坑）。`pickWorkModelFromChain` 按链序对可用清单挑（两级归一化），全不中/清单未就绪落 `workModelFallback`。
- **接线**：`currentWorkModel()` 动态路径失败（榜空/清单空/交集空/异常/`enableDynamicRanking=false`）统一走 `pickWorkModelFromChain`；降级日志改报链头。
- **本地文件缓存**：新增 `loadRankCache` / `saveRankCache`（`.cache/rankings.json` 相对 DSH_HOME，`{ts,ids}`、1h TTL、损坏即当没有、IO 失败静默）；启动预热先读文件缓存（新鲜直接进内存），榜单只在过期时打上游（少一次冷启动请求）；刷新成功落盘。
- **修 `fetchRankOrder` 作用域 bug**：`let timer` 原在 try 块内、`finally` 引用 → 每次调用抛 `ReferenceError: timer is not defined`（5 个用例全红）。移出到函数级。
- **补 v0.7.0 测试覆盖（13 例，85 → 98 全绿）**：`DEFAULT_WORK_MODEL_PRIORITY` 常量与冻结态、`pickWorkModelFromChain` 六态（链头命中/顺序跳过/全不中回退/空链/清单未就绪/原写法保留）、`loadRankCache` 五态（round-trip/缺文件/过期/损坏/缺 ts/空 ids）、`saveRankCache` 三态（拒绝空 ids 与空路径）、`DEFAULTS.workModelPriority` 单一事实源断言、crash 集成级链接线（隔离 DSH_HOME 夹具 + `enableDynamicRanking:false`，链头不可用时真切到链第二位，证明接线而非单值回退）。
- **修 `pickWorkModelFromChain` 匹配 bug（新测试逮出）**：实现原是精确 Set 查找（`availNorm.has`），与注释承诺的两级匹配不符——`deepseek-v4-flash` 对不上清单里的 `deepseek-v4-flash-0731`。改为与 `rankIntersection` 同一套 `matchesNorm`（等值或前缀），仍返回链上原写法。
- **测试**：npm test 85 全绿（router 35 / crash 31 / leaderboard 19），`FAIL` 0，exit 0。
- **生产状态不变**：`cordis.patch.yml` 仍 `disabled: true`，不部署。

## 0.6.0 — 2026-10-05

阶段一（钩子覆盖面）+ 阶段二（路由错位 / 投影读取）：

- **阶段一 新增 `agent/pre-step` 钩子**：旧版只挂 `tools/pre-execute`，纯聊天轮（无工具调用）根本不进钩子 ⇒ QQ 轨迹零活动、模型不切。`agent/pre-step` 在 `Inbox.claim()` 之后、每个拟议步骤前触发，覆盖所有用户消息进入的轮次。独立 try/effect 注册，失败不连累既有 `tools/pre-execute`。与 pre-execute 用 `stepRouted`（`sid|turn|文本签名`）去重，同轮只判一次。真切 `await + 1500ms` 上限（fire-and-forget 会与本步 prompt 组装赛跑）。文本提取取 `role==='user'` 最后一条并跳过 `source.kind==='model-selection'` 的切换通知；无 user 角色时退化取最后一条有文本消息；取不到文本时按 `sid|turn|step` 落 `agent/pre-step/probe` 形状探针，不静默丢轮。
- **阶段二 修复点一（路由错位）**：`decideRoute` 原本末尾「source=main 兜底无条件 return work」越权，导致 `task:chat` 仍落 `route:work`、目标被 work 象限（动态榜 TOP）吃掉，`chatModel` 永远轮不到。现在 `classifyTask === 'chat'` ⇒ `route.mode === 'chat'`，与 source（main/im/group）无关；只有 `agent-work` 才进 work。旧断言 `main ui routes to work`（把 bug 写死）改写为 `main ui chat stays chat` + 新增 `main ui agent keywords still route to work`。
- **阶段二 修复点二（投影读取）**：新增 `readSelectionForRoute(sid)` 三段降级读取 —— 投影 `pending/assembled` → 会话 `requestHeader().config`（真实请求配置，外部漂移也落这里）→ 本插件台账 `lastSwitch`；三段全空才判 `(projection-unreadable)`。旧路只有 `pending/assembled`，读不到就退回台账，常年 `(projection-unreadable)` ⇒ `shouldSwitch` 盲判。读不出时 pre-step **保守不覆盖**，`keepReason=projection-unreadable-fallback` 并落 warn 日志；投影在场但无选择记录返回 `(no-selection)`，与"读不出"区分，正常判定。
- **诊断**：pre-step 决策后补一条 `tool: agent/pre-step/decision`（`target` / `keepReason` / `switched` / 切后 `actualSel`），阶段二真机核对靠这行。
- 单测 85 绿（router 35 / crash 31 / leaderboard 19），`not ok` 0。

## 0.5.3 — 2026-10-05

未知模型纠偏开关（m02002 实锤：IM 会话外部漂移到 `our-free-model/muse-spark-1.2-contributor-free/balanced`，台账外来判定保守 kept，闲聊路由失效）：

- **现场**：turn48 用户中止 → `session/end-seed` 后紧接一条无来源的 `model/selection → muse-spark-1.2/balanced`（非本插件真切——本插件切换必写 `lastSwitch` 台账且目标是 chat/work 配置对），turn49 起请求头全是 1.2。v0.5.2 的冷启动跨类放行只覆盖**空台账**分支；本例台账在（mimo）且 durable 是外来值 → `mine` 不匹配 → `user-manual-selection-kept` → 路由永久失效。
- **新配置键 `reclaimUnknownModel`（boolean，默认 true，{zh,en} 描述）**：台账外来/跨类未命中时，若当前模型既非聊天目标（`resolveChatTarget` 对）也非配置干活对（`workProvider/workModel`、`workProvider/workModelFallback`、生效的手动锁对）→ 判为未知漂移，放行真切（日志 `reason=reclaim-unknown-model`）；`false` → 维持保守"不认识就不动"。`routeMode` 缺省（旧调用路径）不纠偏，读不出（sel 缺 provider/model）不纠偏 —— 绝不赌。
- **`router.js` 新增纯函数 `isUnknownDrift({selProvider, selModel, chatTargetProvider, chatTargetModel, knownWorkPairs})`**：已知集合全部来自配置零硬编码。**刻意不含动态榜单交集成员**：实测交集 TOP 恰是漂移目标 `muse-spark-1.2`（OR rank #23，目录在册且 available），记成已知会让纠偏在生产失灵；路由器自己选出的动态模型必写 `lastSwitch` 台账，台账匹配先于本判定放行。
- **既有语义守卫**：三条"手动优先"用例（durable pending 跨模型 / durable header / 冷启动同类保守）改配 `reclaimUnknownModel:false` —— 它们守的正是关闭纠偏时的保守语义，默认开启时未知外来值按新规格会被纠偏。
- 单测 78 → 83 全绿：router +3（未知漂移两组 + 读不出保守），crash +2（纠偏开 → 必切回 `glm-5.3-flash`；纠偏关 → `user-manual-selection-kept` 零切换，均带 61s 时移绕开节流证明拒绝来自纠偏门而非 cooldown）。

## 0.5.2 — 2026-10-05

冷启动空台账误判修复（m01659 QQ 故障实锤：IM 会话 `session-9e5baf1e` seq927 "你现在的模型是？" chat 路由被短路，seq928 仍 muse-1.2 回复）：

- **根因**：`manualKeepReason` 在 `lastSwitch` 为空（冷启动/重启失忆）时直接返回 `'user-manual-selection-kept'`，`pre-execute` + `realSwitch` 双短路，`annotateRoute.target` 置 null 只注解不真切 —— 路由永久短路。隔离 r1–r7 没暴露：自测都先用路由真切预置档位写 `lastSwitch` 台账再测，`mine` 一直在。
- **修复**：`router.js` 新增纯函数 `isColdStartCrossKind({selProvider, routeMode, workProvider, chatTargetProvider})` —— chat 路由 + durable 停 work 档 → 放行（work→chat）；work 路由 + durable 停 chat 档 → 放行（chat→work）；同类/第三方/缺参/回退合并（work===chatP）→ 保守 false **绝不赌**。用 provider 档位判定不用模型名（动态榜会换模型名，provider 稳定），模型只来自配置零硬编码。`manualKeepReason(sid, services, routeMode)` 空台账分支调 `resolveChatTarget` + 该函数做二次判定，放行即打 `cold-start reroute allowed … reason=cold-start-cross-kind` 日志并返回 null，`realSwitch` 重写 `lastSwitch` 台账。
- **透传链补齐（crash 3 FAIL 实锤）**：pre-execute 火后真切曾裸调 `realSwitch(sid, target)` 丢 route.mode，自测 runRoute 同样丢 —— 二次判定缺 routeMode 保守短路，跨类也切不动。现三处透传：pre-execute `realSwitch(sid, target, route?.mode ?? '')`、runRoute `manualKeepReason(sid, null, route?.mode)` + `realSwitch(sid, target, route?.mode ?? '')`。另 runRoute 手动尊重检查补上 manualKeepReason（含二次判定），与 pre-execute 主体同序，否则自测/生产口径对不上。
- **自测新增 r8 回合**：t13（durable 停 work 档→闲聊切回 chat 目标 + coldLog≥1）、t14（durable 停 chat 档→工作指令切到 work 目标 + coldLog≥1）；`all` 含全部 20 项。语义更新：原“durable chat kept under work command”老断言过时（v0.5.1 台账为空假设），改写为跨类放行断言，保守语义由新增“cold-start same lane stays kept”承接。
- 单测 78 全绿：router +4（`isColdStartCrossKind` 跨类×2/同类保守/不可归类保守），crash +2（冷启动 chat/work 跨类放行）+ 改写 1 + 同类保守 1。

## 0.5.1 — 2026-10-05

「用户手动选择绝对优先」+ 手动锁定 work 模型 + 真 Schemastery Config（对应 m01006 规格）：

- **手动选择绝对优先（功能一）**：新增 `manualKeepReason(sid, services)`——会话存在 durable `model/selection`（投影 `pending`）或 durable `request/header`（`requestHeader().config`）即视为用户显式选择，`realSwitch` 在 controller 解析**前**短路返回 `{ok:false, reason:'user-manual-selection-kept'}`，`pre-execute` 置 `target:null/kept/keepReason`；状态读不出（会话缺失/无投影服务/异常）时保守返回 `selection-state-unreadable` **绝不赌覆盖**。不再依赖"同类保留"间接推断，跨模型/跨类型的手动选择一律不覆盖。
- **手动锁定 work 模型（功能二）**：新增 Config 键 `manualWorkModel`（`provider/model`，默认空）+ `manualWorkModelLocked`（默认 false）；`router.js: parseManualWorkLock` 解析（prov/mod 按首 `/` 拆、裸名配 `workProvider`、空/残缺不成锁）。锁生效时：`currentWorkModel/ensureFresh/refreshLeaderboard` 三处守卫——**OpenRouter 请求计数 0 增长**、工作真切落手动 pair、`annotateRoute` 手动 pair 压过动态榜与 modelOverride，日志 `reason=manual-work-model-locked`。
- **真 Schemastery Config（废除 stub）**：`import Schema from '@deepseek-ai/schemastery'` 静态导入，`export const Config = Schema.object({...})`——规格 7 键带默认 + `{zh,en}` 描述，运维键（chatProvider/workProvider/workEffort 等）不带默认以保 `{...DEFAULTS,…config}` 兜底，`selftest/selftestRound/selftestOut` 走 `union(boolean,string)`。**v0.5.0 的 Config 直通兜底 stub 是 dsh-settings `describe()` 抛错、轨迹消失、模型页红字、手动选择被覆盖的连锁根因，本版彻底移除**（依赖直拷入 `node_modules/@deepseek-ai/schemastery` 3.18.4 + `@standard-schema/spec` + `@deepseek-ai/cosmokit`，实测链式 `.description({zh,en})` 落 `meta.description`、`union(['free','owned'])` 字面量校验、object 校验保留未知键）。
- **自测新增 r6 回合**：t11（锁开→真切落手动 pair + 锁下 `refreshLeaderboard` fetchDelta=0 + 锁日志 ≥1）、t12（锁关有值不成锁 / 锁开空值不成锁 / 恢复后真切落动态或回退且 `currentWorkModel()` 不再钉死）；t6 改写为严格语义（`reason==='user-manual-selection-kept'` + 投影 before/after 不变）。`all` 回合含全部 12 项。
- 单测 58 → 68：router +5（`parseManualWorkLock` 禁用/空值/prov-mod/裸名/斜杠边角），crash +5、改写 2（durable pending 跨模型/跨类型不覆盖、durable header 阻断、投影读不出保守保留、锁开真切手动 pair（夹具用 1.3 证压过回退）、锁关/空值回退动态），harness `makeCtx` 补默认 pristine `sessionProjections/sessions`。全绿。
- **自测预建会话单次消费坑（iso2 r6 首跑实锤）**：回合会话按 `ACTIVE_TAGS` 预建进 `preSids`，`takeSid` 取走即置 null；t11/t12 块内额外调 `takeSid` 会把 `runRoute` 的预建会话吞掉 → `session-create-failed` 假阴性。修复：块内不再取，空 sid 统一由 `runRoute` 的 note 口径处理。
- **来源判定（m01290 内部模拟逼出的核心语义修正）**：纯 durable 门会把**路由自己先前切出的** chat/work 中间态误判为手动，四象限来回切直接失效。`manualKeepReason` 增加台账比对——durable 选择与 `lastSwitch`（仅本插件真切成功时写入的 `provider/model/effort`）一致 ⇒ 路由自有态放行；不一致 ⇒ 用户改过绝对保持；台账缺失的旧会话保守保持。
- **群聊提示动态档从不触发修复（s4 实锤的潜伏 bug）**：`maybeGroupHint` 判档传的是裸模型名（`pending.model` / `lastSwitch` 的 model 段），动态最强模型（如 `muse-spark-1.2…`）既不含 `cfg.workModel` 也不含 `cfg.workProvider` ⇒ `isWorkModelRef` 恒 false ⇒ 提示从未在动态档下触发过。改传 `provider/model` 完整 ref。
- **隔离内部模拟 r7（m01290 六项）**：新增 `runRoute` 的 `preset` 前置档位（路由自有真切建立）与 s1–s6 六块——私聊 work→chat、私聊 chat→work（查日志）、群聊 chat→work（写个脚本）、群聊 work→chat + 提示恰好一次（冷却生效）、手动 selectModel（用户路径）绝不覆盖、全局默认三读 + 新开主界面会话零污染；每项记录真实 model/selection 投影值。
- 单测 68 → 71：+`isWorkModelRef` provider-ref 语义、+来源判定两条（台账一致放行 / 台账在但外来值仍保持）。
- **自测节流污染修复（r7 首跑实锤）**：r7 的 s1–s4 用"路由自有真切"建立前置档位后 300ms 即走路由真切，撞上生产 60s 同会话节流（`SWITCH_COOLDOWN_MS`）→ 全部 `reason=cooldown` 假阴性。修复：`runRoute` 的 `preset` 分支与 s4 手写 pre4 在置档后清 `switchState.delete(sid)`（前置档是"稳态模拟"而非刚发生的真实切换；生产节流逻辑不动）。重跑 r7 六项全绿。
- **t6 硬编码 + 投影竞态修复（r3 实锤）**：t6 手动模型曾硬编码 `muse-spark-1.3-contributor-free`——当动态榜首恰为该模型时 `same-kind` 与 `manual-keep` 语义撞车，且读回只等 300ms，宿主回收窗口下 `(projection-unreadable)` 直接判 fail。修复：手动模型取配置回退值（禁硬编码），读回 3×500ms 重试、仍读不出判 `pass:null` 跳过（环境抖动不记失败）。重跑 t6 教科书级通过（手动 mimo 档 + 动态榜首 muse-1.2 故意不同 + `user-manual-selection-kept` + before/after 一字不差）。
- **全部回合最终代码复跑全绿（2026-10-05 夜）**：r7（s1–s6 六项）+ r1（t1/t2）+ r2（t3/t4）+ r3（t5/t6）+ r4（t7/t8）+ r5（t9/t10）+ r6（t11/t12）——18 项断言零失败，iso2 `agent-default-model` 条目 `our-free-model/mimo-v2.6-flash-free` 纹丝未动（全局零污染实锤）。

## 0.5.0 — 2026-10-05

收尾两项遗留缺陷 + 隔离验证扩充：

- **chatModel 空值回退**（Config 描述此前吹了牛没兑现）：新增纯函数 `router.js: resolveChatTarget`——`chatModel` 留空时回退 `workProvider/workModelFallback`（免费池恒可用，聊天仍走 light 档），10 分钟限频打警告；目标两头都空时置 `target: null` 只注解不真切，**杜绝向 `selectModel` 传空 model**。此前空 chatModel 会让每次 IM 闲聊真切都失败。
- **chatModel `prov/mod` 格式解析**：插件表单只暴露 `chatModel` 键（`chatProvider` 走 patch/默认），表单用户按 Config 描述填 `provider/model` 此前会被整体当裸模型名发出（provider 错配必失败）；现按第一个 `/` 拆分。裸模型名仍搭配 `chatProvider`。
- **enableDynamicRanking=false 可观测**：新增 `lbFetchCount` 请求计数器（guard/inflight 短路不计），自测 t10 临时翻转开关断言"0 次增长 + `currentWorkModel()` 直接回退配置值"。
- **自测新增 r5 回合**：t9（chatModel 空回退——真切后真实投影落在 `workProvider/workModelFallback`）、t10（动态榜关闭不请求）；`all` 回合含全部 10 项。
- **Config schema 直通兜底（隔离验证实锤的激活级缺陷）**：旧兜底 `Config = {}` 是 truthy 但没有 `["~standard"].validate`（cordis resolveConfig 的 standard-schema 接口）⇒ `undefined.validate` TypeError，**整个插件 entry 激活失败**。触发场景：插件经软链加载时 `@deepseek-ai/schemastery` 在真实路径上溯找不到 node_modules（ERR_MODULE_NOT_FOUND）。新兜底为最小标准模式直通对象：`validate:(v)=>({value})`（原样放行、不校验不改写）+ `toJSON:()=>({})`（保住宿主 `'toJSON' in schema` 的设置页投影）。schemastery 可用时仍走完整 Schema。
- **selftest 结果落盘修复**：flush 分支裸调 `writeFile`（未导入）→ `[selftest] flush failed: writeFile is not defined`，`SELFTEST_DONE` 打了但 JSON 从未写出；改走模块内 `writeTextFile`。
- 单测 51 → 58：router +4（`resolveChatTarget` 拆分/裸名/空回退/斜杠边角），crash +3（空 chatModel 真切断言、`prov/mod` 拆分断言、动态榜关闭 0 fetch + 回退值断言，fetch spy 挂在测试窗口内、前序用例的预热 fetch 均在窗口前调用无串扰）。全绿。
- `npm test` 脚本由 `node --test test/` 改为逐文件直跑（本机 node --test wrapper 被 linker 弄坏；直跑跨环境也更兼容）。

## 0.4.0 — 2026-10-05

- 死代码清理：删除 `isUserWorkChoice`（按 provider 全家判定，与精确同类 `isSameKind` 口径冲突，且全仓零引用）——手动尊重统一走 `shouldSwitch/isSameKind`。

## 0.3.0 — 2026-10-05

三缺陷修复（对应 m01990 验收）：

- **动态最强模型**：新增 `src/leaderboard.js`——OpenRouter 公开热度榜（`?sort=most-popular`，免 Key，1h 内存缓存）与本地 `our-free-model` 可用清单（catalog + availability，60s 刷新）求交，取排名最高者；榜单/网络不可用时回退 `workModel` 配置值。归一化匹配（去机构前缀与 `-free/-contributor/:free` 后缀）实测 13 清单命中 10。注意 `files` 已补 `src/leaderboard.js`（此前漏登记会导致装完不生效）。
- **尊重手动选择**：`readSelectionProjection`（`model/selection` 投影 `pending ?? assembled`）判定当前档位；同类型（目标 work 且当前已是 `our-free-model` 任意模型 / 目标 chat 且当前已在同 provider）→ 短路 `same-kind-kept`，只注解 `kept` 不覆盖。`realSwitch` 入口与 `pre-execute` 真切点双设卡点。
- **UI 同步确认**：`selectModel` 成功后读回投影做一致性确认，不一致打 `warn`（前端经投影 broadcast 自动刷新，通常只是刷新延迟）；`same-kind-kept` 两条路径此前静默，现都写 `info` 日志（困惑来源已消除）。
- 自测驱动新增 `dynamic / manual / uisync` 三项；`SELFTEST_DONE.failures` 口径修正（`fallback ok:false` 是期望降级、`manual same-kind-kept` 是期望保持，不再误报）。
- 隔离验证（iso2，真 sessionController + 真投影读回）9 项全绿：rule1（GLM/light，省略 effort 重试 21ms）、rule2（MiMo/deep 10ms）、rule3（提示 1 次+冷却+`/switch chat` 文案）、pollution（默认 `deepseek-official/deepseek-v4-flash` 不变+拦截）、jitter（5 连切 0 错）、fallback（降级+hook 存活）、dynamic（466 榜单×9 可用→`space-bunny-free`）、manual（手动 1.3 保持+preKept）、uisync（投影一致+0 warn）。
- 单测：router 12 + crash 15 + leaderboard 19 = 46 项全绿。

## 0.2.0 — 2026-10-04

移动端规范重写（对应 dsh-mobile-apk 适配要求）：

- 导出形态：具名导出 `name / inject / apply`，无 `export default`。
- `inject = ['tools', 'llm']` 显式声明。
- `apply()` 只做同步注册（`ctx.effect` + `yield ctx.on('tools/pre-execute', …)`），长阻塞操作全部异步化。
- 路由改为**非侵入式注解**：期望档位写 `exec.autoModelRouter` 旁路，不再直接调用 `session/selectModel`（v0.1.x 直接切模型曾导致会话模型抖动）。
- 安全阀：pre-execute 全程 `try...catch`，所有分支 `return next()`，catch 中放行；apply 注册失败只记日志不抛错。
- 依赖检查：`llm.resolveModelInfo` 异步探测 work 模型，缺失/不兼容时明确警告并降级为纯日志模式。
- 新增 `lib/client.js` 浏览器半（WebView 兼容 CSS/JS，无 Node 专属 API）。
- 打包：`files` 含入口 + patch + README/CHANGELOG/LICENSE；`dsh.bundle.patch` 指向 `./cordis.patch.yml`；`peerDependencies` 声明 `dsh-our-free-model >= 1.4.0`；semver。
- 专项验证：`test/router.test.mjs`（11 用例：IM→chat / 主界面→work / 4 关键词升级 / 群聊提示+节流）与 `test/crash.test.mjs`（6 用例：异常 exec / kind 未定义注入 / next 抛错 / free-model 缺失降级 / apply 注册失败不抛 / 注解不污染原字段）全绿。

## 0.1.0 — 2026-10-04（已废弃）

- 初版：`session/created` + `agent/pre-step` 直接调用 `session/selectModel` + `session/appendEvent` 切模型。
- 废弃原因：`ctx.call` 在生产 cordis 中无命中，直接切模型导致会话模型抖动；且缺 `tools/pre-execute` 安全阀，曾引发 DSH 崩溃（`Cannot read properties of undefined (reading 'kind')`）。
