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
};

/**
 * Web Audio 音频引擎
 * - AudioContext 延迟到首次用户手势后创建（浏览器自动播放策略）
 * - 复用单个 <audio> 元素与 MediaElementSource，避免每次切歌泄漏节点
 */
export class AudioEngine {
  private audioContext: AudioContext | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;

  private frequencyData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private timeDomainData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private bassHistory: number[] = [];

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

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.state.muted ? 0 : this.state.volume;

      this.analyser.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeDomainData = new Uint8Array(this.analyser.frequencyBinCount);

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
    if (!this.analyser) return;

    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeDomainData);

    const bass = this.calculateBandEnergy(this.frequencyData, 0, 8);
    const mid = this.calculateBandEnergy(this.frequencyData, 8, 96);
    const treble = this.calculateBandEnergy(this.frequencyData, 96, 280);
    const energy = bass * 0.5 + mid * 0.35 + treble * 0.15;

    // 低频能量滚动均值 → 节拍脉冲（超过均值一定比例算一拍）
    this.bassHistory.push(bass);
    if (this.bassHistory.length > 48) this.bassHistory.shift();
    const avg = this.bassHistory.reduce((a, b) => a + b, 0) / this.bassHistory.length;
    const beatPulse = bass > avg * 1.32 && bass > 0.12 ? 1 : 0;

    this.onAnalyserData?.({
      frequencyData: this.frequencyData,
      timeDomainData: this.timeDomainData,
      bass,
      mid,
      treble,
      energy,
      beatPulse
    });
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
