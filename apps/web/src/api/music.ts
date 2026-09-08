import apiClient from './client';

export interface SongItem {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
  source?: string;
}

export interface SongUrlData {
  url: string;
  quality: string;
  trial?: boolean;
  size?: number;
}

export interface LyricsData {
  lrc: string;
  tlyric: string;
  klyric: string;
}

export interface PlaylistDetailData {
  id: string;
  name: string;
  cover: string;
  trackCount: number;
  tracks: SongItem[];
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export const musicApi = {
  async search(keyword: string, limit = 30): Promise<ApiResponse<SongItem[]>> {
    return apiClient.get('/music/search', { params: { keyword, limit } });
  },

  async getSongUrl(id: string, quality = 'exhigh'): Promise<ApiResponse<SongUrlData>> {
    return apiClient.get(`/music/song/${id}/url`, { params: { quality } });
  },

  async getLyrics(id: string): Promise<ApiResponse<LyricsData>> {
    return apiClient.get(`/music/song/${id}/lyric`);
  },

  async getPlaylistDetail(id: string): Promise<ApiResponse<PlaylistDetailData>> {
    return apiClient.get(`/music/playlist/${id}`);
  },

  async getRecommendSongs(): Promise<ApiResponse<SongItem[]>> {
    return apiClient.get('/music/recommend');
  }
};
