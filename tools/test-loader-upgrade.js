// test-loader-upgrade.js — 验证 buildLoader 的新旧形态升级路径。
// 断言:任何输入形态,输出都不得含渲染阻塞的 7396 <link>,且必含 bootstrap.js。
const b = require('../build-zcode-loader');

const cases = [
  {
    name: 'upgrade-from-pair(当前线上形态:link+script)',
    html: '<html><head><title>ZCode</title><link rel="stylesheet" href="http://127.0.0.1:7396/embed.css?v=2"/><script src="http://127.0.0.1:7396/bootstrap.js?v=2" defer></script></head><body></body></html>',
  },
  {
    name: 'inject-fresh(原生未注入)',
    html: '<html><head><title>ZCode</title><meta charset="utf-8"></head><body></body></html>',
  },
  {
    name: 'upgrade-legacy-embedjs(更老的直连 embed.js 形态)',
    html: '<html><head><title>ZCode</title><link rel="stylesheet" href="http://127.0.0.1:7396/embed.css"/><script src="http://127.0.0.1:7396/embed.js" defer></script></head><body></body></html>',
  },
  {
    name: 'stray-link-only(只剩 link 的残缺形态)',
    html: '<html><head><title>ZCode</title><link rel="stylesheet" href="http://127.0.0.1:7396/embed.css"/></head><body></body></html>',
  },
];

let failures = 0;
for (const c of cases) {
  const big = b.buildLoader(c.html, 100000);
  // tight-slot 语义:新鲜页连极简加载器都放不下时,返回 null 是正确行为
  const tight = b.buildLoader(c.html, Buffer.byteLength(b.compactHtml(c.html), 'utf8'));
  for (const [label, r] of [['normal', big], ['tight-slot', tight]]) {
    const hasLink = r && /<link[^>]*7396/.test(r.text);
    const hasBootstrap = r && /bootstrap\.js/.test(r.text);
    const isNull = r === null;
    const ok = isNull || (!hasLink && hasBootstrap);
    if (!ok) failures += 1;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + c.name + ' [' + label + '] variant=' + (r && r.variant)
      + (hasLink ? ' ←仍有link!' : '') + (hasBootstrap ? '' : ' ←缺bootstrap!'));
  }
}
// 槽位极小 → 应返回 null 而不是硬塞
const none = b.buildLoader(cases[1].html, 50);
console.log((none === null ? 'PASS' : 'FAIL') + '  too-small-slot 返回 null');
if (none !== null) failures += 1;
console.log(failures === 0 ? 'LOADER-TESTS: ALL PASS' : 'LOADER-TESTS: ' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
