// build-zcode-loader.js — 为 ZCode 的 renderer/index.html 构造可放进原槽位的加载器。
//
// 背景:asar 原位补丁只能做「等长覆写」——注入后的 HTML 必须 <= 原始槽位大小。
// 真实 ZCode 的 index.html 约 28KB,压缩空行后空间充足;但为了应对将来 ZCode 把
// index.html 做小(或换用更紧凑的构建),这里按剩余空间逐级降级:
//   full  : defer script(带版本参数)
//   lite  : defer script(无版本参数)
//   tiny  : 同 lite(历史档位名,保持兼容)
//   slim  : 先剥掉 HTML 注释 / 连续空白 / 行尾空白,再按上面三级重试
//   hard  : 额外移除 <meta>/<link rel=icon> 等非关键头部标签(最后手段)
// 都放不下则返回 null,由调用方提示改用影子目录方案。
//
// ⚠ 加载器一律只用 async 脚本(async≠defer:async 完全不阻塞页面解析,
// defer 会卡 DOMContentLoaded —— 服务器启动期/忙时响应慢几秒,ZCode 就
// 表现为"打不开/白屏",这正是本档位曾用 defer 引发过的真实故障)。
// 样式由 embed.js 动态注入,不依赖任何 link 标签。
const INJECT_FULL =
  '<script src="http://127.0.0.1:7396/bootstrap.js?v=4" async></script>';
const INJECT_LITE =
  '<script src="http://127.0.0.1:7396/bootstrap.js" async></script>';
const INJECT_TINY = INJECT_LITE;
const ANCHOR = '<title>ZCode</title>';

const VARIANTS = [
  { tag: INJECT_FULL, variant: 'full' },
  { tag: INJECT_LITE, variant: 'lite' },
  { tag: INJECT_TINY, variant: 'tiny' },
];

function compactHtml(html) {
  return html.replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n');
}

// 激进瘦身:去注释、去行尾空白、去多余空白字符
function slimHtml(html) {
  return compactHtml(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/\n/g, '');
}

// 最后手段:在瘦身基础上再砍掉非关键头部标签(meta / preload 等)
function hardSlimHtml(html) {
  return slimHtml(html)
    .replace(/<meta[^>]*>/g, '')
    .replace(/<link[^>]*rel="(?:preload|modulepreload|icon|manifest)"[^>]*>/g, '');
}

// 把注入标签塞进文档;锚点链四层冗余:标题 → </head> → <body → 首个 <meta。
// ZCode 未来改掉 <title>ZCode</title> 文案时仍能落位(更新免疫)。
function placeTag(html, tag) {
  if (html.indexOf(ANCHOR) >= 0) return html.replace(ANCHOR, ANCHOR + tag);
  if (html.indexOf('</head>') >= 0) return html.replace('</head>', tag + '</head>');
  const b = html.indexOf('<body');
  if (b >= 0) {
    const close = html.indexOf('>', b);
    if (close > 0) return html.slice(0, close + 1) + tag + html.slice(close + 1);
  }
  const m = html.indexOf('<meta');
  if (m >= 0) return html.slice(0, m) + tag + html.slice(m);
  return null;
}
// 文档里是否存在任一可用锚点(asar 补丁脚本的 UNEXPECTED 闸门用)
function hasAnchor(html) {
  return html.indexOf(ANCHOR) >= 0 || html.indexOf('</head>') >= 0 || html.indexOf('<body') >= 0 || html.indexOf('<meta') >= 0;
}

// 已注入时的替换:允许版本参数/协议/引号/defer↔async 形态差异
const LOADER_RE = /<link[^>]*7396\/embed\.css[^>]*>\s*<script[^>]*7396\/(?:embed|bootstrap)\.js[^>]*><\/script>/g;
const SINGLE_RE = /<script[^>]*7396\/(?:embed|bootstrap)\.js[^>]*><\/script>/g;

// 返回 { text, variant } 或 null
function buildLoader(orig, slotSize) {
  const stages = [
    { html: compactHtml(orig), prefix: '' },
    { html: slimHtml(orig), prefix: 'slim-' },
    { html: hardSlimHtml(orig), prefix: 'hard-' },
  ];
  for (const stage of stages) {
    const base = stage.html;
    const injected = base.indexOf('7396/') >= 0;
    for (const c of VARIANTS) {
      let out;
      if (injected) {
        if (LOADER_RE.test(base)) out = base.replace(LOADER_RE, c.tag);
        else if (SINGLE_RE.test(base)) out = base.replace(SINGLE_RE, c.tag);
        else out = base;
        LOADER_RE.lastIndex = 0;
        SINGLE_RE.lastIndex = 0;
        // 旧形态升级:剥离任何残留的 7396 link 标签(full→script-only 升级后不允许再留)
        out = out.replace(/<link[^>]*127\.0\.0\.1:7396[^>]*>/g, '');
        // 残缺形态(槽位里只有 link 没有脚本):剥完后就什么都不剩了,按新鲜页补插
        if (out.indexOf('7396/') < 0) out = placeTag(out, c.tag);
      } else {
        out = placeTag(base, c.tag);
      }
      if (out && Buffer.byteLength(out, 'utf8') <= slotSize) {
        return { text: out, variant: stage.prefix + c.variant };
      }
    }
  }
  return null;
}

module.exports = {
  buildLoader, compactHtml, slimHtml, hardSlimHtml, placeTag, hasAnchor,
  INJECT_FULL, INJECT_LITE, INJECT_TINY, ANCHOR, LOADER_RE, SINGLE_RE,
};