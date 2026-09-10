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
  useUIStore: { getState: () => ({ quality: 'exhigh', showToast: vi.fn() }) }
}));
vi.mock('../audio/beatClock', () => ({ beatClock: { setTrack: vi.fn(), setMap: vi.fn() } }));
vi.mock('../audio/beatAnalyzer', () => ({ analyzeTrackBeatMap: vi.fn() }));

const { parseColorToRgb } = await import('./playService');

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
