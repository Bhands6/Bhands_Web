import apiClient from './client';

export interface UserInfo {
  userId: string;
  nickname: string;
  avatar: string;
  vip: boolean;
  vipType?: number;
}

export interface UserPlaylistItem {
  id: string;
  name: string;
  cover: string;
  trackCount: number;
  playCount?: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface QrCheckData {
  code: number; // 800 过期 / 801 等待 / 802 已扫码 / 803 成功
  message: string;
  user?: UserInfo;
}

export const userApi = {
  async createQr(): Promise<ApiResponse<{ key: string; qrimg: string }>> {
    return apiClient.get('/user/qr/create');
  },

  async checkQr(key: string): Promise<ApiResponse<QrCheckData>> {
    return apiClient.get('/user/qr/check', { params: { key } });
  },

  async getStatus(): Promise<ApiResponse<{ loggedIn: boolean; user: UserInfo | null }>> {
    return apiClient.get('/user/status');
  },

  async getPlaylists(): Promise<ApiResponse<UserPlaylistItem[]>> {
    return apiClient.get('/user/playlists');
  },

  async logout(): Promise<ApiResponse<null>> {
    return apiClient.post('/user/logout');
  }
};
