// 补丁看门狗:壁纸服务器周期性检查 ZCode 客户端的注入补丁是否还在,
// 被 ZCode 自动更新覆盖后自动重新打上。这样"ZCode 更新 → 壁纸掉线"不再需要人工跑 apply.cmd。
//
// 三层职责:
//   ① asar 损坏自愈:补丁写入中途崩溃/被截断会让整个 asar 打不开 → ZCode 起不来。
//      检测 asar 头解析失败 → 从 ~/.we-wallpaper/asar-backup 的全量备份自动还原
//      (按 asar 身份=大小取备份;大小对不上说明更新器正在写,不动,下轮再看)。
//   ② fuse 感知:ZCode 开启 asar 完整性校验后,改写 asar 会让客户端拒绝启动 ——
//      此时彻底不再尝试 asar 补丁(记一次日志),注入交给 CDP 轨道。
//   ③ 常规补丁检查:槽位里没有 bootstrap.js → 重跑 apply.cmd(最小间隔 5 分钟)。
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode');
const ASAR = path.join(ZCODE_DIR, 'resources', 'app.asar');
const UNPACKED_INDEX = path.join(ZCODE_DIR, 'resources', 'app', 'out', 'renderer', 'index.html');
const BACKUP_DIR = path.join(os.homedir(), '.we-wallpaper', 'asar-backup');
const MARK = 'bootstrap.js';           // 注入标志
const CHECK_MS = 60 * 1000;            // 每分钟检查一次
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 两次重打补丁的最小间隔(补丁失败时不要疯狂重试)

let lastApply = 0;
let applying = false;
let fuseSkipLogged = false;
let lastHealAt = 0;
let lastAsarSize = 0;   // 更新检测:patchMissing 时发现 asar 大小变化 = ZCode 更新过

// 事件上报:server.mjs 注入 onEvent 后,看门狗的关键动作进诊断流
// (更新被检测/补丁打上/自愈发生/fuse 跳过),排障不再只能翻 stdout。
function emit(type, data) {
  try { if (module.exports.onEvent) module.exports.onEvent(Object.assign({ type, t: Date.now() }, data || {})); } catch (e) {}
}

// fuse 状态进程级缓存:ZCode.exe 的 fuse 位在安装期固化,运行中不会变;
// 旧实现每分钟同步顺序扫 200MB EXE,期间冻结壁纸服务器事件循环(所有
// 轮询/心跳/媒体流卡顿)。缓存一次探测结果,进程重启才重扫。
let fuseCache = null;
function fuseIntegrityEnabled() {
  if (fuseCache !== null) return fuseCache;
  try {
    const exe = path.join(ZCODE_DIR, 'ZCode.exe');
    const est = fs.statSync(exe);
    const SENT = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
    const CH = 4 * 1024 * 1024;
    const efd = fs.openSync(exe, 'r');
    const buf = Buffer.alloc(CH + SENT.length);
    let pos = 0, found = -1;
    while (pos < est.size && found < 0) {
      const n = fs.readSync(efd, buf, 0, Math.min(buf.length, est.size - pos), pos);
      if (n <= 0) break;
      const i = buf.slice(0, n).indexOf(SENT);
      if (i >= 0) { found = pos + i; break; }
      pos += CH - SENT.length;
    }
    if (found < 0) { fs.closeSync(efd); fuseCache = false; return false; }
    const tail = Buffer.alloc(48);
    fs.readSync(efd, tail, 0, 48, found + SENT.length);
    fs.closeSync(efd);
    const b = tail[2 + 4];   // fuse[4] = EnableEmbeddedAsarIntegrityValidation
    fuseCache = (b === 1 || b === 0x31);
    return fuseCache;
  } catch { fuseCache = false; return false; }
}

// 读 asar 头并返回槽位信息;头解析失败/JSON 损坏 → { corrupt: true }
function readAsarSlot() {
  let fd;
  try {
    fd = fs.openSync(ASAR, 'r');
    const probe = Buffer.alloc(64);
    fs.readSync(fd, probe, 0, 64, 0);
    const jsonSize = probe.readUInt32LE(12);
    if (!(jsonSize > 0 && jsonSize < 64 * 1024 * 1024)) return { corrupt: true };
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    let header;
    try { header = JSON.parse(jsonBuf.toString('utf8')); } catch (e) { return { corrupt: true }; }
    const dataStart = 8 + probe.readUInt32LE(4);
    let node = { files: header.files };
    for (const p of ['out', 'renderer', 'index.html']) node = (node.files || {})[p];
    if (!node || node.offset == null) return { corrupt: true };
    const off = dataStart + Number(node.offset);
    const buf = Buffer.alloc(Math.min(node.size, 8192));
    fs.readSync(fd, buf, 0, buf.length, off);
    return { off, size: node.size, marked: buf.toString('utf8').includes(MARK) };
  } catch { return { corrupt: true }; }
  finally { try { if (fd) fs.closeSync(fd); } catch (e) {} }
}

// 损坏自愈:从同身份(大小一致)的全量备份整文件还原。ZCode 正在运行时不还原
// (文件被映射占用,还原既写不进也没意义 —— 损坏的 asar 本来就起不来)。
function healCorruptAsar(asarSize) {
  const bak = path.join(BACKUP_DIR, 'app.asar.full.' + asarSize + '.bak');
  if (!fs.existsSync(bak)) { console.log('[watchdog] asar 疑似损坏但没有同身份全量备份,无法自愈(请重装/更新 ZCode)'); return false; }
  if (require('./server-zcode-running.js').zcodeRunning()) { console.log('[watchdog] asar 疑似损坏,但 ZCode 正在运行 —— 跳过还原,下轮再看'); return false; }
  try {
    console.log('[watchdog] asar 损坏,从全量备份还原…');
    fs.copyFileSync(bak, ASAR + '.restore.tmp');
    fs.renameSync(ASAR + '.restore.tmp', ASAR);   // 原子替换
    console.log('[watchdog] asar 还原完成,下轮重打补丁');
    return true;
  } catch (e) {
    console.log('[watchdog] asar 还原失败: ' + e.message);
    return false;
  }
}

function zcodeRunning() {
  try {
    const out = require('child_process').spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8', timeout: 10000 });
    return /ZCode\.exe/i.test(out.stdout || '');
  } catch { return true; }
}

function patchMissing() {
  // 已解包目录存在 → 只看 index.html 是否还有注入
  if (fs.existsSync(UNPACKED_INDEX)) {
    try {
      return !fs.readFileSync(UNPACKED_INDEX, 'utf8').includes(MARK);
    } catch { return true; }
  }
  // ZCode 更新检测:asar 大小与上次不同 = 更新器动过
  try {
    const sz = fs.statSync(ASAR).size;
    if (lastAsarSize && sz !== lastAsarSize) emit('update-detected', { from: lastAsarSize, to: sz });
    lastAsarSize = sz;
  } catch (e) {}
  const r = readAsarSlot();
  if (r.corrupt) {
    // 头都读不出 = 损坏(或更新器正在写)。用文件稳定性区分:150ms 内 mtime 不变才算真损坏。
    try {
      const s1 = fs.statSync(ASAR);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      const s2 = fs.statSync(ASAR);
      if (s1.size !== s2.size || s1.mtimeMs !== s2.mtimeMs) return false;   // 正在被写,不动
      if (Date.now() - lastHealAt < 10 * 60 * 1000) return false;           // 刚自愈过,别连环还原
      lastHealAt = Date.now();
      healCorruptAsar(s1.size);
      return false;   // 本轮结束,还原成功下轮重打补丁
    } catch { return false; }
  }
  return !r.marked;
}

function runApply() {
  if (applying || Date.now() - lastApply < MIN_INTERVAL_MS) return;
  // fuse 感知:完整性校验开启后改 asar = 客户端拒绝启动,彻底不试(CDP 轨道接管)
  if (fuseIntegrityEnabled()) {
    if (!fuseSkipLogged) { fuseSkipLogged = true; console.log('[watchdog] 检测到 asar 完整性校验已开启:不再尝试 asar 补丁,注入由 CDP 轨道承担'); emit('fuse-skip'); }
    return;
  }
  applying = true;
  console.log('[watchdog] 检测到补丁丢失,重新打补丁…');
  execFile('cmd.exe', ['/d', '/s', '/c', 'apply.cmd'], { cwd: ROOT, timeout: 120000 },
    (err, stdout, stderr) => {
      applying = false;
      lastApply = Date.now();
      console.log('[watchdog] ' + (err
        ? '打补丁失败: ' + String(stderr || err.message).trim()
        : '打补丁完成: ' + String(stdout).trim().replace(/\s+/g, ' | ')));
      emit(err ? 'patch-failed' : 'patch-applied', { error: err ? String(stderr || err.message).slice(0, 160) : undefined });
    });
}

const timer = setInterval(() => { if (patchMissing()) runApply(); }, CHECK_MS);
timer.unref();
// 启动时先查一轮
setTimeout(() => { if (patchMissing()) runApply(); }, 15 * 1000).unref();
console.log('[watchdog] 补丁看门狗已启动(每 60s 检查一次;含 asar 损坏自愈与 fuse 感知)');
module.exports = { patchMissing, onEvent: null, startPatchWatchdog: () => {} }; // 定时器随模块加载即启动
