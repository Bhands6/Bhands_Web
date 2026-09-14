/**
 * LX 音源脚本的浏览器本地管理：脚本只存 localStorage，不上传服务器。
 * 播放时把脚本随解析请求带到服务端「一次性沙盒」执行（跑完即销毁，服务端不留副本）——
 * 脚本必须服务端执行的原因：音源 API 无 CORS 头，浏览器无法直连。
 * 服务器侧持久音源只有站长预装的内置音源（不在面板展示）。
 */

const SCRIPTS_KEY = 'bhands.lx.scripts';
const ACTIVE_KEY = 'bhands.lx.activeId';
/** 与服务端旧上限一致，防 localStorage 无界膨胀 */
const MAX_LOCAL_SCRIPTS = 12;
/** 单脚本大小上限（与服务端一致） */
export const MAX_LOCAL_SCRIPT_BYTES = 512_000;

export interface LocalLxScript {
  id: string;
  name: string;
  script: string;
}

function readAll(): LocalLxScript[] {
  try {
    const raw = localStorage.getItem(SCRIPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 字段校验：损坏条目直接丢弃（不抛错，坏一条不影响其余）
    return parsed.filter(
      (s: any) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.script === 'string'
    ) as LocalLxScript[];
  } catch {
    return [];
  }
}

function writeAll(list: LocalLxScript[]): void {
  try {
    localStorage.setItem(SCRIPTS_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式/配额满：静默失败（下次读取仍为旧数据，不崩 UI）
  }
}

/** 本地脚本列表（存储顺序） */
export function listLocalLxScripts(): LocalLxScript[] {
  return readAll();
}

/** 当前活跃的本地脚本；活跃 id 失效（被删/损坏）时回落第一个，全空返回 null */
export function getActiveLocalLxScript(): LocalLxScript | null {
  const list = readAll();
  if (!list.length) return null;
  let activeId = '';
  try {
    activeId = localStorage.getItem(ACTIVE_KEY) || '';
  } catch { /* 读不到按无活跃处理 */ }
  return list.find((s) => s.id === activeId) || list[0];
}

/** 新增本地脚本（大小/数量校验在调用前由 UI 提示，这里做最终防御） */
export function addLocalLxScript(name: string, script: string): { ok: boolean; error?: string } {
  if (!script || !script.trim()) return { ok: false, error: '脚本内容为空' };
  if (script.length > MAX_LOCAL_SCRIPT_BYTES) return { ok: false, error: '脚本过大（上限 500KB）' };
  const list = readAll();
  if (list.length >= MAX_LOCAL_SCRIPTS) return { ok: false, error: '脚本数量已达上限（12 个），请先删除不用的脚本' };
  const item: LocalLxScript = {
    id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name || '本地脚本 ' + (list.length + 1),
    script
  };
  list.push(item);
  writeAll(list);
  // 首个脚本自动激活（与旧服务端行为一致：无活跃时新传即活跃）
  try {
    if (!localStorage.getItem(ACTIVE_KEY)) localStorage.setItem(ACTIVE_KEY, item.id);
  } catch { /* 忽略 */ }
  return { ok: true };
}

export function removeLocalLxScript(id: string): void {
  const list = readAll().filter((s) => s.id !== id);
  writeAll(list);
  try {
    if (localStorage.getItem(ACTIVE_KEY) === id) {
      if (list.length) localStorage.setItem(ACTIVE_KEY, list[0].id);
      else localStorage.removeItem(ACTIVE_KEY);
    }
  } catch { /* 忽略 */ }
}

export function setActiveLocalLxScript(id: string): void {
  try {
    if (readAll().some((s) => s.id === id)) localStorage.setItem(ACTIVE_KEY, id);
  } catch { /* 忽略 */ }
}
