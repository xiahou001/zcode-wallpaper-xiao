// 一次性:最终验证 v2(修正三个检查条件)
(async () => {
  const wbJs = await (await fetch('http://127.0.0.1:7396/workbench.js')).text();
  const wbHtml = await (await fetch('http://127.0.0.1:7396/workbench')).text();
  const wbCss = await (await fetch('http://127.0.0.1:7396/workbench.css')).text();
  const css = await (await fetch('http://127.0.0.1:7396/embed.css')).text();
  const checks = {
    '六页签(HTML data-page)': ['wall', 'look', 'play', 'sys', 'ext', 'about'].every((p) => wbHtml.includes(`data-page="${p}"`)),
    'JS 分发五渲染器': ['renderWall', 'renderLook', 'renderPlay', 'renderSystem', 'renderAbout'].every((f) => wbJs.includes('function ' + f)),
    'workbench.js 全端点覆盖': ['/api/wallpapers', '/api/appearance', '/api/advanced', '/api/hide', '/api/scan', '/api/version'].every((e) => wbJs.includes(e)),
    'workbench.css 玻璃材质': wbCss.includes('--wb-glass-rgb') && wbCss.includes('wb-bg'),
    'workbench.css 无 backdrop 规则(注释除外)': !/^\s*backdrop-filter:/m.test(wbCss),
    'embed.css 主题化输出': ['::selection', '::placeholder', 'scrollbar-thumb'].every((p) => css.includes(p)),
    'embed.css 无模板残留': !css.includes('${'),
  };
  let fails = 0;
  for (const [k, v] of Object.entries(checks)) { console.log(v ? 'PASS |' : 'FAIL |', k); if (!v) fails++; }
  console.log(fails === 0 ? '=== ALL PASS ===' : '=== ' + fails + ' FAILURES ===');
  process.exit(fails ? 1 : 0);
})();
