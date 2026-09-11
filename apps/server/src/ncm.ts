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

/** 用法与原「NcmApi = NcmApiDefault as unknown as ...」完全一致，仅多一层超时 */
export const NcmApi = new Proxy(raw, {
  get(target, prop: string | symbol) {
    const fn = target[prop as string];
    if (typeof fn !== 'function') return fn;
    return (query?: any) => withTimeout(fn.call(target, query), NCM_TIMEOUT_MS);
  }
});
