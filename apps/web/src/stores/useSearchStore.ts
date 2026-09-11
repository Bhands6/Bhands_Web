import { create } from 'zustand';
import { musicApi, SongItem } from '../api/music';
import { readJson, writeJson } from '../utils/safeStorage';

interface SearchState {
  query: string;
  results: SongItem[];
  loading: boolean;
  error: string | null;
  searchHistory: string[];

  setQuery: (query: string) => void;
  search: (query: string) => Promise<void>;
  clearResults: () => void;
  addToHistory: (query: string) => void;
  clearHistory: () => void;
}

/** 请求令牌（模块级）：每次 search 递增，过期响应直接丢弃 */
let searchToken = 0;

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  loading: false,
  error: null,
  // 安全读：坏 JSON 回退空数组（模块顶层裸 parse 曾是整站白屏隐患）
  searchHistory: readJson<string[]>('searchHistory', []),

  setQuery: (query) => set({ query }),

  // 请求令牌：快速连搜时旧慢响应不得覆盖新结果、也不得提前清掉 loading
  // （useLyricsStore 的 lyricsLoadToken 同款做法）
  search: async (query) => {
    const kw = query.trim();
    if (!kw) return;
    const token = ++searchToken;

    set({ query: kw, loading: true, error: null, results: [] });

    try {
      const response = await musicApi.search(kw, 30);
      if (token !== searchToken) return; // 已被更新的一次搜索取代
      if (response.success) {
        set({ results: response.data || [], loading: false });
        get().addToHistory(kw);
      } else {
        set({ loading: false, error: response.message || '搜索失败' });
      }
    } catch {
      if (token !== searchToken) return;
      set({ loading: false, error: '搜索失败，请检查网络或后端服务' });
    }
  },

  clearResults: () => set({ results: [], error: null }),

  addToHistory: (query) => {
    const newHistory = [query, ...get().searchHistory.filter((item) => item !== query)].slice(0, 10);
    set({ searchHistory: newHistory });
    writeJson('searchHistory', newHistory);
  },

  clearHistory: () => {
    set({ searchHistory: [] });
    localStorage.removeItem('searchHistory');
  }
}));
