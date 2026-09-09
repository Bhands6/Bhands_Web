import { useEffect, useRef, useState, useCallback } from 'react';
import {
  useSettingsStore,
  VISUAL_PRESETS,
  RenderQuality,
  ParticleEffect,
  EFFECT_LABELS,
  VisualSettings
} from '../stores/useSettingsStore';

/** 滑块行（复用桌面版 .fx-slider 样式） */
function SliderRow({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="fx-slider">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <output>{format ? format(value) : value.toFixed(2)}</output>
    </div>
  );
}

/** 分段选择（复用 .fx-seg） */
function SegRow<T extends string>({
  options,
  value,
  onChange
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="fx-seg">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={value === opt.key ? 'active' : ''}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** 颜色行（复用 .lyric-color-row + .fx-color-row-label） */
function ColorRow({
  label,
  value,
  mode,
  onPick,
  onAuto,
  autoText
}: {
  label: string;
  value: string;
  mode: 'auto' | 'custom';
  onPick: (color: string) => void;
  onAuto: () => void;
  autoText: string;
}) {
  return (
    <div className="lyric-color-row">
      <input
        className="lyric-color-picker"
        type="color"
        value={value}
        title={label}
        onChange={(e) => onPick(e.target.value)}
      />
      <div className="fx-color-row-label">
        {label}
        <small>{mode === 'auto' ? autoText : value.toUpperCase()}</small>
      </div>
      <button
        className={`fx-mini-btn ghost${mode === 'auto' ? ' active' : ''}`}
        type="button"
        onClick={onAuto}
      >
        {mode === 'auto' ? '自动' : '恢复自动'}
      </button>
    </div>
  );
}

const HOTKEY_INFO: { keys: string; desc: string }[] = [
  { keys: 'Space', desc: '播放 / 暂停' },
  { keys: '← / →', desc: '快退 / 快进 5 秒' },
  { keys: '↑ / ↓', desc: '音量增减' },
  { keys: 'L', desc: '歌词显示开关' },
  { keys: 'Esc', desc: '关闭弹层' }
];

/**
 * 视觉控制台（对应桌面版 #fx-fab + #fx-panel）
 * 入口 FAB 在顶栏 Home 按钮旁（TopCorners 渲染），面板从右上滑出；
 * 鼠标完全离开「面板 + FAB」热区才收回（含容差与拖动保护）
 */
/** LX Music 脚本管理子组件 */
function LxMusicSection() {
  const [scripts, setScripts] = useState<{ id: string; sources: string[]; active: boolean }[]>([]);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/music/parse/lx/list');
      const data = await res.json();
      if (data.success) setScripts(data.data || []);
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const script = await file.text();
      const res = await fetch('/api/music/parse/lx/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, name: file.name.replace(/\.js$/, '') })
      });
      const data = await res.json();
      if (data.success) await refresh();
      else alert(data.error || '上传失败');
    } catch { alert('上传失败'); }
    setLoading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleDelete = async (id: string) => {
    await fetch('/api/music/parse/lx/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    await refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {scripts.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
          <span style={{ flex: 1, color: 'rgba(255,255,255,.7)' }}>
            {s.sources.join(', ') || s.id}
            {s.active && <span style={{ color: '#4ade80', marginLeft: 6 }}>● 活跃</span>}
          </span>
          <button className="fx-mini-btn" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => handleDelete(s.id)}>删除</button>
        </div>
      ))}
      <label style={{ cursor: 'pointer', fontSize: 12, color: 'rgba(255,255,255,.5)', padding: '6px 0' }}>
        {loading ? '上传中…' : '+ 上传 .js 脚本'}
        <input ref={fileRef} type="file" accept=".js" style={{ display: 'none' }} onChange={handleUpload} />
      </label>
    </div>
  );
}

export default function SettingsPanel() {
  const panelOpen = useSettingsStore((s) => s.panelOpen);
  const setPanelOpen = useSettingsStore((s) => s.setPanelOpen);
  const visual = useSettingsStore((s) => s.visual);
  const lyrics = useSettingsStore((s) => s.lyrics);
  const setVisual = useSettingsStore((s) => s.setVisual);
  const setLyrics = useSettingsStore((s) => s.setLyrics);
  const applyPreset = useSettingsStore((s) => s.applyPreset);
  const resetAll = useSettingsStore((s) => s.resetAll);

  const panelRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mousePos = useRef({ x: -9999, y: -9999 });

  // 全局跟踪鼠标坐标：延时到期时校验实际位置，比纯事件模型更可靠
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // 「完全离开」判定：鼠标既不在面板热区、也不在 FAB 热区（12px 容差防贴边抖动）
  // FAB 位于 TopCorners 的顶栏内，按 id 查询
  const inKeepZone = () => {
    const tol = 12;
    const { x, y } = mousePos.current;
    const hit = (r?: DOMRect) =>
      !!r && x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol;
    return hit(panelRef.current?.getBoundingClientRect()) || hit(document.getElementById('fx-fab')?.getBoundingClientRect());
  };

  const scheduleHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // 到期时鼠标若已移回面板/FAB（或从未真正离开），保持展开
      if (!inKeepZone()) setPanelOpen(false);
    }, 400);
  };

  const cancelHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };

  // 面板离开：拖动滑块等按着键离开边界时不判定，等松手后再检查
  const handlePanelLeave = (e: React.MouseEvent) => {
    if (!panelOpen) return;
    if (e.buttons > 0) {
      const onUp = () => {
        window.removeEventListener('mouseup', onUp);
        if (!inKeepZone()) scheduleHide();
      };
      window.addEventListener('mouseup', onUp);
      return;
    }
    scheduleHide();
  };

  // FAB（位于 TopCorners）悬停意图：面板展开时悬停 FAB 保持、离开计收起
  useEffect(() => {
    if (!panelOpen) return;
    const fab = document.getElementById('fx-fab');
    if (!fab) return;
    const onEnter = () => cancelHide();
    const onLeave = () => scheduleHide();
    fab.addEventListener('mouseenter', onEnter);
    fab.addEventListener('mouseleave', onLeave);
    return () => {
      fab.removeEventListener('mouseenter', onEnter);
      fab.removeEventListener('mouseleave', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  // 当前命中的预设（参数与预设完全一致时高亮；效果形态不参与比较）
  const stripEffect = (v: VisualSettings) => {
    const { effect: _effect, ...rest } = v;
    return rest;
  };
  const activePreset = (Object.keys(VISUAL_PRESETS) as Array<keyof typeof VISUAL_PRESETS>).find(
    (key) =>
      JSON.stringify(stripEffect(VISUAL_PRESETS[key].visual as VisualSettings)) ===
      JSON.stringify(stripEffect(visual))
  );

  return (
    <>
      <div
        ref={panelRef}
        id="fx-panel"
        className={panelOpen ? 'show' : ''}
        onMouseEnter={cancelHide}
        onMouseLeave={handlePanelLeave}
      >
        <div className="fx-head">
          <div className="fx-head-main">
            <div className="fx-title">视觉控制台</div>
            <div className="fx-sub">BHANDSMUSIC WEB · 完全移开自动收起</div>
          </div>
        </div>

        <div className="fx-section-label">视觉预设</div>
        <div className="preset-grid">
          {(Object.keys(VISUAL_PRESETS) as Array<keyof typeof VISUAL_PRESETS>).map((key) => (
            <button
              key={key}
              type="button"
              className={`preset-card${activePreset === key ? ' active' : ''}`}
              onClick={() => applyPreset(key)}
            >
              <div className="pc-name">{VISUAL_PRESETS[key].name}</div>
              <div className="pc-desc">{VISUAL_PRESETS[key].desc}</div>
            </button>
          ))}
        </div>

        <div className="fx-section-label">粒子效果</div>
        <SegRow<ParticleEffect>
          options={(Object.keys(EFFECT_LABELS) as ParticleEffect[]).map((key) => ({
            key,
            label: EFFECT_LABELS[key]
          }))}
          value={visual.effect}
          onChange={(effect) => setVisual({ effect })}
        />

        <div className="fx-section-label">主控</div>
        <SliderRow
          label="律动强度"
          min={0.2} max={1.6} step={0.01}
          value={visual.intensity}
          onChange={(v) => setVisual({ intensity: v })}
        />
        <SliderRow
          label="粒子尺寸"
          min={0.5} max={2.2} step={0.01}
          value={visual.particleSize}
          onChange={(v) => setVisual({ particleSize: v })}
        />
        <SliderRow
          label="流速"
          min={0.2} max={2.5} step={0.01}
          value={visual.flowSpeed}
          onChange={(v) => setVisual({ flowSpeed: v })}
        />
        <SliderRow
          label="背景透明度"
          min={0} max={1} step={0.01}
          value={visual.backgroundOpacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setVisual({ backgroundOpacity: v })}
        />

        <div className="fx-section-label">视觉主色</div>
        <ColorRow
          label="视觉主色"
          value={visual.tintColor}
          mode={visual.tintMode}
          autoText="封面取色"
          onPick={(color) => setVisual({ tintColor: color, tintMode: 'custom' })}
          onAuto={() => setVisual({ tintMode: 'auto' })}
        />

        <div className="fx-section-label">画质档位</div>
        <SegRow<RenderQuality>
          options={[
            { key: 'eco', label: '低' },
            { key: 'balanced', label: '中' },
            { key: 'high', label: '高' },
            { key: 'ultra', label: '超高' }
          ]}
          value={visual.renderQuality}
          onChange={(q) => setVisual({ renderQuality: q })}
        />

        <div className="fx-section-label">叠加效果</div>
        <div className="fx-toggle-grid">
          <div
            className={`fx-toggle${visual.dustLayer ? ' on' : ''}`}
            onClick={() => setVisual({ dustLayer: !visual.dustLayer })}
          >
            <span>浮空粒子层</span>
            <span className="dot" />
          </div>
        </div>

        <div className="fx-fold open">
          <div className="fx-fold-body">
            <div className="fx-section-label">歌词外观</div>
            <SliderRow
              label="歌词大小"
              min={0.35} max={1.65} step={0.01}
              value={lyrics.scale}
              onChange={(v) => setLyrics({ scale: v })}
            />
            <SliderRow
              label="字重"
              min={500} max={900} step={50}
              value={lyrics.weight}
              format={(v) => String(v)}
              onChange={(v) => setLyrics({ weight: v })}
            />
            <SliderRow
              label="字间距"
              min={0} max={8} step={0.5}
              value={lyrics.letterSpacing}
              format={(v) => `${v}px`}
              onChange={(v) => setLyrics({ letterSpacing: v })}
            />
            <SliderRow
              label="溢光强度"
              min={0} max={1.6} step={0.05}
              value={lyrics.glowStrength}
              onChange={(v) => setLyrics({ glowStrength: v })}
            />
            <ColorRow
              label="歌词颜色"
              value={lyrics.color}
              mode={lyrics.colorMode}
              autoText="封面取色渐变"
              onPick={(color) => setLyrics({ color, colorMode: 'custom' })}
              onAuto={() => setLyrics({ colorMode: 'auto' })}
            />
          </div>
        </div>

        <div className="fx-fold open">
          <div className="fx-fold-body">
            <div className="fx-section-label">快捷键</div>
            <div className="fx-toggle-grid" style={{ gridTemplateColumns: '1fr' }}>
              {HOTKEY_INFO.map((h) => (
                <div
                  key={h.keys}
                  className="fx-toggle"
                  style={{ cursor: 'default', justifyContent: 'space-between' }}
                >
                  <span>{h.desc}</span>
                  <span style={{ color: 'rgba(0,245,212,.72)', fontSize: '10.5px', letterSpacing: '.5px' }}>
                    {h.keys}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ---- LX Music 脚本管理 ---- */}
        <div className="fx-fold open">
          <div className="fx-fold-body">
            <div className="fx-section-label">LX Music 音源脚本</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)', marginBottom: 8, lineHeight: 1.5 }}>
              上传 LX Music 格式的 .js 音源脚本，可解锁更多解析通道。
              脚本从 GitHub 搜索 <b>lx-music-source</b> 获取。
            </div>
            <LxMusicSection />
          </div>
        </div>

        <div className="fx-actions">
          <button className="fx-mini-btn" type="button" onClick={resetAll}>
            恢复默认
          </button>
        </div>
      </div>
    </>
  );
}
