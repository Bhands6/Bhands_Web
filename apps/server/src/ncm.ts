import NcmApiDefault from 'NeteaseCloudMusicApi';

/**
 * 带超时的网易云 API 客户端。
 *
 * 背景（2026-09-11 全项目扫描确认）：NeteaseCloudMusicApi 库内部 axios **未设 timeout**
 * （util/request.js 直接 axios(settings)），TCP 建连后上游慢响应/慢吐字节时调用会
 * **永久悬挂**且不留任何日志（日志里见到的 502/ECONNRESET 是快速失败路径，慢挂起更糟）。
 *
 * 所有路由统一经此代理调用：每个调用外层套 8s 超时，超时按普通失败抛错，
 * 走各端点已有的 catch 兜底（/user/status 的 transient 不清登录态、推荐走新歌速递等）。
 */
export const NCM_TIMEOUT_MS = 8000;

/** 通用 Promise 超时包装：settle 后清理计时器，不残留 pending timer */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'NCM'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 调用超时(${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

const raw = NcmApiDefault as unknown as Record<string, (query?: any) => Promise<any>>;

/** 瞬时网络类错误（值得重试）：上游断连/502/超时。NeteaseCloudMusicApi 遇上游故障
 *  会打印 [ERR] 502 read ECONNRESET 并 throw（2026-09-15 实测 top/album+personalized 同时抖断） */
function isTransientNcmError(e: unknown): boolean {
  const anyE = e as { message?: string; status?: number; body?: { code?: number }; code?: number };
  const msg = anyE?.message || String(e);
  if (/超时|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  if (anyE?.status === 502 || anyE?.status === 503 || anyE?.body?.code === 502) return true;
  return false;
}

/** 调用 + 瞬时失败自动重试一次（间隔 400ms）：上游抖动场景成功率大幅提升。
 *  所有 NCM 调用均幂等安全（search/detail/轮询/开关类），重试无副作用。 */
async function callWithRetry(fn: (query?: any) => Promise<any>, query: any): Promise<any> {
  try {
    return await withTimeout(fn.call(raw, query), NCM_TIMEOUT_MS);
  } catch (e) {
    if (!isTransientNcmError(e)) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return await withTimeout(fn.call(raw, query), NCM_TIMEOUT_MS);
  }
}

/** 用法与原「NcmApi = NcmApiDefault as unknown as ...」完全一致，仅多一层超时 + 瞬时重试 */
export const NcmApi = new Proxy(raw, {
  get(target, prop: string | symbol) {
    const fn = target[prop as string];
    if (typeof fn !== 'function') return fn;
    return (query?: any) => callWithRetry(fn, query);
  }
});
