import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getNeteaseCookie, setNeteaseCookie, clearNeteaseCookie, ensureSid } from '../neteaseSession';
import { NcmApi } from '../ncm';

interface UserInfo {
  userId: string;
  nickname: string;
  avatar: string;
  vip: boolean;
  vipType?: number;
}

/**
 * 用当前浏览器会话的网易云 cookie 拉取账号信息。
 * 返回 null = 网易云确认未登录/cookie 失效；网络等瞬时异常时抛出，
 * 调用方不得把异常当作登录失效处理（否则一次网络抖动就把用户登出）。
 */
async function fetchUserInfo(request: FastifyRequest): Promise<UserInfo | null> {
  const cookie = getNeteaseCookie(request);
  if (!cookie) return null;

  const res = await NcmApi.login_status({ cookie });
  const profile = res.body?.data?.profile;
  if (!profile?.userId) return null;
  return {
    userId: String(profile.userId),
    nickname: profile.nickname || '',
    avatar: profile.avatarUrl || '',
    vip: !!profile.vipType,
    vipType: profile.vipType || 0
  };
}

const QR_MESSAGES: Record<number, string> = {
  800: '二维码已过期',
  801: '等待扫码',
  802: '已扫码，等待确认',
  803: '登录成功'
};

export async function userRoutes(fastify: FastifyInstance) {
  // 生成扫码登录二维码（顺带签发浏览器会话 ID，后续轮询/登录都绑定到该浏览器）
  fastify.get('/qr/create', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      ensureSid(request, reply);
      const keyRes = await NcmApi.login_qr_key();
      const key = keyRes.body?.data?.unikey;
      if (!key) {
        return reply.status(502).send({ success: false, error: '生成二维码 key 失败' });
      }
      const qrRes = await NcmApi.login_qr_create({ key, qrimg: true });
      const qrimg = qrRes.body?.data?.qrimg || '';
      if (!qrimg) {
        return reply.status(502).send({ success: false, error: '生成二维码图片失败' });
      }
      return { success: true, data: { key, qrimg } };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '创建二维码失败' });
    }
  });

  // 轮询扫码状态（803 成功时把网易云会话绑定到当前浏览器）
  fastify.get('/qr/check', async (request: FastifyRequest, reply: FastifyReply) => {
    const { key } = request.query as { key?: string };
    if (!key) {
      return reply.status(400).send({ success: false, error: '缺少 key' });
    }

    try {
      const res = await NcmApi.login_qr_check({ key });
      const code = Number(res.body?.code) || 801;

      if (code === 803) {
        // 优先取 body.cookie；部分 NCM 版本会放在响应 Set-Cookie 头里，做兜底拼接
        let cookie = res.body?.cookie || '';
        if (!cookie && Array.isArray((res as any).cookie)) {
          cookie = (res as any).cookie
            .map((c: string) => c.split(';')[0])
            .filter((c: string) => c.includes('='))
            .join('; ');
        }
        if (!cookie) {
          return { success: true, data: { code, message: '登录成功但未取得会话' } };
        }
        setNeteaseCookie(request, reply, cookie);
        // login_status 偶发超时时重试一次，尽量避免 user 为空
        let user: UserInfo | null = null;
        try {
          user = await fetchUserInfo(request);
        } catch {
          user = await fetchUserInfo(request).catch(() => null);
        }
        return { success: true, data: { code, message: QR_MESSAGES[code], user } };
      }

      return { success: true, data: { code, message: QR_MESSAGES[code] || '未知状态' } };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '查询扫码状态失败' });
    }
  });

  // 登录状态（按浏览器会话独立判定）
  fastify.get('/status', async (request: FastifyRequest, _reply: FastifyReply) => {
    let user: UserInfo | null = null;
    let transient = false;
    try {
      user = await fetchUserInfo(request);
    } catch {
      // 网易云瞬时故障：保留登录态与 cookie，仅本次无法确认用户信息
      transient = true;
    }
    if (!user && !transient) clearNeteaseCookie(request); // 仅在确认 cookie 失效时清理
    return { success: true, data: { loggedIn: transient || !!user, user } };
  });

  // 用户歌单（返回当前登录者自己的歌单）
  fastify.get('/playlists', async (request: FastifyRequest, reply: FastifyReply) => {
    let user: UserInfo | null;
    try {
      user = await fetchUserInfo(request);
    } catch (error) {
      // 瞬时故障 ≠ 未登录：不清登录态，让前端稍后重试
      fastify.log.error(error);
      return reply.status(502).send({ success: false, error: '获取用户信息失败，请稍后重试' });
    }
    const cookie = getNeteaseCookie(request);
    if (!user || !cookie) {
      return reply.status(401).send({ success: false, error: '未登录' });
    }

    try {
      const res = await NcmApi.user_playlist({ uid: user.userId, limit: 100, cookie });
      const playlists = (res.body?.playlist || []).map((p: any) => ({
        id: String(p.id),
        name: p.name || '',
        cover: p.coverImgUrl || '',
        trackCount: p.trackCount || 0
      }));
      return { success: true, data: playlists };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '获取用户歌单失败' });
    }
  });

  // 退出登录（仅退出当前浏览器会话）
  fastify.post('/logout', async (request: FastifyRequest, _reply: FastifyReply) => {
    clearNeteaseCookie(request);
    return { success: true, data: null };
  });
}
