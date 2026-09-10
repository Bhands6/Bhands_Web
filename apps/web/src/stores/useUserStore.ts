import { create } from 'zustand';
import { userApi, UserInfo, UserPlaylistItem } from '../api/user';
import { usePlayerStore } from './usePlayerStore';
import { useLyricsStore } from './useLyricsStore';
import { useSearchStore } from './useSearchStore';
import { usePlaylistStore } from './usePlaylistStore';
import { useSettingsStore } from './useSettingsStore';
import { useUIStore } from './useUIStore';
import { useHistoryStore } from './useHistoryStore';
import { useFavoritesStore } from './useFavoritesStore';

interface UserState {
  user: UserInfo | null;
  loggedIn: boolean;
  playlists: UserPlaylistItem[];
  playlistsLoading: boolean;

  init: () => Promise<void>;
  loginWithQR: () => Promise<boolean>;
  loginSuccess: (user: UserInfo | null) => void;
  logout: () => Promise<void>;
  refreshPlaylists: () => Promise<void>;
}

export const useUserStore = create<UserState>((set) => ({
  user: null,
  loggedIn: false,
  playlists: [],
  playlistsLoading: false,

  init: async () => {
    try {
      const response = await userApi.getStatus();
      if (response.success && response.data?.loggedIn) {
        set({ user: response.data.user, loggedIn: true });
        useUserStore.getState().refreshPlaylists();
      }
    } catch {
      // 后端不可达时静默，界面按未登录处理
    }
  },

  loginWithQR: async () => {
    try {
      const createRes = await userApi.createQr();
      if (!createRes.success || !createRes.data?.key) return false;
      const { key } = createRes.data;

      // 轮询扫码状态，最多约 3 分钟
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        let check;
        try {
          check = await userApi.checkQr(key);
        } catch {
          continue;
        }
        if (!check.success) continue;
        const { code, user } = check.data;
        if (code === 803 && user) {
          set({ user, loggedIn: true });
          useUserStore.getState().refreshPlaylists();
          return true;
        }
        if (code === 800) return false; // 二维码过期
      }
      return false;
    } catch {
      return false;
    }
  },

  // 扫码成功后由 LoginModal 调用（组件内自行轮询以展示扫码状态）
  // user 为 null 时（后端 login_status 偶发失败）也承认登录：后端 cookie 已生效，
  // 后续异步补拉真实用户信息
  loginSuccess: (user: UserInfo | null) => {
    set({
      user: user || { userId: '', nickname: '我', avatar: '', vip: false },
      loggedIn: true
    });
    useUserStore.getState().refreshPlaylists();
    if (!user) {
      userApi
        .getStatus()
        .then((r) => {
          if (r.success && r.data?.user) set({ user: r.data.user });
        })
        .catch(() => {});
    }
  },

  logout: async () => {
    try {
      await userApi.logout();
    } finally {
      // 停止播放、清空队列与会话快照
      usePlayerStore.getState().clearPlaylist();
      // 清空歌词
      useLyricsStore.getState().clearLyrics();
      // 清空搜索结果
      useSearchStore.getState().clearResults();
      // 清空歌单详情
      usePlaylistStore.getState().clearCurrentPlaylist();
      // 清空播放历史
      useHistoryStore.getState().clearHistory();
      // 清空收藏
      useFavoritesStore.getState().clearFavorites();
      // 重置视觉设置为默认值（恢复首次加载的粒子样式）
      useSettingsStore.getState().resetAll();
      useUIStore.setState({
        homeVisible: true,
        queuePanelOpen: false,
        queuePanelPeek: false,
        queuePanelPinned: false,
        queuePanelAwaitHover: false,
        queueTab: 'queue',
        loginModalOpen: false,
        immersive: false,
        controlsHidden: false,
        lyricsVisible: true,
      });
      document.body.classList.remove('immersive-mode','controls-visible','beat-pulse');
      set({ user: null, loggedIn: false, playlists: [] });
    }
  },

  refreshPlaylists: async () => {
    set({ playlistsLoading: true });
    try {
      const response = await userApi.getPlaylists();
      if (response.success) {
        set({ playlists: response.data || [], playlistsLoading: false });
        return;
      }
    } catch {
      // ignore
    }
    set({ playlistsLoading: false });
  }
}));
