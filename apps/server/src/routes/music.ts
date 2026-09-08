import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import NcmApiDefault from 'NeteaseCloudMusicApi';
import unblockMatch from '@unblockneteasemusic/server';
import { getNeteaseCookie } from '../neteaseSession';

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

/** 前端音质档位 → 网易云 level */
const QUALITY_LEVEL: Record<string, string> = {
  jymaster: 'jymaster',
  hires: 'hires',
  lossless: 'lossless',
  exhigh: 'exhigh',
  standard: 'standard'
};

const UNBLOCK_PLATFORMS = ['migu', 'kugou', 'kuwo', 'pyncmd'];

/** 外站音源包装为同源代理地址
 *  前端 Web Audio 频谱分析要求音频元素 crossOrigin=anonymous，
 *  而酷狗/酷我等平台 CDN 不返回 CORS 头，直连会被浏览器拦截。
 *  返回相对路径，dev 经 Vite 代理、生产同源部署，均无跨域问题。 */
function proxyAudioUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/music/stream?url=${encodeURIComponent(url)}`;
}

/** 从其它平台（咪咕/酷狗/酷我等）解析完整音源，失败返回 null
 *  minSize: 最小文件体积（字节），过滤平台返回的十几秒预览片段
 *  timeout: 探测超时（毫秒），避免切歌长时间卡在平台匹配上 */
async function tryUnblockFullTrack(id: string, minSize = 0, timeout = 0): Promise<{
  url: string;
  quality: string;
  trial: boolean;
  size: number;
} | null> {
  const doMatch = (async () => {
    try {
      const detail = await NcmApi.song_detail({ ids: id, cookie: getNeteaseCookie() });
      const s = detail.body?.songs?.[0];
      if (!s) return null;

      const matched: any = await unblockMatch(Number(id), UNBLOCK_PLATFORMS, {
        name: s.name || '',
        artists: (s.ar || []).map((a: any) => ({ name: a.name })),
        album: { name: (s.al || {}).name || '' }
      });
      if (matched?.url) {
        const size = matched.size || 0;
        // 体积过小的匹配多为预览片段；有 minSize 要求时不达标视为无效
        if (minSize > 0 && size > 0 && size < minSize) return null;
        return {
          url: matched.url,
          quality: 'unblock',
          trial: false,
          size
        };
      }
    } catch {
      // unblock 失败不影响主流程
    }
    return null;
  })();

  if (timeout > 0) {
    return Promise.race([
      doMatch,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout))
    ]);
  }
  return doMatch;
}

export async function musicRoutes(fastify: FastifyInstance) {
  // 音频流代理：转发外站音源为同源响应，透传 Range 头以支持拖动进度条
  fastify.get('/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const { url } = request.query as { url?: string };
    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.status(400).send({ success: false, error: '缺少有效的音源地址' });
    }

    try {
      const upstream = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          ...(request.headers.range ? { Range: request.headers.range } : {})
        },
        redirect: 'follow'
      });

      if (!upstream.body || (upstream.status !== 200 && upstream.status !== 206)) {
        return reply.status(502).send({ success: false, error: `音源上游返回 ${upstream.status}` });
      }

      reply.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) reply.header(header, value);
      }
      return reply.send(Readable.fromWeb(upstream.body as any));
    } catch (error) {
      fastify.log.error(error);
      return reply.status(502).send({ success: false, error: '音源代理失败' });
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

    try {
      const res = await NcmApi.cloudsearch({
        keywords: keyword.trim(),
        type: 1,
        limit: Math.min(Number(limit) || 30, 100),
        offset: Number(offset) || 0,
        cookie: getNeteaseCookie()
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
      const res = await NcmApi.song_detail({ ids: id, cookie: getNeteaseCookie() });
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

  // 获取歌曲播放链接（网易云直链 → UnblockNeteaseMusic 灰色歌曲兜底）
  fastify.get('/song/:id/url', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { quality = 'exhigh' } = request.query as { quality?: string };
    const level = QUALITY_LEVEL[quality] || 'exhigh';

    try {
      const res = await NcmApi.song_url_v1({ id, level, cookie: getNeteaseCookie() });
      const info = res.body?.data?.[0];

      if (info?.url) {
        // 完整音源：直接返回
        if (!info.freeTrialInfo) {
          return {
            success: true,
            data: {
              url: proxyAudioUrl(info.url),
              quality,
              trial: false,
              size: info.size || 0
            }
          };
        }

        // 试听片段（VIP/付费曲，未登录或无会员）→ 限时 5 秒探测其它平台完整音源（≥1MB），超时/失败回退试听
        const unblocked = await tryUnblockFullTrack(id, 1_000_000, 5_000);
        if (unblocked) {
          return { success: true, data: { ...unblocked, url: proxyAudioUrl(unblocked.url) } };
        }
        return {
          success: true,
          data: {
            url: proxyAudioUrl(info.url),
            quality,
            trial: true,
            size: info.size || 0
          }
        };
      }

      // 无直链（灰色/版权下架）→ 从其它平台匹配
      const unblocked = await tryUnblockFullTrack(id);
      if (unblocked) {
        return { success: true, data: { ...unblocked, url: proxyAudioUrl(unblocked.url) } };
      }

      return reply.status(404).send({ success: false, error: '暂无可用播放源' });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '解析播放地址失败' });
    }
  });

  // 获取歌词
  fastify.get('/song/:id/lyric', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const res = await NcmApi.lyric({ id, cookie: getNeteaseCookie() });
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
      const res = await NcmApi.playlist_detail({ id, cookie: getNeteaseCookie() });
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
  fastify.get('/recommend', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const cookie = getNeteaseCookie();

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
