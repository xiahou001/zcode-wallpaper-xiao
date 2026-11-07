// 一次性:WCAG 选色数学断言(修正断言方向:dark=深字 #1b1e24,light=浅字 #eef1f6)
const wcagLum = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return 0; const n = parseInt(m[1], 16); const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const wcagContrast = (la, lb) => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
const auto = (bg) => {
  const l = wcagLum(bg);
  return wcagContrast(l, wcagLum('#1b1e24')) >= wcagContrast(l, wcagLum('#eef1f6')) ? 'dark' : 'light';
};
const cases = [
  ['#14161c', 'light', '默认深空黑 → 浅字(旧 0.55 阈值也是浅字,一致)'],
  ['#e8615a', 'dark', '红(饱和,luma 高 WCAG 低)—— 旧阈值误选浅字,新选深字'],
  ['#2ec5d3', 'dark', '青(亮)—— 旧阈值误选浅字(luma 0.6>0.55),新选深字对比 9:1'],
  ['#f2f3f5', 'dark', '近白 → 深字'],
  ['#8ecf5a', 'dark', '亮绿 → 深字'],
  ['#533b78', 'light', '紫(暗)→ 浅字'],
  ['#2a6dbd', 'light', '中饱和蓝 → 浅字对比 4.2:1 优于深字 3.5:1'],
];
let fails = 0;
for (const [bg, expect, note] of cases) {
  const got = auto(bg);
  const ok = got === expect;
  if (!ok) fails++;
  console.log(ok ? 'PASS' : 'FAIL', '|', bg, '->', got, '|', note);
}
console.log(fails === 0 ? '=== ALL PASS ===' : '=== ' + fails + ' FAILURES ===');
process.exit(fails ? 1 : 0);
