import { parseFromGDMusic } from './music-sources/gdmusic';
import { parseFromLxMusic, listRunners as listLxRunners } from './music-sources/lxMusicRunner';
import { probeAudio, acceptProbe } from './durationProbe';

// ============================================================
// 缓存
// ============================================================
interface CacheEntry { data: ParseResult; time: number }
const successCache = new Map<string, CacheEntry>();
const failedCache = new Map<string, number>();
// 外站直链与网易 URL 都带时效 token，缓存过长会供出已过期死链
const SUCCESS_TTL = 10 * 60 * 1000;
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
  /** 歌曲时长（毫秒）。LX 脚本的 songInfo.interval 由它换算，
   *  不传会让脚本收到 "00:00" —— 脚本常按 interval 校验/过滤搜索结果，
   *  缺时长容易匹配到同名不同版本（翻唱/伴奏/串烧）。 */
  durationMs?: number;
  /** 路由层预取的网易云歌曲详情（song_detail 单条），按歌名匹配的第三方音源复用，避免重复请求 */
  detail?: any;
}

/** 外站/网易 CDN 直链 → 同源流代理（外站 CDN 无 CORS 头，浏览器带 crossOrigin 直连会失败） */
const PROXY = (url: string) => /^https?:\/\//i.test(url) ? `/api/music/stream?url=${encodeURIComponent(url)}` : url;

// ============================================================
// 策略：GDMusic
// ============================================================
const GDMUSIC_TIMEOUT = 12_000;

/** 用户档位 → GDMusic(酷音/joox/tidal 聚合) 的 br 参数：999=无损, 320/128=有损 */
function gdQualityOf(tier?: string): string {
  if (tier === 'standard') return '128';
  if (tier === 'lossless' || tier === 'hires' || tier === 'jymaster') return '999';
  return '320';
}

async function tryGDMusic(p: ParseParams): Promise<ParseResult | null> {
  // 失败缓存按「歌曲 + 音质档位」隔离：无损档失败不应连带封禁有损档（反之亦然）
  const br = gdQualityOf(p.quality);
  const key = `gd_${p.id}_${br}`;
  if (failedCache.has(key) && Date.now() - failedCache.get(key)! < FAILED_TTL) return null;
  try {
    const r = await parseFromGDMusic({ name: p.name, artists: p.artists, quality: br, timeout: GDMUSIC_TIMEOUT });
    if (r?.url) return { ...r, url: PROXY(r.url), source: r.quality };
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
      id: p.id, name: p.name, artists: (p.artists || []).join("、"), album: p.album, quality: p.quality,
      // 时长决定脚本拿到的 interval，缺失会退化成 00:00 而匹配到错版本
      duration: p.durationMs ?? (p.detail?.dt as number | undefined) ?? 0
    });
    if (r?.url) return { url: PROXY(r.url), quality: r.quality, trial: false, size: 0, source: r.source };
    return null;
  } catch { return null; }
}

// ============================================================
// 策略：UnblockNeteaseMusic（从 music.ts 迁移）
// ============================================================
import unblockMatch from '@unblockneteasemusic/server';
import { NcmApi, withTimeout } from '../ncm';
import crypto from 'node:crypto';

// 实测：migu / pyncmd 全部返回空（0/20），保留只会白白增加失败延迟，故只留 kugou / kuwo；
// 且 kugou 的正确率（78%）明显高于 kuwo（21%），故 kugou 在前。
const UNBLOCK_PLATFORMS = ['kugou', 'kuwo'];

async function tryUnblock(p: ParseParams, timeout = 5000): Promise<ParseResult | null> {
  const key = `ub_${p.id}`;
  if (failedCache.has(key) && Date.now() - failedCache.get(key)! < FAILED_TTL) return null;
  const doMatch = (async () => {
    try {
      // 路由层已预取详情时直接复用，省一次 NCM 请求
      const s = p.detail || (await NcmApi.song_detail({ ids: p.id })).body?.songs?.[0];
      if (!s) return null;
      const matched: any = await unblockMatch(Number(p.id), UNBLOCK_PLATFORMS, {
        name: s.name || '',
        artists: (s.ar || []).map((a: any) => ({ name: a.name })),
        album: { name: (s.al || {}).name || '' }
      });
      if (matched?.url) {
        return { url: PROXY(matched.url), quality: 'unblock', trial: false, size: matched.size || 0, source: 'unblock-' + (matched.platform || 'unknown') };
      }
    } catch { /* ignore */ }
    return null;
  })();
  // withTimeout：胜出后清理计时器（旧写法 race 胜出后 setTimeout 残留）；
  // doMatch 内部已有 try/catch 不会 reject，此处 .catch(() => null) 把超时降级为「未命中」
  if (timeout > 0) return withTimeout(doMatch, timeout, 'unblock').catch(() => null);
  return doMatch;
}

// ============================================================
// 编排器：按策略列表依次尝试
// ============================================================

/** 代理地址 → 上游直链（时长校验需直连上游取头部字节） */
function upstreamOf(url: string): string {
  if (!url.startsWith('/api/music/stream')) return url;
  try {
    return new URLSearchParams(url.split('?')[1] ?? '').get('url') || '';
  } catch {
    return '';
  }
}

/**
 * 候选音源校验：第三方音源按「歌名+歌手」匹配，有两类必须拦下的问题：
 *  ① 同名错版本（翻唱/伴奏/串烧/现场版）→ 用「音频时长」这个与版本强相关的客观特征判定；
 *  ② 伪成功：地址返回的根本不是音频（HTML 404 / JSON {"code":401}）→ 由 acceptProbe 的
 *     not-audio 分支拒绝，否则用户点播放会直接拿到坏流。
 * 探测不到数据或时长未知时放行（fail-open，避免误杀可用音源）。
 */
async function acceptCandidate(r: ParseResult, expectedMs: number): Promise<boolean> {
  if (r.trial) return true;
  const upstream = upstreamOf(r.url);
  if (!upstream) return true;
  const probe = await probeAudio(upstream);
  if (probe.status === 'not-audio') {
    console.warn(`[MusicParser] 候选音源 ${r.source} 返回的不是音频，丢弃`);
    return false;
  }
  if (probe.status === 'ok' && expectedMs && !acceptProbe(probe, expectedMs)) {
    console.warn(
      `[MusicParser] 时长校验不符，丢弃候选音源 ${r.source}：实际 ${Math.round(probe.durationSec)}s vs 期望 ${Math.round(expectedMs / 1000)}s`
    );
    return false;
  }
  return true;
}

async function tryStrategies(
  p: ParseParams,
  strategies: Array<(p: ParseParams) => Promise<ParseResult | null>>,
  expectedMs = 0
): Promise<ParseResult | null> {
  for (const fn of strategies) {
    const r = await fn(p);
    if (r?.url && (await acceptCandidate(r, expectedMs))) return r;
  }
  return null;
}

/**
 * 音源稳定性/音质实测（2026-09-10，热歌榜 + 飙升榜各 10~15 首样本）：
 *
 * | 音源          | 成功率 | 时长正确 | 音质        | 延迟    |
 * |--------------|-------|---------|------------|--------|
 * | gdmusic:netease | 100% | 100%   | FLAC ~1336k | ~2.9s  |
 * | lx:wy        | 100%  | 100%    | MP3 320k    | ~0.8s  |
 * | lx:kw        | 100%  | 60%     | MP3/MP4 185k| ~0.9s  |
 * | ub:kugou     | 45%   | 78%     | MP3 128k    | ~0.7s  |
 * | ub:kuwo      | 95%   | 21%     | MP3 138k    | ~1.3s  |
 * | gd:joox      | 20%   | 75%     | FLAC        | ~2.0s  |
 * | lx:mg/kg/tx  | —     | —       | 非音频(HTML/JSON) | — |
 * | gd:tidal / ub:migu / ub:pyncmd | 0% | — | — | — |
 *
 * 结论：**GDMusic(netease) 音质与正确率最高，LX(wy) 速度最快且同样 100% 正确**。
 * 故按用户请求的音质档位分两套顺序：
 *  - 无损档（lossless/hires/jymaster）：GDMusic(netease) 优先，直接拿 FLAC；
 *  - 有损档（standard/exhigh）：LX(wy) 优先，320k 且约 0.8s 起播。
 * Unblock 各平台实测质量最差（多为 128k 且错配率高），降为最后兜底。
 */
const LOSSLESS_TIERS = new Set(['lossless', 'hires', 'jymaster']);

/** 外站解析（按音质档位决定优先级） */
async function tryThirdParty(p: ParseParams, expectedMs = 0): Promise<ParseResult | null> {
  const losslessFirst = LOSSLESS_TIERS.has(p.quality || 'exhigh');
  const strategies: Array<(p: ParseParams) => Promise<ParseResult | null>> = losslessFirst
    ? [(pp) => tryGDMusic(pp), (pp) => tryLxMusic(pp), (pp) => tryUnblock(pp, 5_000)]
    : [(pp) => tryLxMusic(pp), (pp) => tryGDMusic(pp), (pp) => tryUnblock(pp, 5_000)];
  return tryStrategies(p, strategies, expectedMs);
}

// ============================================================
// 主入口：VIP 分流
// ============================================================
export async function resolveSongUrl(
  params: ParseParams & { vip: boolean; cookie?: string; bypassCache?: boolean }
): Promise<ParseResult | null> {
  const { vip, cookie, bypassCache, ...p } = params;

  // 成功缓存：音质档位参与 key（不同档位请求不得互相拿到对方的结果）；
  // ⚠️ cookie 指纹也必须参与 key —— 否则 A 账号解析出的 VIP 付费直链会被
  //    任意匿名/他账号请求在 10 分钟内复用（vip 参数是客户端可控的，兜不住这事）
  const cookieTag = cookie
    ? crypto.createHash('md5').update(cookie).digest('hex').slice(0, 8)
    : 'anon';
  const cacheKey = `${p.id}_${p.quality || 'exhigh'}_${vip ? 'v' : 'n'}_${cookieTag}`;
  if (!bypassCache) {
    const cached = successCache.get(cacheKey);
    if (cached && Date.now() - cached.time < SUCCESS_TTL) return cached.data;
  }

  let result: ParseResult | null = null;
  const expectedMs = p.durationMs ?? (p.detail?.dt as number | undefined) ?? 0;

  if (vip) {
    // VIP：① 官方 API → ② 外站解析
    result = await tryNcmOfficial(p, cookie);
    if (!result) result = await tryThirdParty(p, expectedMs);
  } else {
    // 非 VIP：① 外站解析 → ② 官方 API（试听兜底）
    result = await tryThirdParty(p, expectedMs);
    if (!result) result = await tryNcmOfficial(p, cookie);
  }

  if (result) successCache.set(cacheKey, { data: result, time: Date.now() });
  return result;
}

// ============================================================
// 官方 API（带音质降级）
// ============================================================
async function tryNcmOfficial(p: ParseParams, cookie?: string): Promise<ParseResult | null> {
  // 无 cookie 时跳过需要会员的高音质，避免无意义请求
  const VIP_LEVELS = ['jymaster', 'hires', 'lossless'];
  const ALL_LEVELS = ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'];
  const startIdx = ALL_LEVELS.indexOf(p.quality || 'exhigh');
  let chain = startIdx >= 0 ? ALL_LEVELS.slice(startIdx) : ['exhigh', 'standard'];
  if (!cookie) chain = chain.filter(l => !VIP_LEVELS.includes(l));
  if (!chain.length) chain = ['standard'];
  let trialFallback: ParseResult | null = null;

  for (const level of chain) {
    try {
      const res = await NcmApi.song_url_v1({ id: p.id, level, cookie });
      const info = res.body?.data?.[0];
      if (!info?.url) continue;
      if (!info.freeTrialInfo) {
        return { url: PROXY(info.url), quality: 'netease-' + level, trial: false, size: info.size || 0, source: 'netease-' + level };
      }
      if (!trialFallback) {
        trialFallback = { url: PROXY(info.url), quality: 'netease-trial', trial: true, size: info.size || 0, source: 'netease-trial' };
      }
    } catch (err: any) {
      const msg = err?.body?.msg || err?.message || '';
      console.warn(`[MusicParser] NCM ${level} 失败:`, msg);
      // ECONNRESET/502 = 连接被重置，短暂等待后重试下一级
      if (msg.includes('ECONNRESET') || msg.includes('502')) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  return trialFallback;
}
