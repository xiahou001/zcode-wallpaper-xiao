// repair.js — 一条命令把 ZCode 壁纸恢复可用(专治「ZCode 一更新壁纸就没了」)。
//
// 它按顺序做四件事,任何一步失败都会明确说明原因并停下,不破坏现有可用状态:
//   ① 校验并自愈 state.json(settings-schema.sanitizeState)
//   ② 对 app.asar 做原位补丁(等长覆写 renderer/index.html,插入壁纸加载器)
//   ③ 清理 resources/app 影子目录(存在会遮蔽 asar,更新后造成新旧错配)
//   ④ 确认壁纸服务器在跑,不在就用隐藏窗口拉起
//
// 用法:
//   node tools/repair.js            # 完整修复
//   node tools/repair.js --dry-run  # 只体检,不改动任何字节
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const repo = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode');
const ASAR = path.join(ZCODE_DIR, 'resources', 'app.asar');
const SHADOW = path.join(ZCODE_DIR, 'resources', 'app');
const node = process.execPath;
const out = (s) => console.log(s);
let failures = 0;

function zcodeRunning() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8', timeout: 10000 });
    return /ZCode\.exe/i.test(r.stdout || '');
  } catch { return true; }
}

function serverUp() {
  return new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port: 7396, path: '/api/state', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  out('=== ZCode 壁纸修复' + (DRY ? ' (dry-run)' : '') + ' ===');
  out('安装目录: ' + ZCODE_DIR);
  out('ZCode 运行中: ' + (zcodeRunning() ? '是' : '否'));

  // ① state
  out('');
  out('[1/4] 状态文件');
  {
    const r = spawnSync(node, [path.join(repo, 'tools', 'check-state.js')], { encoding: 'utf8', timeout: 20000 });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) { out('  ✗ 状态自愈失败'); failures += 1; }
    else out('  ✓ 状态可用');
  }

  // ② asar
  out('');
  out('[2/4] app.asar 注入');
  if (!fs.existsSync(ASAR)) {
    out('  ✗ 找不到 app.asar: ' + ASAR);
    failures += 1;
  } else if (DRY) {
    out('  (dry-run 跳过写入)');
  } else {
    const r = spawnSync(node, [path.join(repo, 'asar-patch-inplace.js')], { encoding: 'utf8', maxBuffer: 50e6, timeout: 120000 });
    process.stdout.write((r.stdout || '').split('\n').map((l) => (l ? '  | ' + l : l)).join('\n'));
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) { out('  ✗ 注入失败(多半是 ZCode 正在运行占用 app.asar)'); failures += 1; }
    else out('  ✓ 注入就绪');
  }

  // ③ 影子目录
  out('');
  out('[3/4] 影子目录');
  if (!fs.existsSync(SHADOW)) {
    out('  ✓ 不存在(正常)');
  } else if (zcodeRunning()) {
    out('  ! 存在,但 ZCode 正在运行 —— 跳过删除(下次登录自动清理)');
  } else if (DRY) {
    out('  ! 存在,应删除(dry-run 未改动)');
  } else {
    try {
      fs.rmSync(SHADOW, { recursive: true, force: true });
      out(fs.existsSync(SHADOW) ? '  ! 部分删除失败,保留剩余文件' : '  ✓ 已删除');
    } catch (e) { out('  ! 删除失败: ' + e.message); }
  }

  // ④ 服务器
  out('');
  out('[4/4] 壁纸服务器');
  if (await serverUp()) {
    out('  ✓ 127.0.0.1:7396 正常');
  } else if (DRY) {
    out('  ! 未在运行(dry-run 未启动)');
  } else {
    out('  · 未在运行,正在拉起…');
    const child = spawn(node, [path.join(repo, 'server.mjs')], { detached: true, stdio: 'ignore', cwd: repo });
    child.unref();
    let ok = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (await serverUp()) { ok = true; break; }
    }
    if (ok) out('  ✓ 已启动');
    else { out('  ✗ 启动失败,请查看 server-out.log / server-err.log'); failures += 1; }
  }

  out('');
  if (failures === 0) {
    out('结果:全部通过。' + (DRY ? '' : (zcodeRunning() ? ' 重启 ZCode 后生效。' : ' 现在打开 ZCode 即可看到壁纸。')));
  } else {
    out('结果:' + failures + ' 项需要处理(见上方 ✗)。');
    if (zcodeRunning()) out('提示:注入失败通常是 ZCode 正在运行,完全退出 ZCode 后重跑本命令。');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('repair: ' + e.stack || e.message); process.exit(1); });