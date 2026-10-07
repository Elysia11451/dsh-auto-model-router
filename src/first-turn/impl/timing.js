// first-turn / impl / timing —— 首轮弹窗的计时与失败归因。
// 回答的问题：弹窗最多等多久？超时/失败算哪一类降级原因？
//
// 双保险纪律（v0.8.6 方案A）：AbortSignal 超时 + 自有 setTimeout 同时挂，
// 任一生效都能让 ask() 结束，绝不把 pre-step 永久挂住。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）。

/**
 * @typedef {object} AskTimeout
 * @property {AbortSignal} signal
 * @property {number} timeoutMs
 * @property {() => void} clear —— 应答后清定时器，避免悬挂
 */

/**
 * 建一个带超时的 AbortController（无 provider/超时回落 60000，与旧版口径一致）。
 * @param {number|string} ms
 * @returns {AskTimeout}
 */
export function createAskTimeout(ms) {
  let timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 60000;
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch { /* noop */ } }, timeoutMs);
  if (typeof timer.unref === 'function') try { timer.unref(); } catch { /* noop */ }
  return {
    signal: ctl.signal,
    timeoutMs,
    clear() { try { clearTimeout(timer); } catch { /* noop */ } },
  };
}

/**
 * ask() 失败 → 首轮降级 reason（口径与 v0.8.0 完全一致：一律降 chat，不阻塞）。
 * @param {any} err
 * @returns {string}
 */
export function askErrorReason(err) {
  const code = err?.code ?? err?.name ?? '';
  const msg = String(err?.message ?? err ?? '');
  // v0.8.0 指令：NO_PROVIDER / CALLER_NOT_LIVE / DELEGATED_CALLER 统一降级 chat，不阻塞。
  return code === 'NO_PROVIDER' ? 'first-turn-no-provider'
    : (code === 'ASK_TIMED_OUT' || code === 'TimeoutError' ? 'first-turn-timeout'
    : (code === 'ASK_ABORTED' || code === 'AbortError' ? 'first-turn-aborted'
    : (/DELEGATED_CALLER|owned by another|child agent/i.test(msg + code) ? 'first-turn-prompt-failed'
    : (/CALLER_NOT_LIVE|not.*live|live.*agent|runtime root/i.test(msg + code) ? 'first-turn-prompt-failed'
    : 'first-turn-error'))));
}
