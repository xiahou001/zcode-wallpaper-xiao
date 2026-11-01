/**
 * web-focus-guard.js — 网页壁纸的夺焦围栏(源自 dsh-wallpaper-engine lib/we-focus-guard.js 的忠实移植)。
 *
 * 解决:部分网页壁纸在捕获相 mousedown 里调 window.focus(),或内置
 * setInterval(() => input.focus(), 2000) 之类的周期性元素级夺焦 —— 聊天窗口里
 * 任何位置点一下,输入框就丢焦点,且 0.9~3.6 秒周期反复发生。
 *
 * 为什么可以整条围栏:壁纸层 pointer-events:none,本系统从不把键盘送进壁纸帧
 * (web-shim 零键盘转发)——壁纸文档里程序化的 focus() 只能从宿主手里把键盘拿走。
 * 例外:用户真点壁纸时,shim 合成的 pointer 事件(经 op 通道送入)算"真实手势",
 * 手势后 1 秒内的 focus() 放行 —— 壁纸自己的编辑框仍可用。
 *
 * 自证:window.__weFocusGuard = { calls, blocked, allowed, installed, allow,
 * elCalls, elAllowed, elBlocked, elInstalled, gestureAt, ... };allow = true 是
 * 逃生门(对比测试用,不是用户开关)。
 */
(function () {
  var w = window;
  if (w.__weFocusGuard) return;                       // 幂等:同一文档重复注入只装一次
  var guard = {
    calls: 0, blocked: 0, allowed: 0, installed: false, allow: false,
    elCalls: 0, elAllowed: 0, elBlocked: 0, elInstalled: false,
    gestureAt: 0, gestureWindowMs: 1000, elLastBlockedAt: 0, elLastBlockedStack: '',
  };
  w.__weFocusGuard = guard;

  // ── 帧级:window.focus() 无条件吞掉 ──
  var raw = null;
  try { raw = w.focus; } catch (e) { raw = null; }
  if (typeof raw === 'function') {
    var patched = function () {
      guard.calls += 1;
      if (guard.allow) { guard.allowed += 1; return raw.apply(w, arguments); }
      guard.blocked += 1;                             // 帧级夺焦:吞掉,不转交原函数
      return undefined;
    };
    // ① 直接赋值(Window 的 focus 在原型上,可写 ⇒ 产生自有属性遮蔽它)
    try { w.focus = patched; } catch (e) { /* 只读/访问器:交给 ② */ }
    // ② 赋值没生效(继承链不可写)时 defineProperty —— 自有属性创建不受继承链约束
    if (w.focus !== patched) {
      try { Object.defineProperty(w, 'focus', { configurable: true, writable: true, value: patched }); } catch (e) { /* 如实记账 */ }
    }
    guard.installed = w.focus === patched;
  }

  // ── 元素级:只在"最近一次真实交互"窗口内放行 element.focus() ──
  try {
    var doc = w.document;
    var El = w.HTMLElement;
    if (doc && El && El.prototype && typeof El.prototype.focus === 'function') {
      var rawEl = El.prototype.focus;
      // 手势源:pointer/mouse/touch 按下 + 按键。shim 合成的事件 isTrusted === false,
      // 但那正是用户真手经 op 通道送进来的那一次 —— 照样记为手势。
      var mark = function () { guard.gestureAt = Date.now(); };
      var names = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
      for (var i = 0; i < names.length; i++) {
        try { w.addEventListener(names[i], mark, true); } catch (e) { /* 少一个手势源不影响围栏 */ }
      }
      var elPatched = function () {
        guard.elCalls += 1;
        var win = guard.gestureWindowMs > 0 ? guard.gestureWindowMs : 1000;
        var fresh = guard.gestureAt > 0 && (Date.now() - guard.gestureAt) <= win;
        if (guard.allow || fresh) { guard.elAllowed += 1; return rawEl.apply(this, arguments); }
        guard.elBlocked += 1;                         // 无手势的周期性夺焦:吞掉
        guard.elLastBlockedAt = Date.now();
        try {
          guard.elLastBlockedStack = String(new Error().stack || '').split('\n').slice(0, 4).join(' | ');
        } catch (e) { /* 栈拿不到就算了 */ }
        return;
      };
      try { El.prototype.focus = elPatched; } catch (e) { /* 交给下一条腿 */ }
      if (El.prototype.focus !== elPatched) {
        try { Object.defineProperty(El.prototype, 'focus', { configurable: true, writable: true, value: elPatched }); } catch (e) { /* 如实记账 */ }
      }
      guard.elInstalled = El.prototype.focus === elPatched;
    }
  } catch (e) { /* 元素级整体装不上:帧级那一半仍然有效 */ }
})();
