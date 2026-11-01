// 夺焦围栏单元测试(Node vm 模拟浏览器,不依赖浏览器/CDP)—— 长期保留
// ① 帧级 window.focus() 被吞 ② 元素级无手势被吞 ③ 手势窗口内放行
// ④ 手势过期后重拦 ⑤ 逃生门 allow=true 全放行 ⑥ 幂等(重复注入不重装)
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'web-focus-guard.js'), 'utf8');

function makeSandbox(nowRef) {
  const listeners = {};
  const rawFocusCalls = [];
  const rawElFocusCalls = [];
  const win = {
    addEventListener: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); },
    document: { activeElement: null },
    HTMLElement: function () {},
    Date: { now: () => nowRef.value },
    focus: function () { rawFocusCalls.push(1); },
  };
  win.HTMLElement.prototype.focus = function () { rawElFocusCalls.push(1); };
  win.window = win;
  const sb = { window: win, Date: win.Date, Object: Object, String: String, Error: Error, Array: Array };
  sb.globalThis = sb;
  vm.createContext(sb);
  return { sb, win, listeners, rawFocusCalls, rawElFocusCalls };
}
const fire = (listeners, name) => (listeners[name] || []).forEach((fn) => fn());

const results = [];
const check = (name, ok, detail) => results.push([ok ? 'PASS' : 'FAIL', name, detail || '']);

{
  const env = makeSandbox({ value: 1000 });
  vm.runInContext(src, env.sb);
  const g = env.win.__weFocusGuard;
  check('围栏安装(帧级)', g && g.installed === true, '');
  check('围栏安装(元素级)', g && g.elInstalled === true, '');
  const before = g.blocked;
  env.win.focus();
  check('帧级 window.focus() 被吞', g.blocked === before + 1 && env.rawFocusCalls.length === 0, 'blocked=' + g.blocked);
}
{
  const env = makeSandbox({ value: 1000 });
  vm.runInContext(src, env.sb);
  const g = env.win.__weFocusGuard;
  const el = new env.win.HTMLElement();
  el.focus();
  check('元素级无手势被吞', g.elBlocked === 1 && env.rawElFocusCalls.length === 0, 'elBlocked=' + g.elBlocked);
  check('记录被拦栈', typeof g.elLastBlockedStack === 'string' && g.elLastBlockedStack.length > 0, '');
}
{
  const env = makeSandbox({ value: 1000 });
  vm.runInContext(src, env.sb);
  const g = env.win.__weFocusGuard;
  fire(env.listeners, 'pointerdown');
  const el = new env.win.HTMLElement();
  el.focus();
  check('元素级手势后放行', g.elAllowed === 1 && env.rawElFocusCalls.length === 1, 'elAllowed=' + g.elAllowed);
}
{
  const nowRef = { value: 1000 };
  const env = makeSandbox(nowRef);
  vm.runInContext(src, env.sb);
  const g = env.win.__weFocusGuard;
  fire(env.listeners, 'pointerdown');
  nowRef.value = 3000;   // 超出 1000ms 手势窗口
  const el = new env.win.HTMLElement();
  el.focus();
  check('手势过期后重新拦截', g.elBlocked === 1 && env.rawElFocusCalls.length === 0, 'elBlocked=' + g.elBlocked);
}
{
  const env = makeSandbox({ value: 1000 });
  vm.runInContext(src, env.sb);
  const g = env.win.__weFocusGuard;
  g.allow = true;
  env.win.focus();
  const el = new env.win.HTMLElement();
  el.focus();
  check('逃生门 allow=true 全放行', g.allowed >= 1 && g.elAllowed >= 1 && env.rawFocusCalls.length === 1 && env.rawElFocusCalls.length === 1, '');
}
{
  const env = makeSandbox({ value: 1000 });
  vm.runInContext(src, env.sb);
  const first = env.win.__weFocusGuard;
  vm.runInContext(src, env.sb);
  check('幂等(重复注入不重装)', env.win.__weFocusGuard === first, '');
}

for (const [s, n, d] of results) console.log(s, '|', n, '|', d);
const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(fails === 0 ? '=== ALL PASS ===' : '=== ' + fails + ' FAILURES ===');
process.exit(fails === 0 ? 0 : 1);
