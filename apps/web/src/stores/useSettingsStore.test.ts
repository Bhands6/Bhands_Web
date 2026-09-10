import { describe, it, expect } from 'vitest';
import {
  clampLyricOffset,
  LYRIC_OFFSET_LIMIT,
  clampLyricBackdrop,
  LYRIC_BACKDROP_DEFAULT,
  LYRIC_BACKDROP_MAX,
  EFFECT_LABELS,
  EFFECT_PRESET_INDEX,
  ParticleEffect
} from './useSettingsStore';

describe('clampLyricOffset（歌词时间偏移规范化）', () => {
  it('非有限值回退 0', () => {
    expect(clampLyricOffset(undefined)).toBe(0);
    expect(clampLyricOffset(null)).toBe(0);
    expect(clampLyricOffset('abc')).toBe(0);
    expect(clampLyricOffset(NaN)).toBe(0);
    expect(clampLyricOffset(Infinity)).toBe(0);
  });

  it('超界钳制到 ±2s', () => {
    expect(clampLyricOffset(9)).toBe(LYRIC_OFFSET_LIMIT);
    expect(clampLyricOffset(-9)).toBe(-LYRIC_OFFSET_LIMIT);
  });

  it('范围内原样保留（含负值=歌词提前）', () => {
    expect(clampLyricOffset(0.35)).toBe(0.35);
    expect(clampLyricOffset(-0.5)).toBe(-0.5);
    expect(clampLyricOffset('0.2')).toBe(0.2);
  });
});

describe('clampLyricBackdrop（歌词衬底强度规范化）', () => {
  it('缺失/非法回退默认值（1.0），而不是 0 —— 避免旧数据把衬底悄悄关掉', () => {
    expect(clampLyricBackdrop(undefined)).toBe(LYRIC_BACKDROP_DEFAULT);
    expect(clampLyricBackdrop(null)).toBe(LYRIC_BACKDROP_DEFAULT);
    expect(clampLyricBackdrop('abc')).toBe(LYRIC_BACKDROP_DEFAULT);
    expect(clampLyricBackdrop(NaN)).toBe(LYRIC_BACKDROP_DEFAULT);
    expect(clampLyricBackdrop(Infinity)).toBe(LYRIC_BACKDROP_DEFAULT);
  });

  it('0 必须保留（滑块最左 = 完全关闭衬底）', () => {
    expect(clampLyricBackdrop(0)).toBe(0);
    expect(clampLyricBackdrop('0')).toBe(0);
  });

  it('超界钳制到 0~1.6', () => {
    expect(clampLyricBackdrop(-3)).toBe(0);
    expect(clampLyricBackdrop(99)).toBe(LYRIC_BACKDROP_MAX);
  });

  it('范围内原样保留', () => {
    expect(clampLyricBackdrop(0.45)).toBe(0.45);
    expect(clampLyricBackdrop('1.2')).toBe(1.2);
  });
});

/**
 * 粒子效果枚举一致性。
 * 顶点着色器是按 `uPreset < N.5` 的区间分派的，所以序号必须从 0 开始、连续无空洞、且唯一；
 * 漏配一个序号会让 uPreset 变成 undefined → NaN，静默落进错误的 else 分支（很难查）。
 */
describe('粒子效果枚举与 shader 预设序号', () => {
  const keys = Object.keys(EFFECT_LABELS) as ParticleEffect[];

  it('每个效果都有标签与序号', () => {
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const k of keys) {
      expect(EFFECT_LABELS[k]).toBeTruthy();
      expect(Number.isInteger(EFFECT_PRESET_INDEX[k])).toBe(true);
    }
  });

  it('序号唯一、从 0 开始且连续无空洞', () => {
    const idx = keys.map((k) => EFFECT_PRESET_INDEX[k]).sort((a, b) => a - b);
    expect(new Set(idx).size).toBe(idx.length);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(keys.length - 1);
  });

  it('新增的极光/万花筒/迸发已登记且排在桌面版 6 个预设之后', () => {
    expect(EFFECT_LABELS.aurora).toBe('极光');
    expect(EFFECT_LABELS.kaleido).toBe('万花筒');
    expect(EFFECT_LABELS.burst).toBe('迸发');
    expect(EFFECT_PRESET_INDEX.aurora).toBe(6);
    expect(EFFECT_PRESET_INDEX.kaleido).toBe(7);
    expect(EFFECT_PRESET_INDEX.burst).toBe(8);
  });
});
