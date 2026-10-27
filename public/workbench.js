/**
 * workbench.js — DSH 式壁纸工作台页面逻辑(独立页,也被聊天窗口模态引用)。
 * 左侧导航四个分区:壁纸 / 外观 / 轮播 / 高级;数据走壁纸服务器 HTTP API。
 */
(function () {
  var BASE = location.origin;
  var state = null, wallpapers = [], playlists = [];
  var page = 'wall';
  var typeFilter = 'all';          // 壁纸类型筛选(DSH typeFilter),跨 render 保留
  var editorName = null, editorIds = null;
  var scanStatus = '';              // "重新扫描"的结果提示,跨 render 保留
  var content = document.getElementById('content');

  // 通知宿主(ZCode 页面):外观变了,立刻重取样式。比等轮询快得多(通常 <50ms)。
  function notifyAppearance() {
    try { if (window.parent && window.parent !== window) window.parent.postMessage('we-wp-appearance', '*'); } catch (e) {}
  }
  function api(path, body) {
    // 超时保护:挂起的 POST 会让按钮永久无响应(=「换不动」);10s 后中止并抛错
    const ctrl = new AbortController();
    const kill = setTimeout(function () { ctrl.abort(); }, 10000);
    const p = fetch(BASE + path, body !== undefined ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    } : { signal: ctrl.signal }).finally(function () { clearTimeout(kill); });
    return p.then(function (r) {
      return r.json();
    }).then(function (data) {
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

  function render() {
    content.innerHTML = '';
    if (!state) { content.appendChild(el('div', 'loading', '壁纸服务器暂不可用 —— 请确认 we-wallpaper 服务器在运行')); return; }
    if (page === 'wall') renderWall();
    else if (page === 'look') renderLook();
    else if (page === 'rot') renderRot();
    else renderAdv();
  }

  // ── 壁纸 ─────────────────────────────────────────────────
  function renderWall() {
    content.appendChild(el('div', 'sec', '当前壁纸'));
    var w = cur();
    var hero = el('div', 'hero');
    var disc = el('img', 'disc' + (w && !state.paused ? ' spinning' : ''));   // 黑胶唱片效果
    disc.src = w && w.preview ? w.preview : '';
    hero.appendChild(disc);
    var info = el('div', 'info');
    if (w) {
      info.appendChild(el('div', 'name', w.title));
      info.appendChild(el('div', 'meta', typeLabel(w) + '壁纸 · ' + (state.paused ? '已暂停' : '播放中')));
    } else {
      info.appendChild(el('div', 'name', '壁纸未启用'));
      info.appendChild(el('div', 'meta', '从下方列表选择一张壁纸开始'));
    }
    hero.appendChild(info);
    var acts = el('div', 'acts');
    var closeBtn = el('button', 'btn danger', '关闭壁纸');
    closeBtn.onclick = function () { api('/api/close', {}).then(function (s) { state = s; render(); }); };
    acts.appendChild(closeBtn);
    hero.appendChild(acts);
    content.appendChild(hero);

    content.appendChild(el('div', 'sec', '播放控制'));
    var ctl = el('div', 'row');
    var pause = el('button', 'btn' + (state.paused ? ' on' : ''), state.paused ? '▶ 恢复播放' : '⏸ 暂停');
    pause.onclick = function () { api('/api/pause', { paused: !state.paused }).then(function (s) { state = s; render(); }); };
    var mute = el('button', 'btn', state.volume > 0 ? '🔊 音乐开' : '🔇 音乐关');
    mute.onclick = function () { api('/api/volume', { volume: state.volume > 0 ? 0 : 1 }).then(function (s) { state = s; render(); }); };
    ctl.appendChild(pause); ctl.appendChild(mute);
    content.appendChild(ctl);

    content.appendChild(el('div', 'sec', '自定义壁纸(上传图片 / 视频 / 单文件网页)'));
    var up = el('div', 'row');
    var file = document.createElement('input');
    file.type = 'file'; file.accept = 'video/mp4,video/webm,image/*,.html,.htm'; file.style.display = 'none';
    var upBtn = el('button', 'btn primary', '⬆ 上传壁纸');
    var upStat = el('span', 'muted', '支持 mp4 / webm / jpg / png / gif');
    upBtn.onclick = function () { file.click(); };
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
    up.appendChild(upBtn); up.appendChild(upStat); up.appendChild(file);
    content.appendChild(up);

    content.appendChild(el('div', 'sec', '内容分级过滤(源自 dsh-wallpaper-engine)'));
    var cfRow = el('div', 'row');
    var cf = el('button', 'btn' + (state.contentFilter ? ' on' : ''), state.contentFilter ? '● 已隐藏 R 级' : '○ 不过滤');
    cf.onclick = function () { api('/api/advanced', { contentFilter: !state.contentFilter }).then(function (s) { state = s; render(); }); };
    cfRow.appendChild(cf);
    content.appendChild(cfRow);
    content.appendChild(el('div', 'sec', '壁纸属性(当前壁纸的可调参数)'));
    var propsBox = el('div', 'plistbox');
    propsBox.id = 'wb-props';
    propsBox.textContent = '读取中…';
    content.appendChild(propsBox);
    if (cur()) {
      api('/api/props/' + cur().id).then(function (r) {
        var box = document.getElementById('wb-props');
        if (!box) return;
        box.textContent = '';
        var list = r.props || [];
        if (!list.length) { box.textContent = '这张壁纸没有可调参数'; return; }
        var toHex = function (v) {
          var m = /^([\d.]+) ([\d.]+) ([\d.]+)$/.exec(String(v));
          if (!m) return '#000000';
          var h = function (x) { var s = Math.round(Math.max(0, Math.min(1, Number(x))) * 255).toString(16); return s.length < 2 ? '0' + s : s; };
          return '#' + h(m[1]) + h(m[2]) + h(m[3]);
        };
        var toVec = function (hex) {
          var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
          return (parseInt(m[1], 16) / 255).toFixed(4) + ' ' + (parseInt(m[2], 16) / 255).toFixed(4) + ' ' + (parseInt(m[3], 16) / 255).toFixed(4);
        };
        var post = function (values) { api('/api/props/' + cur().id, { values: values }).catch(function () {}); };
        list.forEach(function (p) {
          var row = el('div', 'row');
          row.appendChild(el('label', null, p.text || p.name));
          if (p.type === 'color') {
            var c = document.createElement('input'); c.type = 'color'; c.value = toHex(p.value);
            c.onchange = function () { post({ name: toVec(c.value) }); };
            row.appendChild(c);
          } else if (p.type === 'bool') {
            var b = document.createElement('input'); b.type = 'checkbox'; b.checked = p.value === true || p.value === 1;
            b.onchange = function () { post({ name: b.checked }); };
            row.appendChild(b);
          } else if (p.type === 'slider') {
            var s = document.createElement('input'); s.type = 'range';
            s.min = p.min != null ? p.min : 0; s.max = p.max != null ? p.max : 100; s.step = p.step != null ? p.step : 1; s.value = Number(p.value) || 0;
            s.onchange = function () { post({ name: Number(s.value) }); };
            row.appendChild(s); row.appendChild(el('span', 'val', String(p.value)));
          } else if (p.type === 'combobox') {
            var sel = document.createElement('select');
            var opts = (p.options && p.options.values) || p.alts || [];
            var vals = Object.keys(opts);
            vals.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = (opts[v] && opts[v].text) || v; if (String(p.value) === v) o.selected = true; sel.appendChild(o); });
            sel.onchange = function () { post({ name: sel.value }); };
            row.appendChild(sel);
          } else {
            var tx = document.createElement('input'); tx.type = 'text'; tx.value = String(p.value);
            tx.onchange = function () { post({ name: tx.value }); };
            row.appendChild(tx);
          }
          box.appendChild(row);
        });
      }).catch(function () { var b = document.getElementById('wb-props'); if (b) b.textContent = '读取失败'; });
    }

    if (!wallpapers.length) {
      var empty = el('div', 'plistbox');
      empty.innerHTML = '未找到任何壁纸。<br>排查:① 确认 Steam 已下载 Wallpaper Engine 创意工坊壁纸;<br>② 非默认库位置请在 ~/.we-wallpaper/state.json 的 workshopDirs 里追加后点「扫描」;<br>③ 或把含 project.json 的壁纸目录放进 ~/.we-wallpaper/custom 后点「扫描」;<br>④ 自定义单文件壁纸直接用「上传壁纸」。';
      content.appendChild(empty);
    }

    content.appendChild(el('div', 'sec', '选择壁纸(' + wallpapers.filter(function (x) { return x.playable; }).length + ' 张可用)'));
    // 类型筛选(源自 DSH typeFilter):chips 即时过滤网格
    var typeRow = el('div', 'row');
    typeRow.style.flexWrap = 'wrap';
    [['all', '全部'], ['scene', '场景'], ['video', '视频'], ['image', '图片'], ['web', '网页']].forEach(function (p) {
      var b = el('button', 'btn' + (typeFilter === p[0] ? ' on' : ''), p[1]);
      b.onclick = function () { typeFilter = p[0]; render(); };
      typeRow.appendChild(b);
    });
    content.appendChild(typeRow);
    var shown = wallpapers.filter(function (x) { return typeFilter === 'all' || x.type === typeFilter; });
    var grid = el('div', 'grid');
    shown.forEach(function (wp) {
      var card = el('div', 'card' + (state.currentId === wp.id ? ' current' : '') + (wp.playable ? '' : ' dead'));
      if (wp.playable) { card.onclick = function () { api('/api/select', { id: wp.id }).then(function (s) { state = s; render(); }); }; card.onpointerenter = function () { preheat(wp); }; }
      var img = el('img', 'thumb'); img.loading = 'lazy'; img.src = wp.preview || '';
      var name = el('div', 'name', wp.title);
      name.appendChild(el('span', 'badge', typeLabel(wp)));
      card.appendChild(img); card.appendChild(name);
      grid.appendChild(card);
    });
    content.appendChild(grid);
  }

  // ── 外观 ─────────────────────────────────────────────────
  function slider(parent, label, value, min, max, oninput) {
    var row = el('div', 'row');
    row.appendChild(el('label', null, label));
    var inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.value = value;
    var val = el('span', 'val', value + '%');
    inp.oninput = function () { val.textContent = inp.value + '%'; oninput(Number(inp.value)); };
    row.appendChild(inp); row.appendChild(val);
    parent.appendChild(row);
  }
    function renderLook() {
      // ── 主题模式(自动=随壁纸亮度;深色/浅色强制)──
      content.appendChild(el('div', 'sec', '主题模式'));
      var tmRow = el('div', 'row');
      [['auto', '● 自动(随壁纸亮度)'], ['dark', '深色'], ['light', '浅色']].forEach(function (p) {
        var b = el('button', 'btn' + ((state.appearance.themeMode || 'auto') === p[0] ? ' on' : ''), p[1]);
        b.title = '自动=按壁纸实测亮度智能翻转;深色/浅色=强制整套配色(文字/玻璃基色/强调色联动)';
        b.onclick = function () { api('/api/appearance', { themeMode: p[0] }).then(function (s) { state = s; render(); }); };
        tmRow.appendChild(b);
      });
      content.appendChild(tmRow);
      content.appendChild(el('div', 'muted', '自动模式受「智能可读性」开关约束;强制模式立即固定明暗侧,换壁纸不再翻转。'));

      // ── 强调色(引用/链接等;自动=按明暗侧高对比蓝)──
      content.appendChild(el('div', 'sec', '强调色(引用/链接)'));
      var acRow = el('div', 'row');
      var acManual = /^#[0-9a-f]{6}$/i.test(state.appearance.accentColor || '');
      var acIn = document.createElement('input');
      acIn.type = 'color';
      acIn.value = acManual ? state.appearance.accentColor : '#a5b4ff';
      acIn.title = '引用标题/链接等强调文字的颜色';
      acIn.style.cssText = 'width:34px;height:26px;padding:0;border:0;background:transparent;cursor:pointer;';
      acIn.oninput = function () { state.appearance.accentColor = acIn.value; api('/api/appearance', { accentColor: acIn.value }); };
      acIn.onchange = function () { api('/api/appearance', { accentColor: acIn.value }).then(function (s) { state = s; render(); }); };
      acRow.appendChild(acIn);
      var acAuto = el('button', 'btn' + (acManual ? '' : ' on'), acManual ? '手动' : '● 自动(高对比)');
      acAuto.title = '按明暗侧自动选高对比蓝(WCAG 4.5:1)';
      acAuto.onclick = function () { api('/api/appearance', { accentColor: '' }).then(function (s) { state = s; render(); }); };
      acRow.appendChild(acAuto);
      content.appendChild(acRow);
      content.appendChild(el('div', 'muted', '自动档保证可读;手动选浅色字配浅底会看不清,属个人选择。'));

      // ── 外观预设(出厂七套蒸馏自 dsh-wallpaper-engine;自定义快照存服务器)──
      content.appendChild(el('div', 'sec', '外观预设(源自 dsh-wallpaper-engine 出厂方案)'));
      var presetRow = el('div', 'row');
      presetRow.style.flexWrap = 'wrap';
      api('/api/presets').then(function (pr) {
        (pr.factory || []).forEach(function (f) {
          var b = el('button', 'btn', f.name);
          b.title = '玻璃 ' + f.patch.glassColor + ' · 透明度 ' + f.patch.glass + ' · 磨砂 ' + f.patch.blur + 'px · 亮度 ' + f.patch.brightness + '%' + (f.patch.filter !== 'none' ? ' · 鲜艳滤镜' : '');
          b.onclick = function () { api('/api/presets/apply', { id: f.id }).then(function (s) { state = s; render(); }); };
          presetRow.appendChild(b);
        });
        (pr.custom || []).forEach(function (c) {
          var b = el('button', 'btn', c.name);
          b.onclick = function () { api('/api/presets/apply', { name: c.name }).then(function (s) { state = s; render(); }); };
          presetRow.appendChild(b);
          var del = el('button', 'btn', '×');
          del.title = '删除预设 ' + c.name;
          del.onclick = function () { api('/api/presets/delete', { name: c.name }).then(function (s) { state = s; render(); }); };
          presetRow.appendChild(del);
        });
        var nameIn = document.createElement('input');
        nameIn.type = 'text'; nameIn.placeholder = '存当前…'; nameIn.style.width = '96px';
        var saveB = el('button', 'btn primary', '保存预设');
        saveB.onclick = function () {
          var n = nameIn.value.trim() || ('我的预设 ' + new Date().toISOString().slice(5, 16).replace('T', ' '));
          api('/api/presets/save', { name: n }).then(function (s) { state = s; render(); });
        };
        presetRow.appendChild(nameIn); presetRow.appendChild(saveB);
        // 导出/导入:JSON 经剪贴板/文本框往返,换机迁移或分享用
        var expB = el('button', 'btn', '导出');
        expB.title = '把全部自定义预设复制为 JSON(剪贴板)';
        expB.onclick = function () {
          api('/api/presets').then(function (pr) {
            var json = JSON.stringify({ weWallpaperPresets: 1, presets: pr.custom || [] }, null, 2);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(json).then(function () { expB.textContent = '已复制'; setTimeout(function () { expB.textContent = '导出'; }, 1500); });
            } else { window.prompt('复制以下 JSON:', json); }
          });
        };
        presetRow.appendChild(expB);
        var impB = el('button', 'btn', '导入');
        impB.title = '粘贴导出的 JSON,按名合并进自定义预设';
        impB.onclick = function () {
          var txt = window.prompt('粘贴预设 JSON:');
          if (!txt || !txt.trim()) return;
          var parsed;
          try { parsed = JSON.parse(txt); } catch (e) { window.alert('JSON 解析失败:' + e.message); return; }
          api('/api/presets/import', { presets: (parsed && parsed.presets) || parsed || [] }).then(function (r) {
            impB.textContent = '导入 ' + (r.merged || 0) + ' 条';
            setTimeout(function () { impB.textContent = '导入'; }, 1800);
            return loadData();
          }).then(function () { render(); }).catch(function () {});
        };
        presetRow.appendChild(impB);
      }).catch(function () {});
      content.appendChild(presetRow);
      content.appendChild(el('div', 'muted', '点击即应用(玻璃颜色/透明度/磨砂/亮度/滤镜五个字段);不影响分区透明度与字体。调好后可存为自己的预设,最多 12 个。'));

      // ── 壁纸滤镜(源自 dsh-wallpaper-engine 效果白名单)──
      content.appendChild(el('div', 'sec', '壁纸滤镜'));
      var fRow = el('div', 'row');
      fRow.style.flexWrap = 'wrap';
      [['none', '无'], ['blur', '模糊'], ['grayscale', '黑白'], ['sepia', '怀旧'], ['vivid', '鲜艳'], ['warm', '暖调'], ['cool', '冷调'], ['invert', '反色'], ['brighten', '提亮'], ['darken', '压暗'], ['contrast', '高对比']].forEach(function (p) {
        var b = el('button', 'btn' + ((state.appearance.filter || 'none') === p[0] ? ' on' : ''), p[1]);
        b.onclick = function () { api('/api/appearance', { filter: p[0] }).then(function (s) { state = s; render(); }); };
        fRow.appendChild(b);
      });
      content.appendChild(fRow);
      content.appendChild(el('div', 'muted', '对壁纸画面整体生效:场景壁纸走渲染引擎通道,视频/图片/web 走 CSS;聊天窗口内同样生效。'));

      content.appendChild(el('div', 'sec', '智能可读性(源自 dsh-wallpaper-engine 的主题跟随)'));
      var rr = el('div', 'row');
      var rbtn = el('button', 'btn' + (state.readability.auto ? ' on' : ''), state.readability.auto ? '● 已开启' : '○ 已关闭');
      rbtn.title = '按壁纸实测亮度自动切换文字颜色:亮壁纸→深色文字+浅玻璃,暗壁纸→浅色文字+深玻璃';
      rbtn.onclick = function () { api('/api/readability', { auto: !state.readability.auto }).then(function (s) { state = s; render(); }); };
      rr.appendChild(rbtn);
      rr.appendChild(el('span', 'muted', '实测亮度:' + (state.luminance != null ? Math.round(state.luminance * 100) + '%' : '测量中…')));
      content.appendChild(rr);

      content.appendChild(el('div', 'sec', '文字描边(对抗亮壁纸上的浅色字)'));
      slider(content, '描边强度', state.appearance.stroke, 0, 100, function (v) { state.appearance.stroke = v; api('/api/appearance', { stroke: v }); });

      // ── 文字颜色:主区 / 侧栏 / 聊天框分区独立(DSH 字体集 themeColors 思路)──
      content.appendChild(el('div', 'sec', '文字颜色(分区独立)'));
      function fcObj(k, v) { var o = {}; o[k] = v; return o; }
      function fcZoneRow(label, key, autoLabel, autoTitle) {
        var row = el('div', 'row');
        row.appendChild(el('label', null, label));
        var manual = /^#[0-9a-f]{6}$/i.test(state.appearance[key] || '');
        var inp = document.createElement('input');
        inp.type = 'color';
        inp.value = manual ? state.appearance[key] : '#eef1f6';
        inp.title = '选一个颜色 = ' + label + '手动着色';
        inp.style.cssText = 'width:34px;height:26px;padding:0;border:0;background:transparent;cursor:pointer;';
        inp.oninput = function () { state.appearance[key] = inp.value; api('/api/appearance', fcObj(key, inp.value)); };
        inp.onchange = function () { api('/api/appearance', fcObj(key, inp.value)).then(function (s) { state = s; render(); }); };
        row.appendChild(inp);
        var auto = el('button', 'btn' + (manual ? '' : ' on'), manual ? '手动' : autoLabel);
        auto.title = autoTitle;
        auto.onclick = function () { api('/api/appearance', fcObj(key, '')).then(function (s) { state = s; render(); }); };
        row.appendChild(auto);
        content.appendChild(row);
      }
      fcZoneRow('主区(消息列表)', 'fontColor', '● 自动(随壁纸亮度)', '按壁纸亮度自动深浅翻转');
      fcZoneRow('侧栏', 'fontColorSidebar', '● 跟随主区', '与主区文字同色');
      fcZoneRow('聊天框', 'fontColorComposer', '● 玻璃对比自动', '按玻璃颜色明暗自动深浅');
      content.appendChild(el('div', 'muted', '每区独立配色:主区默认随壁纸亮度翻转,侧栏默认跟随主区,聊天框默认按玻璃明暗自动;选色即手动,点自动恢复。改动约 5 秒内生效。'));

      content.appendChild(el('div', 'sec', '界面玻璃透明度(改动约 5 秒内自动应用到聊天窗口)'));
      slider(content, '主区背景', state.appearance.main, 0, 100, function (v) { state.appearance.main = v; api('/api/appearance', { main: v }); });
      slider(content, '行 / 面板', state.appearance.row, 0, 100, function (v) { state.appearance.row = v; api('/api/appearance', { row: v }); });
      slider(content, '侧栏', state.appearance.sidebar, 0, 100, function (v) { state.appearance.sidebar = v; api('/api/appearance', { sidebar: v }); });

      content.appendChild(el('div', 'sec', '字体与光标'));
      var ffRow = el('div', 'row');
      ffRow.appendChild(el('label', null, '界面字体'));
      var fIn = document.createElement('input');
      fIn.type = 'text';
      fIn.placeholder = '输入或从本机字体中选择…';
      fIn.style.flex = '1';
      fIn.value = state.appearance.fontFamily || '';
      // 系统字体清单(源自 DSH system-fonts:宿主枚举、界面只信回包)+ 常用预设
      var fdl = document.createElement('datalist'); fdl.id = 'we-fonts';
      [['"Microsoft YaHei", sans-serif', '微软雅黑'], ['Consolas, monospace', 'Consolas'], ['KaiTi, serif', '楷体']].forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.label = p[1]; fdl.appendChild(o);
      });
      api('/api/fonts').then(function (r) {
        (r.fonts || []).forEach(function (n) {
          var o = document.createElement('option'); o.value = '"' + n + '"'; fdl.appendChild(o);
        });
      }).catch(function () {});
      fIn.setAttribute('list', 'we-fonts');
      fIn.onchange = function () { api('/api/appearance', { fontFamily: fIn.value.trim() }).then(function (s) { state = s; render(); }); };
      ffRow.appendChild(fIn);
      var fDef = el('button', 'btn', '默认');
      fDef.title = '清空自定义字体,回到系统默认';
      fDef.onclick = function () { api('/api/appearance', { fontFamily: '' }).then(function (s) { state = s; render(); }); };
      ffRow.appendChild(fDef);
      content.appendChild(ffRow);
      content.appendChild(fdl);
      content.appendChild(el('div', 'muted', '支持任意字体族写法(如 "Microsoft YaHei", sans-serif);下拉列出本机全部已装字体,取不到清单时仍可手输。'));
      var curRow = el('div', 'row');
      curRow.appendChild(el('label', null, '光标样式'));
      var cSel = document.createElement('select');
      [['', '默认'], ['pointer', '手型'], ['crosshair', '十字'], ['text', '文本']].forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1];
        if ((state.appearance.cursor || '') === p[0]) o.selected = true;
        cSel.appendChild(o);
      });
      cSel.onchange = function () { api('/api/appearance', { cursor: cSel.value }).then(function (s) { state = s; render(); }); };
      curRow.appendChild(cSel);
      content.appendChild(curRow);

      content.appendChild(el('div', 'sec', '壁纸与界面'));
      slider(content, '壁纸亮度', state.appearance.brightness, 50, 160, function (v) { state.appearance.brightness = v; api('/api/appearance', { brightness: v }); });
      slider(content, '界面缩放', state.appearance.zoom, 80, 140, function (v) { state.appearance.zoom = v; api('/api/appearance', { zoom: v }); });
      // 填充方式(源自 DSH objectFit):视频/图片 object-fit + 场景渲染器 fit
      var fitRow = el('div', 'row');
      fitRow.appendChild(el('label', null, '填充方式'));
      [['cover', '铺满(裁边)'], ['contain', '完整显示(留边)'], ['stretch', '拉伸填满']].forEach(function (p) {
        var b = el('button', 'btn' + ((state.appearance.fit || 'cover') === p[0] ? ' on' : ''), p[1]);
        b.title = '壁纸画面的填充方式;改动会在下次切换壁纸时生效';
        b.onclick = function () { api('/api/appearance', { fit: p[0] }).then(function (s) { state = s; render(); }); };
        fitRow.appendChild(b);
      });
      content.appendChild(fitRow);
      // 画面镜像(源自 DSH flip):舞台整体水平翻转
      var flipRow = el('div', 'row');
      flipRow.appendChild(el('label', null, '画面镜像'));
      var flipB = el('button', 'btn' + (state.appearance.flip ? ' on' : ''), state.appearance.flip ? '● 已镜像(水平翻转)' : '○ 正常');
      flipB.title = '壁纸画面水平翻转(构图反向);对场景/视频/图片同时生效';
      flipB.onclick = function () { api('/api/appearance', { flip: !state.appearance.flip }).then(function (s) { state = s; render(); }); };
      flipRow.appendChild(flipB);
      content.appendChild(flipRow);
      slider(content, '聊天框磨砂(blur)', state.appearance.blur, 0, 40, function (v) { state.appearance.blur = v; api('/api/appearance', { blur: v }); });
      // 聊天框玻璃颜色:与 ZCode 的 Wallpaper Engine 设置页同一形式(色板 + 自定义取色)
      var swRow = el('div', 'row');
      swRow.appendChild(el('label', null, '聊天框玻璃颜色'));
      var GLASS_PALETTE = ['#14161c', '#000000', '#2ec5d3', '#e79bb0', '#f0a04b', '#e8615a', '#f2f3f5', '#8ecf5a'];
      var curGlass = state.appearance.glassColor || '#14161c';
      GLASS_PALETTE.forEach(function (c) {
        var b = document.createElement('button');
        b.title = c;
        b.style.cssText = 'width:26px;height:26px;border-radius:50%;padding:0;cursor:pointer;background:' + c
          + ';border:2px solid ' + (curGlass === c ? '#f2f3f5' : 'rgba(255,255,255,.22)') + ';';
        b.onclick = function () { api('/api/appearance', { glassColor: c }).then(function (s) { state = s; render(); }); };
        swRow.appendChild(b);
      });
      var customColor = document.createElement('input');
      customColor.type = 'color';
      customColor.value = curGlass;
      customColor.title = '自定义玻璃颜色';
      customColor.style.cssText = 'width:34px;height:26px;padding:0;border:0;background:transparent;cursor:pointer;';
      customColor.oninput = function () { state.appearance.glassColor = customColor.value; api('/api/appearance', { glassColor: customColor.value }); };
      customColor.onchange = function () { api('/api/appearance', { glassColor: customColor.value }).then(function (s) { state = s; render(); }); };
      swRow.appendChild(customColor);
      content.appendChild(swRow);
      content.appendChild(el('div', 'muted', '当前玻璃颜色 ' + curGlass + ';浅色玻璃会自动切换成深色文字。'));
      slider(content, '聊天框玻璃透明度', state.appearance.glass, 0, 100, function (v) { state.appearance.glass = v; api('/api/appearance', { glass: v }); });
      content.appendChild(el('div', 'muted', '玻璃透明度:0 = 完全实心,100 = 最透(最能看清壁纸)。改动约 5 秒内自动应用,不需要重启 ZCode。'));

      content.appendChild(el('div', 'sec', '快速预设'));
      var presets = el('div', 'row');
      [['全透', { main: 0, row: 52, sidebar: 55 }], ['轻纱', { main: 30, row: 62, sidebar: 64 }], ['雾面', { main: 62, row: 76, sidebar: 78 }]].forEach(function (p) {
        var b = el('button', 'btn', p[0]);
        b.onclick = function () { api('/api/appearance', p[1]).then(function (s) { state = s; render(); }); };
        presets.appendChild(b);
      });
      var sp = el('span', null, ''); sp.style.flex = '1';
      presets.appendChild(sp);
      var resetB = el('button', 'btn', '↺ 恢复默认外观');
      resetB.title = '外观九件套(玻璃/文字/滤镜/填充/主题模式/强调色等)全部回出厂;轮播/省电等设置不受影响';
      resetB.onclick = function () {
        if (!window.confirm('把全部外观设置恢复为默认?当前外观可先「保存预设」留底。')) return;
        api('/api/appearance/reset', {}).then(function (s) { state = s; render(); });
      };
      presets.appendChild(resetB);
      content.appendChild(presets);
    }

  // ── 轮播 ─────────────────────────────────────────────────
  function renderRot() {
    content.appendChild(el('div', 'sec', '自动轮转'));
    var row = el('div', 'row');
    var rot = el('button', 'btn' + (state.rotate.enabled ? ' on' : ''), state.rotate.enabled ? '● 轮转中' : '○ 已关闭');
    rot.onclick = function () {
      api('/api/rotate', { enabled: !state.rotate.enabled, intervalMin: state.rotate.intervalMin, playlist: state.rotate.playlist })
        .then(function (s) { state = s; render(); });
    };
    row.appendChild(rot);
    var rnd = el('button', 'btn' + (state.rotate.random ? ' on' : ''), state.rotate.random ? '● 随机顺序' : '○ 顺序轮换');
    rnd.title = '随机=每次从池里抽一张(排除当前);顺序=按列表依次';
    rnd.onclick = function () { api('/api/rotate', { enabled: state.rotate.enabled, intervalMin: state.rotate.intervalMin, playlist: state.rotate.playlist, random: !state.rotate.random }).then(function (s) { state = s; render(); }); };
    row.appendChild(rnd);
    var sel = document.createElement('select');
    [15, 30, 60, 120].forEach(function (m) {
      var o = document.createElement('option');
      o.value = m; o.textContent = m + ' 分钟';
      if (state.rotate.intervalMin === m) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      api('/api/rotate', { enabled: state.rotate.enabled, intervalMin: Number(sel.value), playlist: state.rotate.playlist })
        .then(function (s) { state = s; render(); });
    };
    row.appendChild(sel);
    content.appendChild(row);

    content.appendChild(el('div', 'sec', '轮播列表'));
    var prow = el('div', 'row');
    var psel = document.createElement('select');
    var none = document.createElement('option'); none.value = ''; none.textContent = '— 全部壁纸 —';
    psel.appendChild(none);
    playlists.forEach(function (p) {
      var o = document.createElement('option'); o.value = p.name; o.textContent = p.name + ' (' + p.ids.length + ' 张)';
      if (state.rotate.playlist === p.name) o.selected = true;
      psel.appendChild(o);
    });
    psel.onchange = function () {
      api('/api/rotate', { enabled: state.rotate.enabled, intervalMin: state.rotate.intervalMin, playlist: psel.value || null })
        .then(function (s) { state = s; render(); });
    };
    prow.appendChild(psel);
    var newBtn = el('button', 'btn primary', '新建列表');
    newBtn.onclick = function () {
      editorName = '轮播 ' + new Date().toISOString().slice(5, 16).replace('T', ' ');
      editorIds = null; render();
    };
    prow.appendChild(newBtn);
    var delBtn = el('button', 'btn danger', '删除当前');
    delBtn.onclick = function () {
      if (!state.rotate.playlist) return;
      api('/api/playlists/delete', { name: state.rotate.playlist }).then(function (s) { state = s; return loadData(); }).then(render);
    };
    prow.appendChild(delBtn);
    content.appendChild(prow);

    if (editorName != null) {
      content.appendChild(el('div', 'sec', '编辑:' + editorName));
      var nameRow = el('div', 'row');
      var nameIn = document.createElement('input');
      nameIn.type = 'text'; nameIn.value = editorName;
      nameRow.appendChild(nameIn);
      content.appendChild(nameRow);
      var box = el('div', 'plistbox');
      wallpapers.forEach(function (w) {
        if (!w.playable) return;
        var c = el('label', 'chk');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = editorIds ? editorIds.indexOf(w.id) >= 0 : true;
        cb.onchange = function () {
          editorIds = editorIds || wallpapers.filter(function (x) { return x.playable; }).map(function (x) { return x.id; });
          if (cb.checked) { if (editorIds.indexOf(w.id) < 0) editorIds.push(w.id); }
          else editorIds = editorIds.filter(function (x) { return x !== w.id; });
        };
        var img = el('img'); img.src = w.preview || '';
        c.appendChild(cb); c.appendChild(img);
        c.appendChild(el('span', 'n', w.title));
        box.appendChild(c);
      });
      content.appendChild(box);
      // 已选顺序(轮换按此顺序执行;随机模式除外):↑↓ 调整,✕ 移除
      if (editorIds && editorIds.length) {
        content.appendChild(el('div', 'sec', '已选顺序(轮换按此顺序)'));
        editorIds.forEach(function (id, i2) {
          var w2 = wallpapers.find(function (x) { return x.id === id; });
          var orow = el('div', 'row');
          orow.appendChild(el('span', null, (i2 + 1) + '. ' + (w2 ? w2.title : id)));
          var sp2 = el('span', null, ''); sp2.style.flex = '1';
          orow.appendChild(sp2);
          var up = el('button', 'btn', '↑');
          up.disabled = i2 === 0;
          up.onclick = function () { var t = editorIds[i2 - 1]; editorIds[i2 - 1] = editorIds[i2]; editorIds[i2] = t; render(); };
          orow.appendChild(up);
          var dn = el('button', 'btn', '↓');
          dn.disabled = i2 === editorIds.length - 1;
          dn.onclick = function () { var t = editorIds[i2 + 1]; editorIds[i2 + 1] = editorIds[i2]; editorIds[i2] = t; render(); };
          orow.appendChild(dn);
          var rm = el('button', 'btn danger', '✕');
          rm.title = '从列表移除';
          rm.onclick = function () { editorIds = editorIds.filter(function (x) { return x !== id; }); render(); };
          orow.appendChild(rm);
          content.appendChild(orow);
        });
      }
      var srow = el('div', 'row');
      var save = el('button', 'btn primary', '保存列表');
      save.onclick = function () {
        var nm = nameIn.value.trim() || editorName;
        api('/api/playlists', { name: nm, ids: editorIds || wallpapers.filter(function (x) { return x.playable; }).map(function (x) { return x.id; }) })
          .then(function (s) { state = s; return loadData(); })
          .then(function () { editorName = editorIds = null; render(); });
      };
      srow.appendChild(save);
      var cancel = el('button', 'btn', '取消');
      cancel.onclick = function () { editorName = editorIds = null; render(); };
      srow.appendChild(cancel);
      content.appendChild(srow);
    } else {
      content.appendChild(el('div', 'muted', state.rotate.playlist
        ? '当前使用列表:' + state.rotate.playlist
        : '未选择列表 = 在全部可播壁纸中轮转'));
    }
  }

  // ── 高级 ─────────────────────────────────────────────────
    function renderAdv() {
      content.appendChild(el('div', 'sec', '切换过场(交叉淡化)'));
      var row = el('div', 'row');
      [['无', 0], ['快 600ms', 600], ['标准 1800ms', 1800], ['慢 3000ms', 3000]].forEach(function (p) {
        var b = el('button', 'btn' + (state.transition.ms === p[1] ? ' on' : ''), p[0]);
        b.onclick = function () { api('/api/transition', { ms: p[1] }).then(function (s) { state = s; render(); }); };
        row.appendChild(b);
      });
      content.appendChild(row);
      var kindRow = el('div', 'row');
      kindRow.appendChild(el('label', null, '过场动画'));
      var ksel = document.createElement('select');
      [['crossfade', '交叉淡化'], ['push', '推移'], ['wipe', '擦除'], ['iris', '光圈'], ['zoom', '缩放'], ['blinds', '百叶窗'], ['none', '无']].forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1];
        if ((state.transition.kind || 'crossfade') === p[0]) o.selected = true;
        ksel.appendChild(o);
      });
      ksel.onchange = function () { api('/api/transition', { kind: ksel.value, ms: state.transition.ms, dir: state.transition.dir || 'left' }).then(function (s) { state = s; render(); }); };
      kindRow.appendChild(ksel);
      content.appendChild(kindRow);
      // 过场方向(源自 DSH switchTransitionDir):对推移/擦除生效
      var dirRow = el('div', 'row');
      dirRow.appendChild(el('label', null, '过场方向'));
      var dsel = document.createElement('select');
      [['left', '从右进入'], ['right', '从左进入'], ['up', '从下进入'], ['down', '从上进入']].forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1];
        if ((state.transition.dir || 'left') === p[0]) o.selected = true;
        dsel.appendChild(o);
      });
      dsel.onchange = function () { api('/api/transition', { kind: state.transition.kind, ms: state.transition.ms, dir: dsel.value }).then(function (s) { state = s; render(); }); };
      dirRow.appendChild(dsel);
      content.appendChild(dirRow);
      content.appendChild(el('div', 'muted', '换壁纸时按所选过场切换,当前 ' + state.transition.ms + ' ms'));

      content.appendChild(el('div', 'sec', '省电(源自 dsh-wallpaper-engine)'));
      var fpsRow = el('div', 'row');
      fpsRow.appendChild(el('label', null, '场景帧率上限'));
      [15, 30, 60].forEach(function (f) {
        var b = el('button', 'btn' + (state.sceneFps === f ? ' on' : ''), f + ' fps');
        b.onclick = function () { api('/api/advanced', { sceneFps: f }).then(function (s) { state = s; render(); }); };
        fpsRow.appendChild(b);
      });
      content.appendChild(fpsRow);
      var vfRow = el('div', 'row');
      vfRow.appendChild(el('label', null, '视频帧率上限'));
      [[0, '无限制'], [60, '60 fps'], [30, '30 fps']].forEach(function (p) {
        var b = el('button', 'btn' + (Number(state.videoFpsCap || 0) === p[0] ? ' on' : ''), p[1]);
        b.title = '源帧率高于上限的视频壁纸自动转码降帧,降低 GPU 解码占用;转码后台进行,下次切换生效';
        b.onclick = function () { api('/api/advanced', { videoFpsCap: p[0] }).then(function (s) { state = s; render(); }); };
        vfRow.appendChild(b);
      });
      content.appendChild(vfRow);
      var occRow = el('div', 'row');
      occRow.appendChild(el('label', null, '遮挡暂停'));
      [['never', '从不'], ['hidden', '切走/最小化时'], ['focus', '失焦即停']].forEach(function (p) {
        var b = el('button', 'btn' + (state.occlusion === p[0] ? ' on' : ''), p[1]);
        b.onclick = function () { api('/api/advanced', { occlusion: p[0] }).then(function (s) { state = s; render(); }); };
        occRow.appendChild(b);
      });
      content.appendChild(occRow);
      // 视频倍速(源自 DSH playbackRate):视频壁纸专属
      var rateRow = el('div', 'row');
      rateRow.appendChild(el('label', null, '视频倍速'));
      [[0.5, '0.5×'], [0.75, '0.75×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']].forEach(function (p) {
        var b = el('button', 'btn' + (Number(state.videoRate || 1) === p[0] ? ' on' : ''), p[1]);
        b.title = '视频壁纸的播放速度(慢放看清细节/加速省资源);场景与网页壁纸不适用';
        b.onclick = function () { api('/api/advanced', { videoRate: p[0] }).then(function (s) { state = s; render(); }); };
        rateRow.appendChild(b);
      });
      content.appendChild(rateRow);
      // 电池省电(源自 DSH pauseOnBattery):用电池且未充电时自动暂停
      var batRow = el('div', 'row');
      var bat = el('button', 'btn' + (state.batteryPause ? ' on' : ''), state.batteryPause ? '● 电池供电自动暂停已开启' : '○ 电池供电自动暂停已关闭');
      bat.title = '笔记本用电池且未充电时自动暂停壁纸(台式机无电池,开关等于不存在)';
      bat.onclick = function () { api('/api/advanced', { batteryPause: !state.batteryPause }).then(function (s) { state = s; render(); }); };
      batRow.appendChild(bat);
      content.appendChild(batRow);
      content.appendChild(el('div', 'muted', '场景帧率改动在下次切换壁纸时生效;遮挡暂停对视频与场景壁纸同时生效。'));

      content.appendChild(el('div', 'sec', '媒体集成(源自 dsh-wallpaper-engine)'));
      var lyrRow = el('div', 'row');
      var lyr = el('button', 'btn' + (state.lyrics ? ' on' : ''), state.lyrics ? '● 歌词跑马灯已开启' : '○ 歌词跑马灯已关闭');
      lyr.title = 'Now Playing 播放音乐时,在聊天窗口底部显示 lrclib.net 的同步歌词(默认关闭)';
      lyr.onclick = function () { api('/api/advanced', { lyrics: !state.lyrics }).then(function (s) { state = s; render(); }); };
      lyrRow.appendChild(lyr);
      content.appendChild(lyrRow);
      var npLine = el('div', 'muted', '正在读取系统媒体信息…');
      api('/api/nowplaying').then(function (np) {
        npLine.textContent = np && np.available && np.title
          ? 'Now Playing:' + np.title + (np.artist ? ' — ' + np.artist : '') + ' · ' + (np.status === 'playing' ? '播放中' : np.status)
          : 'Now Playing:当前没有正在播放的媒体(支持所有走 Windows 媒体控件的播放器)';
      }).catch(function () { npLine.textContent = 'Now Playing:不可用'; });
      content.appendChild(npLine);

      // ── WE 官方素材通路(localAssets,源自 dsh-wallpaper-engine)──
      content.appendChild(el('div', 'sec', 'WE 官方素材(localAssets)'));
      var waLine = el('div', 'muted', '正在检测 Wallpaper Engine 素材目录…');
      content.appendChild(waLine);
      api('/api/we-assets').then(function (wa) {
        if (wa && wa.available) {
          waLine.textContent = '✓ 已' + (wa.auto ? '自动检测' : '手动配置') + '素材目录(' + wa.textures + ' 张官方贴图):' + wa.dir + ' —— 场景壁纸将按名取官方像素,渲染与官方引擎对齐';
        } else {
          waLine.textContent = '未配置素材目录 —— 场景壁纸使用程序化复刻(观感近似);配置后场景效果链/材质/粒子的公共贴图改用官方像素';
        }
      }).catch(function () { waLine.textContent = '素材目录状态不可用'; });
      var waRow = el('div', 'row');
      var waInput = document.createElement('input');
      waInput.type = 'text';
      waInput.placeholder = '留空 = 自动探测 Steam 库;或填 WE 安装目录的 assets 路径';
      waInput.style.flex = '1';
      if (state.weAssetsDir) waInput.value = state.weAssetsDir;
      waRow.appendChild(waInput);
      var waSave = el('button', 'btn primary', '保存');
      waSave.onclick = function () {
        waSave.disabled = true;
        api('/api/we-assets', { dir: waInput.value.trim() || null }).then(function (s) {
          state = s; render();
        }).catch(function () { waSave.disabled = false; });
      };
      waRow.appendChild(waSave);
      content.appendChild(waRow);
      content.appendChild(el('div', 'muted', '素材只从本机 WE 目录只读取用,不会复制;路径填错(缺 materials/ 子目录)会被拒绝。'));

      content.appendChild(el('div', 'sec', '注入状态(双轨道)'));
      var injLine = el('div', 'muted', '正在读取注入轨道状态…');
      injLine.style.whiteSpace = 'pre-line';
      content.appendChild(injLine);
      var docRow = el('div', 'row');
      var docB = el('button', 'btn', '⯮ 一键体检');
      docB.title = '全面自检:服务器/注入/备份/缓存/磁盘/最近异常';
      docB.onclick = function () {
        docB.disabled = true; docB.textContent = '体检中…';
        api('/api/doctor').then(function (r) {
          var lines = [
            '服务器: 运行 ' + r.server.uptimeMin + ' 分钟 · Node ' + r.server.node,
            '注入: fuse' + (r.inject.fuseIntegrity === true ? '已开启(asar 轨道停用)' : r.inject.fuseIntegrity === false ? '未开启 ✓' : '?') + ' · asar补丁' + (r.inject.asarMarked ? '在位 ✓' : '丢失') + ' · CDP挂' + ((r.inject.cdp && r.inject.cdp.attached) || []).length + '窗',
            '备份: 槽位' + (r.backups && r.backups.slot ? '✓' : '✗') + ' 全量' + (r.backups && r.backups.full ? '✓(' + r.backups.fullMB + 'MB)' : '✗'),
            '缓存: ' + r.cacheMB + 'MB/6GB · 磁盘余 ' + (r.diskFreeGB != null ? r.diskFreeGB + 'GB' : '?') + ' · 壁纸 ' + r.inventory + ' 张',
            '状态文件: ' + (r.stateOk ? '✓' : '✗ 损坏'),
            '最近异常: ' + ((r.recentIssues && r.recentIssues.length) ? r.recentIssues.map(function (e) { return e.kind; }).join(', ') : '无 ✓'),
          ];
          injLine.textContent = lines.join('\n');
        }).catch(function () { injLine.textContent = '体检失败:服务器不可达'; })
          .then(function () { docB.disabled = false; docB.textContent = '⯮ 一键体检'; });
      };
      docRow.appendChild(docB);
      content.appendChild(docRow);
      var injRow = el('div', 'row');
      var autoZ = el('button', 'btn', '…');
      autoZ.title = '开机登录时自动带 CDP 调试端口启动 ZCode(壁纸注入的零改文件轨道,应用更新免疫);不开启则只用 asar 补丁轨道';
      autoZ.onclick = function () {
        api('/api/autostart-zcode', { enabled: !autoZ.dataset.on }).then(function (r) {
          autoZ.dataset.on = r.enabled ? '1' : '';
          autoZ.classList.toggle('on', !!r.enabled);
          autoZ.textContent = r.enabled ? '● 开机自动启动 ZCode(CDP)' : '○ 开机自动启动 ZCode(CDP)';
        });
      };
      injRow.appendChild(autoZ);
      content.appendChild(injRow);
      api('/api/diag-log').then(function (d) {
        var inj = d.inject || {};
        var cdp = d.cdp || {};
        var bits = [];
        bits.push('fuse 完整性校验:' + (inj.fuseIntegrity === true ? '已开启(asar 轨道被安全闸拦下,请用 CDP 启动)' : inj.fuseIntegrity === false ? '未开启 ✓' : '未知'));
        bits.push('asar 补丁:' + (inj.asarMarked === true ? '在位 ✓' : inj.asarMarked === false ? '丢失(看门狗 1 分钟内自动重打)' : '未知'));
        bits.push('CDP 轨道:' + (cdp.attached && cdp.attached.length ? '已挂 ' + cdp.attached.length + ' 窗口 ✓' : '空转(未用 CDP 方式启动)'));
        injLine.textContent = bits.join(' · ');
      }).catch(function () { injLine.textContent = '状态不可用'; });
      api('/api/autostart-zcode').then(function (r) {
        autoZ.dataset.on = r.enabled ? '1' : '';
        if (r.enabled) { autoZ.classList.add('on'); autoZ.textContent = '● 开机自动启动 ZCode(CDP)'; }
        else autoZ.textContent = '○ 开机自动启动 ZCode(CDP)';
      }).catch(function () { autoZ.textContent = '开关不可用'; });

      content.appendChild(el('div', 'sec', '维护'));
      var row2 = el('div', 'row');
      var scan = el('button', 'btn primary', '⟳ 重新扫描壁纸库');
      // 手动扫描:立即重读工坊目录,并汇报新增/删除/清理结果(否则"点了几次都不知道有没有生效")。
      scan.onclick = function () {
        scan.disabled = true;
        scanStatus = '正在扫描 Steam 工坊目录…';
        api('/api/scan', {}).then(function (r) {
          return loadData().then(function () {
            var bits = [];
            if (r && r.added) bits.push('新增 ' + r.added + ' 张');
            if (r && r.removed) bits.push('移除 ' + r.removed + ' 张');
            if (r && r.prunedCache) bits.push('清理缓存 ' + r.prunedCache + ' 项');
            scanStatus = '已扫描完成:共 ' + ((r && r.count) || wallpapers.length) + ' 张壁纸 · '
              + (bits.length ? bits.join('，') : '没有变化');
            render();
          });
        }).catch(function () {
          scanStatus = '扫描失败:请确认壁纸服务器 (127.0.0.1:7396) 正在运行';
          render();
        });
      };
      row2.appendChild(scan);
      content.appendChild(row2);
      content.appendChild(el('div', 'muted', scanStatus
        || '删除或退订壁纸后点这里可立即同步;平时每 5 秒也会自动同步。'));

      content.appendChild(el('div', 'sec', '状态'));
      content.appendChild(el('div', 'muted',
        '壁纸 ' + wallpapers.length + ' 张 · 轮播列表 ' + playlists.length + ' 个 · 当前 ' +
        (cur() ? cur().title : '未启用') + ' · 服务器 127.0.0.1:7396'));
    }

  // ── 独立模式提示(非注入打开时)──
  try {
    if (window.parent === window) {
      var nf = document.querySelector('.navfoot');
      if (nf) nf.innerHTML += '<br>控制台模式:壁纸显示在 <a href="/" target="_blank" style="color:#7fd7ff">播放页</a> 或聊天窗口背景';
    }
  } catch {}

  // ── 导航 ─────────────────────────────────────────────────
  document.querySelectorAll('.nav nav button').forEach(function (b) {
    b.onclick = function () {
      page = b.dataset.page;
      editorName = editorIds = null;
      document.querySelectorAll('.nav nav button').forEach(function (x) { x.classList.toggle('on', x === b); });
      render();
    };
  });
  // 模态宿主:Esc 关闭
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') parent.postMessage('we-wp-close', '*');
  });

  loadData(true).then(render).catch(function () { render(); });
  // 状态轮询(打开期间保持同步)
  setInterval(function () {
    api('/api/state').then(function (s) {
      // 亮度采样每 5s 都在变,剔除后再对比,否则工作台每 5s 重渲染打断滑杆操作
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
