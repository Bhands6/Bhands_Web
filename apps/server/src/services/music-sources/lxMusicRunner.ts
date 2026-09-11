import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDir } from '../../dataDir';

const QUALITY_MAP: Record<string, string> = { standard: '128k', higher: '320k', exhigh: '320k', lossless: 'flac', hires: 'flac', jymaster: 'flac' };
const QUALITY_CASCADE = ['flac', '320k', '128k'];
/** 旧版脚本（自带 sources）音源优先级：按实测正确率排序 */
const LX_SOURCE_PRIORITY = ['wy', 'kw', 'kg', 'tx', 'mg'];
/** 事件式脚本显式请求顺序：wy 实测 100% 正确，kw 仅 60%（脚本默认落到 kw） */
const EVENT_SOURCE_ORDER = ['wy', 'kw'];
/** 持久化脚本数量上限（防磁盘填充与启动时间膨胀） */
const MAX_SCRIPTS = 12;
/** 沙盒 HTTP 响应体上限：脚本（互联网上的第三方 LX 源）无界累积可 OOM */
const MAX_SANDBOX_BODY_BYTES = 2 * 1024 * 1024;

function getQualityCascade(quality: string): string[] {
  const mapped = QUALITY_MAP[quality] || '320k';
  const idx = QUALITY_CASCADE.indexOf(mapped);
  return idx < 0 ? [mapped] : QUALITY_CASCADE.slice(idx);
}

/**
 * 沙盒预置脚本：在沙盒 realm 内部安装 console/定时器/lx API/module。
 * 所有包装函数都在沙盒内创建，桥接对象只经闭包触达、不直接暴露。
 * 整体包裹在 IIFE 中：顶层 const/let 会留在沙盒全局词法作用域，
 * 会与用户脚本自身的同名顶层声明（如 const b）冲突。
 * （本字符串原样经 workerData 传入 worker，注意保持其中无反引号与模板插值。）
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

/**
 * worker 线程代码（new Worker(code, { eval: true })）—— 整个 LX 沙盒都活在子线程里。
 *
 * 为什么搬进 worker（2026-09-11 扫描遗留项，用户拍板继续）：
 *  ① 脚本 handler 里的**同步 while(true)** 曾能阻塞整个事件循环（vm timeout 只护 runInContext，
 *     后续 handler 调用无保护）—— 现在只会烧 worker 线程，主线程超时后直接 terminate；
 *  ② never-resolve 的 Promise / 永久 setInterval 随 terminate 一起销毁，主进程不再有泄漏面；
 *  ③ vm 逃逸（.constructor.constructor）即使发生也只落到一次性 worker 的 Node 环境，
 *     拿不到主进程的会话/缓存/路由状态；配合下方「内网 SSRF 黑名单」掐掉内网探测。
 *
 * ⚠️ 本字符串内禁用反引号与模板插值（${）—— 全部用单引号 + 字符串拼接。
 */
const WORKER_CODE = `
(async () => {
  var wt = await import('node:worker_threads');
  var parentPort = wt.parentPort;
  var workerData = wt.workerData;
  var vm = (await import('node:vm')).default;
  var crypto = (await import('node:crypto')).default;
  var http = (await import('node:http')).default;
  var https = (await import('node:https')).default;
  var zlib = (await import('node:zlib')).default;
  var dnsPromises = (await import('node:dns')).promises;
  var net = (await import('node:net')).default;

  var MAX_BODY = workerData.maxBody || 2097152;
  var CALL_TIMEOUT = workerData.callTimeout || 12000;

  function toBuf(v) {
    if (v && v.bufToArray) return Buffer.from(v.bufToArray());
    if (typeof v === 'string') return Buffer.from(v, 'utf8');
    return Buffer.from(String(v), 'utf8');
  }
  function bufferView(buf) {
    return {
      toString: function (enc) { return buf.toString(enc || 'utf8'); },
      length: buf.length,
      slice: function (a, b) { return bufferView(buf.subarray(a, b)); },
      bufToArray: function () { return Array.from(buf); }
    };
  }
  function parseScriptInfo(s) {
    var info = {};
    var re = /@(name|description|version|author|homepage)\\s+(.+)/gi;
    var m;
    while ((m = re.exec(s))) {
      var k = m[1].toLowerCase();
      if (!info[k]) info[k] = m[2].trim();
    }
    return info;
  }

  // ---- 内网 SSRF 黑名单：脚本来源是互联网上的第三方 LX 源，不允许借服务器探测内网 ----
  function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
      var p = ip.split('.');
      var a = +p[0], b = +p[1];
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 169 && b === 254) return true;            // link-local，含云厂商 metadata 169.254.169.254
      if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
      if (a === 192 && b === 168) return true;            // 192.168/16
      if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64/10
      if (a >= 224) return true;                          // 组播/保留段
      return false;
    }
    var s = String(ip).toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.indexOf('::ffff:127.') === 0 || s.indexOf('::ffff:10.') === 0 || s.indexOf('::ffff:192.168.') === 0) return true;
    if (s.indexOf('fc') === 0 || s.indexOf('fd') === 0) return true;   // ULA fc00::/7
    if (s.indexOf('fe8') === 0 || s.indexOf('fe9') === 0 || s.indexOf('fea') === 0 || s.indexOf('feb') === 0) return true;
    return false;
  }
  // 解析并校验目标主机；返回首个公网地址（调用方用 lookup 钉住，防 DNS rebinding 二次解析）
  function publicLookup(hostname) {
    return dnsPromises.lookup(hostname, { all: true, verbatim: true }).then(function (addrs) {
      if (!addrs || !addrs.length) throw new Error('DNS 解析失败: ' + hostname);
      for (var i = 0; i < addrs.length; i++) {
        if (isPrivateIp(addrs[i].address)) throw new Error('内网地址不可访问: ' + hostname + ' -> ' + addrs[i].address);
      }
      return addrs[0];
    });
  }
  function pinnedLookup(addr) {
    return function (host, opts, cb) {
      process.nextTick(function () { cb(null, addr.address, addr.family); });
    };
  }

  function sandboxHttpRequest(url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var urlObj = new URL(url);
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        reject(new Error('不支持的协议: ' + urlObj.protocol));
        return;
      }
      var client = urlObj.protocol === 'https:' ? https : http;
      publicLookup(urlObj.hostname).then(function (addr) {
        var reqOpts = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: options.method || 'GET',
          headers: options.headers || {},
          timeout: options.timeout || 15000,
          lookup: pinnedLookup(addr)
        };
        var req = client.request(reqOpts, function (res) {
          var body = '';
          var bytes = 0;
          res.setEncoding('utf8');
          res.on('data', function (chunk) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_BODY) { req.destroy(); reject(new Error('Response too large')); return; }
            body += chunk;
          });
          res.on('end', function () { resolve({ status: res.statusCode || 0, headers: res.headers, body: body }); });
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(); reject(new Error('Request timeout')); });
        if (options.body) req.write(options.body);
        req.end();
      }).catch(reject);
    });
  }

  // 沙盒定时器登记表（worker 内）：terminate 会整体回收，这里再兜一层显式清理
  var sandboxTimers = new Set();
  function trackedTimeout(fn, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    var t = setTimeout(function () { sandboxTimers.delete(t); fn.apply(null, rest); }, ms);
    sandboxTimers.add(t);
    return t;
  }
  function trackedInterval(fn, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    var t = setInterval(function () { fn.apply(null, rest); }, ms);
    sandboxTimers.add(t);
    return t;
  }
  function clearTracked(t) {
    if (t == null) return;
    sandboxTimers.delete(t);
    clearTimeout(t); clearInterval(t);
  }

  var lxHandlers = {};
  var bridge = {
    handlers: lxHandlers,
    setTimeout: trackedTimeout, clearTimeout: clearTracked,
    setInterval: trackedInterval, clearInterval: clearTracked,
    httpRequest: sandboxHttpRequest,
    scriptInfo: (function () {
      var info = parseScriptInfo(workerData.script);
      info.rawScript = workerData.script;
      return info;
    })(),
    request: function (url, opts, cb) {
      try {
        var urlObj = new URL(url);
        var client = urlObj.protocol === 'https:' ? https : http;
        var method = ((opts && opts.method) || 'GET').toUpperCase();
        var headers = Object.assign({}, (opts && opts.headers) || {});
        var body = opts && opts.body;
        if (opts && opts.form && typeof opts.form === 'object') {
          body = new URLSearchParams(opts.form).toString();
          headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        } else if (opts && opts.formData && typeof opts.formData === 'object') {
          var boundary = '----lxform' + crypto.randomBytes(8).toString('hex');
          var parts = [];
          var keys = Object.keys(opts.formData);
          for (var i = 0; i < keys.length; i++) {
            parts.push('--' + boundary + '\\r\\nContent-Disposition: form-data; name="' + keys[i] + '"\\r\\n\\r\\n' + String(opts.formData[keys[i]]) + '\\r\\n');
          }
          parts.push('--' + boundary + '--\\r\\n');
          body = parts.join('');
          headers['Content-Type'] = headers['Content-Type'] || ('multipart/form-data; boundary=' + boundary);
        }
        publicLookup(urlObj.hostname).then(function (addr) {
          var reqOpts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: headers,
            timeout: (opts && opts.timeout) || 15000,
            lookup: pinnedLookup(addr)
          };
          var req = client.request(reqOpts, function (res) {
            var data = '';
            var bytes = 0;
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
              bytes += Buffer.byteLength(chunk);
              if (bytes > MAX_BODY) { req.destroy(); cb(new Error('Response too large')); return; }
              data += chunk;
            });
            res.on('end', function () {
              var parsed = data;
              try { parsed = JSON.parse(data); } catch (e) {}
              res.body = parsed;
              cb(null, res, parsed);
            });
          });
          req.on('error', function (e) { cb(e); });
          req.on('timeout', function () { req.destroy(); cb(new Error('timeout')); });
          if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
          req.end();
          // 契约：返回取消函数
          return function () { req.destroy(); };
        }).catch(function (e) { cb(e); });
        return function () {};
      } catch (e) { cb(e); return function () {}; }
    },
    bufFrom: function (s, enc) { return bufferView(Buffer.from(s, enc || 'utf8')); },
    bufToString: function (buf, enc) {
      var b = (buf && buf.bufToArray) ? Buffer.from(buf.bufToArray()) : toBuf(buf);
      return b.toString(enc || 'utf8');
    },
    md5: function (str) { return crypto.createHash('md5').update(toBuf(str)).digest('hex'); },
    randomBytes: function (size) { return bufferView(crypto.randomBytes(size)); },
    rsaEncrypt: function (data, key) {
      var pem = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
      return bufferView(crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, toBuf(data)));
    },
    aesEn: function (data, mode, key, iv) {
      var cipher = crypto.createCipheriv(mode, toBuf(key), iv != null ? toBuf(iv) : null);
      return bufferView(Buffer.concat([cipher.update(toBuf(data)), cipher.final()]));
    },
    aesDe: function (data, mode, key, iv) {
      var decipher = crypto.createDecipheriv(mode, toBuf(key), iv != null ? toBuf(iv) : null);
      return bufferView(Buffer.concat([decipher.update(toBuf(data)), decipher.final()]));
    },
    zlibInflate: function (buf) {
      return new Promise(function (resolve, reject) {
        zlib.inflate(toBuf(buf), function (e, r) { if (e) reject(e); else resolve(bufferView(r)); });
      });
    },
    zlibDeflate: function (buf) {
      return new Promise(function (resolve, reject) {
        zlib.deflate(toBuf(buf), function (e, r) { if (e) reject(e); else resolve(bufferView(r)); });
      });
    }
  };

  var context = vm.createContext({});
  context.__bridge = bridge;
  vm.runInContext(workerData.prelude, context, { timeout: 5000 });
  vm.runInContext(workerData.script, context, { timeout: 15000 });

  // 事件式脚本（lx.on(request)）优先；否则按旧版 module.exports 提取 sources
  var isEvent = !!(lxHandlers['request'] && lxHandlers['request'].length);
  var legacySources = {};
  var sourceKeys = [];
  if (isEvent) {
    sourceKeys = ['_lxEvent'];
  } else {
    var exported = (context.module && context.module.exports) || {};
    if (exported.sources && typeof exported.sources === 'object') {
      legacySources = exported.sources;
    } else if (exported.default && exported.default.sources && typeof exported.default.sources === 'object') {
      legacySources = exported.default.sources;
    } else {
      var eks = Object.keys(exported);
      for (var k = 0; k < eks.length; k++) {
        var v = exported[eks[k]];
        if (v && typeof v === 'object') {
          var hasMethod = Object.keys(v).some(function (kk) { return typeof v[kk] === 'function'; });
          if (hasMethod) { legacySources = v; break; }
        }
      }
    }
    sourceKeys = Object.keys(legacySources);
  }
  if (!sourceKeys.length) {
    parentPort.postMessage({ type: 'init-error', message: '脚本未导出有效音源' });
    return;
  }

  parentPort.on('message', function (msg) {
    if (!msg || msg.type !== 'musicUrl') return;
    var p;
    if (isEvent) {
      var handler = lxHandlers['request'][0];
      var info = {
        source: msg.sourceKey === '_lxEvent' ? 'kw' : msg.sourceKey,
        action: 'musicUrl',
        info: { musicInfo: msg.songInfo, type: msg.quality }
      };
      p = Promise.resolve().then(function () { return handler(info); }).then(function (url) {
        return (typeof url === 'string' && url.indexOf('http') === 0) ? url : null;
      }).catch(function () { return null; });
    } else {
      var source = legacySources[msg.sourceKey];
      var fn = source && (source.getMusicUrl || source.get_url || source.getUrl);
      if (typeof fn !== 'function') { p = Promise.resolve(null); }
      else {
        p = Promise.resolve().then(function () { return fn(msg.songInfo, msg.quality); }).then(function (r) {
          if (r && typeof r === 'string' && r.indexOf('http') === 0) return r;
          if (r && r.url && typeof r.url === 'string') return r.url;
          return null;
        }).catch(function () { return null; });
      }
    }
    var done = false;
    var t = setTimeout(function () {
      if (done) return;
      done = true;
      parentPort.postMessage({ type: 'musicUrl-result', seq: msg.seq, url: null });
    }, CALL_TIMEOUT);
    p.then(function (url) {
      if (done) return;
      done = true; clearTimeout(t);
      parentPort.postMessage({ type: 'musicUrl-result', seq: msg.seq, url: url });
    }, function () {
      if (done) return;
      done = true; clearTimeout(t);
      parentPort.postMessage({ type: 'musicUrl-result', seq: msg.seq, url: null });
    });
  });

  parentPort.postMessage({ type: 'ready', sources: sourceKeys, isEvent: isEvent });
})().catch(function (e) {
  import('node:worker_threads').then(function (wt) {
    wt.parentPort.postMessage({ type: 'init-error', message: String((e && e.message) || e) });
  }).catch(function () {});
});
`;

function callTimeoutMs(): number {
  const v = Number(process.env.LX_CALL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 12_000;
}
function initTimeoutMs(): number {
  const v = Number(process.env.LX_INIT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20_000;
}

/**
 * worker 线程句柄：沙盒（vm + 桥 + 脚本）整体活在子线程。
 * 超时/删除脚本时 terminate —— 同步死循环只烧子线程、定时器与泄漏面随线程销毁；
 * worker 意外死亡后，下次调用会用存档脚本自动重建（self-heal）。
 */
class LxMusicRunner {
  private _sources: string[] = [];
  private _isEvent = false;
  private _worker: Worker | null = null;
  private _seq = 0;
  private _pending = new Map<number, (url: string | null) => void>();
  private _dead = false;

  constructor(
    private readonly _id: string,
    private readonly _script: string,
    private readonly _name: string
  ) {}

  isInitialized(): boolean { return this._sources.length > 0 || this._isEvent; }
  getAvailableSourceKeys(): string[] { return this._sources.slice(); }

  /** 起一个 worker 并等到 ready / init-error / 看门狗超时 */
  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let worker: Worker;
      try {
        worker = new Worker(WORKER_CODE, {
          eval: true,
          workerData: {
            prelude: SANDBOX_PRELUDE,
            script: this._script,
            name: this._name,
            maxBody: MAX_SANDBOX_BODY_BYTES,
            callTimeout: callTimeoutMs()
          },
          // 顺带限制 worker 堆，防脚本吃爆内存（默认值会与主进程共享上限）
          resourceLimits: { maxOldGenerationSizeMb: 256 }
        });
      } catch (err) {
        reject(err);
        return;
      }
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch { /* 已退出 */ }
        reject(new Error('脚本初始化超时'));
      }, initTimeoutMs());

      worker.on('message', (msg: any) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          this._sources = Array.isArray(msg.sources) ? msg.sources : [];
          this._isEvent = !!msg.isEvent;
          this._worker = worker;
          this._dead = false;
          resolve();
          return;
        }
        if (msg.type === 'init-error') {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          try { worker.terminate(); } catch { /* 已退出 */ }
          reject(new Error(String(msg.message || '脚本初始化失败')));
          return;
        }
        if (msg.type === 'musicUrl-result') {
          const resolveUrl = this._pending.get(msg.seq);
          if (resolveUrl) {
            this._pending.delete(msg.seq);
            resolveUrl(typeof msg.url === 'string' ? msg.url : null);
          }
        }
      });
      worker.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          try { worker.terminate(); } catch { /* 已退出 */ }
          reject(err);
          return;
        }
        console.warn('[LxMusic] worker 异常退出，下次调用时自动重建:', err?.message || err);
        this.kill();
      });
      worker.on('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          reject(new Error('worker 在初始化期间退出'));
        }
      });
    });
  }

  async init(): Promise<boolean> {
    try {
      await this.spawn();
      console.log('[LxMusic] worker 沙盒加载成功:', this._name, '音源:', this._sources.join(', ') || '(事件式)');
      return true;
    } catch (err: any) {
      console.error('[LxMusic] 脚本执行失败:', err?.message || err);
      return false;
    }
  }

  /** 调用前确保 worker 存活；死亡则用存档脚本自动重建 */
  private async ensureAlive(): Promise<boolean> {
    if (this._worker && !this._dead) return true;
    this._worker = null;
    this._dead = false;
    for (const resolve of this._pending.values()) resolve(null);
    this._pending.clear();
    try {
      await this.spawn();
      return this.isInitialized();
    } catch {
      return false;
    }
  }

  async getMusicUrl(sourceKey: string, songInfo: any, quality: string): Promise<string | null> {
    if (!(await this.ensureAlive())) return null;
    const worker = this._worker!;
    const seq = ++this._seq;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        // 同步死循环 / never-resolve：整个 worker 直接 terminate（它只烧子线程）；
        // 下次调用 ensureAlive 用存档脚本自动重建
        this._pending.delete(seq);
        this.kill();
        resolve(null);
      }, callTimeoutMs());
      this._pending.set(seq, (url) => {
        clearTimeout(timer);
        resolve(url);
      });
      try {
        worker.postMessage({ type: 'musicUrl', seq, sourceKey, songInfo, quality });
      } catch {
        clearTimeout(timer);
        this._pending.delete(seq);
        this.kill();
        resolve(null);
      }
    });
  }

  /** 回收资源：terminate worker —— 同步循环/定时器/泄漏面随线程一起销毁 */
  dispose(): void {
    this.kill();
  }

  private kill(): void {
    if (this._worker) {
      try { this._worker.terminate(); } catch { /* 已退出 */ }
    }
    this._worker = null;
    this._dead = true;
    for (const resolve of this._pending.values()) resolve(null);
    this._pending.clear();
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
  const runner = new LxMusicRunner(scriptId, scriptContent, scriptName || 'unknown');
  const ok = await runner.init();
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
  // terminate worker：脚本里的同步死循环 / 永久 setInterval / 泄漏面随线程一起销毁
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
