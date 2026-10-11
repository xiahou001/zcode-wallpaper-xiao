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

  const api = (path, body) => fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined).then((r) => r.json());
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
      unmount();
      const v = document.createElement('video');
      v.loop = true; v.muted = effectiveMuted(); v.autoplay = true; v.playsInline = true;
      v.src = '/scene-video/' + encodeURIComponent(w.id); v.className = 'layer-enter';
      v.addEventListener('loadeddata', () => { recoveryAttempts = 0; v.classList.add('layer-on'); const cb = onLayerReady; onLayerReady = null; if (cb) cb(); });
      v.addEventListener('error', () => { unmount(); if (w.preview) { mountFallback(w); $('hud-title').textContent = w.title + '（预览图）'; } });
      stage.appendChild(v); layer = v; mountedId = w.id; v.play().catch(() => {});
      $('hud-title').textContent = w.title + '（视频降级）';
    } else if (w.preview) {
      unmount();
      mountFallback(w);
      $('hud-title').textContent = w.title + '（预览图）';
    }
  }

  function mountScene(w) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.setAttribute('allowtransparency', 'true');
    const muted = effectiveMuted();
    const fps = state.sceneFps || 30;
    const src = '/wallpaper-engine/scene-live/index.html'
      + '?type=scene&fit=cover&sceneFps=' + fps
      + '&muted=' + (muted ? 'true' : 'false')
      + '&src=' + encodeURIComponent(w.sceneBase)
      + '&mediaBase=' + encodeURIComponent(location.origin + '/scene-files');
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
      fetch('/api/scene-progress?token=' + encodeURIComponent(w.sceneBase || ''), { cache: 'no-store' })
        .then(function (p) {
          if (p && p.active > 0) { startAt = Date.now(); return; }   // 载荷仍在传输:顺延预算
          if (p && p.served && Date.now() - startAt > budgetMs) { clearInterval(sceneWatchdog); wallpaperFailed(w, 'scene-no-frames'); }
        }).catch(function () {});
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
          const cb = onLayerReady; onLayerReady = null;
          if (cb) cb();              // 首帧就绪:淡出旧壁纸,淡入场景
          pushSceneMedia();          // 就绪即推送 Now Playing(媒体响应型壁纸)
          return;                    // 正常渲染中
        }
        // 区分「还在下载」与「出不了帧」(DSH 同款):载荷在传输则顺延预算
        if (Date.now() - startAt > budgetMs) {
          fetch('/api/scene-progress?token=' + encodeURIComponent(w.sceneBase || ''), { cache: 'no-store' })
            .then((r) => r.json())
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

  function mountVideo(w) {
    const v = document.createElement('video');
    v.loop = true;
    v.muted = effectiveMuted();
    v.autoplay = true;
    v.playsInline = true;
    v.src = w.mediaUrl;
    v.className = 'layer-enter';
    v.addEventListener('loadeddata', () => {
      recoveryAttempts = 0;
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

  function mountFallback(w) {
    const img = document.createElement('img');
    if (w.preview) img.src = w.preview;
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
    if (w.id === mountedId) return;
    // 恢复重试路径不清零计数(否则 attempt 恒为 1,永远到不了视频/预览降级)
    if (!suppressRecoveryReset) recoveryAttempts = 0;
    suppressRecoveryReset = false;
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
      pushSceneMedia();
      propsKey = "";
      applyProps();
    };
    previewLuminance(w);   // 切换瞬间:按预览图亮度立即翻转文字色(实测帧随后精修)
    $('hud-title').textContent = w.title;
    document.title = w.title + ' · 动态壁纸';
    document.title = w.title + ' · 动态壁纸';
    if (w.playable && w.type === 'scene') mountScene(w);
    else if (w.playable && w.type === 'video') mountVideo(w);
    else if (w.playable && w.type === 'image') mountImage(w);
    else if (w.playable && w.type === 'web' && w.webEntry) mountWeb(w);
    else mountFallback(w);
    if (layer) layer.style.zIndex = '1';
    denseSampling();
    applyPaused();
  }

  // ── 七种过场动画(源自 dsh-wallpaper-engine;type/时长走白名单)──
  function runTransition(ms, dismissOld) {
    const tr = state.transition || {};
    const kind = ms > 0 ? (tr.kind || "crossfade") : "none";
    const newL = layer;
    if (!newL) return;
    const ease = "cubic-bezier(.4,0,.2,1)";
    const finish = () => { dismissOld(); newL.style.zIndex = "1"; newL.style.opacity = "1"; newL.style.clipPath = "none"; newL.style.maskImage = "none"; newL.style.webkitMaskImage = "none"; newL.style.transform = "none"; applyPaused(); pushSceneMedia(); };
    const anim = (frames, opts) => { try { return newL.animate(frames, Object.assign({ duration: ms, easing: ease, fill: "forwards" }, opts || {})); } catch (e) { return null; } };
    const oldFade = () => { if (!dismissOld) return; };
    switch (kind) {
      case "push": {
        newL.style.zIndex = "2";
        try { newL.animate([{ transform: "translateX(100%)" }, { transform: "translateX(0%)" }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
        if (old) { try { old.style.zIndex = "1"; old.animate([{ transform: "translateX(0%)", opacity: 1 }, { transform: "translateX(-28%)", opacity: 0.6 }], { duration: ms, easing: ease, fill: "forwards" }); } catch {} }
        setTimeout(() => { dismissOld(); newL.style.transform = "none"; newL.style.zIndex = "1"; applyPaused(); pushSceneMedia(); }, ms + 60);
        return;
      }
      case "wipe": {
        newL.style.zIndex = "2";
        try { newL.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }], { duration: ms, easing: ease, fill: "forwards" }); } catch {}
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

  function applyPaused() {
    if (!layer || !current() || current().id !== mountedId) return;
    // 遮挡暂停三档:never=仅手动;hidden=切走/最小化;focus=失焦即停(省电)
    var occluded = state.occlusion === 'hidden' ? document.hidden
      : state.occlusion === 'focus' ? (document.hidden || !document.hasFocus())
      : false;
    const paused = state.paused || occluded;
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

  // ── 亮度采样(智能可读性):视频帧/场景抓帧 → 平均亮度 → 上报服务器 ──
  var lumCanvas = document.createElement('canvas');
  lumCanvas.width = 64; lumCanvas.height = 36;
  function reportLuminance(v) {
    fetch('/api/luminance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: v }) }).catch(function () {});
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
  setInterval(sampleLuminance, 5000);
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
    lyricsBox.style.cssText = 'position:fixed;left:0;right:0;bottom:9vh;text-align:center;z-index:2;pointer-events:none;'
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
        applyRotate();
      }
    } catch {} // 服务器暂离:保持当前画面
    pollBusy = false;
  }
  setInterval(poll, 2000);
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
