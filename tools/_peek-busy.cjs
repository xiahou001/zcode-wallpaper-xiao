// 一次性:定位 workbench.js 自刷新的 busy 判定段
const s = require('fs').readFileSync('D:/AI/zcode/.zcode/workspace/default/we-wallpaper/public/workbench.js', 'utf8');
const i = s.indexOf('var busy = ae');
console.log('found at:', i);
if (i >= 0) console.log(s.slice(i - 150, i + 320));
else {
  const j = s.indexOf('document.hidden');
  console.log('document.hidden at:', j);
  console.log(s.slice(Math.max(0, j - 300), j + 200));
}
