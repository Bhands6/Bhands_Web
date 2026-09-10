/**
 * 网易云登录会话（多浏览器会话隔离）
 * 每个浏览器通过 httpOnly cookie 中的 bhands_sid 绑定一份网易云 cookie，
 * 不同访问者各自登录互不覆盖；内存保存，进程重启后需重新登录。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureDataDir } from './dataDir';

const SID_NAME = 'bhands_sid';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天未活动过期
const COOKIE_FILE = path.join(ensureDataDir(), 'ncm-cookies.json');

interface SessionEntry {
  cookie: string;
  updatedAt: number;
}

const sessions = new Map<string, SessionEntry>();
// TODO: 测试用功能，正式部署时移除 cookie 持久化（persistSessions / loadPersistedSessions / COOKIE_FILE）
/** 存盘：保存所有会话到文件 */
function persistSessions(): void {
  try {
    const dir = path.dirname(COOKIE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data: Record<string, SessionEntry> = {};
    for (const [sid, entry] of sessions) data[sid] = entry;
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2));
  } catch { /* 非致命 */ }
}

/** 启动时从文件恢复会话 */
export function loadPersistedSessions(): number {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')) as Record<string, SessionEntry>;
    let count = 0;
    for (const [sid, entry] of Object.entries(data)) {
      if (entry.cookie && Date.now() - entry.updatedAt < SESSION_TTL_MS) {
        sessions.set(sid, entry);
        count++;
      }
    }
    return count;
  } catch { return 0; }
}


/** 从请求头解析当前浏览器的 bhands_sid */
export function parseSid(request: FastifyRequest): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SID_NAME) {
      const sid = part.slice(idx + 1).trim();
      return sid || undefined;
    }
  }
  return undefined;
}

/** 懒清理过期会话（写入时顺带执行，避免常驻定时器） */
function pruneSessions(): void {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    if (now - entry.updatedAt > SESSION_TTL_MS) sessions.delete(sid);
  }
}

/** 读取当前浏览器会话对应的网易云 cookie（未登录返回空串） */
export function getNeteaseCookie(request: FastifyRequest): string {
  const sid = parseSid(request);
  if (!sid) return '';
  const entry = sessions.get(sid);
  if (!entry) return '';
  entry.updatedAt = Date.now();
  return entry.cookie;
}

/** 确保浏览器持有会话 ID：没有则签发并通过 Set-Cookie 下发 */
export function ensureSid(request: FastifyRequest, reply: FastifyReply): string {
  const existing = parseSid(request);
  if (existing) return existing;
  const sid = randomUUID();
  // HTTPS 部署（Caddy 反代 + trustProxy）下附加 Secure，防止会话 ID 走明文外泄
  const secure = request.protocol === 'https' ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `${SID_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return sid;
}

/** 扫码登录成功：把网易云 cookie 绑定到当前浏览器会话 */
export function setNeteaseCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  cookie: string
): void {
  const sid = ensureSid(request, reply);
  pruneSessions();
  sessions.set(sid, { cookie, updatedAt: Date.now() });
  persistSessions();
}

/** 退出登录：仅清除当前浏览器会话的网易云 cookie */
export function clearNeteaseCookie(request: FastifyRequest): void {
  const sid = parseSid(request);
  if (sid) { sessions.delete(sid); persistSessions(); }
}
