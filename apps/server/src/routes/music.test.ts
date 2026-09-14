import { describe, it, expect, afterEach, vi } from 'vitest';
import { shouldDirectRedirect } from './music';

// music.ts 的 import 链含顶层副作用模块（lxMusicRunner 顶层 ensureDataDir 会触碰真实
// data 目录，见 lxMusicRunner.test.ts 文件头禁令）。本文件只测纯函数，重型依赖全部 mock 掉。
vi.mock('../services/musicParser', () => ({ resolveSongUrl: vi.fn() }));
vi.mock('../services/music-sources/lxMusicRunner', () => ({
  initRunner: vi.fn(),
  setActiveRunner: vi.fn(),
  removeRunner: vi.fn(),
  listRunners: vi.fn(() => []),
  canAddScript: vi.fn(() => true),
  resolveWithScriptOnce: vi.fn(),
  isBuiltinRunner: vi.fn(() => false)
}));
vi.mock('../neteaseSession', () => ({ getNeteaseCookie: vi.fn(() => '') }));
vi.mock('../adminAuth', () => ({ assertAdmin: vi.fn() }));
vi.mock('../rateLimit', () => ({ limitedByIp: vi.fn(() => true) }));
vi.mock('../ncm', () => ({ NcmApi: class {} }));

// 302 直连省带宽：仅 https + 网易官方 CDN 域（实测 CORS 全局放行），
// 其余音源走同源代理兜底（music.ts 内注释含完整背景）。
describe('shouldDirectRedirect（stream 302 直连判定）', () => {
  afterEach(() => {
    delete process.env.STREAM_DIRECT_REDIRECT;
  });

  it('https + 网易 CDN 子域 → 直连', () => {
    expect(shouldDirectRedirect('https://m801.music.126.net/a/b/c.flac')).toBe(true);
    expect(shouldDirectRedirect('https://m701.music.126.net/x.mp3')).toBe(true);
  });

  it('https + 网易裸域 → 直连', () => {
    expect(shouldDirectRedirect('https://music.126.net/a.mp3')).toBe(true);
  });

  it('协议/域名大小写不敏感（URL 归一化）', () => {
    expect(shouldDirectRedirect('HTTPS://M801.MUSIC.126.NET/a.flac')).toBe(true);
  });

  it('http 网易链 → 不直连（mixed content + 未实测）', () => {
    expect(shouldDirectRedirect('http://m801.music.126.net/a.flac')).toBe(false);
  });

  it('其他白名单代理域（kugou）不在直连名单 → 走代理', () => {
    expect(shouldDirectRedirect('https://lxyy.kugou.com/a.mp3')).toBe(false);
  });

  it('后缀伪装域（126.net.evil.com）→ 不直连', () => {
    expect(shouldDirectRedirect('https://music.126.net.evil.com/a.flac')).toBe(false);
    expect(shouldDirectRedirect('https://evilmusic.126.net.cn/a.flac')).toBe(false);
  });

  it('畸形 URL → 不直连', () => {
    expect(shouldDirectRedirect('not-a-url')).toBe(false);
    expect(shouldDirectRedirect('ftp://m801.music.126.net/a.flac')).toBe(false);
  });

  it('默认开启；STREAM_DIRECT_REDIRECT=off 时整体回退代理模式', () => {
    expect(shouldDirectRedirect('https://m801.music.126.net/a.flac')).toBe(true);
    process.env.STREAM_DIRECT_REDIRECT = 'off';
    expect(shouldDirectRedirect('https://m801.music.126.net/a.flac')).toBe(false);
  });
});
