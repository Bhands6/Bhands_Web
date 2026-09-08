import { create } from 'zustand';
import { musicApi, SongItem } from '../api/music';

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

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  loading: false,
  error: null,
  searchHistory: JSON.parse(localStorage.getItem('searchHistory') || '[]'),

  setQuery: (query) => set({ query }),

  search: async (query) => {
    const kw = query.trim();
    if (!kw) return;

    set({ query: kw, loading: true, error: null, results: [] });

    try {
      const response = await musicApi.search(kw, 30);
      if (response.success) {
        set({ results: response.data || [], loading: false });
        get().addToHistory(kw);
      } else {
        set({ loading: false, error: response.message || '搜索失败' });
      }
    } catch {
      set({ loading: false, error: '搜索失败，请检查网络或后端服务' });
    }
  },

  clearResults: () => set({ results: [], error: null }),

  addToHistory: (query) => {
    const newHistory = [query, ...get().searchHistory.filter((item) => item !== query)].slice(0, 10);
    set({ searchHistory: newHistory });
    localStorage.setItem('searchHistory', JSON.stringify(newHistory));
  },

  clearHistory: () => {
    set({ searchHistory: [] });
    localStorage.removeItem('searchHistory');
  }
}));
