#!/usr/bin/env node
/**
 * we-wallpaper — 本地动态壁纸服务器(零依赖,Node >= 18)。
 *
 * 从 dsh-wallpaper-engine 抽出的独立版:扫描 Steam Wallpaper Engine 创意工坊
 * 壁纸,Scene 类型用自带的 WebWallGL 渲染器(vendor/webwallgl,MIT)实时渲染,
 * video 类型直接播放。控制面是纯 HTTP API,供 ZCode skill / player 调用。
 *
 * 路由:
 *   GET  /                          播放页
 *   GET  /api/wallpapers            壁纸清单
 *   GET  /api/state                 当前状态 {currentId, paused, volume, rotate}
 *   POST /api/select {id}           切换壁纸
 *   POST /api/pause  {paused}       暂停/恢复
 *   POST /api/volume {volume}       0..1
 *   POST /api/rotate {enabled, intervalMin}
 *   GET  /preview/<id>              预览图(gif/jpg)
 *   GET  /media/<id>/<file...>      壁纸自有文件(视频等,支持 Range)
 *   GET  /scene-files/<token>/<rest> scene.pkg 载荷(token=base64url(abs))
 *   GET  /wallpaper-engine/scene-live/*  vendored WebWallGL 渲染页
 *
 * 状态持久化:~/.we-wallpaper/state.json
 */
import http from 'node:http';
import { spawn, execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sanitizeState, WALLPAPER_FILTERS } from './settings-schema.js';
import wpWatchdog from './watchdog-patch.js';
import { startCdpInjector } from './cdp-inject.mjs';
const startPatchWatchdog = wpWatchdog.startPatchWatchdog ?? wpWatchdog.start ?? (() => {});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WE_WP_PORT || 7396);
const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.we-wallpaper');
const STATE_FILE = path.join(APP_DIR, 'state.json');
const AUTO_LAUNCH_FLAG = path.join(APP_DIR, 'autostart-zcode.flag');   // 存在=登录时看门狗带 CDP 端口启动 ZCode
const VENDOR_DIR = path.join(__dirname, 'vendor', 'webwallgl');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIVE_PREFIX = '/wallpaper-engine/scene-live';

// ── 配置/状态 ────────────────────────────────────────────────────────────────
// state.json 可加 "workshopDirs": ["<其它含 431960 的目录>"] 补充扫描路径。
let state = {
  currentId: null, paused: false, volume: 1,
  rotate: { enabled: false, intervalMin: 30, playlist: null },   // playlist:轮播列表名
  transition: { kind: 'crossfade', ms: 1800 },                    // 切换过场
  appearance: { main: 0, row: 52, sidebar: 55, brightness: 100, stroke: 35, zoom: 100 },
  readability: { auto: true },                                    // 智能可读性:按壁纸亮度换文字色
  occlusion: 'hidden',                                            // 遮挡暂停:never|hidden|focus
  sceneFps: 30,                                                   // 场景渲染帧率上限
  playlists: [],                                                  // [{name, ids:[]}]
};
try {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = {
    ...state, ...s,
    rotate: { ...state.rotate, ...(s.rotate || {}) },
    transition: { ...state.transition, ...(s.transition || {}) },
    appearance: { ...state.appearance, ...(s.appearance || {}) },
    readability: { ...state.readability, ...(s.readability || {}) },
  };
} catch {}
state = sanitizeState(state);
let luminance = null;   // 播放器实测壁纸亮度 0..1(内存态,不落盘)
let stateVersion = 0;   // 状态版本号:每次落盘 +1,供客户端低成本轮询"外观是否变了"
let nowPlaying = null;  // Windows Now Playing(SMTC via PowerShell,内存态)
const lyricsCache = new Map();

// ── Now Playing 轮询(Windows SMTC via PowerShell WinRT,无原生依赖)──────────
// 拉起常驻 PowerShell(tools/nowplaying.ps1),每 2s 输出一行 JSON;失败静默。
function startNowPlayingPoller() {
  if (process.platform !== 'win32') return;
  try {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'tools', 'nowplaying.ps1')], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    ps.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { nowPlaying = JSON.parse(line); } catch {}
      }
    });
    ps.on('error', () => { nowPlaying = null; });
    ps.unref();
  } catch {}
}
const saveState = () => {
  try {
    state = sanitizeState(state);
    stateVersion += 1;   // 任何外观/状态写入都推进版本,宿主据此立即刷新样式
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
};

// ── 壁纸扫描(参考 dsh-wallpaper-engine 的 Steam 库定位逻辑)──────────────────
function steamLibraries() {
  const vdfs = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Steam/config/libraryfolders.vdf'),
    'C:/Program Files/Steam/config/libraryfolders.vdf',
  ];
  const libs = new Set();
  for (const vdf of vdfs) {
    try {
      const t = fs.readFileSync(vdf, 'utf8');
      for (const m of t.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '/'));
    } catch {}
  }
  return [...libs];
}

// ── WE 官方素材通路(localAssets,源自 dsh-wallpaper-engine)────────────────────
// Wallpaper Engine 安装目录 assets 树里,场景效果链/材质/粒子按名引用的公共贴图
// (util/*、particle/**、gradient/*)不在壁纸 pkg 内。配了素材目录后,vendored 引擎
// (内建 local-assets 客户端)在场景页 URL 带 ?localAssets=1 时探测 /api/local-assets
// 并按名取官方像素,场景渲染与官方引擎逐像素对齐;未配置则静默回落程序化复刻。
// 素材属 WE 版权内容:只从用户本机路径**只读取用**,绝不复制入库(与上游合规口径一致)。
let weAssetsProbe = { dir: null, at: 0 };
function detectWeAssetsDir() {
  if (Date.now() - weAssetsProbe.at < 60_000) return weAssetsProbe.dir;
  weAssetsProbe.at = Date.now();
  const cands = [];
  if (process.env.WE_WALLPAPER_ASSETS_DIR && process.env.WE_WALLPAPER_ASSETS_DIR.trim()) {
    cands.push(process.env.WE_WALLPAPER_ASSETS_DIR.trim());
  }
  for (const lib of steamLibraries()) cands.push(lib + '/steamapps/common/wallpaper_engine/assets');
  weAssetsProbe.dir = null;
  for (const c of cands) {
    try { if (fs.statSync(path.join(c, 'materials')).isDirectory()) { weAssetsProbe.dir = c; break; } } catch {}
  }
  return weAssetsProbe.dir;
}
function weAssetsDir() {   // 手动配置优先;null/空 = 自动探测
  const manual = typeof state.weAssetsDir === 'string' && state.weAssetsDir.trim();
  return manual ? state.weAssetsDir : detectWeAssetsDir();
}
function weAssetsAvailable() {
  const d = weAssetsDir();
  if (!d) return false;
  try { return fs.statSync(path.join(d, 'materials')).isDirectory(); } catch { return false; }
}
// 素材名清单:materials/**/*.tex 相对路径去扩展名(引擎按 shader/材质引用同名取用)。
// 官方树约 586 个文件,每次挂载都重扫不值得 —— 60s 缓存(与上游 dev server 同约定)。
const weAssetsNamesCache = new Map();
function listWeAssetNames(dir) {
  const hit = weAssetsNamesCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.names;
  const names = [];
  (function walk(d, prefix) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.tex')) names.push(rel.slice(0, -4));
    }
  })(path.join(dir, 'materials'), '');
  names.sort();
  if (weAssetsNamesCache.size > 8) weAssetsNamesCache.clear();   // 目录改过就整体换血
  weAssetsNamesCache.set(dir, { names, at: Date.now() });
  return names;
}

function scanWallpapers() {
  const roots = [];
  for (const lib of steamLibraries()) {
    roots.push(lib + '/steamapps/workshop/content/431960');
  }
  for (const extra of state.workshopDirs || []) roots.push(extra);
  // 自定义壁纸(工作台上传):~/.we-wallpaper/custom/<id>/project.json + 媒体文件
  // 注意:custom 目录本身就是"工坊根"(其子目录 = 壁纸 id),与 Steam 根同构;
  // 之前把壁纸目录当根 push,主循环会把里面的文件再当 id 拼一层 → 永远扫不到。
  const customRoot = path.join(APP_DIR, 'custom');
  if (fs.existsSync(customRoot)) roots.push(customRoot);
  const list = [];
  for (const root of roots) {
    let ids = [];
    try { ids = fs.readdirSync(root); } catch { continue; }
    for (const id of ids) {
      const dir = path.join(root, id);
      let proj;
      // 有些编辑器/旧工坊包写出的 project.json 带 UTF-8 BOM,JSON.parse 会直接抛错,
      // 之前会把整张壁纸当无效条目静默跳过 —— 先剥掉 BOM 再解析。
      try {
        const raw = fs.readFileSync(path.join(dir, 'project.json'), 'utf8').replace(/^\uFEFF/, '');
        proj = JSON.parse(raw);
      } catch { continue; }
      const fileAbs = proj.file ? path.join(dir, proj.file) : null;
      const fileOk = fileAbs && fs.existsSync(fileAbs);
      const type = String(proj.type || '').toLowerCase();
      // 内容分级(WE 官方分级:Everyone / PG / PG13 / R 等),供工作台过滤
      const rating = String(proj.contentrating || '').toLowerCase();
      let previewAbs = proj.preview ? path.join(dir, proj.preview) : null;
      if (!previewAbs || !fs.existsSync(previewAbs)) {
        previewAbs = ['preview.jpg', 'preview.gif', 'preview.png']
          .map((f) => path.join(dir, f)).find((p) => fs.existsSync(p)) || null;
      }
      // sizeBytes 扫描时一次性取好:旧实现每次 /api/wallpapers 都对每张壁纸
      // statSync(播放器+工作台+面板合计每 5s 一轮 × 30+ 张),纯浪费。
      const sizeBytes = (() => { try { return fileAbs ? fs.statSync(fileAbs).size : (mainAbs ? fs.statSync(mainAbs).size : 0); } catch { return 0; } })();
      if (type === 'scene') {
        // 工坊条目常声明 scene.json 却只带打包的 scene.pkg(参考
        // dsh-wallpaper-engine 的 resolveSceneMainFileP):依次探测声明文件、
        // scene.pkg、scene.json,再退到目录里唯一的 *.pkg。
        const declared = proj.file;
        let mainAbs = [declared, 'scene.pkg', 'scene.json']
          .map((f) => (f ? path.join(dir, f) : null))
          .find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
        if (!mainAbs) {
          try {
            const pkgs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pkg'));
            if (pkgs.length === 1) mainAbs = path.join(dir, pkgs[0]);
          } catch {}
        }
        if (mainAbs) list.push({ id, title: proj.title || id, contentrating: rating, type: 'scene', dir, fileAbs: mainAbs, previewAbs, playable: true, sizeBytes });
        else list.push({ id, title: proj.title || id, contentrating: rating, type, dir, fileAbs: null, previewAbs, playable: false, sizeBytes: 0 });
      } else if (type === 'video' && fileOk) {
        list.push({ id, title: proj.title || id, contentrating: rating, type: 'video', dir, fileAbs, previewAbs, playable: true, sizeBytes });
      } else if (type === 'image' && fileOk) {
        list.push({ id, title: proj.title || id, contentrating: rating, type: 'image', dir, fileAbs, previewAbs: fileAbs, playable: true, sizeBytes });
      } else if (type === 'web' && fileOk) {
        list.push({ id, title: proj.title || id, contentrating: rating, type: 'web', dir, fileAbs, previewAbs, playable: true, sizeBytes });
      } else {
        list.push({ id, title: proj.title || id, contentrating: rating, type, dir, fileAbs: null, previewAbs, playable: false });
      }
    }
  }
  return list;
}
let inventory = scanWallpapers();
let lastInventoryScan = Date.now();
const INVENTORY_TTL_MS = 5000;                      // 自动扫描的最小间隔,避免多客户端轮询时反复读盘
const sceneVideoCache = new Map();

/** 重新扫描 Steam 工坊目录。force=true(手动"重新扫描壁纸库")立即扫描;
 *  自动请求在 TTL 内复用结果,让新下载的壁纸自动出现而不过度读盘。 */
function refreshInventory(force = false) {
  if (!force && Date.now() - lastInventoryScan < INVENTORY_TTL_MS) return inventory;
  inventory = scanWallpapers();
  lastInventoryScan = Date.now();
  return inventory;
}

/** 让状态跟随壁纸库:已删除/退订的壁纸从当前选择和轮播列表里移除。 */
function pruneStateToList() {
  const ids = new Set(inventory.map((w) => w.id));
  let changed = false;
  if (state.currentId && !ids.has(state.currentId)) { state.currentId = null; changed = true; }
  for (const pl of state.playlists) {
    const next = pl.ids.filter((id) => ids.has(id));
    if (next.length !== pl.ids.length) { pl.ids = next; changed = true; }
  }
  if (state.rotate.playlist && !state.playlists.some((pl) => pl.name === state.rotate.playlist)) {
    state.rotate.playlist = null; changed = true;
  }
  if (changed) saveState();
  return changed;
}

/** 清理已删除壁纸留下的磁盘/内存缓存(Scene 内嵌视频、进度记录),
 *  避免反复订阅+退订后缓存无限增长。 */
function pruneCaches(validIds) {
  let freed = 0;
  for (const [id, abs] of [...sceneVideoCache]) {
    if (validIds.has(id)) continue;
    sceneVideoCache.delete(id);
    if (abs) { try { fs.rmSync(abs, { force: true }); freed++; } catch {} }
  }
  const dir = path.join(APP_DIR, 'cache', 'scene-video');
  try {
    for (const f of fs.readdirSync(dir)) {
      const id = f.replace(/\.mp4$/i, '');
      if (validIds.has(id)) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); freed++; } catch {}
    }
  } catch {}
  for (const token of [...sceneProgress.keys()]) {
    let abs = '';
    try { abs = Buffer.from(token, 'base64url').toString('utf8'); } catch {}
    if (abs && !fs.existsSync(abs) && !fs.existsSync(path.dirname(abs))) sceneProgress.delete(token);
  }
  return freed;
}

/** 扫描 + 让状态/缓存跟随壁纸库,返回本次变化统计。 */
function syncInventory(force) {
  const before = new Set(inventory.map((w) => w.id));
  refreshInventory(force);
  const after = new Set(inventory.map((w) => w.id));
  const prunedState = pruneStateToList();
  const prunedCache = pruneCaches(after);
  return {
    added: [...after].filter((id) => !before.has(id)).length,
    removed: [...before].filter((id) => !after.has(id)).length,
    prunedState,
    prunedCache,
  };
}
function findEmbeddedMp4(abs) {
  const st = fs.statSync(abs);
  const fd = fs.openSync(abs, 'r');
  const chunkSize = 4 * 1024 * 1024;
  const buf = Buffer.alloc(chunkSize + 16);
  let carry = Buffer.alloc(0);
  let found = -1;
  try {
    for (let pos = 0; pos < st.size; pos += chunkSize) {
      const n = fs.readSync(fd, buf, 0, Math.min(chunkSize, st.size - pos), pos);
      const data = Buffer.concat([carry, buf.subarray(0, n)]);
      const i = data.indexOf(Buffer.from('ftyp'));
      if (i >= 4) { found = pos - carry.length + i - 4; break; }
      carry = data.subarray(Math.max(0, data.length - 16));
    }
  } finally { fs.closeSync(fd); }
  return found >= 0 ? found : null;
}
function sceneFallbackFile(w) {
  if (!w || w.type !== 'scene' || !w.fileAbs) return null;
  if (sceneVideoCache.has(w.id)) return sceneVideoCache.get(w.id);
  const outDir = path.join(APP_DIR, 'cache', 'scene-video');
  const out = path.join(outDir, String(w.id) + '.mp4');
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 1024) { sceneVideoCache.set(w.id, out); return out; }
    const start = findEmbeddedMp4(w.fileAbs);
    if (start == null) { sceneVideoCache.set(w.id, null); return null; }
    fs.mkdirSync(outDir, { recursive: true });
    const src = fs.openSync(w.fileAbs, 'r'); const dst = fs.openSync(out, 'w');
    try { const buf = Buffer.alloc(1024 * 1024); for (let pos = start; pos < fs.statSync(w.fileAbs).size;) { const n = fs.readSync(src, buf, 0, Math.min(buf.length, fs.statSync(w.fileAbs).size - pos), pos); if (!n) break; fs.writeSync(dst, buf, 0, n); pos += n; } } finally { fs.closeSync(src); fs.closeSync(dst); }
    sceneVideoCache.set(w.id, out); return out;
  } catch (err) { diagRecord('scene-fallback-error', { id: w.id, error: String(err && err.message || err).slice(0, 240) }); sceneVideoCache.set(w.id, null); return null; }
}

// 追加到 server.mjs:faststart(moov 前置)无损重排 —— 源自 dsh-wallpaper-engine
// 未发布版的「切换延迟根因」修复:moov 在文件尾部的 mp4,浏览器为读元数据要顺流
// 整读整个文件(实测 764MB/1.7s),切换延迟 ∝ 文件大小。一次性 `ffmpeg -c copy
// -movflags +faststart`(不重编码,实测 729MB/0.92s),按「源路径+大小+mtime」缓存。

let ffmpegPath = undefined;
let ffmpegChecked = false;
function detectFfmpeg() {
  if (ffmpegChecked) return ffmpegPath;
  ffmpegChecked = true;
  const cands = [];
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH);
  cands.push('ffmpeg'); // PATH
  try {
    // winget 装的 Gyan.FFmpeg
    const wl = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(wl) || []) {
      if (!d.toLowerCase().startsWith('gyan.ffmpeg')) continue;
      const base = path.join(wl, d);
      for (const v of fs.readdirSync(base)) {
        cands.push(path.join(base, v, 'bin', 'ffmpeg.exe'));
        cands.push(path.join(base, v, 'ffmpeg.exe'));
      }
    }
  } catch {}
  cands.push(path.join(HOME, '.dsh-wallpaper-engine', 'ffmpeg', 'ffmpeg.exe'));
  for (const c of cands) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 5000 });
      ffmpegPath = c;
      return ffmpegPath;
    } catch {}
  }
  return null;
}

let ffprobePath = null;
function detectFfprobe() {
  if (ffprobePath !== null && ffprobePath !== undefined) return ffprobePath;
  const ff = detectFfmpeg();
  if (!ff) { ffprobePath = null; return null; }
  const cand = ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  try { execFileSync(cand, ['-version'], { stdio: 'ignore', timeout: 5000 }); ffprobePath = cand; return cand; } catch { ffprobePath = null; return null; }
}
// 源视频帧率(缓存):ffprobe avg_frame_rate 解析,读不到返回 null
const fpsProbeCache = new Map();
function probeSourceFps(abs) {
  if (fpsProbeCache.has(abs)) return fpsProbeCache.get(abs);
  const fp = detectFfprobe();
  if (!fp) { fpsProbeCache.set(abs, null); return null; }
  try {
    const out = execFileSync(fp, ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'json', abs], { timeout: 15000, maxBuffer: 1e6 }).toString();
    const m = JSON.parse(out).streams && JSON.parse(out).streams[0];
    const rate = m && m.avg_frame_rate;
    let fps = null;
    if (rate && /^\d+\/\d+$/.test(rate)) { const [a, b] = rate.split('/').map(Number); if (b) fps = a / b; }
    fpsProbeCache.set(abs, fps);
    return fps;
  } catch { fpsProbeCache.set(abs, null); return null; }
}
// moov 是否已在文件头部(前 2MB 内):在 → 播放器元数据立即可得;不在 → 需要重排。
// 结果按「路径+大小+mtime」缓存:转码/重排在途时浏览器会连发多个 Range 请求,
// 每个都重复同步读 2MB 头部纯属浪费(缓存上限 128 条,超出整体换血)。
const moovHeadCache = new Map();
const MOOV_MAGIC = Buffer.from('moov');
function moovAtHead(abs) {
  try {
    const st = fs.statSync(abs);
    const key = abs + '|' + st.size + '|' + Math.floor(st.mtimeMs);
    const hit = moovHeadCache.get(key);
    if (hit !== undefined) return hit;
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, st.size));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const r = buf.indexOf(MOOV_MAGIC) >= 0;
    if (moovHeadCache.size > 128) moovHeadCache.clear();
    moovHeadCache.set(key, r);
    return r;
  } catch { return true; }
}

// 变体生成(带去重:同一源并发请求共享同一个 promise)
const faststartJobs = new Map();
// 输出文件名带源指纹(abs|size|mtime 哈希):源被更新后旧变体自动失效,
// 不会把陈旧字节当新源发出去(旧版按 id 命名,源更新后仍在服务旧缓存)。
function fp8(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; } return h.toString(36); }
function safeId(id) { return String(id || 'x').replace(/[^\w-]/g, '_').slice(0, 48); }
const MEDIA_CACHE_BUDGET_BYTES = 6 * 1024 ** 3;   // faststart+transcode 缓存合计 6GB(源自 dsh-wallpaper-engine 字节预算口径)
const MEDIA_CACHE_FRESH_MS = 10 * 60_000;         // 刚写不久的变体可能正在播放,回收时跳过
function mediaCacheDir(kind) { return path.join(APP_DIR, 'cache', kind); }
// 缓存预算回收:两目录合计超预算时按 mtime 从旧到新删,直到回到预算内。
// 绝不删 10 分钟内新写的文件 —— 那可能就是正在播放的这一份。
function sweepMediaCache() {
  for (const kind of ['faststart', 'transcode']) {
    const dir = mediaCacheDir(kind);
    let files;
    try {
      files = fs.readdirSync(dir).map((f) => {
        try { const st = fs.statSync(path.join(dir, f)); return st.isFile() ? { f, size: st.size, mtime: st.mtimeMs, path: path.join(dir, f) } : null; } catch { return null; }
      }).filter(Boolean);
    } catch { continue; }
    let total = files.reduce((a, x) => a + x.size, 0);
    files.sort((a, b) => a.mtime - b.mtime);
    for (const x of files) {
      if (total <= MEDIA_CACHE_BUDGET_BYTES) break;
      if (Date.now() - x.mtime < MEDIA_CACHE_FRESH_MS) continue;
      try { fs.unlinkSync(x.path); total -= x.size; diagRecord('cache-evict', { kind, file: x.f.slice(0, 60), bytes: x.size }); } catch {}
    }
  }
}
// 一次性清扫:改名升级(指纹命名)前留下的旧变体与崩溃残留,7 天以上一律回收。
function sweepStaleCacheOnBoot() {
  const WEEK = 7 * 24 * 3600_000;
  for (const kind of ['faststart', 'transcode']) {
    let names;
    try { names = fs.readdirSync(mediaCacheDir(kind)); } catch { continue; }
    for (const f of names) {
      try {
        const st = fs.statSync(path.join(mediaCacheDir(kind), f));
        if (st.isFile() && Date.now() - st.mtimeMs > WEEK) fs.unlinkSync(path.join(mediaCacheDir(kind), f));
      } catch {}
    }
  }
}
function faststartVariant(abs, id) {
  try {
    const st = fs.statSync(abs);
    if (!/\.(mp4|m4v|mov)$/i.test(abs)) return Promise.resolve(null);
    if (!detectFfmpeg()) return Promise.resolve(null);
    const key = abs + '|' + st.size + '|' + Math.floor(st.mtimeMs);
    const outDir = mediaCacheDir('faststart');
    const out = path.join(outDir, safeId(id) + '-' + fp8(key) + '.mp4');
    if (fs.existsSync(out) && fs.statSync(out).size > 1024) return Promise.resolve(out);
    if (moovAtHead(abs)) return Promise.resolve(null);   // 已是 faststart,无需重排
    if (faststartJobs.has(key)) return faststartJobs.get(key);
    const job = new Promise((resolve) => {
      fs.mkdirSync(outDir, { recursive: true });
      const tmp = out + '.tmp';
      execFile(ffmpegPath, ['-y', '-i', abs, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp],
        { timeout: 120000 }, (err) => {
          faststartJobs.delete(key);
          try {
            if (err || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
              diagRecord('faststart-error', { id, error: String(err && err.message || err).slice(0, 240) });
              return resolve(null);
            }
            fs.renameSync(tmp, out);
            diagRecord('faststart-ok', { id, bytes: fs.statSync(out).size });
            sweepMediaCache();   // 新增变体后回看预算
            resolve(out);
          } catch (e2) { diagRecord('faststart-error', { id, error: String(e2 && e2.message || e2).slice(0, 240) }); resolve(null); }
        });
    });
    faststartJobs.set(key, job);
    return job;
  } catch (err) {
    diagRecord('faststart-error', { id, error: String(err && err.message || err).slice(0, 240) });
    return Promise.resolve(null);
  }
}

// 启动预热(源自 dsh-wallpaper-engine 的 warmFaststartFavorites):轮换列表里的视频
// 先做一遍 moov 前置(无损 -c copy),下次轮换到它们时元数据立即可得,切换不再
// 等整个文件顺流读完。顺序=列表优先,串行执行不与播放抢磁盘,最多 12 张。
async function warmFaststartOnBoot() {
  await new Promise((r) => setTimeout(r, 2500));   // 先让服务器与播放链路就绪
  const orderedIds = [];
  const pl = state.playlists.find((x) => x.name === state.rotate.playlist);
  if (pl && Array.isArray(pl.ids)) orderedIds.push(...pl.ids);
  for (const w of inventory) if (!orderedIds.includes(w.id)) orderedIds.push(w.id);
  let warmed = 0;
  for (const id of orderedIds) {
    if (warmed >= 12) break;
    const w = inventory.find((x) => x.id === id);
    if (!w || w.type !== 'video' || !w.fileAbs || !/\.(mp4|m4v|mov)$/i.test(w.fileAbs)) continue;
    try {
      if (moovAtHead(w.fileAbs)) continue;   // 本就 faststart:零成本跳过
      warmed += 1;
      await faststartVariant(w.fileAbs, id);
      await new Promise((r) => setTimeout(r, 300));
    } catch {}
  }
  if (warmed) diagRecord('faststart-warm', { warmed });
}


// 视频帧率上限转码:源帧率高于上限(+1 容差)才转,与容器能否原生播无关
// (DSH v1.2.0 口径);编码优先 NVENC,失败回落 libx264;按「源+大小+mtime+上限」缓存;
// 运行期钉住:一次播放会话中绝不中途换文件 —— 转码在后台进行,下次建层生效。
const transcodeJobs = new Map();
const transcodePin = new Map();   // key -> true(本运行内已决定用原片)
function videoVariant(abs, id) {
  const st = fs.statSync(abs);
  if (!/\.(mp4|m4v|mov)$/i.test(abs)) return Promise.resolve(null);
  const cap = Number(state.videoFpsCap) || 0;
  if (!cap || !detectFfprobe()) return Promise.resolve(null);
  const key = abs + '|' + st.size + '|' + Math.floor(st.mtimeMs) + '|' + cap;
  if (transcodePin.has(key)) return Promise.resolve(transcodePin.get(key) ? transcodePin.get(key) : null);
  const outDir = path.join(APP_DIR, 'cache', 'transcode');
  const out = path.join(outDir, safeId(id) + '-' + cap + '-' + fp8(key) + '.mp4');   // 指纹命名:源更新自动失效
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) { transcodePin.set(key, out); return Promise.resolve(out); }
  return faststartVariant(abs, id).then(function (fs0) {
    const src = fs0 || abs;
    const fps = probeSourceFps(src);
    if (fps == null || fps <= cap + 1) { transcodePin.set(key, null); return null; }   // 源帧率未知或本就低于上限:不折腾
    if (transcodeJobs.has(key)) return transcodeJobs.get(key);
    const job = new Promise((resolve) => {
      fs.mkdirSync(outDir, { recursive: true });
      const tmp = out + '.part.mp4';
      const encoders = ['h264_nvenc', 'libx264'];
      const attempt = function (k) {
        if (k >= encoders.length) { transcodePin.set(key, null); diagRecord('transcode-error', { id, fps: Math.round(fps) }); return resolve(null); }
        const args = ['-y', '-i', src, '-vf', 'fps=' + cap, '-c:v', encoders[k],
          encoders[k] === 'libx264' ? '-preset' : null, encoders[k] === 'libx264' ? 'veryfast' : null,
          '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp].filter(Boolean);
        execFile(ffmpegPath || detectFfmpeg(), args, { timeout: 600000, maxBuffer: 1e6 }, (err) => {
          try {
            if (err || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
              if (!err || !String(err).includes('h264_nvenc')) diagRecord('transcode-attempt', { id, encoder: encoders[k], error: String(err && err.message || err).slice(0, 160) });
              return attempt(k + 1);   // NVENC 失败(无 N 卡等)回落 libx264
            }
            fs.renameSync(tmp, out);
            diagRecord('transcode-ok', { id, encoder: encoders[k], fps: Math.round(fps), cap, bytes: fs.statSync(out).size });
            transcodePin.set(key, out);
            sweepMediaCache();   // 新增变体后回看预算
            resolve(out);
          } catch (e2) { transcodePin.set(key, null); resolve(null); }
        });
      };
      attempt(0);
    });
    transcodeJobs.set(key, job);
    return job;
  });
}
// ── HTTP 基础设施 ─────────────────────────────────────────────────────────────
const diagEntries = [];
const sceneProgress = new Map();
function trackProgress(token) {                     // 上限保护,防长期运行泄漏
  if (sceneProgress.size > 64) { const k = sceneProgress.keys().next().value; sceneProgress.delete(k); }
  let p = sceneProgress.get(token);
  if (!p) { p = { ok: true, token, served: 0, active: 0, startedAt: Date.now() }; sceneProgress.set(token, p); }
  return p;
}
function diagRecord(kind, payload) {
  const entry = { t: Date.now(), kind, ...payload }; diagEntries.push(entry);
  if (diagEntries.length > 200) diagEntries.shift();
  try { fs.mkdirSync(APP_DIR, { recursive: true }); fs.appendFileSync(path.join(APP_DIR, 'diag.log'), JSON.stringify(entry) + '\n'); } catch {}
}
function sceneProgressSnapshot(token) { return sceneProgress.get(token) || { ok: false, token, served: 0, active: 0 }; }

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.pkg': 'application/octet-stream', '.tex': 'application/octet-stream',
  '.frag': 'text/plain; charset=utf-8', '.vert': 'text/plain; charset=utf-8', '.glsl': 'text/plain; charset=utf-8',
};

/** 静态发送器:Range / ETag+Last-Modified(304)/ 缓存头。 */
function serveFile(abs, req, res, { cache = 'no-store' } = {}) {
  let st;
  try { st = fs.statSync(abs); } catch { res.statusCode = 404; res.end('not found'); return; }
  if (st.isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
  const headers = { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache };
  if (cache !== 'no-store') {
    headers['ETag'] = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
    headers['Last-Modified'] = st.mtime.toUTCString();
  }
  const etag = headers['ETag'];
  if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [a, b] = range.slice(6).split('-').map((x) => (x ? Number(x) : NaN));
    let start = Number.isFinite(a) ? a : 0;
    let end = Number.isFinite(b) ? Math.min(b, st.size - 1) : st.size - 1;
    if (start >= st.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = end - start + 1;
    headers['Accept-Ranges'] = 'bytes';
    res.writeHead(206, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const rs206 = fs.createReadStream(abs, { start, end });
    rs206.on('error', () => { try { res.destroy(); } catch (e2) {} });
    res.on('error', () => { try { rs206.destroy(); } catch (e2) {} });
    res.on('close', () => { if (!res.writableEnded) rs206.destroy(); });   // 客户端中断:停止读盘
    rs206.pipe(res);
    return;
  }
  headers['Content-Length'] = st.size;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const rs200 = fs.createReadStream(abs);
  rs200.on('error', () => { try { res.destroy(); } catch (e2) {} });
  res.on('error', () => { try { rs200.destroy(); } catch (e2) {} });
  res.on('close', () => { if (!res.writableEnded) rs200.destroy(); });   // 客户端中断:停止读盘
  rs200.pipe(res);
}

/** 目录围栏:abs 必须落在 fence 内。 */
function fenced(fence, ...parts) {
  const abs = path.resolve(fence, ...parts.filter((p) => p != null && p !== ''));
  const norm = path.resolve(fence) + path.sep;
  if (abs !== path.resolve(fence) && !abs.startsWith(norm)) return null;
  return abs;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); if (chunks.length > 1e4) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── 轮换(优先用选中的轮播列表,否则全部可播壁纸)──────────────────────────────
let rotateTimer = 0;
function scheduleRotation() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = 0; }
  if (!state.rotate.enabled) return;
  const ms = Math.max(1, Number(state.rotate.intervalMin) || 30) * 60_000;
  rotateTimer = setInterval(() => {
    const pl = state.playlists.find((p) => p.name === state.rotate.playlist);
    const hidden = state.contentFilter ? new Set(['r', 'mature']) : null;
    const pool = inventory.filter((w) => w.playable && !(hidden && hidden.has((w.contentrating || '').toLowerCase())) && (pl ? pl.ids.includes(w.id) : true));
    if (pool.length < 1) return;
    const idx = pool.findIndex((w) => w.id === state.currentId);
    state.currentId = pool[(idx + 1) % pool.length].id;
    state.paused = false;
    saveState();
  }, ms);
  rotateTimer.unref();
}

// ── 服务器 ───────────────────────────────────────────────────────────────────
const REQLOG = [];
// ── 注入再同步(每小时):ZCode 更新替换 asar 后,自动恢复注入并清理过期影子目录 ──
const ZCODE_DIR = process.env.ZCODE_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode');
const ZCODE_SHADOW = path.join(ZCODE_DIR, 'resources', 'app');
function zcodeRunning() {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe'], { encoding: 'utf8', timeout: 10000 });
    return /ZCode\.exe/i.test(out.stdout || '');
  } catch { return true; }
}
function asarSlotPatched() {
  try {
    const fd = fs.openSync(path.join(ZCODE_DIR, 'resources', 'app.asar'), 'r');
    const probe = Buffer.alloc(64);
    fs.readSync(fd, probe, 0, 64, 0);
    const js = probe.readUInt32LE(12);
    const jb = Buffer.alloc(js);
    fs.readSync(fd, jb, 0, js, 16);
    const h = JSON.parse(jb.toString('utf8'));
    const ds = 8 + probe.readUInt32LE(4);
    let n = { files: h.files };
    for (const q of ['out', 'renderer', 'index.html']) n = n.files[q];
    const b = Buffer.alloc(Math.min(n.size, 8192));
    fs.readSync(fd, b, 0, b.length, ds + Number(n.offset));
    fs.closeSync(fd);
    return b.toString('utf8').includes('bootstrap.js');
  } catch { return true; }   // 读不了按已处理,避免误判
}
let lastResyncAt = 0;
setInterval(function () {
  if (Date.now() - lastResyncAt < 55 * 60 * 1000) return;
  lastResyncAt = Date.now();
  if (zcodeRunning()) return;                       // ZCode 运行中不动它的文件
  const needShadow = fs.existsSync(ZCODE_SHADOW);
  if (needShadow || !asarSlotPatched()) {
    try { spawnSync(process.execPath, [path.join(__dirname, 'tools', 'resync-injection.js')], { stdio: 'ignore', timeout: 120000 }); } catch {}
  }
}, 10 * 60 * 1000).unref();
const reqlog = (line) => { REQLOG.push(new Date().toISOString().slice(11, 23) + ' ' + line); if (REQLOG.length > 200) REQLOG.shift(); };
// ── 系统字体清单(源自 dsh-wallpaper-engine system-fonts.js 的「宿主枚举、客户端只信回包」)──
// PowerShell 的 System.Drawing InstalledFontCollection 枚举本机族名;10 分钟缓存;失败回旧值或空。
let fontCache = { names: null, at: 0 };
let fontsBusy = false;
function systemFonts() {
  return new Promise((resolve) => {
    if (fontCache.names && Date.now() - fontCache.at < 600_000) return resolve(fontCache.names);
    if (fontsBusy) return resolve(fontCache.names || []);
    if (process.platform !== 'win32') return resolve([]);
    fontsBusy = true;
    execFile('powershell.exe', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Drawing; [System.Drawing.Text.InstalledFontCollection]::new().Families.Name | ConvertTo-Json -Compress'],
      { timeout: 20000, maxBuffer: 4e6, windowsHide: true }, (err, stdout) => {
        fontsBusy = false;
        let names = [];
        if (!err && stdout && stdout.trim()) {
          try {
            const j = JSON.parse(stdout.trim());
            names = (Array.isArray(j) ? j : [j]).filter((x) => typeof x === 'string' && x.trim());
          } catch {}
        }
        if (names.length) fontCache = { names, at: Date.now() };
        resolve(names.length ? names : (fontCache.names || []));
      });
  });
}

// ── 注入轨道状态(fuse + asar 标记;5 分钟缓存,诊断一眼看清双轨健康度)──
// (ZCODE_DIR 已在前文声明,此处直接复用)
const INJECT_STATUS_TTL = 5 * 60_000;
let injectStatusCache = { at: 0, data: null };
function readFuseIntegrity() {
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
    if (found < 0) { fs.closeSync(efd); return false; }   // 老 Electron 无 fuse
    const tail = Buffer.alloc(48);
    fs.readSync(efd, tail, 0, 48, found + SENT.length);
    fs.closeSync(efd);
    const b = tail[2 + 4];   // fuse[4] = EnableEmbeddedAsarIntegrityValidation
    return b === 1 || b === 0x31;
  } catch { return null; }
}
function asarMarked() {
  try {
    const asar = path.join(ZCODE_DIR, 'resources', 'app.asar');
    const fd = fs.openSync(asar, 'r');
    try {
      const probe = Buffer.alloc(64);
      fs.readSync(fd, probe, 0, 64, 0);
      const jsonSize = probe.readUInt32LE(12);
      const jb = Buffer.alloc(jsonSize);
      fs.readSync(fd, jb, 0, jsonSize, 16);
      const header = JSON.parse(jb.toString('utf8'));
      let node = { files: header.files };
      for (const part of ['out', 'renderer', 'index.html']) node = node.files[part];
      const off = 8 + probe.readUInt32LE(4) + Number(node.offset);
      const buf = Buffer.alloc(Math.min(node.size, 8192));
      fs.readSync(fd, buf, 0, buf.length, off);
      return buf.toString('utf8').includes('bootstrap.js');
    } finally { fs.closeSync(fd); }
  } catch { return null; }   // 读不到(更新中/权限)→ 未知
}
function injectStatus() {
  if (Date.now() - injectStatusCache.at < INJECT_STATUS_TTL) return injectStatusCache.data;
  injectStatusCache = { at: Date.now(), data: { fuseIntegrity: readFuseIntegrity(), asarMarked: asarMarked(), cdp: cdpInjector ? cdpInjector.status() : null } };
  return injectStatusCache.data;
}
setTimeout(() => injectStatus(), 4000).unref?.();   // 开机先暖一次缓存

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const p = decodeURIComponent(u.pathname);
  const method = (req.method || 'GET').toUpperCase();

  if (p.startsWith('/media/') || p.startsWith('/scene-files/') || p.startsWith('/scene-video/') || p === '/api/select') reqlog(method + ' ' + p.slice(0, 90) + ' [' + (req.headers['user-agent'] || '').slice(0, 40) + ']');
  try {
    // CORS:聊天窗口是 file:// 源,面板的 fetch 需要跨域许可(服务器只绑 127.0.0.1)
    if (p.startsWith('/api/')) {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // ---- API ----
    if (p === '/api/wallpapers') {
      // Steam 可以在服务器运行期间新增或移除工坊目录:轮询时按 TTL 重新扫描,
      // 并清理已删除/退订壁纸留下的失效当前选择和轮播 ID。
      syncInventory(false);
      return sendJSON(res, 200, {
        wallpapers: inventory.map((w) => {
          const sceneBase = w.type === 'scene' && w.fileAbs
            ? Buffer.from(w.fileAbs, 'utf8').toString('base64url') : null;
          const rel = w.fileAbs ? path.relative(w.dir, w.fileAbs).split(path.sep).map(encodeURIComponent).join('/') : null;
          return {
            id: w.id, title: w.title, type: w.type, playable: w.playable,
            contentrating: w.contentrating || null,
            preview: w.previewAbs ? `/preview/${w.id}` : null,
            hasPkg: w.type === 'scene',
            sceneBase,                                   // scene:渲染页 src 段(其下拼 scene.pkg)
            webEntry: w.type === 'web' && rel ? `/web-live/${w.id}/${rel}` : null,  // web:shim 注入入口
            mediaUrl: (w.type === 'video' || w.type === 'image') && rel ? `/media/${w.id}/${rel}` : null,
            // 扫描时缓存的大小(旧实现每次请求逐张 statSync);目录被外部改动时兜底现算
            sizeBytes: w.sizeBytes != null ? w.sizeBytes : (() => { try { return fs.statSync(w.fileAbs).size; } catch { return 0; } })(),
          };
        }),
        state,
      });
    }
    if (p === '/api/state') return sendJSON(res, 200, { ...state, luminance, weAssetsAvailable: weAssetsAvailable(), weAssetsDir: weAssetsDir() });
    // 极轻量的版本探针:客户端高频轮询它,变了才去取整份 /embed.css(降低换色的等待)
    // 代码指纹版本(播放层据此自刷新):任一前端文件 mtime/size 变化即变,结果缓存。
    // ⚠ 与 /api/style-version 严格分工:这里绝不能返回 stateVersion —— 旧实现把它
    // 当代码版本返回,导致工作台每拖一下滑杆(saveState→stateVersion++)嵌入的
    // 壁纸就整页 location.reload(),既是性能灾难也让动画/播放在调节期间不断重启。
    if (p === '/api/version') {
      let h = 0;
      for (const rel of ['public/player.js', 'public/embed.js', 'public/embed.css', 'public/workbench.js']) {
        try { const st2 = fs.statSync(path.join(__dirname, rel)); h = (h * 31 + st2.size + (st2.mtimeMs % 100000)) >>> 0; } catch (e3) {}
      }
      return sendJSON(res, 200, { v: String(h) });
    }
    // 样式版本(embed.css 热更新探针):任何状态写入推进;客户端变了才重取 CSS
    if (p === '/api/style-version') return sendJSON(res, 200, { v: stateVersion });
    if (p === '/api/diag-log') return sendJSON(res, 200, { entries: diagEntries.slice(-80), reqlog: REQLOG.slice(-60), cdp: cdpInjector.status(), inject: injectStatus() });
    if (p === '/api/scene-progress') {
      const token = String(u.searchParams.get('token') || '');
      return sendJSON(res, 200, sceneProgressSnapshot(token));
    }
    if (p === '/api/select' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const w = inventory.find((x) => x.id === String(body.id));
      if (!w) return sendJSON(res, 404, { error: 'no such wallpaper', id: body.id });
      if (!w.playable) return sendJSON(res, 400, { error: 'wallpaper not playable', type: w.type });
      state.currentId = w.id;
      state.paused = false;
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/pause' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.paused = !!body.paused;
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/volume' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.volume = Math.max(0, Math.min(1, Number(body.volume) || 0));
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/rotate' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.rotate.enabled = !!body.enabled;
      if (body.intervalMin != null) state.rotate.intervalMin = Math.max(1, Number(body.intervalMin) || 30);
      saveState();
      scheduleRotation();
      return sendJSON(res, 200, state);
    }
    if (p.startsWith('/api/props/') && method === 'GET') {
      // 壁纸属性面板:解析 project.json 的 general.properties(含类型/文案/值)
      const id = p.slice('/api/props/'.length);
      const w = inventory.find((x) => x.id === id);
      if (!w) return sendJSON(res, 404, { error: 'no such wallpaper' });
      let proj;
      try { proj = JSON.parse(fs.readFileSync(w.fileAbs ? path.join(w.dir, "project.json") : path.join(w.dir, "project.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return sendJSON(res, 200, { props: [] }); }
      const gp = (proj.general && proj.general.properties) || {};
      const list = Object.entries(gp)
        .filter(([n, d]) => d && d.type !== 'tool')
        .map(([name, d]) => ({ name, text: d.text || name, type: d.type || "text", value: d.value,
          min: d.min, max: d.max, step: d.step, precision: d.precision, order: d.order == null ? 999 : d.order }))
        .sort((a, b) => a.order - b.order);
      return sendJSON(res, 200, { props: list, title: w.title });
    }
    if (p.startsWith('/api/props/') && method === 'POST') {
      // 写回 project.json:values = { 属性名: 新值 }(color 传 #rrggbb,服务器转 WE 的 "r g b" 浮点串)
      const id = p.slice('/api/props/'.length);
      const w = inventory.find((x) => x.id === id);
      if (!w) return sendJSON(res, 404, { error: 'no such wallpaper' });
      const body = JSON.parse((await readBody(req)) || "{}");
      const values = body.values || {};
      const pjPath = path.join(w.dir, "project.json");
      let proj;
      try { proj = JSON.parse(fs.readFileSync(pjPath, "utf8").replace(/^\uFEFF/, "")); } catch { return sendJSON(res, 500, { error: "project.json unreadable" }); }
      proj.general = proj.general || {};
      proj.general.properties = proj.general.properties || {};
      const applied = {};
      for (const [name, val] of Object.entries(values)) {
        const def = proj.general.properties[name];
        if (!def) continue;
        let v = val;
        if (def.type === 'color' && /^#[0-9a-f]{6}$/i.test(String(val))) {
          const n2 = parseInt(String(val).slice(1), 16);
          v = [((n2 >> 16) & 255) / 255, ((n2 >> 8) & 255) / 255, (n2 & 255) / 255].map((x) => x.toFixed(4)).join(" ");
        }
        if (def.type === 'bool') v = Boolean(val);
        if (def.type === 'slider') { v = Number(val); if (def.min != null) v = Math.max(def.min, v); if (def.max != null) v = Math.min(def.max, v); if (def.precision != null) v = Number(v.toFixed(def.precision)); }
        def.value = v;
        if (proj.properties && proj.properties[name]) proj.properties[name].value = v;
        applied[name] = v;
      }
      fs.writeFileSync(pjPath, JSON.stringify(proj, null, 4));
      diagRecord('props-applied', { id, applied });
      return sendJSON(res, 200, { applied });
    }

    if (p === '/api/scan' && method === 'POST') {
      // 手动"重新扫描壁纸库":立即扫描,并让新增/删除同步到状态与列表,清理失效缓存。
      const r = syncInventory(true);
      return sendJSON(res, 200, {
        count: inventory.length,
        added: r.added,
        removed: r.removed,
        prunedState: r.prunedState,
        prunedCache: r.prunedCache,
        state,
      });
    }
    if (p === '/api/close' && method === 'POST') {
      state.currentId = null;                       // 关闭壁纸层,回深色底
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/transition' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // ms/kind/dir 任一缺省都保留现有值:单字段的调用不该重置其它两项
      const ms = Math.max(0, Math.min(8000, Number(body.ms != null ? body.ms : (state.transition.ms || 0)) || 0));
      const KINDS = ['none', 'crossfade', 'push', 'wipe', 'iris', 'zoom', 'blinds'];
      const kind = KINDS.includes(body.kind) ? body.kind
        : (ms > 0 ? (KINDS.includes(state.transition.kind) && state.transition.kind !== 'none' ? state.transition.kind : 'crossfade') : 'none');
      const dir = ['left', 'right', 'up', 'down'].includes(body.dir) ? body.dir : (['left', 'right', 'up', 'down'].includes(state.transition.dir) ? state.transition.dir : 'left');
      state.transition = { kind, ms, dir };
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/appearance' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      for (const k of ['main', 'row', 'sidebar', 'stroke']) {
        if (body[k] != null) state.appearance[k] = Math.max(0, Math.min(100, Number(body[k])));
      }
      if (body.brightness != null) state.appearance.brightness = Math.max(40, Math.min(160, Number(body.brightness)));
      if (body.zoom != null) state.appearance.zoom = Math.max(80, Math.min(140, Number(body.zoom)));
      if (body.fontFamily != null) state.appearance.fontFamily = /^[\w\u4e00-\u9fa5,\s'"-]{0,120}$/.test(String(body.fontFamily)) ? String(body.fontFamily).trim() : '';
      if (body.cursor != null && ['', 'default', 'pointer', 'crosshair', 'text'].includes(String(body.cursor))) state.appearance.cursor = String(body.cursor);
      if (body.blur != null) state.appearance.blur = Math.max(0, Math.min(40, Number(body.blur)));
      if (body.glass != null) state.appearance.glass = Math.max(0, Math.min(100, Number(body.glass)));
      if (body.glassColor != null && /^#[0-9a-f]{6}$/i.test(String(body.glassColor))) {
        state.appearance.glassColor = String(body.glassColor).toLowerCase();
      }
      if (body.filter != null && WALLPAPER_FILTERS.includes(String(body.filter))) state.appearance.filter = String(body.filter);
      // 填充方式(视频/图片 object-fit 与场景 fit 参数,源自 DSH objectFit)
      if (body.fit != null && ['cover', 'contain', 'stretch'].includes(String(body.fit))) state.appearance.fit = String(body.fit);
      // 文字颜色:'' = 回到智能可读性自动;非法色值回自动(不残留异常色)。
      // 分区:fontColor=主区+全局基线,fontColorSidebar=侧栏(空=跟随主区),fontColorComposer=聊天框(空=玻璃对比自动)
      for (const key of ['fontColor', 'fontColorSidebar', 'fontColorComposer']) {
        if (body[key] != null) {
          const fc = String(body[key]).trim();
          state.appearance[key] = /^#[0-9a-f]{6}$/i.test(fc) ? fc.toLowerCase() : '';
        }
      }
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/readability' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.auto != null) state.readability.auto = !!body.auto;
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/luminance' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const v = Number(body.v);
      // 亮度翻转(明↔暗)才推进样式版本:文字色/玻璃配色的方向变了,让 embed 端
      // ~0.4s 内重取 CSS;同侧的细微变化不推 —— 每 5s 一次的采样不该打扰客户端。
      const sideOf = (x) => (state.readability.auto && x > 0.55);
      const prevSide = luminance == null ? null : sideOf(luminance);
      luminance = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
      if (prevSide !== sideOf(luminance)) stateVersion += 1;
      return sendJSON(res, 200, { v: luminance });
    }
    // ---- 系统字体清单(工作台字体下拉的数据源;宿主枚举,失败回空由界面提示)----
    if (p === '/api/fonts' && method === 'GET') {
      const fonts = await systemFonts();
      return sendJSON(res, 200, { fonts });
    }

    // ---- WE 官方素材通路(消费面,契约对齐上游 renderer/src/local-assets.ts)----
    // 四种请求形:GET /api/local-assets → {ok,roots};
    //   /local/materials/index.json → {names};/local/<rel> → 贴图字节(围栏内,只读)。
    // 未配置素材返回 {ok:false}(200)是正常态:引擎静默回落程序化复刻。
    if (p === '/api/local-assets' || p.startsWith('/api/local-assets/')) {
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; return res.end('method not allowed'); }
      const ok = weAssetsAvailable();
      if (p === '/api/local-assets') return sendJSON(res, 200, { ok, roots: ok ? [{ id: 'local', dir: weAssetsDir() }] : [] });
      if (!ok) return sendJSON(res, 404, { ok: false, error: '素材目录未配置或不可用' });
      const root = weAssetsDir();
      let rel = '';
      try { rel = decodeURIComponent(p.slice('/api/local-assets/local/'.length)); } catch { res.statusCode = 400; return res.end('bad path'); }
      if (rel === 'materials/index.json') return sendJSON(res, 200, { names: listWeAssetNames(root) });
      if (!rel) { res.statusCode = 400; return res.end('bad path'); }
      const target = fenced(root, rel);
      if (!target) { res.statusCode = 403; return res.end('forbidden-we-assets'); }
      let isFile = false;
      try { isFile = fs.statSync(target).isFile(); } catch {}
      if (!isFile) { res.statusCode = 404; return res.end('no such asset'); }
      return serveFile(target, req, res, { cache: 'public, max-age=86400' });   // 本机只读素材,可长缓存
    }

    // ---- 开机自启 ZCode(可选,CDP 轨道的推荐启动方式)----
    // 只写/删一个标记文件,实际启动由 Startup 看门狗 VBS 在登录时执行:
    // 标记存在 → 服务器就绪后带 --remote-debugging-port=9333 启动 ZCode。
    if (p === '/api/autostart-zcode' && method === 'GET') {
      return sendJSON(res, 200, { enabled: fs.existsSync(AUTO_LAUNCH_FLAG) });
    }
    if (p === '/api/autostart-zcode' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        if (body.enabled) {
          fs.mkdirSync(APP_DIR, { recursive: true });
          fs.writeFileSync(AUTO_LAUNCH_FLAG, 'see we-wallpaper.vbs\n');
        } else if (fs.existsSync(AUTO_LAUNCH_FLAG)) {
          fs.unlinkSync(AUTO_LAUNCH_FLAG);
        }
      } catch (e) {}
      return sendJSON(res, 200, { enabled: fs.existsSync(AUTO_LAUNCH_FLAG) });
    }

    // ---- WE 素材目录配置(设置面):GET 状态 / POST {dir|null} 手动覆盖或回到自动 ----
    if (p === '/api/we-assets' && method === 'GET') {
      const d = weAssetsDir();
      const ok = weAssetsAvailable();
      return sendJSON(res, 200, { dir: d, available: ok, auto: !(state.weAssetsDir && state.weAssetsDir.trim()), textures: ok ? listWeAssetNames(d).length : 0 });
    }
    if (p === '/api/we-assets' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const d = body && typeof body.dir === 'string' ? body.dir.trim() : null;
      if (d) {
        let hasMaterials = false;
        try { hasMaterials = fs.statSync(path.join(d, 'materials')).isDirectory(); } catch {}
        if (!hasMaterials) return sendJSON(res, 400, { error: '该目录下没有 materials/ 子目录 —— 请指向 Wallpaper Engine 安装目录的 assets 树(或其拷贝)' });
        state.weAssetsDir = d;
      } else {
        state.weAssetsDir = null;   // 清除 → 回落自动探测
      }
      weAssetsProbe = { dir: null, at: 0 };
      weAssetsNamesCache.clear();
      saveState();
      return sendJSON(res, 200, { ...state, weAssetsAvailable: weAssetsAvailable(), weAssetsDir: weAssetsDir() });
    }
    // ---- 外观预设:出厂七套蒸馏自 dsh-wallpaper-engine 的 glass-presets;自定义存 state ----
    // 出厂字段的蒸馏口径:上游 glassAlpha 是不透明度百分比,我们 glass 滑杆映射
    // alpha=96-0.88*glass ⇒ glass=(96-alpha)/0.88;亮度直接映射;饱和度≈滤镜档。
    // 只动玻璃颜色/透明度/磨砂/亮度/滤镜五个视觉字段,不碰分区透明度/字体/光标。
    const FACTORY_PRESETS = [
      { id: 'author',   name: '作者自用', patch: { glassColor: '#0d1524', glass: 64, blur: 9,  brightness: 85,  filter: 'vivid' } },
      { id: 'hacker',   name: '黑客绿',   patch: { glassColor: '#266d3c', glass: 18, blur: 9,  brightness: 100, filter: 'vivid' } },
      { id: 'frosted',  name: '重磨砂',   patch: { glassColor: '#ffffff', glass: 58, blur: 36, brightness: 100, filter: 'none' } },
      { id: 'night',    name: '暗夜釉色', patch: { glassColor: '#0d1524', glass: 41, blur: 22, brightness: 100, filter: 'none' } },
      { id: 'readable', name: '可读优先', patch: { glassColor: '#ffffff', glass: 64, blur: 24, brightness: 100, filter: 'none' } },
      { id: 'orig',     name: '原色直出', patch: { glassColor: '#67DCE7', glass: 52, blur: 18, brightness: 100, filter: 'none' } },
      { id: 'purple',   name: '紫色心情', patch: { glassColor: '#533b78', glass: 18, blur: 9,  brightness: 100, filter: 'vivid' } },
    ];
    if (p === '/api/presets' && method === 'GET') {
      return sendJSON(res, 200, { factory: FACTORY_PRESETS, custom: state.appearancePresets || [], current: state.appearance });
    }
    if (p === '/api/presets/apply' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const f = FACTORY_PRESETS.find((x) => x.id === body.id);
      const c = (state.appearancePresets || []).find((x) => x.name === body.name);
      if (f) {
        Object.assign(state.appearance, f.patch);
      } else if (c) {
        // 自定义预设是外观快照:分区透明度/字体/光标/描边/缩放保留现场(存快照时也带着,
        // 这里再兜一层,避免老快照缺字段把用户调好的分区重置)
        const keep = ['main', 'row', 'sidebar', 'stroke', 'zoom', 'fontFamily', 'cursor'];
        const merged = { ...c.appearance };
        for (const k of keep) if (state.appearance[k] != null) merged[k] = state.appearance[k];
        state.appearance = merged;
      } else return sendJSON(res, 404, { error: '没有这个预设' });
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/presets/save' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = String(body.name || '').trim().slice(0, 24);
      if (!name) return sendJSON(res, 400, { error: '预设名字不能为空' });
      state.appearancePresets = (state.appearancePresets || []).filter((x) => x.name !== name);
      state.appearancePresets.push({ name, appearance: { ...state.appearance } });
      if (state.appearancePresets.length > 12) state.appearancePresets.shift();   // 只留最近 12 个
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/presets/delete' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.appearancePresets = (state.appearancePresets || []).filter((x) => x.name !== body.name);
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/advanced' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.occlusion != null && ['never', 'hidden', 'focus'].includes(body.occlusion)) state.occlusion = body.occlusion;
      if (body.sceneFps != null) state.sceneFps = [15, 30, 60].includes(Number(body.sceneFps)) ? Number(body.sceneFps) : state.sceneFps;
      if (body.lyrics != null) state.lyrics = !!body.lyrics;
      if (body.batteryPause != null) state.batteryPause = !!body.batteryPause;   // 电池供电自动暂停(DSH pauseOnBattery)
      if (body.videoFpsCap != null) state.videoFpsCap = [0, 15, 30, 60].includes(Number(body.videoFpsCap)) ? Number(body.videoFpsCap) : state.videoFpsCap;
      if (body.contentFilter != null) state.contentFilter = !!body.contentFilter;
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/mediakey' && method === 'POST') {
      // 媒体反向控制:壁纸里的播放按钮 → 全局媒体键(Wallpaper Engine 同款行为)
      const body = JSON.parse((await readBody(req)) || '{}');
      const action = String(body.action || 'playpause');
      const vk = { playpause: 0xb3, next: 0xb5, prev: 0xb4, stop: 0xb2 }[action];
      if (!vk || process.platform !== 'win32') return sendJSON(res, 200, { ok: false });
      try {
        spawn('powershell.exe', ['-NoProfile', '-Command',
          '$k = [uint16]' + vk + '; Add-Type -MemberDefinition "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte e, uint f, UIntPtr x);" -Name K -Namespace W; [W.K]::keybd_event($k, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W.K]::keybd_event($k, 0, 2, [UIntPtr]::Zero)' ],
        { stdio: 'ignore' }).unref();
      } catch {}
      return sendJSON(res, 200, { ok: true, action });
    }

    if (p === '/api/nowplaying') {
      return sendJSON(res, 200, nowPlaying || { available: false });
    }
    if (p === '/api/lyrics') {
      // lrclib.net 在线歌词(DSH 同源):按标题/艺术家搜索同步 LRC,带缓存
      const title = u.searchParams.get('title') || '';
      const artist = u.searchParams.get('artist') || '';
      if (!title) return sendJSON(res, 200, { synced: null });
      const key = title + '|' + artist;
      if (lyricsCache.has(key)) return sendJSON(res, 200, { synced: lyricsCache.get(key) });
      try {
        const lr = await fetch('https://lrclib.net/api/search?track_name=' + encodeURIComponent(title)
          + '&artist_name=' + encodeURIComponent(artist), {
          headers: { 'User-Agent': 'we-wallpaper/1.0 (github.com/xiahou001/we-wallpaper)' },
          signal: AbortSignal.timeout(8000),
        });
        const list = lr.ok ? await lr.json() : [];
        const hit = (Array.isArray(list) ? list : []).find((x) => x && x.syncedLyrics);
        const synced = hit ? String(hit.syncedLyrics) : null;
        lyricsCache.set(key, synced);
        if (lyricsCache.size > 64) lyricsCache.delete(lyricsCache.keys().next().value);
        return sendJSON(res, 200, { synced });
      } catch {
        return sendJSON(res, 200, { synced: null });
      }
    }
    if (p === '/api/playlists' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = String(body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'name required' });
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const idx = state.playlists.findIndex((x) => x.name === name);
      if (idx >= 0) state.playlists[idx] = { name, ids };
      else state.playlists.push({ name, ids });
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/playlists/delete' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.playlists = state.playlists.filter((x) => x.name !== body.name);
      if (state.rotate.playlist === body.name) { state.rotate.playlist = null; scheduleRotation(); }
      saveState();
      return sendJSON(res, 200, state);
    }
    if (p === '/api/upload' && method === 'POST') {
      // 工作台"自定义壁纸":原始字节体,filename 走查询串(支持图片/视频)
      const filename = (u.searchParams.get('filename') || '').replace(/[\\/:*?"<>|]/g, '_');
      if (!filename) { res.statusCode = 400; return res.end('filename required'); }
      const ext = path.extname(filename).toLowerCase();
      if (!['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.html', '.htm'].includes(ext)) {
        req.resume();   // 消费掉请求体再应答,否则客户端可能收到连接重置而非 400
        res.statusCode = 400; return res.end('unsupported file type');
      }
      const type = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? 'image'
        : ['.html', '.htm'].includes(ext) ? 'web' : 'video';
      const id = 'custom-' + Date.now();
      const dir = path.join(APP_DIR, 'custom', id);
      fs.mkdirSync(dir, { recursive: true });
      await new Promise((resolve2, reject2) => {
        const ws = fs.createWriteStream(path.join(dir, filename));
        req.pipe(ws);
        ws.on('finish', resolve2); ws.on('error', reject2); req.on('error', reject2);
      });
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
        title: filename.replace(/\.[^.]+$/, ''), type, file: filename,
      }));
      inventory = scanWallpapers();
      return sendJSON(res, 200, { id, count: inventory.length });
    }

    // ---- 聊天窗口背景层的远程样式/脚本与诊断 ----
    if (p === '/embed.css') {
      // DSH 式布局 + 智能可读性(源自 dsh-wallpaper-engine 的主题跟随/可读性下限):
      // 播放器实测壁纸亮度 → 亮壁纸自动切深色文字+浅玻璃,暗壁纸用浅色文字+深玻璃;
      // 文字描边滑杆控制全局 text-shadow;界面缩放/亮度热生效。
      const a = state.appearance;
      const lum = luminance == null ? 0.3 : luminance;
      const lightWall = state.readability.auto && lum > 0.55;   // 壁纸偏亮
      const glassDark = (base, alpha) =>
        alpha <= 0 ? 'transparent' : `color-mix(in srgb, ${base} ${alpha}%, transparent)`;
      const rowBase = lightWall ? '#ffffff' : '#14161c';
      const mainBase = lightWall ? '#ffffff' : '#14161c';
      const sideBase = lightWall ? '#f2f3f5' : '#0c0e12';
      const lightBase = lightWall ? '#f2f3f5' : '#14161c';
      // 文字颜色:手动 fontColor(DSH 字体集 themeColors 思路)优先,空 = 智能可读性自动。
      // 覆盖范围 = 消息区 fg 三档 + 聊天框内文字(glassFg),保证"改了就是全改"的可预期性;
      // 选浅色文字配浅玻璃导致看不清是用户自己的选择,工作台一键回自动。
      const fg = a.fontColor || (lightWall ? '#1b1e24' : '#eef1f6');
      const fgSide = a.fontColorSidebar || fg;   // 侧栏文字:空 = 跟随主区
      // 聊天框玻璃颜色(工作台"玻璃颜色"色板):由用户选择,按亮度自动决定框内文字深浅
      const hexLum = (hex) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return 0.08;
        const n = parseInt(m[1], 16);
        return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      };
      const glassBase = a.glassColor || lightBase;
      const glassLight = hexLum(glassBase) > 0.55;              // 玻璃本身偏亮?
      // 聊天框文字:fontColorComposer 空 = 按玻璃明暗自动(聊天框底色是玻璃,与主区亮度无关)
      const glassFg = a.fontColorComposer || (glassLight ? '#1b1e24' : '#eef1f6');
      // 强调色/链接文字的可读性:默认蓝(引用标题/链接/强调)在玻璃上对比不足
      // (实测 ~2.5:1,WCAG 要求 4.5:1),按明暗侧换成高对比蓝并成对给出前景色。
      const accentFg = lightWall ? '#3b5bdb' : '#a5b4ff';       // 亮壁纸→深蓝 / 暗壁纸→浅蓝紫
      const accentOn = lightWall ? '#f2f4ff' : '#12151d';       // 强调色作底时的文字(按钮等)
      const shadow = Math.round(a.stroke * 0.5) / 100;
      const css = `
@property --blindp { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
html, body { background: #101216 !important; }
#root, #root button, #root .btn { font-family: ${a.fontFamily ? JSON.stringify(a.fontFamily) + ' !important' : 'inherit'}; }
${a.cursor ? '#root { cursor: ' + a.cursor + ' !important; }' : ''}
#root { position: relative; z-index: 1; ${a.zoom === 100 ? '' : `zoom: ${a.zoom}%; `}text-shadow: 0 1px 2px rgba(0,0,0,${(shadow * 0.7).toFixed(2)}), 0 0 ${(Math.max(2, Math.round(a.stroke / 10)))}px rgba(0,0,0,${(shadow * 0.45).toFixed(2)}); }
#we-wp-layer { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 0; pointer-events: none; filter: brightness(${a.brightness}%) saturate(1.08); }
/* 文字主题跟随壁纸亮度(智能可读性) */
:root:not(.dark), .dark {
  --color-foreground: ${fg} !important;
  --color-foreground-subtle: ${fg}b8 !important;
  --color-foreground-subtlest: ${fg}80 !important;
  --color-background: ${glassDark(mainBase, a.main)} !important;
  --color-background-win-alt: ${glassDark(mainBase, a.main)} !important;
  --color-header: ${glassDark(mainBase, a.main)} !important;
  --color-background-alt: ${glassDark(rowBase, a.row)} !important;
  --color-panel: ${glassDark(rowBase, a.row + 4)} !important;
  --color-sidebar: ${glassDark(sideBase, a.sidebar)} !important;
  /* 全局输入底色也跟着玻璃化(设置页/搜索框),与聊天框风格一致 */
  --color-input: ${glassDark(glassBase, 62)} !important;
  --color-input-border: ${glassLight ? 'rgba(0,0,0,.14)' : 'rgba(255,255,255,.18)'} !important;
}
.dark { --color-surface: ${glassDark(lightWall ? '#1b1e24' : '#ffffff', Math.round(a.row / 5))} !important; }
/* 强调色/链接/引用标题:换成与明暗侧匹配的高对比蓝,并成对覆盖强调底色上的文字。
   不存在的 token 被安全忽略;text-accent/--color-accent 作为底色时(accent-foreground/
   primary-foreground)也换成配对色,按钮类元素同步保持 WCAG 对比。 */
:root:not(.dark), .dark {
  --color-accent: ${accentFg} !important;
  --color-link: ${accentFg} !important;
  --color-info: ${accentFg} !important;
  --color-primary: ${accentFg} !important;
  --color-accent-foreground: ${accentOn} !important;
  --color-primary-foreground: ${accentOn} !important;
}
#root a { color: ${accentFg} !important; }   /* 裸 <a> 不走 token,按元素兜底 */
/* 分区文字色(每块区域独立):全局 fg 是主区/基线;
   侧栏按 shadcn sidebar 家族容器作用域覆盖(排除 sidebar-inset —— 那是主区内容);
   自定义属性随子树继承,改容器一处即全侧栏生效;不存在的 token 会被安全忽略。 */
[data-slot^="sidebar"]:not([data-slot="sidebar-inset"]) {
  --color-foreground: ${fgSide} !important;
  --color-foreground-subtle: ${fgSide}b8 !important;
  --color-foreground-subtlest: ${fgSide}80 !important;
  --color-muted-foreground: ${fgSide}99 !important;
  --color-accent-foreground: ${fgSide} !important;
}
[data-slot="sidebar-inset"] {
  --color-foreground: ${fg} !important;
  --color-foreground-subtle: ${fg}b8 !important;
  --color-foreground-subtlest: ${fg}80 !important;
}
/* 聊天输入框:磨砂玻璃。
   DOM 实证(embed.js 的输入框抓取探针上报的真实元素链):
     .chat-composer-input-surface              ← 外层(785x107),应保持透明
       └ form.relative.p-0
           └ div.rounded-2xl.border.bg-input   ← 屏幕上看到的那个盒子
   它的底色来自 Tailwind 的 bg-input(= rgb(43,43,43) 不透明),
   所以玻璃必须做在 .bg-input 这一层;只改外层不会有任何可见变化。 */

/* 1) 输入框整条祖先链都不许画背景/渐变:任何不透明祖先都会把壁纸挡死。 */
[data-testid="v4-composer"],
[data-testid="v4-composer"] *:has(.chat-composer-input-surface),
.chat-composer-region *:has(.chat-composer-input-surface),
[data-v4-composer-dock="true"],
[data-v4-composer-dock="true"] > *,
.chat-composer-input-surface {
  background-color: transparent !important;
  background-image: none !important;
}

/* 2) 输入框本体(真正的可见盒子):磨砂玻璃,直接采样身后的壁纸层。
      玻璃颜色来自工作台"玻璃颜色"色板(默认深空黑),透明度来自"聊天框玻璃透明度"。 */
.chat-composer-input-surface form [class~="bg-input"],
.chat-composer-input-surface form > div {
  backdrop-filter: blur(${a.blur}px) saturate(${(1.25 + a.blur / 80).toFixed(2)}) !important;
  -webkit-backdrop-filter: blur(${a.blur}px) saturate(${(1.25 + a.blur / 80).toFixed(2)}) !important;
  /* glass 0..100 线性映射到玻璃 alpha 96%..8%:整个滑杆区间都有效果,
     默认 50 → 52%;极端值保留最低不透明度,避免文字完全不可读。 */
  background-color: ${glassDark(glassBase, Math.max(8, Math.min(96, Math.round(96 - 0.88 * a.glass))))} !important;
  border-color: ${glassLight ? "rgba(0,0,0,.14)" : "rgba(255,255,255,.18)"} !important;
  border-radius: 16px !important;
  /* 玻璃光泽层:即使祖先阻断 backdrop 采样,也能保住磨砂材质的层次感 */
  background-image: linear-gradient(180deg, ${glassLight ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.09)'}, rgba(255,255,255,0) 58%),
    radial-gradient(120% 100% at 50% 0%, ${glassLight ? 'rgba(255,255,255,.45)' : 'rgba(255,255,255,.06)'}, transparent 62%) !important;
  box-shadow: 0 10px 34px rgba(0,0,0,.28), inset 0 1px 0 ${glassLight ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.1)'} !important;
}

/* 框内文字/图标跟着玻璃颜色走:选浅色玻璃时自动用深色文字,保证对比度。
   只作用于输入框子树,不影响消息区(那里直接坐在壁纸上,仍按壁纸亮度决定)。 */
.chat-composer-input-surface form {
  --color-foreground: ${glassFg} !important;
  --color-foreground-subtle: ${glassFg}b8 !important;
  --color-foreground-subtlest: ${glassFg}80 !important;
  --color-input: ${glassDark(glassBase, Math.max(8, Math.min(96, Math.round(96 - 0.88 * a.glass))))} !important;
  --color-input-border: ${glassLight ? "rgba(0,0,0,.14)" : "rgba(255,255,255,.18)"} !important;
}

/* 3) ZCode 给输入区外层套了 will-change:transform 的过渡层,它会建立 backdrop 采样根,
      导致 backdrop-filter 只能采到该层内部(空的)而看不到壁纸。
      只去掉这个图层提示,不碰 transform 本身,所以过渡动画不受影响。 */
[data-testid="conversation-bottom-dock-transition-layer"] {
  will-change: auto !important;
}

`;
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(css);
    }
    if (p === '/bootstrap.js') {
      const js = fs.readFileSync(path.join(__dirname, 'public', 'bootstrap.js'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(js);
    }
    if (p === '/embed.js') {
      const js = fs.readFileSync(path.join(__dirname, 'public', 'embed.js'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(js);
    }
    if (p === '/api/client-diag') {
      const body = await readBody(req);
      try { diagRecord('client', JSON.parse(body)); } catch { diagRecord('client', { detail: body.slice(0, 500) }); }
      res.statusCode = 204; return res.end();
    }
    if (p === '/api/diag') {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }
      const body = await readBody(req);
      try { diagRecord('client', JSON.parse(body)); } catch { diagRecord('client', { detail: body.slice(0, 500) }); }
      try {
        fs.mkdirSync(APP_DIR, { recursive: true });
        fs.appendFileSync(path.join(APP_DIR, 'diag.log'),
          new Date().toISOString() + ' ' + body.slice(0, 8000) + '\n');
      } catch {}
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end('"ok"');
    }

    if (p === '/embed-test') {
      return serveFile(path.join(PUBLIC_DIR, 'embed-test.html'), req, res);
    }
    if (p === '/np-test') {
      res.setHeader("Cache-Control", "no-store");
      return serveFile(path.join(PUBLIC_DIR, 'np-test.html'), req, res);
    }
    if (p === '/workbench') {
      return serveFile(path.join(PUBLIC_DIR, 'workbench.html'), req, res);
    }
    if (p === '/workbench.js') return serveFile(path.join(PUBLIC_DIR, 'workbench.js'), req, res, { cache: 'no-store' });
    if (p === '/workbench.css') return serveFile(path.join(PUBLIC_DIR, 'workbench.css'), req, res, { cache: 'no-store' });

    // ---- 播放页 ----
    if (p === '/' || p === '/index.html') {
      return serveFile(path.join(PUBLIC_DIR, 'player.html'), req, res);
    }
    if (p === '/player.js') return serveFile(path.join(PUBLIC_DIR, 'player.js'), req, res);
    if (p === '/panel.js') return serveFile(path.join(PUBLIC_DIR, 'panel.js'), req, res, { cache: 'no-store' });
    if (p === '/player.css') return serveFile(path.join(PUBLIC_DIR, 'player.css'), req, res);

    // ---- Web 壁纸(sandbox iframe 载荷:HTML 注入 web-shim,提供 WE API 兼容层)----
    if (p === '/web-shim.js') {
      return serveFile(path.join(VENDOR_DIR, 'web-shim.js'), req, res, { cache: 'no-store' });
    }
    if (p.startsWith('/web-live/')) {
      const rest = p.slice('/web-live/'.length);   // <id>/<file...>
      const slash = rest.indexOf('/');
      const id = slash >= 0 ? rest.slice(0, slash) : rest;
      const rel = slash >= 0 ? rest.slice(slash + 1) : '';
      const w = inventory.find((x) => x.id === id);
      if (!w || w.type !== 'web') { res.statusCode = 404; return res.end('no such web wallpaper'); }
      // 空路径 → 入口文件;目录请求 → 入口文件
      let target = rel || path.relative(w.dir, w.fileAbs).split(path.sep).join('/');
      let abs = fenced(w.dir, target);
      if (abs && fs.statSync(abs).isDirectory()) abs = fenced(w.dir, target + '/' + path.basename(w.fileAbs));
      if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      if (/\.(html?|htm)$/i.test(abs)) {
        // 注入 shim 作为首个脚本(必须在作者脚本前注册 WE API)
        let html = fs.readFileSync(abs, 'utf8');
        const shimTag = '<script src="/web-shim.js"></script>';
        if (!html.includes('/web-shim.js')) {
          if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + shimTag);
          else html = shimTag + html;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      return serveFile(abs, req, res, { cache: 'public, max-age=600' });
    }

    // ---- Scene 内嵌视频降级（首次请求时探测并缓存）----
    if (p.startsWith('/scene-video/')) {
      const id = p.slice('/scene-video/'.length);
      const w = inventory.find((x) => x.id === id);
      const fallback = w && sceneFallbackFile(w);
      if (!fallback) { res.statusCode = 404; return res.end('no embedded scene video'); }
      return serveFile(fallback, req, res, { cache: 'public, max-age=3600' });
    }

    // ---- 预览图 ----
    if (p.startsWith('/preview/')) {
      const id = p.slice('/preview/'.length);
      const w = inventory.find((x) => x.id === id);
      if (!w || !w.previewAbs) { res.statusCode = 404; return res.end('no preview'); }
      return serveFile(w.previewAbs, req, res, { cache: 'public, max-age=300' });
    }

    // ---- 壁纸自有文件(目录围栏=壁纸目录)----
    if (p.startsWith('/media/')) {
      const rest = p.slice('/media/'.length); // <id>/<file...>
      const slash = rest.indexOf('/');
      const id = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      const w = inventory.find((x) => x.id === id);
      if (!w) { res.statusCode = 404; return res.end('no such wallpaper'); }
      let abs = fenced(w.dir, rel);
      if (!abs) { res.statusCode = 403; return res.end('forbidden-media'); }
      if (/\.(mp4|m4v|mov)$/i.test(abs)) {
        // moov 在尾部的视频会迫使浏览器整读文件才拿到元数据(DSH 根因修复):
        // 一次性无损重排(faststart),变体缓存后与文件大小解耦;失败回原片
        const fsv = await faststartVariant(abs, id);          // ① moov 前置(无损)
        const base2 = fsv || abs;
        const tv = await videoVariant(base2, id);             // ② 帧率上限转码(对 faststart 变体亦可)
        if (tv) abs = tv; else if (fsv) abs = fsv;
      }
      return serveFile(abs, req, res, { cache: 'public, max-age=3600' });
    }

    // ---- scene.pkg 载荷(token=base64url(scene.pkg 绝对路径),与 dsh-wallpaper-engine 同协议)----
    if (p.startsWith('/scene-files/')) {
      const rest = p.slice('/scene-files/'.length); // <token>/<file...>
      const slash = rest.indexOf('/');
      const token = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      let fileAbs;
      try { fileAbs = Buffer.from(token, 'base64url').toString('utf8'); } catch { res.statusCode = 400; return res.end('bad token'); }
      if (!fileAbs || (!fs.existsSync(fileAbs) && !fs.existsSync(path.dirname(fileAbs)))) { res.statusCode = 404; return res.end('stale token'); }
      const abs = fenced(path.dirname(fileAbs), rel);
      if (!abs) { diagRecord('fence', { token, rel }); res.statusCode = 403; return res.end('forbidden-scene-files'); }
      const prog = trackProgress(token);
      prog.active = 1; prog.startedAt ||= Date.now();
      res.once('finish', () => { prog.active = 0; prog.served = Date.now(); prog.size = (() => { try { return fs.statSync(abs).size; } catch { return 0; } })(); });
      return serveFile(abs, req, res, { cache: path.extname(abs).toLowerCase() === '.html' ? 'no-store' : 'public, max-age=3600' });
    }

    // ---- vendored WebWallGL 渲染页(哈希名资源 immutable)----
    if (p === LIVE_PREFIX || p.startsWith(LIVE_PREFIX + '/')) {
      const rel = p.slice(LIVE_PREFIX.length).replace(/^\/+/, '') || 'index.html';
      const abs = fenced(VENDOR_DIR, rel);
      if (!abs) { res.statusCode = 403; return res.end('forbidden-scene-live'); }
      return serveFile(abs, req, res, { cache: rel === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
    }

    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    try { sendJSON(res, 500, { error: String((err && err.message) || err) }); } catch {}
  }
});

server.on('error', (e) => {
  console.error('[we-wallpaper] 服务器错误: ' + ((e && e.code) || e.message));
  if (e && e.code === 'EADDRINUSE') console.error('[we-wallpaper] 端口被占用:已有实例在运行,本实例退出。');
});
server.listen(PORT, '127.0.0.1', () => {
  const playable = inventory.filter((w) => w.playable).length;
  console.log(`[we-wallpaper] http://127.0.0.1:${PORT}  壁纸 ${inventory.length} 个(可播放 ${playable})`);
  console.log(`[we-wallpaper] 状态文件: ${STATE_FILE}`);
});
scheduleRotation();
startNowPlayingPoller();
startPatchWatchdog();
// CDP 注入轨道(零改文件):ZCode 经 launch-zcode.vbs 带 --remote-debugging-port=9333
// 启动时,这里自动把 bootstrap 挂进聊天窗口。端口没人听时轮询空转,无副作用;
// 与 asar 补丁轨道经 bootstrap 的幂等闸共存,先到先得。
const cdpInjector = startCdpInjector({
  port: Number(process.env.WE_CDP_PORT || 9333),
  log: (m) => diagRecord(m),
});
sweepStaleCacheOnBoot();   // 指纹命名升级前留下的旧变体一次性回收
sweepMediaCache();         // 启动先过一遍预算
warmFaststartOnBoot();     // 轮换列表视频预热 moov 前置(后台串行,不阻塞服务)
