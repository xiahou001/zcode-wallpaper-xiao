/**
 * we-wallpaper 播放页。
 *
 * scene 壁纸:挂 vendored WebWallGL 渲染页 iframe(/wallpaper-engine/scene-live/),
 * 通过 URL 参数传入载荷地址 —— 协议与 dsh-wallpaper-engine 的 liveRenderUrl 一致:
 *   ?type=scene&fit=cover&sceneFps=30&muted=…&src=<base64url(scene.pkg绝对路径)>&mediaBase=<origin>/scene-files
 * video 壁纸:直接 <video loop> 播放 /media/<id>/<文件名>。
 *
 * 控制面状态来自服务器 /api/state(单真源):本页每 2s 轮询,
 * 因此 ZCode skill 走 HTTP API 切换/暂停时,已打开的播放页会即时跟随。
 */
(() => {
  // embed=1:作为 ZCode 聊天窗口的背景层运行 —— 隐藏控制界面、不绑任何键盘/鼠标
  // 事件(避免抢聊天输入),只按服务器状态渲染;控制一律走 skill 的 HTTP API。
  const EMBED = new URLSearchParams(location.search).has('embed');
  const stage = document.getElementById('stage');
  const $ = (id) => document.getElementById(id);

  let wallpapers = [];
  let state = { currentId: null, paused: false, volume: 1, rotate: { enabled: false, intervalMin: 30 } };
  let mountedId = null;
  let mountedKind = null;    // scene|video|image|web
  let onLayerReady = null;   // 帧门控回调:新层首帧就绪时由挂载函数调用
  let layer = null;          // 当前层元素(iframe / video / img)
  let hudTimer = 0;
  let sawGesture = false;    // 首次用户手势后允许出声
  let recoveryTimer = 0;
  let recoveryAttempts = 0;
  let suppressRecoveryReset = false;
  let sceneWatchdog = 0;
  let sceneReloadTries = {};

    // 所有服务器请求带超时:一次挂起的 fetch 若无超时,pollBusy 会永远锁死,
  // 之后所有切换/暂停全部失效 —— 正是「有时换不动壁纸」的根因。
  const api = (path, body) => {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 8000);
    return fetch(path, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    } : { signal: ctrl.signal }).then((r) => r.json()).finally(() => clearTimeout(kill));
  };
  const current = () => wallpapers.find((w) => w.id === state.currentId) || null;
  function notifyParentReady() {
    if (!EMBED || window.parent === window) return;
    try { window.parent.postMessage({ source: 'we-wallpaper', type: 'ready' }, '*'); } catch {}
  }

  // ── 挂载/卸载 ──────────────────────────────────────────────
  function unmount() {
    clearTimeout(recoveryTimer);
    clearInterval(sceneWatchdog);
    webPointerTarget = null;
    onLayerReady = null;
    if (!layer) return;
    try { layer.src = 'about:blank'; } catch {}
    layer.remove();
    layer = null;
    mountedId = null;
  }

  function wallpaperFailed(w, reason) {
    const active = current();
    if (!w || !active || active.id !== w.id) return;
    const attempt = ++recoveryAttempts;
    try {
      fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'playback-recovery', id: w.id, type: w.type, attempt, reason }) }).catch(() => {});
    } catch {}
    if (attempt <= 3) {
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        if (current().id !== w.id) return;
        suppressRecoveryReset = true;   // 重试挂载:不清零恢复计数
        unmount();
        mountedId = null;
        mountCurrent();
      }, Math.min(8000, 1000 * attempt));
      return;
    }
    // Scene 优先尝试从 scene.pkg 中抽出的内嵌 MP4，再降级到作者预览图。
    if (w.type === 'scene') {
      // 重试耗尽:把这张场景记进服务器失败记忆(源自 DSH sceneLiveFailures),
      // 之后选择/轮换到它直接走降级,不再每次白等整包下载。
      api('/api/scene-fail', { id: w.id, reason: 'retries-exhausted' }).catch(function () {});
      mountSceneFallback(w);
    } else if (w.preview) {
      unmount();
      mountFallback(w);
      $('hud-title').textContent = w.title + '（预览图）';
    }
  }

  // 场景降级链(DSH sceneVideo → 预览图):先试 pkg 内嵌视频,没有再退预览图。
  function mountSceneFallback(w) {
    unmount();
    const v = document.createElement('video');
    v.loop = true; v.muted = effectiveMuted(); v.autoplay = true; v.playsInline = true;
    v.src = '/scene-video/' + encodeURIComponent(w.id); v.className = 'layer-enter';
    v.addEventListener('loadeddata', () => { recoveryAttempts = 0; v.classList.add('layer-on'); const cb = onLayerReady; onLayerReady = null; if (cb) cb(); });
    v.addEventListener('error', () => { unmount(); if (w.preview) { mountFallback(w); $('hud-title').textContent = w.title + '（预览图）'; } });
    stage.appendChild(v); layer = v; mountedId = w.id; v.play().catch(() => {});
    $('hud-title').textContent = w.title + '（视频降级）';
  }

  function mountScene(w) {
    // 失败记忆命中(源自 DSH sceneLiveFailures):这张场景此前首帧超时过,
    // 直接走降级链,不再重复整包下载的等待 —— 轮换列表混进坏场景不再拖慢切换。
    if (state.sceneFailures && state.sceneFailures[w.id]) {
      mountSceneFallback(w);
      return;
    }
    const mountAt = Date.now();   // 加载进度显示的起点(预算的 startAt 会被遮挡暂停重置)
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.setAttribute('allowtransparency', 'true');
    const muted = effectiveMuted();
    const fps = state.sceneFps || 30;
    const src = '/wallpaper-engine/scene-live/index.html'
      + '?type=scene&fit=' + effFit() + '&sceneFps=' + fps
      + '&muted=' + (muted ? 'true' : 'false')
      + '&src=' + encodeURIComponent(w.sceneBase)
      + '&mediaBase=' + encodeURIComponent(location.origin + '/scene-files')
      // WE 官方素材通路(localAssets):配置了素材目录时,引擎按名取官方贴图,
      // 场景渲染与官方引擎逐像素对齐;未配置时不加参数,引擎零请求。
      + (state.weAssetsAvailable ? '&localAssets=1' : '');
    iframe.src = src;
    iframe.className = 'layer-enter';
    // 注意:iframe load ≠ 首帧。上屏交给看护(fps>0 时调 onLayerReady),
    // pkg 下载期间用户看的还是旧壁纸 —— 绝不提前淡入空层。
    iframe.addEventListener('error', () => wallpaperFailed(w, 'scene-iframe-error'));
    stage.appendChild(iframe);
    layer = iframe;
    mountedId = w.id;
    clearInterval(sceneWatchdog);
    // 首帧看护:renderers 在 pkg 整包下载完之前不发任何东西,预算随包大小放宽;
    // 就绪判定 = __wp 存在且 __wpStats 报告 fps>0(只查存在会漏掉"加载了但渲染不出")
    const budgetMs = 12000 + Math.min(90000, Math.round((w.sizeBytes || 0) / 1e6) * 400);   // 大包按大小放宽:235MB ≈ 106s
    let startAt = Date.now();
    sceneWatchdog = setInterval(() => {
      if (layer !== iframe || mountedId !== w.id) { clearInterval(sceneWatchdog); return; }
      if (document.hidden) { startAt = Date.now(); return; }   // 遮挡暂停期间不计入预算
      api('/api/scene-progress?token=' + encodeURIComponent(w.sceneBase || ''))   // 带超时:挂起的探询不再拖住看护节拍
        .then(function (p) {
          if (p && p.active > 0) {
            startAt = Date.now();
            // 大包加载进度:标题显示已等待秒数 —— 用户看得出「在加载」而不是「卡死」
            try { $('hud-title').textContent = w.title + '(加载中 ' + Math.round((Date.now() - mountAt) / 1000) + 's)'; } catch (e3) {}
            return;
          }
          if (p && p.served && Date.now() - startAt > budgetMs) { clearInterval(sceneWatchdog); wallpaperFailed(w, 'scene-no-frames'); }
        }).catch(function () {
  // 兜底:偶发的挂起请求超时中止后,不让未处理 rejection 刷屏
  window.addEventListener('unhandledrejection', function (e) { e.preventDefault(); });});
      try {
        const win = iframe.contentWindow;
        const st = win && win.__wpStats;
        const frame = st && typeof st.frame === 'function' ? st.frame() : null;
        // 渲染器以零尺寸初始化的修复:画布 1x1 时补发 resize 并重载渲染器,
        // 强制 WebWallGL 按真实窗口尺寸重建画布并启动渲染循环(只补一次)
        if (win && frame && frame.fps <= 0) {
          const cv = win.document && win.document.querySelector('canvas');
          if (cv && cv.width <= 1) {
            try { win.dispatchEvent(new Event('resize')); } catch (e) {}
            sceneReloadTries[w.id] = (sceneReloadTries[w.id] || 0) + 1;
            if (sceneReloadTries[w.id] > 2) { clearInterval(sceneWatchdog); wallpaperFailed(w, 'scene-zero-size-loop'); return; }
            try { win.location.reload(); } catch (e) {}
          }
        }
        if (win && win.__wp && frame && frame.running && frame.fps > 0) {
          clearInterval(sceneWatchdog);
          recoveryAttempts = 0;
          try { $('hud-title').textContent = w.title; } catch (e5) {}   // 起播:去掉「加载中」后缀
          const cb = onLayerReady; onLayerReady = null;
          if (cb) cb();              // 首帧就绪:淡出旧壁纸,淡入场景
          pushSceneMedia();          // 就绪即推送 Now Playing(媒体响应型壁纸)
          return;                    // 正常渲染中
        }
        // 区分「还在下载」与「出不了帧」(DSH 同款):载荷在传输则顺延预算
        if (Date.now() - startAt > budgetMs) {
          api('/api/scene-progress?token=' + encodeURIComponent(w.sceneBase || ''))   // 带超时:与第 128 行探询一致,服务器挂起不卡看护
            .then((p) => {
              if (p && p.active > 0) { startAt = Date.now() + 5000; return; }   // 仍在下载:续期
              clearInterval(sceneWatchdog);
              wallpaperFailed(w, frame ? 'scene-no-frames' : 'scene-timeout');
            })
            .catch(() => { clearInterval(sceneWatchdog); wallpaperFailed(w, frame ? 'scene-no-frames' : 'scene-timeout'); });
        }
      } catch {
        clearInterval(sceneWatchdog);
        wallpaperFailed(w, 'scene-timeout');
      }
    }, 1000);
  }

    // ── 填充方式(源自 DSH objectFit):视频/图片层走 object-fit,场景层走渲染器 fit 参数 ──
  const effFit = () => (state.appearance && state.appearance.fit) || 'cover';
  let mountedFit = null;   // 填充方式变了要重挂当前壁纸(场景层的 fit 在页面加载时读取)

  // ── 画面镜像(源自 DSH flip):舞台整体 scaleX(-1),HUD 不动 ──
  function applyFlip() {
    if ($('stage')) $('stage').style.transform = (state.appearance && state.appearance.flip) ? 'scaleX(-1)' : '';
  }

  // ── 视频倍速(源自 DSH playbackRate):视频层专属,场景/web 不适用 ──
  function applyRate() {
    if (layerKind() !== 'video' || !layer) return;
    try { layer.playbackRate = Math.max(0.5, Math.min(2, Number(state.videoRate) || 1)); } catch (e) {}
  }

  function mountVideo(w) {
    const v = document.createElement('video');
    v.loop = true;
    v.muted = effectiveMuted();
    v.autoplay = true;
    v.playsInline = true;
    v.src = w.mediaUrl;
    v.preload = 'auto';   // 立即开始缓冲,首帧等待更短(metadata 会等播放器自己决定)
    v.style.objectFit = effFit();
    v.className = 'layer-enter';
    v.addEventListener('loadeddata', () => {
      recoveryAttempts = 0;
      applyRate();
      if (onLayerReady) { onLayerReady(); onLayerReady = null; }   // 首帧就绪才上屏
    });
    v.addEventListener('error', () => wallpaperFailed(w, 'video-error'));
    const readyT = setTimeout(() => {
      if (layer === v && v.readyState < 2) wallpaperFailed(w, 'video-load-timeout');
    }, 20000);
    v.addEventListener('loadeddata', () => clearTimeout(readyT), { once: true });
    v.addEventListener('error', () => clearTimeout(readyT), { once: true });
    v.addEventListener('stalled', () => {
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        if (layer === v && v.readyState < 2) wallpaperFailed(w, 'video-stalled');
      }, 8000);
    });
    stage.appendChild(v);
    layer = v;
    v.play().catch(() => {});
    // 帧门控:loadeddata(首帧)时由 onLayerReady 上屏,这里不再立即淡入
    mountedId = w.id;
  }

    function mountImage(w) {
    const img = document.createElement('img');
    img.src = w.mediaUrl;
    img.decoding = 'async';   // 不阻塞主线程解码,大图首帧更顺
    img.style.objectFit = effFit();
    img.className = 'layer-enter';
    img.addEventListener('load', () => { const cb = onLayerReady; onLayerReady = null; if (cb) cb(); });
    stage.appendChild(img);
    layer = img;
    mountedId = w.id;
  }

  function mountWeb(w) {
    // Web 壁纸:严格沙箱 iframe(只给 allow-scripts,工坊 HTML 不得继承宿主身份),
    // 服务器端在 HTML 里注入 /web-shim.js(WE API 兼容层);指针经 postMessage 转发。
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allowtransparency', 'true');
    iframe.src = w.webEntry;
    iframe.className = 'layer-enter';
    stage.appendChild(iframe);
    layer = iframe;
    mountedId = w.id;
    // 指针转发:iframe 是 pointer-events:none,作者脚本的鼠标交互经 postMessage 还原
    webPointerTarget = iframe;
    // 帧门控:iframe load(文档就绪)即上屏 —— web 壁纸加载快,无整包下载问题
    iframe.addEventListener('load', () => {
      const cb = onLayerReady; onLayerReady = null;
      if (cb) cb();
      requestAnimationFrame(() => iframe.classList.add('layer-on'));
      try { iframe.contentWindow.postMessage({ __we: 1, op: 'setFps', n: state.sceneFps || 30 }, '*'); } catch {}
      applyPaused();   // 挂载后立刻同步暂停态(加载前 postMessage 会被丢)
    });
  }

  let webPointerTarget = null;
  function forwardPointer(e) {
    const f = webPointerTarget;
    if (!f || layer !== f) return;
    const r = f.getBoundingClientRect();
    try {
      f.contentWindow.postMessage({
        __we: 1, op: 'pointer',
        x: e.clientX - r.left, y: e.clientY - r.top,
        b: e.buttons || 0, m: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0),
      }, '*');
    } catch {}
  }
  window.addEventListener('mousemove', forwardPointer, { passive: true });
  window.addEventListener('mousedown', forwardPointer, { passive: true });
  window.addEventListener('mouseup', forwardPointer, { passive: true });
  window.addEventListener('mouseout', () => {
    const f = webPointerTarget;
    if (!f || layer !== f) return;
    try { f.contentWindow.postMessage({ __we: 1, op: 'pointerLeave' }, '*'); } catch {}
  }, { passive: true });

  // ── 壁纸滤镜(白名单源自 dsh-wallpaper-engine;场景层走引擎 setFilter,其余层走 CSS)──
  const WALLPAPER_FILTERS = {
    none: '', blur: 'blur(14px)', grayscale: 'grayscale(1)', sepia: 'sepia(0.75)',
    vivid: 'saturate(1.6)', warm: 'sepia(0.35) saturate(1.35) brightness(1.05)',
    cool: 'sepia(0.25) hue-rotate(175deg) saturate(1.3) brightness(1.03)', invert: 'invert(1)',
    brighten: 'brightness(1.3)', darken: 'brightness(0.72)', contrast: 'contrast(1.35)',
  };
  function applyLayerFilter() {
    const id = (state.appearance && state.appearance.filter) || 'none';
    const css = WALLPAPER_FILTERS[id] || '';
    if (!layer) return;
    let handled = false;
    try {
      // 场景层:引擎内建滤镜通道(与渲染管线整合);web 沙箱 iframe 没有 __wp → 走 CSS
      if (layer.tagName === 'IFRAME' && layer.contentWindow && layer.contentWindow.__wp && layer.contentWindow.__wp.setFilter) {
        layer.contentWindow.__wp.setFilter(id);
        handled = true;
      }
    } catch (e) { /* 跨源未就绪:CSS 兜底或下轮轮询再试 */ }
    if (!handled && layer.style) layer.style.filter = css;
  }

  function mountFallback(w) {
    const img = document.createElement('img');
    if (w.preview) img.src = w.preview;
    img.style.objectFit = effFit();
    img.className = 'layer-enter';
    stage.appendChild(img);
    layer = img;
    mountedId = w.id;
    const cb = onLayerReady; onLayerReady = null;
    if (cb) cb();
  }

  function mountCurrent() {
    const w = current();
    if (!w) {                                   // 已关闭:卸载,回深色底
      unmount();
      $('hud-title').textContent = '壁纸已关闭';
      document.title = '动态壁纸';
      return;
    }
    if (w.id === mountedId && effFit() === mountedFit) return;   // 同壁纸且填充方式没变:跳过
    // 恢复重试路径不清零计数(否则 attempt 恒为 1,永远到不了视频/预览降级)
    if (!suppressRecoveryReset) recoveryAttempts = 0;
    suppressRecoveryReset = false;
    mountedFit = effFit();
    clearTimeout(recoveryTimer);
    const ms = state.transition ? (state.transition.ms || 0) : 0;
    // 帧门控(DSH「没画面就不上屏」):旧层先留着,新层首帧就绪才交叉淡化;
    // 各挂载函数在首帧/载荷就绪时调用 onLayerReady()。视频元数据没到/场景包
    // 没下载完之前,用户看的一直是旧壁纸 —— 绝不铺纯色。
    const old = layer;
    layer = null;
    let oldGone = false;
    const dismissOld = () => {
      if (oldGone || !old) return;
      oldGone = true;
      if (ms > 0) {
        old.style.transition = 'opacity ' + ms + 'ms ease';
        old.style.opacity = '0';
        setTimeout(() => { try { old.remove(); } catch {} }, ms + 150);
      } else {
        old.remove();
      }
    };
    onLayerReady = () => {
      if (oldGone) {
        if (layer) { layer.style.zIndex = '1'; layer.style.opacity = '1'; }
        return;
      }
      runTransition(ms, dismissOld);
      applyPaused();
      applyLayerFilter();   // 新层就绪立即应用滤镜(场景层走引擎,其它层走 CSS)
      pushSceneMedia();
      propsKey = "";
      applyProps();
    };
    // 主题秒判三梯:① 作者 schemecolor(扫描时算好的 WCAG 亮度,零加载)→
    // ② 预览图 → ③ 实测帧。上游 theme-follow 口径:作者配色最优先。
    if (w.schemeLum != null) reportLuminance(Math.min(1, w.schemeLum * 1.4));   // 服务器翻转阈值 0.55 ↔ 上游 0.40 的等比映射
    previewLuminance(w);   // 切换瞬间:按预览图亮度立即翻转文字色(实测帧随后精修)
    $('hud-title').textContent = w.title;
    document.title = w.title + ' · 动态壁纸';
    if (w.playable && w.type === 'scene') mountScene(w);
    else if (w.playable && w.type === 'video') mountVideo(w);
    else if (w.playable && w.type === 'image') mountImage(w);
    else if (w.playable && w.type === 'web' && w.webEntry) mountWeb(w);
    else mountFallback(w);
    if (layer) layer.style.zIndex = '1';
    denseSampling();
    applyStageFx();   // 亮度/微调/透明度/暗化随新状态生效
    applyPaused();
    applyRate();
    applyFlip();
  }

  // ── 七种过场动画(源自 dsh-wallpaper-engine;type/时长走白名单)──
  function runTransition(ms, dismissOld) {
    const tr = state.transition || {};
    const kind = ms > 0 ? (tr.kind || "crossfade") : "none";
    const dir = tr.dir || "left";   // 新层进入方向(上游 switchTransitionDir 口径:左=从右滑入)
    const newL = layer;
    if (!newL) return;
    const ease = "cubic-bezier(.4,0,.2,1)";
    const finish = () => { dismissOld(); newL.style.zIndex = "1"; newL.style.opacity = "1"; newL.style.clipPath = "none"; newL.style.maskImage = "none"; newL.style.webkitMaskImage = "none"; newL.style.transform = "none"; applyPaused(); pushSceneMedia(); };
    const anim = (frames, opts) => { try { return newL.animate(frames, Object.assign({ duration: ms, easing: ease, fill: "forwards" }, opts || {})); } catch (e) { return null; } };
    switch (kind) {
      case "push": {
        newL.style.zIndex = "2";
        const inT = { left: "translate3d(100%,0,0)", right: "translate3d(-100%,0,0)", up: "translate3d(0,100%,0)", down: "translate3d(0,-100%,0)" }[dir] || "translate3d(100%,0,0)";
        const outT = { left: "translate3d(-28%,0,0)", right: "translate3d(28%,0,0)", up: "translate3d(0,-28%,0)", down: "translate3d(0,28%,0)" }[dir] || "translate3d(-28%,0,0)";
        try { newL.animate([{ transform: inT }, { transform: "translate3d(0,0,0)" }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
        if (old) { try { old.style.zIndex = "1"; old.animate([{ transform: "translate3d(0,0,0)", opacity: 1 }, { transform: outT, opacity: 0.6 }], { duration: ms, easing: ease, fill: "forwards" }); } catch {} }
        setTimeout(() => { dismissOld(); newL.style.transform = "none"; newL.style.zIndex = "1"; applyPaused(); pushSceneMedia(); }, ms + 60);
        return;
      }
      case "wipe": {
        // 揭示从新层的进入缘开始:左=从右缘向左展开,右=从左缘向右,上=从下缘向上,下=从上缘向下
        newL.style.zIndex = "2";
        const inC = { left: "inset(0 0 0 100%)", right: "inset(0 100% 0 0)", up: "inset(100% 0 0 0)", down: "inset(0 0 100% 0)" }[dir] || "inset(0 0 0 100%)";
        try { newL.animate([{ clipPath: inC }, { clipPath: "inset(0 0 0 0)" }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
        setTimeout(() => { dismissOld(); newL.style.clipPath = "none"; newL.style.zIndex = "1"; applyPaused(); pushSceneMedia(); }, ms + 60);
        return;
      }
      case "iris": {
        newL.style.zIndex = "2";
        try { newL.animate([{ clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)" }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
        setTimeout(() => { dismissOld(); newL.style.clipPath = "none"; newL.style.zIndex = "1"; applyPaused(); pushSceneMedia(); }, ms + 60);
        return;
      }
      case "zoom": {
        try { newL.animate([{ transform: "scale(1.14)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
        if (old) { try { old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: ease, fill: "forwards" }); } catch {} }
        setTimeout(() => { dismissOld(); newL.style.transform = "none"; newL.style.opacity = "1"; newL.style.zIndex = "1"; applyPaused(); pushSceneMedia(); }, ms + 60);
        return;
      }
      case "blinds": {
        newL.style.zIndex = "2";
        const mask = "repeating-linear-gradient(180deg, #000 0, #000 var(--blindp), transparent var(--blindp), transparent 25%)";
        newL.style.maskImage = mask; newL.style.webkitMaskImage = mask;
        try { newL.animate([{ "--blindp": "0%" }, { "--blindp": "25%" }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
        setTimeout(() => { dismissOld(); newL.style.maskImage = "none"; newL.style.webkitMaskImage = "none"; newL.style.zIndex = "1"; applyPaused(); pushSceneMedia(); }, ms + 60);
        return;
      }
      default: {   // crossfade
        dismissOld();
        if (ms > 0) {
          newL.style.transition = "opacity " + ms + "ms ease";
          newL.style.opacity = "0";
          requestAnimationFrame(() => { if (newL) newL.style.opacity = "1"; });
        } else { newL.style.opacity = "1"; }
        newL.style.zIndex = "1";
        applyPaused();
        pushSceneMedia();
      }
    }
  }

  // ── 控制下发 ───────────────────────────────────────────────
  const effectiveMuted = () => state.volume <= 0;
  const layerKind = () => {
    if (!layer) return null;
    if (layer.tagName === 'VIDEO') return 'video';
    if (layer.tagName === 'IMG') return 'image';
    return webPointerTarget === layer ? 'web' : 'scene';
  };
  function shimSend(op, extra) {
    // Web 壁纸(sandbox iframe,跨源)控制:经 postMessage 落到 shim 控制通道
    try { layer.contentWindow.postMessage(Object.assign({ __we: 1, op: op }, extra || {}), '*'); } catch {}
  }

  // 电池状态(源自 DSH pauseOnBattery):getBattery 不可用(台式机/部分环境)时
  // 静默不触发 —— 开关等于不存在,不会报错。
  var battery = null;
  try {
    if (typeof navigator.getBattery === 'function') {
      navigator.getBattery().then(function (bm) {
        battery = bm;
        bm.addEventListener('chargingchange', function () { applyPaused(); });
        applyPaused();   // 初始化时就在电池上:立即暂停
      }).catch(function () {});
    }
  } catch (e) {}

  function applyPaused() {
    if (!layer || !current() || current().id !== mountedId) return;
    // 遮挡暂停三档:never=仅手动;hidden=切走/最小化;focus=失焦即停(省电)
    var occluded = state.occlusion === 'hidden' ? document.hidden
      : state.occlusion === 'focus' ? (document.hidden || !document.hasFocus())
      : false;
    // 电池省电(DSH pauseOnBattery):用电池且未充电时自动暂停
    var onBattery = state.batteryPause && battery && battery.charging === false;
    const paused = state.paused || occluded || onBattery;
    const kind = layerKind();
    try {
      if (kind === 'scene') {
        const wp = layer.contentWindow && layer.contentWindow.__wp;
        if (wp) (paused ? wp.pause() : wp.resume());
      } else if (kind === 'video') {
        if (paused) layer.pause();
        else layer.play().catch(() => {});
      } else if (kind === 'web') {
        shimSend('setPaused', { v: paused });
      }
    } catch {}
    $('btn-pause').textContent = state.paused ? '▶' : '⏸';
  }

  function applyVolume() {
    const muted = effectiveMuted();
    const kind = layerKind();
    try {
      if (kind === 'scene') {
        const wp = layer.contentWindow && layer.contentWindow.__wp;
        if (wp && wp.setVolume) wp.setVolume(muted ? 0 : state.volume);
      } else if (kind === 'video') {
        layer.muted = muted;
        layer.volume = Math.max(0.01, state.volume);
      } else if (kind === 'web') {
        shimSend('setVolume', { v: muted ? 0 : state.volume });
      }
    } catch {}
    $('btn-mute').textContent = muted ? '🔇' : '🔊';
  }

  function applyRotate() {
    $('btn-rotate').classList.toggle('hbtn--active', !!state.rotate.enabled);
  }

  // ── 画面微调三旋钮 + 亮度 + 壁纸透明度 + 暗化层(源自 dsh-wallpaper-engine
  //    background 三旋钮 / wallpaperOpacity / scrim)────────────────────────────
  // 全部作用在 #stage(壁纸层容器)上:与层内过渡(opacity 动画)相乘不打架,
  // 播放页与嵌入页都走 player.js,不会出现 embed.css 双重叠加。
  // scrim 是壁纸上方的黑色罩(层级 5:盖住壁纸 1-2,让位 HUD 10 / 面板 20)。
  let scrimEl = document.getElementById('we-scrim');
  if (!scrimEl) {
    scrimEl = document.createElement('div');
    scrimEl.id = 'we-scrim';
    scrimEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;background:transparent;';
    document.body.appendChild(scrimEl);
  }
  function applyStageFx() {
    const a = state.appearance || {};
    const f = [];
    if (Number(a.brightness) !== 100 && Number.isFinite(Number(a.brightness))) f.push('brightness(' + a.brightness + '%)');
    if (Number(a.bgBrightness) !== 100 && Number.isFinite(Number(a.bgBrightness))) f.push('brightness(' + a.bgBrightness + '%)');
    if (Number(a.bgContrast) !== 100 && Number.isFinite(Number(a.bgContrast))) f.push('contrast(' + a.bgContrast + '%)');
    if (Number(a.bgSaturate) !== 100 && Number.isFinite(Number(a.bgSaturate))) f.push('saturate(' + a.bgSaturate + '%)');
    if (stage) stage.style.filter = f.join(' ');
    if (stage) stage.style.opacity = (Number(a.opacity) < 100 && Number.isFinite(Number(a.opacity))) ? String(Math.max(0.1, a.opacity / 100)) : '';
    if (scrimEl) scrimEl.style.background = (Number(a.scrim) > 0 && Number.isFinite(Number(a.scrim))) ? 'rgba(0,0,0,' + (a.scrim / 100).toFixed(3) + ')' : 'transparent';
  }

  // ── 亮度采样(智能可读性):视频帧/场景抓帧 → 平均亮度 → 上报服务器 ──
  var lumCanvas = document.createElement('canvas');
  lumCanvas.width = 64; lumCanvas.height = 36;
  function reportLuminance(v) {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 5000);
    fetch('/api/luminance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: v }), signal: ctrl.signal })
      .catch(function () {}).finally(() => clearTimeout(kill));
  }
  function luminanceFromImage(img) {
    try {
      var ctx = lumCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 64, 36);
      var d = ctx.getImageData(0, 0, 64, 36).data;
      var sum = 0, opaque = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) opaque++;
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      if (opaque === 0) return;   // 全透明帧(未解码的空画布):不计,避免亮度被误判为纯黑
      reportLuminance(sum / (d.length / 4) / 255);
    } catch (e) {}
  }
  function sampleLuminance() {
    try {
      if (!layer || state.paused) return;
      if (layer.tagName === 'VIDEO') {
        if (layer.readyState >= 2) luminanceFromImage(layer);   // 未出首帧不采样(空画布=假黑)
        return;
      }
      if (layer.tagName === 'IFRAME') {
        var win = layer.contentWindow;
        var st = win && win.__wpStats;
        var fr = st && typeof st.frame === 'function' ? st.frame() : null;
        if (!fr || !fr.running || fr.fps <= 0) return;   // 场景未出帧不采样
        var wp = win.__wp;
        if (wp && typeof wp.capture === 'function') {
          var url = wp.capture();
          if (url) { var im = new Image(); im.onload = function () { luminanceFromImage(im); }; im.src = url; }
        }
      }
    } catch (e) {}
  }
  setInterval(function () { if (!document.hidden) sampleLuminance(); }, 5000);   // 隐藏时视频已暂停,抓帧无意义白耗 CPU
  // 预览图采样:切换瞬间即时给出正确亮度(实时帧采样随后精修)
  let lastPreviewId = null;
  function previewLuminance(w) {
    try {
      if (!w || !w.preview || lastPreviewId === w.id) return;
      lastPreviewId = w.id;
      const im = new Image();
      im.onload = function () { luminanceFromImage(im); };
      im.src = w.preview;
    } catch (e) {}
  }
  // 切换后 8s 内每 1s 加密采样(新壁纸首帧亮度可能渐变),之后回到 5s
  function denseSampling() {
    let n = 0;
    const iv = setInterval(function () { sampleLuminance(); if (++n >= 8) clearInterval(iv); }, 1000);
  }

  // ── Now Playing + 在线歌词跑马灯(lrclib.net,与 DSH 同源;默认关闭)───────
  let lyricsBox = null;
  if (EMBED) {
    lyricsBox = document.createElement('div');
    lyricsBox.style.cssText = 'position:fixed;left:0;right:0;bottom:9vh;text-align:center;z-index:6;pointer-events:none;'
      + 'font-size:20px;font-weight:600;letter-spacing:.5px;color:#fff;opacity:.88;'
      + 'text-shadow:0 2px 8px rgba(0,0,0,.85),0 0 24px rgba(0,0,0,.5);transition:opacity .6s ease;font-family:"Segoe UI",system-ui,sans-serif;';
    lyricsBox.textContent = '';
    document.body.appendChild(lyricsBox);
  }
  let nowPlaying = null;
  let npKey = '';
  let lrcLines = [];          // [{t:秒, text}]
  function parseLrc(lrc) {
    const out = [];
    for (const line of String(lrc).split('\n')) {
      const m = line.match(/^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/);
      if (!m) continue;
      const text = m[2].trim();
      for (const t of m[1].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) {
        out.push({ t: Number(t[1]) * 60 + Number(t[2]), text });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function lyricAt(pos) {
    let cur = '';
    for (const l of lrcLines) { if (l.t <= pos + 0.2) { if (l.text) cur = l.text; } else break; }
    return cur;
  }
  function sceneMediaWire(np) {
    // WebWallGL setMedia wire 协议(逆向自 vendored renderer):hasMedia/title/artist/
    // album/position/duration/playing + lyrics(渲染器按 position 自动算当前句)
    const has = !!(np && np.available && np.title);
    return {
      hasMedia: has,
      title: has ? np.title : '',
      artist: has ? (np.artist || '') : '',
      album: has ? (np.album || '') : '',
      position: has ? (np.position || 0) : 0,
      duration: has ? (np.duration || 0) : 0,
      playing: has && np.status === 'playing',
      lyrics: state.lyrics && lrcLines.length ? lrcLines : undefined,
    };
  }
  function pushSceneMedia() {
    if (layerKind() === "scene") {
      try {
        const wp = layer.contentWindow && layer.contentWindow.__wp;
        if (wp && typeof wp.setMediaControl === "function" && !wp.__weCtl) {
          wp.__weCtl = true;   // 只挂一次
          wp.setMediaControl({
            play: function () { api("/api/mediakey", { action: "playpause" }).catch(function () {}); },
            pause: function () { api("/api/mediakey", { action: "playpause" }).catch(function () {}); },
            playPause: function () { api("/api/mediakey", { action: "playpause" }).catch(function () {}); },
            skipNext: function () { api("/api/mediakey", { action: "next" }).catch(function () {}); },
            skipPrevious: function () { api("/api/mediakey", { action: "prev" }).catch(function () {}); },
          });
        }
      } catch {}
    }
    try {
      const wp2 = layer && layer.contentWindow && layer.contentWindow.__wp;
      if (wp2 && typeof wp2.setMedia === "function") wp2.setMedia(sceneMediaWire(nowPlaying));
    } catch {}
  }
  async function refreshNowPlaying() {
    if (!EMBED) return;
    try {
      const np = await api('/api/nowplaying');
      nowPlaying = np;
      if (!np || !np.available || !np.title) { if (lyricsBox) lyricsBox.textContent = ''; npKey = ''; pushSceneMedia(); return; }
      const key = np.title + '|' + np.artist;
      if (key !== npKey) {
        npKey = key;
        lrcLines = [];
        if (state.lyrics) {
          const r = await api('/api/lyrics?title=' + encodeURIComponent(np.title) + '&artist=' + encodeURIComponent(np.artist || ''));
          lrcLines = r && r.synced ? parseLrc(r.synced) : [];
        }
      }
      pushSceneMedia();
      // 歌词行按 SMTC 时间轴位置取当前句
      if (lyricsBox) {
        if (!state.lyrics || !lrcLines.length) { lyricsBox.textContent = ''; return; }
        const line = lyricAt((np.position || 0) + 0.3);
        if (lyricsBox.textContent !== line) lyricsBox.textContent = line;
      }
    } catch {}
  }
  setInterval(refreshNowPlaying, 2000);

  // ── 壁纸属性(工作台属性面板写入 project.json,这里拉取并实时应用)──
  let propsKey = "";
  function applyProps() {
    const w = current();
    if (!w || !layer || mountedId !== w.id) return;
    const kind = layerKind();
    if (kind !== "scene" && kind !== "web") return;
    api("/api/props/" + w.id).then(function (r) {
      const list = r.props || [];
      if (!list.length) { propsKey = JSON.stringify([]); return; }   // 无属性:不推送空对象
      const props = {};
      for (const p of list) props[p.name] = { value: p.value };
      const key = JSON.stringify(props);
      if (key === propsKey) return;
      propsKey = key;
      try {
        if (kind === "scene") {
          const wp = layer.contentWindow && layer.contentWindow.__wp;
          if (wp && typeof wp.updateWebProps === "function") wp.updateWebProps(props);
        } else {
          shimSend("applyProps", { props: props });
        }
      } catch {}
    }).catch(function () {});
  }
  setInterval(applyProps, 8000);

  // ── 滚轮转发(Web 壁纸;pointer-events:none 时作者脚本收不到,经 postMessage 还原)──
  window.addEventListener("wheel", function (e) {
    const f = webPointerTarget;
    if (!f || layer !== f) return;
    const r = f.getBoundingClientRect();
    try { f.contentWindow.postMessage({ __we: 1, op: "wheel", x: e.clientX - r.left, y: e.clientY - r.top,
      dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, mods: (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.shiftKey?4:0) }, "*"); } catch {}
  }, { passive: true });

  // ── 轮询(服务器是单真源,skill 的改动会即时生效)──────────────
  let pollBusy = false;
  async function poll() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const prev = JSON.stringify(state);
      state = await api('/api/state');
      // 亮度采样每 5s 变一次,剔除后对比,避免无意义的控制下发
      const cur = Object.assign({}, state, { luminance: undefined });
      const prevClean = Object.assign({}, JSON.parse(prev), { luminance: undefined });
      if (JSON.stringify(cur) !== JSON.stringify(prevClean)) {
        mountCurrent();
        applyPaused();
        applyVolume();
        applyRate();
        applyFlip();
        applyRotate();
        applyStageFx();       // 外观(微调/透明度/暗化)变化即时生效
        applyLayerFilter();   // 外观(滤镜档)变化即时生效
      }
    } catch {} // 服务器暂离:保持当前画面
    pollBusy = false;
  }
  setInterval(poll, 2000);
  // 注入代码版本自检:服务器上的播放器代码更新后,壁纸层自刷新(用户无需操作)
  if (EMBED) {
    let myVersion = null;
    setInterval(function () {
      fetch('/api/version', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
        if (myVersion === null) { myVersion = v.v; return; }
        if (v.v !== myVersion) location.reload();   // 代码有更新:自刷新
      }).catch(function () {});
    }, 5000);
  }
  let inventoryBusy = false;
  async function refreshInventory() {
    if (inventoryBusy) return;
    inventoryBusy = true;
    try {
      const inv = await api('/api/wallpapers');
      const next = inv.wallpapers || [];
      const oldKey = wallpapers.map((w) => w.id + ':' + w.title + ':' + w.playable).join('|');
      const newKey = next.map((w) => w.id + ':' + w.title + ':' + w.playable).join('|');
      if (oldKey !== newKey) { wallpapers = next; renderList(); }
    } catch {}
    inventoryBusy = false;
  }
  setInterval(refreshInventory, 5000);

  // ── HUD 交互 ───────────────────────────────────────────────
  function pokeHud() {
    if (EMBED) return;
    $('hud').classList.remove('hud--hidden');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => $('hud').classList.add('hud--hidden'), 3000);
  }
  if (!EMBED) {
    ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((ev) =>
      window.addEventListener(ev, pokeHud, { passive: true }));
  }

  async function togglePause() {
    state = await api('/api/pause', { paused: !state.paused });
    applyPaused();
  }
  async function toggleMute() {
    sawGesture = true;
    state = await api('/api/volume', { volume: state.volume > 0 ? 0 : 1 });
    applyVolume();
  }
  async function toggleRotate() {
    state = await api('/api/rotate', { enabled: !state.rotate.enabled });
    applyRotate();
  }

  $('btn-pause').onclick = togglePause;
  $('btn-mute').onclick = toggleMute;
  $('btn-rotate').onclick = toggleRotate;
  $('btn-full').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  $('btn-list').onclick = () => $('panel').classList.toggle('panel--hidden');
  $('panel-close').onclick = () => $('panel').classList.add('panel--hidden');

  window.addEventListener('keydown', (e) => {
    if (EMBED) return; // 背景层绝不抢聊天窗口的键盘事件
    sawGesture = true;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'm' || e.key === 'M') toggleMute();
    else if (e.key === 'f' || e.key === 'F') $('btn-full').onclick();
    else if (e.key === 'l' || e.key === 'L') $('panel').classList.toggle('panel--hidden');
    else if (e.key === 'Escape') $('panel').classList.add('panel--hidden');
  });

  document.addEventListener('visibilitychange', applyPaused);

  // ── 列表 ───────────────────────────────────────────────────
  function renderList() {
    const box = $('panel-list');
    box.innerHTML = '';
    for (const w of wallpapers) {
      const item = document.createElement('div');
      item.className = 'wp-item' + (w.id === state.currentId ? ' wp-item--current' : '')
        + (w.playable ? '' : ' wp-item--unplayable');
      const thumb = document.createElement('img');
      thumb.className = 'wp-item__thumb';
      thumb.loading = 'lazy';
      thumb.src = w.preview || '';
      const meta = document.createElement('div');
      meta.className = 'wp-item__meta';
      const name = document.createElement('div');
      name.className = 'wp-item__name';
      name.textContent = w.title;
      const sub = document.createElement('div');
      sub.className = 'wp-item__sub';
      sub.innerHTML = (w.type === 'scene' ? '场景' : w.type === 'video' ? '视频' : w.type) +
        (w.playable ? ' <span class="wp-item__badge">' + (w.hasPkg ? 'WebGL' : 'MP4') + '</span>' : ' <span class="wp-item__badge">不可播</span>');
      meta.append(name, sub);
      item.append(thumb, meta);
      if (w.playable) item.onclick = async () => { sawGesture = true; state = await api('/api/select', { id: w.id }); mountCurrent(); renderList(); };
      box.appendChild(item);
    }
  }

  // ── 启动 ───────────────────────────────────────────────────
  (async () => {
    const inv = await api('/api/wallpapers');
    wallpapers = inv.wallpapers;
    state = inv.state;
    // 未选过 → 默认第一张可播放的
    if (!state.currentId || !current() || !current().playable) {
      const first = wallpapers.find((w) => w.playable);
      if (first) { state = await api('/api/select', { id: first.id }); }
    }
    renderList();
    applyRotate();
    mountCurrent();
    if (EMBED) {
      document.body.classList.add('embed');
      notifyParentReady();
      setTimeout(notifyParentReady, 1000);
    } else {
      pokeHud();
    }
  })();
})();
