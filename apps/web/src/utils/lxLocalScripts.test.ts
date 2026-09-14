import { describe, it, expect, beforeEach } from 'vitest';
import {
  listLocalLxScripts,
  getActiveLocalLxScript,
  addLocalLxScript,
  removeLocalLxScript,
  setActiveLocalLxScript,
  MAX_LOCAL_SCRIPT_BYTES
} from './lxLocalScripts';

/**
 * LX 本地脚本管理（localStorage）回归锁：
 * 脚本只存用户浏览器，上传/删除/激活全部本地完成（无网络调用）。
 * 活跃 id 失效时回落第一个；损坏数据容错为空列表。
 */

const SCRIPT_A = "lx.on(lx.EVENT_NAMES.request, function () { return 'http://a.example/x.mp3'; });";
const SCRIPT_B = "lx.on(lx.EVENT_NAMES.request, function () { return 'http://b.example/x.mp3'; });";

beforeEach(() => {
  localStorage.clear();
});

describe('lxLocalScripts 本地脚本管理', () => {
  it('新增脚本：默认命名、首个自动激活', () => {
    const r = addLocalLxScript('我的音源', SCRIPT_A);
    expect(r.ok).toBe(true);
    const list = listLocalLxScripts();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('我的音源');
    expect(list[0].id).toMatch(/^local_/);
    expect(getActiveLocalLxScript()?.id).toBe(list[0].id);
  });

  it('空脚本与超大脚本被拒绝', () => {
    expect(addLocalLxScript('空', '   ').ok).toBe(false);
    expect(addLocalLxScript('超大', 'x'.repeat(MAX_LOCAL_SCRIPT_BYTES + 1)).ok).toBe(false);
    expect(listLocalLxScripts()).toHaveLength(0);
  });

  it('数量上限 12 个', () => {
    for (let i = 0; i < 12; i++) {
      expect(addLocalLxScript('s' + i, SCRIPT_A + i).ok).toBe(true);
    }
    expect(addLocalLxScript('s13', SCRIPT_B).ok).toBe(false);
    expect(listLocalLxScripts()).toHaveLength(12);
  });

  it('激活切换与删除后回落第一个；全删后无活跃', () => {
    addLocalLxScript('A', SCRIPT_A);
    addLocalLxScript('B', SCRIPT_B);
    const list = listLocalLxScripts();
    expect(getActiveLocalLxScript()?.id).toBe(list[0].id); // 首个自动激活

    setActiveLocalLxScript(list[1].id);
    expect(getActiveLocalLxScript()?.id).toBe(list[1].id);

    removeLocalLxScript(list[1].id);
    expect(getActiveLocalLxScript()?.id).toBe(list[0].id); // 回落第一个

    removeLocalLxScript(list[0].id);
    expect(listLocalLxScripts()).toHaveLength(0);
    expect(getActiveLocalLxScript()).toBeNull();
  });

  it('删除不存在的 id 不影响现有数据', () => {
    addLocalLxScript('A', SCRIPT_A);
    removeLocalLxScript('local_not_exist');
    expect(listLocalLxScripts()).toHaveLength(1);
  });

  it('损坏的 localStorage 数据容错为空列表（不抛错）', () => {
    localStorage.setItem('bhands.lx.scripts', '{broken json');
    expect(listLocalLxScripts()).toEqual([]);
    expect(getActiveLocalLxScript()).toBeNull();
    // 修复后可继续写入
    expect(addLocalLxScript('A', SCRIPT_A).ok).toBe(true);
    expect(listLocalLxScripts()).toHaveLength(1);
  });

  it('损坏条目（缺字段）被过滤，不影响合法条目', () => {
    localStorage.setItem(
      'bhands.lx.scripts',
      JSON.stringify([{ id: 'local_x' }, null, { id: 'local_ok', name: 'ok', script: SCRIPT_A }])
    );
    const list = listLocalLxScripts();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('local_ok');
  });
});
