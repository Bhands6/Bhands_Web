import { create } from 'zustand';
import { AudioTrack } from '../audio/AudioEngine';
import { readJson, writeJson } from '../utils/safeStorage';

interface HistoryState {
  history: AudioTrack[];
  maxHistory: number;
  
  // Actions
  addToHistory: (track: AudioTrack) => void;
  removeFromHistory: (trackId: string) => void;
  clearHistory: () => void;
  getHistory: () => AudioTrack[];
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  // 安全读：坏 JSON 回退空数组（模块顶层裸 parse 曾是整站白屏隐患）
  history: readJson<AudioTrack[]>('playHistory', []),
  maxHistory: 100,
  
  addToHistory: (track: AudioTrack) => {
    const { history, maxHistory } = get();
    
    // 移除重复项
    const filteredHistory = history.filter(item => item.id !== track.id);
    
    // 添加到开头
    const newHistory = [track, ...filteredHistory].slice(0, maxHistory);
    
    set({ history: newHistory });
    writeJson('playHistory', newHistory);
  },

  removeFromHistory: (trackId: string) => {
    const { history } = get();
    const newHistory = history.filter(item => item.id !== trackId);

    set({ history: newHistory });
    writeJson('playHistory', newHistory);
  },
  
  clearHistory: () => {
    set({ history: [] });
    localStorage.removeItem('playHistory');
  },
  
  getHistory: () => {
    return get().history;
  }
}));
