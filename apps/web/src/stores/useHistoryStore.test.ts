import { describe, it, expect, beforeEach } from 'vitest';
import { useHistoryStore } from './useHistoryStore';
import type { AudioTrack } from '../audio/AudioEngine';

const track = (id: string): AudioTrack => ({
  id,
  name: `歌曲${id}`,
  artist: '歌手',
  album: '专辑',
  duration: 200,
  url: '/api/music/stream?url=x',
  cover: ''
});

beforeEach(() => {
  localStorage.clear();
  useHistoryStore.setState({ history: [] });
});

describe('useHistoryStore', () => {
  it('新纪录插到最前并持久化', () => {
    useHistoryStore.getState().addToHistory(track('1'));
    useHistoryStore.getState().addToHistory(track('2'));

    const ids = useHistoryStore.getState().getHistory().map((t) => t.id);
    expect(ids).toEqual(['2', '1']);
    expect(JSON.parse(localStorage.getItem('playHistory')!).map((t: AudioTrack) => t.id)).toEqual(['2', '1']);
  });

  it('重复播放同一首只置顶一次，不产生重复', () => {
    useHistoryStore.getState().addToHistory(track('1'));
    useHistoryStore.getState().addToHistory(track('2'));
    useHistoryStore.getState().addToHistory(track('1'));

    expect(useHistoryStore.getState().getHistory().map((t) => t.id)).toEqual(['1', '2']);
  });

  it('超过上限（100）时淘汰最旧的记录', () => {
    for (let i = 0; i < 105; i++) {
      useHistoryStore.getState().addToHistory(track(String(i)));
    }
    const history = useHistoryStore.getState().getHistory();
    expect(history).toHaveLength(100);
    expect(history[0].id).toBe('104'); // 最新在前
    expect(history[99].id).toBe('5'); // 最早 0~4 被淘汰
  });

  it('removeFromHistory / clearHistory 正确清理', () => {
    useHistoryStore.getState().addToHistory(track('1'));
    useHistoryStore.getState().addToHistory(track('2'));

    useHistoryStore.getState().removeFromHistory('1');
    expect(useHistoryStore.getState().getHistory().map((t) => t.id)).toEqual(['2']);

    useHistoryStore.getState().clearHistory();
    expect(useHistoryStore.getState().getHistory()).toHaveLength(0);
    expect(localStorage.getItem('playHistory')).toBeNull();
  });
});
