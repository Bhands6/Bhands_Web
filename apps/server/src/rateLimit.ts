import type { FastifyRequest } from 'fastify';

/**
 * 极简内存滑动窗口限流（单进程场景够用，无外部依赖）。
 * 返回 true = 放行，false = 超出配额。
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);

  // 粗粒度防膨胀：桶数过多时清掉整个窗口内无记录的桶
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
    }
  }
  return true;
}

/** 按客户端 IP 限流 */
export function limitedByIp(request: FastifyRequest, name: string, limit: number, windowMs: number): boolean {
  return rateLimit(`${name}:${request.ip || 'unknown'}`, limit, windowMs);
}
