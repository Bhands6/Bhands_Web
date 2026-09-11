/// <reference types="node" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readJson, writeJson, readString, writeString } from './safeStorage';

/**
 * 2026-09-11 全项目扫描的回归锁：
 * 三个 store 曾在模块顶层裸 JSON.parse(localStorage...)，坏 JSON 直接整站白屏；
 * 裸 setItem 在隐私模式抛错会中断 playTrack 的 finish() 后置流程。
 */
describe('safeStorage（坏数据 / 存储异常一律不抛错）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('键不存在回退 fallback', () => {
    expect(readJson('nope', [])).toEqual([]);
    expect(readString('nope')).toBeNull();
  });

  it('坏 JSON 回退 fallback 而不是抛错（白屏隐患的根）', () => {
    localStorage.setItem('bad', '{oops');
    expect(readJson('bad', { ok: true })).toEqual({ ok: true });
  });

  it('正常 JSON 正常解析', () => {
    localStorage.setItem('ok', JSON.stringify([1, 2, 3]));
    expect(readJson<number[]>('ok', [])).toEqual([1, 2, 3]);
    writeString('s', 'abc');
    expect(readString('s')).toBe('abc');
  });

  it('getItem/setItem 抛错（隐私模式）也只回退、不向上传播', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(readJson('k', 'fb')).toBe('fb');
    expect(readString('k')).toBeNull();
    expect(() => writeJson('k', { a: 1 })).not.toThrow();
    expect(() => writeString('k', 'v')).not.toThrow();
  });
});
