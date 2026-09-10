import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * 脚本管理鉴权。
 * ADMIN_TOKEN 未配置时脚本上传/启停一律拒绝（fail-closed）：
 * LX 脚本会在服务端执行任意 JS，而 Node 的 vm 不是安全边界，
 * 公开上传入口等于向所有访客开放服务端代码执行，必须凭令牌操作。
 * 惰性读取：配合 loadEnv 在启动时加载 .env。
 */
function getAdminToken(): string {
  return (process.env.ADMIN_TOKEN || '').trim();
}

export function adminConfigured(): boolean {
  return !!getAdminToken();
}

/** 校验通过返回 true；失败时已写入 4xx 响应，路由直接 return */
export function assertAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = getAdminToken();
  if (!expected) {
    reply.status(403).send({
      success: false,
      error: '脚本管理未开放：需在服务器 .env 中配置 ADMIN_TOKEN 后才能管理音源脚本'
    });
    return false;
  }
  const token = (request.headers['x-admin-token'] as string || '').trim();
  const ok =
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) {
    reply.status(401).send({ success: false, error: '管理令牌无效' });
    return false;
  }
  return true;
}
