import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import NcmApiDefault from 'NeteaseCloudMusicApi';
import { resolveSongUrl } from '../services/musicParser';
import { initRunner, setActiveRunner, removeRunner, listRunners as listLxRunners } from '../services/music-sources/lxMusicRunner';
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
    const { quality = 'exhigh', vip } = request.query as { quality?: string; vip?: string };
    const cookie = getNeteaseCookie(request);

    try {
      const result = await resolveSongUrl({
        id, name: '', artists: [], quality,
        vip: vip === 'true' || vip === '1',
        cookie
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

  // ---- LX Music 脚本管理 ----

  // 上传 LX Music 脚本
  fastify.post('/parse/lx/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    const { script, name } = request.body as { script?: string; name?: string };
    if (!script) return reply.status(400).send({ success: false, error: '缺少脚本内容' });
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

  // 获取脚本列表
  fastify.get('/parse/lx/list', async () => {
    return { success: true, data: listLxRunners() };
  });

  // 激活脚本
  fastify.post('/parse/lx/activate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.body as { id?: string };
    if (!id || !setActiveRunner(id)) {
      return reply.status(404).send({ success: false, error: '脚本不存在' });
    }
    return { success: true };
  });

  // 删除脚本
  fastify.post('/parse/lx/delete', async (request: FastifyRequest, reply: FastifyReply) => {
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
