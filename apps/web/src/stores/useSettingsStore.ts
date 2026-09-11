import { create } from 'zustand';

/**
 * 网页版设置（对应桌面版「视觉控制台」fx 系列设置，localStorage 持久化）
 * 桌面版专属项（桌面歌词/壁纸模式/关闭行为/3D 歌单架/摄像头手势）不适用于浏览器，未纳入。
 */

export type RenderQuality = 'eco' | 'balanced' | 'high' | 'ultra';

/** 粒子效果形态（复刻桌面版 shader 预设：丝绸/滚筒/星球/虚空/唱片/星河壁纸 + 新增 极光/万花筒/迸发/声波地形/螺旋星云） */
export type ParticleEffect =
  | 'silk' | 'tunnel' | 'orbit' | 'void' | 'vinyl' | 'wallpaper'
  | 'aurora' | 'kaleido' | 'burst' | 'sonic' | 'spiral';

export const EFFECT_LABELS: Record<ParticleEffect, string> = {
  silk: '丝绸',
  tunnel: '滚筒',
  orbit: '星球',
  void: '虚空',
  vinyl: '唱片',
  wallpaper: '星河',
  aurora: '极光',
  kaleido: '万花筒',
  burst: '迸发',
  sonic: '声波地形',
  spiral: '螺旋星云'
};

/** 桌面版 uPreset 序号（shader 分支索引）；6/7/8 为新增，9/10 为声波地形/螺旋星云 */
export const EFFECT_PRESET_INDEX: Record<ParticleEffect, number> = {
  silk: 0,
  tunnel: 1,
  orbit: 2,
  void: 3,
  vinyl: 4,
  wallpaper: 5,
  aurora: 6,
  kaleido: 7,
  burst: 8,
  sonic: 9,
  spiral: 10
};

/** 旧版效果名 → 桌面版预设迁移 */
const LEGACY_EFFECT_MIGRATION: Record<string, ParticleEffect> = {
  galaxy: 'wallpaper',
  tunnel: 'tunnel',
  orbit: 'orbit',
  nebula: 'silk',
  wave: 'silk'
};

export interface VisualSettings {
  effect: ParticleEffect;      // 粒子效果形态
  intensity: number;          // 律动强度 0.2-1.6（音频驱动的反应幅度）
  particleSize: number;       // 粒子尺寸 0.5-2.2
  flowSpeed: number;          // 流速 0.2-2.5（星河基础旋转速度）
  dustLayer: boolean;         // 浮空粒子层（近景漂浮尘埃）
  renderQuality: RenderQuality; // 画质档位：粒子数量 + 渲染像素比
  tintMode: 'auto' | 'custom';  // 视觉主色：封面取色 / 自定义
  tintColor: string;
  backgroundOpacity: number;  // 背景透明度 0-1（专辑封面模糊背景）
}

export interface LyricsSettings {
  scale: number;              // 歌词大小 0.35-1.65
  weight: number;             // 字重 500-900
  letterSpacing: number;      // 字间距 px 0-8
  colorMode: 'auto' | 'custom'; // auto=封面取色渐变 / custom=纯色
  color: string;
  glowStrength: number;       // 溢光强度 0-1.6
  /**
   * 歌词衬底强度 0-1.6（当前行背后的暗色晕影，对应桌面版 readability 平面）。
   * 舞台背景是高亮粒子帘时，亮色溢光贴在亮背景上没有对比度、看着像「没有光」，
   * 故加一层暗底拉开对比；但亮暗封面的反差需求差别很大，所以交给用户调。0 = 完全关闭。
   */
  backdrop: number;
  /**
   * 歌词时间偏移（秒）：正值=歌词延后，负值=歌词提前。
   * 用于校正「音源母带与歌词时间轴不一致」或「音频输出延迟（蓝牙/声卡缓冲）」
   * 造成的恒定超前/滞后 —— 这类偏移无法自动探测，需手动校准。
   */
  offset: number;
}

/** 歌词时间偏移钳制范围（秒），与面板滑块一致 */
export const LYRIC_OFFSET_LIMIT = 2;

/** 歌词衬底强度默认值与上限（与面板滑块一致） */
export const LYRIC_BACKDROP_DEFAULT = 1;
export const LYRIC_BACKDROP_MAX = 1.6;

/** 规范化歌词时间偏移（非有限值回退 0，超界钳制） */
export function clampLyricOffset(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-LYRIC_OFFSET_LIMIT, Math.min(LYRIC_OFFSET_LIMIT, n));
}

/** 规范化歌词衬底强度（缺失/非法回退默认值，超界钳制到 0~1.6；0 = 关闭衬底） */
export function clampLyricBackdrop(v: unknown): number {
  if (v === undefined || v === null) return LYRIC_BACKDROP_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return LYRIC_BACKDROP_DEFAULT;
  return Math.max(0, Math.min(LYRIC_BACKDROP_MAX, n));
}

interface SettingsState {
  visual: VisualSettings;
  lyrics: LyricsSettings;

  // 面板（对应桌面版 fx-panel / fx-fab）
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;

  setVisual: (patch: Partial<VisualSettings>) => void;
  setLyrics: (patch: Partial<LyricsSettings>) => void;
  applyPreset: (key: 'default' | 'vivid' | 'calm' | 'aurora') => void;
  resetAll: () => void;
}

const STORE_KEY = 'bhandsmusic-web-settings-v1';

const DEFAULT_VISUAL: VisualSettings = {
  effect: 'silk',
  intensity: 0.85,
  particleSize: 1.0,
  flowSpeed: 1.0,
  dustLayer: true,
  renderQuality: 'high',
  tintMode: 'auto',
  tintColor: '#9db8cf',
  backgroundOpacity: 1
};

const DEFAULT_LYRICS: LyricsSettings = {
  scale: 1.0,
  weight: 700,
  letterSpacing: 2,
  colorMode: 'auto',
  color: '#a9b8c8',
  glowStrength: 1.0,
  backdrop: 1.0,
  offset: 0
};

/** 画质档位 → 粒子网格 / 渲染像素比上限（对齐桌面版 coverParticleGridForResolution：88~183，默认 118×118） */
export const QUALITY_PROFILES: Record<RenderQuality, { particles: number; dust: number; pixelRatio: number }> = {
  eco: { particles: 88 * 88, dust: 120, pixelRatio: 1 },
  balanced: { particles: 108 * 108, dust: 220, pixelRatio: 1.5 },
  high: { particles: 118 * 118, dust: 380, pixelRatio: 2 },
  ultra: { particles: 150 * 150, dust: 560, pixelRatio: 2 }
};

/** 视觉预设（对应桌面版 preset-grid 概念：一键切换参数组合，形态保持用户当前选择） */
export const VISUAL_PRESETS = {
  default: { name: '默认', desc: '均衡的律动与流速', visual: DEFAULT_VISUAL },
  vivid: {
    name: '律动增强',
    desc: '更强的节拍反应与流速',
    visual: { ...DEFAULT_VISUAL, intensity: 1.35, particleSize: 1.25, flowSpeed: 1.6 }
  },
  calm: {
    name: '静谧',
    desc: '缓慢漂移的深空气氛',
    visual: { ...DEFAULT_VISUAL, intensity: 0.45, particleSize: 0.8, flowSpeed: 0.5, backgroundOpacity: 0.6 }
  },
  aurora: {
    name: '绚彩',
    desc: '大粒子 + 高亮背景',
    visual: { ...DEFAULT_VISUAL, intensity: 1.1, particleSize: 1.7, flowSpeed: 1.2, backgroundOpacity: 1, tintColor: '#7fd8ff', tintMode: 'custom' }
  }
} as const;

/** 读取持久化设置（带边界钳制，脏数据回退默认；旧版效果名迁移到桌面预设） */
function loadPersisted(): { visual: VisualSettings; lyrics: LyricsSettings } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Partial<{
      visual: Partial<VisualSettings>;
      lyrics: Partial<LyricsSettings>;
    }>;
    const visual = { ...DEFAULT_VISUAL, ...raw.visual };
    if (!EFFECT_LABELS[visual.effect]) {
      visual.effect = LEGACY_EFFECT_MIGRATION[raw.visual?.effect ?? ''] ?? DEFAULT_VISUAL.effect;
    }
    return {
      visual,
      lyrics: {
        ...DEFAULT_LYRICS,
        ...raw.lyrics,
        offset: clampLyricOffset(raw.lyrics?.offset),
        backdrop: clampLyricBackdrop(raw.lyrics?.backdrop)
      }
    };
  } catch {
    return { visual: { ...DEFAULT_VISUAL }, lyrics: { ...DEFAULT_LYRICS } };
  }
}

/** 把歌词/背景设置写到 CSS 变量（粒子参数由 ParticleStage 直读 store） */
function applyCssVars(lyrics: LyricsSettings, visual: VisualSettings): void {
  const root = document.documentElement.style;
  root.setProperty('--lyric-scale', String(lyrics.scale));
  root.setProperty('--lyric-weight', String(lyrics.weight));
  root.setProperty('--lyric-letter-spacing', `${lyrics.letterSpacing}px`);
  root.setProperty('--lyric-glow-strength', String(lyrics.glowStrength));
  root.setProperty('--lyric-backdrop', String(lyrics.backdrop));
  root.setProperty('--album-bg-opacity', String(visual.backgroundOpacity));

  // 歌词纯色模式：body 类切换 + 颜色变量（auto 模式保持封面取色渐变）
  document.body.classList.toggle('lyric-custom-color', lyrics.colorMode === 'custom');
  root.setProperty('--lyric-custom-color', lyrics.color);

  // 视觉主色自定义：直接覆盖 --visual-tint（auto 模式由 playService 封面取色写入）
  if (visual.tintMode === 'custom') {
    root.setProperty('--visual-tint', visual.tintColor);
  } else {
    // 回到 auto：清除内联覆盖，恢复封面取色写入的值
    root.removeProperty('--visual-tint');
  }
}

function persist(visual: VisualSettings, lyrics: LyricsSettings): void {
  // 隐私模式/配额满时吞异常（设置写失败非致命，内存态仍在）
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ visual, lyrics }));
  } catch { /* 非致命 */ }
}

const initial = loadPersisted();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  visual: initial.visual,
  lyrics: initial.lyrics,

  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  setVisual: (patch) => {
    const visual = { ...get().visual, ...patch };
    set({ visual });
    persist(visual, get().lyrics);
    applyCssVars(get().lyrics, visual);
  },

  setLyrics: (patch) => {
    const lyrics = { ...get().lyrics, ...patch };
    if (patch.offset !== undefined) lyrics.offset = clampLyricOffset(lyrics.offset);
    if (patch.backdrop !== undefined) lyrics.backdrop = clampLyricBackdrop(lyrics.backdrop);
    set({ lyrics });
    persist(get().visual, lyrics);
    applyCssVars(lyrics, get().visual);
  },

  applyPreset: (key) => {
    // 预设只调整参数组合，保留用户当前选择的粒子形态
    const { effect } = get().visual;
    const visual = { ...VISUAL_PRESETS[key].visual, effect };
    set({ visual });
    persist(visual, get().lyrics);
    applyCssVars(get().lyrics, visual);
  },

  resetAll: () => {
    set({ visual: { ...DEFAULT_VISUAL }, lyrics: { ...DEFAULT_LYRICS } });
    persist({ ...DEFAULT_VISUAL }, { ...DEFAULT_LYRICS });
    applyCssVars({ ...DEFAULT_LYRICS }, { ...DEFAULT_VISUAL });
  }
}));

// 启动时应用一次（SSR 无 window，本应用纯 CSR 可安全执行）
applyCssVars(initial.lyrics, initial.visual);
