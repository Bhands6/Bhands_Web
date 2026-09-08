import { create } from 'zustand';
import { musicApi } from '../api/music';
import { usePlayerStore } from './usePlayerStore';

interface LyricLine {
  time: number;
  text: string;
  words?: { time: number; text: string }[];
}

interface LyricsState {
  lyrics: LyricLine[];
  currentLineIndex: number;
  loading: boolean;
  error: string | null;
  hasLyrics: boolean;
  hasKaraoke: boolean;
  timingSource: 'none' | 'lyric' | 'ttml';
  
  // Actions
  loadLyrics: (songId: string) => Promise<void>;
  setCurrentTime: (time: number) => void;
  clearLyrics: () => void;
  setCurrentLineIndex: (index: number) => void;
}

export const useLyricsStore = create<LyricsState>((set, get) => ({
  lyrics: [],
  currentLineIndex: -1,
  loading: false,
  error: null,
  hasLyrics: false,
  hasKaraoke: false,
  timingSource: 'none',
  
  loadLyrics: async (songId: string) => {
    set({ loading: true, error: null });
    
    try {
      const response = await musicApi.getLyrics(songId);
      
      if (response.success && response.data) {
        const { lrc, tlyric, klyric } = response.data;

        // 解析歌词
        const lyrics = parseLyrics(lrc);
        const hasKaraoke = !!klyric;

        set({
          lyrics,
          loading: false,
          hasLyrics: lyrics.length > 0,
          hasKaraoke,
          timingSource: hasKaraoke ? 'lyric' : (tlyric ? 'ttml' : 'none')
        });
        // 歌词晚到（网络慢 / 会话恢复）时播放进度已就位：
        // 加载完成后立即按当前进度同步行号，否则暂停态下 currentTime 不再变化，行号停在开头
        if (lyrics.length > 0) {
          get().setCurrentTime(usePlayerStore.getState().currentTime);
        }
      } else {
        set({ 
          loading: false, 
          error: response.message || '获取歌词失败',
          hasLyrics: false
        });
      }
    } catch (error) {
      set({ 
        loading: false, 
        error: error instanceof Error ? error.message : '获取歌词失败',
        hasLyrics: false
      });
    }
  },
  
  setCurrentTime: (time: number) => {
    const { lyrics, currentLineIndex } = get();
    
    if (lyrics.length === 0) return;
    
    // 查找当前歌词行
    let newIndex = -1;
    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (lyrics[i].time <= time) {
        newIndex = i;
        break;
      }
    }
    
    if (newIndex !== currentLineIndex) {
      set({ currentLineIndex: newIndex });
    }
  },
  
  clearLyrics: () => {
    set({ 
      lyrics: [], 
      currentLineIndex: -1, 
      hasLyrics: false, 
      hasKaraoke: false,
      timingSource: 'none'
    });
  },
  
  setCurrentLineIndex: (index: number) => {
    set({ currentLineIndex: index });
  }
}));

// 解析歌词
function parseLyrics(lrc: string): LyricLine[] {
  if (!lrc) return [];

  const lines: LyricLine[] = [];
  const lineRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;

  let match;
  while ((match = lineRegex.exec(lrc)) !== null) {
    const minutes = parseInt(match[1]);
    const seconds = parseInt(match[2]);
    const text = match[4].trim();

    if (text) {
      const time = minutes * 60 + seconds + fractionToSeconds(match[3]);

      // 解析卡拉OK歌词
      const words = parseKaraokeWords(text);

      lines.push({
        time,
        text: words.length > 0 ? words.map(w => w.text).join('') : text,
        words: words.length > 0 ? words : undefined
      });
    }
  }

  // 按时间排序
  lines.sort((a, b) => a.time - b.time);

  return lines;
}

/** LRC 时间小数：两位是厘秒(.50=0.5s)，三位是毫秒(.500=0.5s)，按位数归一 */
function fractionToSeconds(frac: string): number {
  return parseInt(frac) / Math.pow(10, frac.length);
}

// 解析卡拉OK歌词
function parseKaraokeWords(text: string): { time: number; text: string }[] {
  const words: { time: number; text: string }[] = [];
  const wordRegex = /\((\d{2}):(\d{2})\.(\d{2,3})\)(.*?)(?=\(\d{2}:\d{2}\.\d{2,3}\)|$)/g;
  
  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const minutes = parseInt(match[1]);
    const seconds = parseInt(match[2]);
    const wordText = match[4];

    if (wordText) {
      const time = minutes * 60 + seconds + fractionToSeconds(match[3]);
      words.push({ time, text: wordText });
    }
  }
  
  return words;
}
