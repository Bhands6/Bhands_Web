import { create } from 'zustand';
import { musicApi, SongItem } from '../api/music';

interface PlaylistState {
  // 当前打开的歌单详情
  detailLoading: boolean;
  detailError: string | null;
  currentPlaylistId: string | null;
  currentPlaylistName: string;
  currentPlaylistTracks: SongItem[];

  loadPlaylistDetail: (playlistId: string) => Promise<SongItem[]>;
  clearCurrentPlaylist: () => void;
}

export const usePlaylistStore = create<PlaylistState>((set) => ({
  detailLoading: false,
  detailError: null,
  currentPlaylistId: null,
  currentPlaylistName: '',
  currentPlaylistTracks: [],

  loadPlaylistDetail: async (playlistId) => {
    set({ detailLoading: true, detailError: null, currentPlaylistId: playlistId });

    try {
      const response = await musicApi.getPlaylistDetail(playlistId);
      if (response.success && response.data) {
        set({
          currentPlaylistName: response.data.name,
          currentPlaylistTracks: response.data.tracks || [],
          detailLoading: false
        });
        return response.data.tracks || [];
      }
      set({ detailLoading: false, detailError: response.message || '获取歌单失败' });
      return [];
    } catch {
      set({ detailLoading: false, detailError: '获取歌单失败' });
      return [];
    }
  },

  clearCurrentPlaylist: () => {
    set({
      currentPlaylistId: null,
      currentPlaylistName: '',
      currentPlaylistTracks: []
    });
  }
}));
