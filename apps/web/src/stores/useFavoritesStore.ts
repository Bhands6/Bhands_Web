import { create } from 'zustand';
import { AudioTrack } from '../audio/AudioEngine';
import { readJson, writeJson } from '../utils/safeStorage';

interface FavoritesState {
  favorites: AudioTrack[];
  
  // Actions
  addToFavorites: (track: AudioTrack) => void;
  removeFromFavorites: (trackId: string) => void;
  isFavorite: (trackId: string) => boolean;
  toggleFavorite: (track: AudioTrack) => void;
  clearFavorites: () => void;
  getFavorites: () => AudioTrack[];
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  // 安全读：坏 JSON 回退空数组（模块顶层裸 parse 曾是整站白屏隐患）
  favorites: readJson<AudioTrack[]>('favorites', []),
  
  addToFavorites: (track: AudioTrack) => {
    const { favorites } = get();
    
    // 检查是否已存在
    if (favorites.some(item => item.id === track.id)) {
      return;
    }
    
    const newFavorites = [track, ...favorites];
    
    set({ favorites: newFavorites });
    writeJson('favorites', newFavorites);
  },

  removeFromFavorites: (trackId: string) => {
    const { favorites } = get();
    const newFavorites = favorites.filter(item => item.id !== trackId);

    set({ favorites: newFavorites });
    writeJson('favorites', newFavorites);
  },
  
  isFavorite: (trackId: string) => {
    const { favorites } = get();
    return favorites.some(item => item.id === trackId);
  },
  
  toggleFavorite: (track: AudioTrack) => {
    const { isFavorite, addToFavorites, removeFromFavorites } = get();
    
    if (isFavorite(track.id)) {
      removeFromFavorites(track.id);
    } else {
      addToFavorites(track);
    }
  },
  
  clearFavorites: () => {
    set({ favorites: [] });
    localStorage.removeItem('favorites');
  },
  
  getFavorites: () => {
    return get().favorites;
  }
}));
