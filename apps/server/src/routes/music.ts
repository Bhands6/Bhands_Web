import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import NcmApiDefault from 'NeteaseCloudMusicApi';
import { resolveSongUrl } from '../services/musicParser';
import { initRunner, setActiveRunner, removeRunner, listRunners as listLxRunners, canAddScript } from '../services/music-sources/lxMusicRunner';
import { getNeteaseCookie } from '../neteaseSession';
import { assertAdmin } from '../adminAuth';
import { limitedByIp } from '../rateLimit';

// NCM 自带类型过于严格（body 字段均为 unknown），路由层按宽松类型调用
const NcmApi = NcmApiDefault as unknown as Record<string, (query?: any) => Promise<any>>;

/** 前端 SongItem 结构 */
interface SongItem {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
  source?: string;
}

/** 网易云歌曲对象 → 前端 SongItem（兼容 cloudsearch/ar[] 与 song_detail 两种结构） */
function mapNcmSong(s: any): SongItem {
  const artists = s.ar || s.artists || [];
  const album = s.al || s.album || {};
  return {
    id: String(s.id),
    name: s.name || '',
    artist: artists.map((a: any) => a.name).filter(Boolean).join(' / '),
    album: album.name || '',
    duration: Math.round((s.dt || s.duration || 0) / 1000),
    cover: album.picUrl || s.picUrl || '',
    source: 'netease'
  };
}

// ============================================================
// 音频流代理：同源化外站音源 + SSRF 防护
// ============================================================
/** 允许代理的音源 CDN 域名后缀（匹配自身或任意子域） */
const DEFAULT_STREAM_HOSTS = [
  'music.126.net',   // 网易云 CDN（官方/pyncmd）
  'migu.cn',         // 咪咕
  'kugou.com',       // 酷狗
  'kuwo.cn',         // 酷我
  'qqmusic.qq.com',  // QQ 音乐
  'joox.com',        // GDMusic joox 源
  'tidal.com'        // GDMusic tidal 源
];

function streamHostAllowlist(): string[] {
  const extra = (process.env.STREAM_HOST_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_STREAM_HOSTS, ...extra];
}

function isAllowedStreamHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return streamHostAllowlist().some((d) => h === d || h.endsWith('.' + d));
}

/**
 * 抓取上游音频。逐跳校验重定向目标域名（redirect: manual），
 * 仅对响应头限时（超时后清除），音频 body 可长时间流式传输。
 */
async function fetchUpstreamAudio(rawUrl: string, range?: string): Promise<Response> {
  let url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的协议: ${url.protocol}`);
  }

  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedStreamHost(url.hostname)) {
      throw new Error(`音源域名不在白名单: ${url.hostname}`);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          ...(range ? { Range: range } : {})
        }
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        res.body?.cancel().catch(() => {});
        if (!loc) throw new Error('上游重定向缺少 Location');
        url = new URL(loc, url);
        continue;
      }
      return res;
    } finally {
      // fetch 已返回（含重定向响应）：清除头超时，body 流式传输不受影响
      clearTimeout(timer);
    }
  }
  throw new Error('上游重定向次数过多');
}

export async function musicRoutes(fastify: FastifyInstance) {
  // 音频流代理：转发外站音源为同源响应，透传 Range 头以支持拖动进度条
  fastify.get('/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const { url } = request.query as { url?: string };
    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.status(400).send({ success: false, error: '缺少有效的音源地址' });
    }
    if (!limitedByIp(request, 'stream', 60, 60_000)) {
      return reply.status(429).send({ success: false, error: '请求过于频繁，请稍后再试' });
    }

    try {
      const upstream = await fetchUpstreamAudio(url, request.headers.range);
      if (upstream.status !== 200 && upstream.status !== 206) {
        upstream.body?.cancel().catch(() => {});
        return reply.status(502).send({ success: false, error: `音源上游返回 ${upstream.status}` });
      }

      reply.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) reply.header(header, value);
      }
      return reply.send(Readable.fromWeb(upstream.body as any));
    } catch (error: any) {
      fastify.log.warn(error, 'stream 代理失败');
      const msg = error?.message || '';
      const status = msg.includes('白名单') || msg.includes('协议') ? 400 : 502;
      return reply.status(status).send({ success: false, error: `音源代理失败: ${msg}` });
    }
  });

  // 搜索歌曲
  fastify.get('/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const { keyword, limit = 30, offset = 0 } = request.query as {
      keyword?: string;
      limit?: string;
      offset?: string;
    };

    if (!keyword || !keyword.trim()) {
      return reply.status(400).send({ success: false, error: '缺少搜索关键词' });
    }
    if (!limitedByIp(request, 'search', 30, 60_000)) {
      return reply.status(429).send({ success: false, error: '搜索过于频繁，请稍后再试' });
    }

    try {
      const res = await NcmApi.cloudsearch({
        keywords: keyword.trim(),
        type: 1,
        limit: Math.min(Number(limit) || 30, 100),
        offset: Number(offset) || 0,
        cookie: getNeteaseCookie(request)
      });
      const songs = (res.body?.result?.songs || []).map(mapNcmSong);
      return { success: true, data: songs };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '搜索失败，请稍后重试' });
    }
  });

  // 获取歌曲详情
  fastify.get('/song/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const res = await NcmApi.song_detail({ ids: id, cookie: getNeteaseCookie(request) });
      const song = res.body?.songs?.[0];
      if (!song) {
        return reply.status(404).send({ success: false, error: '歌曲不存在' });
      }
      return { success: true, data: mapNcmSong(song) };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '获取歌曲详情失败' });
    }
  });

  // 获取歌曲播放链接（VIP 分流：VIP 先官方后解析，非 VIP 先解析后官方）
  fastify.get('/song/:id/url', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { quality = 'exhigh', vip, fresh } = request.query as { quality?: string; vip?: string; fresh?: string };
    const cookie = getNeteaseCookie(request);

    if (!limitedByIp(request, 'songurl', 60, 60_000)) {
      return reply.status(429).send({ success: false, error: '请求过于频繁，请稍后再试' });
    }

    try {
      // 预取歌曲详情：GDMusic / LX 脚本（kw/mg/kg）按歌名匹配，缺失元数据时这些通道全部失效
      let name = '';
      let artists: string[] = [];
      let detail: any;
      try {
        const res = await NcmApi.song_detail({ ids: id, cookie });
        detail = res.body?.songs?.[0];
        if (detail) {
          name = detail.name || '';
          artists = (detail.ar || []).map((a: any) => a.name).filter(Boolean);
        }
      } catch { /* 元数据拉取失败不阻塞解析，第三方按缺省信息降级 */ }

      const result = await resolveSongUrl({
        id, name, artists, detail, quality,
        // 时长（ms）供音源脚本换算 interval，缺失会导致匹配到错版本
        durationMs: detail?.dt || 0,
        vip: vip === 'true' || vip === '1',
        cookie,
        // fresh=1：绕过成功缓存重新解析（前端播放失败重试时使用，规避缓存的过期直链）
        bypassCache: fresh === '1' || fresh === 'true'
      });
      if (result) {
        return { success: true, data: result };
      }
      return reply.status(404).send({ success: false, error: '暂无可用播放源' });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '解析播放地址失败' });
    }
  });

  // ---- LX Music 脚本管理（写操作需 ADMIN_TOKEN，见 adminAuth.ts）----

  // 上传 LX Music 脚本
  fastify.post('/parse/lx/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(request, reply)) return;
    if (!limitedByIp(request, 'lxupload', 10, 60_000)) {
      return reply.status(429).send({ success: false, error: '操作过于频繁' });
    }
    const { script, name } = request.body as { script?: string; name?: string };
    if (!script) return reply.status(400).send({ success: false, error: '缺少脚本内容' });
    if (script.length > 512_000) return reply.status(400).send({ success: false, error: '脚本过大（上限 500KB）' });
    if (!canAddScript()) return reply.status(400).send({ success: false, error: '脚本数量已达上限（12 个），请先删除不用的脚本' });
    const scriptId = 'lx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const scriptName = name || 'LX Music 脚本 ' + scriptId;
    try {
      const runner = await initRunner(scriptId, script, scriptName, true);
      if (runner) {
        return { success: true, id: scriptId, name: scriptName, sources: runner.getAvailableSourceKeys() };
      }
      return reply.status(400).send({ success: false, error: '脚本执行失败，未导出有效音源' });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 获取脚本列表（只读，无需令牌）
  fastify.get('/parse/lx/list', async () => {
    return { success: true, data: listLxRunners() };
  });

  // 激活脚本
  fastify.post('/parse/lx/activate', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(request, reply)) return;
    const { id } = request.body as { id?: string };
    if (!id || !setActiveRunner(id)) {
      return reply.status(404).send({ success: false, error: '脚本不存在' });
    }
    return { success: true };
  });

  // 删除脚本
  fastify.post('/parse/lx/delete', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertAdmin(request, reply)) return;
    const { id } = request.body as { id?: string };
    if (!id) return reply.status(400).send({ success: false, error: '缺少脚本 ID' });
    removeRunner(id);
    return { success: true };
  });

  // 获取歌词
  fastify.get('/song/:id/lyric', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const res = await NcmApi.lyric({ id, cookie: getNeteaseCookie(request) });
      return {
        success: true,
        data: {
          lrc: res.body?.lrc?.lyric || '',
          tlyric: res.body?.tlyric?.lyric || '',
          klyric: res.body?.klyric?.lyric || ''
        }
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '获取歌词失败' });
    }
  });

  // 获取歌单详情
  fastify.get('/playlist/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const res = await NcmApi.playlist_detail({ id, cookie: getNeteaseCookie(request) });
      const pd = res.body?.playlist;
      if (!pd) {
        return reply.status(404).send({ success: false, error: '歌单不存在' });
      }
      return {
        success: true,
        data: {
          id: String(pd.id),
          name: pd.name || '',
          cover: pd.coverImgUrl || '',
          trackCount: pd.trackIds?.length || 0,
          tracks: (pd.tracks || []).map(mapNcmSong)
        }
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '获取歌单详情失败' });
    }
  });

  // 推荐歌曲：登录用每日推荐，未登录退化为新歌速递
  fastify.get('/recommend', async (request: FastifyRequest, _reply: FastifyReply) => {
    const cookie = getNeteaseCookie(request);

    if (cookie) {
      try {
        const res = await NcmApi.recommend_songs({ cookie });
        const songs = (res.body?.data?.dailySongs || []).map(mapNcmSong);
        if (songs.length) {
          return { success: true, data: songs };
        }
      } catch (error) {
        // cookie 失效等情况 → 走匿名推荐
        fastify.log.warn(error, '每日推荐失败，使用新歌速递兜底');
      }
    }

    try {
      const res = await NcmApi.personalized_newsong({ limit: 30 });
      const songs = (res.body?.result || [])
        .map((item: any) => item.song)
        .filter(Boolean)
        .map(mapNcmSong);
      return { success: true, data: songs };
    } catch (error) {
      fastify.log.error(error);
      return { success: false, data: [], error: '获取推荐失败' };
    }
  });
}
