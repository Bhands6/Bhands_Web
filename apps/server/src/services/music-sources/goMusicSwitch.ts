/**
 * 策略：go-music-api 智能换源（https://github.com/guohuiyuan/go-music-api）
 *
 * 独立 Go 服务（Docker 部署，GO_MUSIC_API_URL 配置，默认 http://127.0.0.1:8080）：
 *   GET /api/v1/music/switch?name=&artist=&duration=  → 并发搜 6 平台按「歌名+歌手匹配 × 时长差」打分，返回单条最佳
 *   GET /api/v1/music/url?source=&id=&quality=        → 目标平台直链
 *
 * 定位：外站链路的**高质量兜底**——gdmusic 上游抖动 / wy 缺失时，用酷狗/酷我/QQ/咪咕的
 * 官方真实音源替代（远优于 unblock 的 128k 错配）。只接受 stream 白名单内的平台
 * （netease 跳过——官方自己更快；bilibili 等 CDN 不在白名单排除）。
 */
import type { ParseParams } from '../musicParser';

const GO_MUSIC_API = (process.env.GO_MUSIC_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const SWITCH_TIMEOUT = 4500;
const URL_TIMEOUT = 4500;

/** 平台 → 音频 CDN 域名（须与 music.ts 的 stream 白名单一致）；netease 官方更快故跳过 */
const PLATFORM_HOSTS: Record<string, string> = {
  qq: 'qqmusic.qq.com',
  kugou: 'kugou.com',
  kuwo: 'kuwo.cn',
  migu: 'migu.cn'
};

/** 失败缓存：服务离线/某曲不可换源时防反复打（与 gdmusic 的 failedCache 同款思路） */
const failedCache = new Map<string, number>();
const FAILED_TTL = 5 * 60_000;

async function getJson(url: string, timeout: number): Promise<any | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** 音质档位 → go-music-api 的 quality 参数（平台尽力满足，拿不到就给该平台最高档） */
function qualityOf(quality?: string): string {
  if (quality && LOSSLESS.has(quality)) return '999';
  return '320';
}
const LOSSLESS = new Set(['lossless', 'hires', 'jymaster']);

/** 智能换源解析：返回 null = 不可用（策略链继续走 unblock） */
export async function tryGoMusicSwitch(p: ParseParams): Promise<{ url: string; source: string; quality: string; trial: boolean; size: number } | null> {
  if (!p.name) return null;
  const br = qualityOf(p.quality);
  const key = `go_${p.id}_${br}`;
  if (failedCache.has(key) && Date.now() - failedCache.get(key)! < FAILED_TTL) return null;

  const artist = (p.artists || [])[0] || '';
  const durationSec = p.durationMs ? Math.round(p.durationMs / 1000) : 0;
  const q = `name=${encodeURIComponent(p.name)}${artist ? `&artist=${encodeURIComponent(artist)}` : ''}${durationSec ? `&duration=${durationSec}` : ''}`;

  // ① 换源：拿最佳候选（服务端已按分数排序取一）
  const sw = await getJson(`${GO_MUSIC_API}/api/v1/music/switch?${q}`, SWITCH_TIMEOUT);
  const cand = sw?.data || (sw?.source ? sw : null);
  if (!cand?.source || !cand?.id) {
    failedCache.set(key, Date.now());
    return null;
  }
  // ② 平台白名单过滤（音频直链必须能走我们的同源代理）
  const host = PLATFORM_HOSTS[cand.source];
  if (!host) {
    failedCache.set(key, Date.now());
    return null;
  }

  // ③ 直链
  const u = await getJson(`${GO_MUSIC_API}/api/v1/music/url?source=${cand.source}&id=${cand.id}&quality=${br}`, URL_TIMEOUT);
  const direct = u?.data?.url;
  if (!direct || !/^https?:\/\//i.test(direct)) {
    failedCache.set(key, Date.now());
    return null;
  }

  const proxy = (raw: string) => `/api/music/stream?url=${encodeURIComponent(raw)}`;
  return {
    url: proxy(direct),
    quality: `gomusic-${cand.source}`,
    trial: false,
    size: 0,
    source: `gomusic-${cand.source}`
  } as any;
}
