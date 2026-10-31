// Shared validation for the standalone ZCode wallpaper server.
// Keep this browser/Node safe and dependency-free.
export const DEFAULTS = {
  currentId: null, paused: false, volume: 1,
  rotate: { enabled: false, intervalMin: 30, playlist: null, random: false },
  transition: { kind: 'crossfade', ms: 1800 },
  appearance: { main: 0, row: 52, sidebar: 55, brightness: 100, stroke: 35, zoom: 100, blur: 22, glass: 50, glassColor: '#14161c', glassColorDark: '', fontFamily: '', cursor: '', filter: 'none', fontColor: '', fontColorSidebar: '', fontColorComposer: '', fit: 'cover', themeMode: 'auto', accentColor: '', flip: false, bgBrightness: 100, bgContrast: 100, bgSaturate: 100, opacity: 100, scrim: 0, caretColor: '' },
  videoRate: 1,         // 视频壁纸播放倍速(0.5~2,源自 DSH playbackRate)
  readability: { auto: true }, occlusion: 'hidden', sceneFps: 30, videoFpsCap: 0, playlists: [], workshopDirs: [],
  lyrics: false,        // 在线歌词跑马灯(默认关闭,与 DSH 一致)
  contentFilter: false, // 内容分级过滤:隐藏 R 级壁纸(DSH 功能)
  weAssetsDir: null,    // WE 官方素材目录(手动覆盖;null=自动探测 Steam 库,localAssets 功能)
  batteryPause: false,  // 电池供电时自动暂停(源自 DSH pauseOnBattery;仅笔记本有效)
  hiddenIds: [],        // 隐藏的壁纸 id(源自 DSH hiddenIds 软删除:离开清单与轮播,正在播的不打断)
  fxEnabled: false,     // 光效总开关(源自 DSH fxEnabled:点击涟漪/光标拖尾,默认关)
  fxColorMode: 'accent',  // 光效配色:accent=跟随强调色 / rainbow=流转彩虹 / custom=自定义色
  fxColor: '',          // 自定义光效色(仅 fxColorMode=custom 时生效)
};
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
// 壁纸滤镜白名单(与 player.js 的 WALLPAPER_FILTERS 一一对应)
export const WALLPAPER_FILTERS = ['none','blur','grayscale','sepia','vivid','warm','cool','invert','brighten','darken','contrast'];
export function sanitizeState(input = {}) {
  const s = { ...DEFAULTS, ...input };
  s.currentId = input.currentId == null ? null : String(input.currentId);
  s.paused = Boolean(input.paused); s.volume = num(input.volume, 0, 1, 1);
  s.rotate = { ...DEFAULTS.rotate, ...(input.rotate || {}) };
  s.rotate.enabled = Boolean(s.rotate.enabled); s.rotate.intervalMin = num(s.rotate.intervalMin, 1, 1440, 30);
  s.rotate.playlist = s.rotate.playlist ? String(s.rotate.playlist) : null;
  s.rotate.random = Boolean(s.rotate.random);   // 随机轮换(默认顺序)
  s.transition = { ...DEFAULTS.transition, ...(input.transition || {}) };
  s.transition.ms = num(s.transition.ms, 0, 8000, 1800);
  const KINDS = ['none','crossfade','push','wipe','iris','zoom','blinds'];
  s.transition.kind = KINDS.includes(s.transition.kind) ? s.transition.kind : (s.transition.ms ? 'crossfade' : 'none');
  // 过场方向(源自 DSH switchTransitionDir):新层从哪个方向进入(左=从右滑入)
  s.transition.dir = ['left','right','up','down'].includes(s.transition.dir) ? s.transition.dir : 'left';
  s.appearance = { ...DEFAULTS.appearance, ...(input.appearance || {}) };
  for (const k of ['main','row','sidebar','stroke']) s.appearance[k] = num(s.appearance[k], 0, 100, DEFAULTS.appearance[k]);
  s.appearance.brightness = num(s.appearance.brightness, 40, 160, 100);
  s.appearance.zoom = num(s.appearance.zoom, 80, 140, 100);
  s.appearance.blur = num(s.appearance.blur, 0, 40, DEFAULTS.appearance.blur);   // 聊天框磨砂强度(px)
  s.appearance.glass = num(s.appearance.glass, 0, 100, DEFAULTS.appearance.glass);   // 聊天框玻璃透明度(0=实心 100=最透)
  s.appearance.fontFamily = /^[\w\u4e00-\u9fa5,\s'\"-]{0,120}$/.test(String(s.appearance.fontFamily || '')) ? String(s.appearance.fontFamily).trim() : '';
  s.appearance.cursor = ['', 'default', 'pointer', 'crosshair', 'text'].includes(String(s.appearance.cursor || '')) ? String(s.appearance.cursor || '') : '';
  // 壁纸滤镜(源自 dsh-wallpaper-engine 的效果白名单,场景/视频/图片层通用)
  s.appearance.filter = WALLPAPER_FILTERS.includes(s.appearance.filter) ? s.appearance.filter : 'none';
  // 文字颜色:'' = 智能可读性自动(按壁纸亮度翻转);'#rrggbb' = 手动覆盖(DSH 字体集 themeColors 思路)
  // 分区独立配色:sidebar(侧栏)空 = 跟随主区色;composer(聊天框)空 = 玻璃对比自动
  s.appearance.fontColor = /^#[0-9a-f]{6}$/i.test(String(s.appearance.fontColor || ''))
    ? String(s.appearance.fontColor).toLowerCase()
    : '';
  s.appearance.fontColorSidebar = /^#[0-9a-f]{6}$/i.test(String(s.appearance.fontColorSidebar || ''))
    ? String(s.appearance.fontColorSidebar).toLowerCase()
    : '';
  s.appearance.fontColorComposer = /^#[0-9a-f]{6}$/i.test(String(s.appearance.fontColorComposer || ''))
    ? String(s.appearance.fontColorComposer).toLowerCase()
    : '';
  // 填充方式(视频/图片层 object-fit 与场景渲染器 fit 参数,源自 DSH 的 objectFit)
  s.appearance.fit = ['cover', 'contain', 'stretch'].includes(s.appearance.fit) ? s.appearance.fit : 'cover';
  // 主题模式:auto=智能(随壁纸亮度+可读性开关)/dark=强制深色/light=强制浅色
  s.appearance.themeMode = ['auto', 'dark', 'light'].includes(s.appearance.themeMode) ? s.appearance.themeMode : 'auto';
  // 强调色(引用/链接等):'' = 自动高对比蓝;'#rrggbb' = 用户指定
  s.appearance.accentColor = /^#[0-9a-f]{6}$/i.test(String(s.appearance.accentColor || ''))
    ? String(s.appearance.accentColor).toLowerCase()
    : '';
  s.appearance.flip = Boolean(s.appearance.flip);   // 画面水平镜像(源自 DSH flip)
  // 画面微调三旋钮(源自 DSH backgroundBrightness/Contrast/Saturate):100 = 不动
  s.appearance.bgBrightness = num(s.appearance.bgBrightness, 50, 150, 100);
  s.appearance.bgContrast = num(s.appearance.bgContrast, 50, 150, 100);
  s.appearance.bgSaturate = num(s.appearance.bgSaturate, 0, 200, 100);
  // 壁纸透明度(源自 DSH wallpaperOpacity):100 = 不动,调低让壁纸融向深色底
  s.appearance.opacity = num(s.appearance.opacity, 10, 100, 100);
  // 暗化层(源自 DSH scrim):壁纸上方的黑色罩,0 = 关
  s.appearance.scrim = num(s.appearance.scrim, 0, 80, 0);
  // 输入光标颜色(源自 DSH caretColor):'' = 跟随原生;光标色与壁纸相近时会隐形
  s.appearance.caretColor = /^#[0-9a-f]{6}$/i.test(String(s.appearance.caretColor || ''))
    ? String(s.appearance.caretColor).toLowerCase()
    : '';
  // 深色壁纸时的玻璃颜色('' = 跟随主玻璃色,即保持单一玻璃色的旧行为)
  s.appearance.glassColorDark = /^#[0-9a-f]{6}$/i.test(String(s.appearance.glassColorDark || ''))
    ? String(s.appearance.glassColorDark).toLowerCase()
    : '';
  s.videoRate = num(input.videoRate, 0.5, 2, 1);   // 视频倍速(0.5~2 连续值)
  // 自定义外观预设:只保留名字与外观快照,上限 12 个(防状态文件无限膨胀)
  s.appearancePresets = Array.isArray(input.appearancePresets)
    ? input.appearancePresets.slice(0, 12).filter((p) => p && String(p.name || '').trim()).map((p) => ({
      name: String(p.name).trim().slice(0, 24),
      appearance: { ...DEFAULTS.appearance, ...(p.appearance || {}), filter: WALLPAPER_FILTERS.includes(p.appearance?.filter) ? p.appearance.filter : 'none' },
    }))
    : [];
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
  s.batteryPause = Boolean(input.batteryPause);   // 电池供电自动暂停(DSH pauseOnBattery)
  s.videoFpsCap = [0, 15, 30, 60].includes(Number(input.videoFpsCap)) ? Number(input.videoFpsCap) : 0;   // 视频壁纸帧率上限(0=无限制,超上限自动转码)
  // WE 素材目录:只存路径字符串,可用性(含 materials/ 子目录)由服务器在用时探测;
  // 非法形态一律回落 null(= 自动探测),绝不因手工填错路径卡死状态保存。
  s.weAssetsDir = typeof input.weAssetsDir === 'string' && input.weAssetsDir.trim() ? String(input.weAssetsDir).trim() : null;
  // 场景失败记忆(源自 DSH sceneLiveFailures):{ 壁纸id: true }。首帧超时的场景记进来,
  // 之后选择/轮换到它直接走视频降级,不再每次白等整包下载;工作台「重试」清空。
  s.sceneFailures = (input.sceneFailures && typeof input.sceneFailures === 'object' && !Array.isArray(input.sceneFailures))
    ? Object.fromEntries(Object.entries(input.sceneFailures).slice(0, 200).map(([k]) => [String(k).slice(0, 64), true]))
    : {};
  // 隐藏的壁纸(软删除,源自 DSH hiddenIds):离开清单/轮播但可随时恢复;
  // id 只收壁纸 id 形态(字母数字_-),上限 500
  s.hiddenIds = Array.isArray(input.hiddenIds)
    ? input.hiddenIds.map(String).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 500)
    : [];
  // 光效(源自 DSH fx*):默认关
  s.fxEnabled = Boolean(input.fxEnabled);
  s.fxColorMode = ['accent', 'rainbow', 'custom'].includes(input.fxColorMode) ? input.fxColorMode : 'accent';
  s.fxColor = /^#[0-9a-f]{6}$/i.test(String(input.fxColor || '')) ? String(input.fxColor).toLowerCase() : '';
  return s;
}
