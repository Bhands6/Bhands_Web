import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { usePlayerStore } from '../stores/usePlayerStore';
import { audioEngine } from '../audio/AudioEngine';
import { useLyricsStore } from '../stores/useLyricsStore';
import { useUIStore } from '../stores/useUIStore';
import { useSettingsStore } from '../stores/useSettingsStore';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (v: number) => v * v * (3 - 2 * v);

/**
 * 舞台歌词：大字居中、当前行高亮溢光、点击跳播（对应桌面版 #stage-lyrics）
 * 动态溢光：rAF 循环直读 analyserData，移植桌面版「阳光溢光」自适应阈值算法，
 * 把 --beat-glow（节拍包络）与 --lyric-sun（持续能量）写入 CSS 变量驱动样式。
 */
export default function StageLyrics() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const seek = usePlayerStore((s) => s.seek);

  const lyrics = useLyricsStore((s) => s.lyrics);
  const hasLyrics = useLyricsStore((s) => s.hasLyrics);
  const currentLineIndex = useLyricsStore((s) => s.currentLineIndex);

  const lyricMode = useUIStore((s) => s.lyricMode);
  const lyricScale = useSettingsStore((s) => s.lyrics.scale);

  // ---------- 音频驱动溢光（节拍 + 阳光能量，桌面版 updateStageLyrics3D 移植） ----------
  useEffect(() => {
    const root = document.documentElement;

    let raf = 0;
    let disposed = false;
    // 平滑包络
    let smoothEnergy = 0, smoothMid = 0, smoothTreb = 0;
    let beatGlow = 0;
    // 阳光能量自适应阈值状态
    let sunAvg = 0, sunPeak = 0.55, sunHold = 0, sunEnergy = 0;
    const env = (prev: number, next: number, attack: number, release: number) =>
      prev + (next - prev) * (next > prev ? attack : release);

    const loop = () => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);

      // 歌词行推进：直读引擎实时进度（rAF 级精度）。
      // 不能依赖 store.currentTime —— 它由 timeupdate 事件更新（约 250ms 一次），
      // 行切换会滞后/量化 250ms；setCurrentTime 仅在行号变化时 setState，不会高频重渲染。
      // 注意：即使 Home 页可见（歌词被主页遮挡）也要继续推进行号，
      // 否则浏览 Home 期间行号会停住，切回舞台的瞬间会显示过期行。
      //
      // 时间偏移：音源母带（LX/酷我等第三方）与网易云歌词时间轴常不一致，
      // 加上音频输出延迟（蓝牙/声卡缓冲）会表现为恒定超前/滞后，用设置里的
      // 「歌词时间偏移」补偿：正值=歌词延后。此处直读 store，避免闭包读到过期值。
      const lyricOffset = useSettingsStore.getState().lyrics.offset;
      useLyricsStore.getState().setCurrentTime(audioEngine.getCurrentTime() - lyricOffset);

      // 标签页隐藏 或 Home 页可见时跳过溢光计算（歌词不可见，无需驱动 CSS 变量）
      if (document.hidden || useUIStore.getState().homeVisible) return;

      const { analyserData, isPlaying } = usePlayerStore.getState();
      if (isPlaying) {
        smoothEnergy = env(smoothEnergy, Math.min(0.72, analyserData?.energy ?? 0), 0.16, 0.055);
        smoothMid = env(smoothMid, Math.min(0.68, (analyserData?.mid ?? 0) * 0.64), 0.18, 0.06);
        smoothTreb = env(smoothTreb, Math.min(0.56, (analyserData?.treble ?? 0) * 0.54), 0.18, 0.055);
      } else {
        smoothEnergy *= 0.91; smoothMid *= 0.91; smoothTreb *= 0.91;
      }

      // 整行呼吸 + 低频律动（对应桌面版 mesh.scale = 0.96 + breathe + bass*0.038 + beatPulse*0.014）
      const nowSec = performance.now() / 1000;
      const breathe = Math.sin(nowSec * 0.92) * 0.05 + Math.sin(nowSec * 0.41) * 0.028;
      root.style.setProperty('--lyric-breath', (isPlaying ? breathe : 0).toFixed(4));
      root.style.setProperty('--lyric-bass', Math.min(0.9, analyserData?.bass ?? 0).toFixed(3));

      // 节拍溢光：beatPulseSmooth 来自离线节拍映射（桌面版 beatGlow 公式：beatPulse * 1.22，快攻慢放）
      const beatGlowRaw = isPlaying ? (analyserData?.beatPulseSmooth ?? 0) * 1.22 : 0;
      beatGlow += (beatGlowRaw - beatGlow) * (beatGlowRaw > beatGlow ? 0.32 : 0.1);

      // 阳光溢光（对应桌面版 lyricSun*：持续能量 + 中高频抬升，副歌段落才点亮）
      let sunTarget = 0;
      if (isPlaying) {
        const sunEnergyRaw = clamp01((smoothEnergy - 0.18) / 0.38);
        const sunMelody = clamp01((smoothMid - 0.16) / 0.27);
        const sunAir = clamp01((smoothTreb - 0.105) / 0.17);
        let sunRaw = clamp01(sunEnergyRaw * 0.44 + sunMelody * 0.32 + sunAir * 0.24);
        sunRaw = smoothstep(sunRaw);
        sunAvg += (sunRaw - sunAvg) * 0.006;
        sunPeak = Math.max(0.48, sunPeak * 0.9985, sunRaw);
        const sunThreshold = Math.max(0.78, sunAvg + 0.2, sunPeak * 0.74);
        let sunGate = clamp01((sunRaw - sunThreshold) / Math.max(0.08, 1 - sunThreshold));
        sunGate = smoothstep(sunGate);
        sunHold += (sunGate - sunHold) * (sunGate > sunHold ? 0.035 : 0.014);
        sunTarget = sunHold > 0.16 ? clamp01((sunHold - 0.16) / 0.84) : 0;
      } else {
        sunHold *= 0.9;
        sunAvg *= 0.995;
        sunPeak = Math.max(0.48, sunPeak * 0.997);
      }
      sunEnergy += (sunTarget - sunEnergy) * (sunTarget > sunEnergy ? 0.075 : 0.03);

      root.style.setProperty('--beat-glow', beatGlow.toFixed(3));
      root.style.setProperty('--lyric-sun', sunEnergy.toFixed(3));
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      root.style.removeProperty('--beat-glow');
      root.style.removeProperty('--lyric-sun');
      root.style.removeProperty('--lyric-breath');
      root.style.removeProperty('--lyric-bass');
    };
  }, []);

  // 歌词行号由上方 rAF 循环逐帧驱动（audioEngine.getCurrentTime），不再依赖
  // 250ms 粒度的 store.currentTime；歌词晚到时立即按当前进度补一次同步（含时间偏移）
  const trackId = currentTrack?.id;
  useEffect(() => {
    if (trackId) {
      const { offset } = useSettingsStore.getState().lyrics;
      useLyricsStore.getState().setCurrentTime(audioEngine.getCurrentTime() - offset);
    }
  }, [trackId, lyrics]);

  // 可见行数随字号自适应：字号越大显示行数越少，避免超出容器被裁切
  const { above, below } = useMemo(() => {
    if (lyricScale > 1.4) return { above: 1, below: 2 };
    if (lyricScale > 1.1) return { above: 2, below: 3 };
    return { above: 2, below: 4 };
  }, [lyricScale]);

  // 单行模式：只取当前行（没有当前行则取第一行）
  const singleLine = useMemo(() => {
    if (!lyrics.length) return null;
    const idx = currentLineIndex >= 0 ? currentLineIndex : 0;
    return { ...lyrics[idx], index: idx };
  }, [lyrics, currentLineIndex]);

  // 可见窗口：当前行上方 above 行到下方 below 行
  const window = useMemo(() => {
    if (!lyrics.length || currentLineIndex < 0) {
      return lyrics.slice(0, above + below).map((l, i) => ({ ...l, index: i }));
    }
    const start = Math.max(0, currentLineIndex - above);
    const end = Math.min(lyrics.length, currentLineIndex + below + 1);
    const rows = [];
    for (let i = start; i < end; i++) rows.push({ ...lyrics[i], index: i });
    return rows;
  }, [lyrics, currentLineIndex, above, below]);

  const visible = !!currentTrack && lyricMode !== 'hidden';
  if (!visible) return <div id="stage-lyrics" />;

  return (
    <LyricsStage
      mode={lyricMode}
      hasLyrics={hasLyrics}
      currentTrack={currentTrack}
      window={window}
      singleLine={singleLine}
      currentLineIndex={currentLineIndex}
      seek={seek}
    />
  );
}

/** 歌词渲染（多行窗口 / 单行当前句 + 溢出自适应缩放） */
function LyricsStage({
  mode,
  hasLyrics,
  currentTrack,
  window,
  singleLine,
  currentLineIndex,
  seek
}: {
  mode: 'multi' | 'single' | 'hidden';
  hasLyrics: boolean;
  currentTrack: { name: string; artist: string } | null;
  window: { index: number; time: number; text: string }[];
  singleLine: { index: number; time: number; text: string } | null;
  currentLineIndex: number;
  seek: (t: number) => void;
}) {
  // 单行模式：测量文字自然宽度，溢出时等比缩小塞进一行（写入 --single-fit）
  const singleLineRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (mode !== 'single') return;
    const line = singleLineRef.current;
    const text = textRef.current;
    if (!line || !text) return;
    line.style.setProperty('--single-fit', '1');
    // clientWidth 含行左右 12px padding，扣除后作为可用宽度
    const available = line.clientWidth - 24;
    const natural = text.offsetWidth;
    const fit = natural > available && natural > 0
      ? Math.max(0.4, available / natural)
      : 1;
    line.style.setProperty('--single-fit', fit.toFixed(3));
  }, [mode, singleLine?.text, singleLine?.index, currentTrack]);

  // 单行模式：仅当前行，容器收窄为单行高度
  if (mode === 'single') {
    return (
      <div id="stage-lyrics" className={hasLyrics ? 'show single' : ''}>
        {!hasLyrics && (
          <div className="stage-lyric-empty">
            {currentTrack ? `${currentTrack.name} · ${currentTrack.artist}` : ''}
          </div>
        )}
        {hasLyrics && singleLine && (
          <div
            key={singleLine.index}
            ref={singleLineRef}
            className="stage-lyric-line current"
            data-text={singleLine.text}
            onClick={() => seek(Math.max(0, singleLine.time - 0.2))}
            title="点击跳到这句"
          >
            <span ref={textRef} className="sll-text">{singleLine.text}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div id="stage-lyrics" className={hasLyrics ? 'show' : ''}>
      {!hasLyrics && (
        <div className="stage-lyric-empty">
          {currentTrack ? `${currentTrack.name} · ${currentTrack.artist}` : ''}
        </div>
      )}
      {hasLyrics &&
        window.map((line) => {
          const dist = Math.abs(line.index - currentLineIndex);
          const cls =
            line.index === currentLineIndex
              ? 'current'
              : dist === 1
                ? 'near'
                : '';
          return (
            <div
              key={line.index}
              className={`stage-lyric-line ${cls}`}
              data-text={line.text}
              onClick={() => seek(Math.max(0, line.time - 0.2))}
              title="点击跳到这句"
            >
              <span className="sll-text">{line.text}</span>
            </div>
          );
        })}
    </div>
  );
}
