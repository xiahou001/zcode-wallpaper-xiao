// server-zcode-running.js — ZCode 是否在运行的统一探测(供 watchdog 损坏自愈等共用)。
// 独立成 CJS 小模块:watchdog-patch.js(require 进服务器)与 CLI 脚本都要用,
// 检测不到进程状态时按"在运行"处理 —— 宁可保守,不冒险动文件。
const { spawnSync } = require('child_process');

function zcodeRunning() {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8', timeout: 10000 });
    return /ZCode\.exe/i.test(out.stdout || '');
  } catch { return true; }
}

module.exports = { zcodeRunning };
