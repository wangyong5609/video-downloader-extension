# 自用视频下载器

Chrome 插件（Manifest V3），给做自媒体的人下载 B站、抖音、小红书、快手、微博上的视频、图片、封面和字幕，并支持博主主页批量下载和作品数据表导出。纯前端，没有服务器，没有构建步骤：改完文件直接在 `chrome://extensions` 里重新加载。

## 项目主人和产品原则

项目主人不是程序员。和他沟通用中文、大白话，少用术语；给文件里写的注释也用中文，写清楚“这段是干什么的”。

这些是他明确定下的规则，改功能前先对照：

- **只做完全不花钱就能拿到的内容。** 平台不提供的东西就不做，不接语音识别之类的付费服务。所以字幕只有 B站 和 YouTube 有。
- **只服务自媒体平台。** 不要在无关网站或“通用能力”上花时间。
- **不连任何第三方服务器。** 所有解析和下载都在用户自己的浏览器里完成。
- **不绕过版权保护（DRM）**，YouTube 只下字幕不下视频。
- **把它当产品做**：好看、好用、一步到位。用户点了下载，必须立刻在当前页面看到反馈；不要打开新标签页去干活。
- 有明确推荐方案时直接做，在回复里说明选了什么。只有涉及花钱、账号、不可撤销的操作时才停下来问。

## 代码结构

| 文件 | 运行在哪 | 作用 |
|---|---|---|
| `background.js` | 后台 service worker | 嗅探视频请求；建立下载任务；给下载请求补 Referer；页面按钮的 `quickDownload` / `quickSubtitle` |
| `hook.js` | 网页主环境（MAIN world，`document_start`） | 包住 `fetch` / `XMLHttpRequest`，把抖音、快手、微博接口返回的作品数据和 YouTube 字幕存到 `window.__vdl` |
| `inpage.js` | 网页隔离环境（content script） | 页面内界面，全部在 closed Shadow DOM 里：悬停下载按钮、B站 字幕按钮、右下角批量按钮、右侧面板（iframe）、进度提示条 |
| `offscreen.html` / `offscreen.js` | 后台隐藏页面 | 真正执行下载的地方，任务排队一个一个跑 |
| `job.js` | 被 `offscreen.html`、`batch.html`、`job.html` 共用 | 下载核心：`runDirect` / `runMerge`（ffmpeg.wasm 合并音画）/ `runHls` / `runImages`、`saveBlob` |
| `job.html` | 标签页 | 后备方案：后台隐藏页面起不来时，退回在标签页里下载 |
| `providers.js` | 被 `background.js` 和 `batch.html` 共用 | 各平台取列表、补数据、取下载地址的函数；`pickFormat` 按清晰度偏好挑版本 |
| `batch.html` / `batch.js` | 独立窗口，或嵌在网页右侧的 iframe（`?embed=1`） | 批量面板：列表、筛选、下载、导出 CSV |
| `popup.html` / `popup.js` | 插件图标弹窗 | 当前作品卡片，可选清晰度 |
| `shared.js` | 后台和弹窗共用 | YouTube 字幕抓取、字幕文本生成 |
| `ui.css` | 弹窗、批量面板、任务页共用 | 设计规范：白底、墨色主按钮、暖橙强调色 `#ff5a1f`，跟随系统深浅色 |

### 几个容易踩的地方

- **送进网页执行的函数必须自成一体。** `chrome.scripting.executeScript({ func })` 只序列化函数本身，里面不能引用外面的变量或函数。`providers.js` 里的 `biliResolve`、`xhsResolve` 等都是这种。
- **一次下载的流程：** 界面 → `background.js` 的 `createJob` → 发给 `offscreen.js` 排队 → `job.js` 下载 / 合并 → `saveBlob` 发现没有 `chrome.downloads`，把 blob 地址交回后台存盘 → 后台把进度转给发起下载的标签页，同时写到插件图标的角标上。
- **Referer 靠 declarativeNetRequest 的会话规则。** B站 的视频服务器不带正确的 Referer 会拒绝。后台任务的规则在 `setJobReferer`；嵌在网页里的批量面板用的是另一条按标签页限定的规则，优先级更高。
- **保存 blob 必须写明 MIME 类型**，否则 Chrome 会自己猜，把扩展名改成 `.txt`。
- **每个清晰度只给用户一个选项**，优先 H.264，其次 H.265。
- **下载是整个文件进内存再存盘**，单文件超过约 1.8 GB 会被 `fetchBytes` 拦下。这是已知短板。

### 各平台数据从哪来

| 平台 | 来源 |
|---|---|
| B站 | 页面里调 `x/web-interface/view`、`x/player/playurl`（不用签名的旧接口可用）；字幕 `x/player/wbi/v2`，**必须登录才返回字幕** |
| 抖音 | `hook.js` 截获 `/aweme/v*/` 接口；当前视频的编号在播放器外层的 `data-e2e-vid` 属性上；刷到直播（`data-e2e="feed-live"`）时没有作品数据 |
| 小红书 | `window.__INITIAL_STATE__`（值可能是 Vue 的 ref，要取 `_rawValue`）；视频流分组名是代号（`EF4` 之类），不能按 `h264` / `h265` 取；批量时逐篇抓笔记页 |
| 快手 | `hook.js` 截获 `/rest/v/feed/hot` 等，作品在 `feeds[].photo`，地址在 `manifest` / `manifestH265` |
| 微博 | `hook.js` 截获 `/ajax/`，详情页用 `/ajax/statuses/show?id=` |
| YouTube | 字幕请求必须带播放器生成的令牌，自己拼会返回空。做法是让播放器自己加载，`hook.js` 抄下内容 |

平台经常改版。某个平台突然不行了，先怀疑数据结构变了：在取数据的函数里临时返回字段名看一眼，改完把诊断代码删掉。

## 怎么测试

改完先跑语法检查：

```bash
for f in *.js; do node --check "$f"; done
```

**界面和下载流程必须在真实浏览器里验证，光看代码不算。** 两条路：

1. 操作项目主人的 Chrome。改了 `background.js`、`hook.js`、`inpage.js`、`manifest.json` 之后要在 `chrome://extensions` 重新加载插件，并刷新目标网页；只改弹窗、批量面板、`job.js` 不用重载。
2. 独立的测试浏览器。用 `puppeteer-core` 驱动 Chrome for Testing，带 `--load-extension` 加载本目录，通过 service worker 直接调用 `quickDownload` 等函数，再检查下载目录里的文件。不需要登录就能测 B站 的下载和合并。

   注意：这种测试环境会无视插件指定的文件名（存成随机名或 `download`），所以**文件名对不对只能在真实浏览器里看**。

下载结果用 `ffprobe` 看是否同时有画面和声音，不要只看“显示完成”。

向项目主人汇报时，分清“实际测过”和“写了没测”，没测的要明说。

## 发布

- 仓库是公开的。提交前检查没有密钥、本机路径、个人信息、残留的调试代码。
- `lib/ffmpeg/` 是第三方的 ffmpeg.wasm，不要改动。
- README 里的功能表带验证状态，功能有变化时同步更新，不要把没验证的写成可用。
