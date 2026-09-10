export interface AudioTrack {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  url: string;
  cover: string;
  source?: string;
  resolvedQuality?: string;
}

export interface AudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  loading: boolean;
  error: string | null;
}

export type AudioAnalyserData = {
  frequencyData: Uint8Array;
  timeDomainData: Uint8Array;
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  beatPulse: number;
  /** 离线节拍映射驱动的平滑脉冲（0..1，桌面版 beatPulse 等效物；无映射时退化为实时分析） */
  beatPulseSmooth: number;
  /** 本帧命中新节拍（一次性） */
  beatHit: boolean;
  /** 本帧命中的是否为强拍（离线节拍的 downbeat/accent 或高 strength）；供「跟随强拍」的视觉用 */
  beatStrong: boolean;
};

/**
 * Web Audio 音频引擎
 * - AudioContext 延迟到首次用户手势后创建（浏览器自动播放策略）
 * - 复用单个 <audio> 元素与 MediaElementSource，避免每次切歌泄漏节点
 */
import { beatClock } from './beatClock';

export class AudioEngine {
  private audioContext: AudioContext | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** 节拍检测专用分析器（低平滑，与桌面版 beatAnalyser 一致） */
  private beatAnalyser: AnalyserNode | null = null;
  /** 节拍分析器的零增益汇点：保证其分支被音频图渲染（否则频谱恒为 0） */
  private beatSink: GainNode | null = null;
  private gainNode: GainNode | null = null;

  private frequencyData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private timeDomainData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private beatFrequencyData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  /** 低频慢速基线（≈0.4s EMA），用于 onset 上升沿判定；-1 表示尚未初始化 */
  private beatSlowAvg = -1;
  private lastAnalyserAt = 0;
  private lastTimeSyncAt = 0;
  private lastBeatAt = 0;

  private state: AudioState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    loading: false,
    error: null
  };

  private onStateChange: ((state: AudioState) => void) | null = null;
  private onAnalyserData: ((data: AudioAnalyserData) => void) | null = null;
  private onTrackEnd: (() => void) | null = null;

  private animationFrame: number | null = null;

  /** 首次用户手势时调用，解锁 AudioContext */
  public unlock(): void {
    this.ensureContext();
  }

  private ensureContext(): boolean {
    if (this.audioContext) return true;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new Ctx();

      // 视觉分析器（对齐桌面版 analyser：fftSize 2048 / smoothing 0.58）
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.58;

      // 节拍检测专用分析器（对齐桌面版 beatAnalyser：smoothing 0.10）
      // 必须与视觉分析器分开：smoothingTimeConstant 是逐帧指数平滑，
      // 0.8 会把底鼓的瞬态峰值抹平，低频能量永远超不过滚动均值 →
      // 实时节拍检测彻底失效（这正是「没有节拍/歌词溢光」的根因）。
      this.beatAnalyser = this.audioContext.createAnalyser();
      this.beatAnalyser.fftSize = 2048;
      this.beatAnalyser.smoothingTimeConstant = 0.10;

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.state.muted ? 0 : this.state.volume;

      // 节拍分析器必须被音频图「拉动」才会更新频谱数据：
      // 仅 source.connect(beatAnalyser) 而不接下游时，部分浏览器不会渲染该分支，
      // 频谱恒为 0 → 实时节拍永久失效。经零增益节点接入 destination，
      // 既保证被渲染，又不会把音频重复叠加到输出。
      this.beatSink = this.audioContext.createGain();
      this.beatSink.gain.value = 0;
      this.beatAnalyser.connect(this.beatSink);
      this.beatSink.connect(this.audioContext.destination);

      this.analyser.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeDomainData = new Uint8Array(this.analyser.frequencyBinCount);
      this.beatFrequencyData = new Uint8Array(this.beatAnalyser.frequencyBinCount);

      // 复用单个 audio 元素
      this.audioElement = new Audio();
      this.audioElement.crossOrigin = 'anonymous';
      this.audioElement.preload = 'auto';

      this.audioElement.addEventListener('loadedmetadata', () => {
        if (this.audioElement) {
          this.state.duration = this.audioElement.duration || 0;
          this.notifyStateChange();
        }
      });

      this.audioElement.addEventListener('timeupdate', () => {
        if (this.audioElement) {
          this.state.currentTime = this.audioElement.currentTime;
          this.notifyStateChange();
        }
      });

      this.audioElement.addEventListener('ended', () => {
        this.state.isPlaying = false;
        this.notifyStateChange();
        this.onTrackEnd?.();
      });

      this.audioElement.addEventListener('error', () => {
        this.state.loading = false;
        this.state.error = '音频加载失败，可能是版权或网络限制';
        this.notifyStateChange();
      });

      return true;
    } catch (error) {
      console.error('Failed to initialize audio engine:', error);
      this.state.error = '音频引擎初始化失败';
      this.notifyStateChange();
      return false;
    }
  }

  public async loadTrack(track: AudioTrack): Promise<void> {
    if (!this.ensureContext() || !this.audioElement) {
      throw new Error('Audio engine not initialized');
    }
    if (!track.url) {
      throw new Error('缺少播放地址');
    }

    // 同一个元素切歌：只换 src，不重建 source 节点
    if (!this.source && this.audioContext) {
      this.source = this.audioContext.createMediaElementSource(this.audioElement);
      this.source.connect(this.analyser!);
      // 节拍分析器不接下游（仅分析，与桌面版一致），避免音频信号被重复累加到输出
      this.source.connect(this.beatAnalyser!);
    }

    return new Promise((resolve, reject) => {
      this.state.loading = true;
      this.state.error = null;
      this.notifyStateChange();

      const el = this.audioElement!;
      const onCanPlay = () => {
        cleanup();
        this.state.loading = false;
        this.state.duration = el.duration || 0;
        this.notifyStateChange();
        resolve();
      };
      const onError = () => {
        cleanup();
        this.state.loading = false;
        this.state.error = '音频加载失败，可能是版权或网络限制';
        this.notifyStateChange();
        reject(new Error(this.state.error));
      };
      const cleanup = () => {
        el.removeEventListener('canplay', onCanPlay);
        el.removeEventListener('error', onError);
      };

      el.addEventListener('canplay', onCanPlay, { once: true });
      el.addEventListener('error', onError, { once: true });

      el.src = track.url;
      el.load();
    });
  }

  public play(): void {
    if (!this.audioElement || !this.audioContext) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    this.audioElement.play().then(() => {
      this.state.isPlaying = true;
      this.notifyStateChange();
      this.startAnalyserLoop();
    }).catch(() => {
      this.state.error = '播放被浏览器拦截，请再点一次播放';
      this.notifyStateChange();
    });
  }

  public pause(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.state.isPlaying = false;
      this.notifyStateChange();
      this.stopAnalyserLoop();
    }
  }

  public togglePlay(): void {
    if (this.state.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public setVolume(volume: number): void {
    this.state.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.state.muted ? 0 : this.state.volume;
    }
    this.notifyStateChange();
  }

  public setMuted(muted: boolean): void {
    this.state.muted = muted;
    if (this.gainNode) {
      this.gainNode.gain.value = muted ? 0 : this.state.volume;
    }
    this.notifyStateChange();
  }

  public toggleMuted(): void {
    this.setMuted(!this.state.muted);
  }

  public seek(time: number): void {
    if (this.audioElement) {
      this.audioElement.currentTime = Math.max(0, Math.min(time, this.state.duration || time));
      this.state.currentTime = this.audioElement.currentTime;
      this.notifyStateChange();
    }
  }

  public getCurrentTime(): number {
    return this.audioElement?.currentTime || 0;
  }

  public getDuration(): number {
    return this.audioElement?.duration || 0;
  }

  public getState(): AudioState {
    return { ...this.state };
  }

  public setOnStateChange(callback: (state: AudioState) => void): void {
    this.onStateChange = callback;
  }

  public setOnAnalyserData(callback: (data: AudioAnalyserData) => void): void {
    this.onAnalyserData = callback;
  }

  public setOnTrackEnd(callback: () => void): void {
    this.onTrackEnd = callback;
  }

  private startAnalyserLoop(): void {
    if (this.animationFrame) return;
    const loop = () => {
      if (!this.state.isPlaying) {
        this.animationFrame = null;
        return;
      }
      this.updateAnalyserData();
      this.animationFrame = requestAnimationFrame(loop);
    };
    this.animationFrame = requestAnimationFrame(loop);
  }

  private stopAnalyserLoop(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  private updateAnalyserData(): void {
    if (!this.analyser || !this.beatAnalyser) return;

    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeDomainData);

    const bass = this.calculateBandEnergy(this.frequencyData, 0, 8);
    const mid = this.calculateBandEnergy(this.frequencyData, 8, 96);
    const treble = this.calculateBandEnergy(this.frequencyData, 96, 280);
    const energy = bass * 0.5 + mid * 0.35 + treble * 0.15;

    // 节拍检测走低平滑分析器：底鼓瞬态才能形成明显尖峰（见 ensureContext 注释）
    this.beatAnalyser.getByteFrequencyData(this.beatFrequencyData);
    const beatBass = this.calculateBandEnergy(this.beatFrequencyData, 0, 8);

    const now = performance.now();

    // 低频能量上升沿检测（对应桌面版 realtimeBeat 的 onset 思路）：
    // 旧实现用「高于 0.8s 滚动均值 1.32 倍」判定，对低频持续（bassline/电子乐）几乎不可能触发。
    // 改为慢速基线(~0.4s EMA) + 上升量/相对尖峰双条件，显著提升命中率。
    if (this.beatSlowAvg < 0) this.beatSlowAvg = beatBass;
    this.beatSlowAvg += (beatBass - this.beatSlowAvg) * 0.05;
    const rise = beatBass - this.beatSlowAvg;

    // 最小间隔 180ms：限制连击上限（≈333 BPM）
    const beatPulse =
      (rise > 0.04 || beatBass > this.beatSlowAvg * 1.25) &&
      beatBass > 0.10 &&
      now - this.lastBeatAt > 180
        ? 1
        : 0;
    if (beatPulse) this.lastBeatAt = now;

    // 节拍时钟：离线 BeatMap 游标驱动平滑脉冲（无映射时由上面的实时二值节拍兜底）
    // 时间必须直读 audioElement.currentTime：state.currentTime 由 timeupdate 事件更新
    // （Chrome 约 250ms 一次），按它推进游标会让节拍触发滞后/量化 250ms，与音频对不上
    const dt = this.lastAnalyserAt ? Math.min(0.1, (now - this.lastAnalyserAt) / 1000) : 0.016;
    this.lastAnalyserAt = now;
    beatClock.tick(this.audioElement?.currentTime ?? this.state.currentTime, dt, beatPulse === 1, this.state.isPlaying);

    // 播放进度主动同步（约 8Hz）：timeupdate 只有 ~4Hz，最差滞后 250ms；
    // 歌词已按 rAF 级实时进度推进，若进度条/时间显示仍用滞后值，会被误判成「歌词超前」。
    if (now - this.lastTimeSyncAt >= 120) {
      this.lastTimeSyncAt = now;
      const t = this.audioElement?.currentTime ?? this.state.currentTime;
      if (t !== this.state.currentTime) {
        this.state.currentTime = t;
        this.notifyStateChange();
      }
    }

    this.onAnalyserData?.({
      frequencyData: this.frequencyData,
      timeDomainData: this.timeDomainData,
      bass,
      mid,
      treble,
      energy,
      beatPulse,
      beatPulseSmooth: beatClock.pulse,
      beatHit: beatClock.hitFlag,
      beatStrong: beatClock.hitFlag && beatClock.lastHitStrong
    });
    beatClock.hitFlag = false;
  }

  private calculateBandEnergy(data: Uint8Array, start: number, end: number): number {
    let sum = 0;
    const stop = Math.min(end, data.length);
    const length = Math.max(1, stop - start);
    for (let i = start; i < stop; i++) {
      sum += data[i] / 255;
    }
    return sum / length;
  }

  private notifyStateChange(): void {
    this.onStateChange?.({ ...this.state });
  }

  public destroy(): void {
    this.stopAnalyserLoop();
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.src = '';
      this.audioElement = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

// 创建单例（不再在 import 时创建 AudioContext）
export const audioEngine = new AudioEngine();
