/**
 * workbench.js — 壁纸引擎工作台页面逻辑(独立页 / 聊天窗内嵌模态两用)。
 *
 * 观感对标上游 dsh-wallpaper-engine 的液态玻璃设置页:顶栏(圆形徽标 + 标题 + 副标题)
 * → 玻璃页签条(壁纸库/外观/播放/系统/扩展/关于)→ 一栏式玻璃内容板。
 * 内容板里每个功能 = 一节(.wb-sec:节标题 + 控件行),节间用 1px 细线分隔。
 *
 * 控件同构上游命名语义:ctlText(label, hint) / ctlRow(text, side) / switchRow / segRow /
 * ctlSelect。所有写操作走壁纸服务器的 HTTP API(127.0.0.1:7396)。
 */
(function () {
  // 全局兜底:api() 超时/失败会 reject,几十处调用点不可能逐个补 catch ——
  // 在这里吞掉未处理 rejection(服务器不可达时按钮保持现状,属诚实降级)。
  window.addEventListener('unhandledrejection', function (e) { e.preventDefault(); });
  var BASE = location.origin;
  var state = null, wallpapers = [], playlists = [];
  var page = 'wall';
  var typeFilter = 'all';          // 壁纸类型筛选,跨 render 保留
  var editorName = null, editorIds = null, editorInterval = 30, editorRandom = false;
  var scanStatus = '';              // "重新扫描"的结果提示,跨 render 保留
  var propsOpen = false;            // 「壁纸属性」折叠开关(上游同款行按钮)
  var content = document.getElementById('content');

  // 通知宿主(ZCode 页面):外观变了,立刻重取样式。比等轮询快得多(通常 <50ms)。
  function notifyAppearance() {
    try { if (window.parent && window.parent !== window) window.parent.postMessage('we-wp-appearance', '*'); } catch (e) {}
  }
  function api(path, body) {
    // 超时保护:挂起的 POST 会让按钮永久无响应(=「换不动」);10s 后中止并抛错
    var ctrl = new AbortController();
    var kill = setTimeout(function () { ctrl.abort(); }, 10000);
    var p = fetch(BASE + path, body !== undefined ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    } : { signal: ctrl.signal }).finally(function () { clearTimeout(kill); });
    return p.then(function (r) { return r.json(); }).then(function (data) {
      if (body !== undefined) notifyAppearance();   // 任何状态写入都让宿主立即刷新样式
      return data;
    });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, cls, onClick, title) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    if (title) b.title = title;
    if (onClick) b.onclick = onClick;
    return b;
  }
  // ── 上游同构的排布原语 ──────────────────────────────────────
  // 一节:节标题 + 若干行;节间靠 CSS 的 border-top 分隔
  function section(title) {
    var s = el('div', 'wb-sec');
    if (title) s.appendChild(el('h3', 'wb-sec-label', title));
    content.appendChild(s);
    return s;
  }
  // 行:左 = 标签 + 灰色说明,右 = 控件
  function ctlText(label, hint) {
    var t = el('div', 'wb-ctl-text');
    t.appendChild(el('span', 'wb-ctl-label', label));
    if (hint) t.appendChild(el('span', 'wb-ctl-hint', hint));
    return t;
  }
  function ctlRow(parent, label, hint, buildSide, cls) {
    var row = el('div', 'wb-ctl' + (cls ? ' ' + cls : ''));
    row.appendChild(ctlText(label, hint));
    var side = el('div', 'wb-ctl-side');
    if (buildSide) buildSide(side);
    row.appendChild(side);
    parent.appendChild(row);
    return row;
  }
  function ctlSelect(options, value, onChange) {
    var sel = document.createElement('select');
    options.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0]; o.textContent = p[1];
      if (String(value) === String(p[0])) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { onChange(sel.value); };
    return sel;
  }
  function Toggle(checked, onChange, title) {
    var lab = el('label', 'wb-switch');
    if (title) lab.title = title;
    var inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!checked;
    inp.onchange = function () { onChange(inp.checked); };
    var track = el('span', 'wb-switch-track');
    track.appendChild(el('span', 'wb-switch-thumb'));
    lab.appendChild(inp); lab.appendChild(track);
    return lab;
  }
  // 分段按钮组:同一排互斥按钮,选中态用强调色
  function segRow(parent, label, hint, items, cur, onPick) {
    return ctlRow(parent, label, hint, function (side) {
      var seg = el('div', 'wb-seg');
      items.forEach(function (p) {
        var b = el('button', 'wb-rate' + (String(cur) === String(p[0]) ? ' is-on' : ''), p[1]);
        b.onclick = function () { onPick(p[0]); };
        seg.appendChild(b);
      });
      side.appendChild(seg);
    }, 'wb-ctl--wrap');
  }
  function switchRow(parent, label, hint, checked, onChange, title) {
    return ctlRow(parent, label, hint, function (side) {
      side.appendChild(Toggle(checked, onChange, title));
    });
  }
  function sliderRow(parent, label, hint, value, min, max, oninput, unit) {
    var row = el('div', 'wb-ctl');
    row.appendChild(ctlText(label, hint));
    var side = el('div', 'wb-ctl-side');
    side.style.flex = '1';
    var inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.value = value;
    var val = el('span', 'val', value + (unit || '%'));
    inp.oninput = function () { val.textContent = inp.value + (unit || '%'); oninput(Number(inp.value)); };
    side.appendChild(inp); side.appendChild(val);
    row.appendChild(side);
    parent.appendChild(row);
    return inp;
  }

  // ── 工作台玻璃染色(材质与聊天框同一套设置)────────────────────
  // 背景层现在恒定可见(不再只限独立页):wantsBg 恒为 true,由 CSS 的
  // --wb-bgart 决定叠哪张预模糊壁纸,极光渐变永远兜底,不会出现纯黑。
  var glassStyleEl = null;
  function applyGlassTint() {
    if (!state || !state.appearance) return;
    var a = state.appearance;
    var modal = false;
    try { modal = window.parent && window.parent !== window; } catch (e) { modal = true; }
    var m = /^#?([0-9a-f]{6})$/i.exec(String(a.glassColor || '#14161c'));
    var rgb = [20, 22, 28];
    if (m) { var n = parseInt(m[1], 16); rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    var alpha = Math.max(8, Math.min(96, Math.round(96 - 0.88 * (Number(a.glass) || 50))));
    var wb = Math.max(45, Math.min(92, Math.round(alpha * 0.75 + 28)));   // 向实心收,保面板可读
    if (!glassStyleEl) {
      glassStyleEl = document.createElement('style');
      glassStyleEl.id = 'wb-glass';
      document.head.appendChild(glassStyleEl);
    }
    // 内嵌:body 透明(宿主已把壁纸铺在更底层,本页背景图叠在上面);
    // 独立:body 透明 + html 深色兜底 —— 两种情况背景层都由 .wb-bg 负责。
    glassStyleEl.textContent = 'html { background: #0b0d11; }'
      + ':root { --wb-glass-rgb: ' + rgb.join(',') + '; }'
      + 'body { background: transparent !important; }'
      + '.content { background-color: rgba(' + rgb.join(',') + ',' + (wb / 100).toFixed(2) + '); }';
  }
  // 悬停预取:提前触发服务端的 faststart 重排与元数据 Range 请求,
  // 点击播放时首帧立即可得(单槽 + 60s TTL,避免重复预热)
  var preheatSlot = null, preheatAt = 0;
  function preheat(w) {
    if (!w || !w.mediaUrl) return;
    var now = Date.now();
    if (preheatSlot === w.id && now - preheatAt < 60000) return;
    preheatSlot = w.id; preheatAt = now;
    fetch(BASE + w.mediaUrl, { headers: { Range: 'bytes=0-65535' }, cache: 'no-store' }).catch(function () {});
  }
  var typeLabel = function (w) { return w.type === 'scene' ? '场景' : w.type === 'video' ? '视频' : w.type === 'image' ? '图片' : w.type === 'web' ? '网页' : w.type; };
  var cur = function () { return wallpapers.find(function (w) { return state && w.id === state.currentId; }) || null; };
  function availCount() { return wallpapers.filter(function (x) { return x.playable && !x.hidden; }).length; }

  // forceScan=true 时先调 /api/scan(手动重新扫描 / 打开面板),
  // 让 Steam 刚下载或退订的壁纸立即反映到列表。
  function loadData(forceScan) {
    var pre = forceScan ? api('/api/scan', {}).catch(function () { return null; }) : Promise.resolve(null);
    return pre.then(function () {
      return Promise.all([api('/api/wallpapers'), api('/api/state')]);
    }).then(function (rs) {
      wallpapers = rs[0].wallpapers || [];
      state = rs[1];
      playlists = state.playlists || [];
    });
  }
  function setState(s) { if (s && s.appearance) { state = s; playlists = s.playlists || []; } render(); }

  function render() {
    applyGlassTint();
    updateBgArt();
    var count = document.getElementById('wb-count');
    if (count) count.textContent = availCount();
    content.innerHTML = '';
    if (!state) { content.appendChild(el('div', 'loading', '壁纸服务器暂不可用 —— 请确认 we-wallpaper 服务器在运行')); return; }
    if (page === 'wall') renderWall();
    else if (page === 'look') renderLook();
    else if (page === 'play') renderPlay();
    else if (page === 'sys') renderSystem();
    else if (page === 'ext') renderExt();
    else renderAbout();
  }

  // 背景壁纸层:换壁纸时同步 --wb-bgart 变量(服务端已按当前壁纸烘焙好预模糊图,
  // 首屏由 /workbench 直接注入,这里只负责后续变化);CSS 端是纯 background-image。
  var bgArtKey = '';
  function updateBgArt() {
    var w = cur();
    var key = w && w.preview ? w.preview : '';
    if (key === bgArtKey) return;
    bgArtKey = key;
    var v = key ? '/preview-blur/' + w.id + '?v=' + Date.now() : 'none';
    document.documentElement.style.setProperty('--wb-bgart', key ? "url('" + v + "')" : 'none');
  }

  // ── 壁纸库(上游四节:当前壁纸 / 切换过场 / 自动轮播 / 自定义壁纸)──
  function renderWall() {
    renderCurrentSection();
    renderTransitionSection();
    renderRotationSection();
    renderUploadsSection();
    renderLibrarySection();
  }

  // 1. 当前壁纸:黑胶唱片 + 标题 + 类型/状态 + 主按钮;下方一行动作按钮
  function renderCurrentSection() {
    var s = section('当前壁纸');
    var w = cur();
    var card = el('div', 'wb-current');
    var vinyl = el('div', 'wb-vinyl' + (w && !state.paused ? ' is-playing' : ''));
    var cover = el('div', 'wb-vinyl__cover');
    if (w) { cover.style.backgroundColor = 'transparent'; }
    var img = el('img');
    img.alt = '';
    if (w && w.preview) img.src = w.preview;
    cover.appendChild(img);
    vinyl.appendChild(cover);
    vinyl.appendChild(el('div', 'wb-vinyl__hole'));
    card.appendChild(vinyl);

    var info = el('div', 'wb-current-info');
    if (w) {
      info.appendChild(el('div', 'wb-current-title', w.title));
      info.appendChild(el('span', 'wb-current-meta',
        (w.type === 'scene' ? '场景壁纸(实时渲染)' : typeLabel(w) + '壁纸') + ' · ' + (state.paused ? '已暂停' : '播放中')));
    } else {
      info.appendChild(el('div', 'wb-current-title', '壁纸未启用'));
      info.appendChild(el('span', 'wb-current-meta', '从下方壁纸库里挑一张开始'));
    }
    card.appendChild(info);

    var acts = el('div', 'wb-current-actions');
    acts.appendChild(btn('选择壁纸', 'primary', function () {
      var gridSec = document.querySelector('.wb-sec--library');
      if (gridSec) gridSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, '跳到下方壁纸库'));
    card.appendChild(acts);
    s.appendChild(card);

    // 动作行:壁纸属性 / 暂停 / 音乐关 / 清除 / 刷新
    var row = el('div', 'wb-row');
    var hasProps = !!(w && (w.type === 'scene' || w.type === 'web'));
    if (hasProps) {
      row.appendChild(btn('壁纸属性', propsOpen ? 'on' : '', function () { propsOpen = !propsOpen; render(); },
        '展开这张壁纸的可调参数(来自 project.json 的 general.properties)'));
    }
    row.appendChild(btn(state.paused ? '▶ 播放' : '⏸ 暂停', '', function () {
      api('/api/pause', { paused: !state.paused }).then(setState);
    }, '暂停/恢复壁纸动效'));
    row.appendChild(btn(state.volume > 0 ? '🔊 音乐开' : '🔇 音乐关', '', function () {
      api('/api/volume', { volume: state.volume > 0 ? 0 : 1 }).then(setState);
    }, '壁纸自带音轨的开关'));
    row.appendChild(btn('清除', 'danger', function () {
      api('/api/close', {}).then(setState);
    }, '关闭壁纸(清空当前选择)'));
    row.appendChild(btn('刷新', '', function () {
      loadData(true).then(render);
    }, '重新扫描壁纸库并刷新状态'));
    s.appendChild(row);

    if (propsOpen && w) renderPropsBox(s, w);
  }

  // 壁纸属性:可读名称 + 类型化控件(替代原来直接显示字段名的裸面板)
  function renderPropsBox(parent, w) {
    var box = el('div', 'wb-box');
    box.textContent = '读取中…';
    box.style.maxHeight = '320px';
    parent.appendChild(box);
    api('/api/props/' + w.id).then(function (r) {
      box.textContent = '';
      var list = r.props || [];
      if (!list.length) { box.appendChild(el('div', 'muted', '这张壁纸没有可调参数')); return; }
      var toHex = function (v) {
        var m = /^([\d.]+) ([\d.]+) ([\d.]+)$/.exec(String(v));
        if (!m) return '#000000';
        var h = function (x) { var t = Math.round(Math.max(0, Math.min(1, Number(x))) * 255).toString(16); return t.length < 2 ? '0' + t : t; };
        return '#' + h(m[1]) + h(m[2]) + h(m[3]);
      };
      var toVec = function (hex) {
        var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
        return (parseInt(m[1], 16) / 255).toFixed(4) + ' ' + (parseInt(m[2], 16) / 255).toFixed(4) + ' ' + (parseInt(m[3], 16) / 255).toFixed(4);
      };
      var pretty = function (p) {
        var t = String(p.text || p.name);
        // WE 的 internal 属性名(ui_browse_properties_*)对人类不可读,换成人话
        if (/^ui_browse_properties_scheme_color$/i.test(t)) return '主题配色';
        if (/^ui_browse_properties_/i.test(t)) return t.replace(/^ui_browse_properties_/i, '').replace(/_/g, ' ');
        return t;
      };
      var post = function (name, v) { api('/api/props/' + w.id, { values: {} }).catch(function () {}); };
      list.forEach(function (p) {
        var row = el('div', 'wb-ctl');
        var hint = p.type === 'color' ? '颜色' : p.type === 'slider' ? '滑杆' : p.type === 'bool' ? '开关' : p.type === 'combo' || p.type === 'combobox' ? '下拉' : '文本';
        row.appendChild(ctlText(pretty(p), hint));
        var side = el('div', 'wb-ctl-side');
        if (p.type === 'color') {
          var c = document.createElement('input'); c.type = 'color'; c.value = toHex(p.value);
          c.onchange = function () { var o = {}; o[p.name] = toVec(c.value); api('/api/props/' + w.id, { values: o }).catch(function () {}); };
          side.appendChild(c);
        } else if (p.type === 'bool') {
          side.appendChild(Toggle(p.value === true || p.value === 1, function (v) {
            var o = {}; o[p.name] = v; api('/api/props/' + w.id, { values: o }).catch(function () {});
          }));
        } else if (p.type === 'slider') {
          var sl = document.createElement('input'); sl.type = 'range';
          sl.min = p.min != null ? p.min : 0; sl.max = p.max != null ? p.max : 100; sl.step = p.step != null ? p.step : 1;
          sl.value = Number(p.value) || 0; sl.style.flex = '1'; sl.style.minWidth = '110px';
          var vv = el('span', 'val', String(p.value));
          sl.onchange = function () { var o = {}; o[p.name] = Number(sl.value); api('/api/props/' + w.id, { values: o }).catch(function () {}); };
          side.appendChild(sl); side.appendChild(vv);
        } else if (p.type === 'combobox' || p.type === 'combo') {
          var opts = (p.options && p.options.values) || p.alts || {};
          var keys = Object.keys(opts);
          side.appendChild(ctlSelect(keys.map(function (k) { return [k, (opts[k] && opts[k].text) || k]; }), p.value, function (v) {
            var o = {}; o[p.name] = v; api('/api/props/' + w.id, { values: o }).catch(function () {});
          }));
        } else {
          var tx = document.createElement('input'); tx.type = 'text'; tx.value = String(p.value);
          tx.style.width = '150px';
          tx.onchange = function () { var o = {}; o[p.name] = tx.value; api('/api/props/' + w.id, { values: o }).catch(function () {}); };
          side.appendChild(tx);
        }
        row.appendChild(side);
        box.appendChild(row);
      });
      post = null;
    }).catch(function () { box.textContent = '读取失败'; });
  }

  // 2. 切换过场
  var TRANSITIONS = [['crossfade', '交叉淡化'], ['push', '推移'], ['wipe', '擦除'], ['iris', '光圈'], ['zoom', '缩放'], ['blinds', '百叶窗'], ['none', '硬切']];
  var TRANS_MS = [[0, '硬切'], [600, '快 600ms'], [1800, '标准 1800ms'], [3000, '慢 3000ms']];
  function renderTransitionSection() {
    var s = section('切换过场');
    var t = state.transition || { kind: 'crossfade', ms: 1800, dir: 'left' };
    ctlRow(s, '过场动画', '换壁纸时的转场', function (side) {
      side.appendChild(ctlSelect(TRANSITIONS, t.kind || 'crossfade', function (v) {
        api('/api/transition', { kind: v, ms: t.ms, dir: t.dir || 'left' }).then(setState);
      }));
    });
    var kind = t.kind || 'crossfade';
    if (kind === 'push' || kind === 'wipe') {
      segRow(s, '方向', '新画面从哪边进来',
        [['left', '←'], ['right', '→'], ['up', '↑'], ['down', '↓']], t.dir || 'left', function (v) {
          api('/api/transition', { kind: kind, ms: t.ms, dir: v }).then(setState);
        });
    }
    if (kind !== 'none') {
      segRow(s, '时长', '当前约 ' + t.ms + ' ms', TRANS_MS, t.ms, function (v) {
        api('/api/transition', { kind: kind, ms: Number(v), dir: t.dir || 'left' }).then(setState);
      });
    }
  }

  // 3. 自动轮播(列表选择 / 新建 / 编辑 / 删除 + 自动轮转开关)
  function renderRotationSection() {
    var s = section('自动轮播');
    var rot = state.rotate || { enabled: false, intervalMin: 30, playlist: null, random: false };
    var prow = el('div', 'wb-row');
    var psel = document.createElement('select');
    psel.style.flex = '1'; psel.style.minWidth = '140px';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = playlists.length ? '— 选择轮播列表 —' : '— 暂无轮播列表 —';
    psel.appendChild(none);
    playlists.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.name; o.textContent = p.name + '(' + p.ids.length + ' 张)';
      if (rot.playlist === p.name) o.selected = true;
      psel.appendChild(o);
    });
    psel.onchange = function () {
      api('/api/rotate', { enabled: rot.enabled, intervalMin: rot.intervalMin, playlist: psel.value || null, random: rot.random }).then(setState);
    };
    prow.appendChild(psel);
    prow.appendChild(btn('新建', '', function () {
      editorName = '轮播 ' + new Date().toISOString().slice(5, 16).replace('T', ' ');
      editorIds = null; editorInterval = rot.intervalMin || 30; editorRandom = !!rot.random;
      render();
    }, '新建一个轮播列表'));
    prow.appendChild(btn('编辑', '', function () {
      var p = playlists.find(function (x) { return x.name === rot.playlist; });
      editorName = p ? p.name : '轮播 ' + new Date().toISOString().slice(5, 16).replace('T', ' ');
      editorIds = p ? p.ids.slice() : null;
      editorInterval = (p && p.intervalMin) || rot.intervalMin || 30;
      editorRandom = p ? !!p.random : !!rot.random;
      render();
    }, '编辑当前轮播列表'));
    prow.appendChild(btn('删除', 'danger', function () {
      if (!rot.playlist) return;
      if (!window.confirm('删除轮播列表「' + rot.playlist + '」?')) return;
      api('/api/playlists/delete', { name: rot.playlist }).then(setState);
    }, '删除当前轮播列表'));
    s.appendChild(prow);

    // 自动轮转
    ctlRow(s, '自动轮转',
      '请先选择或新建一个轮播列表',
      function (side) {
        var ivSel = ctlSelect([[15, '15 分钟'], [30, '30 分钟'], [60, '60 分钟'], [120, '120 分钟']], rot.intervalMin || 30, function (v) {
          api('/api/rotate', { enabled: rot.enabled, intervalMin: Number(v), playlist: rot.playlist, random: rot.random }).then(setState);
        });
        side.appendChild(ivSel);
        side.appendChild(Toggle(!!rot.enabled, function (v) {
          api('/api/rotate', { enabled: v, intervalMin: rot.intervalMin, playlist: rot.playlist, random: rot.random }).then(setState);
        }, '到点自动换下一张壁纸'));
      });

    if (editorName != null) renderPlaylistEditor(s, rot);
  }

  function renderPlaylistEditor(parent, rot) {
    var box = el('div', 'wb-box');
    box.style.maxHeight = 'none';
    // 名称
    var nameRow = el('div', 'wb-ctl');
    nameRow.appendChild(ctlText('列表名称', '保存后按此名出现在下拉里'));
    var side = el('div', 'wb-ctl-side');
    var nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.value = editorName; nameIn.style.width = '180px';
    side.appendChild(nameIn);
    nameRow.appendChild(side);
    box.appendChild(nameRow);
    // 顺序
    ctlRow(box, '轮换方式', '随机=每次从池里抽一张;顺序=按列表依次', function (sd) {
      sd.appendChild(Toggle(editorRandom, function (v) { editorRandom = v; render(); }, '随机顺序'));
    });
    // 选择壁纸
    var listWrap = el('div');
    listWrap.style.display = 'flex'; listWrap.style.flexDirection = 'column'; listWrap.style.gap = '2px';
    listWrap.style.maxHeight = '220px'; listWrap.style.overflowY = 'auto'; listWrap.style.marginTop = '6px';
    var all = wallpapers.filter(function (w) { return w.playable && !w.hidden; });
    if (editorIds === null) editorIds = all.map(function (x) { return x.id; });
    all.forEach(function (w) {
      var c = el('label', 'chk');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = editorIds.indexOf(w.id) >= 0;
      cb.onchange = function () {
        if (cb.checked) { if (editorIds.indexOf(w.id) < 0) editorIds.push(w.id); }
        else editorIds = editorIds.filter(function (x) { return x !== w.id; });
      };
      var img = el('img'); img.src = w.preview || '';
      c.appendChild(cb); c.appendChild(img);
      c.appendChild(el('span', 'n', w.title));
      listWrap.appendChild(c);
    });
    box.appendChild(el('div', 'muted', '已选 ' + editorIds.length + ' / ' + all.length + ' 张'));
    box.appendChild(listWrap);
    // 动作
    var actRow = el('div', 'wb-row');
    actRow.style.marginTop = '10px';
    actRow.appendChild(btn('保存', 'primary', function () {
      var nm = nameIn.value.trim() || editorName;
      api('/api/playlists', { name: nm, ids: editorIds }).then(function (s) {
        editorName = null; editorIds = null;
        state = s; return loadData();
      }).then(render);
    }));
    actRow.appendChild(btn('取消', '', function () { editorName = null; editorIds = null; render(); }));
    box.appendChild(actRow);
    parent.appendChild(box);
  }

  // 4. 自定义壁纸:存储位置 + 上传 + 用量/删除
  function renderUploadsSection() {
    var s = section('自定义壁纸');
    var row = el('div', 'wb-ctl');
    row.appendChild(ctlText('存储位置', '自定义壁纸的落盘目录'));
    var side = el('div', 'wb-ctl-side');
    var path = el('span', 'wb-ctl-hint', '~/.we-wallpaper/custom');
    path.style.maxWidth = '220px';
    side.appendChild(path);
    side.appendChild(btn('更改', '', function () {
      window.alert('自定义壁纸目录固定为 ~/.we-wallpaper/custom\n(把含 project.json 的壁纸目录或 mp4/jpg 单文件放进去,再点「刷新」即入库)');
    }, '查看/说明存储位置'));
    row.appendChild(side);
    s.appendChild(row);

    var upRow = el('div', 'wb-row');
    var file = document.createElement('input');
    file.type = 'file'; file.accept = 'video/mp4,video/webm,image/*,.html,.htm';
    file.style.display = 'none';
    var upStat = el('span', 'muted', '支持 mp4 / webm / jpg / png / gif / html');
    upRow.appendChild(btn('⬆ 上传壁纸', '', function () { file.click(); }));
    upRow.appendChild(upStat);
    upRow.appendChild(file);
    s.appendChild(upRow);
    file.onchange = function () {
      var f = file.files[0];
      if (!f) return;
      upStat.textContent = '上传中… ' + f.name + '(' + Math.round(f.size / 1048576) + 'MB)';
      fetch(BASE + '/api/upload?filename=' + encodeURIComponent(f.name), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
      }).then(function (r) { return r.json(); })
        .then(function () { upStat.textContent = '已加入列表'; return loadData(); })
        .then(render)
        .catch(function () { upStat.textContent = '上传失败'; });
    };

    var customOnes = wallpapers.filter(function (x) { return String(x.id).indexOf('custom-') === 0; });
    if (customOnes.length) {
      var boxC = el('div', 'wb-box');
      boxC.textContent = '统计中…';
      s.appendChild(boxC);
      api('/api/custom-usage').then(function (u) {
        boxC.textContent = '';
        if (!u || !(u.items || []).length) { boxC.textContent = '没有自定义壁纸'; return; }
        boxC.appendChild(el('div', 'muted', '共 ' + u.items.length + ' 个 · 合计 ' + (u.totalBytes / 1048576).toFixed(1) + ' MB'));
        (u.items || []).forEach(function (it) {
          var r = el('div', 'wb-ctl');
          r.appendChild(ctlText(it.title, (it.bytes / 1048576).toFixed(1) + ' MB' + (it.current ? ' · 正在播放' : '')));
          var sd = el('div', 'wb-ctl-side');
          sd.appendChild(btn('移除', 'danger', function () {
            if (!window.confirm('删除「' + it.title + '」?文件将一并删除,不可恢复。')) return;
            api('/api/custom-delete', { id: it.id }).then(function () { return loadData(); }).then(render).catch(function () {});
          }));
          r.appendChild(sd);
          boxC.appendChild(r);
        });
      }).catch(function () { boxC.textContent = '用量统计不可用'; });
    }
  }

  // 5. 壁纸库网格(类型筛选 + 卡片 + 已隐藏恢复)
  function renderLibrarySection() {
    var s = section('壁纸库(' + availCount() + ' 张可用)');
    s.classList.add('wb-sec--library');
    var typeRow = el('div', 'wb-row');
    [['all', '全部'], ['scene', '场景'], ['video', '视频'], ['image', '图片'], ['web', '网页']].forEach(function (p) {
      typeRow.appendChild(btn(p[1], typeFilter === p[0] ? 'on' : '', function () { typeFilter = p[0]; render(); }));
    });
    s.appendChild(typeRow);

    if (!wallpapers.length) {
      var empty = el('div', 'wb-box');
      empty.innerHTML = '未找到任何壁纸。<br>排查:① 确认 Steam 已下载 Wallpaper Engine 创意工坊壁纸;<br>② 非默认库位置请在 ~/.we-wallpaper/state.json 的 workshopDirs 里追加后点「刷新」;<br>③ 或把含 project.json 的壁纸目录放进 ~/.we-wallpaper/custom 后点「刷新」;<br>④ 自定义单文件壁纸直接用上面的「上传壁纸」。';
      s.appendChild(empty);
      return;
    }
    var shown = wallpapers.filter(function (x) { return (typeFilter === 'all' || x.type === typeFilter) && !x.hidden; });
    var grid = el('div', 'grid');
    shown.forEach(function (wp) {
      var card = el('div', 'card' + (state.currentId === wp.id ? ' current' : '') + (wp.playable ? '' : ' dead'));
      if (wp.playable) {
        card.onclick = function () { api('/api/select', { id: wp.id }).then(setState); };
        card.onpointerenter = function () { preheat(wp); };
      }
      var img = el('img', 'thumb'); img.loading = 'lazy'; img.src = wp.preview || '';
      var name = el('div', 'name', wp.title);
      name.appendChild(el('span', 'badge', typeLabel(wp)));
      card.appendChild(img); card.appendChild(name);
      var hideB = btn('隐藏', '', function (ev) {
        ev.stopPropagation();
        api('/api/hide', { id: wp.id, hidden: true }).then(setState);
      }, '从清单和轮播里隐藏(正在播放的不打断);可在下方"已隐藏"里恢复');
      hideB.style.cssText = 'position:absolute;top:10px;right:10px;opacity:0;transition:opacity .15s;height:24px;font-size:11px;padding:0 8px;';
      card.onpointerenter = function () { preheat(wp); hideB.style.opacity = '.92'; };
      card.onpointerleave = function () { hideB.style.opacity = '0'; };
      card.appendChild(hideB);
      grid.appendChild(card);
    });
    s.appendChild(grid);

    var hiddenOnes = wallpapers.filter(function (x) { return x.hidden; });
    if (hiddenOnes.length) {
      var hs = section('已隐藏(' + hiddenOnes.length + ')');
      var hRow = el('div', 'wb-row');
      hiddenOnes.forEach(function (wp) {
        hRow.appendChild(btn('↺ ' + wp.title, '', function () {
          api('/api/hide', { id: wp.id, hidden: false }).then(setState);
        }, '恢复显示(回到清单与轮播)'));
      });
      hs.appendChild(hRow);
      hs.appendChild(el('div', 'muted', '隐藏 = 软删除:退出清单与轮播但不删文件;正在播放的那张不打断。'));
    }
  }

  // ── 外观 ─────────────────────────────────────────────────
  function renderLook() {
    // 主题模式
    var s1 = section('主题模式');
    segRow(s1, '明暗侧', '自动=按壁纸实测亮度翻转;深色/浅色=强制固定',
      [['auto', '自动'], ['dark', '深色'], ['light', '浅色']], state.appearance.themeMode || 'auto', function (v) {
        api('/api/appearance', { themeMode: v }).then(setState);
      });

    // 强调色
    var s2 = section('强调色');
    var acManual = /^#[0-9a-f]{6}$/i.test(state.appearance.accentColor || '');
    ctlRow(s2, '引用 / 链接强调色', acManual ? '手动:' + state.appearance.accentColor : '自动:按明暗侧选高对比色', function (side) {
      var acIn = document.createElement('input');
      acIn.type = 'color';
      acIn.value = acManual ? state.appearance.accentColor : '#a5b4ff';
      acIn.onchange = function () { api('/api/appearance', { accentColor: acIn.value }).then(setState); };
      side.appendChild(acIn);
      side.appendChild(btn(acManual ? '手动' : '自动', acManual ? '' : 'on', function () {
        api('/api/appearance', { accentColor: '' }).then(setState);
      }, '按明暗侧自动选高对比蓝(WCAG 4.5:1)'));
    });

    // 外观预设
    var s3 = section('外观预设');
    var presetRow = el('div', 'wb-row');
    s3.appendChild(presetRow);
    api('/api/presets').then(function (pr) {
      (pr.factory || []).forEach(function (f) {
        presetRow.appendChild(btn(f.name, '', function () {
          api('/api/presets/apply', { id: f.id }).then(setState);
        }, '玻璃 ' + f.patch.glassColor + ' · 透明度 ' + f.patch.glass + ' · 磨砂 ' + f.patch.blur + 'px · 亮度 ' + f.patch.brightness + '%'));
      });
      (pr.custom || []).forEach(function (c) {
        var wrap = el('span');
        wrap.style.display = 'inline-flex'; wrap.style.gap = '4px';
        wrap.appendChild(btn(c.name, '', function () { api('/api/presets/apply', { name: c.name }).then(setState); }));
        wrap.appendChild(btn('×', '', function () { api('/api/presets/delete', { name: c.name }).then(setState); }, '删除预设 ' + c.name));
        presetRow.appendChild(wrap);
      });
      var nameIn = document.createElement('input');
      nameIn.type = 'text'; nameIn.placeholder = '存当前…'; nameIn.style.width = '110px'; nameIn.style.flex = '0 0 auto';
      presetRow.appendChild(nameIn);
      presetRow.appendChild(btn('保存预设', 'primary', function () {
        var n = nameIn.value.trim() || ('我的预设 ' + new Date().toISOString().slice(5, 16).replace('T', ' '));
        api('/api/presets/save', { name: n }).then(setState);
      }, '把当前外观存为预设(最多 12 个)'));
      presetRow.appendChild(btn('导出', '', function () {
        api('/api/presets').then(function (p2) {
          var json = JSON.stringify({ weWallpaperPresets: 1, presets: p2.custom || [] }, null, 2);
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json);
          else window.prompt('复制以下 JSON:', json);
        });
      }, '把全部自定义预设复制为 JSON'));
      presetRow.appendChild(btn('导入', '', function () {
        var txt = window.prompt('粘贴预设 JSON:');
        if (!txt || !txt.trim()) return;
        var parsed;
        try { parsed = JSON.parse(txt); } catch (e) { window.alert('JSON 解析失败:' + e.message); return; }
        api('/api/presets/import', { presets: (parsed && parsed.presets) || parsed || [] }).then(function () { return loadData(); }).then(render).catch(function () {});
      }, '粘贴导出的 JSON,按名合并进自定义预设'));
    }).catch(function () {});
    s3.appendChild(el('div', 'muted', '点击即应用(玻璃颜色/透明度/磨砂/亮度/滤镜);不影响分区透明度与字体。'));

    // 壁纸滤镜
    var s4 = section('壁纸滤镜');
    var F = [['none', '无'], ['blur', '模糊'], ['grayscale', '黑白'], ['sepia', '怀旧'], ['vivid', '鲜艳'], ['warm', '暖调'], ['cool', '冷调'], ['invert', '反色'], ['brighten', '提亮'], ['darken', '压暗'], ['contrast', '高对比']];
    var fRow = el('div', 'wb-row');
    F.forEach(function (p) {
      fRow.appendChild(btn(p[1], (state.appearance.filter || 'none') === p[0] ? 'on' : '', function () {
        api('/api/appearance', { filter: p[0] }).then(setState);
      }));
    });
    s4.appendChild(fRow);

    // 画面微调
    var s5 = section('画面微调');
    sliderRow(s5, '画面亮度', '滤镜管风格,这里管程度;100% = 不动', state.appearance.bgBrightness != null ? state.appearance.bgBrightness : 100, 50, 150, function (v) { state.appearance.bgBrightness = v; api('/api/appearance', { bgBrightness: v }); });
    sliderRow(s5, '画面对比', '', state.appearance.bgContrast != null ? state.appearance.bgContrast : 100, 50, 150, function (v) { state.appearance.bgContrast = v; api('/api/appearance', { bgContrast: v }); });
    sliderRow(s5, '画面饱和', '', state.appearance.bgSaturate != null ? state.appearance.bgSaturate : 100, 0, 200, function (v) { state.appearance.bgSaturate = v; api('/api/appearance', { bgSaturate: v }); });

    // 壁纸透明度与暗化
    var s6 = section('壁纸透明度与暗化');
    sliderRow(s6, '壁纸透明度', '调低让壁纸融向深色底', state.appearance.opacity != null ? state.appearance.opacity : 100, 10, 100, function (v) { state.appearance.opacity = v; api('/api/appearance', { opacity: v }); });
    sliderRow(s6, '暗化层', '亮壁纸 + 浅色字看不清时优先用它', state.appearance.scrim != null ? state.appearance.scrim : 0, 0, 80, function (v) { state.appearance.scrim = v; api('/api/appearance', { scrim: v }); });

    // 光效
    var s7 = section('光效');
    switchRow(s7, '点击涟漪 / 光标拖尾', '画在壁纸上、界面之下;空闲零 CPU', !!state.fxEnabled, function (v) {
      api('/api/advanced', { fxEnabled: v }).then(setState);
    });
    ctlRow(s7, '光效配色', '', function (side) {
      side.appendChild(ctlSelect([['accent', '跟随强调色'], ['rainbow', '彩虹流转'], ['custom', '自定义颜色']], state.fxColorMode || 'accent', function (v) {
        api('/api/advanced', { fxColorMode: v }).then(setState);
      }));
      var fxIn = document.createElement('input');
      fxIn.type = 'color';
      fxIn.value = /^#[0-9a-f]{6}$/i.test(state.fxColor || '') ? state.fxColor : '#4f8cff';
      fxIn.onchange = function () { api('/api/advanced', { fxColor: fxIn.value, fxColorMode: 'custom' }).then(setState); };
      side.appendChild(fxIn);
    });

    // 智能可读性 + 描边
    var s8 = section('智能可读性');
    switchRow(s8, '按壁纸亮度自动翻转文字', '实测亮度:' + (state.luminance != null ? Math.round(state.luminance * 100) + '%' : '测量中…'),
      !!state.readability.auto, function (v) { api('/api/readability', { auto: v }).then(setState); });
    sliderRow(s8, '文字描边', '对抗亮壁纸上的浅色字', state.appearance.stroke, 0, 100, function (v) { state.appearance.stroke = v; api('/api/appearance', { stroke: v }); });

    // 文字颜色(分区)
    var s9 = section('文字颜色(分区独立)');
    [['主区(消息列表)', 'fontColor', '自动(随壁纸亮度)'], ['侧栏', 'fontColorSidebar', '跟随主区'], ['聊天框', 'fontColorComposer', '玻璃对比自动']].forEach(function (p) {
      var manual = /^#[0-9a-f]{6}$/i.test(state.appearance[p[1]] || '');
      var hint = p[2];
      ctlRow(s9, p[0], manual ? '手动 ' + state.appearance[p[1]] : hint, function (side) {
        var inp = document.createElement('input');
        inp.type = 'color';
        inp.value = manual ? state.appearance[p[1]] : '#eef1f6';
        inp.onchange = function () { var o = {}; o[p[1]] = inp.value; api('/api/appearance', o).then(setState); };
        side.appendChild(inp);
        side.appendChild(btn(manual ? '手动' : '自动', manual ? '' : 'on', function () {
          var o = {}; o[p[1]] = ''; api('/api/appearance', o).then(setState);
        }));
      });
    });

    // 玻璃透明度三档
    var s10 = section('界面玻璃透明度');
    sliderRow(s10, '主区背景', '', state.appearance.main, 0, 100, function (v) { state.appearance.main = v; api('/api/appearance', { main: v }); });
    sliderRow(s10, '行 / 面板', '', state.appearance.row, 0, 100, function (v) { state.appearance.row = v; api('/api/appearance', { row: v }); });
    sliderRow(s10, '侧栏', '', state.appearance.sidebar, 0, 100, function (v) { state.appearance.sidebar = v; api('/api/appearance', { sidebar: v }); });
    s10.appendChild(el('div', 'muted', '改动约 5 秒内自动应用到聊天窗口。'));

    // 字体与光标
    var s11 = section('字体');
    var fdl = document.createElement('datalist'); fdl.id = 'we-fonts';
    [['"Microsoft YaHei", sans-serif', '微软雅黑'], ['Consolas, monospace', 'Consolas'], ['KaiTi, serif', '楷体']].forEach(function (p) {
      var o = document.createElement('option'); o.value = p[0]; o.label = p[1]; fdl.appendChild(o);
    });
    api('/api/fonts').then(function (r) {
      (r.fonts || []).forEach(function (n) { var o = document.createElement('option'); o.value = '"' + n + '"'; fdl.appendChild(o); });
    }).catch(function () {});
    s11.appendChild(fdl);

    ctlRow(s11, '界面字体', '支持任意字体族写法,下拉列出本机全部字体', function (side) {
      var fIn = document.createElement('input');
      fIn.type = 'text'; fIn.style.width = '210px'; fIn.placeholder = '输入或选择…';
      fIn.value = state.appearance.fontFamily || '';
      fIn.setAttribute('list', 'we-fonts');
      fIn.onchange = function () { api('/api/appearance', { fontFamily: fIn.value.trim() }).then(setState); };
      side.appendChild(fIn);
      side.appendChild(btn('默认', '', function () { api('/api/appearance', { fontFamily: '' }).then(setState); }));
    });
    ctlRow(s11, '聊天框字体', '空 = 跟随界面字体', function (side) {
      var cIn = document.createElement('input');
      cIn.type = 'text'; cIn.style.width = '210px'; cIn.placeholder = '跟随界面字体…';
      cIn.value = state.appearance.fontFamilyComposer || '';
      cIn.setAttribute('list', 'we-fonts');
      cIn.onchange = function () { api('/api/appearance', { fontFamilyComposer: cIn.value.trim() }).then(setState); };
      side.appendChild(cIn);
      side.appendChild(btn('默认', '', function () { api('/api/appearance', { fontFamilyComposer: '' }).then(setState); }));
    });
    sliderRow(s11, '聊天框字号', '相对原生偏移', Number(state.appearance.fontSizeComposer || 0), -2, 8, function (v) {
      state.appearance.fontSizeComposer = v; api('/api/appearance', { fontSizeComposer: v });
    }, 'px');
    ctlRow(s11, '聊天框字重', '', function (side) {
      side.appendChild(ctlSelect([[0, '自动'], [300, '300 细'], [400, '400 常规'], [500, '500 中等'], [600, '600 半粗'], [700, '700 粗']], Number(state.appearance.fontWeightComposer || 0), function (v) {
        api('/api/appearance', { fontWeightComposer: Number(v) }).then(setState);
      }));
    });
    sliderRow(s11, '正文字号', '消息区段落/列表缩放;100 = 原生', state.appearance.chatTextScale != null ? state.appearance.chatTextScale : 100, 85, 140, function (v) {
      state.appearance.chatTextScale = v; api('/api/appearance', { chatTextScale: v });
    });
    switchRow(s11, '文字渲染优化', '细体抗锯齿 + 合字字距微调', !!state.appearance.fontSmooth, function (v) {
      api('/api/appearance', { fontSmooth: v }).then(setState);
    });

    // 光标
    var s12 = section('光标');
    ctlRow(s12, '光标样式', '', function (side) {
      side.appendChild(ctlSelect([['', '默认'], ['pointer', '手型'], ['crosshair', '十字'], ['text', '文本']], state.appearance.cursor || '', function (v) {
        api('/api/appearance', { cursor: v }).then(setState);
      }));
    });
    var caretManual = /^#[0-9a-f]{6}$/i.test(state.appearance.caretColor || '');
    ctlRow(s12, '光标颜色', caretManual ? '手动 ' + state.appearance.caretColor : '自动 = 跟随 ZCode 原生', function (side) {
      var ci = document.createElement('input');
      ci.type = 'color';
      ci.value = caretManual ? state.appearance.caretColor : '#ffffff';
      ci.onchange = function () { api('/api/appearance', { caretColor: ci.value }).then(setState); };
      side.appendChild(ci);
      side.appendChild(btn(caretManual ? '手动' : '自动', caretManual ? '' : 'on', function () {
        api('/api/appearance', { caretColor: '' }).then(setState);
      }));
    });

    // 壁纸与界面
    var s13 = section('壁纸与界面');
    sliderRow(s13, '壁纸亮度', '', state.appearance.brightness, 50, 160, function (v) { state.appearance.brightness = v; api('/api/appearance', { brightness: v }); });
    sliderRow(s13, '界面缩放', '', state.appearance.zoom, 80, 140, function (v) { state.appearance.zoom = v; api('/api/appearance', { zoom: v }); });
    segRow(s13, '填充方式', '下次切换壁纸生效', [['cover', '铺满'], ['contain', '完整'], ['stretch', '拉伸']], state.appearance.fit || 'cover', function (v) {
      api('/api/appearance', { fit: v }).then(setState);
    });
    switchRow(s13, '画面镜像', '水平翻转构图', !!state.appearance.flip, function (v) {
      api('/api/appearance', { flip: v }).then(setState);
    });

    // 聊天框玻璃
    var s14 = section('聊天框玻璃');
    sliderRow(s14, '磨砂(blur)', '玻璃背后的模糊半径', state.appearance.blur, 0, 40, function (v) { state.appearance.blur = v; api('/api/appearance', { blur: v }); }, 'px');
    var GLASS_PALETTE = ['#14161c', '#000000', '#2ec5d3', '#e79bb0', '#f0a04b', '#e8615a', '#f2f3f5', '#8ecf5a'];
    var curGlass = state.appearance.glassColor || '#14161c';
    var swRow = el('div', 'wb-ctl');
    swRow.appendChild(ctlText('玻璃颜色', '当前 ' + curGlass + ';浅色玻璃会自动切深色文字'));
    var swSide = el('div', 'wb-ctl-side');
    GLASS_PALETTE.forEach(function (c) {
      var b = document.createElement('button');
      b.title = c;
      b.style.cssText = 'width:24px;height:24px;border-radius:50%;padding:0;cursor:pointer;background:' + c
        + ';border:2px solid ' + (curGlass === c ? '#f2f3f5' : 'rgba(255,255,255,.22)') + ';';
      b.onclick = function () { api('/api/appearance', { glassColor: c }).then(setState); };
      swSide.appendChild(b);
    });
    var cc = document.createElement('input');
    cc.type = 'color'; cc.value = curGlass; cc.title = '自定义玻璃颜色';
    cc.onchange = function () { api('/api/appearance', { glassColor: cc.value }).then(setState); };
    swSide.appendChild(cc);
    swRow.appendChild(swSide);
    s14.appendChild(swRow);
    var darkManual = /^#[0-9a-f]{6}$/i.test(state.appearance.glassColorDark || '');
    ctlRow(s14, '深色壁纸玻璃色', darkManual ? '手动 ' + state.appearance.glassColorDark : '自动 = 与主玻璃色一致', function (side) {
      var di = document.createElement('input');
      di.type = 'color'; di.value = darkManual ? state.appearance.glassColorDark : curGlass;
      di.onchange = function () { api('/api/appearance', { glassColorDark: di.value }).then(setState); };
      side.appendChild(di);
      side.appendChild(btn(darkManual ? '手动' : '跟随', darkManual ? '' : 'on', function () {
        api('/api/appearance', { glassColorDark: '' }).then(setState);
      }));
    });
    sliderRow(s14, '玻璃透明度', '0 = 完全实心,100 = 最透', state.appearance.glass, 0, 100, function (v) { state.appearance.glass = v; api('/api/appearance', { glass: v }); });

    // 快速预设 + 重置
    var s15 = section('快速预设');
    var prow = el('div', 'wb-row');
    [['全透', { main: 0, row: 52, sidebar: 55 }], ['轻纱', { main: 30, row: 62, sidebar: 64 }], ['雾面', { main: 62, row: 76, sidebar: 78 }]].forEach(function (p) {
      prow.appendChild(btn(p[0], '', function () { api('/api/appearance', p[1]).then(setState); }));
    });
    prow.appendChild(btn('↺ 恢复默认外观', 'danger', function () {
      if (!window.confirm('把全部外观设置恢复为默认?当前外观可先「保存预设」留底。')) return;
      api('/api/appearance/reset', {}).then(setState);
    }, '外观九件套全部回出厂;轮播/省电等设置不受影响'));
    s15.appendChild(prow);
  }

  // ── 播放(切换过场之外:速率 / 帧率 / 倍速)──────────────────
  function renderPlay() {
    var s1 = section('播放速率与帧率');
    segRow(s1, '场景帧率上限', '下次切换壁纸生效', [[15, '15 fps'], [30, '30 fps'], [60, '60 fps']], state.sceneFps, function (v) {
      api('/api/advanced', { sceneFps: Number(v) }).then(setState);
    });
    segRow(s1, '视频帧率上限', '超出上限的视频自动转码降帧', [[0, '无限制'], [60, '60 fps'], [30, '30 fps']], Number(state.videoFpsCap || 0), function (v) {
      api('/api/advanced', { videoFpsCap: Number(v) }).then(setState);
    });
    segRow(s1, '视频倍速', '仅视频壁纸,即时生效', [[0.5, '0.5×'], [0.75, '0.75×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']], Number(state.videoRate || 1), function (v) {
      api('/api/advanced', { videoRate: Number(v) }).then(setState);
    });

    // 过场与轮播在壁纸库里也有,这里给出全量入口(保持原有可发现性)
    renderTransitionSection();
    renderRotationSection();

    var s2 = section('播放页');
    var row = el('div', 'wb-row');
    var a = document.createElement('a');
    a.href = '/'; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'btn'; a.textContent = '🎞 打开播放页';
    row.appendChild(a);
    s2.appendChild(row);
    s2.appendChild(el('div', 'muted', '播放页 / 是壁纸本体;工作台只负责控制,不显示壁纸画面。'));
  }

  // ── 系统 ─────────────────────────────────────────────────
  function renderSystem() {
    var s1 = section('遮挡与省电');
    segRow(s1, '遮挡暂停', '失焦/最小化时暂停壁纸动效', [['never', '从不'], ['hidden', '切走时'], ['focus', '失焦即停']], state.occlusion, function (v) {
      api('/api/advanced', { occlusion: v }).then(setState);
    });
    switchRow(s1, '电池供电自动暂停', '笔记本用电池且未充电时自动暂停(台式机等于不存在)', !!state.batteryPause, function (v) {
      api('/api/advanced', { batteryPause: v }).then(setState);
    });

    var s2 = section('内容分级过滤');
    switchRow(s2, '隐藏 R 级内容', '按 workshop 标签过滤', !!state.contentFilter, function (v) {
      api('/api/advanced', { contentFilter: v }).then(setState);
    });

    var s3 = section('场景失败记忆');
    var sfNames = Object.keys(state.sceneFailures || {});
    ctlRow(s3, '失败场景', sfNames.length ? '已记忆 ' + sfNames.length + ' 张,直接走视频降级' : '空(全部场景可尝试实时渲染)', function (side) {
      var b = btn('⟲ 重试(' + sfNames.length + ')', sfNames.length ? 'danger' : '', function () {
        api('/api/scene-retry', {}).then(setState);
      }, '清空失败记忆,重新尝试完整场景渲染');
      b.disabled = !sfNames.length;
      side.appendChild(b);
    });
    if (sfNames.length) {
      s3.appendChild(el('div', 'muted', sfNames.map(function (id) {
        var w2 = wallpapers.find(function (x) { return x.id === id; });
        return w2 ? w2.title : id;
      }).join('、').slice(0, 120)));
    }

    var s4 = section('媒体集成');
    switchRow(s4, '歌词跑马灯', 'Now Playing 播放时在聊天窗底部显示同步歌词', !!state.lyrics, function (v) {
      api('/api/advanced', { lyrics: v }).then(setState);
    });
    var npLine = el('div', 'muted', '正在读取系统媒体信息…');
    s4.appendChild(npLine);
    api('/api/nowplaying').then(function (np) {
      npLine.textContent = np && np.available && np.title
        ? 'Now Playing:' + np.title + (np.artist ? ' — ' + np.artist : '') + ' · ' + (np.status === 'playing' ? '播放中' : np.status)
        : 'Now Playing:当前没有正在播放的媒体';
    }).catch(function () { npLine.textContent = 'Now Playing:不可用'; });

    var s5 = section('WE 官方素材(localAssets)');
    var waLine = el('div', 'muted', '正在检测 Wallpaper Engine 素材目录…');
    s5.appendChild(waLine);
    api('/api/we-assets').then(function (wa) {
      waLine.textContent = (wa && wa.available)
        ? '✓ 已' + (wa.auto ? '自动检测' : '手动配置') + '素材目录(' + wa.textures + ' 张官方贴图):' + wa.dir
        : '未配置素材目录 —— 场景壁纸使用程序化复刻(观感近似)';
    }).catch(function () { waLine.textContent = '素材目录状态不可用'; });
    ctlRow(s5, '素材目录', '留空 = 自动探测 Steam 库;或填 WE 安装目录的 assets 路径', function (side) {
      var wi = document.createElement('input');
      wi.type = 'text'; wi.style.width = '220px';
      wi.placeholder = '自动探测…';
      if (state.weAssetsDir) wi.value = state.weAssetsDir;
      side.appendChild(wi);
      side.appendChild(btn('保存', 'primary', function () {
        api('/api/we-assets', { dir: wi.value.trim() || null }).then(setState).catch(function () {});
      }));
    });

    var s6 = section('注入状态');
    var injLine = el('div', 'muted', '正在读取注入轨道状态…');
    injLine.style.whiteSpace = 'pre-line';
    s6.appendChild(injLine);
    ctlRow(s6, '一键体检', '服务器/注入/备份/缓存/磁盘/最近异常', function (side) {
      var b = btn('⯮ 体检', '', function () {
        b.disabled = true; b.textContent = '体检中…';
        api('/api/doctor').then(function (r) {
          injLine.textContent = [
            '服务器: 运行 ' + r.server.uptimeMin + ' 分钟 · Node ' + r.server.node,
            '注入: fuse' + (r.inject.fuseIntegrity === true ? '已开启(asar 轨道停用)' : r.inject.fuseIntegrity === false ? '未开启 ✓' : '?')
              + ' · asar补丁' + (r.inject.asarMarked ? '在位 ✓' : '丢失')
              + ' · CDP挂 ' + ((r.inject.cdp && r.inject.cdp.attached) || []).length + ' 窗',
            '备份: 槽位' + (r.backups && r.backups.slot ? '✓' : '✗') + ' 全量' + (r.backups && r.backups.full ? '✓(' + r.backups.fullMB + 'MB)' : '✗'),
            '缓存: ' + r.cacheMB + 'MB · 磁盘余 ' + (r.diskFreeGB != null ? r.diskFreeGB + 'GB' : '?') + ' · 壁纸 ' + r.inventory + ' 张',
            '状态文件: ' + (r.stateOk ? '✓' : '✗ 损坏'),
            '最近异常: ' + ((r.recentIssues && r.recentIssues.length) ? r.recentIssues.map(function (e) { return e.kind; }).join(', ') : '无 ✓'),
          ].join('\n');
        }).catch(function () { injLine.textContent = '体检失败:服务器不可达'; })
          .then(function () { b.disabled = false; b.textContent = '⯮ 体检'; });
      });
      side.appendChild(b);
    });
    var autoZ = btn('…', '', function () {
      api('/api/autostart-zcode', { enabled: autoZ.dataset.on !== '1' }).then(function (r) {
        autoZ.dataset.on = r.enabled ? '1' : '';
        autoZ.classList.toggle('is-on', !!r.enabled);
        autoZ.classList.toggle('on', !!r.enabled);
        autoZ.textContent = r.enabled ? '● 开机带 CDP 启动 ZCode' : '○ 开机带 CDP 启动 ZCode';
      });
    }, '开机登录时自动带 CDP 调试端口启动 ZCode(注入的零改文件轨道,应用更新免疫)');
    ctlRow(s6, '开机自启 ZCode', 'CDP 轨道:应用更新免疫', function (side) { side.appendChild(autoZ); });
    api('/api/diag-log').then(function (d) {
      var inj = d.inject || {};
      var cdp = d.cdp || {};
      injLine.textContent = [
        'fuse 完整性校验:' + (inj.fuseIntegrity === true ? '已开启(asar 轨道被拦下)' : inj.fuseIntegrity === false ? '未开启 ✓' : '未知'),
        'asar 补丁:' + (inj.asarMarked === true ? '在位 ✓' : inj.asarMarked === false ? '丢失(看门狗 1 分钟内自动重打)' : '未知'),
        'CDP 轨道:' + (cdp.attached && cdp.attached.length ? '已挂 ' + cdp.attached.length + ' 窗口 ✓' : '空转'),
      ].join(' · ');
    }).catch(function () { injLine.textContent = '状态不可用'; });
    api('/api/autostart-zcode').then(function (r) {
      autoZ.dataset.on = r.enabled ? '1' : '';
      if (r.enabled) { autoZ.classList.add('is-on'); autoZ.classList.add('on'); autoZ.textContent = '● 开机带 CDP 启动 ZCode'; }
      else autoZ.textContent = '○ 开机带 CDP 启动 ZCode';
    }).catch(function () { autoZ.textContent = '开关不可用'; });

    var s7 = section('维护');
    ctlRow(s7, '重新扫描壁纸库', scanStatus || '删除或退订壁纸后点这里立即同步;平时每 5 秒也会自动同步', function (side) {
      var b = btn('⟳ 扫描', 'primary', function () {
        b.disabled = true;
        scanStatus = '正在扫描 Steam 工坊目录…';
        api('/api/scan', {}).then(function (r) {
          return loadData().then(function () {
            var bits = [];
            if (r && r.added) bits.push('新增 ' + r.added + ' 张');
            if (r && r.removed) bits.push('移除 ' + r.removed + ' 张');
            if (r && r.prunedCache) bits.push('清理缓存 ' + r.prunedCache + ' 项');
            scanStatus = '已扫描:共 ' + ((r && r.count) || wallpapers.length) + ' 张 · ' + (bits.length ? bits.join('，') : '没有变化');
            render();
          });
        }).catch(function () { scanStatus = '扫描失败:请确认壁纸服务器在运行'; render(); });
      });
      side.appendChild(b);
    });
  }

  // ── 扩展 ─────────────────────────────────────────────────
  function renderExt() {
    var s = section('扩展模块');
    var box = el('div', 'wb-box');
    box.appendChild(el('div', 'muted', '还没有可用的扩展模块。'));
    box.appendChild(el('div', 'muted', '扩展位预留给:自定义渲染器、第三方壁纸源、歌词/媒体插件。'));
    s.appendChild(box);
    var s2 = section('本地能力');
    ctlRow(s2, '播放页', '壁纸本体(iframe/独立窗口)', function (side) {
      var a = document.createElement('a');
      a.href = '/'; a.target = '_blank'; a.rel = 'noopener'; a.className = 'btn'; a.textContent = '打开 ↗';
      side.appendChild(a);
    });
    ctlRow(s2, '工作台 API', '控制面 HTTP 接口根地址', function (side) {
      side.appendChild(el('span', 'wb-ctl-hint', '127.0.0.1:7396'));
    });
  }

  // ── 关于 ─────────────────────────────────────────────────
  function renderAbout() {
    var s1 = section('📖 项目简介');
    s1.appendChild(el('div', 'muted', '把 Wallpaper Engine 的 Steam 创意工坊壁纸搬进 ZCode / DeepSeek Harness:'
      + '场景(实时渲染)、视频、图片、网页四类壁纸都能铺到聊天窗口底下,并提供玻璃磨砂、可读性、轮播等控制面。'));
    var s2 = section('⭐ 开源与支持');
    var row = el('div', 'wb-row');
    var repo = document.createElement('a');
    repo.href = 'https://github.com/xiahou001/zcode-wallpaper-xiao';
    repo.target = '_blank'; repo.rel = 'noopener'; repo.className = 'btn'; repo.textContent = 'GitHub 仓库 ↗';
    row.appendChild(repo);
    s2.appendChild(row);
    s2.appendChild(el('div', 'muted', 'WSK 心角 / zcode-wallpaper-xiao · 灵感与结构参考 elysia395/dsh-wallpaper-engine(MIT)。'));

    var s3 = section('健康摘要');
    var healthLine = el('div', 'muted', '正在读取体检摘要…');
    s3.appendChild(healthLine);
    api('/api/doctor').then(function (r) {
      healthLine.textContent = '服务器运行 ' + r.server.uptimeMin + ' 分钟 · Node ' + r.server.node
        + ' · asar 补丁' + (r.inject.asarMarked ? '在位 ✓' : '丢失')
        + ' · CDP ' + ((r.inject.cdp && r.inject.cdp.attached) || []).length + ' 窗'
        + ' · 缓存 ' + r.cacheMB + 'MB · 磁盘余 ' + (r.diskFreeGB != null ? r.diskFreeGB + 'GB' : '?');
    }).catch(function () { healthLine.textContent = '体检摘要不可用:服务器不可达'; });

    var s4 = section('状态');
    s4.appendChild(el('div', 'muted', '壁纸 ' + wallpapers.length + ' 张 · 轮播列表 ' + playlists.length + ' 个 · 当前 '
      + (cur() ? cur().title : '未启用') + ' · 服务器 127.0.0.1:7396'));
  }

  // ── 导航 ─────────────────────────────────────────────────
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.onclick = function () {
      page = b.dataset.page;
      editorName = editorIds = null;
      document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      content.parentNode.scrollTop = 0;
      render();
    };
  });
  // 模态宿主:Esc 关闭
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') parent.postMessage('we-wp-close', '*');
  });

  loadData(true).then(render).catch(function () { render(); });
  // ── 版本自刷新:工作台长期开着会错过服务器端的代码/样式更新 ──
  // ⚠ 双通道:内嵌浏览器环境实测会把可见页面的定时器整体冻结 ——
  // setInterval 只是主通道;输入事件(动鼠标/聚焦/可见性变化)另挂惰性通道。
  var wbVersion = null;
  var wbCheckBusy = false;
  var wbLastCheck = 0;
  function wbCheckVersion() {
    if (wbVersion === null || wbCheckBusy) return;
    if (Date.now() - wbLastCheck < 2500) return;
    wbCheckBusy = true;
    wbLastCheck = Date.now();
    fetch(BASE + '/api/version?wb=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        wbCheckBusy = false;
        if (wbVersion === null) { wbVersion = v.v; return; }
        if (v.v === wbVersion) return;
        var ae = null;
        try { ae = document.activeElement; } catch (e) {}
        var busy = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT');
        if (document.hidden || !busy) { wbVersion = v.v; location.reload(); }
      }).catch(function () { wbCheckBusy = false; });
  }
  (function () {
    var iv = setInterval(wbCheckVersion, 10000);
    if (iv.unref) iv.unref();
  })();
  ['pointermove', 'pointerdown', 'visibilitychange', 'focus', 'pageshow'].forEach(function (ev) {
    window.addEventListener(ev, wbCheckVersion, { passive: true });
  });
  // 状态轮询(打开期间保持同步)
  setInterval(function () {
    api('/api/state').then(function (s) {
      var a = Object.assign({}, s, { luminance: undefined });
      var b = Object.assign({}, state, { luminance: undefined });
      if (!panelDirty() && JSON.stringify(a) !== JSON.stringify(b)) { state = s; playlists = s.playlists || []; render(); }
    }).catch(function () {});
  }, 3000);
  var inventoryBusy = false;
  setInterval(function () {
    if (inventoryBusy || panelDirty()) return;
    inventoryBusy = true;
    Promise.all([api('/api/wallpapers'), api('/api/state')]).then(function (rs) {
      var next = rs[0].wallpapers || [];
      var oldKey = wallpapers.map(function (x) { return x.id + ':' + x.title + ':' + x.playable; }).join('|');
      var newKey = next.map(function (x) { return x.id + ':' + x.title + ':' + x.playable; }).join('|');
      if (oldKey !== newKey) { wallpapers = next; state = rs[1]; playlists = state.playlists || []; render(); }
    }).catch(function () {}).then(function () { inventoryBusy = false; });
  }, 5000);
  function panelDirty() { return editorName != null; }
})();

// version-bump probe
