/// <reference types="node" />
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionPersistEnabled, trustProxyEnabled } from './envFlags';
import { setNeteaseCookie } from './neteaseSession';

/**
 * 2026-09-11 部署/本地拆分的回归锁：
 * cookie 明文落盘与 trustProxy 改为环境开关，默认值必须取「部署安全侧」（全关）。
 */

const KEYS = ['SESSION_PERSIST', 'TRUST_PROXY', 'DATA_DIR'] as const;
const savedValues: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of KEYS) {
    const saved = savedValues[k];
    if (saved === undefined) delete process.env[k];
    else process.env[k] = saved;
  }
  vi.restoreAllMocks();
});

function setEnv(key: (typeof KEYS)[number], value: string | undefined): void {
  if (!(key in savedValues)) savedValues[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('envFlags：默认值必须取部署安全侧', () => {
  it('什么都不配置 → 持久化与 trustProxy 双双关闭', () => {
    setEnv('SESSION_PERSIST', undefined);
    setEnv('TRUST_PROXY', undefined);
    expect(sessionPersistEnabled()).toBe(false);
    expect(trustProxyEnabled()).toBe(false);
  });

  it('on / ON / 1 / true（含空白）都算开', () => {
    for (const v of ['on', 'ON', '1', 'true', ' True ']) {
      setEnv('SESSION_PERSIST', v);
      setEnv('TRUST_PROXY', v);
      expect(sessionPersistEnabled(), `SESSION_PERSIST=${v}`).toBe(true);
      expect(trustProxyEnabled(), `TRUST_PROXY=${v}`).toBe(true);
    }
  });

  it('off / 0 / 乱值都算关', () => {
    for (const v of ['off', '0', 'false', 'yes-please', ' ']) {
      setEnv('SESSION_PERSIST', v);
      setEnv('TRUST_PROXY', v);
      expect(sessionPersistEnabled(), `SESSION_PERSIST=${v}`).toBe(false);
      expect(trustProxyEnabled(), `TRUST_PROXY=${v}`).toBe(false);
    }
  });
});

describe('neteaseSession 持久化门控', () => {
  it('SESSION_PERSIST 未开 → setNeteaseCookie 不写任何文件（磁盘不留凭据）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bhands-session-test-'));
    setEnv('DATA_DIR', tmp);
    setEnv('SESSION_PERSIST', undefined);
    const spy = vi.spyOn(fs, 'writeFileSync');

    const req = { headers: { cookie: 'bhands_sid=test-sid-1' } } as any;
    const reply = { header: () => {} } as any;
    setNeteaseCookie(req, reply, 'MUSIC_U=fake-cookie');

    expect(spy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'ncm-cookies.json'))).toBe(false);
    spy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('SESSION_PERSIST=on → 写入 DATA_DIR 指向的存档（不碰真实数据目录）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bhands-session-test-'));
    setEnv('DATA_DIR', tmp);
    setEnv('SESSION_PERSIST', 'on');

    const req = { headers: { cookie: 'bhands_sid=test-sid-2' } } as any;
    const reply = { header: () => {} } as any;
    setNeteaseCookie(req, reply, 'MUSIC_U=fake-cookie');

    const file = path.join(tmp, 'ncm-cookies.json');
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data['test-sid-2'].cookie).toBe('MUSIC_U=fake-cookie');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
