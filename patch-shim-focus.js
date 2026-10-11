const fs = require('fs');
const f = 'D:/AI/zcode/.zcode/workspace/default/we-wallpaper/vendor/webwallgl/web-shim.js';
let t = fs.readFileSync(f, 'utf8');
// 在 shim 的立即执行函数体开头加夺焦围栏:吞掉壁纸的 window.focus() 调用
// (DSH 同款思路:网页壁纸不得夺走宿主聊天窗口的焦点)
const anchor = '  // 幂等：同一文档只装一套。';
if (!t.includes(anchor)) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
const inject = [
  '  // ── 夺焦围栏:壁纸脚本调用 window.focus() / 元素 focus() 时吞掉 ——',
  '  //    网页壁纸不得夺走宿主聊天窗口的焦点(DSH 同款行为边界)。',
  '  //    元素的 preventScroll 语义保留:点击壁纸内部仍可定位,但不抬窗。',
  '  try {',
  '    var __origFocus = w.HTMLInputElement.prototype.focus;',
  '    var __noSteal = function (orig) {',
  '      return function () { try { w.parent.postMessage({ __we: 1, op: "focusSteal" }, "*"); } catch (_) {}',
  '        try { orig.apply(this, arguments); } catch (_) {} };',
  '    };',
  '    w.focus = function () { try { w.parent.postMessage({ __we: 1, op: "focusSteal" }, "*"); } catch (_) {} };',
  '    var HTMLEls = [w.HTMLInputElement, w.HTMLTextAreaElement, w.HTMLSelectElement, w.HTMLButtonElement, w.HTMLAnchorElement, w.HTMLElement];',
  '    for (var fi = 0; fi < HTMLEls.length; fi++) {',
  '      try { var pf = HTMLEls[fi].prototype.focus; if (pf) HTMLEls[fi].prototype.focus = __noSteal(pf); } catch (_) {}',
  '    }',
  '  } catch (_) {}',
  '  ' + anchor,
].join('\r\n');
const anchorLf = anchor.replace(/\r\n/g, '\n');
const injectLf = inject.replace(/\r\n/g, '\n');
if (t.includes(anchor)) t = t.split(anchor).join(inject);
else if (t.includes(anchorLf)) t = t.split(anchorLf).join(injectLf);
else { console.log('P NOT FOUND'); process.exit(1); }
fs.writeFileSync(f, t);
console.log('focus guard: ' + (t.includes('focusSteal') ? 'ok' : 'MISSING'));
