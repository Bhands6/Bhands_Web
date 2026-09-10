/**
 * 离线节拍分析器 —— 完整移植桌面版 dj-analyzer.js 的核心算法。
 *
 * 流程（与桌面版一致）：
 *  1. 拉取音频 → decodeAudioData 解码为原生采样率的 AudioBuffer（单声道混合）
 *  2. 全采样率逐样本级联双二阶滤波（32Hz 高通 → 178Hz 低通，底鼓频段）
 *  3. 每 10ms 一帧计算低频 RMS（lowEnergy）与峰值（hitEnergy）
 *  4. buildBeatMapFromLowEnergy：起音检测 → 自适应阈值峰检 → 直方图节拍间隔估计
 *     → 网格对齐（相位评分）→ 每 4 拍 combo 分类（downbeat/push/drop/rebound/accent）
 *     → 生成 strength/impact/low/body/snap 等视觉参数
 *
 * 运行时消费见 beatClock.ts：pulseBeats 游标 + 桌面版 triggerScheduledBeat 脉冲公式。
 */

// ============================================================
// 工具函数（桌面版原样移植）
// ============================================================
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number(v) || 0));
}
function clampRange(v: number, min: number, max: number): number {
  v = Number(v) || 0;
  return Math.max(min, Math.min(max, v));
}
function percentile(arr: ArrayLike<number>, p: number, maxSamples = 16000): number {
  const len = arr ? arr.length : 0;
  if (!len) return 0.001;
  let sample: number[];
  if (len <= maxSamples) {
    sample = Array.prototype.slice.call(arr);
  } else {
    sample = new Array(maxSamples);
    const step = (len - 1) / (maxSamples - 1);
    for (let i = 0; i < maxSamples; i++) sample[i] = arr[Math.min(len - 1, Math.floor(i * step))] || 0;
  }
  sample.sort((a, b) => a - b);
  return sample[Math.max(0, Math.min(sample.length - 1, Math.floor(sample.length * p)))] || 0.001;
}
function median(vals: number[]): number {
  vals = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
}

// ============================================================
// IIR 双二阶滤波器（Audio EQ Cookbook 标准实现）
// ============================================================
interface BiquadState { b0: number; b1: number; b2: number; a1: number; a2: number; x1: number; x2: number; y1: number; y2: number }

function makeBiquad(type: 'highpass' | 'lowpass', freq: number, q: number, sr: number): BiquadState {
  freq = Math.max(8, Math.min(freq, sr * 0.45));
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * (q || 0.707));
  let b0: number, b1: number, b2: number;
  if (type === 'highpass') {
    b0 = (1 + cos) * 0.5;
    b1 = -(1 + cos);
    b2 = (1 + cos) * 0.5;
  } else {
    b0 = (1 - cos) * 0.5;
    b1 = 1 - cos;
    b2 = (1 - cos) * 0.5;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const inv = 1 / a0;
  return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function runBiquad(st: BiquadState, x: number): number {
  const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
  st.x2 = st.x1;
  st.x1 = x;
  st.y2 = st.y1;
  st.y1 = y;
  return y;
}

// ============================================================
// 类型
// ============================================================
export type BeatCombo = 'downbeat' | 'push' | 'drop' | 'rebound' | 'accent';

export interface BeatEvent {
  time: number;
  strength: number;
  confidence: number;
  impact: number;
  primary: boolean;
  camera: boolean;
  pulse: boolean;
  low: number;
  body: number;
  snap: number;
  mass: number;
  sharpness: number;
  combo: BeatCombo;
  step: number;
  index: number;
  dj: true;
}

export interface BeatMap {
  kicks: number[];
  beats: BeatEvent[];
  pulseBeats: BeatEvent[];
  cameraBeats: BeatEvent[];
  gridStep: number;
  sectionSteps: number[];
  tempoSource: string;
  duration: number;
  visualBeatCount: number;
  analyzedAt: number;
}

interface Candidate {
  frame: number;
  time: number;
  score: number;
  lowTone: number;
  hitTone: number;
  lowRel: number;
  raw: number;
  power: number;
}

// ============================================================
// 核心节拍映射构建（桌面版原样移植）
// ============================================================
export function buildBeatMapFromLowEnergy(
  lowEnergy: Float32Array | number[],
  hitEnergy: Float32Array | number[],
  hopSec: number,
  durationSec: number
): BeatMap {
  const nFrames = Math.min(lowEnergy.length, hitEnergy.length);

  if (nFrames < 20) {
    return emptyMap(durationSec, 'web-empty');
  }

  function bandAt(arr: ArrayLike<number>, idx: number): number {
    idx = Math.max(0, Math.min(nFrames - 1, idx | 0));
    const a = arr[Math.max(0, idx - 1)] || 0;
    const b = arr[idx] || 0;
    const c = arr[Math.min(nFrames - 1, idx + 1)] || 0;
    return (a + b * 2 + c) * 0.25;
  }

  const lowFloor = Math.max(0.0004, percentile(lowEnergy, 0.22));
  const lowMid = Math.max(lowFloor + 0.0002, percentile(lowEnergy, 0.58));
  const lowRef = Math.max(lowMid + 0.0002, percentile(lowEnergy, 0.86));
  const lowCeil = Math.max(lowRef + 0.0004, percentile(lowEnergy, 0.96));
  const hitRef = Math.max(0.0004, percentile(hitEnergy, 0.86));

  /* ---- 起音检测（onset）---- */
  const onset = new Float32Array(nFrames);
  for (let i = 4; i < nFrames; i++) {
    const prev = lowEnergy[i - 1] * 0.62 + lowEnergy[i - 2] * 0.28 + lowEnergy[i - 3] * 0.10;
    const lowRise = Math.max(0, (lowEnergy[i] || 0) - prev);
    const wideRise = Math.max(0, ((lowEnergy[i] || 0) + (lowEnergy[i - 1] || 0)) * 0.5 - ((lowEnergy[i - 3] || 0) + (lowEnergy[i - 4] || 0)) * 0.5);
    const peakRise = Math.max(0, (hitEnergy[i] || 0) - (hitEnergy[i - 2] || 0) * 0.84);
    onset[i] = lowRise * 1.72 + wideRise * 0.86 + peakRise * 0.10;
  }

  /* ---- 峰值检测（滑动窗口自适应阈值）---- */
  const winN = Math.max(52, Math.round(0.82 / hopSec));
  const minFrameGap = Math.max(18, Math.round(0.215 / hopSec));
  const candidates: Candidate[] = [];

  let sumO = 0;
  let sqO = 0;
  for (let i = 0; i < winN; i++) {
    const o = onset[i] || 0;
    sumO += o;
    sqO += o * o;
  }

  for (let f = winN + 4; f < nFrames - 4; f++) {
    const mean = sumO / winN;
    const std = Math.sqrt(Math.max(0, sqO / winN - mean * mean));
    const th = mean + std * 1.66 + lowRef * 0.0038;
    const o = onset[f];

    if (o > th && o >= onset[f - 1] && o > onset[f + 1]) {
      let peakF = f;
      let peakScore = o + lowEnergy[f] * 0.10;
      for (let pf = f - 2; pf <= f + 3; pf++) {
        const ps = (onset[pf] || 0) + (lowEnergy[pf] || 0) * 0.10;
        if (ps > peakScore) {
          peakScore = ps;
          peakF = pf;
        }
      }

      const lowTone = Math.min(2.6, bandAt(lowEnergy, peakF) / lowRef);
      const hitTone = Math.min(2.6, bandAt(hitEnergy, peakF) / hitRef);
      const lowRel = clamp01((bandAt(lowEnergy, peakF) - lowFloor) / Math.max(0.0001, lowCeil - lowFloor));
      const score = (o - th) / Math.max(0.0006, std + mean * 0.38 + lowRef * 0.012);

      if (score > 0.16 && (lowTone > 0.32 || lowRel > 0.22 || hitTone > 0.52)) {
        const cand: Candidate = { frame: peakF, time: peakF * hopSec, score, lowTone, hitTone, lowRel, raw: o, power: 0 };
        cand.power =
          cand.score * 0.56 +
          Math.pow(clamp01((cand.lowTone - 0.22) / 1.42), 0.82) * 0.34 +
          Math.min(1.5, cand.hitTone) * 0.08 +
          cand.lowRel * 0.10;

        const last = candidates[candidates.length - 1];
        if (last && cand.frame - last.frame < minFrameGap) {
          if (cand.power > last.power) candidates[candidates.length - 1] = cand;
        } else {
          candidates.push(cand);
        }
      }
    }

    const old = onset[f - winN] || 0;
    const next = onset[f] || 0;
    sumO += next - old;
    sqO += next * next - old * old;
  }

  if (!candidates.length) {
    return emptyMap(durationSec || nFrames * hopSec, 'web-empty');
  }

  /* ---- 候选点筛选 ---- */
  const powers = candidates.map((c) => c.power);
  const p30 = percentile(powers, 0.30);
  const p50 = percentile(powers, 0.50);
  void p50;
  const p90 = Math.max(p50 + 0.001, percentile(powers, 0.90));
  void p90;
  const p96 = Math.max(p90 + 0.001, percentile(powers, 0.965));
  let strong = candidates.filter((c) => c.power >= p50 && c.lowTone > 0.34);
  if (strong.length < 16) strong = candidates.slice();

  /* ---- 节拍间隔估计（直方图）---- */
  function estimateStep(list: Candidate[]): number {
    if (!list || list.length < 3) return 0;
    const bin = 0.006;
    const hist: Record<number, number> = {};
    const medGaps: number[] = [];

    for (let ai = 0; ai < list.length; ai++) {
      for (let bi = ai + 1; bi < list.length && bi < ai + 10; bi++) {
        const rawGap = list[bi].time - list[ai].time;
        if (rawGap < 0.24) continue;
        if (rawGap > 2.55) break;

        for (let div = 1; div <= 6; div++) {
          const g = rawGap / div;
          if (g < 0.31) break;
          if (g > 0.86) continue;
          const weight = Math.sqrt(Math.max(0.001, list[ai].power * list[bi].power)) / Math.sqrt((bi - ai) * div);
          const key = Math.round(g / bin);
          hist[key] = (hist[key] || 0) + weight;
          medGaps.push(g);
        }
      }
    }

    let bestKey: number | null = null;
    let bestScore = 0;
    Object.keys(hist).forEach((k) => {
      const key = parseInt(k, 10);
      const score = (hist[key] || 0) + (hist[key - 1] || 0) * 0.72 + (hist[key + 1] || 0) * 0.72;
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    });

    if (bestKey != null) return bestKey * bin;
    return median(medGaps);
  }

  let globalStep = estimateStep(strong) || estimateStep(candidates) || 0.5;
  globalStep = clampRange(globalStep, 0.32, 0.86);

  /* ---- 网格对齐 ---- */
  function nearestCandidate(center: number, windowSec: number, startIdx: number): Candidate | null {
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    let j = startIdx || 0;
    while (j < candidates.length && candidates[j].time < center - windowSec) j++;
    for (let ni = j; ni < candidates.length && candidates[ni].time <= center + windowSec; ni++) {
      const dist = Math.abs(candidates[ni].time - center);
      const score = candidates[ni].power * (1 - (dist / Math.max(0.001, windowSec)) * 0.42);
      if (score > bestScore) {
        best = candidates[ni];
        bestScore = score;
      }
    }
    return best;
  }

  function scorePhase(anchorTime: number, step: number): number {
    let start = anchorTime;
    while (start - step > 0.05) start -= step;
    const end = Math.min(durationSec || nFrames * hopSec, 180);
    const win = Math.max(0.055, Math.min(0.125, step * 0.18));
    let score = 0;
    let count = 0;
    let cursor = 0;

    for (let gt = start; gt < end; gt += step) {
      while (cursor < candidates.length && candidates[cursor].time < gt - win) cursor++;
      let bestScore = 0;
      for (let pi = cursor; pi < candidates.length && candidates[pi].time <= gt + win; pi++) {
        const dist = Math.abs(candidates[pi].time - gt);
        const s = candidates[pi].power * (1 - (dist / win) * 0.44);
        if (s > bestScore) bestScore = s;
      }
      score += bestScore ? bestScore : -p30 * 0.08;
      count++;
    }
    return count ? score / count : -Infinity;
  }

  let phaseSource = strong.filter((c) => c.time < Math.min(durationSec || nFrames * hopSec, 180)).slice(0, 72);
  if (!phaseSource.length) phaseSource = strong.slice(0, 1);
  let bestAnchor = phaseSource[0] ? phaseSource[0].time : 0;
  let bestAnchorScore = -Infinity;

  for (let i = 0; i < phaseSource.length; i++) {
    const score = scorePhase(phaseSource[i].time, globalStep);
    if (score > bestAnchorScore) {
      bestAnchorScore = score;
      bestAnchor = phaseSource[i].time;
    }
  }

  const halfStep = globalStep * 0.5;
  if (halfStep >= 0.31) {
    const halfScore = scorePhase(bestAnchor, halfStep);
    if (halfScore > bestAnchorScore * 1.04) globalStep = halfStep;
  }

  let anchor = bestAnchor;
  while (anchor - globalStep > 0.05) anchor -= globalStep;

  /* ---- 分段节拍间隔 ---- */
  const duration = durationSec || nFrames * hopSec;
  const sectionLen = duration > 3600 ? 96 : 72;
  const sectionCount = Math.max(1, Math.ceil(duration / sectionLen));
  const sectionSteps: number[] = [];

  for (let si = 0; si < sectionCount; si++) {
    const t0 = si * sectionLen;
    const t1 = Math.min(duration, t0 + sectionLen);
    const seg = strong.filter((c) => c.time >= t0 && c.time < t1);
    const prevStep = sectionSteps.length ? sectionSteps[sectionSteps.length - 1] : globalStep;
    let localStep = estimateStep(seg) || prevStep || globalStep;

    if (prevStep) localStep = clampRange(localStep, prevStep * 0.94, prevStep * 1.06);
    if (globalStep) localStep = clampRange(localStep, globalStep * 0.86, globalStep * 1.14);

    sectionSteps.push(prevStep ? localStep * 0.3 + prevStep * 0.7 : localStep);
  }

  function stepAt(time: number): number {
    const idx = Math.max(0, Math.min(sectionSteps.length - 1, Math.floor(time / sectionLen)));
    return sectionSteps[idx] || globalStep || 0.5;
  }

  /* ---- 节拍网格生成 ---- */
  const beats: BeatEvent[] = [];
  let gridIndex = 0;
  let cursorIdx = 0;

  for (let gridT = anchor; gridT < duration - 0.04; ) {
    const localStep = stepAt(gridT) || globalStep || 0.5;
    const winSec = Math.max(0.06, Math.min(0.135, localStep * 0.2));

    while (cursorIdx < candidates.length && candidates[cursorIdx].time < gridT - winSec) cursorIdx++;
    const bestCand = nearestCandidate(gridT, winSec, cursorIdx);

    const gf = Math.max(0, Math.min(nFrames - 1, Math.round(gridT / hopSec)));
    const gridLow = bandAt(lowEnergy, gf);
    const gridHit = bandAt(hitEnergy, gf);
    const gridLowTone = Math.min(2.6, gridLow / lowRef);
    const gridHitTone = Math.min(2.6, gridHit / hitRef);
    const lowTone = bestCand ? Math.max(gridLowTone * 0.62, bestCand.lowTone) : gridLowTone;
    const hitTone = bestCand ? Math.max(gridHitTone * 0.62, bestCand.hitTone) : gridHitTone;

    const distPenalty = bestCand ? 1 - Math.min(1, Math.abs(bestCand.time - gridT) / winSec) * 0.26 : 0.54;
    const basePower = bestCand ? bestCand.power * distPenalty : gridLowTone * 0.25 + gridHitTone * 0.06;
    const powerRel = clamp01((basePower - p30 * 0.78) / Math.max(0.001, p96 - p30 * 0.78));
    const lowRel = clamp01((gridLow - lowFloor) / Math.max(0.0001, lowCeil - lowFloor));
    const kickRel = clamp01(powerRel * 0.74 + lowRel * 0.22 + clamp01((hitTone - 0.26) / 1.7) * 0.04);

    const softGrid = (!bestCand && lowRel < 0.2) || kickRel < 0.16;

    const slot = gridIndex % 4;
    let combo: BeatCombo = slot === 0 ? 'downbeat' : slot === 1 ? 'push' : slot === 2 ? 'drop' : 'rebound';
    if (kickRel > 0.84 && combo !== 'downbeat') combo = 'accent';

    const visualRel = kickRel > 0.76 ? 0.76 + (kickRel - 0.76) * 0.52 : kickRel;
    const downLift = combo === 'downbeat' ? (visualRel > 0.18 ? 0.016 + visualRel * 0.036 : visualRel * 0.028) : 0;
    const sectionGate = clamp01((kickRel - 0.1) / 0.58);

    let impact = Math.max(0.02, Math.min(0.88, 0.022 + Math.pow(visualRel, 1.62) * 0.86 + downLift));
    let strength = Math.max(0.12, Math.min(0.93, 0.13 + Math.pow(visualRel, 1.12) * 0.68 + downLift * 0.7));

    if (softGrid) {
      const softMul = combo === 'downbeat' ? 0.48 : 0.3;
      impact *= softMul;
      strength *= 0.58 + sectionGate * 0.22;
    }

    const timingPull = bestCand ? 0.24 + clamp01((kickRel - 0.25) / 0.65) * 0.46 : 0;
    const sourceTime = bestCand ? gridT * (1 - timingPull) + bestCand.time * timingPull : gridT;

    const cameraActive = impact >= 0.13 || (combo === 'downbeat' && kickRel >= 0.14) || (!!bestCand && kickRel >= 0.18);

    const lowMix = Math.max(0.42, Math.min(0.9, 0.52 + visualRel * 0.32 + lowTone * 0.035 - (combo === 'accent' ? 0.1 : 0)));
    const bodyMix = Math.max(0.035, Math.min(0.54, 0.06 + visualRel * 0.12 + (combo === 'push' ? 0.18 : 0) + (combo === 'drop' ? 0.24 : 0)));
    const snapMix = Math.max(0.015, Math.min(0.62, 0.026 + (combo === 'accent' ? 0.4 : 0) + (combo === 'rebound' ? 0.08 : 0) + visualRel * 0.038));

    beats.push({
      time: sourceTime,
      strength,
      confidence: Math.max(0.44, Math.min(0.99, 0.46 + kickRel * 0.43 + (bestCand ? 0.08 : -0.03))),
      impact,
      primary: cameraActive,
      camera: cameraActive,
      pulse: impact > 0.16 || (combo === 'downbeat' && kickRel >= 0.18),
      low: lowMix,
      body: bodyMix,
      snap: snapMix,
      mass: Math.max(0.36, Math.min(0.94, lowMix * 0.72 + Math.pow(visualRel, 1.22) * 0.24)),
      sharpness: Math.max(0.03, Math.min(0.28, snapMix * 1.18)),
      combo,
      step: localStep,
      index: beats.length,
      dj: true
    });

    gridIndex++;
    gridT += localStep;
  }

  const cameraBeats = beats.filter((b) => b.camera !== false);
  const pulseBeats = beats.filter((b) => b.pulse !== false && (b.impact >= 0.16 || b.combo === 'downbeat'));

  return {
    kicks: beats.map((b) => b.time),
    beats,
    pulseBeats,
    cameraBeats,
    gridStep: globalStep,
    sectionSteps,
    tempoSource: 'web-offline-low-grid',
    duration,
    visualBeatCount: cameraBeats.length,
    analyzedAt: Date.now()
  };
}

function emptyMap(durationSec: number, source: string): BeatMap {
  return {
    kicks: [],
    beats: [],
    pulseBeats: [],
    cameraBeats: [],
    gridStep: 0,
    sectionSteps: [],
    tempoSource: source,
    duration: durationSec || 0,
    visualBeatCount: 0,
    analyzedAt: Date.now()
  };
}

// ============================================================
// Web 端音频解码与能量提取（对应桌面版 decodePodcastDjEnergyRange）
// ============================================================

/**
 * 解码音频为 AudioBuffer（原生采样率）。
 *
 * 必须用普通 AudioContext，与桌面版一致（`new AudioContext()` + decodeAudioData）。
 * 早期 Web 实现用 `new OfflineAudioContext(1, 1, 22050)` 借它把音频重采样到 22050Hz，
 * 但「length=1 + 非标准 sampleRate」的 OfflineAudioContext 解码在部分 Chrome 上
 * 既不 resolve 也不 reject（实测长期停在 decoding 阶段）——
 * 这正是离线节拍映射一直装载不上、进而完全没有节拍效果的原因。
 *
 * 解码失败/超时返回 null，调用方退回实时节拍兜底。
 */
const DECODE_TIMEOUT_MS = 12_000;

/** 降级分析时最多拉取的首段字节数（≈ 1.4MB ≈ 1~2 分钟 192kbps 音频，足够建立节拍网格） */
const ANALYSIS_PREFIX_BYTES = 1_400_000;

async function decodeAudioBuffer(raw: ArrayBuffer): Promise<AudioBuffer | null> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const decoded = await Promise.race([
      ctx.decodeAudioData(raw.slice(0)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('decode-timeout')), DECODE_TIMEOUT_MS)
      )
    ]);
    return decoded;
  } finally {
    // 解码完成（或超时）即释放，避免长时间占用音频输出上下文
    void ctx.close?.().catch(() => {});
  }
}

/**
 * 提取音频的低频/高频能量帧序列。
 * 与桌面版一致：全采样率逐样本滤波（32Hz 高通 → 178Hz 低通级联），每 10ms 一帧，RMS + 峰值。
 * 注意：不可先抽取再滤波 —— 无抗混叠的降采样会把 5.5k~11kHz 能量折返进低频段，
 * 污染底鼓频段导致节拍网格错位；biquad 代价极低，逐样本处理与桌面版等效。
 * 长音频分块处理并周期性让出事件循环，避免阻塞 UI。
 */
async function extractEnergyFrames(
  buffer: AudioBuffer,
  hopSec: number
): Promise<{ lowEnergy: Float32Array; hitEnergy: Float32Array; frames: number; hopSec: number }> {
  const chL = buffer.getChannelData(0);
  const chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = buffer.length;
  const sr = buffer.sampleRate;

  const hopSize = Math.max(80, Math.floor(sr * hopSec));
  const hp = makeBiquad('highpass', 32, 0.72, sr);
  const lp = makeBiquad('lowpass', 178, 0.82, sr);

  const lowEnergy = new Float32Array(Math.ceil(n / hopSize) + 2);
  const hitEnergy = new Float32Array(lowEnergy.length);
  let frameIdx = 0;
  let frameSum = 0;
  let framePeak = 0;
  let frameCount = 0;

  const YIELD_EVERY = 1 << 21; // 每 ~2M 样本让出一次
  let sinceYield = 0;

  for (let i = 0; i < n; i++) {
    const x = chR ? ((chL[i] || 0) + (chR[i] || 0)) * 0.5 : chL[i] || 0;
    const y = runBiquad(lp, runBiquad(hp, x));
    const ay = y < 0 ? -y : y;
    frameSum += y * y;
    if (ay > framePeak) framePeak = ay;
    frameCount++;
    if (frameCount >= hopSize) {
      lowEnergy[frameIdx] = Math.sqrt(frameSum / Math.max(1, frameCount));
      hitEnergy[frameIdx] = framePeak;
      frameIdx++;
      frameSum = 0;
      framePeak = 0;
      frameCount = 0;
    }
    // 让出事件循环，避免阻塞 UI。
    // 注意：必须用递增计数器判断，不能写 `(processed & YIELD_EVERY) === YIELD_EVERY` ——
    // 按位与会丢掉高位，导致 processed ∈ [2^21, 2^22) 区间内**连续 200 万次**都成立、
    // 每样本 await 一次 setTimeout(0)（Chrome 钳到 ~4ms），整曲分析实际要跑数小时，
    // 表现为离线节拍图永远做不出来（老代码里状态长期停在 decoding 的就是这个原因）。
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (frameCount > 0) {
    lowEnergy[frameIdx] = Math.sqrt(frameSum / Math.max(1, frameCount));
    hitEnergy[frameIdx] = framePeak;
    frameIdx++;
  }

  // 帧长按样本取整后真实 hop 会略小于请求值（如 44.1kHz 下 0.01s → 441 样本恰为 0.01s，
  // 但 22.05kHz 下是 220 样本 = 0.009977s）。把**实际** hop 回传做 帧号→时间 换算，
  // 保证任何采样率下都不会产生系统性节拍漂移（漂移会让脉冲打在错误时刻、律动错位）。
  return {
    lowEnergy: lowEnergy.subarray(0, frameIdx),
    hitEnergy: hitEnergy.subarray(0, frameIdx),
    frames: frameIdx,
    hopSec: hopSize / sr
  };
}

// ============================================================
// 对外入口：按曲目分析（带缓存与并发去重）
// ============================================================
const cache = new Map<string, BeatMap>();
const inFlight = new Map<string, Promise<BeatMap | null>>();
const CACHE_MAX = 8;

export async function analyzeTrackBeatMap(trackId: string, url: string, durationHint = 0): Promise<BeatMap | null> {
  const cached = cache.get(trackId);
  if (cached) return cached;
  const running = inFlight.get(trackId);
  if (running) return running;

  const task = (async (): Promise<BeatMap | null> => {
    try {
      if (!url) return null;
      const hopSec = durationHint > 4200 ? 0.0125 : 0.01;

      // 一轮分析：拉取（可选只取首段）→ 解码 → 能量帧 → 节拍图
      // 单轮失败（含解码超时）只返回 null，让调用方继续降级，不中断整条链
      const attempt = async (maxBytes?: number): Promise<BeatMap | null> => {
        try {
          const headers = maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : undefined;
          const resp = await fetch(url, headers ? { headers } : undefined);
          if (!resp.ok) return null;
          const raw = await resp.arrayBuffer();

          const buffer = await decodeAudioBuffer(raw);
          if (!buffer) return null;

          const { lowEnergy, hitEnergy, hopSec: actualHopSec } = await extractEnergyFrames(buffer, hopSec);
          // 用实际 hop 换算时间，避免帧长取整导致的节拍漂移
          return buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, actualHopSec, buffer.duration);
        } catch {
          return null;
        }
      };

      // ① 先整曲（节拍图覆盖最全）；② 整曲解码超时/失败/无拍时，退回只分析文件首段
      //    （整曲过大或 Ogg 多流/尾部异常时 decodeAudioData 可能长期不返回；
      //     首段足以建立节拍网格，之后段落由实时节拍兜底，且大幅省流量与限流压力）
      let map = await attempt();
      if (!map || !map.pulseBeats.length) {
        const prefixed = await attempt(ANALYSIS_PREFIX_BYTES);
        if (prefixed) map = prefixed;
      }

      if (!map) {
        console.warn('[BeatAnalyzer] 离线节拍分析失败，退回实时节拍兜底');
        return null;
      }
      if (!map.pulseBeats.length) {
        console.warn('[BeatAnalyzer] 未检出可信节拍，本次退回实时节拍兜底');
      } else {
        console.info(
          `[BeatAnalyzer] 离线节拍就绪: 曲目 ${trackId}，拍点 ${map.beats.length} / 脉冲 ${map.pulseBeats.length}，网格步长 ${map.gridStep.toFixed(3)}s`
        );
      }

      if (cache.size >= CACHE_MAX) {
        // 简单淘汰：删最早的 key
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(trackId, map);
      return map;
    } catch (err) {
      // 解码失败（格式不支持/网络中断/CORS 等）：返回 null，调用方保持实时分析兜底
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[BeatAnalyzer] 离线节拍分析失败，退回实时节拍兜底:', msg);
      return null;
    } finally {
      inFlight.delete(trackId);
    }
  })();

  inFlight.set(trackId, task);
  return task;
}

/** 测试/切歌清理 */
export function clearBeatMapCache(): void {
  cache.clear();
}
