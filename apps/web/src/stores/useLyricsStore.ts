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

/** loadLyrics 竞态令牌：只有最新一次请求允许写入 store */
let lyricsLoadToken = 0;

export const useLyricsStore = create<LyricsState>((set, get) => ({
  lyrics: [],
  currentLineIndex: -1,
  loading: false,
  error: null,
  hasLyrics: false,
  hasKaraoke: false,
  timingSource: 'none',
  
  loadLyrics: async (songId: string) => {
    // 竞态守卫：切歌是异步的，快速连点会让旧请求后返回并覆盖新歌歌词
    const token = ++lyricsLoadToken;
    set({ loading: true, error: null });
    
    try {
      const response = await musicApi.getLyrics(songId);
      if (token !== lyricsLoadToken) return; // 已被更新的请求取代，丢弃过期结果

      if (response.success && response.data) {
        const { lrc, tlyric, klyric } = response.data;

        // 解析歌词：优先 LRC 时间轴；部分歌曲网易云不返回 LRC（lrc 为空）而只有
        // YRC 逐字歌词（klyric），此时用 YRC 兜底，否则表现为「这首歌没有歌词」。
        let lyrics = parseLyrics(lrc);
        const usedYrc = lyrics.length === 0 && !!klyric;
        if (usedYrc) lyrics = parseYrc(klyric);
        const hasKaraoke = !!klyric;

        set({
          lyrics,
          loading: false,
          hasLyrics: lyrics.length > 0,
          hasKaraoke,
          timingSource: usedYrc || hasKaraoke ? 'lyric' : (tlyric ? 'ttml' : 'none')
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
      if (token !== lyricsLoadToken) return;
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
    // 使在途请求失效：清空后旧响应不得再把歌词写回来
    lyricsLoadToken++;
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

/**
 * 解析 LRC —— 对应桌面版 parseLyricText。
 *
 * 关键点（Web 版早期实现遗漏，导致「重复段落」歌词丢失/错位）：
 *  - 一行可能带**多个**时间标签（`[01:23.45][03:45.67]副歌`），必须全部收集并展开成多条，
 *    而不是只取第一个标签、把其余标签留在正文里；
 *  - 时间标签的小数部分可选（`[00:12]`），位数 1~3 均可（厘秒/毫秒按位数归一）；
 *  - 分钟/秒允许 1~2 位（`[1:23.45]`）。
 */
export function parseLyrics(lrc: string): LyricLine[] {
  if (!lrc) return [];

  const tagRegex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const lines: LyricLine[] = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    tagRegex.lastIndex = 0;
    const times: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(rawLine)) !== null) {
      times.push(tagToSeconds(match[1], match[2], match[3]));
    }
    if (!times.length) continue;

    // 剔除行内全部时间标签后的正文（多标签重复行只保留一份正文）
    const text = rawLine.replace(tagRegex, '').trim();
    if (!text) continue;

    // 解析卡拉OK歌词（无逐字标签时为空数组）
    const words = parseKaraokeWords(text);
    const bodyText = words.length > 0 ? words.map((w) => w.text).join('') : text;

    // 每个时间标签各生成一条（重复段落按各自时间点分别命中）
    for (const time of times) {
      lines.push({
        time,
        text: bodyText,
        words: words.length > 0 ? words : undefined
      });
    }
  }

  // 按时间排序
  lines.sort((a, b) => a.time - b.time);

  return lines;
}

/**
 * 解析 YRC（网易云逐字歌词，对应 `klyric` 字段）—— 对应桌面版 parseYrcText。
 * 行格式：`[行起始ms,行时长ms](词起始ms,词时长ms,0)词 ...`
 * 逐字起始时间可能是绝对毫秒或相对行首的毫秒（与行首相差过大时按相对值处理）。
 * 仅在 LRC 时间轴缺失时作为兜底，保证「有歌词的歌都能显示」。
 */
export function parseYrc(text: string): LyricLine[] {
  if (!text) return [];
  const lines: LyricLine[] = [];
  const wordRegex = /\((\d+),(\d+),\d+\)([^()]*)/g;

  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) continue;
    const lineStartMs = parseInt(m[1], 10) || 0;
    const body = m[3] || '';

    wordRegex.lastIndex = 0;
    const words: { time: number; text: string }[] = [];
    let wm: RegExpExecArray | null;
    while ((wm = wordRegex.exec(body)) !== null) {
      const txt = (wm[3] || '').replace(/\s+/g, ' ');
      if (!txt) continue;
      const rawStart = parseInt(wm[1], 10) || 0;
      const absStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;
      words.push({ time: absStartMs / 1000, text: txt });
    }

    const plain = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    const lineText = (words.length ? words.map((w) => w.text).join('') : plain).trim();
    if (!lineText) continue;

    lines.push({
      time: lineStartMs / 1000,
      text: lineText,
      words: words.length ? words : undefined
    });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** LRC 时间小数：两位是厘秒(.50=0.5s)，三位是毫秒(.500=0.5s)，按位数归一 */
function fractionToSeconds(frac?: string): number {
  if (!frac) return 0;
  return parseInt(frac, 10) / Math.pow(10, frac.length);
}

/** [mm, ss, frac] → 秒 */
function tagToSeconds(minutes: string, seconds: string, frac?: string): number {
  return parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + fractionToSeconds(frac);
}

// 解析卡拉OK歌词（行内 (mm:ss.xx) 逐字标签）
function parseKaraokeWords(text: string): { time: number; text: string }[] {
  const words: { time: number; text: string }[] = [];
  const wordRegex = /\((\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\)(.*?)(?=\(\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\)|$)/g;

  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const wordText = match[4];

    if (wordText) {
      words.push({ time: tagToSeconds(match[1], match[2], match[3]), text: wordText });
    }
  }

  return words;
}
