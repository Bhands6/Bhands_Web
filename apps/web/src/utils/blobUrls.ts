/**
 * 本地导入（blob: URL）的生命周期登记与回收。
 *
 * 背景（2026-09-11 扫描遗留项）：SearchArea 每次导入本地文件都 URL.createObjectURL，
 * 但从不 revoke —— 换歌单/清队列后旧文件的字节一直被持有。直接「删 track 就 revoke」
 * 又会误杀仍被历史/收藏/当前曲目引用的地址（本地曲目无法经服务端重新解析，revoke 后播不回来）。
 *
 * 策略：登记 id → blob URL；由调用方（playTrack 换队列、clearPlaylist）在**操作完成后**
 * 用 keepIds（仍在队列/当前曲目/历史/收藏里的 id）批量回收孤儿。
 */

const registry = new Map<string, string[]>();

/** 登记一个新 blob URL（同一 track 可多次导入产生多个 URL，回收时一并处理） */
export function registerBlobUrl(trackId: string, blobUrl: string): void {
  const list = registry.get(trackId);
  if (list) list.push(blobUrl);
  else registry.set(trackId, [blobUrl]);
}

/** 回收所有不在 keepIds 里的 blob URL；返回被回收的 URL（便于测试） */
export function releaseBlobUrlsExcept(keepIds: ReadonlySet<string>): string[] {
  const released: string[] = [];
  for (const [id, urls] of registry) {
    if (keepIds.has(id)) continue;
    registry.delete(id);
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url);
        released.push(url);
      } catch { /* 已失效：忽略 */ }
    }
  }
  return released;
}

/**
 * 纯函数：从登记表里挑出需要回收的 URL（不执行 revoke，供单测）。
 */
export function pickOrphanBlobUrls(keepIds: ReadonlySet<string>): string[] {
  const orphan: string[] = [];
  for (const [id, urls] of registry) {
    if (keepIds.has(id)) continue;
    orphan.push(...urls);
  }
  return orphan;
}

/** 测试用：清空登记表 */
export function resetBlobRegistry(): void {
  registry.clear();
}
