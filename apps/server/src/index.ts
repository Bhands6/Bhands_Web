import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { musicRoutes } from './routes/music';
import { userRoutes } from './routes/user';
import { weatherRoutes } from './routes/weather';

const server = Fastify({
  logger: true
});

/** 解析前端构建产物目录。
 *  不使用 __dirname（tsx 开发模式按 ESM 运行时不存在），
 *  按 环境变量 → 常见启动目录 依次探测。 */
function resolveWebDist(): string {
  const env = process.env.WEB_DIST;
  if (env && fs.existsSync(env)) return env;

  const candidates = [
    path.resolve(process.cwd(), 'apps/web/dist'), // 仓库根 / Docker WORKDIR=/app
    path.resolve(process.cwd(), '../web/dist'),   // apps/server 目录内启动
    path.resolve(process.cwd(), 'web/dist')       // 扁平部署布局
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0]; // 不存在时返回默认值，由调用方判断
}

async function main() {
  // 注册 CORS
  await server.register(cors, {
    origin: true,
    credentials: true
  });

  // 注册路由
  await server.register(musicRoutes, { prefix: '/api/music' });
  await server.register(userRoutes, { prefix: '/api/user' });
  await server.register(weatherRoutes, { prefix: '/api/weather' });

  // 健康检查
  server.get('/api/health', async () => {
    return { status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() };
  });

  // 生产部署：直接托管前端构建产物（apps/web/dist），单域名完成 Web + API
  const webDist = resolveWebDist();
  if (fs.existsSync(webDist)) {
    await server.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      maxAge: '1h',
      decorateReply: true,
      // 入口 HTML 与 SW 禁止缓存：内容 hash 变化后浏览器必须重新拉取，
      // 否则旧 index.html（引用旧 JS 文件名）会被缓存 1h，发版不生效
      setHeaders: (res, pathName) => {
        if (pathName.endsWith('index.html') || pathName.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    });

    // SPA fallback：非 API 的未知 GET 路径回退到 index.html（前端为单页应用）
    server.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ success: false, error: 'Not Found' });
    });
  }

  try {
    const port = parseInt(process.env.PORT || '3001');
    const host = process.env.HOST || '0.0.0.0';
    await server.listen({ port, host });
    console.log(`Server is running on http://${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
