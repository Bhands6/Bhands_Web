import { parseFromGDMusic } from './music-sources/gdmusic';
import { parseFromLxMusic, listRunners as listLxRunners } from './music-sources/lxMusicRunner';

// ============================================================
// 缓存
// ============================================================
interface CacheEntry { data: ParseResult; time: number }
const successCache = new Map<string, CacheEntry>();
const failedCache = new Map<string, number>();
const SUCCESS_TTL = 30 * 60 * 1000;
const FAILED_TTL = 60 * 1000;

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of successCache) if (now - v.time > SUCCESS_TTL) successCache.delete(k);
  for (const [k, t] of failedCache) if (now - t > FAILED_TTL) failedCache.delete(k);
}
setInterval(cleanCache, 5 * 60 * 1000);

// ============================================================
// 类型
// ============================================================
export interface ParseResult {
  url: string;
  quality: string;
  trial: boolean;
  size: number;
  source: string;
}

export interface ParseParams {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  quality?: string;
}

// ============================================================
// 策略：GDMusic
// ============================================================
const GDMUSIC_TIMEOUT = 12_000;

async function tryGDMusic(p: ParseParams): Promise<ParseResult | null> {
  const key = `gd_${p.id}`;
  if (failedCache.has(key) && Date.now() - failedCache.get(key)! < FAILED_TTL) return null;
  try {
    const r = await parseFromGDMusic({ name: p.name, artists: p.artists, quality: '999', timeout: GDMUSIC_TIMEOUT });
    if (r?.url) return { ...r, source: r.quality };
    failedCache.set(key, Date.now());
    return null;
  } catch {
    failedCache.set(key, Date.now());
    return null;
  }
}


// ============================================================
// 策略：LxMusic
// ============================================================
async function tryLxMusic(p: ParseParams): Promise<ParseResult | null> {
  if (!listLxRunners().length) return null;
  try {
    const r = await parseFromLxMusic({
      id: p.id, name: p.name, artists: (p.artists || []).join("、"), album: p.album, quality: p.quality
    });
    if (r?.url) return { url: r.url, quality: r.quality, trial: false, size: 0, source: r.source };
    return null;
  } catch { return null; }
}

// ============================================================
// 策略：UnblockNeteaseMusic（从 music.ts 迁移）
// ============================================================
import unblockMatch from '@unblockneteasemusic/server';
import NcmApiDefault from 'NeteaseCloudMusicApi';
const NcmApi = NcmApiDefault as unknown as Record<string, (q?: any) => Promise<any>>;

const UNBLOCK_PLATFORMS = ['migu', 'kugou', 'kuwo', 'pyncmd'];

async function tryUnblock(p: ParseParams, minSize = 0, timeout = 0): Promise<ParseResult | null> {
  const key = `ub_${p.id}`;
  if (minSize === 0 && failedCache.has(key) && Date.now() - failedCache.get(key)! < FAILED_TTL) return null;
  const doMatch = (async () => {
    try {
      const detail = await NcmApi.song_detail({ ids: p.id });
      const s = detail.body?.songs?.[0];
      if (!s) return null;
      const matched: any = await unblockMatch(Number(p.id), UNBLOCK_PLATFORMS, {
        name: s.name || '',
        artists: (s.ar || []).map((a: any) => ({ name: a.name })),
        album: { name: (s.al || {}).name || '' }
      });
      if (matched?.url) {
        const size = matched.size || 0;
        if (minSize > 0 && size > 0 && size < minSize) return null;
        return { url: matched.url, quality: 'unblock', trial: false, size, source: 'unblock-' + (matched.platform || 'unknown') };
      }
    } catch { /* ignore */ }
    return null;
  })();
  if (timeout > 0) return Promise.race([doMatch, new Promise<null>((r) => setTimeout(() => r(null), timeout))]);
  return doMatch;
}

// ============================================================
// 编排器：按策略列表依次尝试
// ============================================================
async function tryStrategies(p: ParseParams, strategies: Array<(p: ParseParams) => Promise<ParseResult | null>>): Promise<ParseResult | null> {
  for (const fn of strategies) {
    const r = await fn(p);
    if (r?.url) return r;
  }
  return null;
}

/** 外站解析（GDMusic + Unblock） */
async function tryThirdParty(p: ParseParams): Promise<ParseResult | null> {
  return tryStrategies(p, [
    (pp) => tryLxMusic(pp),
    (pp) => tryGDMusic(pp),
    (pp) => tryUnblock(pp, 1_000_000, 5_000),
  ]);
}

// ============================================================
// 主入口：VIP 分流
// ============================================================
export async function resolveSongUrl(params: ParseParams & { vip: boolean; cookie?: string }): Promise<ParseResult | null> {
  const { vip, cookie, ...p } = params;

  // 成功缓存
  const cacheKey = `${p.id}_${vip ? 'v' : 'n'}`;
  const cached = successCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SUCCESS_TTL) return cached.data;

  let result: ParseResult | null = null;

  if (vip) {
    // VIP：① 官方 API → ② 外站解析
    result = await tryNcmOfficial(p, cookie);
    if (!result) result = await tryThirdParty(p);
  } else {
    // 非 VIP：① 外站解析 → ② 官方 API（试听兜底）
    result = await tryThirdParty(p);
    if (!result) result = await tryNcmOfficial(p, cookie);
  }

  if (result) successCache.set(cacheKey, { data: result, time: Date.now() });
  return result;
}

// ============================================================
// 官方 API（带音质降级）
// ============================================================
const PROXY = (url: string) => /^https?:\/\//i.test(url) ? `/api/music/stream?url=${encodeURIComponent(url)}` : url;

async function tryNcmOfficial(p: ParseParams, cookie?: string): Promise<ParseResult | null> {
  const ALL_LEVELS = ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'];
  const startIdx = ALL_LEVELS.indexOf(p.quality || 'exhigh');
  const chain = startIdx >= 0 ? ALL_LEVELS.slice(startIdx) : ['exhigh', 'standard'];
  let trialFallback: ParseResult | null = null;

  for (const level of chain) {
    try {
      const res = await NcmApi.song_url_v1({ id: p.id, level, cookie });
      const info = res.body?.data?.[0];
      if (!info?.url) continue;
      if (!info.freeTrialInfo) {
        return { url: PROXY(info.url), quality: level, trial: false, size: info.size || 0, source: 'netease-' + level };
      }
      if (!trialFallback) {
        trialFallback = { url: PROXY(info.url), quality: level, trial: true, size: info.size || 0, source: 'netease-trial' };
      }
    } catch { /* next */ }
  }
  return trialFallback;
}
