import { describe, it, expect, beforeEach } from 'vitest';
import { registerBlobUrl, pickOrphanBlobUrls, resetBlobRegistry } from './blobUrls';

/**
 * 2026-09-11 扫描遗留项回归锁：本地导入的 blob URL 不再永久持有 ——
 * keepIds（队列/当前曲目/历史/收藏仍引用的 id）之外的都算孤儿。
 */
describe('blobUrls 孤儿判定', () => {
  beforeEach(() => resetBlobRegistry());

  it('keepIds 之外的 id 视为孤儿（含全部历史 URL）', () => {
    registerBlobUrl('a', 'blob:a-1');
    registerBlobUrl('b', 'blob:b-1');
    registerBlobUrl('b', 'blob:b-2'); // 同一曲目重复导入
    expect(pickOrphanBlobUrls(new Set(['a']))).toEqual(['blob:b-1', 'blob:b-2']);
  });

  it('keepIds 命中的 id 一个都不回收', () => {
    registerBlobUrl('a', 'blob:a-1');
    registerBlobUrl('b', 'blob:b-1');
    expect(pickOrphanBlobUrls(new Set(['a', 'b']))).toEqual([]);
  });

  it('登记表为空 → 无孤儿', () => {
    expect(pickOrphanBlobUrls(new Set())).toEqual([]);
  });
});
