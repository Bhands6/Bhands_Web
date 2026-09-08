import { describe, it, expect, beforeEach } from 'vitest';
import { useFavoritesStore } from './useFavoritesStore';
import type { AudioTrack } from '../audio/AudioEngine';

const track = (id: string): AudioTrack => ({
  id,
  name: `歌曲${id}`,
  artist: '歌手',
  album: '专辑',
  duration: 200,
  url: '',
  cover: ''
});

beforeEach(() => {
  localStorage.clear();
  useFavoritesStore.setState({ favorites: [] });
});

describe('useFavoritesStore', () => {
  it('添加收藏并持久化到 localStorage', () => {
    useFavoritesStore.getState().addToFavorites(track('1'));

    expect(useFavoritesStore.getState().isFavorite('1')).toBe(true);
    expect(JSON.parse(localStorage.getItem('favorites')!)).toHaveLength(1);
  });

  it('重复添加同一首不产生重复项', () => {
    useFavoritesStore.getState().addToFavorites(track('1'));
    useFavoritesStore.getState().addToFavorites(track('1'));

    expect(useFavoritesStore.getState().getFavorites()).toHaveLength(1);
  });

  it('toggleFavorite 在收藏/取消之间切换', () => {
    const store = useFavoritesStore.getState();
    store.toggleFavorite(track('1'));
    expect(useFavoritesStore.getState().isFavorite('1')).toBe(true);

    useFavoritesStore.getState().toggleFavorite(track('1'));
    expect(useFavoritesStore.getState().isFavorite('1')).toBe(false);
    expect(localStorage.getItem('favorites')).toBe('[]');
  });

  it('removeFromFavorites / clearFavorites 同步清理持久化数据', () => {
    useFavoritesStore.getState().addToFavorites(track('1'));
    useFavoritesStore.getState().addToFavorites(track('2'));

    useFavoritesStore.getState().removeFromFavorites('1');
    expect(useFavoritesStore.getState().getFavorites().map((t) => t.id)).toEqual(['2']);

    useFavoritesStore.getState().clearFavorites();
    expect(useFavoritesStore.getState().getFavorites()).toHaveLength(0);
    expect(localStorage.getItem('favorites')).toBeNull();
  });
});
