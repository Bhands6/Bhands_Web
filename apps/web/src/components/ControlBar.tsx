import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useUIStore, QUALITY_LABELS, PlayQuality } from '../stores/useUIStore';
import { useFavoritesStore } from '../stores/useFavoritesStore';
import { audioEngine } from '../audio/AudioEngine';

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const QUALITY_OPTIONS: { key: PlayQuality; label: string; note: string }[] = [
  { key: 'jymaster', label: '超清母带', note: '最高规格' },
  { key: 'hires', label: '高清臻音', note: '细节优先' },
  { key: 'lossless', label: '无损 SQ', note: 'FLAC 优先' },
  { key: 'exhigh', label: '极高 HQ', note: '320kbps' },
  { key: 'standard', label: '标准', note: '128kbps' }
];

/** 实际播放音质 → 友好显示 */
function formatPlayingQuality(q: string): string {
  if (!q) return '';
  const pill = QUALITY_PILL[q as PlayQuality];
  if (pill) return pill;
  if (q.startsWith('gdmusic')) return 'GD';
  if (q.startsWith('lx')) return 'LX';
  if (q === 'unblock') return 'UC';
  if (q.startsWith('netease-')) return QUALITY_PILL[q.replace('netease-', '') as PlayQuality] || q.replace('netease-', '').toUpperCase();
  return q.toUpperCase();
}

const QUALITY_PILL: Record<PlayQuality, string> = {
  jymaster: '母带',
  hires: '臻音',
  lossless: '无损',
  exhigh: '极高',
  standard: '标准'
};

const MODE_DATA: Record<string, string> = { sequence: 'loop', loop: 'single', shuffle: 'shuffle' };
const MODE_TITLE: Record<string, string> = { sequence: '列表循环', loop: '单曲循环', shuffle: '随机播放' };

/** 底部控制台：进度条 + 播放控制 + 音质/音量/队列/沉浸模式（对应桌面版 #bottom-bar） */
export default function ControlBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const playMode = usePlayerStore((s) => s.playMode);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const seek = usePlayerStore((s) => s.seek);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMuted = usePlayerStore((s) => s.toggleMuted);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);

  const splashActive = useUIStore((s) => s.splashActive);
  const lyricMode = useUIStore((s) => s.lyricMode);
  const cycleLyricMode = useUIStore((s) => s.cycleLyricMode);
  const immersive = useUIStore((s) => s.immersive);
  const toggleImmersive = useUIStore((s) => s.toggleImmersive);
  const controlsAutoHide = useUIStore((s) => s.controlsAutoHide);
  const toggleControlsAutoHide = useUIStore((s) => s.toggleControlsAutoHide);
  const quality = useUIStore((s) => s.quality);
  const playingQuality = usePlayerStore((s) => s.playingQuality);
  const setQuality = useUIStore((s) => s.setQuality);
  const showToast = useUIStore((s) => s.showToast);
  const setQueuePanelOpen = useUIStore((s) => s.setQueuePanelOpen);
  const queuePanelOpen = useUIStore((s) => s.queuePanelOpen);

  const isFavorite = useFavoritesStore((s) => !!s.favorites.find((f) => f.id === currentTrack?.id));
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);

  // ---- 控制条可见性（悬停意图：鼠标在底部边缘/播放栏/弹层上 → 展示，完全离开 → 收缩）----
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseRef = useRef({ x: -9999, y: -9999, buttons: 0 });
  const [visible, setVisible] = useState(false);
  const [softHidden, setSoftHidden] = useState(false);

  // 「保持展示」热区：屏幕最底部边缘带（48px）+ 播放栏矩形 + 可见的音量/音质弹层（视觉上浮在栏上方）
  const inKeepZone = () => {
    const { x, y } = mouseRef.current;
    if (y >= window.innerHeight - 48) return true;
    const tol = 16;
    const hit = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol;
    };
    const bar = barRef.current;
    // 仅当栏实际可见时其矩形才算热区——透明/收缩态的栏 rect 仍占据屏幕区域，
    // 若不排除会把不可见区域也算进唤起范围（曾导致实际范围退化到 ~100px）
    const showing = !!bar && bar.classList.contains('visible') && !bar.classList.contains('soft-hidden');
    if (showing && hit(bar)) return true;
    for (const pop of showing ? bar?.querySelectorAll('.volume-popover, .quality-popover') ?? [] : []) {
      const cs = getComputedStyle(pop);
      if (cs.pointerEvents !== 'none' && hit(pop)) return true;
    }
    return false;
  };

  const scheduleHide = useCallback((delay = 400) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      // 到期校验：鼠标仍热区内或按住键拖动中（进度/音量滑块）则不收缩
      if (!inKeepZone() && mouseRef.current.buttons === 0) setSoftHidden(true);
    }, delay);
  }, []);

  const reveal = useCallback((delay?: number) => {
    setVisible(true);
    setSoftHidden(false);
    if (useUIStore.getState().controlsAutoHide) scheduleHide(delay ?? 2600);
  }, [scheduleHide]);

  // 播放状态变化时展示控制条
  useEffect(() => {
    if (isPlaying) reveal();
  }, [isPlaying, reveal]);

  // 鼠标位置驱动：底部边缘唤起，完全离开收缩（坐标校验，静止悬停不误收）
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY, buttons: e.buttons };
      if (splashActive) return;
      if (inKeepZone()) {
        reveal(2800);
      } else if (useUIStore.getState().controlsAutoHide && visible && e.buttons === 0) {
        scheduleHide(400);
      }
    };
    const onUp = () => {
      // 拖动滑块松手在热区外：补一次收缩判定
      if (useUIStore.getState().controlsAutoHide && visible && !inKeepZone()) scheduleHide(400);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [splashActive, visible, reveal, scheduleHide]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // body.controls-visible 联动（Home 上移等样式依赖它）
  useEffect(() => {
    const active = visible && !softHidden;
    document.body.classList.toggle('controls-visible', active);
    return () => document.body.classList.remove('controls-visible');
  }, [visible, softHidden]);

  // ---- 进度条拖拽 ----
  const progressRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragRatio, setDragRatio] = useState(0);

  const ratioFromEvent = (clientX: number): number => {
    const el = progressRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => setDragRatio(ratioFromEvent(e.clientX));
    const onUp = (e: MouseEvent) => {
      setDragging(false);
      seek(ratioFromEvent(e.clientX) * (duration || 0));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, duration, seek]);

  const progressRatio = dragging ? dragRatio : duration > 0 ? currentTime / duration : 0;

  // ---- 播放模式切换：sequence → loop → shuffle ----
  const cycleMode = () => {
    const order: Array<'sequence' | 'loop' | 'shuffle'> = ['sequence', 'loop', 'shuffle'];
    const next = order[(order.indexOf(playMode) + 1) % order.length];
    setPlayMode(next);
    showToast(`播放模式：${MODE_TITLE[next]}`);
  };

  // ---- 音质切换（切歌后生效） ----
  const changeQuality = (q: PlayQuality) => {
    setQuality(q);
    showToast(`音质已切换为「${QUALITY_LABELS[q]}」，下一首生效`);
  };

  const handleLike = () => {
    if (!currentTrack) return;
    toggleFavorite(currentTrack);
    showToast(isFavorite ? '已从红心移除' : '已加入红心喜欢');
  };

  const barCls = [
    visible ? 'visible' : '',
    softHidden ? 'soft-hidden' : '',
    currentTrack ? 'stage-mode' : ''
  ].filter(Boolean).join(' ');

  return (
    <>
      <button
        id="bottom-handle"
        type="button"
        aria-label="展开播放器控制台"
        title="播放器控制台"
        onClick={() => reveal(3600)}
      >
        <span />
      </button>

      <div
        id="bottom-bar"
        ref={barRef}
        className={barCls}
      >
        <div
          id="progress-bar"
          ref={progressRef}
          className={dragging ? 'is-dragging' : ''}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          onMouseDown={(e) => {
            if (!duration) return;
            setDragging(true);
            setDragRatio(ratioFromEvent(e.clientX));
          }}
        >
          <div id="progress-fill" style={{ width: `${progressRatio * 100}%` }} />
          <div id="progress-thumb" style={{ left: `${progressRatio * 100}%` }} aria-hidden="true" />
        </div>

        <div id="controls">
          {/* 左：封面 + 曲目信息 + 喜欢 + 音质 */}
          <div className="control-cluster actions">
            <div className="control-track">
              <div
                className={`control-cover${currentTrack?.cover ? '' : ' cover-empty'}`}
                style={currentTrack?.cover ? { backgroundImage: `url(${currentTrack.cover})` } : undefined}
                aria-hidden="true"
              />
              <div className="control-meta">
                <div className="control-title" title={currentTrack?.name || ''}>
                  {currentTrack?.name || '未在播放'}
                </div>
                <div className="control-artist" title={currentTrack?.artist || ''}>
                  {currentTrack?.artist || '搜索一首歌开始'}
                </div>
              </div>
            </div>

            <div className="quality-control">
              <button
                className="ctrl-btn quality-pill"
                title="播放音质"
                style={{ fontSize: '11.5px', fontWeight: 800, letterSpacing: '.5px' }}
              >
                <span>{playingQuality ? formatPlayingQuality(playingQuality) : QUALITY_PILL[quality]}</span>
              </button>
              <div className="quality-popover" onClick={(e) => e.stopPropagation()}>
                {QUALITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    className={`quality-option${quality === opt.key ? ' active' : ''}`}
                    onClick={() => changeQuality(opt.key)}
                  >
                    <span>{opt.label}</span>
                    <small>{opt.note}</small>
                  </button>
                ))}
              </div>
            </div>

            <button
              className={`ctrl-btn${isFavorite ? ' liked' : ''}`}
              onClick={handleLike}
              title="红心喜欢"
              disabled={!currentTrack}
            >
              <svg className="heart-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21.45c-.32 0-.62-.12-.86-.34l-1.23-1.12C5.54 16.03 2.25 13.05 2.25 8.9 2.25 5.48 4.88 2.9 8.28 2.9c1.7 0 3.35.72 4.52 1.96C13.97 3.62 15.62 2.9 17.32 2.9c3.4 0 6.03 2.58 6.03 6 0 4.15-3.29 7.13-7.66 11.09l-1.23 1.12c-.24.22-.54.34-.86.34z" />
              </svg>
            </button>
          </div>

          {/* 中：模式 + 上一首/播放/下一首/队列 */}
          <div className="control-cluster transport">
            <button
              id="play-mode-btn"
              className="ctrl-btn"
              data-mode={MODE_DATA[playMode]}
              onClick={cycleMode}
              title={MODE_TITLE[playMode]}
            >
              {playMode === 'shuffle' ? (
                <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
                </svg>
              ) : playMode === 'loop' ? (
                <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  <text x="10" y="15" fontSize="7" fill="currentColor" stroke="none" fontWeight="700">1</text>
                </svg>
              ) : (
                <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              )}
            </button>
            <button id="prev-btn" className="ctrl-btn" onClick={prevTrack} title="上一首">
              <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>
            <button id="play-btn" className="ctrl-btn" onClick={() => { audioEngine.unlock(); togglePlay(); }} title="播放/暂停">
              {isPlaying ? (
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
                </svg>
              ) : (
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button id="next-btn" className="ctrl-btn" onClick={nextTrack} title="下一首">
              <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
            <button
              className="ctrl-btn"
              onClick={() => setQueuePanelOpen(!queuePanelOpen)}
              title="当前队列"
            >
              <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" />
                <path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
              </svg>
            </button>
          </div>

          {/* 右：歌词 + 音量 + 自动隐藏 + 沉浸 + 时间 */}
          <div className="control-cluster modes">
            {/* 歌词显示模式：多行 → 单行 → 隐藏 循环切换 */}
            <button
              className={`ctrl-btn lyrics-toggle-btn mode-${lyricMode}${lyricMode !== 'hidden' ? ' active' : ''}`}
              onClick={cycleLyricMode}
              title={
                lyricMode === 'multi' ? '歌词：多行（点击切单行）'
                : lyricMode === 'single' ? '歌词：单行（点击隐藏）'
                : '歌词：隐藏（点击恢复多行）'
              }
            >
              {lyricMode === 'multi' && (
                <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" viewBox="0 0 24 24">
                  <path d="M4 6h16" /><path d="M4 11h12" /><path d="M4 16h16" />
                </svg>
              )}
              {lyricMode === 'single' && (
                <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" viewBox="0 0 24 24">
                  <path d="M4 12h16" />
                </svg>
              )}
              {lyricMode === 'hidden' && (
                <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" viewBox="0 0 24 24">
                  <path d="M4 12h16" /><path d="M4 6.5l16 11" />
                </svg>
              )}
            </button>

            <div className={`volume-control${muted || volume === 0 ? ' muted' : ''}`}>
              <button className="ctrl-btn" onClick={toggleMuted} title="音量 / 静音">
                {muted || volume === 0 ? (
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15 9.5a4 4 0 0 1 0 5" />
                  </svg>
                ) : (
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15 9.5a4 4 0 0 1 0 5" />
                    <path d="M18.5 7a8 8 0 0 1 0 10" />
                  </svg>
                )}
              </button>
              <div className="volume-popover" onClick={(e) => e.stopPropagation()}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  style={{ flex: 1, minWidth: 0, accentColor: 'var(--fc-accent, #9db8cf)' }}
                  aria-label="音量"
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                />
                <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,.55)', minWidth: 32, textAlign: 'right' }}>
                  {Math.round((muted ? 0 : volume) * 100)}%
                </span>
              </div>
            </div>

            <button
              id="controls-hide-btn"
              className={`ctrl-btn${controlsAutoHide ? ' active' : ''}`}
              onClick={toggleControlsAutoHide}
              title="控制条自动隐藏"
            >
              <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M5 8h14" /><path d="M8 12h8" /><path d="M10 16h4" />
              </svg>
            </button>

            <button
              className={`ctrl-btn${immersive ? ' active' : ''}`}
              onClick={toggleImmersive}
              title="全沉浸式"
              aria-pressed={immersive}
            >
              <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24">
                <path d="M4 9V5a1 1 0 0 1 1-1h4" /><path d="M15 4h4a1 1 0 0 1 1 1v4" />
                <path d="M20 15v4a1 1 0 0 1-1 1h-4" /><path d="M9 20H5a1 1 0 0 1-1-1v-4" />
                <circle cx="12" cy="12" r="2.2" />
              </svg>
            </button>

            <div id="time-display">
              {formatTime(currentTime)} / {formatTime(duration)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
