/**
 * src/session-mode.js — v0.7.2 阶段二：会话状态存储层（热 Map + 冷侧车文件）。
 *
 * 规格（执行计划阶段二）：
 *  - 热存储：内存 Map<sid, {mode, chatTurns, updatedAt}>，key=sessionId；有界，>500 清最旧。
 *  - 冷存储：$DSH_HOME/plugin-state/auto-model-router.session-modes.json，
 *    格式 {[sid]: {mode, chatTurns, updatedAt}}；升/降档即时写（fire-and-forget，失败静默）。
 *  - 启动预热：hydrate() 幂等后台读侧车进 Map（参考 warmRankCache 的 fire-and-forget 链）。
 *  - 升/降档事件：onEvent 回调（index.js 落 auto-model-router/mode-changed 会话日志，
 *    参考 @morlay/dsh-session-mode「模式落成会话事实」）。
 *
 * 纪律：零 DSH 依赖、零静态 node: 导入（移动端规范，与 leaderboard.js 同款动态 import），
 * 可离线单测（test/session-mode.test.mjs 用临时目录，生产 profile 零改动）。
 *
 * 事件语义：隐式默认 chat（未记录的会话 = chat）。仅当 mode 实际变化时触发 onEvent：
 *  新会话首写 chat → 不触发（初始化非切换）；新会话首写 work → 触发（chat→work 升档）；
 *  chat↔work 切换 → 触发；chatTurns 计数更新（同模式）→ 只落侧车不触发事件。
 */

// 有界：插入新 sid 前若 map 已达上限，按 Map 插入序清掉最旧一条。
export const SESSION_MODE_CAP = 500;

// v0.8.7 步骤9（千问审计 P2-9：无界 Map 淘汰）：与 SESSION_MODE_CAP 同口径（500）的
// 有界 Map 工厂 —— 供装配根（index.js）的 lastSwitch / hintState 使用。
// 策略 = FIFO + 写刷新：同 key 复写时先删再插（提到最新，防活跃会话被误淘汰）；
// 超限删最旧（Map 插入序）。读不提升（点查 + 条目自带时间有效性，无需 LRU）。
// key 全是 string（sessionId/sessionKey），需 size 淘汰 ⇒ 不用 WeakMap（对象 key 专用、无 size）。
export class BoundedMap extends Map {
  constructor(cap = SESSION_MODE_CAP) {
    super();
    this._cap = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.trunc(Number(cap)) : SESSION_MODE_CAP;
  }
  set(k, v) {
    try {
      if (this.has(k)) super.delete(k);
      super.set(k, v);
      while (this.size > this._cap) {
        const oldest = this.keys().next();
        if (oldest.done) break;
        super.delete(oldest.value);
      }
    } catch { try { super.set(k, v); } catch { /* noop */ } }
    return this;
  }
}
export function createBoundedMap(cap = SESSION_MODE_CAP) {
  return new BoundedMap(cap);
}
// 侧车文件名（相对 $DSH_HOME/plugin-state/）。
export const SESSION_MODE_SIDECAR = 'auto-model-router.session-modes.json';
// 会话日志事件名（升/降档写一条轻量事件，供 UI 和事后核对）。
export const MODE_CHANGED_EVENT = 'auto-model-router/mode-changed';

const normMode = (m) => (m === 'work' ? 'work' : 'chat');
const normInitialMode = (v) => (v === 'work' ? 'work' : (v === 'chat' ? 'chat' : null));
const normWorkToolAsked = (v) => v === true;
const normCount = (n) => {
  const x = Math.trunc(Number(n));
  return Number.isFinite(x) && x > 0 ? x : 0;
};
const normTool = (v) => v === true;
const validSid = (sid) => {
  const id = String(sid ?? '').trim();
  return id && id !== 'unknown' ? id : null;
};

/**
 * 创建会话状态存储。
 * @param {object} [opts]
 * @param {string|(() => (string|Promise<string>))} [opts.homeDir] DSH home（缺省 null = 冷存储关闭，仅热 Map）
 * @param {(ev: {sid: string, prevMode: string, mode: string, chatTurns: number, reason: string|null, updatedAt: number}) => void} [opts.onEvent] 升/降档回调
 */
export function createSessionModeStore({ homeDir = null, onEvent = null } = {}) {
  // v0.7.2 修正（turn 计数）：entry 增加 tool 标记 = 本 turn 是否有真实工具调用。
  // pre-execute 置 true；pre-step 消费后重置 false。观测型工具永不置位。
  const map = new Map(); // sid -> { mode, chatTurns, tool, updatedAt }
  let loaded = false;    // hydrate 幂等旗标（无文件/损坏也置位，避免每次 miss 重读）

  async function sidecarPath() {
    try {
      const home = typeof homeDir === 'function' ? await homeDir() : homeDir;
      if (!home) return null;
      const { join } = await import('node:path');
      return join(home, 'plugin-state', SESSION_MODE_SIDECAR);
    } catch { return null; }
  }

  // 即时写侧车：整份小文件重写（≤500 条）。失败静默（与 appendRouteLog 同纪律）。
  async function save() {
    try {
      const p = await sidecarPath();
      if (!p) return false;
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(p), { recursive: true });
      const obj = {};
      for (const [sid, v] of map) obj[sid] = v;
      await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    } catch { return false; }
  }

  // 启动预热：读侧车进 Map（幂等；内存已有的 sid 不覆盖——热数据优先）。
  // 返回本次新增条数；无文件（冷启动默认 chat）/损坏（视同无文件）都返回 0，绝不抛。
  // 阶段三修正：并发保护 —— read() 撞上在飞预热时等它落地，避免冷启动竞态把
  // 侧车里的既有状态读成"无状态"（会被首轮预判覆写）。
  let loading = null;
  async function doHydrate() {
    let added = 0;
    try {
      const p = await sidecarPath();
      if (!p) return 0;
      const { readFile } = await import('node:fs/promises');
      let raw;
      try { raw = await readFile(p, 'utf8'); } catch { return 0; }
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
      for (const [sid, v] of Object.entries(obj)) {
        const id = validSid(sid);
        if (!id || map.has(id) || !v || typeof v !== 'object') continue;
        if (v.mode !== 'chat' && v.mode !== 'work') continue;
        map.set(id, { mode: v.mode, chatTurns: normCount(v.chatTurns), tool: normTool(v.tool), initialMode: normInitialMode(v.initialMode), workToolAsked: normWorkToolAsked(v.workToolAsked), updatedAt: Number(v.updatedAt) || 0 });
        added++;
      }
    } catch { /* 损坏=冷启动默认 */ }
    return added;
  }
  async function hydrate() {
    if (loading) { try { await loading; } catch { /* noop */ } return 0; }
    if (loaded) return 0;
    loading = doHydrate();
    try { return await loading; } finally { loaded = true; loading = null; }
  }

  // 同步读热 Map（JSONL 诊断字段用，绝不做 IO）。
  function peek(sid) {
    try {
      const id = validSid(sid);
      return id ? (map.get(id) ?? null) : null;
    } catch { return null; }
  }

  // 读状态：优先热 Map，缺失则 hydrate（幂等）后重试（阶段三 pre-step 路由用）。
  async function read(sid) {
    try {
      const id = validSid(sid);
      if (!id) return null;
      const hit = map.get(id);
      if (hit) return hit;
      await hydrate();
      return map.get(id) ?? null;
    } catch { return null; }
  }

  // 写状态（同步更新热 Map + fire-and-forget 落侧车 + 模式变化触发 onEvent）。
  // tool 语义：opts 显式带 tool 时采用；未带时沿用旧值（缺省 false）。
  // pre-execute 置 true，pre-step 消费后置 false。
  function set(sid, opts = {}) {
    try {
      const id = validSid(sid);
      if (!id) return null;
      const o = (opts && typeof opts === 'object') ? opts : {};
      const prev = map.get(id) ?? null;
      const hasInitial = o && typeof o === 'object' && 'initialMode' in o;
      const entry = { mode: normMode(o.mode ?? 'chat'), chatTurns: normCount(o.chatTurns ?? 0), tool: (o && typeof o === 'object' && 'tool' in o) ? normTool(o.tool) : normTool(prev?.tool), initialMode: hasInitial ? normInitialMode(o.initialMode) : (prev?.initialMode === 'work' || prev?.initialMode === 'chat' ? prev.initialMode : null), workToolAsked: ('workToolAsked' in o) ? normWorkToolAsked(o.workToolAsked) : normWorkToolAsked(prev?.workToolAsked), updatedAt: Date.now() };
      const reason = o.reason ?? null;
      const prevMode = prev ? prev.mode : 'chat'; // 隐式默认 chat（冷启动语义）
      if (!map.has(id) && map.size >= SESSION_MODE_CAP) {
        const oldest = map.keys().next(); // Map 插入序 = 最旧
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(id, entry);
      save().catch(() => {}); // 即时写，fire-and-forget，失败静默
      if (prevMode !== entry.mode && typeof onEvent === 'function') {
        try {
          onEvent({ sid: id, prevMode, mode: entry.mode, chatTurns: entry.chatTurns, reason: reason ?? null, updatedAt: entry.updatedAt });
        } catch { /* 事件失败不阻断状态 */ }
      }
      return entry;
    } catch { return null; }
  }

  return { peek, read, set, hydrate, save, sidecarPath, size: () => map.size };
}
