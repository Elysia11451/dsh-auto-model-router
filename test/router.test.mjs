import assert from 'node:assert/strict';
import { classifyTask, sourceFromMeta, isGroupMeta, isSameKind, decideRoute, buildGroupHint, normalizeEffortForSwitch, buildSelectModelPayload, resolveChatTarget, parseManualWorkLock, isColdStartCrossKind, isUnknownDrift, isWorkModelRef, DEFAULTS } from '../src/router.js';

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

// 精确同类：provider/model 全等才算同类，不按全家判定
t('isSameKind is exact, not family', () => {
  assert.equal(isSameKind('our-free-model/muse-spark-1.3-contributor-free/deep', 'our-free-model', 'muse-spark-1.3-contributor-free'), true);
  assert.equal(isSameKind('our-free-model/muse-spark-1.3-contributor-free/deep', 'our-free-model', 'space-bunny-x1.1-free'), false);
  assert.equal(isSameKind('zai-coding-cn/glm-5.3-flash/light', 'zai-coding-cn', 'glm-5.3-flash'), true);
  assert.equal(isSameKind('zai-coding-cn/glm-5.4/light', 'zai-coding-cn', 'glm-5.3-flash'), false);
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

console.log('router tests done');
