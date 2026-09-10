import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { probeAudio, acceptProbe, isDurationPlausible } from './durationProbe';

/**
 * 时长校验阈值：用于剔除「同名但版本不符」的第三方音源（翻唱/伴奏/串烧）。
 * 阈值偏宽松，避免误杀现场版/加长版等合理差异；探测不到时长必须放行（fail-open）。
 */
describe('isDurationPlausible（音源时长校验）', () => {
  it('探测不到时长时放行（避免误杀可用音源）', () => {
    expect(isDurationPlausible(null, 200_000)).toBe(true);
  });

  it('期望时长缺失时放行', () => {
    expect(isDurationPlausible(120, 0)).toBe(true);
  });

  it('完全一致 / 小幅差异（<10s 且 <8%）放行', () => {
    expect(isDurationPlausible(296, 296_000)).toBe(true);
    expect(isDurationPlausible(230, 233_000)).toBe(true); // 差 3s
    expect(isDurationPlausible(320, 320_000)).toBe(true);
  });

  it('实测错配案例必须拦下', () => {
    // 海屿你：期望 296s，错配成 72s 的短片段
    expect(isDurationPlausible(72, 296_000)).toBe(false);
    // 还是会想你：期望 190s，错配成 240s
    expect(isDurationPlausible(240, 190_000)).toBe(false);
  });

  it('阈值取 max(10s, 期望×8%)：长歌允许更大绝对差', () => {
    // 600s 的歌：8% = 48s，50s 差异应判不符、45s 应放行
    expect(isDurationPlausible(645, 600_000)).toBe(true);
    expect(isDurationPlausible(652, 600_000)).toBe(false);
  });
});

// ============================================================
// probeAudio / acceptProbe
// 用假的 fetch 驱动真实探测器，锁死三类关键行为：
//  ① MP3 必须按**真实采样率**换算（48kHz 文件曾因写死 44100 而高估 8.8% → 误杀正确音源）
//  ② 返回 HTML/JSON 的「伪成功」地址必须判为 not-audio 并拒绝
//  ③ 网络取不到数据仍要放行（fail-open）
// ============================================================

const realFetch = globalThis.fetch;

/** 构造 MP3 帧头：默认 MPEG1 / LayerIII / 48000Hz / 128kbps */
function mp3FrameHeader(verBits = 3, layerBits = 1, srIdx = 1, brIdx = 9): Buffer {
  const b2 = 0xe0 | (verBits << 3) | (layerBits << 1) | 1; // 保护位=1（无 CRC）
  const b3 = (brIdx << 4) | (srIdx << 2);
  return Buffer.from([0xff, b2, b3, 0x00]);
}

/** 构造带 Xing/Info 总帧数的 MP3（帧数决定时长） */
function buildMp3(frames: number, srIdx = 1): Buffer {
  const hdr = mp3FrameHeader(3, 1, srIdx, 9);
  const tag = Buffer.alloc(4 + 4 + 4 + 64);
  tag.write('Info', 0, 'latin1');
  tag.writeUInt32BE(1, 4);        // flags: 含总帧数
  tag.writeUInt32BE(frames, 8);   // 总帧数
  return Buffer.concat([hdr, tag]);
}

/** 构造 FLAC：STREAMINFO 里的采样率与总采样数决定时长 */
function buildFlac(sampleRate: number, totalSamples: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.write('fLaC', 0, 'latin1');
  const packed = (BigInt(sampleRate) << 44n) | (2n << 41n) | (16n << 36n) | BigInt(totalSamples);
  buf.writeBigUInt64BE(packed, 18);
  return buf;
}

function id3v2(payload: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 3; // 版本
  const n = payload.length;
  head[6] = (n >> 21) & 0x7f;
  head[7] = (n >> 14) & 0x7f;
  head[8] = (n >> 7) & 0x7f;
  head[9] = n & 0x7f;
  return Buffer.concat([head, payload]);
}

function stubFetch(handler: (url: string) => Buffer | null): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    const body = handler(url);
    if (!body) {
      return {
        ok: false, status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
        body: { cancel: () => {} }
      };
    }
    return {
      ok: true, status: 206,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-range' ? `bytes 0-${body.length - 1}/${body.length}` : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      body: { cancel: () => {} }
    };
  };
}

beforeEach(() => { /* 每个用例自行 stub */ });
afterEach(() => { (globalThis as unknown as { fetch: unknown }).fetch = realFetch; });

describe('probeAudio（容器识别与时长解析）', () => {
  it('MP3 按真实采样率换算：48kHz 与 44.1kHz 结果必须不同', async () => {
    // 12000 帧 × 1152 样本/帧 ÷ 48000 = 288s；若按 44100 算会得到 313.5s（高估 8.8%）
    stubFetch(() => buildMp3(12000, 1)); // srIdx=1 → 48000Hz
    const r48 = await probeAudio('http://x/48k.mp3');
    expect(r48.status).toBe('ok');
    expect(r48.durationSec).toBeCloseTo(288, 1);

    stubFetch(() => buildMp3(12000, 0)); // srIdx=0 → 44100Hz
    const r441 = await probeAudio('http://x/44k.mp3');
    expect(r441.durationSec).toBeCloseTo((12000 * 1152) / 44100, 1);

    // 关键回归：两者必须不同，且 48k 结果不能被算成 44.1k 的值
    expect(r48.durationSec).not.toBeCloseTo(r441.durationSec as number, 0);
    expect(r48.durationSec).toBeLessThan(300);
  });

  it('不会被 ID3 元数据里的同名串欺骗（帧头之后才找 Xing/Info）', async () => {
    // ID3 内放一个假的 Info（帧数极大），真实帧头之后才是正确的 Info
    const decoy = Buffer.alloc(300);
    decoy.write('Info', 0, 'latin1');
    decoy.writeUInt32BE(1, 4);
    decoy.writeUInt32BE(9_999_999, 8); // 若被采信 → 时长巨大
    const real = buildMp3(12000, 1);   // → 288s
    // ID3 标签只含诱饵，真实 MP3 紧随其后
    stubFetch(() => Buffer.concat([id3v2(decoy), real]));

    const r = await probeAudio('http://x/withid3.mp3');
    expect(r.status).toBe('ok');
    expect(r.durationSec).toBeCloseTo(288, 1);
  });

  it('FLAC 从 STREAMINFO 读取时长', async () => {
    stubFetch(() => buildFlac(44100, 44100 * 200));
    const r = await probeAudio('http://x/a.flac');
    expect(r.status).toBe('ok');
    expect(r.kind).toBe('flac');
    expect(r.durationSec).toBeCloseTo(200, 1);
  });

  it('返回 JSON / HTML 的「伪成功」地址判为 not-audio', async () => {
    stubFetch(() => Buffer.from('{\n  "code": 401,\n  "msg": "error, has not any level"\n}'));
    expect((await probeAudio('http://x/kg.mp3')).status).toBe('not-audio');

    stubFetch(() => Buffer.from('<html>\r\n<head><title>404 Not Found</title></head>'));
    expect((await probeAudio('http://x/mg.mp3')).status).toBe('not-audio');
  });

  it('取不到数据时返回 unreachable', async () => {
    stubFetch(() => null);
    expect((await probeAudio('http://x/dead.mp3')).status).toBe('unreachable');
    expect((await probeAudio('not-a-url')).status).toBe('unreachable');
  });
});

describe('acceptProbe（候选音源放行/拒绝）', () => {
  it('非音频一律拒绝（这正是 LX mg/kg/tx 的坏 URL）', () => {
    expect(acceptProbe({ status: 'not-audio', kind: 'not-audio', durationSec: null, totalBytes: 0 }, 200_000)).toBe(false);
  });

  it('取不到数据 / 是音频但时长未知 → 放行', () => {
    expect(acceptProbe({ status: 'unreachable', kind: 'unknown', durationSec: null, totalBytes: 0 }, 200_000)).toBe(true);
    expect(acceptProbe({ status: 'audio', kind: 'mp3', durationSec: null, totalBytes: 0 }, 200_000)).toBe(true);
  });

  it('时长可见时按 max(10s, 8%) 判定', () => {
    expect(acceptProbe({ status: 'ok', kind: 'mp3', durationSec: 296, totalBytes: 0 }, 296_000)).toBe(true);
    expect(acceptProbe({ status: 'ok', kind: 'mp4', durationSec: 72, totalBytes: 0 }, 296_000)).toBe(false);
  });
});
