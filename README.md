# BhandsMusic Web

沉浸式在线音乐播放器 - 将 BhandsMusic Electron 桌面应用迁移为 Web 网页版

## 项目结构

```
BhandsMusicWeb/
├── apps/
│   ├── web/                    # 前端应用
│   │   ├── src/
│   │   │   ├── components/     # React 组件
│   │   │   ├── pages/          # 页面组件
│   │   │   ├── stores/         # Zustand 状态管理
│   │   │   ├── hooks/          # 自定义 Hooks
│   │   │   ├── services/       # 业务服务
│   │   │   ├── api/            # API 客户端
│   │   │   ├── audio/          # 音频引擎
│   │   │   ├── visual/         # 视觉系统
│   │   │   ├── lyrics/         # 歌词系统
│   │   │   ├── playlist/       # 播放列表
│   │   │   ├── weather/        # 天气系统
│   │   │   ├── three/          # Three.js 3D
│   │   │   ├── utils/          # 工具函数
│   │   │   └── types/          # TypeScript 类型
│   │   ├── public/             # 静态资源
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   └── server/                 # 后端服务
│       ├── src/
│       │   ├── routes/         # API 路由
│       │   ├── services/       # 业务服务
│       │   ├── adapters/       # 适配器
│       │   ├── middleware/     # 中间件
│       │   └── config/         # 配置
│       ├── package.json
│       └── tsconfig.json
│
├── package.json                # 根项目配置
├── WEB_MIGRATION_PLAN.md       # 迁移计划文档
└── MIGRATION_AUDIT.md          # 迁移审计报告
```

## 技术栈

### 前端
- React 19+
- TypeScript
- Vite
- Zustand (状态管理)
- Three.js (3D 渲染)
- GSAP (动画)
- Axios (HTTP 客户端)

### 后端
- Node.js
- Fastify
- NeteaseCloudMusicApi
- UnblockNeteaseMusic

## 快速开始

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run dev
```

### 构建项目
```bash
npm run build
```

### 启动服务
```bash
npm start
```

## 功能特性

### P0 - 核心功能
- 音乐播放
- 搜索功能
- 多音源支持
- 歌词显示
- 播放队列

### P1 - 增强功能
- 播放列表管理
- 播放历史
- 收藏功能
- 天气电台

### P2 - 视觉系统
- 粒子视觉
- 星系效果
- 节拍可视化
- 壁纸模式

### P3 - 3D 系统
- Three.js 集成
- 3D 歌单架
- 3D 视觉效果

### P4 - 高级功能
- 本地音乐支持
- PWA 支持
- 移动端适配

### P5 - 扩展功能
- 用户登录
- LX 沙盒
- 高级音源

## 开发指南

### 添加新页面
1. 在 `apps/web/src/pages/` 创建新组件
2. 在 `apps/web/src/App.tsx` 添加路由
3. 更新导航组件

### 添加新 API
1. 在 `apps/server/src/routes/` 创建路由文件
2. 在 `apps/server/src/index.ts` 注册路由
3. 在 `apps/web/src/api/` 创建 API 客户端

### 添加新状态
1. 在 `apps/web/src/stores/` 创建 Zustand store
2. 在组件中使用 `useStore` hook

## 部署

### 前端部署
```bash
npm run build:web
# 将 apps/web/dist 部署到静态文件服务器
```

### 后端部署
```bash
npm run build:server
npm start
```

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 许可证

ISC License
