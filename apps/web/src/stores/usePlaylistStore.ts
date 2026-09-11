import { create } from 'zustand';
import { musicApi, SongItem } from '../api/music';

/** 请求令牌（模块级）：连点两个歌单时旧慢响应不得写回状态 */
let detailToken = 0;

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
    const token = ++detailToken;
    set({ detailLoading: true, detailError: null, currentPlaylistId: playlistId });

    try {
      const response = await musicApi.getPlaylistDetail(playlistId);
      // 已切到别的歌单：丢弃旧响应 —— 否则 currentPlaylistId 是新的而名称/曲目是旧的，三者错配
      if (token !== detailToken) return [];
      if (response.success && response.data) {
        set({
          currentPlaylistName: response.data.name,
          currentPlaylistTracks: response.data.tracks || [],
          detailLoading: false
        });
        return response.data.tracks || [];
      }
      if (token !== detailToken) return [];
      set({ detailLoading: false, detailError: response.message || '获取歌单失败' });
      return [];
    } catch {
      if (token !== detailToken) return [];
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
