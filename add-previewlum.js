// 智能可读性增强:切换瞬间按预览图采样亮度(预览图永远可得),
// 实测帧采样随后精修;切换后 8s 内加密采样(1s 间隔)让文字色快速稳定。
const fs = require('fs');
const f = 'D:/AI/zcode/.zcode/workspace/default/we-wallpaper/public/player.js';
let t = fs.readFileSync(f, 'utf8');

// 1) mountCurrent:切换瞬间先按预览图采样
const anchor = "    $('hud-title').textContent = w.title;";
const injectLines = [
  "    previewLuminance(w);   // 切换瞬间:按预览图亮度立即翻转文字色(实测帧随后精修)",
  "    $('hud-title').textContent = w.title;",
  "    document.title = w.title + ' · 动态壁纸';",
];
if (!t.includes(injectLines[0])) {
  if (!t.includes(anchor)) { console.log('A1 NOT FOUND'); process.exit(1); }
  t = t.split(anchor).join(injectLines.join('\r\n'));
}

// 2) 预览采样函数 + 切换后加密采样(插在 sampleLuminance 的定时器后)
const anchor2 = '  setInterval(sampleLuminance, 5000);';
if (!t.includes('function previewLuminance')) {
  if (!t.includes(anchor2)) { console.log('A2 NOT FOUND'); process.exit(1); }
  const fn = [
    '  setInterval(sampleLuminance, 5000);',
    '  // 预览图采样:切换瞬间即时给出正确亮度(实时帧采样随后精修)',
    '  let lastPreviewId = null;',
    '  function previewLuminance(w) {',
    '    try {',
    '      if (!w || !w.preview || lastPreviewId === w.id) return;',
    '      lastPreviewId = w.id;',
    '      const im = new Image();',
    '      im.onload = function () { luminanceFromImage(im); };',
    '      im.src = w.preview;',
    '    } catch (e) {}',
    '  }',
    '  // 切换后 8s 内每 1s 加密采样(新壁纸首帧亮度可能渐变),之后回到 5s',
    '  function denseSampling() {',
    '    let n = 0;',
    '    const iv = setInterval(function () { sampleLuminance(); if (++n >= 8) clearInterval(iv); }, 1000);',
    '  }',
  ].join('\r\n');
  t = t.split(anchor2).join(fn);
}

// 3) mountCurrent 末尾触发加密采样(唯一匹配点:.layer.style.zIndex 赋值后)
const anchor3 = "    if (layer) layer.style.zIndex = '1';";
const inject3 = "    if (layer) layer.style.zIndex = '1';\r\n    denseSampling();";
const anchor3lf = "    if (layer) layer.style.zIndex = '1';\n    denseSampling();";
if (t.includes(inject3) || t.includes(anchor3lf)) { console.log('already has denseSampling'); }
else {
  const hits = t.split(anchor3).length - 1;
  if (hits !== 1) { console.log('A3 ambiguous (' + hits + ')'); process.exit(1); }
  t = t.split(anchor3).join(inject3);
}

fs.writeFileSync(f, t);
console.log('preview luminance: ' + (t.includes('previewLuminance') && t.includes('denseSampling') ? 'ok' : 'MISSING'));
