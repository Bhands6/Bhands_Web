import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AudioAnalyserData } from './AudioEngine';

/**
 * 集成测试：用桩件驱动真实 AudioEngine，验证
 *   <audio> 频谱 → beatAnalyser(低平滑) → 节拍判定 → beatClock → analyserData.beatPulseSmooth
 * 这条链路确实能产出非零脉冲（历史上因「单一高平滑分析器」导致恒为 0）。
 */

type Cb = () => void;

class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  /** 桩件注入的「本帧低频能量」（0-255） */
  value = 0;
  connect(): void {}
  disconnect(): void {}
  getByteFrequencyData(arr: Uint8Array): void {
    arr.fill(this.value);
  }
  getByteTimeDomainData(arr: Uint8Array): void {
    arr.fill(128);
  }
}

class FakeGain {
  gain = { value: 1 };
  connect(): void {}
  disconnect(): void {}
}
class FakeSource {
  connect(): void {}
  disconnect(): void {}
}

const analysers: FakeAnalyser[] = [];

class FakeCtx {
  sampleRate = 44100;
  state = 'running';
  destination = {};
  createAnalyser(): FakeAnalyser {
    const a = new FakeAnalyser();
    analysers.push(a); // [0] 视觉分析器，[1] 节拍分析器
    return a;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createMediaElementSource(): FakeSource {
    return new FakeSource();
  }
  close(): void {}
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAudioEl {
  src = '';
  currentTime = 0;
  duration = 100;
  preload = '';
  crossOrigin = '';
  private listeners = new Map<string, Cb[]>();
  addEventListener(type: string, cb: Cb): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, cb: Cb): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== cb));
  }
  dispatch(type: string): void {
    [...(this.listeners.get(type) ?? [])].forEach((cb) => cb());
  }
  load(): void {
    queueMicrotask(() => this.dispatch('canplay'));
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

let rafQueue: FrameRequestCallback[] = [];
/** 可控时钟：jsdom 的 performance.now() 从 0 起，会让「距上拍间隔」判定失效 */
let fakeNow = 10_000;
function pumpFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    fakeNow += 16;
    const queue = rafQueue;
    rafQueue = [];
    queue.forEach((cb) => cb(fakeNow));
  }
}

beforeEach(() => {
  analysers.length = 0;
  rafQueue = [];
  fakeNow = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
  (globalThis as unknown as { Audio: unknown }).Audio = function () {
    return new FakeAudioEl();
  };
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
});

async function startEngine(): Promise<{ payloads: AudioAnalyserData[] }> {
  vi.resetModules();
  const { audioEngine } = await import('./AudioEngine');

  const payloads: AudioAnalyserData[] = [];
  audioEngine.setOnAnalyserData((d) => payloads.push(d));

  audioEngine.unlock();
  await audioEngine.loadTrack({
    id: 't1',
    name: 'n',
    artist: 'a',
    album: 'al',
    duration: 100,
    url: '/fake',
    cover: ''
  });
  audioEngine.play();
  await Promise.resolve();
  await Promise.resolve();
  pumpFrames(1); // 让第一个 rAF 进入循环
  return { payloads };
}

describe('AudioEngine 实时节拍链路（频谱 → 低平滑节拍分析器 → beatClock）', () => {
  it('底鼓瞬态可触发实时节拍，产出非零 beatPulseSmooth', async () => {
    const { payloads } = await startEngine();

    const visual = analysers[0];
    const beat = analysers[1];
    expect(visual).toBeTruthy();
    expect(beat).toBeTruthy();
    // 关键：节拍分析器必须是低平滑的独立节点（否则瞬态被抹平，永远检测不到拍）
    expect(beat.smoothingTimeConstant).toBeLessThan(0.2);
    expect(beat).not.toBe(visual);

    // 先跑足够长的安静底噪，让慢速基线收敛（否则静音→有声的过渡会连续误触发）
    visual.value = 40;
    for (let f = 0; f < 40; f++) {
      beat.value = 30;
      pumpFrames(1);
    }
    expect(payloads.length).toBeGreaterThan(10);
    expect(payloads[payloads.length - 1].beatPulse).toBe(0);

    // 注入一帧强底鼓
    beat.value = 220;
    pumpFrames(1);

    const last = payloads[payloads.length - 1];
    expect(last.beatPulse).toBe(1);
    expect(last.beatHit).toBe(true);
    expect(last.beatPulseSmooth).toBeGreaterThan(0);
  });

  it('无节拍映射时实时兜底也不为 0（脉冲封顶 0.46）', async () => {
    const { payloads } = await startEngine();
    const beat = analysers[1];
    for (let f = 0; f < 40; f++) {
      beat.value = 30;
      pumpFrames(1);
    }
    beat.value = 220;
    pumpFrames(1);

    const last = payloads[payloads.length - 1];
    expect(last.beatPulseSmooth).toBeGreaterThan(0.3);
    expect(last.beatPulseSmooth).toBeLessThanOrEqual(0.46);
  });
});
