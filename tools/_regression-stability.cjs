// 本轮稳定性回归:进程治理 + 上一轮功能不回归
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
  // 1. 体检
  try {
    const d = await j('/api/doctor');
    check('体检', d.server.ok && d.inject.asarMarked === true && d.backups.slot && d.backups.full,
      'uptime ' + d.server.uptimeMin + 'min, issues ' + (d.recentIssues || []).length);
    check('zcodeRunning 探测', typeof d.zcodeRunning === 'boolean', String(d.zcodeRunning));
  } catch (e) { check('体检', false, e.message); }

  // 2. 切换回归
  try {
    const inv = await j('/api/wallpapers');
    const st0 = await j('/api/state');
    const videos = (inv.wallpapers || []).filter((w) => w.playable && w.type === 'video');
    if (videos.length >= 1) {
      const target = videos.find((w) => w.id !== st0.currentId) || videos[0];
      const s1 = await j('/api/select', { id: target.id });
      check('切换到视频壁纸', s1.currentId === target.id, target.id);
      await new Promise((r) => setTimeout(r, 700));
      const s2 = await j('/api/select', { id: st0.currentId });
      check('切回原壁纸', s2.currentId === st0.currentId, st0.currentId);
    } else check('切换回归', false, '无视频壁纸');
  } catch (e) { check('切换回归', false, e.message); }

  // 3. nowplaying 治理后仍可用
  try {
    const np = await j('/api/nowplaying');
    check('Now Playing 端点', np && typeof np.available === 'boolean', 'available=' + np.available);
  } catch (e) { check('Now Playing 端点', false, e.message); }

  // 4. readBody 空闲超时(快速验证:正常 body 仍工作;超时路径 60s 太久,靠代码审查)
  try {
    const s = await j('/api/pause', { paused: false });
    check('POST body 常规路径', typeof s.paused === 'boolean', '');
  } catch (e) { check('POST body 常规路径', false, e.message); }

  // 5. 上传超限 413(content-length 头早退路径)—— 用 curl:Node fetch 会拒绝伪造头
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('curl', ['-s', '-o', 'NUL', '-w', '%{http_code}', '-X', 'POST',
      '-H', 'Content-Length: 5368709121', '--data-binary', 'x',
      BASE + '/api/upload?filename=cap-test.mp4'], { encoding: 'utf8', timeout: 20000 });
    check('上传 4GB 上限', out.trim() === '413', 'status ' + out.trim());
  } catch (e) { check('上传 4GB 上限', false, e.message); }

  // 6. 上传正常路径(小文件)+ 半成品清理不误伤
  try {
    const r = await fetch(BASE + '/api/upload?filename=regression-test.png', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000, raw hex placeholder'.slice(0, 40)),
    });
    const d = await r.json();
    check('上传正常路径', r.status === 200 && d.id, 'id=' + d.id);
  } catch (e) { check('上传正常路径', false, e.message); }

  // 7. 场景失败记忆端点(上轮功能不回归)
  try {
    await j('/api/scene-fail', { id: 'stab-regression', reason: 't' });
    const st = await j('/api/state');
    check('scene-fail 写入', !!(st.sceneFailures && st.sceneFailures['stab-regression']), '');
    const after = await j('/api/scene-retry', {});
    check('scene-retry 清除', !(after.sceneFailures && after.sceneFailures['stab-regression']), '');
  } catch (e) { check('场景失败记忆', false, e.message); }

  // 8. 外观新字段(上轮功能不回归)
  try {
    await j('/api/appearance', { bgBrightness: 105, scrim: 10 });
    const st = await j('/api/state');
    check('外观微调字段', st.appearance.bgBrightness === 105 && st.appearance.scrim === 10, '');
    await j('/api/appearance', { bgBrightness: 100, scrim: 0 });
  } catch (e) { check('外观微调字段', false, e.message); }

  for (const [s, n, dt] of results) console.log(s, '|', n, '|', dt);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(fails === 0 ? '=== ALL PASS ===' : '=== ' + fails + ' FAILURES ===');
  process.exit(fails === 0 ? 0 : 1);
})();
