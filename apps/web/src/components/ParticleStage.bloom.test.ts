// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { VERTEX_SHADER, BLOOM_VERTEX_SHADER, deriveBloomVertexShader } from './particleShaders';

/**
 * 回归测试：泛光层的顶点着色器是用字符串补丁从主着色器派生的。
 *
 * 背景：这个补丁曾经因为改动了 `gl_PointSize` 那一行的表达式而**静默失效**，
 * 导致 uBloomSize（2.65×）没被乘进去，泛光层退化成与主层同尺寸，
 * 粒子失去加色光晕 —— 用户看到的现象就是「粒子效果都没了」。
 *
 * 下面这些断言把「补丁必须命中」锁死。
 */
describe('泛光顶点着色器派生', () => {
  it('声明 uBloomSize（否则着色器会因未定义变量编译失败）', () => {
    expect(BLOOM_VERTEX_SHADER).toContain('uniform float uMouseActive, uPixel, uColorMixT, uBloomSize;');
  });

  it('把 uBloomSize 乘进 gl_PointSize（这才是泛光层 2.65× 尺寸的来源）', () => {
    const m = BLOOM_VERTEX_SHADER.match(/gl_PointSize\s*=\s*([^;]+);/);
    expect(m, '未找到 gl_PointSize 赋值').toBeTruthy();
    expect(m![1]).toMatch(/\*\s*uBloomSize\s*$/);
  });

  it('主着色器本身不含 uBloomSize（主层不该被放大）', () => {
    expect(VERTEX_SHADER).not.toContain('uBloomSize');
  });

  it('表达式里出现新系数也不会打坏补丁（本轮就是栽在这里）', () => {
    // 模拟以后又往尺寸表达式里加系数的情况
    const mutated = VERTEX_SHADER.replace(
      /gl_PointSize\s*=\s*([^;]+);/,
      'gl_PointSize = $1 * uSomeFutureFactor;'
    );
    expect(mutated).not.toBe(VERTEX_SHADER); // 前提：确实改到了
    const out = deriveBloomVertexShader(mutated);
    const expr = out.match(/gl_PointSize\s*=\s*([^;]+);/)![1];
    // 全新系数与 uBloomSize 都要在；顺序无关（整条式子都是乘法）
    expect(expr).toContain('uSomeFutureFactor');
    expect(expr).toMatch(/\*\s*uBloomSize/);
  });

  it('锚点缺失时直接抛错，而不是静默退化成 1×', () => {
    expect(() => deriveBloomVertexShader('precision highp float;\nvoid main(){}\n')).toThrow(/泛光顶点着色器派生失败/);
  });
});
