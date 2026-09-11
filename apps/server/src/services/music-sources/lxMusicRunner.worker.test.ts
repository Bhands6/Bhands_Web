/// <reference types="node" />
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initRunner,
  parseFromLxMusic,
  listRunners
} from './lxMusicRunner';

/**
 * 2026-09-11 扫描遗留项的回归锁：lxMusicRunner 已整体迁入 worker_threads ——
 *  ① 同步 while(true) 只烧 worker（超时 terminate + 存档自动重建），不再冻结主进程；
 *  ② never-resolve 的 handler 在主侧限时返回 null；
 *  ③ 沙盒 HTTP 有内网 SSRF 黑名单（127.0.0.1/内网段不可访问）。
 * timeout 用 LX_CALL_TIMEOUT_MS / LX_INIT_TIMEOUT_MS 压短，整文件 < 10s。
 *
 * ⚠️ lxMusicRunner 在模块顶层用 DATA_DIR 定位存档文件 —— 必须先把 DATA_DIR 指到临时目录
 *    再动态 import，避免测试把假脚本写进真实 data/lx-scripts.json。
 */

let tmpDir: string;
let mod: typeof import('./lxMusicRunner');

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['DATA_DIR', 'LX_CALL_TIMEOUT_MS', 'LX_INIT_TIMEOUT_MS']) {
    savedEnv[k] = process.env[k];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhands-lx-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.LX_CALL_TIMEOUT_MS = '500';
  process.env.LX_INIT_TIMEOUT_MS = '3000';
  mod = await import('./lxMusicRunner');
});

afterAll(() => {
  for (const k of Object.keys(savedEnv)) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const EVENT_FIXED = `
lx.on(lx.EVENT_NAMES.request, function (info) {
  return 'http://example.com/fixed.mp3';
});
`;

const EVENT_NEVER = `
lx.on(lx.EVENT_NAMES.request, function () {
  return new Promise(function () {});
});
`;

const EVENT_LOOP = `
lx.on(lx.EVENT_NAMES.request, function () {
  var x = 0;
  while (true) { x++; }
});
`;

const EVENT_SSRF = `
lx.on(lx.EVENT_NAMES.request, function () {
  return fetch('http://127.0.0.1:9/x').then(function (r) {
    return 'http://leaked.example/x';
  }).catch(function () {
    return null;
  });
});
`;

const LEGACY = `
module.exports = {
  sources: {
    wy: { getMusicUrl: function (songInfo, quality) { return 'http://legacy.example/' + quality; } }
  }
};
`;

describe('lxMusicRunner worker 沙盒', () => {
  it('事件式脚本：getMusicUrl 经消息协议返回 URL', async () => {
    const runner = await mod.initRunner('t-fixed', EVENT_FIXED, '固定URL测试');
    expect(runner).not.toBeNull();
    expect(runner!.getAvailableSourceKeys()).toEqual(['_lxEvent']);
    const r = await mod.parseFromLxMusic({ id: '1', name: 'a', artists: 'b', duration: 200000, quality: 'standard', scriptId: 't-fixed' });
    expect(r?.url).toBe('http://example.com/fixed.mp3');
    expect(r?.source).toBe('lx-wy');
  }, 15_000);

  it('旧版 module.exports 脚本：按音质档位路由', async () => {
    const runner = await mod.initRunner('t-legacy', LEGACY, '旧版测试');
    expect(runner).not.toBeNull();
    const r = await mod.parseFromLxMusic({ id: '2', name: 'a', artists: 'b', duration: 200000, quality: 'standard', scriptId: 't-legacy' });
    expect(r?.url).toBe('http://legacy.example/128k');
  }, 15_000);

  it('never-resolve 的 handler：主侧限时返回 null（不永久悬挂）', async () => {
    const runner = await mod.initRunner('t-never', EVENT_NEVER, '悬挂测试');
    expect(runner).not.toBeNull();
    const start = Date.now();
    const r = await mod.parseFromLxMusic({ id: '3', name: 'a', artists: 'b', duration: 200000, quality: 'standard', scriptId: 't-never' });
    expect(r).toBeNull();
    expect(Date.now() - start).toBeLessThan(8000);
  }, 20_000);

  it('同步 while(true)：只烧 worker，超时 terminate 后主线程无恙且可继续用新脚本', async () => {
    const runner = await mod.initRunner('t-loop', EVENT_LOOP, '死循环测试');
    expect(runner).not.toBeNull();
    const start = Date.now();
    const r = await mod.parseFromLxMusic({ id: '4', name: 'a', artists: 'b', duration: 200000, quality: 'standard', scriptId: 't-loop' });
    expect(r).toBeNull();
    expect(Date.now() - start).toBeLessThan(9000);
    // terminate 后下一次调用自动重建（用存档脚本），证明自愈链路可用
    const runner2 = await mod.initRunner('t-loop-after', EVENT_FIXED, '重建测试');
    expect(runner2).not.toBeNull();
    const r2 = await mod.parseFromLxMusic({ id: '5', name: 'a', artists: 'b', duration: 200000, quality: 'standard', scriptId: 't-loop-after' });
    expect(r2?.url).toBe('http://example.com/fixed.mp3');
  }, 25_000);

  it('内网 SSRF 黑名单：沙盒 fetch 到 127.0.0.1 被拒绝', async () => {
    const runner = await mod.initRunner('t-ssrf', EVENT_SSRF, 'SSRF测试');
    expect(runner).not.toBeNull();
    const r = await mod.parseFromLxMusic({ id: '6', name: 'a', artists: 'b', duration: 200000, quality: 'standard', scriptId: 't-ssrf' });
    expect(r).toBeNull();
  }, 15_000);

  it('脚本管理登记表：listRunners / removeRunner', async () => {
    expect(listRunners().length).toBeGreaterThanOrEqual(4);
    mod.removeRunner('t-fixed');
    expect(mod.listRunners().some((r) => r.id === 't-fixed')).toBe(false);
  });
});
