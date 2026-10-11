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
import { sanitizeState } from './settings-schema.js';
import wpWatchdog from './watchdog-patch.js';
const startPatchWatchdog = wpWatchdog.startPatchWatchdog ?? wpWatchdog.start ?? (() => {});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WE_WP_PORT || 7396);
const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.we-wallpaper');
const STATE_FILE = path.join(APP_DIR, 'state.json');
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
        if (mainAbs) list.push({ id, title: proj.title || id, contentrating: rating, type: 'scene', dir, fileAbs: mainAbs, previewAbs, playable: true });
        else list.push({ id, title: proj.title || id, contentrating: rating, type, dir, fileAbs: null, previewAbs, playable: false });
      } else if (type === 'video' && fileOk) {
        list.push({ id, title: proj.title || id, contentrating: rating, type: 'video', dir, fileAbs, previewAbs, playable: true });
      } else if (type === 'image' && fileOk) {
        list.push({ id, title: proj.title || id, contentrating: rating, type: 'image', dir, fileAbs, previewAbs: fileAbs, playable: true });
      } else if (type === 'web' && fileOk) {
        list.push({ id, title: proj.title || id, contentrating: rating, type: 'web', dir, fileAbs, previewAbs, playable: true });
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
// moov 是否已在文件头部(前 2MB 内):在 → 播放器元数据立即可得;不在 → 需要重排
function moovAtHead(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, fs.statSync(abs).size));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    return buf.indexOf(Buffer.from('moov')) >= 0;
  } catch { return true; }
}

// 变体生成(带去重:同一源并发请求共享同一个 promise)
const faststartJobs = new Map();
function faststartVariant(abs, id) {
  try {
    const st = fs.statSync(abs);
    if (!/\.(mp4|m4v|mov)$/i.test(abs)) return Promise.resolve(null);
    if (!detectFfmpeg()) return Promise.resolve(null);
    const key = abs + '|' + st.size + '|' + Math.floor(st.mtimeMs);
    const outDir = path.join(APP_DIR, 'cache', 'faststart');
    const out = path.join(outDir, id + '.mp4');
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
  const out = path.join(outDir, id + '-' + cap + '.mp4');
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
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  headers['Content-Length'] = st.size;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(abs).pipe(res);
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
            sizeBytes: (() => { try { return fs.statSync(w.fileAbs).size; } catch { return 0; } })(),
          };
        }),
        state,
      });
    }
    if (p === '/api/state') return sendJSON(res, 200, { ...state, luminance });
    // 极轻量的版本探针:客户端高频轮询它,变了才去取整份 /embed.css(降低换色的等待)
    if (p === '/api/version') return sendJSON(res, 200, { v: stateVersion });
    if (p === '/api/diag-log') return sendJSON(res, 200, { entries: diagEntries.slice(-80), reqlog: REQLOG.slice(-60) });
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
      const ms = Math.max(0, Math.min(8000, Number(body.ms) || 0));
      const KINDS = ['none', 'crossfade', 'push', 'wipe', 'iris', 'zoom', 'blinds'];
      const kind = KINDS.includes(body.kind) ? body.kind : (ms > 0 ? 'crossfade' : 'none');
      state.transition = { kind, ms };
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
      luminance = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
      return sendJSON(res, 200, { v: luminance });
    }
    if (p === '/api/advanced' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.occlusion != null && ['never', 'hidden', 'focus'].includes(body.occlusion)) state.occlusion = body.occlusion;
      if (body.sceneFps != null) state.sceneFps = [15, 30, 60].includes(Number(body.sceneFps)) ? Number(body.sceneFps) : state.sceneFps;
      if (body.lyrics != null) state.lyrics = !!body.lyrics;
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
      const fg = lightWall ? '#1b1e24' : '#eef1f6';
      // 聊天框玻璃颜色(工作台"玻璃颜色"色板):由用户选择,按亮度自动决定框内文字深浅
      const hexLum = (hex) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return 0.08;
        const n = parseInt(m[1], 16);
        return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      };
      const glassBase = a.glassColor || lightBase;
      const glassLight = hexLum(glassBase) > 0.55;              // 玻璃本身偏亮?
      const glassFg = glassLight ? '#1b1e24' : '#eef1f6';
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

server.listen(PORT, '127.0.0.1', () => {
  const playable = inventory.filter((w) => w.playable).length;
  console.log(`[we-wallpaper] http://127.0.0.1:${PORT}  壁纸 ${inventory.length} 个(可播放 ${playable})`);
  console.log(`[we-wallpaper] 状态文件: ${STATE_FILE}`);
});
scheduleRotation();
startNowPlayingPoller();
startPatchWatchdog();
