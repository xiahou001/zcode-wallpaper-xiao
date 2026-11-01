// 一次性:workbench 自刷新加模态守卫(按字符偏移精确替换,避开换行差异)
const fs = require('fs');
const f = 'D:/AI/zcode/.zcode/workspace/default/we-wallpaper/public/workbench.js';
let s = fs.readFileSync(f, 'utf8');
const anchor = "if (document.hidden || !busy) { wbVersion = v.v; location.reload(); }";
const i = s.indexOf(anchor);
if (i < 0) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
const replacement = [
  "var modal = false;",
  "try { modal = window.parent && window.parent !== window; } catch (e) {}",
  "var safe = modal ? document.hidden : (document.hidden || !busy);",
  "if (v.v !== wbVersion && safe) { wbVersion = v.v; location.reload(); }",
].join(' ');
s = s.slice(0, i) + replacement + s.slice(i + anchor.length);
fs.writeFileSync(f, s);
console.log('patched, guard present:', s.includes('var safe = modal ? document.hidden'));
