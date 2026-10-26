/**
 * embed.js — 注入进 ZCode 聊天窗口的壁纸层逻辑(经 /embed.js 加载)。
 *
 * 职责:
 *   1. 挂 pointer-events:none 的 iframe 壁纸层 + 服务器探活重试;
 *   2. 热更新样式:每 5s 拉 embed.css,变了立即应用 —— 服务器上改样式,
 *      用户窗口 5 秒内自动生效,永远不需要刷新/重启客户端;
 *   3. DOM 诊断每 60s 上报(data-slot 普查 + 大面积表面),驱动行级玻璃精调。
 */
(function () {
  var BASE = 'http://127.0.0.1:7396';

  // ── 热更新样式 ──────────────────────────────────────────────
  var styleEl = null;
  var lastCss = '';
  // fetch 超时:挂起的请求会让 busy 锁永远不放,样式/版本热更新从此失灵
  function fetchTO(path, ms) {
    var ctrl = new AbortController();
    var kill = setTimeout(function () { ctrl.abort(); }, ms || 5000);
    return fetch(path, { cache: 'no-store', signal: ctrl.signal }).finally(function () { clearTimeout(kill); });
  }
  function refreshCss() {
    fetchTO(BASE + '/embed.css')
      .then(function (r) { return r.text(); })
      .then(function (t) {
        if (t === lastCss) return;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'we-wp-style-dyn';
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = t;
        lastCss = t;
      })
      .catch(function () {});
  }

  // 版本探针:只取一个数字,比整份 CSS 便宜得多。
  // 用来把"在工作台换颜色"的等待从 5 秒压到 ~0.4 秒(工作台还会直接推消息,见下)。
  // 自调度轮询:改过样式后 400ms 热路径;连续 30 次(约 12s)无变化退到 1.2s,
  // 有变化或工作台推送立刻回热路径 —— 稳定状态下省一大半请求,也让出启动期。
  var lastVersion = -1;
  var versionBusy = false;
  var pollStreak = 0;
  function pollVersion() {
    if (versionBusy || document.hidden) return;   // 窗口隐藏时跳过,省 CPU 与请求
    versionBusy = true;
    // /api/style-version(样式热更新);/api/version 是代码指纹,语义不同,勿混用
    fetchTO(BASE + '/api/style-version')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var v = d && d.v;
        var changed = lastVersion !== -1 && v !== lastVersion;
        lastVersion = v;
        if (changed) { pollStreak = 0; refreshCss(); } else { pollStreak += 1; }
      })
      .catch(function () {})
      .then(function () { versionBusy = false; });
  }
  function pollLoop() {
    setTimeout(function () { pollVersion(); pollLoop(); }, pollStreak > 30 ? 1200 : 400);
  }

  // ── 壁纸 iframe ────────────────────────────────────────────
  var frame = null;
  var frameLoaded = false;
  var frameReady = false;
  var frameStartedAt = 0;
  var serverWasDown = true;
  var healthTimer = 0;
  var retryTimer = 0;
  var reloadCount = 0;   // 连续握手失败重载计数(上限 3,防损坏壁纸的整包重下载黑洞)
  function showFrame() {
    if (!frame) return;
    frame.style.display = 'block';
    frame.style.visibility = 'visible';
  }
  function reloadFrame() {
    if (!frame) return;
    frameLoaded = false;
    frameReady = false;
    frameStartedAt = Date.now();
    showFrame();
    frame.src = BASE + '/?embed=1&recover=' + Date.now();
  }
  function checkServer() {
    // 探活用极轻的 style-version 探针(旧实现取整份 /api/state,纯浪费);
    // 4s 一次 × 多窗口,省下的带宽让首屏内容更快回来。
    fetchTO(BASE + '/api/style-version?health=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('server ' + r.status);
        return r.json();
      })
      .then(function () {
        var wasDown = serverWasDown;
        serverWasDown = false;
        showFrame();
        // 握手过期重载带上限:损坏的壁纸连续重载 3 次后停手(每次重载都是整包
        // 重下载,无限重载=带宽黑洞);服务器重启或窗口重新可见时清零重试。
        var handshakeExpired = frameStartedAt && Date.now() - frameStartedAt > 8000;
        if (wasDown || !frameLoaded || (handshakeExpired && !frameReady && reloadCount < 3)) {
          reloadCount += 1;
          reloadFrame();
        }
      })
      .catch(function () {
        serverWasDown = true;
        reloadCount = 0;   // 服务器重启过:重载预算重新发
        if (frame) { frameLoaded = false; frame.style.display = 'block'; }
        clearTimeout(retryTimer);
        retryTimer = setTimeout(checkServer, 2000);
      });
  }
  function mount() {
    frame = document.getElementById('we-wp-layer');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'we-wp-layer';
      frame.setAttribute('allow', 'autoplay');
      frame.setAttribute('allowtransparency', 'true');
      frame.setAttribute('title', 'wallpaper');
      frame.style.cssText = 'display:block!important;visibility:visible!important;position:fixed;inset:0;width:100%;height:100%;border:0;z-index:0;pointer-events:none;background:transparent;';
      document.body.insertBefore(frame, document.body.firstChild);
    }
    frame.addEventListener('load', function () { frameLoaded = true; showFrame(); });
    frame.addEventListener('error', function () { frameLoaded = false; frameReady = false; clearTimeout(retryTimer); retryTimer = setTimeout(checkServer, 2000); });
    showFrame();
    frameStartedAt = Date.now();
    checkServer();
    clearInterval(healthTimer);
    healthTimer = setInterval(checkServer, 4000);
  }

  window.addEventListener('message', function (event) {
    // 工作台改了外观 → 直接推消息,立即重取样式(无需等轮询)
    if (event.data === 'we-wp-appearance') { pollStreak = 0; refreshCss(); return; }
    if (!frame || event.source !== frame.contentWindow || event.origin !== BASE) return;
    if (event.data && event.data.source === 'we-wallpaper' && event.data.type === 'ready') {
      frameReady = true;
      reloadCount = 0;   // 播放页成功握手:重载预算重置
      showFrame();
    }
  });

  // ── DOM 抓取:找出输入框位置上的元素链,以及谁在画不透明背景 ──────────
  function dumpComposerRegion() {
    try {
      var y = Math.round(innerHeight * 0.925);
      var el = document.elementFromPoint(Math.round(innerWidth / 2), y);
      if (!el) return;
      var chain = [];
      for (var i = 0; el && i < 16; i++, el = el.parentElement) {
        var cs = getComputedStyle(el);
        var r = el.getBoundingClientRect();
        chain.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 130),
          testid: el.getAttribute ? el.getAttribute('data-testid') : null,
          bg: cs.backgroundColor,
          bgImg: cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 80) : null,
          bd: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : null,
          filter: cs.filter && cs.filter !== 'none' ? cs.filter : null,
          opacity: cs.opacity !== '1' ? cs.opacity : null,
          transform: cs.transform && cs.transform !== 'none' ? cs.transform.slice(0, 36) : null,
          radius: cs.borderTopLeftRadius,
          rect: Math.round(r.width) + 'x' + Math.round(r.height),
        });
      }
      fetch(BASE + '/api/client-diag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'composer-dom', vy: y, top: chain[0] && chain[0].tag, chain: chain }),
      }).catch(function () {});
    } catch (e) {}
  }

  // ── 诊断上报 ───────────────────────────────────────────────
  function diag() {
    if (document.hidden) return;   // 隐藏时做全页 querySelectorAll+getComputedStyle 是纯浪费(强制布局)
    try {
      var f = document.getElementById('we-wp-layer');
      var info = {
        href: String(location.href).slice(0, 120),
        title: document.title,
        iframe: !!f,
        iframeDisplay: f ? getComputedStyle(f).display : null,
        iframeRect: f ? (function (r) { return Math.round(r.width) + 'x' + Math.round(r.height); })(f.getBoundingClientRect()) : null,
        bigSurfaces: [],
        // 壁纸层实况:聊天窗口里挂载的壁纸(类型/透明度/播放进度)
        wallpaper: (function () {
          try {
            var f = document.getElementById("we-wp-layer");
            if (!f || !f.contentWindow) return { has: false };
            var w = f.contentWindow;
            var v = w.document.querySelector("#stage video");
            var fr = f.contentDocument.querySelector("#stage iframe");
            var im = f.contentDocument.querySelector("#stage img");
            var out = { has: true, layers: [] };
            if (v) out.layers.push("video ready=" + v.readyState + " " + (v.paused ? "paused" : "playing") + " t=" + Math.round(v.currentTime * 10) / 10);
            if (fr) out.layers.push("iframe(scene) " + (function () { try { var s = fr.contentWindow.__wpStats; return s && s.frame ? "fps=" + Math.round(s.frame().fps) : "?"; } catch (e) { return "cross"; } })());
            if (im) out.layers.push("img");
            if (!out.layers.length) out.layers.push("(empty)");
            return out;
          } catch (e) { return { err: String(e).slice(0, 80) }; }
        })(),        bottomSurfaces: (function () {
          try {
            var out = [];
            var els = document.body ? document.body.querySelectorAll("*") : [];
            for (var i = 0; i < els.length && out.length < 14; i++) {
              var el = els[i];
              var r = el.getBoundingClientRect();
              if (r.width < innerWidth * 0.35 || r.height < 50 || r.height > innerHeight * 0.45) continue;
              if (r.top < innerHeight * 0.5) continue;
              var cs = getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              var bg = cs.backgroundColor;
              if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") continue;
              var chain = [];
              var p = el;
              for (var k = 0; k < 3 && p; k++) { chain.push(String(p.className || p.tagName).slice(0, 90)); p = p.parentElement; }
              out.push({ tag: el.tagName.toLowerCase(), bg: bg, rect: Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height), chain: chain });
            }
            return out;
          } catch (e) { return { err: String(e).slice(0, 80) }; }
        })(),
        slots: [],
        // 强调色残留探针:找仍为蓝色系的叶子文字(引用/链接/硬编码 Tailwind 蓝),
        // 上报类名链 + 实际色值 —— token 覆盖没接住的精确数据从这里来。
        accentText: (function () {
          try {
            var out = [];
            var els = document.body ? document.body.querySelectorAll('*') : [];
            for (var i = 0; i < els.length && out.length < 8; i++) {
              var el = els[i];
              if (el.children.length) continue;
              var r = el.getBoundingClientRect();
              if (r.width < 30 || r.height < 8) continue;
              var cs = getComputedStyle(el);
              var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
              if (!m) continue;
              var R = +m[1], G = +m[2], B = +m[3];
              if (!(B > 120 && B > R + 20 && B >= G)) continue;   // 蓝色系
              var chain = [];
              var p = el;
              for (var k = 0; k < 4 && p; k++) { chain.push(String(p.className || p.tagName).slice(0, 70)); p = p.parentElement; }
              out.push({ color: cs.color, cls: chain });
            }
            return out;
          } catch (e) { return { err: String(e).slice(0, 60) }; }
        })(),
        // 分区探针:分区文字色的选择器是否命中(shadcn sidebar 家族/主区/聊天框)
        zones: (function () {
          try {
            var q = function (s) { return document.querySelectorAll(s).length; };
            return {
              sidebar: q('[data-slot^="sidebar"]:not([data-slot="sidebar-inset"])'),
              sidebarInset: q('[data-slot="sidebar-inset"]'),
              composer: q('.chat-composer-input-surface'),
              rootFg: (getComputedStyle(document.documentElement).getPropertyValue('--color-foreground') || '').trim() || null,
            };
          } catch (e) { return { err: String(e).slice(0, 60) }; }
        })(),
      };
      // 磨砂玻璃探针:报告输入框 computed 样式,并找出会阻断 backdrop-filter 的祖先
      info.composer = (function () {
        try {
          var surf = document.querySelector('.chat-composer-input-surface');
          var hasInput = !!document.querySelector('[data-testid="chat-input"]');
          if (!surf) return { exists: false, hasRegion: !!document.querySelector('.chat-composer-region'), hasInput: hasInput };
          var cs = getComputedStyle(surf);
          var blockers = [];
          for (var el = surf.parentElement; el && el !== document.documentElement; el = el.parentElement) {
            var s2 = getComputedStyle(el);
            var why = [];
            if (s2.transform && s2.transform !== 'none') why.push('transform');
            if (s2.filter && s2.filter !== 'none') why.push('filter');
            if (s2.backdropFilter && s2.backdropFilter !== 'none') why.push('backdrop-filter');
            if (s2.opacity && s2.opacity !== '1') why.push('opacity=' + s2.opacity);
            if (s2.willChange && /transform|filter|opacity/.test(s2.willChange)) why.push('will-change:' + s2.willChange);
            if (s2.contain && s2.contain !== 'none') why.push('contain:' + s2.contain);
            if (why.length) blockers.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 70), why: why.join('+') });
          }
          return {
            exists: true, hasInput: hasInput,
            bg: cs.backgroundColor,
            backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
            border: cs.borderTopWidth + ' ' + cs.borderTopColor,
            blockers: blockers.slice(0, 8),
          };
        } catch (e) { return { err: String(e).slice(0, 90) }; }
      })();
      // 大面积表面(≥30% 视口,含 fixed 遮罩)
      var els = document.body ? document.body.querySelectorAll('*') : [];
      for (var i = 0, n = 0; i < els.length && n < 20; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        if (r.width < innerWidth * 0.3 || r.height < innerHeight * 0.3) continue;
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        var bg = cs.backgroundColor;
        var bf = cs.backdropFilter || cs.webkitBackdropFilter;
        if ((!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && (!bf || bf === 'none')) continue;
        info.bigSurfaces.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          cls: String(el.className).slice(0, 110) || undefined,
          bg: bg,
          blur: bf && bf !== 'none' ? bf : undefined,
        });
        n++;
      }
      // data-slot 普查(shadcn 风格组件名):高频 slot 附带一份样本类名
      var slotCount = {}, slotSample = {};
      for (var j = 0; j < els.length; j++) {
        var s = els[j].getAttribute && els[j].getAttribute('data-slot');
        if (!s) continue;
        slotCount[s] = (slotCount[s] || 0) + 1;
        if (!slotSample[s]) slotSample[s] = String(els[j].className).slice(0, 150);
      }
      var keys = Object.keys(slotCount).sort(function (a, b) { return slotCount[b] - slotCount[a]; }).slice(0, 40);
      for (var k = 0; k < keys.length; k++) info.slots.push({ slot: keys[k], n: slotCount[keys[k]], cls: slotSample[keys[k]] });
      fetch(BASE + '/api/diag', {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info),
      }).catch(function () {});
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
  function onReady() {
    refreshCss();
    setInterval(refreshCss, 15000);           // 兜底:直接改服务器上 embed.css 时也能生效
    pollLoop();
    setInterval(diag, 60000);
    setTimeout(diag, 5000);                   // 首次诊断避开聊天应用挂载关键期
    // 窗口从隐藏恢复时立即补一次样式/版本/诊断,隐藏期间的跳过不留空窗;
    // 同时重置重载预算 —— 用户正看着,值得给新一轮自愈机会
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { reloadCount = 0; refreshCss(); pollVersion(); diag(); }
    });
    // ── 注入代码自更新 ──
    // embed.js 只在 ZCode 重启时加载,以前每次改注入逻辑都得等用户重启。
    // 现在:记住启动时的代码指纹(/api/version=文件哈希),变了且【窗口隐藏+
    // 输入框无草稿】时才 location.reload() —— ZCode 带 restoreSession,重载
    // 自动恢复会话;可见中或正在打字时绝不重载,下次隐藏时机再试。
    var embedFp = null;
    function fetchFp() {
      return fetch(BASE + '/api/version?embed-fp=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { return d && d.v; })
        .catch(function () { return null; });
    }
    fetchFp().then(function (v) { embedFp = v; });
    setInterval(function () {
      if (!document.hidden || embedFp == null) return;
      fetchFp().then(function (v) {
        if (v == null || v === embedFp) return;
        var hasDraft = false;
        try {
          var inp = document.querySelector('[data-testid="chat-input"], .chat-composer-input-surface textarea, .chat-composer-input-surface [contenteditable="true"]');
          hasDraft = !!inp && ((inp.value || inp.textContent || '').trim().length > 0);
        } catch (e) {}
        if (hasDraft) return;   // 有草稿:不重载,等下个周期
        location.reload();
      });
    }, 120000);
    // ── 壁纸层延迟挂载:文本/模型加载提速的核心 ──
    // 壁纸是重资源(视频解码 + WebGL 初始化),以前页面一挂载就开始加载,
    // 正好和聊天应用的启动抢 CPU/GPU。现在等输入框出现(= 聊天应用挂载完成)
    // 再挂壁纸,最多等 2.5s:聊天先独占资源,壁纸随后淡入,快机器上几乎无感。
    var mounted = false;
    function mountWhenAppReady() {
      if (mounted) return;
      mounted = true;
      mount();
    }
    (function waitApp() {
      var APP_READY = '[data-testid="chat-input"],.chat-composer-region';
      if (document.querySelector(APP_READY)) { setTimeout(mountWhenAppReady, 300); return; }
      var mo = new MutationObserver(function () {
        if (document.querySelector(APP_READY)) { mo.disconnect(); setTimeout(mountWhenAppReady, 300); }
      });
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { mo.disconnect(); mountWhenAppReady(); }, 2500);
    })();
    // 一次性 DOM 抓取:从"输入框所在的屏幕位置"反查元素链,用于精确定位遮挡壁纸的容器
    setTimeout(dumpComposerRegion, 4000);
    setTimeout(dumpComposerRegion, 15000);
    setTimeout(dumpComposerRegion, 45000);   // 覆盖样式热更新之后的状态
    // 壁纸面板/工作台入口:仅聊天窗口(file:// 宿主)加载;
    // 播放页自身(127.0.0.1:7396/?embed=1)不加载,否则壁纸 iframe 里会再长一个按钮
    if (location.origin !== BASE) {
      var s = document.createElement('script');
      s.src = BASE + '/panel.js?v=' + Date.now();
      document.head.appendChild(s);
      hookSettingsDialog();
    }
  }

  // ── 设置页注入:在左侧"基础设置"分组的"外观"项后面加 "Wallpaper" ─────────
  // ZCode 设置是独立整页(非弹窗),侧边栏项是普通按钮。策略:找文本恰为"外观"、
  // 位于屏幕左栏(x<380)的叶子节点 → 克隆其最近的可点击祖先 → 改文本 → 插到后面。
  var hookInjected = 0;
  function hookSettingsDialog() {
    if (document.getElementById('we-wp-settings-entry')) { hookInjected = 1; return; }
    if (document.body.textContent.indexOf('基础设置') < 0) return;   // 不在设置页
    var leaves = document.body.querySelectorAll('*');
    for (var i = 0; i < leaves.length; i++) {
      var el = leaves[i];
      if (el.children.length !== 0 || el.id === 'we-wp-settings-entry') continue;
      var txt = (el.textContent || '').trim();
      // 兼容带图标前缀的条目(如 "🎨 外观"),也兼容纯文本 "外观"
      if (!(txt === '外观' || (txt.indexOf('外观') >= 0 && txt.length <= 8))) continue;
      var r = el.getBoundingClientRect();
      if (r.x < 0 || r.x > 380 || r.width > 340) continue;           // 必须在左栏
      var host0 = el.closest('button') || el.closest('[role="button"]') || el.closest('a') || el;
      if (!host0 || host0.id === 'we-wp-settings-entry') continue;
      var item = host0.cloneNode(true);
      item.id = 'we-wp-settings-entry';
      // 改克隆体里的文本节点
      var tnode = item.querySelector('*');
      var set = false;
      var walk = item.querySelectorAll('*');
      for (var k = 0; k < walk.length; k++) {
        var wtxt = (walk[k].textContent || '').trim();
        if (walk[k].children.length === 0 && wtxt.indexOf('外观') >= 0 && wtxt.length <= 8) {
          walk[k].textContent = 'Wallpaper'; set = true; break;
        }
      }
      if (!set) item.textContent = 'Wallpaper';
      item.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (window.__weWpOpenWorkbench) window.__weWpOpenWorkbench();
      });
      if (host0.nextSibling) host0.parentNode.insertBefore(item, host0.nextSibling);
      else host0.parentNode.appendChild(item);
      hookInjected = 1;
      try {
        fetch(BASE + '/api/diag', { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hook: 'settings-entry-injected', after: '外观(基础设置)' }) }).catch(function () {});
      } catch (e2) {}
      return;
    }
  }
  // 设置页是 SPA 路由:进设置时 DOM 才出现,靠观察器触发;1s 节流。
  // 聊天流式输出时 DOM 变更极频繁,而扫描要序列化整棵 body 文本(O(树)),
  // 所以窗口隐藏时直接跳过,恢复显示后的那次变更自然会触发。
  var hookScanPending = 0;
  new MutationObserver(function () {
    if (hookScanPending || document.hidden) return;
    hookScanPending = setTimeout(function () {
      hookScanPending = 0;
      if (!document.hidden) hookSettingsDialog();
    }, 1000);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
