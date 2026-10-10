// switch-controller / impl / cooldown —— 真切节流（切换冷却）归此文件管。
// 回答的问题：距上次真切多久了？这次切换该被拦、还是升档放行？
//
// 状态：sessionId -> lastSwitchTs。连续 pre-execute 命中同一会话时，
// 冷却内不重复 selectModel，避免模型选择器抖动（Step3 验证项 5）。
// v0.7.8 方向区分：升档（chat→work，含 routeMode==='work'）跳过冷却立即放行；
// 降档（work→chat）与同档切换仍受冷却约束。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）。

/**
 * @typedef {object} CooldownAPI
 * @property {Map<string, number>} switchState
 * @property {number} SWITCH_COOLDOWN_MS
 * @property {(sid: string, opts: object) => ({blocked: boolean, bypass?: boolean})} gate
 * @property {number} SWITCH_STATE_CAP —— 有界上限（v0.8.7 步骤9，与 SESSION_MODE_CAP 同口径 500）
 * @property {(sid: string, ts: number) => void} mark —— 带淘汰的有界写入（替代裸 switchState.set）
 */

// v0.8.7 步骤9（千问审计 P2-9：无界 Map 淘汰）：与 session-mode SESSION_MODE_CAP 同口径。
// FIFO + 写刷新：同 sid 复写提到最新，超限删最旧。读不提升（时间戳自带有效性，无需 LRU）。
export const SWITCH_STATE_CAP = 500;

function boundedSet(map, cap, k, v) {
  try {
    if (map.has(k)) map.delete(k);
    map.set(k, v);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  } catch { try { map.set(k, v); } catch { /* noop */ } }
}

export function createCooldown({ cap = SWITCH_STATE_CAP } = {}) {
  // 真切节流：sessionId -> lastSwitchTs。
  const switchState = new Map();
  const SWITCH_COOLDOWN_MS = 60 * 1000; // 历史默认（现已被 cfg.switchCooldownMs 覆盖，默认 5000）

  /**
   * 有界写入：真切成功后记节流时间戳（替代裸 switchState.set，保证上限）。
   * @param {string} sid
   * @param {number} ts
   */
  function mark(sid, ts) {
    boundedSet(switchState, cap, sid, ts);
  }

  /**
   * 冷却闸门（逻辑自 realSwitch 原样搬移，含日志与返回语义）。
   * @param {string} sid
   * @param {{cooldownMs: number, isUpgrade: boolean, ctx: object, tag: string,
   *          safeLog: Function}} o
   * @returns {{blocked: boolean, bypass?: boolean}}
   */
  function gate(sid, o) {
    const { cooldownMs, isUpgrade, ctx, tag, safeLog } = o;
    const now = () => Date.now();
    try {
      const last = switchState.get(sid);
      if (!isUpgrade && last && now() - last < cooldownMs) {
        const remain = cooldownMs - (now() - last);
        safeLog(ctx, 'warn', `${tag} | early-return reason=downgrade-cooldown-blocked (${now() - last}ms since last switch; remain=${remain}ms)`);
        return { blocked: true };
      }
      if (isUpgrade && last && now() - last < cooldownMs) {
        safeLog(ctx, 'info', `${tag} | reason=upgrade-bypass-cooldown (${now() - last}ms since last switch; chat->work instant)`);
        return { blocked: false, bypass: true };
      }
    } catch { /* Map 异常不阻断 */ }
    return { blocked: false };
  }

  return { switchState, SWITCH_COOLDOWN_MS, SWITCH_STATE_CAP: cap, gate, mark };
}
