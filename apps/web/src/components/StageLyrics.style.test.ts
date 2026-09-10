/**
 * 歌词样式的结构性不变量。
 *
 * 为什么需要这些测试：歌词的发光/衬底都画在 `.stage-lyric-line` 的伪元素上，而伪元素
 * 向外外扩的尺寸受**祖先容器的 overflow** 支配。这类问题 tsc / oxlint / vite build 一律
 * 不报错，只有人眼在浏览器里才看得到（而且很容易被误判成"文字被裁"）。
 * 这里把踩过的坑固化成断言，改样式时能立刻发现回归。
 */
// 三斜线指令：只给本文件引入 node 类型（tsconfig.app.json 的 types 只有 vite/client，
// 全局加 node 会污染浏览器代码的类型环境）。@types/node 在 apps/web/node_modules 下已存在。
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 不用 `import css from '../index.css?raw'`：vitest 下 raw 导入返回空串（CSS 被 vite 的
// css 插件接管了）；也不用 new URL('./index.css', import.meta.url)（不是 file: scheme，会抛）。
// stdout 是 apps/web（见 vitest.config.ts 所在目录），拼绝对路径最稳。
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** 剥掉注释，避免断言命中注释里的正/反例（踩过） */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某个选择器规则块的规则体（从 `{` 到配对的 `}`）
 *  ⚠️ 必须在行首匹配：`.stage-lyric-line.current` 这个子串也出现在
 *  `#stage-lyrics.single .stage-lyric-line.current .sll-text` 里，且出现得更早，
 *  用 indexOf 裸找会取到错误的规则块（踩过）。 */
function ruleBody(selector: string): string {
  const re = new RegExp('^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
  const m = re.exec(code);
  expect(m, `选择器 ${selector} 必须作为独立规则存在`).not.toBeNull();
  const open = code.indexOf('{', m!.index);
  const close = code.indexOf('}', open);
  return code.slice(open + 1, close);
}

describe('歌词容器的 overflow 与发光层的匹配', () => {
  it('当前行发光层 ::after 确实向上下大幅外扩', () => {
    const body = ruleBody('.stage-lyric-line.current::after');
    // inset: -55% -12% —— 纵向外扩 55%，绘制盒高约为行高的 2.1 倍
    const m = body.match(/inset:\s*-([\d.]+)%\s+-([\d.]+)%/);
    expect(m, '::after 应使用百分比 inset').not.toBeNull();
    expect(Number(m![1]), '纵向外扩比例').toBeGreaterThanOrEqual(40);
  });

  it('单行模式必须放开 overflow（否则发光被裁成硬边亮条）', () => {
    const body = ruleBody('#stage-lyrics.single');
    expect(body).toMatch(/overflow:\s*visible/);
    // 不允许在单行规则里再出现 hidden
    expect(body).not.toMatch(/overflow:\s*hidden/);
  });

  it('基础容器仍保留 overflow: hidden（多行模式靠它收口）', () => {
    const body = ruleBody('#stage-lyrics');
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/mask-image:/);
  });

  it('单行模式关掉了 mask-image（没有 mask 兜底，所以才必须放开 overflow）', () => {
    const body = ruleBody('#stage-lyrics.single');
    expect(body).toMatch(/mask-image:\s*none/);
  });

  it('衬底渐变半径不超过 50%（淡出必须在元素盒内完成）', () => {
    const body = ruleBody('.stage-lyric-line.current');
    // 取 background 里的 ellipse 尺寸
    const m = body.match(/ellipse\s+([\d.]+)%\s+([\d.]+)%/);
    expect(m, '衬底应使用显式 ellipse').not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(50);
    expect(Number(m![2])).toBeLessThanOrEqual(50);
  });
});
