// check-state.js — 壁纸状态文件体检与自愈。
// 场景:ZCode 升级后,壁纸服务仍是旧进程,state.json 里可能残留旧版字段或越界值;
// 若新版 settings-schema 收紧校验,state 会整体校验失败 → 壁纸不显示。
// 做法:用当前 settings-schema 的 sanitizeState 跑一遍,差异写回,并在越界/未知字段时输出原因。
// 退出码:0 = 状态可用(可能已修正);1 = 状态文件读不了或 schema 加载失败。
const fs = require('fs');
const path = require('path');
const os = require('os');

const repo = path.join(__dirname, '..');
const STATE_DIR = path.join(os.homedir(), '.we-wallpaper');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

(async function main() {
  let sanitizeState, DEFAULTS;
  try {
    const mod = await import(require('url').pathToFileURL(path.join(repo, 'settings-schema.js')).href);
    sanitizeState = mod.sanitizeState;
    DEFAULTS = mod.DEFAULTS;
  } catch (e) {
    console.error('state: 无法加载 settings-schema.js: ' + e.message);
    process.exit(1);
  }

  let raw = {};
  let existed = false;
  if (fs.existsSync(STATE_FILE)) {
    existed = true;
    try {
      raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '') || '{}');
    } catch (e) {
      console.error('state: state.json 解析失败(' + e.message + '),已重置为默认值');
      raw = {};
    }
  } else {
    console.log('state: 无 state.json,将写入默认值');
  }

  const fixed = sanitizeState(Object.assign({}, DEFAULTS, raw));

  // 找出被修正的顶层键,便于诊断日志定位
  const changed = [];
  for (const k of Object.keys(fixed)) {
    const a = JSON.stringify(raw[k]);
    const b = JSON.stringify(fixed[k]);
    if (a !== b) changed.push(k + ': ' + a + ' -> ' + b);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(fixed, null, 2));

  if (existed && changed.length) {
    console.log('state: 已修正 ' + changed.length + ' 项越界/失效字段');
    changed.slice(0, 12).forEach((c) => console.log('  · ' + c));
    if (changed.length > 12) console.log('  …共 ' + changed.length + ' 项');
  } else {
    console.log('state: 校验通过(首行修复检查完成)');
  }
  console.log('state: appearance=' + JSON.stringify(fixed.appearance));
})().catch((e) => { console.error('state: 未处理异常 ' + e.message); process.exit(1); });