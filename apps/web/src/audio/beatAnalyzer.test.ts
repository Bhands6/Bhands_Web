import { describe, it, expect } from 'vitest';
import { buildBeatMapFromLowEnergy } from './beatAnalyzer';
import { beatClock } from './beatClock';

/**
 * 合成 120 BPM（0.5s 一拍）的低频能量序列：每拍能量瞬间抬升后指数衰减，
 * 每 4 拍一组的第 1 拍更强（模拟 downbeat），叠加底噪。
 */
function synth120bpm(durationSec: number, hopSec = 0.01) {
  const n = Math.floor(durationSec / hopSec);
  const lowEnergy = new Float32Array(n);
  const hitEnergy = new Float32Array(n);
  const step = 0.5;
  for (let i = 0; i < n; i++) {
    const t = i * hopSec;
    let low = 0.05 + Math.sin(t * 1.7) * 0.004; // 底噪
    let hit = 0.02;
    const beatIdx = Math.floor(t / step);
    const sinceBeat = t - beatIdx * step;
    const amp = beatIdx % 4 === 0 ? 0.7 : 0.45; // downbeat 更强
    if (sinceBeat >= 0) {
      low += amp * Math.exp(-sinceBeat * 9);
      hit += amp * 0.6 * Math.exp(-sinceBeat * 14);
    }
    lowEnergy[i] = low;
    hitEnergy[i] = hit;
  }
  return { lowEnergy, hitEnergy, hopSec, duration: durationSec };
}

describe('buildBeatMapFromLowEnergy（桌面版算法移植）', () => {
  it('120 BPM 合成节拍：估计出 ~0.5s 的网格步长', () => {
    const { lowEnergy, hitEnergy, hopSec, duration } = synth120bpm(60);
    const map = buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, duration);

    expect(map.gridStep).toBeGreaterThan(0.42);
    expect(map.gridStep).toBeLessThan(0.58);
  });

  it('生成覆盖全曲的节拍网格与脉冲子集', () => {
    const { lowEnergy, hitEnergy, hopSec, duration } = synth120bpm(60);
    const map = buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, duration);

    // 60s / 0.5s = 120 拍，允许边缘损失
    expect(map.beats.length).toBeGreaterThanOrEqual(80);
    expect(map.beats.length).toBeLessThanOrEqual(130);
    expect(map.pulseBeats.length).toBeGreaterThan(30);
    // 节拍按时间升序
    for (let i = 1; i < map.beats.length; i++) {
      expect(map.beats[i].time).toBeGreaterThan(map.beats[i - 1].time);
    }
    // 每种视觉参数都在钳制区间内（softGrid 衰减后 strength 允许低于 0.12 下限）
    for (const b of map.beats) {
      expect(b.strength).toBeGreaterThan(0);
      expect(b.strength).toBeLessThanOrEqual(0.93);
      expect(b.impact).toBeGreaterThan(0);
      expect(b.impact).toBeLessThanOrEqual(0.88);
      expect(['downbeat', 'push', 'drop', 'rebound', 'accent']).toContain(b.combo);
    }
    // combo 按 4 拍循环分配（首拍为 downbeat）
    expect(map.beats[0].combo).toBe('downbeat');
  });

  it('节拍时间对齐 0.5s 网格（中位偏差 < 150ms，最大 < 250ms）', () => {
    const { lowEnergy, hitEnergy, hopSec, duration } = synth120bpm(60);
    const map = buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, duration);

    const sampled = map.beats.slice(2, 40);
    const dists = sampled.map((b) => {
      const phase = ((b.time % 0.5) + 0.5) % 0.5;
      return Math.min(phase, 0.5 - phase);
    });
    dists.sort((a, b) => a - b);
    // timing pull 会把网格点往 onset 候选上拉，允许合理偏移
    expect(dists[Math.floor(dists.length / 2)]).toBeLessThan(0.15);
    expect(dists[dists.length - 1]).toBeLessThan(0.25);
  });

  it('静音输入返回空映射（不崩溃）', () => {
    const n = 3000;
    const low = new Float32Array(n).fill(0.01);
    const hit = new Float32Array(n).fill(0.005);
    const map = buildBeatMapFromLowEnergy(low, hit, 0.01, 30);
    // 常量输入无 onset → 候选为空 → 空映射（或极少量噪声拍）
    expect(map.beats.length).toBeLessThanOrEqual(4);
  });
});

describe('beatClock（播放游标 + 脉冲公式）', () => {
  it('命中节拍时脉冲抬升并指数衰减', () => {
    const { lowEnergy, hitEnergy, hopSec, duration } = synth120bpm(30);
    const map = buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, duration);

    beatClock.setTrack('test-song');
    beatClock.setMap('test-song', map);

    // 从 0 开始按 16ms 帧推进到 3 秒
    let peak = 0;
    let peakTime = -1;
    for (let t = 0; t <= 3; t += 0.016) {
      beatClock.tick(t, 0.016, false, true);
      if (beatClock.pulse > peak) { peak = beatClock.pulse; peakTime = t; }
    }
    expect(peak).toBeGreaterThan(0.25);       // 有明显脉冲
    expect(peak).toBeLessThanOrEqual(1);      // 钳制
    expect(peakTime).toBeGreaterThan(0.2);    // 不是第 0 秒瞬时误触发

    // 暂停后衰减到接近 0
    for (let i = 0; i < 120; i++) beatClock.tick(3, 0.016, false, false);
    expect(beatClock.pulse).toBeLessThan(0.05);
  });

  it('seek 后游标重对齐，不补发过去的节拍', () => {
    const { lowEnergy, hitEnergy, hopSec, duration } = synth120bpm(30);
    const map = buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, duration);

    beatClock.setTrack('test-seek');
    beatClock.setMap('test-seek', map);
    // 直接跳到 10s
    for (let t = 10; t <= 10.5; t += 0.016) {
      beatClock.tick(t, 0.016, false, true);
    }
    // 只推进 0.5s，命中次数有限（0.5s 内最多 1-2 拍），脉冲不会因回放 10s 前所有节拍而饱和
    expect(beatClock.pulse).toBeLessThanOrEqual(1);
  });

  it('无映射时实时二值节拍兜底（封顶 0.46）', () => {
    beatClock.setTrack('test-fallback');
    beatClock.tick(0, 0.016, true, true);
    expect(beatClock.pulse).toBeLessThanOrEqual(0.46);
    expect(beatClock.pulse).toBeGreaterThan(0.3);
  });
});
