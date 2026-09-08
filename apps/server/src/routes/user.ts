import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import NcmApiDefault from 'NeteaseCloudMusicApi';
import { getNeteaseCookie, setNeteaseCookie, clearNeteaseCookie } from '../neteaseSession';

// NCM 自带类型过于严格（body 字段均为 unknown），路由层按宽松类型调用
const NcmApi = NcmApiDefault as unknown as Record<string, (query?: any) => Promise<any>>;

interface UserInfo {
  userId: string;
  nickname: string;
  avatar: string;
  vip: boolean;
  vipType?: number;
}

/** 用当前会话 cookie 拉取网易云账号信息（未登录/失效返回 null） */
async function fetchUserInfo(): Promise<UserInfo | null> {
  const cookie = getNeteaseCookie();
  if (!cookie) return null;

  try {
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
  } catch {
    return null;
  }
}

const QR_MESSAGES: Record<number, string> = {
  800: '二维码已过期',
  801: '等待扫码',
  802: '已扫码，等待确认',
  803: '登录成功'
};

export async function userRoutes(fastify: FastifyInstance) {
  // 生成扫码登录二维码
  fastify.get('/qr/create', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
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

  // 轮询扫码状态（803 成功时服务端保存 cookie）
  fastify.get('/qr/check', async (request: FastifyRequest, reply: FastifyReply) => {
    const { key } = request.query as { key?: string };
    if (!key) {
      return reply.status(400).send({ success: false, error: '缺少 key' });
    }

    try {
      const res = await NcmApi.login_qr_check({ key });
      const code = Number(res.body?.code) || 801;

      if (code === 803) {
        const cookie = res.body?.cookie || '';
        if (!cookie) {
          return { success: true, data: { code, message: '登录成功但未取得会话' } };
        }
        setNeteaseCookie(cookie);
        // login_status 偶发超时时重试一次，尽量避免 user 为空
        let user = await fetchUserInfo();
        if (!user) user = await fetchUserInfo();
        return { success: true, data: { code, message: QR_MESSAGES[code], user } };
      }

      return { success: true, data: { code, message: QR_MESSAGES[code] || '未知状态' } };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '查询扫码状态失败' });
    }
  });

  // 登录状态
  fastify.get('/status', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const user = await fetchUserInfo();
    if (!user) clearNeteaseCookie(); // cookie 失效及时清理
    return { success: true, data: { loggedIn: !!user, user } };
  });

  // 用户歌单
  fastify.get('/playlists', async (request: FastifyRequest, reply: FastifyReply) => {
    const cookie = getNeteaseCookie();
    const user = await fetchUserInfo();
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

  // 退出登录
  fastify.post('/logout', async (_request: FastifyRequest, _reply: FastifyReply) => {
    clearNeteaseCookie();
    return { success: true, data: null };
  });
}
