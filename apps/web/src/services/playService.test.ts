import { describe, it, expect, vi } from 'vitest';

/**
 * 回归测试：歌词辉光颜色解析。
 *
 * 历史 bug：银蓝兜底分支的 lyricColor 是 '#d8f1ff'（hex），而辉光色用 `/\d+/` 取分量
 * 会解析失败 → 退回「封面原始色」。该分支恰恰只在封面色偏暗时命中，于是辉光变成暗色、
 * 在深色舞台上完全不可见（表现为「歌词有跳动但没有溢光」）。
 */
vi.mock('../api/music', () => ({ musicApi: {} }));
vi.mock('../stores/usePlaylistStore', () => ({ usePlaylistStore: { getState: () => ({ loadPlaylistDetail: vi.fn() }) } }));
vi.mock('../stores/useHistoryStore', () => ({ useHistoryStore: { getState: () => ({ addToHistory: vi.fn() }) } }));
vi.mock('../stores/useUserStore', () => ({ useUserStore: { getState: () => ({ user: null }) } }));
vi.mock('../stores/useUIStore', () => ({
  useUIStore: { getState: () => ({ quality: 'exhigh', showToast: vi.fn() }) },
  QUALITY_LABELS: {
    jymaster: '超清母带', hires: '高清臻音', lossless: '无损 SQ', exhigh: '极高 HQ', standard: '标准'
  }
}));
vi.mock('../audio/beatClock', () => ({ beatClock: { setTrack: vi.fn(), setMap: vi.fn() } }));
vi.mock('../audio/beatAnalyzer', () => ({ analyzeTrackBeatMap: vi.fn() }));

const { parseColorToRgb, qualityRankOf, maybeToastQualityFallback } = await import('./playService');

describe('parseColorToRgb（歌词辉光取色）', () => {
  it('解析 hex 形式（银蓝兜底分支）', () => {
    expect(parseColorToRgb('#d8f1ff')).toEqual([216, 241, 255]);
    expect(parseColorToRgb('#eef7ff')).toEqual([238, 247, 255]);
  });

  it('解析 rgb() 形式', () => {
    expect(parseColorToRgb('rgb(120, 200, 255)')).toEqual([120, 200, 255]);
  });

  it('无法解析时返回 null（调用方回退）', () => {
    expect(parseColorToRgb('transparent')).toBeNull();
    expect(parseColorToRgb('')).toBeNull();
  });

  it('hex 分支也能得到明亮辉光色（不再是暗封面原色）', () => {
    const rgb = parseColorToRgb('#d8f1ff');
    expect(rgb).not.toBeNull();
    const [r, g, b] = rgb!;
    expect(Math.min(r, g, b)).toBeGreaterThan(180); // 明亮：不会出现「暗色辉光不可见」
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(60);
  });
});

describe('qualityRankOf（实际档位等级，用于回落判定）', () => {
  it('官方档位 netease-* 映射到对应等级', () => {
    expect(qualityRankOf('netease-jymaster')).toBe(4);
    expect(qualityRankOf('netease-lossless')).toBe(2);
    expect(qualityRankOf('netease-exhigh')).toBe(1);
    expect(qualityRankOf('netease-standard')).toBe(0);
    expect(qualityRankOf('netease-unknown')).toBe(-1);
  });

  it('LX 脚本 lx-* 档位映射', () => {
    expect(qualityRankOf('lx-flac')).toBe(2);
    expect(qualityRankOf('lx-320k')).toBe(1);
    expect(qualityRankOf('lx-128k')).toBe(0);
  });

  it('Unblock 视为最低档；GDMusic 不带码率视为未知；空值未知', () => {
    expect(qualityRankOf('unblock')).toBe(0);
    expect(qualityRankOf('gdmusic-netease')).toBe(-1);
    expect(qualityRankOf('')).toBe(-1);
    expect(qualityRankOf(undefined)).toBe(-1);
  });
});

describe('maybeToastQualityFallback（档位回落提示）', () => {
  it('实际档位低于请求档位时提示回落文案', () => {
    const toast = vi.fn();
    maybeToastQualityFallback(toast, 'hires', 'lx-320k');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain('320kbps');
    expect(toast.mock.calls[0][0]).toContain('高清臻音');
  });

  it('同一回落组合 5 分钟内只提示一次，超过间隔后允许再次提示', () => {
    vi.useFakeTimers();
    const toast = vi.fn();
    const t0 = 1_000_000_000_000;
    vi.setSystemTime(t0);
    maybeToastQualityFallback(toast, 'jymaster', 'lx-flac'); // 首次：提示
    vi.setSystemTime(t0 + 4 * 60_000);
    maybeToastQualityFallback(toast, 'jymaster', 'lx-flac'); // 间隔内：去重
    expect(toast).toHaveBeenCalledTimes(1);
    vi.setSystemTime(t0 + 6 * 60_000);
    maybeToastQualityFallback(toast, 'jymaster', 'lx-flac'); // 超过间隔：再次提示
    expect(toast).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('实际档位不低于请求档位 / 未知来源 / 最低档请求时不提示', () => {
    const toast = vi.fn();
    maybeToastQualityFallback(toast, 'exhigh', 'netease-lossless'); // 反而更高
    maybeToastQualityFallback(toast, 'lossless', 'netease-lossless'); // 同档
    maybeToastQualityFallback(toast, 'exhigh', 'gdmusic-netease'); // 未知来源不判定
    maybeToastQualityFallback(toast, 'standard', 'lx-320k'); // standard 已是最低档
    maybeToastQualityFallback(toast, 'exhigh', undefined); // 无实际档位
    expect(toast).not.toHaveBeenCalled();
  });
});
