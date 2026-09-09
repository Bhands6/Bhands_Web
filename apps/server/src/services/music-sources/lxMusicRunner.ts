import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const SOURCE_NAMES: Record<string, string> = { wy: '网易云', kw: '酷我', mg: '咪咕', kg: '酷狗', tx: 'QQ音乐' };
const QUALITY_MAP: Record<string, string> = { standard: '128k', higher: '320k', exhigh: '320k', lossless: 'flac', hires: 'flac', jymaster: 'flac' };
const QUALITY_CASCADE = ['flac', '320k', '128k'];

function getQualityCascade(quality: string): string[] {
  const mapped = QUALITY_MAP[quality] || '320k';
  const idx = QUALITY_CASCADE.indexOf(mapped);
  return idx < 0 ? [mapped] : QUALITY_CASCADE.slice(idx);
}

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
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

class LxMusicRunner {
  private _sources: Record<string, any> = {};
  private _lxApi: any = null;
  private _lxHandlers: Record<string, Function[]> = {};
  private _initialized = false;
  private _scriptName = '';

  async init(scriptContent: string, scriptName?: string): Promise<boolean> {
    try {
      this._scriptName = scriptName || 'unknown';

      // LX Music 兼容事件总线
      const lxEventHandlers: Record<string, Function[]> = {};
      const lxApi: any = {
        EVENT_NAMES: { inited: 'inited', request: 'request', updateAlert: 'updateAlert' },
        version: '2.9.0',
        currentScriptInfo: { version: '1' },
        env: 'node',
        request: (url: string, opts: any, cb: Function) => {
          const method = (opts?.method || 'GET').toUpperCase();
          const headers = opts?.headers || {};
          const body = opts?.body;
          const urlObj = new URL(url);
          const isHttps = urlObj.protocol === 'https:';
          const client = isHttps ? https : http;
          const reqOpts: any = { hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname + urlObj.search, method, headers, timeout: 15000 };
          const req = client.request(reqOpts, (res: any) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { data += chunk; });
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
        },
        on: (event: string, handler: Function) => { (lxEventHandlers[event] ||= []).push(handler); },
        send: (event: string, ...args: any[]) => { const handlers = lxEventHandlers[event] || []; return handlers.length ? handlers[0](...args) : undefined; },
        utils: {
          buffer: { bufToString: (buf: any, enc: string) => Buffer.from(buf).toString(enc as any) },
          crypto: { hash: (algo: string, data: string) => crypto.createHash(algo).update(data).digest('hex') }
        }
      };

      const sandbox: any = {
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Date, Math, JSON, RegExp, Array, Object, String, Number, Boolean,
        Error, TypeError, RangeError,
        encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite,
        Buffer,
        fetch: sandboxHttpRequest,
        module: { exports: {} },
        exports: {},
        globalThis: {} as any,
        global: {} as any
      };
      sandbox.globalThis = sandbox;
      sandbox.global = sandbox;
      sandbox.lx = lxApi;
      sandbox.globalThis.lx = lxApi;

      this._lxApi = lxApi;
      this._lxHandlers = lxEventHandlers;

      const context = vm.createContext(sandbox);
      vm.runInContext(scriptContent, context, { timeout: 15000 });

      // 新版脚本：通过 globalThis.lx 事件式注册
      if (lxEventHandlers['request']?.length) {
        this._initialized = true;
        this._sources = { _lxEvent: true } as any;
        console.log('[LxMusic] 事件式脚本加载成功:', this._scriptName);
        return true;
      }

      // 旧版脚本：module.exports 导出 sources
      const exported = sandbox.module.exports || sandbox.exports || {};
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
      const result = await handler(songInfo, quality);
      if (result && typeof result === 'string' && result.startsWith('http')) return result;
      if (result?.url && typeof result.url === 'string') return result.url;
      return null;
    } catch { return null; }
  }
}


// ============================================================
// 持久化（脚本存盘，重启自动加载）
// ============================================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_FILE = path.resolve(__dirname, '../../../../data/lx-scripts.json');

interface PersistedScript { id: string; name: string; script: string; }

function ensureDataDir() {
  const dir = path.dirname(SCRIPTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveScripts() {
  ensureDataDir();
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
      if (_runners[s.id]) continue;
      const runner = await initRunner(s.id, s.script, s.name, s.id === data.activeId);
      if (runner) count++;
    }
    return count;
  } catch { return 0; }
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

export function setActiveRunner(scriptId: string): boolean {
  if (_runners[scriptId]) { _activeRunnerId = scriptId; return true; }
  return false;
}

export function removeRunner(scriptId: string): void {
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
  const sourcePriority = ['wy', 'kw', 'mg', 'kg', 'tx'];
  let best = sourcePriority.find((s) => available.includes(s)) || available[0];
  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  const interval = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  const songInfo = { songmid: String(id), name: name || '', singer: artists || '', album, interval, img: '' };
  const cascade = getQualityCascade(quality);
  for (const lxQ of cascade) {
    // 事件式脚本：直接请求（脚本内部处理音源路由）
    if (available.length === 1 && available[0] === '_lxEvent') {
      const url = await runner.getMusicUrl('_lxEvent', songInfo, lxQ);
      if (url) return { url, source: 'lx-event', quality: lxQ };
    } else {
      const url = await runner.getMusicUrl(best, songInfo, lxQ);
      if (url) return { url, source: 'lx-' + best, quality: lxQ };
      for (const src of available) {
        if (src === best) continue;
        try {
          const altUrl = await runner.getMusicUrl(src, songInfo, lxQ);
          if (altUrl) return { url: altUrl, source: 'lx-' + src, quality: lxQ };
        } catch { /* next */ }
      }
    }
  }
  return null;
}
