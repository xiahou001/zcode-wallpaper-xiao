# we-wallpaper

把本地 [Wallpaper Engine](https://www.wallpaperengine.io/) 创意工坊壁纸变成动态背景的独立工作台 —— 支持 **Scene 实时渲染**(内置 WebWallGL 引擎)、**视频/图片壁纸**、**嵌入 ZCode 等基于 Electron 的应用作为聊天窗口背景**,并自带一个 DSH 风格的壁纸管理工作台。

> 灵感与核心渲染能力来自 [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)(MIT)与其内置的 [WebWallGL](https://github.com/oneincase/webwallgl) 引擎(MIT)。本项目是独立重写的宿主实现,与原项目无隶属关系。

## 功能

- **壁纸渲染**:Scene 壁纸由内置 WebWallGL 实时渲染(粒子/骨骼/SceneScript/包内音频/鼠标交互);video 与 image 壁纸直接播放;**web 壁纸**(HTML 互动型)经严格沙箱 iframe + WE API 兼容 shim 加载,鼠标交互经 postMessage 转发
- **降级链(不会黑屏)**:场景渲染首帧看护(预算随包大小放宽,`fps>0` 才算就绪)→ 自动重试 → 从 scene.pkg 提取内嵌 MP4 播放 → 作者预览图兜底
- **壁纸工作台**(`/workbench`):当前壁纸、选择网格、**自定义壁纸上传**(图片/视频)、外观调节、轮播列表、过场与省电设置;**填充方式**(铺满/完整/拉伸)与**本机字体清单**下拉(system-fonts 思路:服务器枚举已装字体)
- **智能可读性**:实时采样壁纸画面亮度,亮壁纸自动切换深色文字 + 浅玻璃,暗壁纸反之(源自 DSH 的"主题跟随/可读性下限"思路)
- **外观预设**:七套出厂方案(作者自用/黑客绿/重磨砂/暗夜釉色/可读优先/原色直出/紫色心情,蒸馏自 DSH glass-presets)一键应用;当前外观可存为自定义预设(最多 12 个)
- **壁纸滤镜**:无/模糊/黑白/怀旧/鲜艳/暖调/冷调/反色/提亮/压暗/高对比,场景壁纸走渲染引擎通道、视频/图片/web 走 CSS,聊天窗口内同样生效
- **文字颜色(分区独立)**:主区(消息列表)/ 侧栏 / 聊天框三区各自配色——主区默认随壁纸亮度翻转,侧栏默认跟随主区,聊天框默认按玻璃明暗自动,均可手动指定色值;其余滑杆即时生效(样式 5 秒热更新)
- **切换过场**:7 种过场动画(交叉淡化/推移/擦除/光圈/缩放/百叶窗/无)× 4 方向(左右上下进入)+ 速度档,换壁纸时新旧画面按帧门控交接
- **自动轮转 + 轮播列表**:新建/编辑/删除轮播列表,按列表定时轮换
- **省电**:遮挡暂停三档(从不 / 切走·最小化 / 失焦即停)、电池供电自动暂停(pauseOnBattery,仅笔记本有效)、场景帧率上限(15/30/60fps)
- **视频帧率上限转码**:源帧率高于上限的视频自动 ffmpeg 降帧转码(NVENC 优先、回落 libx264),降低 GPU 解码占用;后台进行,下次切换生效
- **faststart 无损重排**:moov 在文件尾部的视频一次性无损前置(切换延迟与文件大小解耦),启动时按轮换列表优先预热,faststart+转码缓存合计 6GB 预算自动回收
- **WE 官方素材通路(localAssets)**:检测到本机 Wallpaper Engine 的 assets 目录时,场景壁纸按名取官方贴图(util/*、particle/**),渲染与官方引擎逐像素对齐;未检测到则静默回落程序化复刻(素材只读取用,不复制)
- **Now Playing + 在线歌词**:读取 Windows 媒体控件(SMTC)正在播放的音乐,可选开启 lrclib.net 同步歌词跑马灯(纯 PowerShell WinRT,无原生依赖)
- **ZCode 深度集成(可选)**:把壁纸层注入 ZCode 桌面客户端(Electron 应用)的聊天窗口背景,并在其设置页添加 Wallpaper 入口

## 环境要求

- Node.js ≥ 18(零 npm 依赖)
- Windows + Steam:创意工坊已下载 Wallpaper Engine 壁纸(**无需安装 Wallpaper Engine 本体**,壁纸文件即所需全部)
- 可选:任何 image / video 文件可作为自定义壁纸上传
- 可选(深度集成):ZCode Desktop(Electron)客户端

## 快速开始

```cmd
git clone https://github.com/<you>/we-wallpaper.git
cd we-wallpaper
node server.mjs
```

打开 <http://127.0.0.1:7396> —— 全屏播放,右下角 🖼 打开工作台,或直接访问 <http://127.0.0.1:7396/workbench>。

服务器自动扫描 Steam 库中的 `steamapps/workshop/content/431960`(Wallpaper Engine 工坊)。手动下载的壁纸包(含 `project.json` 的目录)可通过 `~/.we-wallpaper/state.json` 的 `workshopDirs` 数组追加,再 `POST /api/scan`。

### 开机自启(可选)

推荐运行仓库内的 `install-autostart.vbs`，它会在当前用户的 Startup 文件夹创建一个指向仓库的快捷方式。这样仓库移动到其他目录后，只需重新运行安装脚本，不需要手动修改路径。

开机时会按以下顺序自动执行:

1. 启动壁纸服务器并等待 `/api/state` 可访问;
2. 壁纸 iframe 等待服务后自动显示;
3. 开机脚本常驻监控壁纸服务，服务异常退出后会自动重启;
4. ZCode 不会被这个脚本自动启动，关闭 ZCode 或 zcode-host 不会停止壁纸服务器。

手动安装:

```cmd
cscript //nologo install-autostart.vbs
```

取消开机自启:删除 Startup 文件夹中的 `we-wallpaper-autostart.lnk`。

## 嵌入 Electron 应用聊天窗口(以 ZCode Desktop 为例)

> ⚠️ 此操作修改本地客户端资源(原文件不被改动、随时可恢复),属非官方玩法,应用更新后需重跑一遍。请自担风险。

```cmd
apply.cmd     rem 解包 resources/app + 注入壁纸层加载器(幂等,可重复执行)
restore.cmd   rem 一键恢复原生界面
```

刷新/重启客户端后:聊天窗口背景即为动态壁纸,右下角出现 🖼 按钮打开工作台;若客户端支持自定义设置页注入,设置侧边栏也会出现 **Wallpaper** 条目。

加载可靠性说明:

- ZCode 首次加载的是 `bootstrap.js`，只有壁纸服务器 `/api/state` 可用后才加载 `embed.js`，避免启动竞态和缓存旧脚本。
- 壁纸 iframe 每 4 秒探活;服务恢复后自动加时间戳重载。播放页会向父页面发送就绪消息，超过 8 秒没有就绪握手也会自动重载。
- 如果壁纸服务被系统结束，开机守护脚本每 5 秒自动拉起 Node 服务;不需要重新登录 Windows。
- Scene 失败时按实时 WebGL → scene.pkg 内嵌 MP4 → preview 图顺序降级。
- `/api/diag-log` 和 `/api/scene-progress` 提供渲染错误、目录围栏、客户端恢复和大包传输状态。
- `settings-schema.js` 统一校验状态范围，避免 state.json 中的异常值导致播放器启动失败。

如果刚更新过注入逻辑，请完全退出 ZCode 后重新打开一次，让新的 `bootstrap.js` 注入生效。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/wallpapers` | 壁纸清单(含预览图、类型、可播性) |
| GET | `/api/state` | 当前状态(选中/暂停/音量/外观/亮度采样等) |
| POST | `/api/select` `{id}` | 切换壁纸 |
| POST | `/api/close` | 关闭壁纸层 |
| POST | `/api/pause` `{paused}` | 暂停 / 恢复 |
| POST | `/api/volume` `{volume}` | 音量 0~1 |
| POST | `/api/rotate` `{enabled,intervalMin,playlist}` | 自动轮转 |
| POST | `/api/playlists` `{name,ids}` / `/api/playlists/delete` `{name}` | 轮播列表管理 |
| POST | `/api/transition` `{ms,kind,dir}` | 过场动画(7 种)× 方向(4)× 时长;单字段调用保留其余 |
| POST | `/api/appearance` `{main,row,sidebar,stroke,brightness,zoom}` | 外观(玻璃α/描边/亮度/缩放) |
| POST | `/api/readability` `{auto}` | 智能可读性开关 |
| GET/POST | `/api/presets[/apply|/save|/delete]` | 外观预设:出厂七套清单 / 应用 / 保存自定义 / 删除 |
| POST | `/api/luminance` `{v}` | 播放器亮度采样上报(0~1) |
| POST | `/api/advanced` `{occlusion,sceneFps,lyrics}` | 遮挡暂停 / 帧率上限 / 歌词跑马灯开关 |
| GET | `/api/nowplaying` | Windows 媒体控件当前播放(SMTC) |
| GET | `/api/lyrics?title=x&artist=y` | lrclib.net 同步歌词搜索(带缓存) |
| POST | `/api/upload?filename=x` | 上传自定义壁纸(原始字节体,支持图片/视频/单文件 HTML) |
| POST | `/api/scan` | 重新扫描壁纸库 |
| GET | `/api/diag-log` | 最近渲染和客户端诊断记录 |
| GET | `/api/scene-progress?token=x` | Scene 资源传输状态 |
| GET/POST | `/api/we-assets` | WE 素材目录状态 / 手动配置 `{dir|null}` |
| GET | `/api/local-assets[/local/…]` | WE 官方素材消费端点(引擎 localAssets 客户端契约) |
| GET | `/scene-video/<id>` | Scene 内嵌 MP4 降级源 |
| GET | `/web-live/<id>/<file>` | Web 壁纸载荷(HTML 自动注入 WE API shim) |

## 目录结构

```
server.mjs            零依赖 HTTP 服务器:扫描/清单/静态服务/诊断/降级 API
settings-schema.js    壁纸状态唯一校验真源
public/player.*       全屏播放页(工作台控制之外的自用形态)
public/workbench.*    DSH 式壁纸工作台(左导航 + 四分区)
public/bootstrap.js   ZCode 启动引导:等待服务就绪后加载 embed.js
public/embed.js       客户端注入脚本:壁纸层 + 样式热更新 + 设置页钩子
public/panel.js       聊天窗口内的按钮与工作台模态入口
public/embed.css      动态生成的界面样式(玻璃α/描边/亮度/缩放,由服务器按状态输出)
vendor/webwallgl/     内置 WebWallGL 渲染页(上游 MIT,见 THIRD-PARTY.md)
asar-extract.js 等    ZCode 客户端集成工具(可选)
```

## 许可

本项目以 [MIT](LICENSE) 协议开源。第三方组件归属见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 致谢

- [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) —— 架构思路(场景载荷 token 协议、降级链、可读性/主题跟随、省电三档)的来源
- [oneincase/webwallgl](https://github.com/oneincase/webwallgl) —— Scene 壁纸实时渲染引擎
