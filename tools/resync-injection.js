// resync-injection.js — 开机/手动运行的「注入再同步」:
//   ① 对 app.asar 做原位补丁(幂等:已注入则跳过;首次先备份原始字节)
//   ② 补丁成功且 ZCode 未运行时,删除 resources/app 影子目录
//     (影子会遮蔽 asar,ZCode 更新后造成新旧错配;部分删除会破坏客户端,
//      所以 ZCode 运行中一律跳过,下次登录再试)
//   ③ 任何失败都保留现状(影子目录仍是可用注入形态),绝不破坏
// 由 autostart.vbs 在登录时调用一次;也可手动运行。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const repo = path.join(__dirname, '..');
const node = process.execPath;
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode');
const SHADOW = path.join(ZCODE_DIR, 'resources', 'app');

function zcodeRunning() {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8', timeout: 10000 });
    return /ZCode\.exe/i.test(out.stdout || '');
  } catch { return true; }   // 检测不到时按"在运行"处理,宁可保守
}

// ── ① asar 原位补丁(幂等)──
let patchOk = false;
try {
  const r = spawnSync(node, [path.join(repo, 'asar-patch-inplace.js')], { encoding: 'utf8', maxBuffer: 50e6 });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  patchOk = r.status === 0;
} catch (e) { console.log('resync: asar patch failed to run: ' + e.message); }

// ── ② 影子目录:仅在 asar 补丁成功且 ZCode 未运行时删除 ──
if (patchOk && fs.existsSync(SHADOW)) {
  if (zcodeRunning()) {
    console.log('resync: ZCode 正在运行,影子目录保留(下次登录再清理)');
  } else {
    try {
      fs.rmSync(SHADOW, { recursive: true, force: true });
      if (fs.existsSync(SHADOW)) {
        console.log('resync: 影子目录部分删除失败 —— 保留剩余文件,下次登录再试');
      } else {
        console.log('resync: 影子目录已删除(注入改由 asar 补丁承载)');
      }
    } catch (e) {
      console.log('resync: 影子目录删除失败 —— 保留,下次登录再试');
    }
  }
}
console.log('resync: done (patchOk=' + patchOk + ')');
