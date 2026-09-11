import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { ensureDataDir } from '../../dataDir';

const QUALITY_MAP: Record<string, string> = { standard: '128k', higher: '320k', exhigh: '320k', lossless: 'flac', hires: 'flac', jymaster: 'flac' };
const QUALITY_CASCADE = ['flac', '320k', '128k'];
/** 旧版脚本（自带 sources）音源优先级：按实测正确率排序 */
const LX_SOURCE_PRIORITY = ['wy', 'kw', 'kg', 'tx', 'mg'];
/** 事件式脚本显式请求顺序：wy 实测 100% 正确，kw 仅 60%（脚本默认落到 kw） */
const EVENT_SOURCE_ORDER = ['wy', 'kw'];
/** 持久化脚本数量上限（防磁盘填充与启动时间膨胀） */
const MAX_SCRIPTS = 12;

function getQualityCascade(quality: string): string[] {
  const mapped = QUALITY_MAP[quality] || '320k';
  const idx = QUALITY_CASCADE.indexOf(mapped);
  return idx < 0 ? [mapped] : QUALITY_CASCADE.slice(idx);
}

/** 解析脚本头部 @name/@version 等注释字段（对齐真实 LX 客户端的 currentScriptInfo） */
function parseScriptInfo(script: string): Record<string, string> {
  const info: Record<string, string> = {};
  const re = /@(name|description|version|author|homepage)\s+(.+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script))) {
    const k = m[1].toLowerCase();
    if (!info[k]) info[k] = m[2].trim();
  }
  return info;
}

/** 沙盒 HTTP 响应体上限：脚本（互联网上的第三方 LX 源）无界累积可 OOM 进程 */
const MAX_SANDBOX_BODY_BYTES = 2 * 1024 * 1024;

function sandboxHttpRequest(url: string, options: any = {}): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const client = isHttps ? https : http;
    const urlObj = new URL(url);
    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 15000
    };
    const req = client.request(reqOpts, (res) => {
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_SANDBOX_BODY_BYTES) {
          req.destroy();
          reject(new Error('Response too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** AES key/iv 宽松解析：Buffer 直用；字符串优先按 hex，非法 hex 回退 utf8 */
function toBuf(v: any): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    if (v.length > 0 && /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
      const hex = Buffer.from(v, 'hex');
      if (hex.length * 2 === v.length) return hex;
    }
    return Buffer.from(v, 'utf8');
  }
  return Buffer.from(String(v), 'utf8');
}

/** 伪造的 Buffer 视图：把宿主 Buffer 的常用方法收窄后暴露给沙盒，
 *  避免 Buffer 构造器本身（可经 .constructor 逃逸到宿主 realm）直接进入沙盒 */
function bufferView(buf: Buffer): any {
  return {
    toString: (enc?: string) => buf.toString((enc as any) || 'utf8'),
    length: buf.length,
    slice: (a?: number, b?: number) => bufferView(buf.subarray(a, b)),
    bufToArray: () => Array.from(buf)
  };
}

/**
 * 沙盒预置脚本：在沙盒 realm 内部安装 console/定时器/lx API/module。
 * 所有包装函数都在沙盒内创建，桥接对象只经闭包触达、不直接暴露，
 * 避免把宿主函数原型（fn.constructor === 宿主 Function）泄露为逃逸通道。
 * 整体包裹在 IIFE 中：顶层 const/let 会留在沙盒全局词法作用域，
 * 会与用户脚本自身的同名顶层声明（如 const b）冲突。
 */
const SANDBOX_PRELUDE = `
(() => {
const b = globalThis.__bridge;
globalThis.console = { log(){}, warn(){}, error(){}, info(){}, debug(){} };
globalThis.setTimeout = (fn, ms, ...args) => b.setTimeout(fn, ms, ...args);
globalThis.clearTimeout = (t) => b.clearTimeout(t);
globalThis.setInterval = (fn, ms, ...args) => b.setInterval(fn, ms, ...args);
globalThis.clearInterval = (t) => b.clearInterval(t);
globalThis.fetch = (url, opts) => b.httpRequest(String(url), opts || {});
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;
const ci = b.scriptInfo;
globalThis.lx = {
  EVENT_NAMES: { inited: 'inited', request: 'request', updateAlert: 'updateAlert' },
  version: '2.9.0',
  // 对齐真实 LX 客户端（lxmusic.toside.cn 自定义源文档）：currentScriptInfo 含头部注释字段与 rawScript；
  // 加载器类脚本（如 grass）依赖 rawScript 提取内置配置，缺失会直接 undefined.trim() 崩溃
  currentScriptInfo: {
    name: ci.name || '', description: ci.description || '', version: ci.version || '',
    author: ci.author || '', homepage: ci.homepage || '', rawScript: ci.rawScript || ''
  },
  env: 'node',
  utils: {
    buffer: {
      from: (s, enc) => b.bufFrom(s, enc),
      bufToString: (buf, enc) => b.bufToString(buf, enc)
    },
    crypto: {
      md5: (str) => b.md5(str),
      randomBytes: (size) => b.randomBytes(size),
      rsaEncrypt: (data, key) => b.rsaEncrypt(data, key),
      aesEncrypt: (data, mode, key, iv) => b.aesEn(data, mode, key, iv),
      aesEn: (data, mode, key, iv) => b.aesEn(data, mode, key, iv),
      aesDe: (data, mode, key, iv) => b.aesDe(data, mode, key, iv),
      aesDecrypt: (data, mode, key, iv) => b.aesDe(data, mode, key, iv)
    },
    zlib: {
      inflate: (buf) => b.zlibInflate(buf),
      deflate: (buf) => b.zlibDeflate(buf)
    }
  },
  request: (url, opts, cb) => b.request(String(url), opts || {}, cb),
  on: (event, handler) => { (b.handlers[event] = b.handlers[event] || []).push(handler); },
  send: (event, ...args) => {
    const hs = b.handlers[event] || [];
    return hs.length ? hs[0](...args) : undefined;
  }
};
delete globalThis.__bridge;
})();
`;

class LxMusicRunner {
  private _sources: Record<string, any> = {};
  private _lxApi: any = null;
  private _lxHandlers: Record<string, Function[]> = {};
  private _initialized = false;
  private _scriptName = '';
  /** 本 runner 的沙盒定时器登记表（init 时被 bridge 闭包引用） */
  private _timers: Set<NodeJS.Timeout> = new Set();

  async init(scriptContent: string, scriptName?: string): Promise<boolean> {
    try {
      this._scriptName = scriptName || 'unknown';

      // 事件处理器注册表：宿主持有引用，用于探测事件式脚本与后续回调
      const lxEventHandlers: Record<string, Function[]> = {};
      this._lxHandlers = lxEventHandlers;

      // 沙盒定时器登记表：被删除/替换的脚本，其 setInterval 若不回收，
      // 回调（持有整个沙盒 context）会永久驻留并持续执行 —— CPU/内存随脚本增删累积
      const sandboxTimers = this._timers;
      const trackedTimeout = (fn: any, ms?: number, ...args: any[]): NodeJS.Timeout => {
        const t = setTimeout((...a: any[]) => { sandboxTimers.delete(t); fn(...a); }, ms, ...args);
        sandboxTimers.add(t);
        return t;
      };
      const trackedInterval = (fn: any, ms?: number, ...args: any[]): NodeJS.Timeout => {
        const t = setInterval((...a: any[]) => fn(...a), ms, ...args);
        sandboxTimers.add(t);
        return t;
      };
      // Node 里 clearTimeout 对 interval 句柄同样有效（同一底层实现）
      const clearTracked = (t: any): void => {
        if (t == null) return;
        sandboxTimers.delete(t);
        clearTimeout(t);
      };

      // 桥接对象：脚本触达宿主能力的唯一入口（定时器/网络/摘要）。
      // 注意 vm 不是安全边界，脚本可信性由路由层的 ADMIN_TOKEN 鉴权保证；
      // 这里不再向沙盒注入宿主 realm 的 Object/Error/Buffer 等构造器，
      // 堵住 e.constructor.constructor('return process')() 这类一行逃逸。
      const bridge = {
        handlers: lxEventHandlers,
        setTimeout: trackedTimeout, clearTimeout: clearTracked,
        setInterval: trackedInterval, clearInterval: clearTracked,
        httpRequest: sandboxHttpRequest,
        scriptInfo: { ...parseScriptInfo(scriptContent), rawScript: scriptContent },
        request: (url: string, opts: any, cb: Function) => {
          try {
            const urlObj = new URL(url);
            const isHttps = urlObj.protocol === 'https:';
            const client = isHttps ? https : http;
            const method = (opts?.method || 'GET').toUpperCase();
            const headers: any = { ...(opts?.headers || {}) };
            let body = opts?.body;
            // 对齐 lx.request 契约：form → urlencoded，formData → 简单 multipart
            if (opts?.form && typeof opts.form === 'object') {
              body = new URLSearchParams(opts.form).toString();
              headers['Content-Type'] ||= 'application/x-www-form-urlencoded';
            } else if (opts?.formData && typeof opts.formData === 'object') {
              const boundary = '----lxform' + crypto.randomBytes(8).toString('hex');
              const parts: string[] = [];
              for (const [k, v] of Object.entries(opts.formData)) {
                parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`);
              }
              parts.push(`--${boundary}--\r\n`);
              body = parts.join('');
              headers['Content-Type'] ||= `multipart/form-data; boundary=${boundary}`;
            }
            const reqOpts: any = {
              hostname: urlObj.hostname,
              port: urlObj.port || (isHttps ? 443 : 80),
              path: urlObj.pathname + urlObj.search,
              method,
              headers,
              timeout: opts?.timeout || 15000
            };
            const req = client.request(reqOpts, (res: any) => {
              let data = '';
              let bytes = 0;
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => {
                bytes += Buffer.byteLength(chunk);
                if (bytes > MAX_SANDBOX_BODY_BYTES) {
                  req.destroy();
                  cb(new Error('Response too large'));
                  return;
                }
                data += chunk;
              });
              res.on('end', () => {
                let parsed: any = data;
                try { parsed = JSON.parse(data); } catch {}
                res.body = parsed;
                cb(null, res, parsed);
              });
            });
            req.on('error', (e: Error) => cb(e));
            req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
            if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
            req.end();
            // 契约：返回取消函数
            return () => req.destroy();
          } catch (e: any) {
            cb(e);
            return () => {};
          }
        },
        bufFrom: (s: any, enc?: string) => bufferView(Buffer.from(s, (enc as any) || 'utf8')),
        bufToString: (buf: any, enc: string) => {
          const b = Buffer.isBuffer(buf) ? buf : (buf?.bufToArray ? Buffer.from(buf.bufToArray()) : Buffer.from(String(buf)));
          return b.toString((enc as any) || 'utf8');
        },
        md5: (str: any) => crypto.createHash('md5').update(toBuf(str)).digest('hex'),
        randomBytes: (size: number) => bufferView(crypto.randomBytes(size)),
        rsaEncrypt: (data: any, key: any) => {
          const pem = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
          return bufferView(crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, toBuf(data)));
        },
        aesEn: (data: any, mode: string, key: any, iv: any) => {
          const cipher = crypto.createCipheriv(mode, toBuf(key), iv != null ? toBuf(iv) : null);
          return bufferView(Buffer.concat([cipher.update(toBuf(data)), cipher.final()]));
        },
        aesDe: (data: any, mode: string, key: any, iv: any) => {
          const decipher = crypto.createDecipheriv(mode, toBuf(key), iv != null ? toBuf(iv) : null);
          return bufferView(Buffer.concat([decipher.update(toBuf(data)), decipher.final()]));
        },
        zlibInflate: (buf: any) => new Promise((resolve, reject) => {
          zlib.inflate(toBuf(buf), (e, r) => e ? reject(e) : resolve(bufferView(r)));
        }),
        zlibDeflate: (buf: any) => new Promise((resolve, reject) => {
          zlib.deflate(toBuf(buf), (e, r) => e ? reject(e) : resolve(bufferView(r)));
        })
      };

      const context = vm.createContext({});
      (context as any).__bridge = bridge;
      vm.runInContext(SANDBOX_PRELUDE, context, { timeout: 5000 });
      this._lxApi = (context as any).lx;

      vm.runInContext(scriptContent, context, { timeout: 15000 });

      // 新版脚本：通过 lx.on(request) 事件式注册
      if (lxEventHandlers['request']?.length) {
        this._initialized = true;
        this._sources = { _lxEvent: true } as any;
        console.log('[LxMusic] 事件式脚本加载成功:', this._scriptName);
        return true;
      }

      // 旧版脚本：module.exports 导出 sources（module 由预置脚本在沙盒内创建）
      const exported = (context as any).module?.exports || {};
      if (exported.sources && typeof exported.sources === 'object') {
        this._sources = exported.sources;
      } else if (exported.default?.sources) {
        this._sources = exported.default.sources;
      } else {
        for (const key of Object.keys(exported)) {
          if (typeof exported[key] === 'object' && exported[key] !== null) {
            const hasMethod = Object.values(exported[key]).some((v: any) => typeof v === 'function');
            if (hasMethod) { this._sources[key] = exported[key]; break; }
          }
        }
      }
      const keys = Object.keys(this._sources);
      if (keys.length === 0) { console.warn('[LxMusic] 脚本未导出有效音源:', this._scriptName); return false; }
      this._initialized = true;
      console.log('[LxMusic] 脚本加载成功:', this._scriptName, '音源:', keys.join(', '));
      return true;
    } catch (err: any) {
      console.error('[LxMusic] 脚本执行失败:', err.message);
      return false;
    }
  }

  isInitialized(): boolean { return this._initialized; }
  getAvailableSourceKeys(): string[] { return Object.keys(this._sources); }

  /** 回收脚本资源：清除沙盒里登记的全部定时器（不回收的被删脚本 interval 会永久驻留） */
  dispose(): void {
    for (const t of this._timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this._timers.clear();
    this._initialized = false;
    this._sources = {};
    this._lxHandlers = {};
  }

  async getMusicUrl(sourceKey: string, songInfo: any, quality: string): Promise<string | null> {
    // 事件式脚本（新版 LX Music 脚本）
    if (this._sources._lxEvent && this._lxApi) {
      try {
        return await new Promise<string | null>((resolve) => {
          const timeout = setTimeout(() => resolve(null), 12000);
          this._lxApi.send(this._lxApi.EVENT_NAMES.request, {
            source: sourceKey === '_lxEvent' ? 'kw' : sourceKey,
            action: 'musicUrl',
            info: { musicInfo: songInfo, type: quality }
          }).then((url: any) => {
            clearTimeout(timeout);
            resolve(typeof url === 'string' && url.startsWith('http') ? url : null);
          }).catch(() => { clearTimeout(timeout); resolve(null); });
        });
      } catch { return null; }
    }
    // 旧版 module.exports 脚本
    const source = this._sources[sourceKey];
    if (!source) return null;
    try {
      const handler = source.getMusicUrl || source.get_url || source.getUrl;
      if (typeof handler !== 'function') return null;
      // 旧版 handler 此前完全无超时：脚本返回 never-resolve 的 Promise 会把
      // tryLxMusic → resolveSongUrl → 路由整条链永久挂死（事件式路径本就有 12s）
      let timer: NodeJS.Timeout | undefined;
      const result: any = await Promise.race([
        Promise.resolve(handler(songInfo, quality)),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 12_000); })
      ]).finally(() => clearTimeout(timer));
      if (result && typeof result === 'string' && result.startsWith('http')) return result;
      if (result?.url && typeof result.url === 'string') return result.url;
      return null;
    } catch { return null; }
  }
}


// ============================================================
// 持久化（脚本存盘，重启自动加载）
// ============================================================
const SCRIPTS_FILE = path.join(ensureDataDir(), 'lx-scripts.json');

interface PersistedScript { id: string; name: string; script: string; }

function saveScripts() {
  const list: PersistedScript[] = Object.keys(_runners).map(id => {
    const r = _scriptsStore[id];
    return r ? { id, name: r.name, script: r.script } : null;
  }).filter(Boolean) as PersistedScript[];
  fs.writeFileSync(SCRIPTS_FILE, JSON.stringify({ scripts: list, activeId: _activeRunnerId }, null, 2));
}

export async function loadPersistedScripts(): Promise<number> {
  try {
    if (!fs.existsSync(SCRIPTS_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8'));
    let count = 0;
    for (const s of (data.scripts || [])) {
      // 字段校验：损坏条目跳过而不是靠 init 内部 catch 兜底（损坏时至少这里可日志排查）
      if (!s || typeof s.id !== 'string' || typeof s.script !== 'string') continue;
      if (_runners[s.id]) continue;
      const runner = await initRunner(s.id, s.script, s.name, s.id === data.activeId);
      if (runner) count++;
    }
    return count;
  } catch (err: any) {
    console.warn('[LxMusic] 加载持久化脚本失败:', err?.message || err);
    return 0;
  }
}

// ============================================================
// Runner 管理
// ============================================================
const _runners: Record<string, LxMusicRunner> = {};
const _scriptsStore: Record<string, { name: string; script: string }> = {};
let _activeRunnerId: string | null = null;

export async function initRunner(scriptId: string, scriptContent: string, scriptName?: string, activate = false): Promise<LxMusicRunner | null> {
  const runner = new LxMusicRunner();
  const ok = await runner.init(scriptContent, scriptName);
  if (ok) {
    _runners[scriptId] = runner;
    _scriptsStore[scriptId] = { name: scriptName || scriptId, script: scriptContent };
    if (activate || !_activeRunnerId) _activeRunnerId = scriptId;
    saveScripts();
    return runner;
  }
  return null;
}

export function canAddScript(): boolean {
  return Object.keys(_runners).length < MAX_SCRIPTS;
}

export function setActiveRunner(scriptId: string): boolean {
  if (_runners[scriptId]) { _activeRunnerId = scriptId; return true; }
  return false;
}

export function removeRunner(scriptId: string): void {
  // 先回收定时器再删除：被删脚本的沙盒 interval 不清除会永久驻留（CPU/内存泄漏）
  _runners[scriptId]?.dispose();
  delete _runners[scriptId];
  delete _scriptsStore[scriptId];
  if (_activeRunnerId === scriptId) {
    const keys = Object.keys(_runners);
    _activeRunnerId = keys.length > 0 ? keys[0] : null;
  }
  saveScripts();
}

export function listRunners(): Array<{ id: string; initialized: boolean; sources: string[]; active: boolean }> {
  return Object.keys(_runners).map((id) => ({
    id, initialized: _runners[id].isInitialized(),
    sources: _runners[id].getAvailableSourceKeys(),
    active: id === _activeRunnerId
  }));
}

export async function parseFromLxMusic(params: {
  id: string; name: string; artists: string; album?: string; duration?: number; quality?: string; scriptId?: string;
}): Promise<{ url: string; source: string; quality: string } | null> {
  const { id, name, artists, album = '', duration = 0, quality = '320k', scriptId } = params;
  let runner: LxMusicRunner | null = null;
  if (scriptId && _runners[scriptId]) runner = _runners[scriptId];
  else if (_activeRunnerId && _runners[_activeRunnerId]) runner = _runners[_activeRunnerId];
  if (!runner?.isInitialized()) return null;
  const available = runner.getAvailableSourceKeys();
  if (!available.length) return null;
  const isEvent = available.length === 1 && available[0] === '_lxEvent';

  /**
   * 事件式脚本内部按 `source` 字段路由到具体音源，**默认落到 kw**。
   * 实测（热歌榜 + 飙升榜各 10 首）：wy 成功率 100% / 时长正确率 100% / 320k；
   * kw 成功率 100% 但时长正确率仅 60%（常匹配到 MV 或翻唱版本，例：海屿你 296s → 72s）。
   * 故事件式脚本显式按 wy → kw 顺序请求，不再依赖脚本的默认路由。
   * 另：mg / kg / tx 实测返回 HTML 404 / JSON 401（非音频），排在最后，由上层非音频校验拦下。
   */
  const order = isEvent
    ? EVENT_SOURCE_ORDER
    : [...LX_SOURCE_PRIORITY.filter((s) => available.includes(s)), ...available.filter((s) => !LX_SOURCE_PRIORITY.includes(s))];

  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  const interval = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  const songInfo = { songmid: String(id), name: name || '', singer: artists || '', album, interval, img: '' };
  const cascade = getQualityCascade(quality);
  for (const lxQ of cascade) {
    for (const src of order) {
      try {
        const url = await runner.getMusicUrl(src, songInfo, lxQ);
        if (url) return { url, source: 'lx-' + src, quality: 'lx-' + lxQ };
      } catch { /* next */ }
    }
  }
  return null;
}
