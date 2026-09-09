import { create } from 'zustand';
import { audioEngine } from '../audio/AudioEngine';
import type { AudioTrack, AudioState, AudioAnalyserData } from '../audio/AudioEngine';

interface PlayerState {
  // 播放状态
  currentTrack: AudioTrack | null;
  isPlaying: boolean;
  playingQuality: string;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  loading: boolean;
  error: string | null;
  
  // 播放列表
  playlist: AudioTrack[];
  currentIndex: number;
  playMode: 'sequence' | 'loop' | 'shuffle';
  
  // 音频分析数据
  analyserData: AudioAnalyserData | null;

  // 切歌委托：由 playService 注册，负责 URL 解析后真正播放
  // （store 不能反向 import playService，否则循环依赖）
  playIndexDelegate: ((index: number) => void) | null;
  setPlayIndexDelegate: (fn: ((index: number) => void) | null) => void;
  
  // Actions
  setCurrentTrack: (track: AudioTrack, opts?: { autoplay?: boolean }) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  playAtIndex: (index: number) => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  setPlaylist: (playlist: AudioTrack[]) => void;
  setCurrentIndex: (index: number) => void;
  setPlayMode: (mode: 'sequence' | 'loop' | 'shuffle') => void;
  clearPlaylist: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  // 初始状态
  currentTrack: null,
  isPlaying: false,
  playingQuality: '',
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  loading: false,
  error: null,
  playlist: [],
  currentIndex: -1,
  playMode: 'sequence',
  analyserData: null,
  playIndexDelegate: null,
  setPlayIndexDelegate: (fn) => set({ playIndexDelegate: fn }),
  
  // 设置当前曲目
  setCurrentTrack: async (track: AudioTrack, opts?: { autoplay?: boolean }) => {
    try {
      set({ loading: true, error: null });
      await audioEngine.loadTrack(track);
      set({
        currentTrack: track,
        loading: false,
        duration: audioEngine.getDuration()
      });
      // autoplay:false 供会话恢复使用：只加载不播放
      if (opts?.autoplay !== false) audioEngine.play();
    } catch (error) {
      set({ 
        loading: false, 
        error: error instanceof Error ? error.message : 'Failed to load track' 
      });
      // 向上抛出，让调用方（playService）感知失败并提示用户
      throw error;
    }
  },
  
  // 播放
  play: () => {
    audioEngine.play();
  },
  
  // 暂停
  pause: () => {
    audioEngine.pause();
  },
  
  // 切换播放/暂停
  togglePlay: () => {
    audioEngine.togglePlay();
  },
  
  // 按索引播放（经 playService 解析地址后播放）
  playAtIndex: (index) => {
    const { playlist, playIndexDelegate } = get();
    if (index < 0 || index >= playlist.length) return;
    if (playIndexDelegate) {
      playIndexDelegate(index);
    } else {
      // 委托未注册时兜底（本地曲目已带 url）
      set({ currentIndex: index });
      get().setCurrentTrack(playlist[index]).catch(() => {
        // 错误状态已由 setCurrentTrack 写入 store
      });
    }
  },
  
  // 下一首
  nextTrack: () => {
    const { playlist, currentIndex, playMode } = get();
    if (playlist.length === 0) return;
    
    let nextIndex: number;
    
    switch (playMode) {
      case 'loop':
        nextIndex = currentIndex;
        break;
      case 'shuffle':
        nextIndex = playlist.length > 1
          ? (currentIndex + 1 + Math.floor(Math.random() * (playlist.length - 1))) % playlist.length
          : 0;
        break;
      case 'sequence':
      default:
        nextIndex = (currentIndex + 1) % playlist.length;
        break;
    }
    
    get().playAtIndex(nextIndex);
  },
  
  // 上一首
  prevTrack: () => {
    const { playlist, currentIndex, playMode, currentTime } = get();
    if (playlist.length === 0) return;

    // 播放超过 3 秒时回到本曲开头（常见播放器行为）
    if (currentTime > 3) {
      get().seek(0);
      return;
    }
    
    let prevIndex: number;
    
    switch (playMode) {
      case 'loop':
        prevIndex = currentIndex;
        break;
      case 'shuffle':
        prevIndex = Math.floor(Math.random() * playlist.length);
        if (prevIndex === currentIndex) prevIndex = (prevIndex + 1) % playlist.length;
        break;
      case 'sequence':
      default:
        prevIndex = currentIndex <= 0 ? playlist.length - 1 : currentIndex - 1;
        break;
    }
    
    get().playAtIndex(prevIndex);
  },
  
  // 跳转
  seek: (time: number) => {
    audioEngine.seek(time);
  },
  
  // 设置音量
  setVolume: (volume: number) => {
    audioEngine.setVolume(volume);
    set({ volume });
  },
  
  // 设置静音
  setMuted: (muted: boolean) => {
    audioEngine.setMuted(muted);
    set({ muted });
  },
  
  // 切换静音
  toggleMuted: () => {
    const { muted } = get();
    audioEngine.setMuted(!muted);
    set({ muted: !muted });
  },
  
  // 设置播放列表
  setPlaylist: (playlist: AudioTrack[]) => {
    set({ playlist });
  },
  
  // 设置当前索引
  setCurrentIndex: (index: number) => {
    set({ currentIndex: index });
  },
  
  // 设置播放模式
  setPlayMode: (mode: 'sequence' | 'loop' | 'shuffle') => {
    set({ playMode: mode });
  },
  
  // 清空播放列表（显式清除会话快照：saveSessionSnapshot 对空队列只跳过不清除）
  clearPlaylist: () => {
    set({
      playlist: [],
      currentIndex: -1,
      currentTrack: null,
      isPlaying: false,
      playingQuality: '',
      currentTime: 0,
      duration: 0
    });
    audioEngine.pause();
    sessionStorage.removeItem(SESSION_KEY);
  }
}));

// 初始化音频引擎回调
audioEngine.setOnStateChange((state: AudioState) => {
  usePlayerStore.setState({
    isPlaying: state.isPlaying,
    currentTime: state.currentTime,
    duration: state.duration,
    volume: state.volume,
    muted: state.muted,
    loading: state.loading,
    error: state.error
  });
});

audioEngine.setOnAnalyserData((data: AudioAnalyserData) => {
  usePlayerStore.setState({ analyserData: data });
});

audioEngine.setOnTrackEnd(() => {
  const { nextTrack } = usePlayerStore.getState();
  nextTrack();
});

// ============================================================
//  会话快照：刷新页面保留播放现场（队列/当前曲目/进度），
//  关闭标签页自动清除（sessionStorage 语义，正好匹配需求）
// ============================================================
const SESSION_KEY = 'bhandsmusic-session-v1';

export interface SessionSnapshot {
  playlist: AudioTrack[];
  currentIndex: number;
  currentTime: number;
  playMode: 'sequence' | 'loop' | 'shuffle';
  volume: number;
  muted: boolean;
}

/** 读取上次会话快照（无数据/脏数据返回 null） */
export function readSessionSnapshot(): SessionSnapshot | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as SessionSnapshot;
    if (!Array.isArray(snap.playlist) || !snap.playlist.length) return null;
    if (typeof snap.currentIndex !== 'number' || snap.currentIndex < 0 || snap.currentIndex >= snap.playlist.length) return null;
    return snap;
  } catch {
    return null;
  }
}

/** 保存快照（默认 1.2s 节流：store 高频更新由 analyser/timeupdate 驱动；force 跳过节流）
 *  注意：空队列时只跳过不清除 —— 清除仅由 clearPlaylist 显式触发，
 *  避免「恢复时 setPlaylist 先于 setCurrentIndex 触发订阅（此刻 index=-1）」误删待恢复的数据 */
let lastSnapshotAt = 0;
function saveSessionSnapshot(force = false) {
  const { playlist, currentIndex, playMode, volume, muted } = usePlayerStore.getState();
  if (!playlist.length || currentIndex < 0) return;
  const now = performance.now();
  if (!force && lastSnapshotAt > 0 && now - lastSnapshotAt < 1200) return;
  lastSnapshotAt = now;
  try {
    // blob: 是本地导入的临时地址，刷新后失效 → 存盘时清空，恢复后播放时重新解析
    const persistable = playlist.map((t) =>
      t.url && t.url.startsWith('blob:') ? { ...t, url: '' } : t
    );
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      playlist: persistable,
      currentIndex,
      currentTime: audioEngine.getCurrentTime(),
      playMode,
      volume,
      muted
    }));
  } catch {
    // sessionStorage 容量满等异常：静默放弃
  }
}

/** 立即落盘（跳过节流）：页面隐藏/刷新前、会话恢复完成后调用 */
export function flushSessionSnapshot() {
  saveSessionSnapshot(true);
}

usePlayerStore.subscribe(() => saveSessionSnapshot());
// 刷新/关闭前抢救最新进度（pagehide 在 F5 时必触发，比 beforeunload 可靠）
window.addEventListener('pagehide', flushSessionSnapshot);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSessionSnapshot();
});
