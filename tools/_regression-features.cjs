// 功能移植回归:隐藏/恢复 + custom 管理 + fx + 玻璃双色(本轮套件,长期保留)
const BASE = 'http://127.0.0.1:7396';
const j = async (p, body) => {
  const c = new AbortController();
  const k = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(BASE + p, body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: c.signal } : { signal: c.signal });
    return await r.json();
  } finally { clearTimeout(k); }
};
const results = [];
const check = (name, ok, detail) => results.push([ok ? 'PASS' : 'FAIL', name, detail || '']);

(async () => {
  // 隐藏/恢复全链路 + 非法 id 防线
  try {
    const inv = await j('/api/wallpapers');
    const st = await j('/api/state');
    const target = (inv.wallpapers || []).find((w) => w.playable && w.id !== st.currentId && !String(w.id).startsWith('custom-'));
    if (!target) throw new Error('无候选壁纸');
    await j('/api/hide', { id: target.id, hidden: true });
    const h = (await j('/api/wallpapers')).wallpapers.find((w) => w.id === target.id);
    check('隐藏后清单带 hidden 标记', h && h.hidden === true, '');
    check('隐藏进 state.hiddenIds', (await j('/api/state')).hiddenIds.includes(target.id), '');
    await j('/api/hide', { id: target.id, hidden: false });
    check('恢复后 hidden 清除', (await j('/api/wallpapers')).wallpapers.find((w) => w.id === target.id).hidden === false, '');
    await j('/api/hide', { id: 'javascript:alert(1)', hidden: true });
    check('hide 非法 id 不入库', !(await j('/api/state')).hiddenIds.includes('javascript:alert(1)'), '');
    await j('/api/hide', { id: 'javascript:alert(1)', hidden: false });
  } catch (e) { check('隐藏/恢复', false, e.message); }

  // fx 开关与配色
  try {
    await j('/api/advanced', { fxEnabled: true, fxColorMode: 'custom', fxColor: '#ff8800' });
    const st = await j('/api/state');
    check('fx 开关/配色', st.fxEnabled === true && st.fxColorMode === 'custom' && st.fxColor === '#ff8800', '');
    await j('/api/advanced', { fxEnabled: false, fxColorMode: 'accent', fxColor: '' });
    check('fx 关闭复位', (await j('/api/state')).fxEnabled === false, '');
  } catch (e) { check('fx 配置', false, e.message); }

  // 玻璃双色
  try {
    await j('/api/appearance', { glassColorDark: '#0a0f18' });
    check('glassColorDark 写入', (await j('/api/state')).appearance.glassColorDark === '#0a0f18', '');
    const css = await (await fetch(BASE + '/embed.css')).text();
    check('embed.css 双色引用', css.includes('#0a0f18'), '');
    await j('/api/appearance', { glassColorDark: '' });
    check('glassColorDark 复位', (await j('/api/state')).appearance.glassColorDark === '', '');
  } catch (e) { check('玻璃双色', false, e.message); }

  // 聊天框字体三件 + 正文字号缩放 + 渲染优化
  try {
    await j('/api/appearance', { fontFamilyComposer: '"KaiTi", serif', fontSizeComposer: 2, fontWeightComposer: 500, chatTextScale: 110, fontSmooth: true });
    const st = await j('/api/state');
    check('字体五件写入', st.appearance.fontFamilyComposer === '"KaiTi", serif' && st.appearance.fontSizeComposer === 2
      && st.appearance.fontWeightComposer === 500 && st.appearance.chatTextScale === 110 && st.appearance.fontSmooth === true, '');
    const css = await (await fetch(BASE + '/embed.css')).text();
    check('字体规则进 CSS', css.includes('KaiTi') && css.includes('calc(1em + 2px)') && css.includes('font-weight: 500')
      && css.includes('zoom: 1.10') && css.includes('antialiased'), '');
    // 非法值钳制
    await j('/api/appearance', { fontSizeComposer: 99, fontWeightComposer: 12345, chatTextScale: 999 });
    const st2 = await j('/api/state');
    check('非法值钳制', st2.appearance.fontSizeComposer === 8 && st2.appearance.fontWeightComposer === 0 && st2.appearance.chatTextScale === 140, '');
    // 复位
    await j('/api/appearance', { fontFamilyComposer: '', fontSizeComposer: 0, fontWeightComposer: 0, chatTextScale: 100, fontSmooth: false });
    const st3 = await j('/api/state');
    check('字体复位', st3.appearance.fontSizeComposer === 0 && st3.appearance.chatTextScale === 100 && !st3.appearance.fontSmooth, '');
  } catch (e) { check('聊天框字体', false, e.message); }

  // custom-delete 防线 + 切换链路
  try {
    const r = await fetch(BASE + '/api/custom-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '../evil' }) });
    check('custom-delete 路径穿越被拒', r.status === 400, 'status ' + r.status);
    const st0 = await j('/api/state');
    check('切换链路', (await j('/api/select', { id: st0.currentId })).currentId === st0.currentId, '');
  } catch (e) { check('custom 防线/切换', false, e.message); }

  for (const [s, n, dt] of results) console.log(s, '|', n, '|', dt);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(fails === 0 ? '=== ALL PASS ===' : '=== ' + fails + ' FAILURES ===');
  process.exit(fails === 0 ? 0 : 1);
})();
