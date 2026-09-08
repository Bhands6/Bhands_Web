# BhandsMusic Web 网页版迁移实施计划

> 项目来源：
> https://github.com/Bhands6/BhandsMusicChange
>
> 项目名称：BhandsMusic Web
>
> 目标：将现有 BhandsMusic Windows Electron 桌面音乐播放器迁移为真正可运行的 Web 网页版。
>
> 本文档不是需求概述，而是给 AI Agent / Coding Agent 执行的完整工程实施方案。
>
> **Agent 必须先阅读整个文档，再开始修改代码。不要边看边大规模重构。**

---

# 0. Agent 执行总原则

## 0.1 核心目标

将当前：

```text
Electron
├── Electron Main Process
├── Electron Preload
├── 本地 HTML/CSS/JS
├── Node Music Server
├── 本地文件系统
├── Electron BrowserWindow
└── Electron IPC
```

改造成：

```text
Browser
│
├── Web Frontend
│   ├── React
│   ├── TypeScript
│   ├── CSS
│   ├── Web Audio API
│   ├── Canvas/WebGL
│   └── Three.js
│
└── HTTP API
        │
        ▼
Node.js Backend
├── 音乐搜索
├── 音源解析
├── 歌词
├── 天气
├── 用户数据
├── 网易云相关接口
├── QQ 音乐相关接口
└── 第三方 API Proxy
```

---

# 1. 最重要的迁移原则

## 1.1 不允许直接重写整个项目

当前仓库已经包含大量已经实现的音乐业务逻辑。

当前仓库主要结构：

```text
BhandsMusicChange
├── build/
├── desktop/
│   ├── main.js
│   ├── preload.js
│   └── overlay-preload.js
├── docs/
├── public/
│   ├── assets/
│   ├── js/
│   │   ├── main.js
│   │   ├── server.js
│   │   └── dj-analyzer.js
│   ├── styles/
│   ├── vendor/
│   ├── index.html
│   ├── desktop-lyrics.html
│   └── wallpaper.html
├── server/
│   └── music-sources/
└── package.json
```

当前 README 已经明确包含：

* 多音源解析
* GD 音乐台
* UnblockNeteaseMusic
* LX Music 音源脚本
* 自定义 API
* 网易云相关能力
* QQ 音乐相关能力
* Open-Meteo 天气电台
* 歌词舞台
* 粒子视觉
* 3D 歌单架
* DJ / Podcast 视觉
* 自定义歌词
* 自定义封面
* 搜索
* 歌单
* 播客
* 用户本地数据

这些功能原则上全部保留。

---

# 2. 最终产品定位

最终产品应该成为：

> **BhandsMusic Web —— 沉浸式在线音乐播放器**

访问：

```text
https://你的域名/
```

即可使用。

不需要：

```text
.exe
Electron
安装程序
Windows
```

支持：

```text
Chrome
Edge
Firefox
Safari
Android Chrome
iOS Safari
移动端浏览器
桌面浏览器
```

优先保证：

```text
Chrome / Edge Desktop
Chrome Android
Safari iOS
```

---

# 3. 推荐技术栈

## Frontend

必须采用：

```text
React
TypeScript
Vite
```

推荐：

```text
React 19+
TypeScript
Vite
```

不要继续维护超大单文件：

```text
public/js/main.js
```

必须逐步拆分。

---

# 4. 推荐前端依赖

建议：

```text
react
react-dom
react-router-dom
zustand
three
@react-three/fiber
@react-three/drei
gsap
axios
idb
lucide-react
```

如果项目已有 GSAP：

```text
继续复用
```

不要重复安装多个动画库。

---

# 5. Backend

继续使用：

```text
Node.js
```

推荐：

```text
Fastify
```

或者：

```text
Express
```

优先：

```text
Fastify
```

后端职责：

```text
API Proxy
音乐搜索
音乐 URL 解析
歌词
天气
第三方服务
Cookie / Session
音源管理
缓存
```

---

# 6. 最终目录结构

Agent 最终应该将项目逐渐调整成：

```text
BhandsMusicWeb/
│
├── apps/
│   │
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── components/
│   │   │   ├── pages/
│   │   │   ├── layouts/
│   │   │   ├── stores/
│   │   │   ├── hooks/
│   │   │   ├── services/
│   │   │   ├── api/
│   │   │   ├── audio/
│   │   │   ├── visual/
│   │   │   ├── lyrics/
│   │   │   ├── playlist/
│   │   │   ├── weather/
│   │   │   ├── three/
│   │   │   ├── utils/
│   │   │   └── types/
│   │   │
│   │   ├── public/
│   │   ├── index.html
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   └── server/
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   ├── adapters/
│       │   ├── middleware/
│       │   ├── cache/
│       │   └── index.ts
│       │
│       └── package.json
│
├── packages/
│   ├── shared/
│   ├── music-core/
│   └── visual-core/
│
├── public-assets/
│
├── docs/
│
├── package.json
├── README.md
└── WEB_MIGRATION_PLAN.md
```

---

# 7. 第一阶段：项目审计

Agent 开始工作后：

**禁止立即修改代码。**

首先执行：

```bash
git status
git branch
npm install
```

然后分析：

```text
desktop/main.js
desktop/preload.js
desktop/overlay-preload.js
public/index.html
public/js/main.js
public/js/server.js
public/js/dj-analyzer.js
public/styles/*
server/music-sources/*
```

建立：

```text
docs/WEB_MIGRATION_AUDIT.md
```

内容至少包括：

```text
1. 当前页面结构
2. 当前播放器结构
3. 当前音乐搜索流程
4. 当前音源解析流程
5. 当前歌词流程
6. 当前天气流程
7. 当前视觉系统
8. 当前 3D 歌单架
9. Electron API 使用位置
10. Node API 使用位置
11. 文件系统 API 使用位置
12. IPC 使用位置
13. 可以直接复用的代码
14. 必须重写的代码
15. 无法迁移的功能
```

---

# 8. 第二阶段：Electron 依赖扫描

必须搜索：

```text
electron
BrowserWindow
ipcMain
ipcRenderer
contextBridge
webContents
dialog
shell
app.getPath
app.getAppPath
nativeImage
Menu
Tray
globalShortcut
session
protocol
fs
path
child_process
process
```

建立迁移表：

| Electron 能力        | Web 替代方案                |
| ------------------ | ----------------------- |
| BrowserWindow      | 浏览器页面                   |
| ipcMain            | HTTP API                |
| ipcRenderer        | fetch / axios           |
| preload            | Web API / React service |
| app.getPath        | IndexedDB / OPFS        |
| dialog             | `<input type=file>`     |
| shell.openExternal | `window.open()`         |
| fs                 | File System Access API  |
| path               | 浏览器不可用，改为后端处理           |
| child_process      | Node Server             |
| globalShortcut     | 浏览器快捷键                  |
| Tray               | 删除                      |
| native window      | 删除                      |
| window bounds      | CSS                     |
| Electron menu      | Web UI                  |
| autoUpdater        | Web deploy / PWA 更新     |

---

# 9. 第三阶段：建立新的 Web Frontend

创建：

```text
apps/web
```

初始化：

```bash
npm create vite@latest apps/web -- --template react-ts
```

然后安装：

```bash
npm install
```

---

# 10. Frontend 页面结构

至少实现：

```text
/
├── Home
├── Search
├── Playlist
├── Library
├── Player
├── Lyrics
├── Visual
├── Settings
└── About
```

路由：

```text
/
 /search
 /playlist/:id
 /library
 /settings
```

---

# 11. 首页设计

首页必须保留现有 BhandsMusic 的核心视觉。

当前项目 README 描述的首页功能包括：

```text
天气电台
每日推荐
私人电台
继续听
听歌画像
我的歌单
银河 Wallpaper
```

因此 Web 首页：

```text
┌─────────────────────────────────────┐
│ Logo                  Search   ⚙    │
├─────────────────────────────────────┤
│                                     │
│        银河动态背景                 │
│                                     │
│      当前天气 / 时间 / Mood          │
│                                     │
│         今日推荐                    │
│                                     │
├─────────────────────────────────────┤
│ Continue Listening                  │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐       │
│ │    │ │    │ │    │ │    │       │
│ └────┘ └────┘ └────┘ └────┘       │
├─────────────────────────────────────┤
│ My Playlist                         │
└─────────────────────────────────────┘
```

---

# 12. 播放器核心

必须建立：

```text
AudioEngine
```

位置：

```text
apps/web/src/audio/AudioEngine.ts
```

负责：

```text
play()
pause()
toggle()
seek()
setVolume()
next()
previous()
setLoop()
setShuffle()
```

播放器状态：

```typescript
interface PlayerState {
    currentTrack: Track | null
    queue: Track[]
    currentIndex: number
    playing: boolean
    duration: number
    currentTime: number
    volume: number
    muted: boolean
    shuffle: boolean
    repeatMode: "none" | "one" | "all"
}
```

---

# 13. Web Audio API

必须使用：

```text
AudioContext
AnalyserNode
GainNode
MediaElementAudioSourceNode
```

结构：

```text
HTMLAudioElement
       │
       ▼
MediaElementSource
       │
       ├──────────────► GainNode ─────► Destination
       │
       ▼
AnalyserNode
       │
       ▼
Visual System
```

这样可以让：

```text
音乐播放
↓
频谱分析
↓
粒子
↓
3D
↓
歌词舞台
```

同步。

---

# 14. 音频分析

创建：

```text
audio/AudioAnalyzer.ts
```

输出：

```typescript
interface AudioAnalysis {
    bass: number
    mid: number
    treble: number
    volume: number
    energy: number
    waveform: Float32Array
    frequency: Uint8Array
}
```

用于：

```text
粒子
背景
3D 模型
光效
Beat
DJ 模式
Podcast 模式
```

---

# 15. 粒子视觉系统

必须保留现有：

```text
粒子视觉
```

不要简单改成 CSS animation。

推荐：

```text
Canvas
+
WebGL
+
Three.js
```

创建：

```text
visual/
├── VisualEngine.ts
├── ParticleSystem.ts
├── BeatDetector.ts
├── VisualPreset.ts
└── VisualManager.ts
```

---

# 16. VisualEngine

接口：

```typescript
interface VisualEngine {
    init(container: HTMLElement): void
    update(audio: AudioAnalysis): void
    resize(): void
    setPreset(preset: string): void
    destroy(): void
}
```

---

# 17. 视觉模式

至少实现：

```text
Galaxy
Particle
Emily
Default
DJ
Podcast
Wallpaper
```

原项目已经存在不同视觉模式。

Web 版必须继续支持。

---

# 18. Beat Detection

继续保留：

```text
DJ Analyzer
```

但不能依赖 Node-only API。

重新封装：

```text
audio/BeatDetector.ts
```

使用：

```text
AnalyserNode
```

计算：

```text
bass energy
overall energy
spectral flux
beat threshold
```

---

# 19. 3D 歌单架

当前项目具有：

```text
3D Playlist Shelf
```

必须保留。

使用：

```text
Three.js
@react-three/fiber
@react-three/drei
```

结构：

```text
three/
├── PlaylistShelf.tsx
├── AlbumCard3D.tsx
├── ShelfCamera.tsx
├── ShelfLighting.tsx
└── ShelfController.ts
```

---

# 20. 3D 歌单架交互

支持：

```text
鼠标拖动
鼠标滚轮
触摸滑动
点击专辑
双击播放
键盘左右
```

移动端：

```text
touchstart
touchmove
touchend
```

---

# 21. 歌词系统

建立：

```text
lyrics/
├── LyricsEngine.ts
├── LyricsParser.ts
├── LyricsRenderer.tsx
└── LyricsSync.ts
```

支持：

```text
普通歌词
逐行歌词
自定义歌词
歌词位置
歌词舞台
歌词滚动
当前行高亮
```

---

# 22. 歌词同步

使用：

```text
audio.currentTime
```

而不是：

```text
setInterval
```

歌词时间轴：

```typescript
interface LyricLine {
    time: number
    duration?: number
    text: string
}
```

每帧根据：

```text
currentTime
```

确定当前歌词。

---

# 23. 搜索系统

建立：

```text
api/music.ts
```

统一：

```text
search()
searchSongs()
searchArtists()
searchAlbums()
searchPlaylists()
```

不要让 React Component 直接请求第三方 API。

必须：

```text
Component
↓
Store
↓
Service
↓
API Client
↓
Backend
```

---

# 24. 后端 API

建立：

```text
/api/search
/api/song
/api/song/url
/api/song/lyrics
/api/playlist
/api/playlist/:id
/api/artist
/api/weather
/api/source
```

---

# 25. 音源架构

当前项目支持多种音源。

不要把音源逻辑写死。

建立：

```text
server/src/adapters/
```

例如：

```text
NeteaseAdapter
QQMusicAdapter
GDAdapter
UnblockAdapter
LXMusicAdapter
CustomApiAdapter
```

统一接口：

```typescript
interface MusicSourceAdapter {

    search(
        keyword: string,
        options?: SearchOptions
    ): Promise<SearchResult>

    getSongUrl(
        track: Track,
        quality: AudioQuality
    ): Promise<string | null>

    getLyrics(
        track: Track
    ): Promise<LyricData | null>

}
```

---

# 26. 音源优先级

保留现有逻辑：

```text
官方高质量音源
↓
第三方高质量
↓
FLAC
↓
320K
↓
128K
```

如果一个源失败：

```text
自动 fallback
```

例如：

```text
Source A
   ↓失败
Source B
   ↓失败
Source C
   ↓
播放
```

---

# 27. CORS

这是从 Electron 迁移到 Web 最大的问题之一。

Electron 中：

```text
Renderer
↓
Node
```

可以绕过很多浏览器限制。

Web 中：

```text
Browser
↓
第三方 API
```

会遇到：

```text
CORS
Cookie
Referer
Origin
Mixed Content
```

所以：

**禁止前端直接请求所有第三方音乐 API。**

统一：

```text
Browser
 ↓
BhandsMusic Backend
 ↓
Third Party API
```

---

# 28. 后端 Proxy

建立：

```text
server/src/routes/proxy.ts
```

所有需要 CORS 处理的第三方请求：

```text
Frontend
↓
/api/*
↓
Backend
↓
Third Party
```

---

# 29. 音频 URL

需要重点处理：

```text
HTTP
HTTPS
302
Range
Content-Type
Content-Length
Accept-Ranges
```

浏览器播放器必须支持：

```text
Range Request
```

否则长音乐可能无法正常 seek。

---

# 30. 音频播放格式

优先支持：

```text
mp3
aac
m4a
ogg
opus
wav
flac
```

但：

**不要假设浏览器支持所有格式。**

必须实现：

```text
canPlayType()
```

检测。

---

# 31. FLAC

如果浏览器原生支持：

```text
直接播放
```

否则：

```text
Backend
↓
Transcode
↓
Browser
```

但第一阶段不要马上加入 FFmpeg 转码。

优先使用浏览器原生支持。

---

# 32. 本地音乐

桌面版可以访问本地文件系统。

Web 版改成：

```text
<input type="file" multiple>
```

以及：

```text
File System Access API
```

如果浏览器支持：

```text
showDirectoryPicker()
```

则允许用户选择：

```text
音乐文件夹
```

---

# 33. 本地音乐索引

不要上传用户音乐到服务器。

必须：

```text
浏览器本地处理
```

数据存储：

```text
IndexedDB
```

文件缓存：

```text
IndexedDB
或
OPFS
```

---

# 34. 本地歌曲模型

```typescript
interface LocalTrack {

    id: string

    name: string

    artist?: string

    album?: string

    duration?: number

    fileName: string

    size: number

    mimeType: string

    lastModified: number

}
```

---

# 35. 用户数据

不能使用：

```text
Electron app.getPath()
```

改为：

```text
IndexedDB
```

保存：

```text
播放历史
搜索历史
收藏
播放列表
自定义歌词
自定义封面
视觉参数
用户设置
音量
播放位置
```

---

# 36. Storage Layer

创建：

```text
stores/
├── playerStore.ts
├── playlistStore.ts
├── settingsStore.ts
├── historyStore.ts
└── userStore.ts
```

底层：

```text
IndexedDB
```

可以使用：

```text
idb
```

---

# 37. Zustand

使用：

```text
Zustand
```

作为前端全局状态。

核心 Store：

```text
playerStore
playlistStore
libraryStore
lyricsStore
visualStore
settingsStore
weatherStore
```

---

# 38. 天气电台

当前项目使用：

```text
Open-Meteo
```

Web 版保留。

浏览器优先：

```text
navigator.geolocation
```

获取：

```text
latitude
longitude
```

然后：

```text
Open-Meteo
```

获取：

```text
temperature
weather code
wind
humidity
```

如果用户拒绝定位：

```text
显示城市选择
```

---

# 39. 天气电台

根据：

```text
天气
时间
温度
```

生成：

```text
Mood
```

例如：

```text
Rain
→
Calm

Sunny
→
Happy

Night
→
Dream

Cloudy
→
Melancholy
```

最终生成推荐队列。

---

# 40. Wallpaper

原项目存在：

```text
wallpaper.html
```

Web 版不要单独创建 Electron Window。

改为：

```text
WallpaperLayer
```

直接作为：

```text
Home Background
```

结构：

```text
App
├── WallpaperLayer
├── VisualLayer
├── UI
└── PlayerBar
```

---

# 41. 桌面歌词窗口

Electron 中：

```text
desktop-lyrics.html
```

可能是独立窗口。

Web 版改成：

```text
Lyrics Overlay
```

支持：

```text
全屏歌词
沉浸歌词
Picture-in-Picture-like UI
```

如果浏览器支持：

```text
Document Picture-in-Picture API
```

可以作为增强功能。

否则：

```text
普通全屏页面
```

---

# 42. Overlay

不要再依赖：

```text
Electron BrowserWindow
```

改为：

```text
position: fixed
```

实现：

```text
Lyrics Overlay
Visual Overlay
Player Overlay
```

---

# 43. 键盘快捷键

Web 版实现：

```text
Space
→ Play/Pause

ArrowLeft
→ Previous / Seek

ArrowRight
→ Next / Seek

ArrowUp
→ Volume+

ArrowDown
→ Volume-

M
→ Mute

L
→ Lyrics

V
→ Visual
```

必须避免输入框获得焦点时触发。

---

# 44. 移动端

必须实现：

```text
responsive
```

至少：

```text
375px
390px
414px
768px
1024px
1440px
1920px
```

---

# 45. 移动端 UI

移动端底部固定：

```text
┌─────────────────────────┐
│ Cover │ Song      ▶     │
├─────────────────────────┤
│ Home Search Library Me  │
└─────────────────────────┘
```

桌面：

```text
左侧 Sidebar
中间 Content
底部 Player
右侧 Lyrics / Queue
```

---

# 46. 响应式断点

建议：

```css
@media (max-width: 768px)
@media (min-width: 769px)
@media (min-width: 1200px)
```

---

# 47. UI 组件拆分

不要继续：

```text
main.js 2000+ lines
```

拆成：

```text
components/
├── AppShell
├── Sidebar
├── Header
├── SearchBar
├── PlayerBar
├── PlayerControls
├── VolumeControl
├── TrackList
├── TrackCard
├── AlbumCard
├── PlaylistCard
├── LyricsPanel
├── LyricsStage
├── VisualStage
├── WeatherCard
├── RecommendationCard
├── PlaylistShelf
├── SettingsPanel
└── Modal
```

---

# 48. 播放器 UI

播放器底部：

```text
┌──────────────────────────────────────────────┐
│ Cover │ Title / Artist                      │
│       │ ───────────────●──────────           │
│       │ 01:20 / 04:23                       │
│       │                                      │
│       │       ◀   ▶   ▶   🔀   🔁          │
│       │                         🔊           │
└──────────────────────────────────────────────┘
```

---

# 49. 搜索页面

支持：

```text
歌曲
歌手
专辑
歌单
播客
```

搜索结果：

```text
Cover
Title
Artist
Album
Duration
Source
Play
Add
```

---

# 50. 搜索防抖

搜索：

```text
debounce 300~500ms
```

不要每输入一个字符都发送请求。

---

# 51. 播放队列

支持：

```text
添加下一首
添加到队列
移除
拖动排序
清空
随机
循环
```

---

# 52. Playlist

支持：

```text
创建
删除
重命名
添加歌曲
移除歌曲
排序
播放
```

数据保存：

```text
IndexedDB
```

---

# 53. 收藏

支持：

```text
喜欢
取消喜欢
```

使用：

```text
libraryStore
```

---

# 54. 播放历史

记录：

```text
trackId
playCount
lastPlayedAt
progress
```

---

# 55. Continue Listening

首页读取：

```text
historyStore
```

展示：

```text
最近播放
继续播放
```

---

# 56. 用户头像 / 用户资料

如果当前项目存在用户信息：

Web 版必须区分：

```text
第三方音乐平台用户
```

和：

```text
BhandsMusic Web Local User
```

第一阶段不实现自己的账号系统。

默认：

```text
Local User
```

---

# 57. 网易云登录

浏览器版不能直接复制 Electron Cookie 方案。

必须重新设计：

```text
Backend Session
```

如果第三方登录允许：

```text
OAuth
```

优先 OAuth。

如果必须 Cookie：

```text
HttpOnly Cookie
Secure
SameSite
```

后端管理。

禁止：

```text
localStorage
```

保存敏感 Cookie。

---

# 58. QQ 音乐

同样：

```text
Backend Adapter
```

不要：

```text
React → QQ Music
```

直接访问。

---

# 59. LX Music Script

当前项目支持：

```text
LX Music 音源脚本
```

这是迁移中最需要特别处理的模块。

Web 浏览器禁止随意执行：

```text
eval()
new Function()
```

尤其是远程脚本。

因此必须：

```text
Server Sandbox
```

执行。

---

# 60. LX Script Sandbox

推荐：

```text
Node.js Worker
```

或者：

```text
isolated-vm
```

如果现有脚本兼容：

```text
vm
```

也可以。

要求：

```text
限制 CPU
限制内存
限制网络
限制文件系统
禁止 process
禁止 fs
禁止 child_process
```

---

# 61. 安全要求

绝对禁止：

```text
eval(userInput)
new Function(userInput)
直接执行远程 JS
```

---

# 62. 自定义 API

允许用户在：

```text
Settings
→ Music Sources
```

添加：

```text
API URL
API Name
API Type
Priority
Enabled
```

---

# 63. 音源管理界面

例如：

```text
Music Sources

● Netease
  Priority: 1
  Status: Online

● QQ Music
  Priority: 2
  Status: Online

● GD Music
  Priority: 3
  Status: Online

● Custom API
  Priority: 4
```

---

# 64. API 状态

后端提供：

```text
GET /api/source/status
```

返回：

```json
{
  "name": "netease",
  "online": true,
  "latency": 123
}
```

---

# 65. Cache

后端增加：

```text
Memory Cache
```

缓存：

```text
搜索
歌词
歌单
歌曲信息
天气
```

TTL：

```text
搜索：1~5 分钟
歌词：1 天
天气：10 分钟
歌曲 metadata：1 天
```

---

# 66. 前端缓存

使用：

```text
IndexedDB
```

保存：

```text
最近搜索
最近歌曲
歌词
playlist metadata
```

---

# 67. 网络断开

Web 版必须检测：

```text
navigator.onLine
```

显示：

```text
Offline
```

如果歌曲已经加载：

```text
继续播放
```

---

# 68. PWA

第二阶段加入：

```text
PWA
```

支持：

```text
Add to Home Screen
```

添加：

```text
manifest.webmanifest
service-worker
```

但：

**不要缓存音乐文件到 Service Worker。**

---

# 69. Service Worker

只缓存：

```text
HTML
CSS
JS
图片
字体
```

音乐：

```text
不缓存
```

---

# 70. Three.js 性能

必须考虑：

```text
GPU
FPS
Mobile
Memory
```

默认：

```text
60 FPS
```

移动端：

```text
30~60 FPS
```

低端设备自动降低：

```text
particle count
pixel ratio
post processing
```

---

# 71. Visual Quality

不要因为迁移 Web 就把视觉效果降级成：

```text
简单 CSS 粒子
```

目标：

```text
Electron 视觉效果 ≈ Web 视觉效果
```

---

# 72. GPU 自适应

初始化：

```text
devicePixelRatio
```

限制：

```text
Math.min(devicePixelRatio, 2)
```

移动端：

```text
Math.min(devicePixelRatio, 1.5)
```

---

# 73. 3D 模型资源

当前仓库存在：

```text
public/assets/skull-decimation-points.bin
```

以及视觉相关资源。

迁移时：

```text
不要删除
```

逐项判断：

```text
Web 是否需要
Three.js 是否能加载
是否需要转换
```

---

# 74. 静态资源

统一：

```text
public-assets/
```

或者：

```text
apps/web/public/assets/
```

最终不能继续依赖：

```text
Electron __dirname
```

所有资源使用：

```text
/public/assets/xxx
```

或者 Vite import。

---

# 75. 路径迁移

禁止：

```javascript
path.join(__dirname, ...)
```

前端改成：

```text
import asset from "./asset"
```

或：

```text
/assets/xxx
```

---

# 76. CSS

现有：

```text
public/styles
```

不要一次性全部删除。

迁移策略：

```text
第一阶段
保留原 CSS

第二阶段
拆分 CSS

第三阶段
组件化 CSS
```

---

# 77. 主题系统

建立：

```text
ThemeProvider
```

支持：

```text
Default
Dark
Glass
Galaxy
```

至少保留：

```text
Galaxy
```

作为默认主题。

---

# 78. CSS Variables

统一：

```css
--bg
--surface
--surface-glass
--text
--text-secondary
--accent
--border
--blur
--radius
```

---

# 79. Glass UI

现有项目有：

```text
GLASS_SVG_TEXTURE.md
```

相关设计不要丢失。

Web 版继续使用：

```text
backdrop-filter
```

配合：

```text
rgba
border
blur
noise
```

实现玻璃质感。

---

# 80. 首页动画

继续使用：

```text
GSAP
```

实现：

```text
页面进入
卡片出现
搜索过渡
播放状态切换
歌词舞台切换
3D Shelf
```

---

# 81. React 与 GSAP

不要在组件 render 中创建 GSAP。

使用：

```text
useEffect
useLayoutEffect
useRef
```

并在：

```text
cleanup
```

时：

```text
gsap.killTweensOf()
```

---

# 82. Player 与 Visual 解耦

不要：

```text
Player Component
直接操作 Three.js
```

应该：

```text
Player
 ↓
AudioEngine
 ↓
AudioAnalyzer
 ↓
VisualEngine
```

---

# 83. Event Bus

如果需要跨模块通信：

```text
EventBus
```

事件：

```text
TRACK_CHANGED
PLAY
PAUSE
TIME_UPDATE
LYRICS_CHANGED
VISUAL_CHANGED
QUEUE_CHANGED
```

但优先使用 Zustand。

EventBus 只用于：

```text
高频实时事件
```

---

# 84. 高频数据

不要每个：

```text
audio timeupdate
```

都触发整个 React tree render。

音频分析数据：

```text
requestAnimationFrame
```

直接发送给：

```text
Canvas
Three.js
VisualEngine
```

React 只保存：

```text
低频状态
```

---

# 85. React 性能

避免：

```text
setState 60fps
```

例如：

错误：

```typescript
setFrequencyData(data)
```

每帧执行。

正确：

```text
AudioAnalyzer
→ VisualEngine
```

---

# 86. 后端结构

推荐：

```text
apps/server/src/

index.ts

routes/
├── search.ts
├── song.ts
├── playlist.ts
├── lyrics.ts
├── weather.ts
└── sources.ts

services/
├── musicService.ts
├── lyricService.ts
├── weatherService.ts
├── sourceService.ts
└── cacheService.ts

adapters/
├── NeteaseAdapter.ts
├── QQMusicAdapter.ts
├── GDAdapter.ts
├── UnblockAdapter.ts
├── LXAdapter.ts
└── CustomAdapter.ts
```

---

# 87. API 返回格式统一

例如：

```json
{
  "success": true,
  "data": {}
}
```

错误：

```json
{
  "success": false,
  "error": {
    "code": "SOURCE_UNAVAILABLE",
    "message": "Music source unavailable"
  }
}
```

---

# 88. Track 数据结构

统一：

```typescript
interface Track {

    id: string

    title: string

    artist: string

    artists?: Artist[]

    album?: Album

    duration?: number

    cover?: string

    source: string

    sourceId?: string

    playable?: boolean

}
```

---

# 89. Album

```typescript
interface Album {

    id: string

    name: string

    cover?: string

    artist?: string

}
```

---

# 90. Artist

```typescript
interface Artist {

    id: string

    name: string

    avatar?: string

}
```

---

# 91. Playlist

```typescript
interface Playlist {

    id: string

    name: string

    cover?: string

    description?: string

    tracks: Track[]

    source?: string

}
```

---

# 92. Source Normalization

不同音乐平台返回的数据不能直接暴露给 React。

必须：

```text
Netease Response
        ↓
NeteaseAdapter
        ↓
Track
        ↓
React
```

---

# 93. API 错误处理

所有 API：

```text
timeout
retry
fallback
```

例如：

```text
timeout 8 sec
retry 1 次
```

音乐 URL：

```text
失败后切换 source
```

---

# 94. Loading 状态

每个页面必须支持：

```text
Loading
Empty
Error
Success
```

---

# 95. Skeleton

搜索：

```text
TrackSkeleton
```

首页：

```text
CardSkeleton
```

歌词：

```text
LyricsSkeleton
```

---

# 96. Error Boundary

React 增加：

```text
ErrorBoundary
```

视觉模块崩溃：

```text
不能导致播放器崩溃
```

---

# 97. Visual Crash Isolation

Three.js：

```text
try/catch
```

如果 GPU 初始化失败：

```text
Fallback Visual
```

显示：

```text
CSS Visualizer
```

保证：

```text
音乐仍然可以播放
```

---

# 98. 浏览器兼容性

必须检测：

```text
Web Audio
Canvas
WebGL
IndexedDB
File System Access API
Geolocation
Document PiP
```

---

# 99. 不支持时必须降级

例如：

```text
WebGL unavailable
→ CSS Visual

IndexedDB unavailable
→ localStorage

File System Access unavailable
→ File input
```

---

# 100. 浏览器权限

天气：

```text
Geolocation
```

必须：

```text
用户主动触发
```

不能页面加载后偷偷请求。

---

# 101. 本地文件权限

不能：

```text
自动读取用户磁盘
```

必须：

```text
用户选择
```

---

# 102. Security Headers

后端至少配置：

```text
CSP
X-Content-Type-Options
Referrer-Policy
X-Frame-Options
```

如果使用：

```text
helmet
```

可以。

---

# 103. CSP

禁止：

```text
unsafe-eval
```

除非某个必要依赖确实要求。

如果必须使用：

```text
单独隔离
```

不要全站放开。

---

# 104. CORS

只允许：

```text
WEB_DOMAIN
```

开发环境：

```text
localhost
```

生产环境：

```text
正式域名
```

不要：

```text
Access-Control-Allow-Origin: *
```

用于带 Cookie 的 API。

---

# 105. 环境变量

创建：

```text
.env.example
```

例如：

```env
PORT=3000
WEB_ORIGIN=http://localhost:5173

NETEASE_API_URL=
QQ_API_URL=
GD_API_URL=

OPEN_METEO_URL=https://api.open-meteo.com
```

---

# 106. 不允许提交 Secret

禁止提交：

```text
.env
Cookie
Token
账号
密码
API Secret
```

---

# 107. 开发启动

根目录：

```bash
npm install
npm run dev
```

同时启动：

```text
Frontend
Backend
```

推荐：

```text
concurrently
```

---

# 108. 端口

开发：

```text
Frontend:
5173

Backend:
3000
```

Vite Proxy：

```text
/api
→
http://localhost:3000
```

---

# 109. Production

执行：

```bash
npm run build
```

生成：

```text
apps/web/dist
```

后端：

```text
node apps/server/dist/index.js
```

---

# 110. Production Server

后端可以直接：

```text
Fastify
```

同时：

```text
serve static frontend
```

最终：

```text
https://domain.com
```

一个域名完成：

```text
Web
+
API
```

---

# 111. Docker

建议添加：

```text
Dockerfile
docker-compose.yml
```

结构：

```text
Node
├── Frontend static
└── API
```

---

# 112. Docker 部署

最终：

```bash
docker compose up -d
```

即可运行。

---

# 113. Nginx

如果不用 Docker，也支持：

```text
Nginx
```

结构：

```text
Nginx
├── /
│   └── Web Static
│
└── /api/
    └── Node Server
```

---

# 114. HTTPS

生产环境：

```text
HTTPS 必须
```

原因：

```text
Audio
Geolocation
PWA
File System Access
部分浏览器 API
```

很多功能要求 Secure Context。

---

# 115. Git 策略

开始之前：

```bash
git checkout -b feature/web-version
```

不要直接修改：

```text
main
```

---

# 116. 每完成一个阶段

必须：

```bash
git add .
git commit
```

提交格式：

```text
feat(web): initialize web application
feat(audio): add browser audio engine
feat(api): migrate music search
feat(visual): migrate particle engine
feat(playlist): add indexeddb playlist
feat(three): add 3d playlist shelf
```

---

# 117. 第一阶段 Commit

```text
chore(web): add web architecture
```

---

# 118. 第二阶段

```text
feat(web): add responsive shell
```

---

# 119. 第三阶段

```text
feat(audio): add browser player
```

---

# 120. 第四阶段

```text
feat(api): add music backend
```

---

# 121. 第五阶段

```text
feat(visual): migrate visual system
```

---

# 122. 第六阶段

```text
feat(playlist): migrate playlist
```

---

# 123. 第七阶段

```text
feat(lyrics): migrate lyrics
```

---

# 124. 第八阶段

```text
feat(three): migrate 3d shelf
```

---

# 125. 第九阶段

```text
feat(pwa): add pwa support
```

---

# 126. 不要删除 Electron 代码

第一阶段：

```text
desktop/
```

保留。

只有：

```text
Web 版完全稳定
```

之后才可以考虑删除。

---

# 127. Web 与 Desktop 共存

最终建议：

```text
BhandsMusic
├── desktop
│   └── Electron
│
├── web
│   └── React
│
└── server
    └── shared Node backend
```

这样：

```text
Desktop
```

和：

```text
Web
```

可以共享：

```text
Music Core
Source Adapter
Lyrics
API
```

---

# 128. Shared Package

建立：

```text
packages/music-core
```

放：

```text
Track
Album
Artist
Playlist
Source
Lyrics
```

---

# 129. Desktop 未来也使用 Shared Core

最终：

```text
Desktop
 ↓
music-core

Web
 ↓
music-core
```

避免：

```text
Desktop 一套逻辑
Web 一套逻辑
```

造成维护灾难。

---

# 130. 第一版 MVP

Agent 不允许一开始就实现所有东西。

第一阶段 MVP：

```text
首页
搜索
播放
暂停
音量
进度
下一首
上一首
搜索歌曲
获取歌曲 URL
歌词
播放队列
```

必须先跑通。

---

# 131. MVP 完成条件

浏览器打开：

```text
http://localhost:5173
```

可以：

```text
搜索
↓
点击歌曲
↓
获取 URL
↓
播放
↓
看到封面
↓
看到歌词
↓
拖动进度
↓
切换下一首
```

---

# 132. 第二阶段

加入：

```text
播放列表
历史
收藏
IndexedDB
天气
```

---

# 133. 第三阶段

加入：

```text
粒子
频谱
Beat
Wallpaper
```

---

# 134. 第四阶段

加入：

```text
Three.js
3D Playlist Shelf
```

---

# 135. 第五阶段

加入：

```text
PWA
移动端
离线 UI
```

---

# 136. 第六阶段

加入：

```text
用户平台登录
高级音源
LX Script
自定义 API
```

---

# 137. 第一阶段不要做的事情

暂时不要：

```text
账号系统
数据库
云端音乐存储
社交
评论
上传音乐服务器
在线音乐 CDN
支付
```

---

# 138. 音乐版权

项目已经声明：

```text
第三方音乐平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。
```

Web 版同样遵守。

不要设计：

```text
绕过会员
批量下载
盗链传播
公开音乐 CDN
```

---

# 139. Agent 必须保留 LICENSE

当前项目：

```text
GPL-3.0
```

迁移时：

```text
LICENSE
```

必须保留。

---

# 140. README

最终重新编写：

```text
README.md
```

必须说明：

```text
BhandsMusic Web
安装
开发
生产
Docker
API
配置
音乐平台说明
版权说明
License
```

---

# 141. 自动测试

至少添加：

```text
Vitest
```

测试：

```text
musicService
source adapter
lyrics parser
playlist store
player state
```

---

# 142. E2E

建议：

```text
Playwright
```

测试：

```text
打开首页
搜索
播放
暂停
下一首
搜索结果
创建 Playlist
```

---

# 143. Playwright 测试

至少：

```text
desktop chromium
mobile chromium
mobile webkit
```

---

# 144. 性能测试

要求：

```text
首页首次加载 < 3 秒
```

正常桌面环境：

```text
视觉 FPS ≥ 55
```

移动设备：

```text
FPS ≥ 30
```

---

# 145. Lighthouse

最终目标：

```text
Performance > 80
Accessibility > 90
Best Practices > 90
SEO > 80
```

---

# 146. Bundle 优化

Three.js 等大型依赖：

```text
lazy load
```

不要：

```text
首页一次性加载全部
```

例如：

```text
VisualStage
ThreePlaylistShelf
```

使用：

```text
React.lazy()
```

---

# 147. 视觉模块懒加载

首页进入：

```text
Wallpaper
```

播放歌曲后：

```text
VisualEngine
```

用户打开 3D：

```text
Three.js
```

---

# 148. 音源懒加载

不要：

```text
所有 Adapter
```

全部初始化。

根据：

```text
source
```

动态加载。

---

# 149. API 请求取消

搜索必须：

```text
AbortController
```

避免：

```text
快速输入
→
旧请求覆盖新请求
```

---

# 150. 搜索竞态

必须保证：

```text
搜索 A
搜索 B
```

即使：

```text
A 后返回
```

也不能覆盖：

```text
B
```

---

# 151. Player Race Condition

防止：

```text
快速点击歌曲 A
↓
快速点击歌曲 B
```

A 的异步 URL 返回后：

```text
不能覆盖 B
```

---

# 152. Audio URL 生命周期

每次切歌：

```text
旧 Object URL
```

如果是 Blob：

```text
URL.revokeObjectURL()
```

---

# 153. 内存管理

Three.js：

```text
geometry.dispose()
material.dispose()
texture.dispose()
renderer.dispose()
```

页面卸载必须释放。

---

# 154. AudioContext 生命周期

浏览器可能要求：

```text
用户点击
```

之后才能：

```text
audioContext.resume()
```

所以第一次播放：

```text
用户点击 Play
→ resume()
```

---

# 155. Safari 特殊处理

特别测试：

```text
iOS Safari
```

重点：

```text
AudioContext
autoplay
fullscreen
touch
File
IndexedDB
```

---

# 156. 移动端播放

必须遵守浏览器：

```text
User Gesture
```

不能：

```text
页面加载自动播放
```

---

# 157. 音乐继续播放

如果浏览器允许：

```text
visibilitychange
```

切后台后：

```text
不要主动暂停
```

但不能保证所有移动浏览器都允许后台播放。

---

# 158. 页面切换

使用：

```text
React Router
```

但：

```text
AudioEngine
```

不能因为页面切换而销毁。

必须放在：

```text
App Root
```

生命周期内。

---

# 159. 全局 AudioEngine

结构：

```text
App
│
├── AudioProvider
│   └── AudioEngine
│
├── Router
│
└── Pages
```

---

# 160. 全局 VisualEngine

同样：

```text
App
├── AudioProvider
├── VisualProvider
└── Router
```

---

# 161. 页面结构

最终：

```text
App
│
├── BackgroundLayer
│
├── Sidebar
│
├── MainContent
│
├── VisualLayer
│
├── LyricsLayer
│
└── PlayerBar
```

---

# 162. Z-Index

统一管理：

```text
background: 0
visual: 10
content: 100
overlay: 500
modal: 1000
player: 800
```

---

# 163. 视觉与 UI

粒子视觉不能遮挡：

```text
点击
```

因此：

```css
pointer-events: none;
```

视觉 Canvas 默认：

```text
pointer-events: none
```

---

# 164. 3D Playlist

需要交互时：

```text
pointer-events: auto
```

---

# 165. Loading

启动：

```text
BhandsMusic
```

显示：

```text
Logo
Galaxy
Loading
```

等待：

```text
API
```

完成后进入首页。

---

# 166. API Health Check

启动后：

```text
GET /api/health
```

如果失败：

```text
显示 Server Offline
```

---

# 167. Backend Health

返回：

```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

---

# 168. Debug Mode

开发环境：

```text
Settings
→ Developer
```

可以显示：

```text
Audio FPS
Visual FPS
Network
Current Source
Audio Format
Buffer
```

生产默认隐藏。

---

# 169. Debug Panel

建议：

```text
FPS
CPU
GPU
Audio
Source
Latency
```

方便以后维护。

---

# 170. 迁移顺序

严格按照：

```text
1. Audit
2. Architecture
3. Web Shell
4. Audio
5. API
6. Search
7. Lyrics
8. Playlist
9. Weather
10. Visual
11. Three.js
12. Local Files
13. PWA
14. Login
15. Production
```

不要反过来。

---

# 171. Agent 执行规则

每一步：

```text
先分析
↓
修改
↓
运行
↓
测试
↓
修复
↓
提交
```

不能：

```text
一次修改几十个文件
然后最后才测试
```

---

# 172. Agent 不得做的事情

禁止：

```text
删除现有 server
删除 music-sources
删除视觉代码
删除 public assets
删除 LICENSE
删除 docs
```

除非：

```text
确认没有引用
```

并且：

```text
迁移完成
```

---

# 173. Agent 不得做的事情

禁止：

```text
把所有旧 JS 粗暴复制成 React
```

例如：

```text
main.js
→
Main.tsx
```

这是错误方案。

必须：

```text
拆分职责
```

---

# 174. Agent 不得做的事情

禁止：

```text
使用 eval
```

除非：

```text
第三方兼容层
```

并且：

```text
隔离到 backend sandbox
```

---

# 175. Agent 不得做的事情

禁止：

```text
直接把第三方音乐 API Key 写进前端
```

---

# 176. Agent 不得做的事情

禁止：

```text
把用户 Cookie 上传到公共服务器
```

---

# 177. Agent 不得做的事情

禁止：

```text
默认开启定位
```

必须：

```text
用户主动允许
```

---

# 178. Agent 不得做的事情

禁止：

```text
自动上传用户本地音乐
```

---

# 179. 兼容旧版

第一阶段必须：

```text
npm start
```

仍然能够启动原 Electron。

直到：

```text
Web Version MVP
```

完成。

---

# 180. 最终 package scripts

目标：

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:web\" \"npm run dev:server\"",
    "dev:web": "npm --workspace apps/web run dev",
    "dev:server": "npm --workspace apps/server run dev",

    "build": "npm run build:web && npm run build:server",

    "build:web": "npm --workspace apps/web run build",
    "build:server": "npm --workspace apps/server run build",

    "test": "npm run test:web && npm run test:server",

    "test:web": "npm --workspace apps/web run test",
    "test:server": "npm --workspace apps/server run test",

    "test:e2e": "playwright test"
  }
}
```

---

# 181. 最终 Web 启动

开发：

```bash
npm run dev
```

打开：

```text
http://localhost:5173
```

---

# 182. 最终 Production

```bash
npm run build
npm run start
```

---

# 183. Docker

最终：

```bash
docker compose up -d
```

打开：

```text
https://your-domain.com
```

---

# 184. 完整功能验收表

Agent 完成后必须逐项测试：

## 播放

* [ ] 播放
* [ ] 暂停
* [ ] 上一首
* [ ] 下一首
* [ ] Seek
* [ ] Volume
* [ ] Mute
* [ ] Shuffle
* [ ] Repeat

## 搜索

* [ ] 搜索歌曲
* [ ] 搜索歌手
* [ ] 搜索专辑
* [ ] 搜索歌单
* [ ] 搜索播客

## 音源

* [ ] GD
* [ ] Netease
* [ ] QQ
* [ ] Unblock
* [ ] LX
* [ ] Custom API

## 歌词

* [ ] 普通歌词
* [ ] 滚动
* [ ] 同步
* [ ] 自定义歌词
* [ ] 歌词舞台

## Playlist

* [ ] 创建
* [ ] 删除
* [ ] 添加
* [ ] 移除
* [ ] 排序
* [ ] 播放

## Library

* [ ] 收藏
* [ ] 历史
* [ ] Continue Listening

## Visual

* [ ] Galaxy
* [ ] Particle
* [ ] Emily
* [ ] Default
* [ ] DJ
* [ ] Podcast
* [ ] Wallpaper

## 3D

* [ ] 3D Shelf
* [ ] 拖动
* [ ] 点击
* [ ] 播放
* [ ] 移动端触摸

## Weather

* [ ] Geolocation
* [ ] City
* [ ] Weather
* [ ] Mood
* [ ] Weather Radio

## Local

* [ ] File Upload
* [ ] Folder Picker
* [ ] Local Playback
* [ ] Local Library

## Mobile

* [ ] Android
* [ ] iOS
* [ ] Responsive
* [ ] Touch
* [ ] Safe Area

---

# 185. 最终性能验收

必须测试：

```text
Chrome Desktop
Edge Desktop
Chrome Android
Safari iOS
```

至少：

```text
1920×1080
1440×900
1280×720
1024×768
768×1024
414×896
390×844
375×812
```

---

# 186. 最终交付物

Agent 最终必须生成：

```text
apps/web
apps/server
packages/shared
packages/music-core
docs/WEB_MIGRATION_AUDIT.md
docs/WEB_MIGRATION_STATUS.md
README.md
Dockerfile
docker-compose.yml
.env.example
```

---

# 187. WEB_MIGRATION_STATUS.md

必须记录：

```text
功能
状态
完成度
文件
备注
```

例如：

```text
Audio Player       DONE
Search             DONE
Lyrics             DONE
Playlist           DONE
Weather            DONE
Particle           DONE
3D Shelf           TODO
PWA                TODO
```

---

# 188. Agent 最终报告

Agent 完成工作后必须输出：

```text
1. 修改了哪些文件
2. 新增了哪些文件
3. 删除了哪些文件
4. 哪些功能已经迁移
5. 哪些功能暂时不能迁移
6. 为什么不能迁移
7. 如何启动
8. 如何部署
9. 测试结果
10. 浏览器兼容性
11. 已知问题
```

---

# 189. 第一阶段实际执行指令

Agent 收到本文件后：

```text
STEP 1

阅读整个仓库。

不要修改代码。

生成：

docs/WEB_MIGRATION_AUDIT.md
```

完成后：

```text
STEP 2

创建：

feature/web-version
```

然后：

```text
STEP 3

创建 apps/web
apps/server
packages/shared
packages/music-core
```

---

# 190. 第二阶段

先实现：

```text
Web Shell
```

页面必须能：

```text
启动
导航
响应式
加载资源
```

---

# 191. 第三阶段

实现：

```text
AudioEngine
```

使用：

```text
HTMLAudioElement
Web Audio API
```

---

# 192. 第四阶段

迁移：

```text
Search
Source
Song URL
Lyrics
```

---

# 193. 第五阶段

迁移：

```text
Playlist
Library
History
IndexedDB
```

---

# 194. 第六阶段

迁移：

```text
Weather
```

---

# 195. 第七阶段

迁移：

```text
Particle
Galaxy
Wallpaper
Beat
```

---

# 196. 第八阶段

迁移：

```text
Three.js Playlist Shelf
```

---

# 197. 第九阶段

实现：

```text
Local Music
```

---

# 198. 第十阶段

实现：

```text
PWA
Mobile
Offline UI
```

---

# 199. 第十一阶段

实现：

```text
Production Build
Docker
Nginx
HTTPS
```

---

# 200. 最终架构

最终目标：

```text
                         ┌─────────────────────┐
                         │      Browser        │
                         │                     │
                         │ React + TypeScript  │
                         │                     │
                         │ ┌─────────────────┐ │
                         │ │ Audio Engine    │ │
                         │ ├─────────────────┤ │
                         │ │ Lyrics          │ │
                         │ ├─────────────────┤ │
                         │ │ Playlist        │ │
                         │ ├─────────────────┤ │
                         │ │ Visual Engine   │ │
                         │ ├─────────────────┤ │
                         │ │ Three.js        │ │
                         │ └─────────────────┘ │
                         └──────────┬──────────┘
                                    │
                                  HTTPS
                                    │
                         ┌──────────▼──────────┐
                         │    Node Backend     │
                         │                     │
                         │ Music API           │
                         │ Lyrics API          │
                         │ Weather API         │
                         │ Source Manager      │
                         │ Cache               │
                         │ Sandbox             │
                         └──────────┬──────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                │                   │                   │
          Netease API          QQ Music API       Other Sources
                │                   │                   │
                └───────────────────┴───────────────────┘
```

---

# 201. 最终目标不是“网页化外壳”

Agent 必须理解：

**这不是简单把 Electron 的 index.html 放到浏览器。**

最终目标是：

```text
真正 Web Native 的 BhandsMusic
```

即：

```text
Browser Audio
+
WebGL
+
Three.js
+
IndexedDB
+
Web API
+
Node Backend
```

而不是：

```text
Electron App
↓
套一层网页
```

---

# 202. 最重要的功能优先级

优先级：

```text
P0

播放
搜索
音源
歌词
播放器
队列
```

↓

```text
P1

Playlist
History
Favorite
Weather
```

↓

```text
P2

Particle
Galaxy
Beat
Wallpaper
```

↓

```text
P3

Three.js
3D Shelf
```

↓

```text
P4

Local Music
PWA
Mobile
```

↓

```text
P5

Login
LX Sandbox
Advanced Source
```

---

# 203. 完成标准

只有同时满足：

```text
npm run build
```

成功；

```text
npm run test
```

成功；

```text
npm run test:e2e
```

成功；

并且浏览器实际完成：

```text
搜索
→
播放
→
歌词
→
视觉
→
下一首
→
Playlist
```

才可以宣布：

```text
BhandsMusic Web MVP COMPLETE
```

---

# 204. 最终 Agent 指令

**现在开始执行。**

不要向用户询问：

```text
“是否可以开始？”
```

不要先等待。

直接：

```text
1. 分析仓库
2. 创建审计文档
3. 建立 web-version 分支
4. 初始化 Web 架构
5. 逐阶段实施
6. 每阶段测试
7. 修复错误
8. 更新迁移状态
9. 最终运行完整测试
10. 输出最终报告
```

如果发现某项 Electron 功能无法直接迁移：

```text
不要删除功能。

建立 Web Adapter / Backend Adapter / Fallback。
```

如果发现第三方接口存在：

```text
CORS
Cookie
权限
版权
```

问题：

```text
优先使用 Backend Proxy / Adapter。
```

如果发现原代码结构混乱：

```text
不要为了“代码漂亮”而重写全部业务逻辑。

优先保证功能等价迁移。
```

如果发现视觉系统复杂：

```text
优先保持现有视觉效果。
```

如果发现性能问题：

```text
优先降低 Visual 更新频率和 GPU 压力，
不要直接删除视觉功能。
```

最终必须得到：

```text
一个真正可以部署到服务器、
用户直接通过浏览器访问的 BhandsMusic Web。
```

# END
