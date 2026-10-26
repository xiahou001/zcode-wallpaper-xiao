// 对 app.asar 做"等长原位补丁"——推荐的注入方式(替代 resources/app 影子目录)。
//
// 为什么比影子目录稳定:
//   影子目录(resources/app)会一直遮蔽 app.asar。ZCode 更新替换 asar 后,旧影子
//   仍在 ⇒ 旧前端配新后端 ⇒ 协议错乱/报错。原位补丁则随更新自然失效(回原生),
//   重新跑一次 apply 即可,永远不会出现新旧错配。
//
// 步骤:① 若从未备份,先把原始 index.html 字节存到 ~/.we-wallpaper/asar-backup/;
//      ② 压缩腾空间 → 注入微型加载器 → 空格补齐到原长 → 原 offset 覆写;
//      ③ 读回校验。文件头不动;Windows 端 Electron 默认不校验 asar 内容哈希。
const fs = require('fs');
const path = require('path');
// ZCode 安装目录:默认 %LOCALAPPDATA%\Programs\ZCode,可用环境变量 ZCODE_DIR 覆盖
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode');
const ASAR = path.join(ZCODE_DIR, 'resources', 'app.asar');
const BACKUP_DIR = path.join(require('os').homedir(), '.we-wallpaper', 'asar-backup');

const fd = fs.openSync(ASAR, 'r');

// ── fuse 安全闸:ZCode.exe 若开启 asar 完整性校验,改写 asar 会让客户端拒绝启动 ──
// 读 Electron fuse 线(哨兵串后的字节;老格式 0/1/2,新格式 ASCII '0'/'1'/' ')。
// 只认「明确开启」;读不出/不含哨兵(老 Electron)一律放行。
function asarIntegrityEnabled() {
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
    if (found < 0) { fs.closeSync(efd); return false; }
    const tail = Buffer.alloc(48);
    fs.readSync(efd, tail, 0, 48, found + SENT.length);
    fs.closeSync(efd);
    // fuse[4] = EnableEmbeddedAsarIntegrityValidation(顺序按 Electron 1.9 线序)
    const b = tail[2 + 4];
    return b === 1 || b === 0x31;   // 二进制 1 或 ASCII '1'
  } catch { return false; }
}
if (asarIntegrityEnabled()) {
  console.error('FUSE GUARD: ZCode 已开启 asar 完整性校验,改写 app.asar 会导致客户端拒绝启动。');
  console.error('请改用 CDP 注入轨道:用 launch-zcode.vbs 启动 ZCode(自动带 --remote-debugging-port),零改文件。');
  process.exit(1);
}

const probe = Buffer.alloc(64);
fs.readSync(fd, probe, 0, 64, 0);
const jsonSize = probe.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const DATA_START = 8 + probe.readUInt32LE(4);

const parts = ['out', 'renderer', 'index.html'];
let node = { files: header.files };
for (const p of parts) node = node.files[p];
const OFF = DATA_START + Number(node.offset);
const SIZE = node.size;
console.log('slot offset=' + OFF + ' size=' + SIZE);

const origBuf = Buffer.alloc(SIZE);
fs.readSync(fd, origBuf, 0, SIZE, OFF);
const orig = origBuf.toString('utf8');

// ── 备份:按 asar 身份(大小+槽位)保存原始字节;ZCode 更新后自动滚动备份 ──
// 旧逻辑只看 meta.json 是否存在就跳过备份,而 ZCode 更新会整体替换 app.asar,
// 导致备份永远停在旧版本 —— 一旦新版本没备份就被补丁污染,再也回不到原生 index.html。
const metaFile = path.join(BACKUP_DIR, 'meta.json');
const asarSize = fs.statSync(ASAR).size;
const genFile = path.join(BACKUP_DIR, 'index.html.' + asarSize + '.bin');
let needBackup = true;
if (fs.existsSync(metaFile) && fs.existsSync(genFile)) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (Number(meta.asarSize) === asarSize && Number(meta.slotOffset) === OFF && Number(meta.slotSize) === SIZE) {
      needBackup = false;
      console.log('备份已存在(asarSize=' + asarSize + '),跳过');
    }
  } catch (e) { /* meta 损坏则重新备份 */ }
}
if (needBackup) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // 若槽位已含注入(重复补丁),先剥离注入标签再备份 —— 永远不把补丁字节当原生备份
  let pristineBuf = origBuf;
  if (orig.includes('127.0.0.1:7396')) {
    const s = orig
      .replace(/<link rel="stylesheet" href="http:\/\/127\.0\.0\.1:7396\/[^\"]*"\s*\/?>/g, '')
      .replace(/<script src="http:\/\/127\.0\.0\.1:7396\/[^\"]*"[^>]*><\/script>/g, '');
    pristineBuf = Buffer.from(s, 'utf8');
    console.log('槽位已含旧注入:备份已剥离注入标签(原生字节)');
  }
  // 先写新代备份,再更新 meta,避免中途失败留下"有 meta 无备份"的状态
  fs.writeFileSync(genFile, pristineBuf);
  fs.writeFileSync(path.join(BACKUP_DIR, 'index.html.bin'), pristineBuf); // 兼容旧 restore 脚本
  fs.writeFileSync(metaFile, JSON.stringify({
    backedUpAt: new Date().toISOString(),
    slotOffset: OFF, slotSize: SIZE, asarSize: asarSize,
    backupFile: path.basename(genFile),
  }, null, 2));
  console.log('原生 index.html 已备份: ' + genFile + ' (' + pristineBuf.length + ' 字节)');
}

// ── 全量 asar 备份(每个 asar 身份一份):槽位级备份救不了"写入中途崩溃/被截断"
// 造成的整个 asar 损坏 —— 那种情况下唯一自救就是整文件还原。341MB 只拷一次。
const fullBak = path.join(BACKUP_DIR, 'app.asar.full.' + asarSize + '.bak');
if (!fs.existsSync(fullBak)) {
  try {
    console.log('全量 asar 备份(每个身份只做一次)…');
    fs.copyFileSync(ASAR, fullBak + '.tmp');
    fs.renameSync(fullBak + '.tmp', fullBak);   // 原子落位:中断不会留下半个备份
    console.log('全量备份完成: ' + fullBak);
  } catch (e) { console.log('全量备份失败(不阻塞补丁): ' + e.message); }
}

// 已是目标形态(async 脚本、无渲染阻塞 link)才允许早退;
// defer 旧形态要继续走重补丁升级为 async(defer 会阻塞 DOMContentLoaded,
// 服务器忙时拖住 ZCode 首屏 —— 正是「有时候打不开 ZCode」的注入侧成因)。
const { buildLoader, hasAnchor } = require('./build-zcode-loader');
const hasAsyncLoader = /<script[^>]*7396\/(?:embed|bootstrap)\.js[^>]*\basync\b[^>]*><\/script>/.test(orig);
const hasBlockingLink = /<link[^>]*127\.0\.0\.1:7396/.test(orig);
if (hasAsyncLoader && !hasBlockingLink) { console.log('ALREADY PATCHED IN ASAR (async loader)'); process.exit(0); }
if (!hasAsyncLoader && orig.includes('bootstrap.js')) console.log('检测到旧形态注入(defer),升级为 async…');
// 锚点闸门放宽:未来 ZCode 改掉 <title>ZCode</title> 文案时,只要还有
// </head> / <body / <meta 任一锚点就继续打(hasAnchor 四层冗余)。
if (!hasAnchor(orig)) { console.error('UNEXPECTED CONTENT: 找不到任何注入锚点(title/head/body/meta),拒绝盲写'); process.exit(1); }

// 构造加载器:按槽位剩余空间自动分三级降级(见 build-zcode-loader.js)
const built = buildLoader(orig, SIZE);
if (!built) {
  console.error('DOES NOT FIT: 槽位 ' + SIZE + ' 字节连极简加载器都放不下。');
  console.error('该 ZCode 版本的 index.html 过于紧凑,请改用影子目录方案(见 README)。');
  process.exit(1);
}
const body = Buffer.from(built.text, 'utf8');
console.log('loader variant=' + built.variant + ' bytes=' + body.length + '/' + SIZE);
const out = Buffer.alloc(SIZE, 0x20); // 空格补齐
body.copy(out);

// ── 更新器稳定性闸:写 asar 前确认文件不在被写入中 ──
// ZCode 更新器替换 asar 需要数秒;若补丁恰好在这窗口写入(先读的头、后写的槽),
// 交错写入会损坏 asar → 更新后客户端打不开。三重判据任一命中即中止,看门狗
// 下一轮再来 —— 慢一步补丁无害,写坏一个 asar 是灾难。
(function stabilityGate() {
  try {
    // ① 槽位内容复读:与最初读取一致(读取间隙没被别人写过)
    const cur = Buffer.alloc(SIZE);
    const fd2 = fs.openSync(ASAR, 'r');
    fs.readSync(fd2, cur, 0, SIZE, OFF);
    fs.closeSync(fd2);
    if (cur.toString('utf8') !== orig) { console.log('stability gate: 槽位在读取间隙被外部修改,中止'); process.exit(1); }
    // ② 150ms 时间窗内 size/mtime 稳定(没人在持续写)
    const s1 = fs.statSync(ASAR);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    const s2 = fs.statSync(ASAR);
    if (s1.size !== s2.size || s1.mtimeMs !== s2.mtimeMs) { console.log('stability gate: asar 正在被写入(疑似更新中),中止补丁'); process.exit(1); }
  } catch (e) { console.log('stability gate: ' + (e && e.message)); process.exit(1); }
})();
fs.closeSync(fd);   // 释放最初那个只读句柄

let wfd;
try {
  wfd = fs.openSync(ASAR, 'r+'); // 只读 fd 不能写,另开读写句柄
} catch (e) {
  console.error('无法打开 app.asar 写入(可能被正在运行的 ZCode 锁定):' + e.message);
  console.error('请完全退出 ZCode 后重新运行本脚本。');
  process.exit(1);
}
try {
  fs.writeSync(wfd, out, 0, SIZE, OFF);
} catch (e) {
  console.error('写入失败:' + e.message);
  console.error('请完全退出 ZCode 后重新运行本脚本。');
  process.exit(1);
} finally {
  fs.closeSync(wfd);
}

// ── 读回校验(强化):全槽位字节比对,而不只是"加载器存在"——
// 写偏了/写短了/尾部截断都能立刻发现,损坏的 asar 绝不留到下一次启动。
const vfd = fs.openSync(ASAR, 'r');
const vbuf = Buffer.alloc(SIZE);
fs.readSync(vfd, vbuf, 0, SIZE, OFF);
fs.closeSync(vfd);
const readback = vbuf.toString('utf8');
if (!vbuf.equals(out)) {
  console.error('READBACK MISMATCH! 读回内容与写入字节不一致(asar 可能被并发修改),立即中止。');
  if (readback.indexOf('7396/') < 0 || readback.indexOf('bootstrap.js') < 0) {
    console.error('读回内容里连加载器都没有 —— 请用 ~/.we-wallpaper/asar-backup 还原后重试。');
  }
  process.exit(1);
}
console.log('PATCHED IN PLACE: ' + body.length + '/' + SIZE + ' bytes used at offset ' + OFF + '(读回校验通过)');
console.log('提示:ZCode 更新后注入会自然失效回原生(不报错),重新运行 apply 即可。');
