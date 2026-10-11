// first-turn / impl / pending-store —— 首轮待定消息留存（reject + steer 重发的登记处）。
// 回答的问题：被 reject 消费掉的首轮消息放哪，等答案落定后拿什么重发？
//
// 口径（阶段二 T1/T3 实测约束）：
//   - key = sid；value = { content, source, savedAt }（content/source 均为 structuredClone 深拷贝，
//     不保留原冻结对象的引用；agent 不存此处，用 __finish 闭包的 live agent，避免跨闭包引用失效）。
//   - 有界（默认 500，FIFO 淘汰最旧），防 blocked/error 轮不派发 turn-stopping 导致的泄漏。
//   - 登记（save）→ 防重（peek/has + __settled 旗双保险）→ 清理（consume/delete），
//     参考 dsh-user-questions queuedReplies 模式（callId→sid）。
//   - 本文件零依赖、零副作用，可离线单测；不 import 任何跨域实现。

const DEFAULT_CAP = 500;

function cloneDeep(v) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(v);
  } catch { /* 回退 JSON */ }
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

export function createPendingFirstTurnStore(cap = DEFAULT_CAP) {
  const map = new Map();
  const lim = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.trunc(Number(cap)) : DEFAULT_CAP;
  function evictIfNeeded() {
    try {
      while (map.size >= lim) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    } catch { /* 淘汰失败不阻断 */ }
  }
  return {
    save(sid, entry) {
      const id = String(sid ?? '').trim();
      if (!id || id === 'unknown') return false;
      if (!entry || typeof entry !== 'object') return false;
      evictIfNeeded();
      try {
        map.set(id, {
          content: cloneDeep(entry.content),
          source: cloneDeep(entry.source),
          savedAt: Date.now(),
        });
        return true;
      } catch { return false; }
    },
    peek(sid) {
      try { return map.get(String(sid ?? '')) ?? null; } catch { return null; }
    },
    has(sid) {
      try { return map.has(String(sid ?? '')); } catch { return false; }
    },
    consume(sid) {
      try {
        const id = String(sid ?? '');
        const v = map.get(id) ?? null;
        if (v !== null && v !== undefined) map.delete(id);
        return v ?? null;
      } catch { return null; }
    },
    delete(sid) {
      try { return map.delete(String(sid ?? '')); } catch { return false; }
    },
    clear() {
      try { map.clear(); } catch { /* noop */ }
    },
    get size() {
      try { return map.size; } catch { return 0; }
    },
  };
}
