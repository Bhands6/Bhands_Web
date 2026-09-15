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

/** 热门新碟条目（网易云「新碟上架」，游客可用） */
export interface AlbumItem {
  id: string;
  name: string;
  artist: string;
  cover: string;
  size: number;
}

export interface AlbumDetailData {
  id: string;
  name: string;
  cover: string;
  artist: string;
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

  async getSongUrl(id: string, quality = 'exhigh', vip = false, fresh = false): Promise<ApiResponse<SongUrlData>> {
    return apiClient.get(`/music/song/${id}/url`, { params: { quality, vip, ...(fresh ? { fresh: 1 } : {}) } });
  },

  /** 本地脚本一次性解析：脚本存于用户浏览器，随请求带到服务端沙盒执行（不落服务器存储） */
  async resolveWithLocalScript(script: string, id: string, quality = 'exhigh', fresh = false): Promise<ApiResponse<SongUrlData>> {
    return apiClient.post('/music/parse/lx/resolve', { script, id, quality, ...(fresh ? { fresh: 1 } : {}) });
  },

  async getLyrics(id: string): Promise<ApiResponse<LyricsData>> {
    return apiClient.get(`/music/song/${id}/lyric`);
  },

  async getPlaylistDetail(id: string): Promise<ApiResponse<PlaylistDetailData>> {
    return apiClient.get(`/music/playlist/${id}`);
  },

  async getRecommendSongs(): Promise<ApiResponse<SongItem[]>> {
    return apiClient.get('/music/recommend');
  },

  /** 热门新碟（免登录模式的「每日推荐」数据源，游客可用） */
  async getTopAlbums(): Promise<ApiResponse<AlbumItem[]>> {
    return apiClient.get('/music/top/album');
  },

  /** 专辑详情（新碟点开即播，游客可用） */
  async getAlbumDetail(id: string): Promise<ApiResponse<AlbumDetailData>> {
    return apiClient.get(`/music/album/${id}`);
  }
};
