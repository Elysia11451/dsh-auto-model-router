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

export function createRouteLog() {
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
  async function appendRouteLog(entry) {
    try {
      const home = await getDshHomeDir();
      const { join } = await import('node:path');
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      const { appendFile, mkdir } = await import('node:fs/promises');
      const dir = join(home, 'logs');
      try { await mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
      await appendFile(join(dir, 'auto-router.jsonl'), line + '\n', 'utf8');
    } catch { /* 诊断落盘失败不阻断 */ }
  }

  return { getDshHomeDir, readTextFile, writeTextFile, appendRouteLog };
}
