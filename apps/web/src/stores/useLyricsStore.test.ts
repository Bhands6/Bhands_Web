import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useLyricsStore } from './useLyricsStore';
import { musicApi } from '../api/music';

vi.mock('../api/music', () => ({
  musicApi: { getLyrics: vi.fn() }
}));

const mockedGetLyrics = vi.mocked(musicApi.getLyrics);

const LRC = [
  '[00:10.00]第二句', // 时间靠后，应排到后面
  '[00:05.00]第一句',
  '[00:05.00]', // 空行，应被过滤
  '没有时间戳的行', // 不匹配，应被忽略
  '[01:02.50]第三句'
].join('\n');

beforeEach(() => {
  mockedGetLyrics.mockReset();
  useLyricsStore.getState().clearLyrics();
  localStorage.clear();
});

describe('useLyricsStore 歌词解析', () => {
  it('解析 LRC 时间轴、过滤空行并按时间排序', async () => {
    mockedGetLyrics.mockResolvedValue({
      success: true,
      data: { lrc: LRC, tlyric: '', klyric: '' }
    });

    await useLyricsStore.getState().loadLyrics('song-1');

    const { lyrics, hasLyrics } = useLyricsStore.getState();
    expect(hasLyrics).toBe(true);
    expect(lyrics.map((l) => l.text)).toEqual(['第一句', '第二句', '第三句']);
    expect(lyrics[0].time).toBe(5);
    expect(lyrics[2].time).toBe(62.5);
  });

  it('接口失败时写入错误且不产生歌词', async () => {
    mockedGetLyrics.mockRejectedValue(new Error('network'));

    await useLyricsStore.getState().loadLyrics('song-2');

    const state = useLyricsStore.getState();
    expect(state.error).toBe('network');
    expect(state.hasLyrics).toBe(false);
    expect(state.lyrics).toHaveLength(0);
  });
});

describe('useLyricsStore 当前行定位', () => {
  beforeEach(async () => {
    mockedGetLyrics.mockResolvedValue({
      success: true,
      data: { lrc: LRC, tlyric: '', klyric: '' }
    });
    await useLyricsStore.getState().loadLyrics('song-1');
  });

  it('按播放时间定位到不晚于当前时间的最后一行', () => {
    const store = useLyricsStore.getState();
    store.setCurrentTime(70); // 70s 落在 62.5s（第三句）之后
    expect(useLyricsStore.getState().currentLineIndex).toBe(2);

    useLyricsStore.getState().setCurrentTime(6); // 6s 落在第一句内
    expect(useLyricsStore.getState().currentLineIndex).toBe(0);
  });

  it('早于首行时无高亮行', () => {
    useLyricsStore.getState().setCurrentTime(1);
    expect(useLyricsStore.getState().currentLineIndex).toBe(-1);
  });
});
