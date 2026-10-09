import assert from 'node:assert/strict';
import { classifyTask, sourceFromMeta, isGroupMeta } from '../src/routing-policy/impl/classifier.js';
import { isSameKind, decideRoute, buildGroupHint, normalizeEffortForSwitch, buildSelectModelPayload, resolveChatTarget, parseManualWorkLock, isColdStartCrossKind, isUnknownDrift, isWorkModelRef, nextSessionMode, DEFAULTS, createDecider } from '../src/routing-policy/impl/decider.js';
import { DEFAULT_WORK_MODEL_PRIORITY } from '../src/leaderboard/leaderboard.js';
import { createRealSwitch } from '../src/switch-controller/impl/real-switch.js';
import { createBoundedMap, SESSION_MODE_CAP } from '../src/routing-policy/impl/session-mode.js';
import { createCooldown, SWITCH_STATE_CAP } from '../src/switch-controller/impl/cooldown.js';

const t = (name, fn) => { try { fn(); console.log(`ok - ${name}`); } catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; } };

// 规则一：IM 聊天 -> chat（强制回自有，哪怕停在 work 档）
t('im chat routes to chat', () => {
  const r = decideRoute({ source: 'im', text: '今天天气怎么样', meta: { channel: 'weixin' } });
  assert.equal(r.mode, 'chat');
});
t('im chat forces back from work (private)', () => {
  const r = decideRoute({ source: 'im', text: '你好', meta: { channel: 'weixin' }, currentMode: 'work' });
  assert.equal(r.mode, 'chat');
  assert.equal(r.workStyle, 'owned');
});
t('qq/telegram route to chat', () => {
  for (const ch of ['qq', 'telegram', 'tg', 'discord']) {
    const r = decideRoute({ source: 'im', text: 'hello', meta: { channel: ch } });
    assert.equal(r.mode, 'chat', ch);
  }
});

// v0.6.0 修复点一：classifyTask 判 chat ⇒ route 必须 chat，与 source 无关
// （旧断言「main ui routes to work」把「main 兜底无条件 work」的 bug 写死了）
t('main ui chat stays chat (source must not force work)', () => {
  const r = decideRoute({ source: 'main', text: '随便看看' });
  assert.equal(r.mode, 'chat');
  const r2 = decideRoute({ source: 'main', text: '今天天气怎么样' });
  assert.equal(r2.mode, 'chat');
});
t('main ui agent keywords still route to work', () => {
  for (const kw of ['帮我装插件', '跑命令看日志', '写代码实现', '操作文件整理']) {
    const r = decideRoute({ source: 'main', text: kw });
    assert.equal(r.mode, 'work', kw);
  }
});

// 规则二：IM 中明确要求工作 -> work（4 关键词）；私聊策略 free/owned 分叉
t('im agent keywords escalate to work', () => {
  for (const kw of ['帮我装插件', '跑命令看日志', '写代码实现', '操作文件整理']) {
    const r = decideRoute({ source: 'im', text: kw, meta: { channel: 'weixin' } });
    assert.equal(r.mode, 'work', kw);
  }
});
t('private work free vs owned strategy', () => {
  const f = decideRoute({ source: 'im', text: '帮我装插件', meta: { channel: 'weixin' }, strategy: 'free' });
  assert.equal(f.mode, 'work');
  assert.equal(f.workStyle, 'free');
  const o = decideRoute({ source: 'im', text: '帮我装插件', meta: { channel: 'weixin' }, strategy: 'owned' });
  assert.equal(o.mode, 'work');
  assert.equal(o.workStyle, 'owned');
});
t('group work always free-dynamic', () => {
  const r = decideRoute({ source: 'im', text: '帮我装插件', meta: { channel: 'qq', chatType: 'group' }, strategy: 'owned' });
  assert.equal(r.mode, 'work');
  assert.equal(r.workStyle, 'free');
});

// v0.8.7 千问审计 P0-1：同类判定升级为 (provider, model, effort) 三元组
// - 目标 effort 缺失（3 参调用）→ 非同类（原固化的 true 已改为 false）
// - effort 已知且相等 → 同类；effort 不等 → 非同类
t('isSameKind is exact triple (provider, model, effort)', () => {
  assert.equal(isSameKind('our-free-model/muse-spark-1.3-contributor-free/deep', 'our-free-model', 'muse-spark-1.3-contributor-free'), false);
  assert.equal(isSameKind('our-free-model/muse-spark-1.3-contributor-free/deep', 'our-free-model', 'space-bunny-x1.1-free'), false);
  assert.equal(isSameKind('zai-coding-cn/glm-5.3-flash/light', 'zai-coding-cn', 'glm-5.3-flash'), false);
  assert.equal(isSameKind('zai-coding-cn/glm-5.4/light', 'zai-coding-cn', 'glm-5.3-flash'), false);
  // effort 相等 → 同类
  assert.equal(isSameKind('our-free-model/muse-spark-1.3-contributor-free/deep', 'our-free-model', 'muse-spark-1.3-contributor-free', 'deep'), true);
  // effort 不等（同模型 light vs deep）→ 非同类
  assert.equal(isSameKind('our-free-model/muse-spark-1.3-contributor-free/light', 'our-free-model', 'muse-spark-1.3-contributor-free', 'deep'), false);
  // 归一化：max→deep、off→light 视为相等
  assert.equal(isSameKind('prov/mod/max', 'prov', 'mod', 'deep'), true);
  assert.equal(isSameKind('prov/mod/off', 'prov', 'mod', 'light'), true);
  // 当前 effort 未知（'-'）→ 保守同类（避免无 effort 菜单模型反复真切）
  assert.equal(isSameKind('prov/mod/-', 'prov', 'mod', 'deep'), true);
});

// v0.8.7 新增：chat 和 work 解析到同一模型但 effort 不同 → 断言触发切换
t('same model different effort triggers switch', () => {
  const noop = () => {};
  const sw = createRealSwitch({
    ctx: {}, cfg: {}, flags: {}, getService: noop, safeLog: noop,
    lastSwitch: new Map(), cooldown: { switchState: new Map(), gate: () => false },
    knownWorkPairs: () => [], currentWorkModel: () => 'mimo-v2.6-flash-free',
    resolveChatTarget, isColdStartCrossKind, isUnknownDrift, isSameKind,
    buildSelectModelPayload, DEFAULT_WORK_MODEL: 'mimo-v2.6-flash-free',
  });
  const target = { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', effort: 'deep' };
  // 同模型但当前是 light、目标 deep → 必须真切
  assert.notEqual(sw.shouldSwitch('our-free-model/muse-spark-1.3-contributor-free/light', target), null);
  // 同模型同 effort → 不切
  assert.equal(sw.shouldSwitch('our-free-model/muse-spark-1.3-contributor-free/deep', target), null);
  // 不同模型 → 切
  assert.notEqual(sw.shouldSwitch('zai-coding-cn/glm-5.3-flash/light', target), null);
});

// 规则三：群聊+work -> hint；私聊不 hint
t('group chat on work model needs hint', () => {
  const r = decideRoute({ source: 'im', text: '大家好', meta: { chatType: 'group' }, currentMode: 'work' });
  assert.equal(r.mode, 'chat');
  assert.equal(r.needHint, true);
  assert.match(buildGroupHint(), /工作模型/);
});
t('private chat needs no hint', () => {
  const r = decideRoute({ source: 'im', text: '你好', meta: { channel: 'weixin' }, currentMode: 'work' });
  assert.equal(r.needHint, false);
});

// source/meta 边角
t('conversationKey implies im', () => {
  assert.equal(sourceFromMeta({ conversationKey: 'abc' }), 'im');
});
t('participants array >2 is group', () => {
  assert.equal(isGroupMeta({ participants: ['a', 'b', 'c'] }), true);
  assert.equal(isGroupMeta({ participants: ['a', 'b'] }), false);
});
t('classifyTask defaults to chat', () => {
  assert.equal(classifyTask('今天吃什么'), 'chat');
});
t('defaults point at free work model', () => {
  assert.equal(DEFAULTS.workProvider, 'our-free-model');
  assert.equal(DEFAULTS.workModel, 'mimo-v2.6-flash-free');
  assert.equal(DEFAULTS.workModelFallback, 'mimo-v2.6-flash-free');
  assert.equal(DEFAULTS.privateChatWorkStrategy, 'free');
  assert.equal(DEFAULTS.workEffort, 'deep');
  assert.equal(DEFAULTS.chatEffort, 'light');
});
t('defaults carry v0.7.0 static work chain (single source of truth)', () => {
  assert.deepEqual([...DEFAULTS.workModelPriority], ['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash']);
  assert.deepEqual([...DEFAULTS.workModelPriority], [...DEFAULT_WORK_MODEL_PRIORITY], 'DEFAULTS 链必须与 leaderboard 导出一致');
});
t('legacy ui efforts normalize to adapter ids', () => {
  assert.equal(normalizeEffortForSwitch('max'), 'deep');
  assert.equal(normalizeEffortForSwitch('off'), 'light');
  assert.equal(normalizeEffortForSwitch('minimal'), 'light');
  assert.equal(normalizeEffortForSwitch('deep'), 'deep');
});
t('selectModel payload passes sessionId through untouched', () => {
  const p = buildSelectModelPayload({ sessionId: 'session-9f3a', provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', effort: 'max' });
  assert.equal(p.sessionId, 'session-9f3a');
  assert.equal(p.reasoningEffort, 'deep');
});

// v0.5.0：chat 目标解析（表单格式 / 空回退）
t('resolveChatTarget parses prov/mod format', () => {
  const ct = resolveChatTarget({ chatProvider: 'zai-coding-cn', chatModel: 'my-api/glm-x', workProvider: 'our-free-model', workModelFallback: 'mimo-v2.6-flash-free' });
  assert.equal(ct.provider, 'my-api');
  assert.equal(ct.model, 'glm-x');
  assert.equal(ct.source, 'configured');
});
t('resolveChatTarget bare model keeps chatProvider', () => {
  const ct = resolveChatTarget({ chatProvider: 'zai-coding-cn', chatModel: 'glm-5.3-flash', workProvider: 'our-free-model', workModelFallback: 'fb' });
  assert.equal(ct.provider, 'zai-coding-cn');
  assert.equal(ct.model, 'glm-5.3-flash');
  assert.equal(ct.source, 'configured');
});
t('resolveChatTarget empty chatModel falls back to workProvider/fallback', () => {
  const ct = resolveChatTarget({ chatProvider: 'zai-coding-cn', chatModel: '', workProvider: 'our-free-model', workModelFallback: 'mimo-v2.6-flash-free' });
  assert.equal(ct.provider, 'our-free-model');
  assert.equal(ct.model, 'mimo-v2.6-flash-free');
  assert.equal(ct.source, 'fallback');
});
t('resolveChatTarget tolerates malformed slash edges', () => {
  assert.equal(resolveChatTarget({ chatProvider: 'p', chatModel: '/leading' }).provider, 'p');
  assert.equal(resolveChatTarget({ chatProvider: 'p', chatModel: 'trailing/' }).provider, 'p');
  assert.equal(resolveChatTarget({ chatProvider: 'p', chatModel: '   ' }).source, 'fallback');
});

// v0.5.1：手动锁定 work 模型解析（parseManualWorkLock）
t('manual lock disabled regardless of modelRef', () => {
  const l = parseManualWorkLock({ locked: false, modelRef: 'prov/mod', fallbackProvider: 'p' });
  assert.equal(l.on, false);
  assert.equal(l.why, 'lock-disabled');
});
t('manual lock enabled but empty modelRef is inert', () => {
  const l = parseManualWorkLock({ locked: true, modelRef: '', fallbackProvider: 'p' });
  assert.equal(l.on, false);
  assert.equal(l.why, 'empty');
});
t('manual lock parses prov/mod format', () => {
  const l = parseManualWorkLock({ locked: true, modelRef: 'our-free-model/mimo-v2.6-flash-free', fallbackProvider: 'other' });
  assert.equal(l.on, true);
  assert.equal(l.provider, 'our-free-model');
  assert.equal(l.model, 'mimo-v2.6-flash-free');
  assert.equal(l.reason, 'manual-work-model-locked');
});
t('manual lock bare model pairs fallbackProvider', () => {
  const l = parseManualWorkLock({ locked: true, modelRef: 'bare-model', fallbackProvider: 'our-free-model' });
  assert.equal(l.on, true);
  assert.equal(l.provider, 'our-free-model');
  assert.equal(l.model, 'bare-model');
});
t('manual lock malformed slash edges stay safe', () => {
  // '/leading'、'trailing/' 按裸名处理（与 resolveChatTarget 口径一致），绝不产生空 model
  const a = parseManualWorkLock({ locked: true, modelRef: '/leading', fallbackProvider: 'p' });
  assert.equal(a.on, true);
  assert.ok(a.model.length > 0);
  const b = parseManualWorkLock({ locked: true, modelRef: 'trailing/', fallbackProvider: 'p' });
  assert.equal(b.on, true);
  assert.ok(b.model.length > 0);
  const c = parseManualWorkLock({ locked: true, modelRef: '  ', fallbackProvider: 'p' });
  assert.equal(c.on, false);
});

// isWorkModelRef 判档语义（m01290 s4 实锤的潜伏 bug）：必须传 provider/model 完整 ref——
// 裸动态模型名既不含 workModel 也不含 workProvider，恒 false（旧调用点正是这样漏掉群聊提示的）。
t('isWorkModelRef matches provider ref, bare dynamic name alone does not', () => {
  const workModel = 'mimo-v2.6-flash-free';
  const workProvider = 'our-free-model';
  assert.equal(isWorkModelRef('our-free-model/muse-spark-1.2-contributor-free', workModel, workProvider), true);
  assert.equal(isWorkModelRef('muse-spark-1.2-contributor-free', workModel, workProvider), false, 'bare name is the historical miss');
  assert.equal(isWorkModelRef('our-free-model/mimo-v2.6-flash-free', workModel, workProvider), true);
  assert.equal(isWorkModelRef('zai-coding-cn/glm-5.3-flash', workModel, workProvider), false);
  assert.equal(isWorkModelRef('', workModel, workProvider), false);
});

// v0.5.2：冷启动空台账二次判定（isColdStartCrossKind）——模型只来自配置，零硬编码。
// 用「档位」判定（provider 级跨类），不用「模型名」：动态榜会换模型名，provider 稳定。
t('cold-start chat reroutes from work lane (cross-kind)', () => {
  assert.equal(isColdStartCrossKind({ selProvider: 'our-free-model', routeMode: 'chat', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), true);
});
t('cold-start work reroutes from chat lane (cross-kind)', () => {
  assert.equal(isColdStartCrossKind({ selProvider: 'zai-coding-cn', routeMode: 'work', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), true);
});
t('cold-start same lane stays conservative (no reroute)', () => {
  assert.equal(isColdStartCrossKind({ selProvider: 'our-free-model', routeMode: 'work', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), false);
  assert.equal(isColdStartCrossKind({ selProvider: 'zai-coding-cn', routeMode: 'chat', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), false);
});
t('cold-start unclassifiable stays conservative (third-party / missing / fallback-merge)', () => {
  assert.equal(isColdStartCrossKind({ selProvider: 'other-api', routeMode: 'chat', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), false);
  assert.equal(isColdStartCrossKind({ selProvider: '', routeMode: 'chat', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), false);
  assert.equal(isColdStartCrossKind({ selProvider: 'our-free-model', routeMode: '', workProvider: 'our-free-model', chatTargetProvider: 'zai-coding-cn' }), false);
  // chat 回退到免费池时 work===chatP，无法分类 → 保守（不赌）
  assert.equal(isColdStartCrossKind({ selProvider: 'our-free-model', routeMode: 'chat', workProvider: 'our-free-model', chatTargetProvider: 'our-free-model' }), false);
});

// v0.5.3：未知漂移判定（isUnknownDrift，reclaimUnknownModel 门控）——已知集合全部来自配置。
t('unknown drift: external model not chat/work config is reclaimed', () => {
  // 实测漂移现场：our-free-model/muse-spark-1.2-contributor-free 既非聊天目标也非配置 workModel
  assert.equal(isUnknownDrift({
    selProvider: 'our-free-model', selModel: 'muse-spark-1.2-contributor-free',
    chatTargetProvider: 'zai-coding-cn', chatTargetModel: 'glm-5.3-flash',
    knownWorkPairs: ['our-free-model/mimo-v2.6-flash-free'],
  }), true);
  // 第三方 provider 同样是未知漂移
  assert.equal(isUnknownDrift({
    selProvider: 'other-api', selModel: 'mystery-model',
    chatTargetProvider: 'zai-coding-cn', chatTargetModel: 'glm-5.3-flash',
    knownWorkPairs: ['our-free-model/mimo-v2.6-flash-free'],
  }), true);
});
t('unknown drift: known chat/work config pairs stay manual-priority', () => {
  const known = ['our-free-model/mimo-v2.6-flash-free', 'our-free-model/mimo-v2.6-flash-free'];
  // 聊天目标（prov/mod 形式）→ 已知
  assert.equal(isUnknownDrift({
    selProvider: 'zai-coding-cn', selModel: 'glm-5.3-flash',
    chatTargetProvider: 'zai-coding-cn', chatTargetModel: 'glm-5.3-flash',
    knownWorkPairs: known,
  }), false);
  // 配置 workModel 对 → 已知
  assert.equal(isUnknownDrift({
    selProvider: 'our-free-model', selModel: 'mimo-v2.6-flash-free',
    chatTargetProvider: 'zai-coding-cn', chatTargetModel: 'glm-5.3-flash',
    knownWorkPairs: known,
  }), false);
  // chatModel 为空时 resolveChatTarget 回退的免费池目标也算已知（调用方传 fallback 对）
  assert.equal(isUnknownDrift({
    selProvider: 'our-free-model', selModel: 'mimo-v2.6-flash-free',
    chatTargetProvider: 'our-free-model', chatTargetModel: 'mimo-v2.6-flash-free',
    knownWorkPairs: [],
  }), false);
});
t('unknown drift: unreadable selection never reclaimed (do not gamble)', () => {
  assert.equal(isUnknownDrift({ selProvider: '', selModel: '', chatTargetProvider: 'zai-coding-cn', chatTargetModel: 'glm-5.3-flash', knownWorkPairs: [] }), false);
  assert.equal(isUnknownDrift({ selProvider: 'our-free-model', selModel: '', chatTargetProvider: 'zai-coding-cn', chatTargetModel: 'glm-5.3-flash', knownWorkPairs: [] }), false);
});

t('classifyTask recognizes 建文件 variants as work', () => {
  assert.equal(classifyTask('帮我在工作区建个 test-model-switch.txt 写入“切换测试”'), 'agent-work');
  assert.equal(classifyTask('帮我在工作区建个 test.txt 写入测试'), 'agent-work');
  assert.equal(classifyTask('新建文件 test.txt'), 'agent-work');
  assert.equal(classifyTask('创建文件 test.txt'), 'agent-work');
  assert.equal(classifyTask('生成文件 report.md'), 'agent-work');
  assert.equal(classifyTask('please create file test.txt'), 'agent-work');
});


// ── v0.7.2 状态机真值表（nextSessionMode 纯函数，8 行全覆盖 + 阈值边界）──
t('S1 chat + tool call -> work/0 (升档铁证)', () => {
  assert.deepEqual(nextSessionMode('chat', true, false, 0), { mode: 'work', chatTurns: 0 });
});
t('S2 chat + keywords (首轮预判) -> work/0', () => {
  assert.deepEqual(nextSessionMode('chat', false, true, 0), { mode: 'work', chatTurns: 0 });
});
t('S3 chat no tool no keywords -> chat/0 (闲聊保持)', () => {
  assert.deepEqual(nextSessionMode('chat', false, false, 0), { mode: 'chat', chatTurns: 0 });
});
t('S4 work + tool call -> work/0 (干活延续)', () => {
  assert.deepEqual(nextSessionMode('work', true, false, 2), { mode: 'work', chatTurns: 0 });
});
t('S5 work + keywords -> work/0 (清零不断档)', () => {
  assert.deepEqual(nextSessionMode('work', false, true, 2), { mode: 'work', chatTurns: 0 });
});
t('S6 work no tool no keywords counts up (n<2 -> n+1)', () => {
  assert.deepEqual(nextSessionMode('work', false, false, 0), { mode: 'work', chatTurns: 1 });
  assert.deepEqual(nextSessionMode('work', false, false, 1), { mode: 'work', chatTurns: 2 });
});
t('S7 work reaches threshold 3 -> chat/0 (降档)', () => {
  assert.deepEqual(nextSessionMode('work', false, false, 2), { mode: 'chat', chatTurns: 0 });
  // 边界外输入（异常值 >=3）同样降档，不悬空
  assert.deepEqual(nextSessionMode('work', false, false, 9), { mode: 'chat', chatTurns: 0 });
});
t('S8 work + pendingToolCalls freezes counter (禁降档)', () => {
  assert.deepEqual(nextSessionMode('work', false, false, 1, { pendingToolCalls: true }), { mode: 'work', chatTurns: 1 });
  assert.deepEqual(nextSessionMode('work', false, false, 2, { pendingToolCalls: true }), { mode: 'work', chatTurns: 2 });
  // 冻结优先级：仍低于工具调用升档（有工具 -> 归零不算冻结）
  assert.deepEqual(nextSessionMode('work', true, false, 2, { pendingToolCalls: true }), { mode: 'work', chatTurns: 0 });
});
t('S9 边角：非法 currentMode/NaN 计数按 chat/0 兜底', () => {
  assert.deepEqual(nextSessionMode('unknown-mode', false, false, undefined), { mode: 'chat', chatTurns: 0 });
  assert.deepEqual(nextSessionMode(null, false, false, 'abc'), { mode: 'chat', chatTurns: 0 });
  // work 态计数非法值按 0 起算
  assert.deepEqual(nextSessionMode('work', false, false, 'abc'), { mode: 'work', chatTurns: 1 });
});
t('S10 阈值边界序列：work 连续 3 轮无工具无关键词恰好降档，第 1/2 轮不抖动', () => {
  let s = { mode: 'work', chatTurns: 0 };
  s = nextSessionMode(s.mode, false, false, s.chatTurns);
  assert.deepEqual(s, { mode: 'work', chatTurns: 1 }, '第1轮保持 work');
  s = nextSessionMode(s.mode, false, false, s.chatTurns);
  assert.deepEqual(s, { mode: 'work', chatTurns: 2 }, '第2轮保持 work');
  s = nextSessionMode(s.mode, false, false, s.chatTurns);
  assert.deepEqual(s, { mode: 'chat', chatTurns: 0 }, '第3轮降档');
  // 中途来一次关键词 -> 清零重新起算
  s = { mode: 'work', chatTurns: 1 };
  s = nextSessionMode(s.mode, false, true, s.chatTurns);
  assert.deepEqual(s, { mode: 'work', chatTurns: 0 }, '关键词清零');
});

// v0.8.7 步骤9（千问审计 P2-9：无界 Map 淘汰）：三 Map 各塞 501 项，最旧淘汰、最新保留。
// 策略 = FIFO + 写刷新（上限 500，同 SESSION_MODE_CAP 口径；读不提升，无需 LRU；
// key 全是 string 且需 size 淘汰 ⇒ 不用 WeakMap）。
t('v0.8.7 step9: lastSwitch BoundedMap 501 项淘汰最旧保留最新 + 写刷新', () => {
  assert.equal(SESSION_MODE_CAP, 500, 'cap 口径 500');
  const m = createBoundedMap();
  for (let i = 0; i <= 500; i++) m.set(`sess-${i}`, `p/m-${i}`);
  assert.equal(m.size, 500, '501 项后 size=500');
  assert.equal(m.has('sess-0'), false, '最旧 sess-0 被淘汰');
  assert.equal(m.has('sess-500'), true, '最新 sess-500 保留');
  assert.equal(m.has('sess-1'), true, '次旧 sess-1 仍在');
  // 写刷新：复写 sess-1 提到最新，再塞一项，sess-1 不被淘汰、sess-2 成为最旧被淘汰
  m.set('sess-1', 'p/m-1-refresh');
  m.set('sess-501', 'p/m-501');
  assert.equal(m.size, 500, '写刷新后仍有界');
  assert.equal(m.has('sess-1'), true, '被复写的活跃 sess-1 提到最新未被淘汰');
  assert.equal(m.has('sess-2'), false, 'sess-2 成为最旧被淘汰');
  assert.equal(m.has('sess-501'), true, '最新 sess-501 保留');
});
t('v0.8.7 step9: cooldown.switchState mark 501 项淘汰最旧保留最新 + 写刷新', () => {
  assert.equal(SWITCH_STATE_CAP, 500, 'cap 口径 500');
  const cd = createCooldown();
  for (let i = 0; i <= 500; i++) cd.mark(`sess-${i}`, 1000 + i);
  assert.equal(cd.switchState.size, 500, '501 项后 size=500');
  assert.equal(cd.switchState.has('sess-0'), false, '最旧 sess-0 被淘汰');
  assert.equal(cd.switchState.has('sess-500'), true, '最新 sess-500 保留');
  // 写刷新：复写 sess-1 提到最新，再 mark 一项，sess-1 保留、sess-2 被淘汰
  cd.mark('sess-1', 9999);
  cd.mark('sess-501', 10000);
  assert.equal(cd.switchState.size, 500, '写刷新后仍有界');
  assert.equal(cd.switchState.has('sess-1'), true, '活跃 sess-1 未被淘汰');
  assert.equal(cd.switchState.has('sess-2'), false, 'sess-2 成为最旧被淘汰');
  assert.equal(cd.switchState.has('sess-501'), true, '最新 sess-501 保留');
});
t('v0.8.7 step9: hintState 经 maybeGroupHint 501 会话淘汰最旧保留最新', () => {
  const hintState = createBoundedMap();
  const lastSwitch = createBoundedMap();
  const cfg = {
    enableGroupHint: true, workModel: 'w-model', workProvider: 'w-prov',
    hintCooldownMs: 10 * 60 * 1000, hintMaxCount: 20, workEffort: 'deep',
  };
  const dec = createDecider({
    ctx: {}, cfg, flags: {}, manualLock: { on: false },
    lastSwitch, hintState,
    getService: () => null,
    safeLog: () => {},
    currentWorkModel: () => 'w-prov/w-model',
    sidOf: (exec) => exec?.agent?.session ?? '',
  });
  for (let i = 0; i <= 500; i++) {
    const sid = `gsess-${i}`;
    lastSwitch.set(sid, 'w-prov/w-model/deep');
    dec.maybeGroupHint({}, { agent: { session: sid }, meta: { chatType: 'group' } }, { mode: 'chat' });
  }
  assert.equal(hintState.size, 500, '501 会话后 size=500');
  assert.equal(hintState.has('gsess-0'), false, '最旧 gsess-0 被淘汰');
  assert.equal(hintState.has('gsess-500'), true, '最新 gsess-500 保留');
  assert.equal(hintState.has('gsess-1'), true, '次旧 gsess-1 仍在');
});

// ── v0.8.7 步骤8（千问审计）：路由日志脱敏 / telemetry 开关 / 轮转（异步 fs 用例）──
await (async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRouteLog } = await import('../src/telemetry/impl/route-log.js');
  const at = async (name, fn) => { try { await fn(); console.log(`ok - ${name}`); } catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; } };
  // 每用例独立 DSH_HOME（口径同 crash.test withTmpLog：finally 还原 env）。
  const withHome = async (fn) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'router-rlog-'));
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try { await fn(home); }
    finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
  };
  const logFile = (home) => path.join(home, 'logs', 'auto-router.jsonl');

  await at('v0.8.7 step8: 用户消息截断 100 字符落盘，非文本字段原样', async () => {
    await withHome(async (home) => {
      const rl = createRouteLog();
      await rl.appendRouteLog({ sid: 's1', extractText: 'x'.repeat(500), reason: 'y'.repeat(500) });
      const j = JSON.parse((await fs.readFile(logFile(home), 'utf8')).trim());
      assert.equal(j.extractText.length, 101, '100 字符 + 省略号');
      assert.ok(j.extractText.endsWith('…'), '截断以省略号收尾');
      assert.equal(j.reason.length, 101, 'reason 同样截断');
      assert.equal(j.sid, 's1', '非白名单字段不截断');
    });
  });

  await at('v0.8.7 step8: enableRouteLog 关（isEnabled=false）不落盘', async () => {
    await withHome(async (home) => {
      const rl = createRouteLog({ isEnabled: () => false });
      await rl.appendRouteLog({ sid: 's2' });
      let ok = true;
      try { await fs.readFile(logFile(home)); ok = false; } catch { /* ENOENT = 期望 */ }
      assert.ok(ok, '开关关闭时不应产生日志文件');
    });
  });

  await at('v0.8.7 step8: 超 maxBytes 归档为 .1 单档（磁盘有界）', async () => {
    await withHome(async (home) => {
      const rl = createRouteLog({ maxBytes: () => 64 });
      await rl.appendRouteLog({ sid: 'old-1', pad: 'z'.repeat(200) }); // 主文件超 64B
      await rl.appendRouteLog({ sid: 'new' }); // 写前发现超限 → 旧行归档
      const main = await fs.readFile(logFile(home), 'utf8');
      assert.ok(main.includes('"new"'), '新行在主文件');
      assert.ok(!main.includes('"old-1"'), '旧行已移出主文件');
      const arch = await fs.readFile(logFile(home) + '.1', 'utf8');
      assert.ok(arch.includes('"old-1"'), '旧行在 .1 归档');
    });
  });
})();

console.log('router tests done');
