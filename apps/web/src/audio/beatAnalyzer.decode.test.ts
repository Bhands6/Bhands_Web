import { describe, it, expect, beforeEach, vi } from 'vitest';
import { analyzeTrackBeatMap, clearBeatMapCache } from './beatAnalyzer';

/**
 * 回归测试：离线节拍分析的解码路径。
 *
 * 历史 bug：用 `new OfflineAudioContext(1, 1, 22050)` 借它重采样解码，在部分 Chrome 上
 * 既不 resolve 也不 reject（长期停在 decoding），导致 BeatMap 永远装载不上、完全没有节拍效果。
 * 现改为与桌面版一致：普通 `AudioContext` + decodeAudioData（原生采样率）。
 */

/** 桩件解码出的音频时长（秒），由用例设置 */
let bufferSeconds = 12;

class FakeCtx {
  sampleRate = 44100;
  state = 'running';
  async decodeAudioData(_data: ArrayBuffer): Promise<FakeAudioBuffer> {
    return new FakeAudioBuffer(bufferSeconds);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 120 BPM（0.5s 一拍）的合成底鼓波形，便于检出网格 */
class FakeAudioBuffer {
  sampleRate = 44100;
  numberOfChannels = 1;
  length: number;
  duration: number;
  private data: Float32Array;
  constructor(seconds = 12) {
    this.length = seconds * this.sampleRate;
    this.duration = seconds;
    this.data = new Float32Array(this.length);
    for (let i = 0; i < this.length; i++) {
      const t = i / this.sampleRate;
      const ph = t % 0.5;
      const env = Math.exp(-ph * 18);
      this.data[i] = env * Math.sin(2 * Math.PI * 60 * t) * 0.9 + Math.sin(2 * Math.PI * 3000 * t) * 0.02 * Math.exp(-ph * 60);
    }
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

beforeEach(() => {
  bufferSeconds = 12;
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
  // 明确断开 OfflineAudioContext：若实现回退到它，本测试必须失败
  (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = class {
    constructor() {
      throw new Error('不应使用 OfflineAudioContext 解码（会在部分 Chrome 上挂起）');
    }
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1024)
    }))
  );
  clearBeatMapCache();
});

describe('analyzeTrackBeatMap 解码路径（对齐桌面版）', () => {
  it('用普通 AudioContext 解码并产出节拍图', async () => {
    const map = await analyzeTrackBeatMap('decode-ok', '/fake.wav', 12);
    expect(map).toBeTruthy();
    expect(map!.beats.length).toBeGreaterThan(10);
    expect(map!.pulseBeats.length).toBeGreaterThan(0);
  });

  it('解码失败时返回 null（不抛出、不阻塞）', async () => {
    class BadCtx extends FakeCtx {
      async decodeAudioData(): Promise<never> {
        throw new Error('decode-broken');
      }
    }
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = BadCtx;

    const map = await analyzeTrackBeatMap('decode-bad', '/fake.wav', 12);
    expect(map).toBeNull();
  });

  /**
   * 回归：能量提取循环的「让出事件循环」判定。
   * 旧写法 `(processed & YIELD_EVERY) === YIELD_EVERY` 只保留第 21 位，
   * 在 processed ∈ [2^21, 2^22) 区间内**每个样本**都成立 → 连续 200 万次 setTimeout(0)，
   * 整曲分析要跑数小时（离线节拍图永远做不出来）。故必须有 >2^21 样本的用例覆盖。
   */
  it('超过 2^21 样本的长音频不会卡死（让出判定回归）', async () => {
    bufferSeconds = 60; // 60s @44.1kHz = 2,646,000 样本 > 2^21
    const started = Date.now();
    const map = await analyzeTrackBeatMap('decode-long', '/fake.wav', 60);
    const elapsed = Date.now() - started;

    expect(map).toBeTruthy();
    expect(map!.beats.length).toBeGreaterThan(50);
    // 有该 bug 时这里会耗时以小时/分钟计（测试将超时失败）
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);
});
