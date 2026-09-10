/**
 * 节拍时钟：离线 BeatMap 的播放期游标（移植桌面版 tickBeatMap/triggerScheduledBeat）。
 *
 * 每帧 tick(currentTime, dt)：
 *  - 推进 pulseBeats 游标，命中节拍按桌面版公式计算脉冲强度
 *  - 脉冲指数衰减（0.36^dt），与实时分析兜底取 max
 * 消费方（StageLyrics 歌词溢光、body.beat-pulse）读取 pulse 连续值。
 */
import type { BeatMap, BeatEvent } from './beatAnalyzer';

const clampRange = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

class BeatClock {
  private map: BeatMap | null = null;
  private trackId: string | null = null;
  private nextIdx = 0;
  private lastT = -1;

  /** 平滑节拍脉冲（0..1 连续值，桌面版 beatPulse） */
  public pulse = 0;
  /** 本帧是否命中新节拍（一次性标志，消费后由 tick 复位） */
  public hitFlag = false;
  /**
   * 本帧命中的是否为「强拍」：离线节拍按每 4 拍分类 combo，
   * downbeat（小节第一拍）/ accent（重音）或 strength ≥ 0.62 视为强拍。
   * 供视觉层「跟随强拍」（如迸发预设优先落在强拍上）。实时兜底路径恒为 false。
   */
  public lastHitStrong = false;
  private scheduledPulse = 0;

  /** 切歌：重置游标；返回值表示是否换了曲目 */
  setTrack(trackId: string | null): void {
    if (trackId === this.trackId) return;
    this.trackId = trackId;
    this.map = null;
    this.nextIdx = 0;
    this.lastT = -1;
    this.pulse = 0;
    this.scheduledPulse = 0;
  }

  /** 分析完成：装入节拍映射并把游标对齐到当前播放位置 */
  setMap(trackId: string, map: BeatMap): void {
    if (trackId !== this.trackId) return; // 曲目已切换，丢弃过期结果
    this.map = map.pulseBeats.length ? map : null;
    this.resync(this.lastT < 0 ? 0 : this.lastT);
  }

  private resync(t: number): void {
    this.nextIdx = 0;
    const events = this.map?.pulseBeats;
    if (events) {
      while (this.nextIdx < events.length && events[this.nextIdx].time <= t) this.nextIdx++;
    }
  }

  /**
   * 每帧调用。
   * @param t 当前播放位置（秒）
   * @param dt 距上帧时间（秒）
   * @param realtimeOn 实时分析的二值节拍（未离线分析时的兜底，对应桌面版 live fallback）
   * @param isPlaying 是否播放中
   */
  tick(t: number, dt: number, realtimeOn: boolean, isPlaying: boolean): void {
    // seek 检测：时间大幅回跳/前跳时重对齐游标；首帧（lastT<0）同样重对齐，
    // 避免恢复会话（分析完成于暂停态、游标停在 0）后一次性补发所有历史节拍
    if (this.lastT < 0 || Math.abs(t - this.lastT) > 0.75) this.resync(t);
    this.lastT = t;
    // 每帧从零重建「本帧强拍」标记，避免消费方读到上一帧的残留值
    this.lastHitStrong = false;

    if (!isPlaying) {
      this.pulse *= 0.82;
      this.scheduledPulse = 0;
      return;
    }

    // ---- 离线节拍：命中即按桌面版公式计算脉冲 ----
    const events = this.map?.pulseBeats;
    if (events) {
      while (this.nextIdx < events.length && events[this.nextIdx].time <= t) {
        const beat = events[this.nextIdx++];
        const p = this.triggerScheduledBeat(beat);
        if (p > 0) {
          this.scheduledPulse = Math.max(this.scheduledPulse, p);
          this.hitFlag = true;
          const st = clampRange(beat.strength ?? 0.42, 0, 1);
          this.lastHitStrong = beat.combo === 'downbeat' || beat.combo === 'accent' || st >= 0.62;
        }
      }
    }

    // ---- 实时兜底：与离线映射取 max 合并（对应桌面版实时引擎 + beatmap 的合并语义，非互斥）----
    // 离线分析可能拉流/解码失败或与音源存在对齐差；实时 onset 保证任何情况下都有律动。
    if (realtimeOn) {
      this.scheduledPulse = Math.max(this.scheduledPulse, 0.46);
      this.hitFlag = true;
    }

    // ---- 衰减与合并（桌面版：0.36^dt 与 0.32^dt）----
    this.pulse *= Math.pow(0.36, dt);
    if (this.scheduledPulse > this.pulse) this.pulse = this.scheduledPulse;
    this.scheduledPulse *= Math.pow(0.32, dt);
    this.pulse = Math.min(1, this.pulse);
  }

  /** 桌面版 triggerScheduledBeat 移植（dj 分支公式） */
  private triggerScheduledBeat(beat: BeatEvent): number {
    const strength = clampRange(beat.strength ?? 0.42, 0, 1);
    const impact = clampRange(beat.impact ?? strength, 0, 1);
    // 弱拍门限（桌面版：impact < 0.18 且 strength < 0.52 直接跳过）
    if (impact < 0.18 && strength < 0.52) return 0;

    const combo = beat.combo;
    const comboLift = combo === 'downbeat' ? 0.08 : combo === 'drop' ? 0.04 : 0;
    // 桌面版 cameraDynamicsScale 在 web 简化为固定曲线（无镜头动力学用户系数）
    const dynScale = clampRange(0.88 + impact * 0.16, 0.78, 1.18);
    const pulse = Math.min(0.92, (0.12 + strength * 0.5 + impact * 0.28 + comboLift * 0.7) * dynScale);
    return pulse;
  }
}

export const beatClock = new BeatClock();
