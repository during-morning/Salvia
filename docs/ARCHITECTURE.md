# Salvia 的模块结构

Salvia 由模块组装而成。core 不认识任何网站：每个平台都是一个模块，向注册表登记自己能处理的链接、编号、登录页、网络，以及它给各个功能提供的能力。

## 分层（只能向下依赖）

```
core ← media ← 功能（video、music、anime、novel）← platforms ← app ← server / cli
```

| 包 | 内容 | 可以依赖 |
|---|---|---|
| `core` | Session、任务队列、注册表（`registry.ts`）、输入语法（`intent.ts`）、http/代理、数据库、设置、浏览器登录、连通性检测 | 无 |
| `media` | ffmpeg、分片下载、试听播放、`@ffmpeg` | core |
| `video` | `VIDEO_SOURCES` 槽：链接 → 合集 → 格式 → 下载，`@video` 搜索 | core、media |
| `music` | `MUSIC_PROVIDERS`、`AUDIO_MATCHERS` 槽：搜索与排序、匹配链、同名回退、歌词、预览、音乐设置 | core、media |
| `anime` | `ANIME_SOURCES` 槽：Bangumi 资料、`@anime` | core |
| `novel` | Legado 书源引擎 | core |
| `platforms` | 每个平台一个目录（bilibili、youtube、douyin、bt、netease、qq……） | core、media、功能包 |
| `app` | 组合层：安装全部模块、`createSession`、`prewarm` | 以上全部 |
| `server` | HTTP / SSE、服务端模式（会话、限流） | core、media |
| `cli`、`web` | 终端界面、网页界面 | — |

以下规则由 `packages/app/test/architecture.test.ts` 检查，违反即测试失败：
- 功能包不 import 平台，功能包之间也互不 import；
- 平台目录之间互不 import；
- core 里不出现任何网站名。

## 注册表（`core/src/registry.ts`）

模块的形式是 `SalviaModule { id, setup(api) }`。在 `setup` 里可以登记：

| 方法 | 作用 |
|---|---|
| `api.host({ pattern, kind, site })` | 这些域名的链接交给哪个站点处理 |
| `api.id({ pattern, link, platform?, bare?, label? })` | 裸编号（BV号、歌曲号）。`bare` 越小越先匹配；负数表示不用 `@parse` 也能识别 |
| `api.platform({ type, id, name, aliases })` | `@music:<id>` / `@video:<id>` 的平台 |
| `api.login(id, LoginSite, aliases)` | `@login <id>` 的登录页；`aliases` 里的值也可以用作结果的 `locked.site` |
| `api.site({ id, hosts, probe?, region?, prewarm? })` | 网络：`@proxy` 的键、启动时的连通性探测、是否仅限中国大陆、预热地址 |
| `api.provide(SLOT, value)` | 往功能包声明的能力槽里放实现 |
| `api.handler` / `api.command` / `api.setting` / `api.warm` | handler、命令、设置项、后台预热 |

注意：模块的安装顺序决定了重叠域名的优先级（先装的先匹配），也决定了补全列表的顺序。组合顺序写在 `packages/app/src/index.ts`，平台顺序写在 `packages/platforms/src/index.ts`。

## 链接解析

处理顺序如下：
1. **识别不出平台的链接**（如 t.cn、apple.co、c.migu.cn、jamen.do 这类短链或分享链）：`Session` 用 core 的 `followRedirects` 跟随 HTTP 跳转，以及页面里的 meta refresh 或脚本跳转，然后按落地地址重新分派。
2. **平台自己的分享链**（b23.tv、v.douyin.com、163cn.tv、spotify.link、酷狗 t1/m 站、咪咕 c 站）：由各平台在 `list` 里调用同一个 `followRedirects`。
3. **链接里没有编号的页面**：由平台读取页面数据，例如：
   - 酷狗 mixsong / share 页面里的 hash；
   - YouTube `@频道` 页面里的频道 id；
   - BT 资源页里的种子或磁力链接。

## 新增一个平台

1. 新建目录 `packages/platforms/src/<名字>/`。
2. 写实现：API 客户端，以及要提供的能力。例如：
   - 音乐平台写一个 `MusicProvider`；
   - 视频网站写一个 `VideoSource`；
   - 动漫片源写一个 `AnimeSource`。
3. 写 `module.ts`。它只做登记：`host`、`id`、`platform`、`login`、`site`，以及 `provide(...)`。
   - 平台特有的知识写在 provider 的字段上，不要让功能包去判断平台名。字段包括：
     - `defaultSearch`、`exactRank`、`lyricsFallback`；
     - `account.loggedIn()`、`matchOnly`、`video`；
     - `standIn`、`fetchAudio`、`clip`、`details`。
4. 在 `packages/platforms/src/index.ts` 的 `platformModules` 里加上这个模块。
5. 测试放在 `packages/platforms/test/`。如果有链接或编号的路由规则，在 `packages/app/test/routing.test.ts` 里加一行。

## 视图与推送

`Session` 把界面状态分成五个部分：
- `list`（结果、表格列、批量操作、能否返回）
- `status`
- `tasks`
- `playback`
- `prefs`

推送规则：
- **只推送变化的部分。** 某部分变化后，发出带有这些部分的 `patch` 事件；TUI 仍然订阅完整的 `view`。
- **结果列表只序列化一次。** `list` 的 JSON 按版本号缓存，同一次变化供所有连接复用。
- **下载进度限频。** 进度最多每秒推送 4 次；任务新增、完成、失败、移除时立即推送。

网页端连接 `/api/events` 时：
- 先收到一次完整的 `view`，之后只收 `patch`；
- 连接写不动（网络慢）时，后续的 patch 先合并暂存，等缓冲区排空后只发最新的一份。

静态资源在启动时预先压缩（brotli / gzip），并带 ETag：
- 带哈希的 `/assets/*` 长期缓存；
- `index.html` 每次重新验证。

用 `npx tsx scripts/bench-server.ts [客户端数] [秒数]` 测量推送流量和服务器 CPU。
