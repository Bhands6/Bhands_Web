import { musicApi, SongItem } from '../api/music';
import { AudioTrack } from '../audio/AudioEngine';
import { beatClock } from '../audio/beatClock';
import { analyzeTrackBeatMap } from '../audio/beatAnalyzer';
import { usePlayerStore, readSessionSnapshot, flushSessionSnapshot } from '../stores/usePlayerStore';
import { usePlaylistStore } from '../stores/usePlaylistStore';
import { useLyricsStore } from '../stores/useLyricsStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { useUIStore } from '../stores/useUIStore';
import { useUserStore } from '../stores/useUserStore';

/** SongItem(搜索结果) → AudioTrack(播放器) */
export function songItemToTrack(song: SongItem): AudioTrack {
  return {
    id: song.id,
    name: song.name,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
    url: '', // 播放地址在真正播放时解析
    cover: song.cover,
    source: song.source || 'netease'
  };
}

/** 解析播放地址（服务端 VIP 分流：VIP 先官方后解析，非 VIP 先解析后官方）
 *  fresh=true 绕过服务端成功缓存重新解析，用于播放失败重试（缓存的时效直链可能已过期） */
async function resolveTrackUrl(id: string, fresh = false): Promise<{ url: string; trial?: boolean; quality?: string } | null> {
  const { quality } = useUIStore.getState();
  const { user } = useUserStore.getState();
  try {
    const response = await musicApi.getSongUrl(id, quality, !!user?.vip, fresh);
    if (response.success && response.data?.url) {
      return { url: response.data.url, trial: response.data.trial, quality: response.data.quality };
    }
  } catch {
    // 解析失败
  }
  return null;
}

/** RGB → HSL（移植桌面版 rgbToHsl） */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

/** HSL → RGB（移植桌面版 hslToRgb） */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  ];
}

/** '#rrggbb' 或 'rgb(r,g,b)' → [r,g,b]（同时支持两种写法，避免 hex 分支解析失败） */
export function parseColorToRgb(color: string): [number, number, number] | null {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const nums = color.match(/\d+/g);
  if (nums && nums.length >= 3) return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
  return null;
}

/**
 * 从封面图提取主色，驱动粒子与歌词氛围（对应桌面版「封面取色」）
 * 歌词色移植桌面版 lyricPaletteFromHex 的 HSL 提亮算法：暗封面也会得到
 * 亮度 0.30~0.82 的清晰歌词色，而不是简单 +46 导致的暗淡色。
 */
function applyCoverTint(cover: string): void {
  if (!cover) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 12;
      canvas.height = 12;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 12, 12);
      const { data } = ctx.getImageData(0, 0, 12, 12);

      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        // 跳过过暗/过亮像素，取中间调主色
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum > 28 && lum < 226) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
      }
      if (!count) return;
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);

      // ---- 歌词色：桌面版 lyricTextPaletteFromHsl 移植 ----
      // 桌面版 lightText 判定（avgL<0.52 用亮字、否则深字）服务于白色壁纸模式；
      // 网页版舞台背景恒为暗色（封面模糊层 brightness .18），歌词永远用亮色文字（0.74/0.86）
      const hsl = rgbToHsl(r, g, b);
      const chroma = hsl.s;
      let lyricColor: string;
      let hlColor: string;
      if (hsl.l < 0.16 || chroma < 0.08 || (hsl.l < 0.30 && (hsl.h < 0.06 || hsl.h > 0.75))) {
        // 银蓝兜底（桌面版 silverBlueLyricPalette）
        lyricColor = '#d8f1ff';
        hlColor = '#eef7ff';
      } else {
        const s = Math.min(0.78, Math.max(0.42, hsl.s + 0.16));
        const [lr, lg, lb] = hslToRgb(hsl.h, s, 0.74);
        const [hr, hg, hb] = hslToRgb((hsl.h + 0.03) % 1, Math.max(0.28, s - 0.18), 0.86);
        lyricColor = `rgb(${lr},${lg},${lb})`;
        hlColor = `rgb(${hr},${hg},${hb})`;
      }

      const tint = `rgb(${r},${g},${b})`;
      // 辉光必须取**提亮后的歌词色**（桌面版 glow 取 c1 而非原始封面色）。
      // 注意：银蓝兜底分支的 lyricColor 是 '#d8f1ff'（hex），若用 /\d+/ 取分量会解析失败，
      // 从而退回「封面原始色」—— 而该分支恰恰是封面色偏暗时才走，暗色发光在深色舞台上完全不可见，
      // 表现为「歌词有跳动但没有溢光」。这里统一解析 hex / rgb() 两种写法。
      const glowRgb = parseColorToRgb(lyricColor) ?? [r, g, b];
      const glow = `rgba(${glowRgb[0]},${glowRgb[1]},${glowRgb[2]},.62)`;
      document.documentElement.style.setProperty('--visual-tint', tint);
      document.documentElement.style.setProperty('--stage-lyric-glow', glow);
      document.documentElement.style.setProperty('--stage-lyric-color', lyricColor);
      document.documentElement.style.setProperty('--stage-lyric-hl', hlColor);
    } catch {
      // 跨域等导致取色失败时保持默认色
    }
  };
  img.src = cover;
}

/** 离线节拍分析启动延迟（对应桌面版 beatAnalysisConfig.delayMs = 1600）：
 *  切歌后立刻拉整曲会与音频首帧缓冲抢带宽，延后一点再分析。 */
const BEAT_ANALYSIS_DELAY_MS = 1600;

/**
 * 离线节拍分析（桌面版 dj-analyzer 移植）：解析整曲生成 BeatMap，
 * 完成后装入节拍时钟驱动歌词溢光；失败静默（保持实时分析兜底）。
 *
 * - 延后 BEAT_ANALYSIS_DELAY_MS 再开始，且已切歌则直接放弃（不为旧曲目白下载整曲）；
 * - 拉流是整曲下载，易受上游抖动 / `/stream` 限流影响而瞬时失败，
 *   故失败后延时重试一次（成功结果有缓存，重试不会重复解码）。
 */
function startBeatAnalysis(track: AudioTrack): void {
  beatClock.setTrack(track.id);
  const run = (attempt: number, delayMs: number): void => {
    window.setTimeout(() => {
      if (usePlayerStore.getState().currentTrack?.id !== track.id) return; // 已切歌
      analyzeTrackBeatMap(track.id, track.url, track.duration)
        .then((map) => {
          if (map) beatClock.setMap(track.id, map);
          else if (attempt === 0) run(1, 2500);
        })
        .catch(() => {
          if (attempt === 0) run(1, 2500);
        });
    }, delayMs);
  };
  run(0, BEAT_ANALYSIS_DELAY_MS);
}

/**
 * 统一播放入口：解析地址 → 播放 → 加载歌词 → 记录历史 → 封面取色
 * @param queue 可选，同时更新播放队列
 *
 * playToken 竞态守卫：解析地址是异步的（可能数秒），期间用户可能再次切歌、
 * 或旧曲目播完触发 ended→next。过期请求在关键节点被丢弃，避免旧解析覆盖新曲目。
 */
let playToken = 0;

/** 可直接播放的缓存地址：blob:（本地导入）与本服务代理 /api/。
 *  早期版本把酷狗/酷我等平台直链持久化进了队列/历史，外站 CDN 无 CORS 头，须重新解析。 */
function isDirectPlayableUrl(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('/api/');
}

export async function playTrack(
  track: AudioTrack,
  queue?: AudioTrack[],
  index = -1,
  opts: { autoAdvance?: boolean } = {}
): Promise<void> {
  const token = ++playToken;
  const player = usePlayerStore.getState();
  const showToast = useUIStore.getState().showToast;

  // 用户主动选歌 → 自动切到舞台视图；自动切歌/上一首下一首不打扰 Home 浏览
  if (!opts.autoAdvance) {
    useUIStore.getState().setHomeVisible(false);
  }

  const queueIndex = queue ? (index >= 0 ? index : queue.indexOf(track)) : -1;
  if (queue) {
    player.setPlaylist(queue);
    player.setCurrentIndex(queueIndex);
  }

  showToast(`正在解析「${track.name}」…`);

  // 已有可直连地址直接播放，否则（含旧版持久化的平台直链）重新解析
  let url = isDirectPlayableUrl(track.url) ? track.url : '';
  let trial = false;
  usePlayerStore.setState({ playingQuality: track.resolvedQuality || '' });
  if (!url) {
    const resolved = await resolveTrackUrl(track.id);
    if (token !== playToken) return; // 已被更新的播放请求取代
    if (!resolved) {
      showToast(`「${track.name}」暂无可用播放源`);
      return;
    }
    url = resolved.url;
    trial = !!resolved.trial;
    if (resolved.quality) usePlayerStore.setState({ playingQuality: resolved.quality });
  }
  if (trial) {
    showToast('当前仅试听片段，登录后可获得完整播放');
  }

  let fullTrack: AudioTrack = { ...track, url, resolvedQuality: usePlayerStore.getState().playingQuality || track.resolvedQuality };

  // 把解析到的地址回写队列，切回本曲时无需再次解析
  const writeBack = () => {
    if (queue && queueIndex >= 0) {
      queue[queueIndex] = fullTrack;
      player.setPlaylist([...queue]);
    }
  };
  writeBack();

  const finish = () => {
    // 歌词 + 历史 + 氛围
    const lyrics = useLyricsStore.getState();
    lyrics.clearLyrics();
    lyrics.loadLyrics(track.id);
    useHistoryStore.getState().addToHistory(fullTrack);
    applyCoverTint(track.cover);
    // 离线节拍分析（异步，完成后歌词溢光切到精确节拍驱动）
    startBeatAnalysis(fullTrack);
  };

  const loadAndFinish = async (): Promise<boolean> => {
    try {
      await player.setCurrentTrack(fullTrack);
      if (token !== playToken) return true; // 被新请求取代，无需后续处理
      finish();
      return true;
    } catch {
      return false;
    }
  };

  if (await loadAndFinish()) return;

  // 首次加载失败：缓存的直链可能已过期（外站链接含时效令牌，服务端成功缓存也会过期）
  // → 无论地址来自快照还是解析结果，都绕过缓存重新解析一次再试
  if (token !== playToken) return;
  const retried = await resolveTrackUrl(track.id, true);
  if (token !== playToken) return;
  if (retried) {
    fullTrack = { ...track, url: retried.url, resolvedQuality: retried.quality || '' };
    writeBack();
    if (await loadAndFinish()) return;
  }
  if (token === playToken) {
    showToast(`「${track.name}」播放失败`);
  }
}

/** 播放搜索结果（同时把结果设为队列） */
export async function playSearchResult(songs: SongItem[], index: number): Promise<void> {
  const queue = songs.map(songItemToTrack);
  const track = queue[index];
  if (track) await playTrack(track, queue, index);
}

/** 播放歌单（先拉详情再整单入队）；返回是否成功入队 */
export async function playPlaylist(playlistId: string, name: string, startIndex = 0): Promise<boolean> {
  const { loadPlaylistDetail } = usePlaylistStore.getState();
  const showToast = useUIStore.getState().showToast;
  showToast(`正在打开歌单「${name}」…`);
  const tracks = await loadPlaylistDetail(playlistId);
  if (!tracks.length) {
    showToast('歌单为空或加载失败');
    return false;
  }
  const queue = tracks.map(songItemToTrack);
  await playTrack(queue[startIndex], queue, startIndex);
  return true;
}

// 注册切歌委托：next/prev/播放结束 → 经 playTrack 解析地址后播放（autoAdvance 不切视图）
usePlayerStore.getState().setPlayIndexDelegate((index) => {
  const { playlist } = usePlayerStore.getState();
  const track = playlist[index];
  if (track) playTrack(track, playlist, index, { autoAdvance: true });
});

/** 恢复上次会话：刷新后还原队列/当前曲目/进度（暂停态，点播放从上次位置继续） */
export async function restoreSession(): Promise<void> {
  const snap = readSessionSnapshot();
  if (!snap) return;
  // 竞态守卫：恢复是异步的（解析地址可能数秒），期间用户点播新歌会让 playToken 递增。
  // 恢复流程必须在每个 await 之后检查并退出 —— 否则 setCurrentTrack 会替换共享 <audio>
  // 的 src，**打断用户正在播的歌**并停在暂停态。
  const tokenAtStart = playToken;
  const player = usePlayerStore.getState();
  const track = snap.playlist[snap.currentIndex];
  if (!track) return;

  // 队列/模式/音量直接回写
  player.setPlaylist(snap.playlist);
  player.setCurrentIndex(snap.currentIndex);
  player.setPlayMode(snap.playMode);
  player.setVolume(snap.volume);
  player.setMuted(snap.muted);

  // 当前曲目：解析地址 → 加载（不自动播放）→ 跳到上次进度
  let url = isDirectPlayableUrl(track.url) ? track.url : '';
  if (!url) {
    const resolved = await resolveTrackUrl(track.id);
    if (!resolved || playToken !== tokenAtStart) return; // 地址解析失败：保留队列，用户点播时走常规重试
    url = resolved.url;
  }
  if (playToken !== tokenAtStart) return; // 恢复期间用户已点播新歌
  try {
    await player.setCurrentTrack({ ...track, url }, { autoplay: false });
    if (playToken !== tokenAtStart) return; // 加载期间用户已点播新歌
    if (snap.currentTime > 1) player.seek(Math.min(snap.currentTime, player.duration || snap.currentTime));
    // 歌词 + 封面氛围（与 playTrack 的 finish 一致，但不写播放历史）
    const lyrics = useLyricsStore.getState();
    lyrics.loadLyrics(track.id);
    applyCoverTint(track.cover);
    // 离线节拍分析（恢复现场同样驱动歌词溢光）
    startBeatAnalysis({ ...track, url });
    // 恢复完成：把跳转后的真实进度立即落盘（否则下次刷新进度回到 0）
    flushSessionSnapshot();
  } catch {
    // 加载失败：队列仍在，静默放弃（点播放时会重新解析）
  }
}
