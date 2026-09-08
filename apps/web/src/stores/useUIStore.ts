import { create } from 'zustand';

export type PlayQuality = 'jymaster' | 'hires' | 'lossless' | 'exhigh' | 'standard';

/** 歌词显示模式：多行 / 单行 / 隐藏 */
export type LyricMode = 'multi' | 'single' | 'hidden';

export const LYRIC_MODE_LABELS: Record<LyricMode, string> = {
  multi: '多行歌词',
  single: '单行歌词',
  hidden: '隐藏歌词'
};

export const QUALITY_LABELS: Record<PlayQuality, string> = {
  jymaster: '超清母带',
  hires: '高清臻音',
  lossless: '无损 SQ',
  exhigh: '极高 HQ',
  standard: '标准'
};

interface UIState {
  // 启动页
  splashActive: boolean;
  splashRevealing: boolean;
  dismissSplash: () => void;

  // Home 视图开关（独立于播放状态：点空白处收起进舞台，点 Home 按钮展开）
  homeVisible: boolean;
  setHomeVisible: (visible: boolean) => void;

  // 面板
  queuePanelOpen: boolean;      // 底部队列按钮切换（常驻）
  queuePanelPeek: boolean;      // 左边缘悬停临时显示
  queuePanelPinned: boolean;
  queueTab: 'queue' | 'playlists';
  setQueuePanelOpen: (open: boolean) => void;
  setQueuePanelPeek: (peek: boolean) => void;
  toggleQueuePanelPinned: () => void;
  setQueueTab: (tab: 'queue' | 'playlists') => void;

  // 登录
  loginModalOpen: boolean;
  setLoginModalOpen: (open: boolean) => void;

  // 歌词显示模式：multi 多行 / single 单行 / hidden 隐藏
  lyricMode: LyricMode;
  lyricsVisible: boolean;
  toggleLyrics: () => void;
  setLyricMode: (mode: LyricMode) => void;
  cycleLyricMode: () => void;

  // 沉浸模式
  immersive: boolean;
  toggleImmersive: () => void;

  // 控制条自动隐藏
  controlsAutoHide: boolean;
  controlsHidden: boolean;
  toggleControlsAutoHide: () => void;
  setControlsHidden: (hidden: boolean) => void;

  // 播放音质
  quality: PlayQuality;
  setQuality: (q: PlayQuality) => void;

  // 搜索面板
  searchMode: 'song' | 'netease';
  setSearchMode: (m: 'song' | 'netease') => void;

  // Toast
  toastMessage: string;
  toastVisible: boolean;
  showToast: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 持久化偏好（音质/自动隐藏随设置保留，对应桌面版 localStorage 偏好键） */
const QUALITY_STORE_KEY = 'bhandsmusic-playback-quality-v1';
const CONTROLS_AUTO_HIDE_STORE_KEY = 'bhandsmusic-controls-auto-hide-v1';

const QUALITY_VALUES: PlayQuality[] = ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'];
function readPersistedQuality(): PlayQuality {
  const saved = localStorage.getItem(QUALITY_STORE_KEY) as PlayQuality | null;
  return saved && QUALITY_VALUES.includes(saved) ? saved : 'exhigh';
}
function readPersistedAutoHide(): boolean {
  // 默认开启「底部悬停唤起 / 离开收缩」；仅当用户显式关闭过才读取持久化值
  const saved = localStorage.getItem(CONTROLS_AUTO_HIDE_STORE_KEY);
  return saved === null ? true : saved === '1';
}

const LYRIC_MODE_STORE_KEY = 'bhandsmusic-lyric-mode-v1';
function readPersistedLyricMode(): LyricMode {
  const saved = localStorage.getItem(LYRIC_MODE_STORE_KEY);
  if (saved === 'single' || saved === 'hidden' || saved === 'multi') return saved;
  // 旧版「隐藏歌词」开关迁移
  if (localStorage.getItem('bhandsmusic-lyrics-visible') === '0') return 'hidden';
  return 'multi';
}

export const useUIStore = create<UIState>((set, get) => ({
  splashActive: true,
  splashRevealing: false,

  dismissSplash: () => {
    if (!get().splashActive || get().splashRevealing) return;
    set({ splashRevealing: true });
    // 与桌面版一致：先 reveal 再彻底收起启动页
    setTimeout(() => set({ splashActive: false, splashRevealing: false }), 1600);
  },

  queuePanelOpen: false,
  queuePanelPeek: false,
  queuePanelPinned: false,
  queueTab: 'queue',

  homeVisible: true,
  setHomeVisible: (visible) => set({ homeVisible: visible }),
  setQueuePanelOpen: (open) => set({ queuePanelOpen: open }),
  setQueuePanelPeek: (peek) => set({ queuePanelPeek: peek }),
  toggleQueuePanelPinned: () => set((s) => ({ queuePanelPinned: !s.queuePanelPinned })),
  setQueueTab: (tab) => set({ queueTab: tab }),

  loginModalOpen: false,
  setLoginModalOpen: (open) => set({ loginModalOpen: open }),

  lyricMode: readPersistedLyricMode(),
  lyricsVisible: true,
  toggleLyrics: () =>
    set((s) => ({ lyricMode: s.lyricMode === 'hidden' ? 'multi' : 'hidden' })),
  setLyricMode: (mode) => {
    localStorage.setItem(LYRIC_MODE_STORE_KEY, mode);
    set({ lyricMode: mode });
  },
  cycleLyricMode: () => {
    const order: LyricMode[] = ['multi', 'single', 'hidden'];
    const next = order[(order.indexOf(get().lyricMode) + 1) % order.length];
    localStorage.setItem(LYRIC_MODE_STORE_KEY, next);
    set({ lyricMode: next, lyricsVisible: next !== 'hidden' });
  },

  immersive: false,
  toggleImmersive: () => set((s) => ({ immersive: !s.immersive })),

  controlsAutoHide: readPersistedAutoHide(),
  controlsHidden: false,
  toggleControlsAutoHide: () => {
    const next = !get().controlsAutoHide;
    localStorage.setItem(CONTROLS_AUTO_HIDE_STORE_KEY, next ? '1' : '0');
    set({ controlsAutoHide: next });
  },
  setControlsHidden: (hidden) => set({ controlsHidden: hidden }),

  quality: readPersistedQuality(),
  setQuality: (q) => {
    localStorage.setItem(QUALITY_STORE_KEY, q);
    set({ quality: q });
  },

  searchMode: 'song',
  setSearchMode: (m) => set({ searchMode: m }),

  toastMessage: '',
  toastVisible: false,
  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toastMessage: msg, toastVisible: true });
    toastTimer = setTimeout(() => set({ toastVisible: false }), 2600);
  }
}));
