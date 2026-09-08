# ---------- 构建阶段：安装依赖并编译前端 + 后端 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷贝 package.json，充分利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci

COPY apps/web apps/web
COPY apps/server apps/server
# tsc -b && vite build / tsc
RUN npm run build --workspace=apps/web \
 && npm run build --workspace=apps/server

# ---------- 生产依赖阶段：仅安装运行时依赖 ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev

# ---------- 运行阶段：Node 服务同时提供 API 与前端静态资源 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
