# BhandsMusic Web 迁移状态总结

> 来源项目：BhandsMusic（Electron 桌面版）
> 目标：浏览器直接访问的沉浸式在线音乐播放器
> 实施计划：见 [WEB_MIGRATION_PLAN.md](./WEB_MIGRATION_PLAN.md)

## 技术架构（实际）

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript + Vite 8（单页舞台式 UI，无路由） |
| 状态 | Zustand（localStorage 持久化） |
| 音频 | Web Audio API（AudioContext + Analyser + Gain + MediaElementSource） |
| 视觉 | Three.js 粒子星河（React.lazy 懒加载，独立分包） |
| 后端 | Node.js + Fastify + NeteaseCloudMusicApi + UnblockNeteaseMusic |
| 测试 | Vitest（19 个用例） |
| 部署 | Fastify 单域名同时提供 API 与前端静态资源；Docker 可选 |

## 功能迁移状态

### P0 核心 — ✅ 完成
| 功能 | 状态 | 说明 |
|---|---|---|
| 播放/暂停/切歌/Seek/音量/静音 | ✅ | ControlBar + AudioEngine |
| 播放模式（顺序/单曲/随机） | ✅ | |
| 搜索（网易云） | ✅ | 搜索历史、防抖、竞态取消 |
| 音源解析 | ✅ | 官方直链 → UnblockNeteaseMusic 兜底（≥1MB 过滤 + 5s 超时） |
| 音频流代理 | ✅ | `/api/music/stream` 同源转发（支持 Range 拖动），解决外站 CDN 无 CORS 头问题 |
| 歌词（LRC + 卡拉OK逐字） | ✅ | 时间解析已修正厘秒/毫秒归一 |
| 播放队列 | ✅ | QueuePanel，含播放模式、随机、清空 |
| 播放竞态守卫 | ✅ | playToken 防止旧解析覆盖新曲目；过期代理地址自动重解析 |

### P1 增强 — ✅ 完成
| 功能 | 状态 | 说明 |
|---|---|---|
| 播放历史（100 条上限、去重置顶） | ✅ | localStorage |
| 收藏 | ✅ | localStorage |
| 每日推荐 | ✅ | 登录用每日推荐，未登录退化新歌速递 |
| 天气电台 | ✅ | Open-Meteo + 心情映射 + 种子搜索开台 |
| 网易云扫码登录 | ✅ | 后端 cookie 会话（HttpOnly），含登录态恢复、用户歌单 |
| 本地音乐导入 | ✅ | `<input type="file">` → objectURL 直接播放 |
| 键盘快捷键 | ✅ | 空格/←→/↑↓/L/Esc（输入框聚焦时屏蔽） |

### P2 视觉 — ✅ 完成
| 功能 | 状态 | 说明 |
|---|---|---|
| Three.js 粒子星河 | ✅ | 音频响应（低/中/高频驱动 + 节拍脉冲），封面取色联动 |
| 封面取色氛围 | ✅ | 主色驱动粒子与歌词发光 |
| 背景层 | ✅ | 专辑封面模糊 + 渐变氛围 |

### P3+ 工程化 — ✅ 完成（本次收尾）
| 功能 | 状态 | 说明 |
|---|---|---|
| PWA | ✅ | manifest + Service Worker（绝不缓存 /api 与音频）+ 离线页 + 图标 |
| 离线检测 | ✅ | navigator.onLine 断网/恢复提示 |
| 生产部署 | ✅ | `npm run build && npm start` 单域名运行，SPA fallback |
| Docker | ✅ | Dockerfile（多阶段构建）+ docker-compose.yml |
| 单元测试 | ✅ | Vitest：歌词解析/收藏/历史 store + 天气心情映射（19 用例） |
| 环境变量 | ✅ | .env.example |

### 未迁移 / 后续任务
| 功能 | 状态 | 原因 |
|---|---|---|
| 3D 歌单架 | ⬜ TODO | 桌面版功能，规划见计划 #19-20，Three.js 基建已就绪 |
| LX Music 音源脚本沙盒 | ⬜ TODO | 需 Node Worker/vm 沙盒（计划 #59-60），安全要求高 |
| QQ 音乐 / GD 音台 / 自定义 API 适配器 | ⬜ TODO | 计划 #25，当前音源已由 Unblock 兜底覆盖大部分场景 |
| 搜索类型扩展（歌手/专辑/歌单 tab） | ⬜ TODO | 当前仅单曲搜索 |
| E2E 测试（Playwright） | ⬜ TODO | 手动验收链路已通过 |
| 移动端深度适配验证 | 🔶 部分 | CSS 已有 38 处断点，真机测试待做 |

## 快速开始

```bash
# 开发（前端 5173 + 后端 3001，Vite 代理 /api）
npm install
npm run dev

# 测试（19 用例）
npm test

# 生产：单域名部署（默认 3001）
npm run build
npm start

# Docker
docker compose up -d
```

## 已知问题

1. 外站音源（酷狗/酷我）链接含时效令牌，过期后由前端自动重解析自愈
2. 部分咪咕平台接口偶发超时（UnblockNeteaseMusic 上游问题，不影响播放，已有超时兜底）
3. PWA 安装图标为 AI 生成初版，可按需替换 `apps/web/public/icons/`
