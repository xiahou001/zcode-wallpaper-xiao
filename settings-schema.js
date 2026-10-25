// Shared validation for the standalone ZCode wallpaper server.
// Keep this browser/Node safe and dependency-free.
export const DEFAULTS = {
  currentId: null, paused: false, volume: 1,
  rotate: { enabled: false, intervalMin: 30, playlist: null },
  transition: { kind: 'crossfade', ms: 1800 },
  appearance: { main: 0, row: 52, sidebar: 55, brightness: 100, stroke: 35, zoom: 100, blur: 22, glass: 50, glassColor: '#14161c', fontFamily: '', cursor: '' },
  readability: { auto: true }, occlusion: 'hidden', sceneFps: 30, videoFpsCap: 0, playlists: [], workshopDirs: [],
  lyrics: false,        // 在线歌词跑马灯(默认关闭,与 DSH 一致)
  contentFilter: false, // 内容分级过滤:隐藏 R 级壁纸(DSH 功能)
  weAssetsDir: null,    // WE 官方素材目录(手动覆盖;null=自动探测 Steam 库,localAssets 功能)
};
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
export function sanitizeState(input = {}) {
  const s = { ...DEFAULTS, ...input };
  s.currentId = input.currentId == null ? null : String(input.currentId);
  s.paused = Boolean(input.paused); s.volume = num(input.volume, 0, 1, 1);
  s.rotate = { ...DEFAULTS.rotate, ...(input.rotate || {}) };
  s.rotate.enabled = Boolean(s.rotate.enabled); s.rotate.intervalMin = num(s.rotate.intervalMin, 1, 1440, 30);
  s.rotate.playlist = s.rotate.playlist ? String(s.rotate.playlist) : null;
  s.transition = { ...DEFAULTS.transition, ...(input.transition || {}) };
  s.transition.ms = num(s.transition.ms, 0, 8000, 1800);
  const KINDS = ['none','crossfade','push','wipe','iris','zoom','blinds'];
  s.transition.kind = KINDS.includes(s.transition.kind) ? s.transition.kind : (s.transition.ms ? 'crossfade' : 'none');
  s.appearance = { ...DEFAULTS.appearance, ...(input.appearance || {}) };
  for (const k of ['main','row','sidebar','stroke']) s.appearance[k] = num(s.appearance[k], 0, 100, DEFAULTS.appearance[k]);
  s.appearance.brightness = num(s.appearance.brightness, 40, 160, 100);
  s.appearance.zoom = num(s.appearance.zoom, 80, 140, 100);
  s.appearance.blur = num(s.appearance.blur, 0, 40, DEFAULTS.appearance.blur);   // 聊天框磨砂强度(px)
  s.appearance.glass = num(s.appearance.glass, 0, 100, DEFAULTS.appearance.glass);   // 聊天框玻璃透明度(0=实心 100=最透)
  s.appearance.fontFamily = /^[\w\u4e00-\u9fa5,\s'\"-]{0,120}$/.test(String(s.appearance.fontFamily || '')) ? String(s.appearance.fontFamily).trim() : '';
  s.appearance.cursor = ['', 'default', 'pointer', 'crosshair', 'text'].includes(String(s.appearance.cursor || '')) ? String(s.appearance.cursor || '') : '';
  // 聊天框玻璃颜色:只接受 #rrggbb,非法值回落到默认深空黑
  s.appearance.glassColor = /^#[0-9a-f]{6}$/i.test(String(s.appearance.glassColor || ''))
    ? String(s.appearance.glassColor).toLowerCase()
    : DEFAULTS.appearance.glassColor;
  s.readability = { auto: input.readability?.auto !== false };
  s.occlusion = ['never','hidden','focus'].includes(input.occlusion) ? input.occlusion : 'hidden';
  s.sceneFps = [15,30,60].includes(Number(input.sceneFps)) ? Number(input.sceneFps) : 30;
  s.playlists = Array.isArray(input.playlists) ? input.playlists.filter(p => p && String(p.name || '').trim()).map(p => ({ name: String(p.name).trim(), ids: Array.isArray(p.ids) ? p.ids.map(String) : [] })) : [];
  s.workshopDirs = Array.isArray(input.workshopDirs) ? input.workshopDirs.map(String).filter(Boolean) : [];
  s.lyrics = Boolean(input.lyrics);
  s.contentFilter = Boolean(input.contentFilter);
  s.videoFpsCap = [0, 15, 30, 60].includes(Number(input.videoFpsCap)) ? Number(input.videoFpsCap) : 0;   // 视频壁纸帧率上限(0=无限制,超上限自动转码)
  // WE 素材目录:只存路径字符串,可用性(含 materials/ 子目录)由服务器在用时探测;
  // 非法形态一律回落 null(= 自动探测),绝不因手工填错路径卡死状态保存。
  s.weAssetsDir = typeof input.weAssetsDir === 'string' && input.weAssetsDir.trim() ? String(input.weAssetsDir).trim() : null;
  return s;
}
