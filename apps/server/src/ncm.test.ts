import { describe, it, expect } from 'vitest';
import { withTimeout, NcmApi } from './ncm';

/**
 * 2026-09-11 全项目扫描确认：NeteaseCloudMusicApi 库内 axios 无 timeout，
 * 上游慢响应会让路由永久悬挂。所有 NCM 调用现在经 ncm.ts 的 withTimeout 兜底。
 */
describe('withTimeout', () => {
  it('及时完成 → 透传结果，并清理计时器', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
  });

  it('超时 → 在时限内 reject（不永久悬挂）', async () => {
    const start = Date.now();
    await expect(
      withTimeout(new Promise<never>(() => {}), 30, 'test')
    ).rejects.toThrow('超时');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('底层拒绝 → 透传原始错误（不吞错）', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
  });
});

describe('NcmApi 代理', () => {
  it('端点仍是可调用函数（用法与原裸导入一致）', () => {
    expect(typeof NcmApi.song_detail).toBe('function');
    expect(typeof NcmApi.cloudsearch).toBe('function');
    expect(typeof NcmApi.login_qr_check).toBe('function');
  });
});
