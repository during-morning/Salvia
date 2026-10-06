# ❀ Salvia

一个输入框搞定**视频、音乐、番剧、小说**的搜索与下载。终端界面（TUI）和网页界面共用同一套内核，单个可执行文件，自带 ffmpeg，不需要 Python / yt-dlp。

```
@music 晴天          聚合搜索各音乐平台
@video:bilibili 原神   只搜 B站
@anime 葬送的芙莉莲    番剧：Bangumi 资料 + B站正版 + BT 资源
@novel 三体          按 Legado（阅读）书源搜小说，导出 TXT / EPUB
https://b23.tv/xxxx   直接粘贴链接（或 BV 号、YouTube id、歌曲 id …）
```

## 安装

### 安装包

到 [Releases](https://github.com/during-morning/Salvia/releases/latest) 下载对应系统的文件：

| 系统 | 安装包 | 免安装 |
| --- | --- | --- |
| Windows x64 | `salvia-<版本>-windows-x64-setup.exe`（装到用户目录并加入 PATH，无需管理员） | `salvia-<版本>-windows-x64.zip` |
| macOS Apple 芯片 | `salvia-<版本>-macos-arm64.pkg`（装到 `/usr/local/bin`） | `salvia-<版本>-macos-arm64.tar.gz` |
| macOS Intel | `salvia-<版本>-macos-x64.pkg` | `salvia-<版本>-macos-x64.tar.gz` |
| Linux x64 | `salvia_<版本>_amd64.deb`（`sudo apt install ./salvia_*.deb`） | `salvia-<版本>-linux-x64.tar.gz` |
| Linux arm64 | `salvia_<版本>_arm64.deb` | `salvia-<版本>-linux-arm64.tar.gz` |

安装包没有付费签名：Windows 若出现 SmartScreen 提示，点「更多信息 → 仍要运行」；macOS 若提示无法验证开发者，在 Finder 里右键 `.pkg` →「打开」，或到「系统设置 → 隐私与安全性」点「仍要打开」。

### 一行命令

macOS / Linux（装到 `~/.local/bin`）：

```sh
curl -fsSL https://raw.githubusercontent.com/during-morning/Salvia/main/install.sh | sh
```

Windows PowerShell（装到 `%LOCALAPPDATA%\Programs\Salvia` 并加入 PATH）：

```powershell
irm https://raw.githubusercontent.com/during-morning/Salvia/main/install.ps1 | iex
```

### npm / bun

需要 Node.js 22.13 或更新版本（推荐 24）。

```sh
npm install -g salvia
# 或
bun add -g salvia
```

不安装直接运行：`npx salvia` / `bunx salvia`。npm 版本的 ffmpeg 由 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 在安装时下载。

## 使用

运行 `salvia` 进入全屏终端界面：顶部一个输入框，下面是结果区和任务区，支持鼠标点击、滚轮、拖选复制。

| 输入 | 作用 |
| --- | --- |
| `@music <歌名>` / `@video <关键词>` / `@anime <番剧名>` / `@novel <书名>` | 聚合搜索 |
| `@music:netease 晴天`、`@video:youtube …`、`@anime:bt …`、`@novel:<书源名> …` | 只搜一个平台（`@help` 看全部） |
| `@parse <链接或编号>` 或直接粘贴链接 | 解析单个视频 / 歌曲 / 歌单 / 合集 / UP 主 / 磁力链接 |
| `@login bilibili｜netease｜qqmusic｜spotify｜douyin` | 用浏览器登录自己的账号（解锁自己账号能看的清晰度 / 音质） |
| `@dir <目录>` | 下载目录 |
| `@source add <链接或文件>` | 导入 Legado 书源 |
| `@setting` | 主题、列表样式、下载线程数等 |
| `@proxy <网站｜*> <http://代理>` | 按网站设置代理 |
| `@web [端口]` | 在浏览器里打开网页版（默认 8080） |
| `@web:server [端口]` | 局域网多人共享的服务器模式 |
| `@help` | 全部命令 |

普通文字不会被猜测，会让你选择要搜的类型。

### 命令行脚本模式

```sh
salvia @music 晴天 --pick 1               # 搜索并下载第一个结果
salvia https://www.bilibili.com/video/BV… --pick best
salvia @video 关键词 --json               # 输出 JSON
salvia web                                # 只开网页版
```

PowerShell 会把 `@xxx` 当成自己的语法，要加引号：`salvia '@music 晴天' --pick 1`。

### 数据位置

设置、登录 Cookie、下载记录（SQLite）、导入的书源都在 `~/.salvia`（Windows：`%USERPROFILE%\.salvia`），可用环境变量 `SALVIA_HOME` 改到别处。卸载程序不会删除这个目录。

## 支持的网站

- **视频**：B站（含番剧、合集、收藏夹、UP 主空间、音频）、YouTube（含频道、播放列表）、抖音（需登录）
- **音乐**：网易云、QQ音乐、酷狗、酷我、咪咕、千千、5sing、Jamendo、JOOX、汽水音乐、Apple Music、Spotify（仅元数据，音频从其他平台匹配）
- **番剧**：Bangumi（资料）、B站正版、动漫花园 / Mikan / ACG.RIP（BT）
- **小说**：Legado（阅读）格式书源；内置维基文库（公有领域）书源，其他书源用 `@source add` 导入

部分平台在中国大陆以外访问受限，可以用 `@proxy` 为该网站指定代理。

## 从源码构建

```sh
git clone https://github.com/during-morning/Salvia.git
cd Salvia
npm install
npm run cli             # 直接运行终端界面（tsx）
npm run dev             # 网页版开发模式（Vite + 后端）
npm test                # 测试
npm run build           # 单文件可执行程序 → dist/salvia(.exe)
node scripts/package.mjs           # 当前系统的安装包 → dist/release
node scripts/build.mjs --npm       # npm 包 → dist/npm
```

推送 `v*` 标签后，GitHub Actions 会在 Windows / Linux / macOS 上分别构建安装包并发布 Release（见 `.github/workflows/release.yml`）。代码结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 说明

- Salvia 不破解 DRM、不绕过会员限制：会员内容只能用你自己账号的权限下载（`@login`）。
- BT 资源来自公开索引，下载时会向其他人分享片段，完成后立即停止；是否下载、下载什么由使用者自行负责。
- 请遵守所在地法律和各网站的服务条款，下载内容仅供个人学习使用。
