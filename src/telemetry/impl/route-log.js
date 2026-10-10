// telemetry / impl / route-log —— 诊断落盘与文件读写底座。
// 回答的问题：这一轮的决策怎么留痕？DSH_HOME 下的文件怎么读写？
// 零注入依赖：全部动态 import（node:os / node:path / node:fs），失败一律静默，
// 诊断绝不阻断主流程。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）。

/**
 * @typedef {object} RouteLogAPI
 * @property {(homeDir?: string) => Promise<string>} getDshHomeDir
 * @property {(p: string) => Promise<string>} readTextFile
 * @property {(p: string, s: string) => Promise<void>} writeTextFile
 * @property {(entry: object) => Promise<void>} appendRouteLog
 */

/**
 * @typedef {object} RouteLogOptions
 * @property {() => (boolean|Promise<boolean>)} [isEnabled] —— v0.8.7 步骤8 telemetry 开关（缺省 null=恒开）
 * @property {() => number} [maxBytes] —— 轮转上限（字节，超限先降级到 .1 归档）；缺省 5MB
 */

export function createRouteLog(opts = {}) {
  const { isEnabled = null, maxBytes = null } = opts;
  // v0.8.7 步骤8：用户消息原文截断上限（脱敏口径=只留前 100 字符做取证，避免原文长文落盘）。
  const USER_TEXT_MAX = 100;
  const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
  // v0.5.0: DSH_HOME 解析（动态导入 node:os/path；失败回退默认值，不阻塞 apply）。
  // 纯函数年金：如果调用方传入 homeDir 则直接用（单测/自测钉死路径用）。
  let dshHomeCache = null;
  async function getDshHomeDir(homeDir) {
    if (homeDir) return homeDir;
    if (process.env.DSH_HOME) return process.env.DSH_HOME;
    if (dshHomeCache) return dshHomeCache;
    try {
      const [{ homedir }, { join }] = await Promise.all([import('node:os'), import('node:path')]);
      dshHomeCache = join(homedir(), '.dsh');
    } catch { dshHomeCache = '.dsh'; }
    return dshHomeCache;
  }
  async function readTextFile(p) {
    const { readFile } = await import('node:fs/promises');
    return readFile(p, 'utf8');
  }
  async function writeTextFile(p, s) {
    const { writeFile } = await import('node:fs/promises');
    return writeFile(p, s);
  }

  // JSONL 诊断落盘（auto-router.jsonl）：每次 pre-execute 决策一行，
  // 字段：ts/sid/tool/extractText/task/route/target/actualSel/keepReason/switched/switchError。
  // 失败静默（诊断不能阻断工具链）；路径固定 ~/.dsh/logs/auto-router.jsonl。
  // v0.8.7 步骤8（千问审计）：① telemetry 开关（enableRouteLog=false 直接不落盘）；
  //   ② 用户消息原文（extractText 等文本字段）截断到 100 字符，长文不整段进日志；
  //   ③ 轮转上限：超 maxBytes（默认 5MB）先改名归档到 auto-router.jsonl.1 再写（单档归档）。
  async function appendRouteLog(entry) {
    try {
      if (isEnabled) {
        let on = true;
        try { on = await isEnabled(); } catch { on = true; /* 开关读失败按开（诊断保守可用） */ }
        if (!on) return;
      }
      const home = await getDshHomeDir();
      const { join } = await import('node:path');
      const clean = { ...entry };
      // 文本字段截断：只处理落盘字段本身（不改调用方对象）。
      for (const k of ['extractText', 'reason', 'keepReason', 'target', 'actualSel']) {
        if (typeof clean[k] === 'string' && clean[k].length > USER_TEXT_MAX) {
          clean[k] = clean[k].slice(0, USER_TEXT_MAX) + '…';
        }
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...clean });
      const { appendFile, mkdir, stat, rename } = await import('node:fs/promises');
      const dir = join(home, 'logs');
      try { await mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
      const file = join(dir, 'auto-router.jsonl');
      // 轮转：先查大小，超限归档为 .1（旧 .1 被覆盖 → 磁盘占用有界）。
      try {
        const cap = typeof maxBytes === 'function' ? maxBytes() : DEFAULT_MAX_BYTES;
        const st = await stat(file).catch(() => null);
        if (st && st.size > cap) await rename(file, file + '.1').catch(() => {});
      } catch { /* 轮转失败不阻断本次落盘 */ }
      await appendFile(file, line + '\n', 'utf8');
    } catch { /* 诊断落盘失败不阻断 */ }
  }

  return { getDshHomeDir, readTextFile, writeTextFile, appendRouteLog };
}
