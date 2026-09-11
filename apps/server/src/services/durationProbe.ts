/**
 * 音源时长/类型探测：只取容器头部/尾部少量字节，解析出音频总时长与容器类型。
 *
 * 用途：第三方音源（LX 脚本 / GDMusic / Unblock）都是**按歌名+歌手**匹配的，
 * 同名翻唱、伴奏、串烧、现场版极其常见，匹配错版本时用户会听到「另一首歌」。
 * 时长是客户端唯一能拿到的、且与版本强相关的客观特征，用它做一道校验。
 *
 * 另一类必须拦下的情况：**返回的根本不是音频**。例如 LX 脚本的部分音源
 * （mg/kg/tx）在不可用时会返回 HTML 404 或 JSON `{"code":401}` 的地址，
 * 这类「伪成功」若放行，用户点播放会直接拿到坏流。
 *
 * 结论：
 *  - 明确非音频（HTML/JSON/文本）→ 拒绝；
 *  - 是音频但时长未知，或网络取不到数据 → 放行（fail-open，避免误杀可用音源）。
 *
 * 支持：MP4/M4A(mvhd)、MP3(帧头 + Xing/Info，按真实采样率与每帧样本数)、
 *       FLAC(STREAMINFO)、OGG(granule/采样率)。
 */

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 6000;
/** 单次探测响应体上限：部分 CDN 无视 Range 返回 200 + 整首曲子（FLAC 上百 MB），
 *  无条件 arrayBuffer() 会把它全读进内存，被 /song/:id/url 的候选遍历放大成内存 DoS */
const MAX_PROBE_BYTES = 2 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type AudioKind = 'mp4' | 'mp3' | 'flac' | 'ogg' | 'unknown';

export type ProbeResult =
  /** 明确是音频且拿到了时长 */
  | { status: 'ok'; kind: AudioKind; durationSec: number; totalBytes: number }
  /** 是音频，但容器里取不到总时长（放行） */
  | { status: 'audio'; kind: AudioKind; durationSec: null; totalBytes: number }
  /** 明确不是音频（HTML/JSON/文本等）→ 应拒绝 */
  | { status: 'not-audio'; kind: 'not-audio'; durationSec: null; totalBytes: number }
  /** 取不到数据（网络/超时）→ 放行 */
  | { status: 'unreachable'; kind: 'unknown'; durationSec: null; totalBytes: 0 };

interface RangeData { buf: Buffer; total: number }

async function fetchRange(url: string, range: string): Promise<RangeData | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { Range: range, 'User-Agent': UA }
    });
    // 只接受 206 分段响应：200 = CDN 无视了 Range（body 是整首曲子），按取不到数据处理
    //（probeAudio 对 unreachable fail-open，不会误杀音源）
    if (res.status !== 206) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    // 声明体积超限直接放弃；content-length 缺失/撒谎由读入后的实际长度兜底
    const declared = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PROBE_BYTES) return null;
    // content-range: bytes 0-32767/12345678 → 总大小
    const cr = res.headers.get('content-range');
    const m = cr && cr.match(/\/(\d+)\s*$/);
    const total = m ? Number(m[1]) : Number(res.headers.get('content-length') || 0);
    return { buf, total: Number.isFinite(total) ? total : 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function findTag(buf: Buffer, tag: string, from = 0): number {
  return buf.indexOf(Buffer.from(tag, 'latin1'), from);
}

/** MP4/M4A：mvhd 里的 timescale / duration */
function mp4Duration(buf: Buffer): number | null {
  const i = findTag(buf, 'mvhd');
  if (i < 0) return null;
  const version = buf[i + 4];
  if (version === 1) {
    if (i + 36 > buf.length) return null;
    const scale = buf.readUInt32BE(i + 24);
    const dur = Number(buf.readBigUInt64BE(i + 28));
    return scale > 0 ? dur / scale : null;
  }
  if (i + 24 > buf.length) return null;
  const scale = buf.readUInt32BE(i + 16);
  const dur = buf.readUInt32BE(i + 20);
  return scale > 0 ? dur / scale : null;
}

/** 跳过 ID3v2 头，定位第一个 MP3 帧同步字，返回偏移（找不到返回 -1） */
function findMp3Frame(buf: Buffer): number {
  let p = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    p = 10 + ((buf[6] & 0x7f) << 21) + ((buf[7] & 0x7f) << 14) + ((buf[8] & 0x7f) << 7) + (buf[9] & 0x7f);
  }
  for (; p + 4 <= buf.length; p++) {
    if (buf[p] === 0xff && (buf[p + 1] & 0xe0) === 0xe0) return p;
  }
  return -1;
}

const MP3_SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_BR: Record<number, number[]> = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};

/**
 * MP3：必须先读真实帧头拿到采样率与 MPEG 版本。
 * 早期实现写死 `frames*1152/44100`，遇到 48kHz 文件会高估 8.8%（超过 8% 阈值），
 * 从而把**完全正确的音源**误判为错版本丢弃。
 * 每帧样本数：Layer1=384，Layer2=1152，Layer3 在 MPEG1=1152、MPEG2/2.5=576。
 * 另：Xing/Info 必须从帧头之后开始找，避免命中 ID3 元数据（如封面二进制）里的同名串。
 */
function mp3Duration(head: Buffer, totalBytes: number): number | null {
  const p = findMp3Frame(head);
  if (p < 0) return null;
  const h = head.readUInt32BE(p);
  const verBits = (h >> 19) & 3;
  const layerBits = (h >> 17) & 3;
  const srIdx = (h >> 10) & 3;
  const brIdx = (h >> 12) & 15;
  const srTable = MP3_SR[verBits];
  if (!srTable || srIdx === 3) return null;
  const sampleRate = srTable[srIdx];
  const samplesPerFrame = layerBits === 3 ? 384 : layerBits === 2 ? 1152 : (verBits === 3 ? 1152 : 576);

  // VBR：Xing/Info 头带总帧数
  for (const tag of ['Xing', 'Info']) {
    const i = findTag(head, tag, p);
    if (i < 0 || i + 12 > head.length) continue;
    const flags = head.readUInt32BE(i + 4);
    if (flags & 1) {
      const frames = head.readUInt32BE(i + 8);
      if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
    }
  }
  // CBR 无 Xing：用 total bytes / 码率估算
  const bitrate = (MP3_BR[verBits] || [])[brIdx] || 0;
  if (bitrate > 0 && totalBytes > 0) return (totalBytes * 8) / (bitrate * 1000);
  return null;
}

/** FLAC：STREAMINFO 的总采样数 / 采样率 */
function flacDuration(buf: Buffer): number | null {
  const b = buf.subarray(18, 26);
  if (b.length < 8) return null;
  const sr = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
  const total = (b[3] & 0x0f) * 4294967296 + ((b[4] << 24) >>> 0) + (b[5] << 16) + (b[6] << 8) + b[7];
  return sr > 0 && total > 0 ? total / sr : null;
}

/** OGG：头部取采样率 + 尾部最后一页的 granule 位置 */
function oggDuration(head: Buffer, tail: Buffer | null): number | null {
  if (head.length < 40 || head.toString('latin1', 0, 4) !== 'OggS') return null;
  const off = 27 + head[26] + 7 + 4;
  if (head.length < off + 4) return null;
  const sr = head.readUInt32LE(off);
  if (!sr || !tail) return null;
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail.toString('latin1', i, i + 4) === 'OggS') {
      const g = Number(tail.readBigUInt64LE(i + 6));
      if (g > 0) return g / sr;
      break;
    }
  }
  return null;
}

/** 容器魔数识别；'not-audio' 表示内容形如 HTML/JSON/文本，明确不是音频流 */
function detectKind(head: Buffer): AudioKind | 'not-audio' {
  if (head.length < 4) return 'unknown';
  const magic = head.toString('latin1', 0, 4);
  if (magic === 'fLaC') return 'flac';
  if (magic === 'OggS') return 'ogg';
  if (magic.startsWith('ID3')) return 'mp3';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  if (head.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  // 文本型响应：HTML 文档、JSON（部分音源不可用时返回 {"code":401}）、纯文本报错
  const text = head.toString('utf8', 0, Math.min(64, head.length)).trimStart();
  if (/^(<!doctype|<html|<\?xml|\{|\}|\[|"|error|forbidden|not\s*found)/i.test(text)) return 'not-audio';
  return 'unknown';
}

/**
 * 探测音频容器与时长。
 * 返回 status：
 *  - ok          音频且拿到时长
 *  - audio       音频但时长未知（调用方放行）
 *  - not-audio   明确非音频（调用方拒绝）
 *  - unreachable 取不到数据（调用方放行）
 */
export async function probeAudio(upstreamUrl: string): Promise<ProbeResult> {
  if (!/^https?:\/\//i.test(upstreamUrl)) return { status: 'unreachable', kind: 'unknown', durationSec: null, totalBytes: 0 };
  const head = await fetchRange(upstreamUrl, `bytes=0-${HEAD_BYTES - 1}`);
  if (!head) return { status: 'unreachable', kind: 'unknown', durationSec: null, totalBytes: 0 };
  const kind = detectKind(head.buf);
  if (kind === 'not-audio') return { status: 'not-audio', kind: 'not-audio', durationSec: null, totalBytes: head.total };

  let durationSec: number | null = null;
  if (kind === 'flac') {
    durationSec = flacDuration(head.buf);
  } else if (kind === 'ogg') {
    const tail = await fetchRange(upstreamUrl, `bytes=-${8 * 1024}`);
    durationSec = oggDuration(head.buf, tail?.buf ?? null);
  } else if (kind === 'mp4') {
    durationSec = mp4Duration(head.buf);
    if (!durationSec) {
      const tail = await fetchRange(upstreamUrl, `bytes=-${TAIL_BYTES}`);
      durationSec = tail ? mp4Duration(tail.buf) : null;
    }
  } else if (kind === 'mp3') {
    durationSec = mp3Duration(head.buf, head.total);
  }

  if (durationSec != null && durationSec > 0) {
    return { status: 'ok', kind, durationSec, totalBytes: head.total };
  }
  return { status: 'audio', kind, durationSec: null, totalBytes: head.total };
}

/**
 * 时长是否可信：无法探测时放行；差值超过 max(10s, 8%) 判定为错版本。
 * 阈值偏宽松，避免误杀「现场版/加长版」等合理差异。
 */
export function isDurationPlausible(actualSec: number | null, expectedMs: number): boolean {
  if (actualSec == null || !expectedMs) return true;
  const expectedSec = expectedMs / 1000;
  const diff = Math.abs(actualSec - expectedSec);
  return diff <= Math.max(10, expectedSec * 0.08);
}

/**
 * 综合判定候选音源是否可用：
 *  - 明确非音频 → 拒绝（这是「伪成功」音源的兜底，如返回 JSON/HTML 的 LX 音源）
 *  - 取不到数据 / 时长为空 → 放行（fail-open）
 *  - 时长可见但与期望差异过大 → 拒绝
 */
export function acceptProbe(r: ProbeResult, expectedMs: number): boolean {
  if (r.status === 'not-audio') return false;
  if (r.status === 'unreachable' || r.status === 'audio') return true;
  return isDurationPlausible(r.durationSec, expectedMs);
}

export type { ProbeResult as AudioProbeResult };
