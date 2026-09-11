/**
 * localStorage 安全读写：坏 JSON / 隐私模式 / 配额满都不抛错。
 *
 * 背景（2026-09-11 全项目扫描发现）：
 *  - 模块顶层裸 JSON.parse(localStorage.getItem(...) || '[]') 在 store 被 import 的
 *    第一时间执行，一条被截断/篡改的坏 JSON 就会让**整站白屏**且无任何兜底；
 *  - 裸 setItem 在隐私模式/配额满时抛错，最实际的影响链是 playTrack 的 finish() 里
 *    addToHistory 抛错会中断 applyCoverTint / startBeatAnalysis（歌在播但氛围全失效）。
 *  - 项目内正确范本：useSettingsStore.load / usePlayerStore.readSessionSnapshot。
 */

/** 读 JSON：键不存在 / 值非法 / 存储不可用 一律回退 fallback */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写 JSON：配额满 / 隐私模式吞异常（非致命，内存态仍在） */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 非致命 */ }
}

/** 读字符串：存储不可用回退 null */
export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写字符串：吞异常 */
export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* 非致命 */ }
}
