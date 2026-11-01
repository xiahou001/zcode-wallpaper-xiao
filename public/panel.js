/**
 * panel.js — 聊天窗口内的壁纸工作台入口。
 * 右下角玻璃按钮 → 打开 /workbench 工作区(iframe 模态,Esc/点外部关闭)。
 * 工作区页面本体在 workbench.html/js/css;独立 URL 也可直接访问。
 */
(function () {
  var BASE = 'http://127.0.0.1:7396';
  if (document.getElementById('we-wp-panel-host')) return;

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); return; }
  init();

  function init() {
    var host = document.createElement('div');
    host.id = 'we-wp-panel-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483640;pointer-events:none;';
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      '* { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }',
      '.trigger { position: fixed; right: 14px; bottom: 14px; width: 34px; height: 34px; border-radius: 50%;',
      '  border: 1px solid rgba(255,255,255,.16); cursor: pointer; pointer-events: auto;',
      '  background: rgba(16,18,24,.55); color: #eef1f6; font-size: 15px; display: flex; align-items: center; justify-content: center;',
      '  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); opacity: .28; transition: opacity .25s ease; }',
      '.trigger:hover, .trigger.active { opacity: 1; }',
      '.overlay { position: fixed; inset: 0; background: rgba(6,8,12,.45); pointer-events: auto;',
      '  backdrop-filter: blur(18px) saturate(.85); -webkit-backdrop-filter: blur(18px) saturate(.85); }',
      '.modal { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);',
      '  width: min(960px, calc(100vw - 48px)); height: min(640px, calc(100vh - 64px));',
      '  border-radius: 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.16);',
      '  box-shadow: 0 24px 80px rgba(0,0,0,.6); pointer-events: auto; background: transparent; }',
      '.modal iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; }',
    ].join('\n');
    root.appendChild(style);

    var trigger = document.createElement('button');
    trigger.className = 'trigger';
    trigger.title = '壁纸工作台 (we-wallpaper)';
    trigger.textContent = '🖼';
    root.appendChild(trigger);

    var modal = null;   // {overlay, frame}

    function closeWorkbench() {
      if (modal) { modal.overlay.remove(); modal.frame.remove(); modal = null; }
      trigger.classList.remove('active');
      document.removeEventListener('mousedown', onOutside, true);
    }
    function openWorkbench() {
      if (modal) { closeWorkbench(); return; }
      var overlay = document.createElement('div');
      overlay.className = 'overlay';
      var frame = document.createElement('div');
      frame.className = 'modal';
      var iframe = document.createElement('iframe');
      iframe.src = BASE + '/workbench?refresh=' + Date.now();
      iframe.setAttribute('title', '壁纸工作台');
      iframe.setAttribute('allow', 'autoplay');
      frame.appendChild(iframe);
      root.appendChild(overlay);
      root.appendChild(frame);
      modal = { overlay: overlay, frame: frame };
      trigger.classList.add('active');
      overlay.addEventListener('mousedown', closeWorkbench);
      document.addEventListener('mousedown', onOutside, true);
    }
    function onOutside(e) {
      if (!modal) return document.removeEventListener('mousedown', onOutside, true);
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(modal.frame) === -1 && path.indexOf(trigger) === -1) closeWorkbench();
    }
    window.addEventListener('message', function (e) {
      if (e.data === 'we-wp-close') closeWorkbench();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal) closeWorkbench();
    });

    trigger.onclick = openWorkbench;
    // 供注入层(设置弹窗里的 Wallpaper 条目)调用
    window.__weWpOpenWorkbench = openWorkbench;
    // 服务器可达时按钮才浮现
    trigger.style.opacity = '0';
    (function probe() {
      fetch(BASE + '/api/state', { cache: 'no-store', mode: 'no-cors' })
        .then(function () { trigger.style.opacity = ''; })
        .catch(function () { trigger.style.opacity = '0'; setTimeout(probe, 5000); });
    })();
  }
})();
