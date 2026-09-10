import { describe, it, expect } from 'vitest';
import {
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  BLOOM_VERTEX_SHADER,
  BLOOM_FRAGMENT_SHADER,
  DUST_VERTEX_SHADER,
  DUST_FRAGMENT_SHADER
} from './particleShaders';

/**
 * GLSL 只在浏览器里真正编译，tsc / vitest / vite build 都不会发现着色器问题。
 * 这里把「能在浏览器之外静态判定」的几类错误钉死：
 *  ① 括号不平衡（编译必挂）
 *  ② varying 在顶点里写了、片元里用了却没声明（编译必挂 / 值未定义）
 *  ③ uniform 在某 stage 里用了却没声明（编译必挂）
 *  ④ 流星依赖的关键坐标链路被改动（改了 gl_FragCoord 就会退回有方向歧义的 gl_PointCoord）
 */
const ALL = {
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  BLOOM_FRAGMENT_SHADER,
  DUST_VERTEX_SHADER,
  DUST_FRAGMENT_SHADER
} as const;

const count = (s: string, ch: string) => [...s].filter((c) => c === ch).length;

/** 取出某 stage 里声明的 varying 名（不含注释行） */
function declaredVaryings(src: string): string[] {
  const code = src.replace(/\/\/.*$/gm, '');
  return [...code.matchAll(/varying\s+(?:float|vec2|vec3|vec4)\s+([^;]+);/g)].flatMap((m) =>
    m[1].split(',').map((s) => s.trim())
  );
}

/** 取出某 stage 里声明的 uniform 名（不含注释行） */
function declaredUniforms(src: string): Set<string> {
  const code = src.replace(/\/\/.*$/gm, '');
  return new Set(
    [...code.matchAll(/uniform\s+\w+\s+([^;]+);/g)].flatMap((m) =>
      m[1].split(',').map((s) => s.trim().split(/\s+/).pop() as string)
    )
  );
}

describe('着色器静态一致性', () => {
  it('所有 shader 的 {} 与 () 都平衡（不平衡必编译失败）', () => {
    for (const [name, src] of Object.entries(ALL)) {
      expect(count(src, '{'), `${name} 的 {`).toBe(count(src, '}'));
      expect(count(src, '('), `${name} 的 (`).toBe(count(src, ')'));
    }
  });

  it('片元用到的 varying 都能在片元里解析到（含 #define 别名），且顶点里也声明了', () => {
    // varying 用了「打包 + 宏别名」：名字（vBright 等）由 #define 映射到 vPackN.x 这类分量，
    // 所以「可解析」= 直接声明过，或在 #define 里定义过。
    const macroNames = (src: string) =>
      [...src.matchAll(/^\s*#define\s+(\w+)\s+\w+\.\w/gm)].map((m) => m[1]);
    const vsResolvable = new Set([...declaredVaryings(VERTEX_SHADER), ...macroNames(VERTEX_SHADER)]);
    const pair: Array<[string, string]> = [
      ['FRAGMENT_SHADER', FRAGMENT_SHADER],
      ['BLOOM_FRAGMENT_SHADER', BLOOM_FRAGMENT_SHADER]
    ];
    for (const [name, fs] of pair) {
      const resolvable = new Set([...declaredVaryings(fs), ...macroNames(fs)]);
      const fsCode = fs.replace(/\/\/.*$/gm, '');
      for (const v of ['vColor', 'vBright', 'vRipple', 'vEdgeBoost', 'vAlpha', 'vSourceLum', 'vMeteor']) {
        // 用到了（出现次数 > 声明次数 说明有引用）
        const refs = (fsCode.match(new RegExp(`\\b${v}\\b`, 'g')) || []).length;
        const decl = resolvable.has(v) ? 1 : 0;
        if (refs > decl) {
          expect([...resolvable], `${name} 引用了 ${v} 但无法解析`).toContain(v);
          expect([...vsResolvable], `顶点未声明/未定义 ${v}`).toContain(v);
        }
      }
    }
  });

  it('各 stage 用到的 uniform 都必须在该 stage 声明', () => {
    for (const [name, src] of Object.entries(ALL)) {
      const declared = declaredUniforms(src);
      const used = new Set([...src.replace(/\/\/.*$/gm, '').matchAll(/\bu[A-Z]\w*/g)].map((m) => m[0]));
      const missing = [...used].filter((u) => !declared.has(u));
      expect(missing, `${name} 缺少 uniform 声明`).toEqual([]);
    }
  });
});

describe('极光流星', () => {
  it('顶点里保留了流星槽位与每波 3~5 颗的定义', () => {
    expect(VERTEX_SHADER).toContain('#define METEOR_SLOTS');
    expect(VERTEX_SHADER).toContain('#define METEOR_WAVE_PERIOD');
    // 3 + floor(hash * 3) → 3/4/5
    expect(VERTEX_SHADER).toMatch(/float meteorsThisWave = 3\.0 \+ floor\([\s\S]*?\* 3\.0\)/);
  });

  /**
   * ⚠️ 回归测试：空闲流星槽位必须走帘幕路径，不能靠片元兜底。
   *
   * METEOR_SLOTS 固定 5，但每波只启用 3~5 颗。早先的写法是 `if (pid < METEOR_SLOTS)`
   * 整段进流星分支，于是本波没启用的槽位也被设上了 sizeOverride（顶着点精灵上限的
   * 大尺寸），而片元里因为 vMeteor=0 落回普通点精灵路径 → 屏幕上出现几个
   * 「又大又圆、不成形状的白斑」。用户截图确认过这个现象。
   *
   * 正确写法：先算 meteorsThisWave，用 `if (pid < meteorsThisWave)` 才进流星分支。
   */
  it('流星分支的判定必须用本波启用数，而不是固定的槽位总数', () => {
    expect(VERTEX_SHADER).toMatch(/if \(pid < meteorsThisWave\)/);
    expect(VERTEX_SHADER).not.toMatch(/if \(pid < float\(METEOR_SLOTS\)\)/);
    // meteorsThisWave 必须在 pid 判定之前算出来，否则判定用的是未初始化的值
    const iCount = VERTEX_SHADER.indexOf('float meteorsThisWave =');
    const iGuard = VERTEX_SHADER.indexOf('if (pid < meteorsThisWave)');
    expect(iCount, 'meteorsThisWave 必须在流星分支判定之前定义').toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(iCount);
  });

  it('拖尾长度不等于点精灵边长（正方形精灵会硬裁斜向拖尾）', () => {
    // 片元里的 L 必须带一个 <1 的系数，否则拖尾顶到方框两端被裁
    expect(FRAGMENT_SHADER).toMatch(/float L\s*=\s*max\(uMeteorSize, 1\.0\)\s*\*\s*0\.\d+/);
    // 宽度不能跟着长度一起缩（否则短拖尾变粗棒），要独立地跟 uMeteorSize 走
    expect(FRAGMENT_SHADER).toMatch(/uMeteorSize \* 0\.0\d/);
  });

  it('极光预设必须有独立的粒子尺寸档（比默认明显更小）', () => {
    // 帘幕靠细点堆质感，共用默认档会变成一团粗颗粒
    expect(VERTEX_SHADER).toMatch(/uPreset > 5\.5 && uPreset < 6\.5/);
  });

  it('拖尾用窗口坐标计算，不用有 y 轴方向歧义的 gl_PointCoord', () => {
    expect(FRAGMENT_SHADER).toContain('gl_FragCoord.xy - vMeteorCenter');
    // 流星分支里不得出现 gl_PointCoord（那个分支只允许走窗口坐标）
    const branch = FRAGMENT_SHADER.slice(
      FRAGMENT_SHADER.indexOf('if (vMeteor > 0.002)'),
      FRAGMENT_SHADER.indexOf('vec4 tex = texture2D')
    );
    expect(branch).not.toContain('gl_PointCoord');
  });

  /**
   * ⚠️ 头部在哪一端由 axis 的正方向决定，这里把它钉死。
   *
   * axis = (cos(vPack1.z), sin(vPack1.z))，vPack1.z = ang ≈ 202°。
   * 在 gl_FragCoord（y 向上）系里 axis 指向**左下**，与世界里的飞行方向 dir **同向**。
   * u = (hf - along)/L，所以 u=0（头部）落在 along 最大的一侧，也就是**左下**。
   * 流星从右上飞向左下 → 头部在最前方（左下），拖尾朝来路（右上）拖。
   *
   * 曾经被误认为「头位置不对」，实际数学一直是对的（用户最终确认头就该在左下）。
   * 这条测试防止后续有人「顺手把符号反过来」。
   */
  it('流星头部必须在飞行前方（axis 正方向 = 左下），拖尾朝来路延伸', () => {
    // 角度定义在顶点：PI + 0.38 附近的第三象限（左下）
    expect(VERTEX_SHADER).toMatch(/float ang = PI \+ 0\.3\d/);
    // 位移方向与拖尾朝向共用同一个 ang（两处必须一致，否则头尾会打架）
    const iAng = VERTEX_SHADER.indexOf('float ang = PI +');
    const iDir = VERTEX_SHADER.indexOf('vec2 dir = vec2(cos(ang), sin(ang));');
    expect(iAng).toBeGreaterThan(-1);
    expect(iDir).toBeGreaterThan(iAng);
    // 角度以 PI 为基准（指向 -x，即左），加 0.38 让 y 分量为负（向下）→ 左下
    // sin(PI + 0.38) = -sin(0.38) < 0 ✅ 所以 dir 指向左下
    expect(Math.sin(Math.PI + 0.38)).toBeLessThan(0);
    expect(Math.cos(Math.PI + 0.38)).toBeLessThan(0);
    // 片元里 u 由 axialT 夹取而来，u=0 在 along 大的一侧（axis 正方向 = 左下 = 头部）
    expect(FRAGMENT_SHADER).toMatch(/float axialT = \(hf - along\) \/ L;/);
    expect(FRAGMENT_SHADER).toMatch(/float u\s*=\s*clamp\(axialT, 0\.0, 1\.0\);/);
    // 头部亮核必须贴在 along = +hf（不是精灵中心）
    expect(FRAGMENT_SHADER).toMatch(/float ha = along - hf;/);
  });

  /**
   * ⚠️⚠️ 头部前方必须收束，否则亮核看起来「长在拖尾中间」（用户截图抓到过）。
   *
   * 旧写法 `u = clamp((hf - along)/L, 0, 1)` 把 along > hf 的整片区域
   * （精灵框内头部前方还剩 uMeteorSize*0.09 ≈ 22px）都钳到 u = 0，
   * 也就是「头部轮廓」——prof 仍为 1、宽度仍最大，于是在**头部前方凭空多出一截
   * 和头部一样亮的拖尾**。实测那段 alpha 高达 0.90（头部峰值也才 1.0），
   * 视觉上亮核就被推到了整条的中间。
   *
   * 修法：保留 uRaw，另用 headCut 在 along > hf 处快速衰减，
   * 并把它乘进 w / prof / head 三处。
   */
  it('头部前方必须收束（否则亮核看起来在拖尾中间）', () => {
    expect(FRAGMENT_SHADER).toMatch(/float headCut\s*=\s*clamp\(1\.0 \+ axialT \* \d/);
    // headCut 必须同时作用于宽度、纵向亮度、头部亮核三处
    const nWidth = FRAGMENT_SHADER.match(/w \*= mix\([^)]*headCut\)/);
    expect(nWidth, 'headCut 必须收窄头部前方的宽度').toBeTruthy();
    expect(FRAGMENT_SHADER).toMatch(/float prof = tail \* tail \* tail \* tail \* headCut;/);
    expect(FRAGMENT_SHADER).toMatch(/\* headCut;\s*$/m);
  });

  /**
   * ⚠️ 头部宽度不能归零，否则会变成「棍子前端一个孤立小点」。
   * 这个形状改错过两次，两头都踩过：
   *   ① 头端留 0.16 保底宽度 → 钝头，叠上圆核像「棒子黏珠子」；
   *   ② 头端宽度直接归 0（sqrt(u)）→ 太单薄，头是个孤立小点。
   * 正解：头端宽度不为 0 但不最大（≈0.62 倍），最宽处落在头部稍后。
   */
  it('拖尾头部宽度不得归零（否则头部变成孤立小点）', () => {
    // 宽度公式里必须有一个非零常数项（0.6x 量级）
    expect(FRAGMENT_SHADER).toMatch(/float profileW = 0\.\d+ \+ 0\.\d+ \* sin\(/);
    expect(FRAGMENT_SHADER).not.toMatch(/float w\s*=\s*wMax \* headTaper/);
    // 还要有下限夹取，防止极端情况下归零
    expect(FRAGMENT_SHADER).toMatch(/clamp\(profileW, 0\.\d+, 1\.\d\)/);
  });

  /**
   * ⚠️⚠️ 这是本文件最重要的一条回归测试 —— 踩过两次大坑。
   *
   * GLSL ES 1.00 只保证 MAX_VARYING_VECTORS = 8，而 **ANGLE/D3D11（Windows Chrome
   * 默认后端）不会把多个「varying float a, b, c;」合并进同一槽**，每个声明实打实占一个。
   * 超限的后果不是画面变差，而是**顶点着色器编译失败 → 主层 + 泛光层全都不渲染**，
   * 表现成「所有粒子效果都没了」，而 tsc / vitest / oxlint / vite build / glsl-parser
   * 全部通过（唯一线索是浏览器 Console 的 `Vertex shader is not compiled.`）。
   *
   * 因此这里锁死两件事：
   *   ① 三个 stage 的 varying 槽位都必须 ≤ 8；
   *   ② 更严格地，必须 ≤ 5（当前是 4）—— 不再贴着上限走，而是留出余量。
   * 想加 varying 时，去 vPack0 / vPack1 里找空闲分量，不要新开声明。
   */
  it('varying 槽位必须留有安全余量（≤5 槽；超 8 会直接编译失败、粒子全消失）', () => {
    // 先剥掉行注释，否则注释里举例的旧声明会被算进来
    const countVaryingSlots = (sh: string) =>
      [...sh.replace(/\/\/.*$/gm, '').matchAll(/^\s*varying\s+\w+\s+([^;]+);/gm)].flatMap((m) =>
        m[1].split(',')
      ).length;
    for (const [name, sh] of [
      ['VERTEX_SHADER', VERTEX_SHADER],
      ['FRAGMENT_SHADER', FRAGMENT_SHADER],
      ['BLOOM_FRAGMENT_SHADER', BLOOM_FRAGMENT_SHADER]
    ] as const) {
      expect(countVaryingSlots(sh), `${name} 的 varying 槽位超过了安全阈值`).toBeLessThanOrEqual(5);
    }
    // 打包容器必须存在（数据一律走它们的分量传递）
    expect(VERTEX_SHADER).toContain('varying vec4 vPack0;');
    expect(VERTEX_SHADER).toContain('varying vec4 vPack1;');
    // 不允许再把旧的独立 float varying 加回来
    expect(VERTEX_SHADER).not.toMatch(/varying\s+float\s+vBright/);
    expect(VERTEX_SHADER).not.toMatch(/varying\s+vec2\s+vMeteorAxis/);
  });

  it('顶点为流星算出窗口中心（与 gl_FragCoord 同系）', () => {
    expect(VERTEX_SHADER).toMatch(/vMeteorCenter = \(gl_Position\.xy \/ gl_Position\.w/);
    expect(VERTEX_SHADER).toMatch(/uniform vec2 uResolution;/);
  });

  it('泛光层压掉流星的巨大圆点（否则会变成一坨大光斑）', () => {
    expect(BLOOM_FRAGMENT_SHADER).toContain('vMeteor');
    expect(BLOOM_FRAGMENT_SHADER).toMatch(/1\.0 - vMeteor \* 0\.9/);
  });

  it('流星强度在非流星粒子上为 0（片元分支默认不进入）', () => {
    expect(VERTEX_SHADER).toMatch(/vMeteor = 0\.0;/);
    expect(FRAGMENT_SHADER).toContain('if (vMeteor > 0.002)');
  });

  /**
   * 着色器是 **JS 模板字符串**：注释里出现反引号会提前结束字符串，
   * 让整个模块语法错误（tsc 会报一堆诡异的 "',' expected"）。
   * 这个坑踩过一次，用测试锁住。
   */
  it('着色器模板字符串内不得出现裸反引号', () => {
    for (const [name, sh] of [
      ['VERTEX_SHADER', VERTEX_SHADER],
      ['FRAGMENT_SHADER', FRAGMENT_SHADER],
      ['BLOOM_VERTEX_SHADER', BLOOM_VERTEX_SHADER],
      ['BLOOM_FRAGMENT_SHADER', BLOOM_FRAGMENT_SHADER]
    ] as const) {
      expect(sh.includes('`'), `${name} 内出现反引号，会截断 JS 模板字符串`).toBe(false);
    }
  });

  /**
   * GLSL ES 1.00 有一族「未来保留字」，拿它们当变量名会得到
   * `ERROR: 0:463: 'active' : Illegal use of reserved word` → 顶点着色器编译失败。
   *
   * 最阴的是这些词在 C / C++ / HLSL / JS 里都非常自然（尤其 active、filter），
   * 写的时候根本不会起疑；而 tsc / vitest / vite build 全都不报错，
   * 只在浏览器里表现为「整个粒子层不渲染」。这个坑踩过一次，用测试锁住。
   */
  it('不得用 GLSL 保留字当标识符（active / filter / layout 等）', () => {
    const RESERVED = new Set([
      'asm', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'packed', 'goto',
      'switch', 'default', 'inline', 'noinline', 'volatile', 'public', 'static', 'extern',
      'external', 'interface', 'long', 'short', 'double', 'half', 'fixed', 'unsigned',
      'lowp', 'mediump', 'highp', 'precision', 'input', 'output',
      'hvec2', 'hvec3', 'hvec4', 'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4',
      'sampler1D', 'sampler3D', 'sampler1DShadow', 'sampler2DShadow', 'sampler2DRect',
      'sampler3DRect', 'sampler2DRectShadow',
      'sizeof', 'cast', 'namespace', 'using',
      'attribute', 'const', 'bool', 'float', 'int', 'void', 'varying', 'uniform',
      'break', 'continue', 'do', 'for', 'while', 'if', 'else', 'in', 'out', 'inout',
      'discard', 'return', 'struct', 'true', 'false', 'main',
      // 「未来保留字」里的陷阱
      'active', 'filter', 'superp', 'common', 'partition', 'resource', 'patch', 'sample',
      'subroutine', 'layout', 'row_major', 'noperspective', 'smooth', 'flat',
      'centroid', 'invariant', 'precise', 'coherent', 'restrict', 'readonly', 'writeonly',
      'atomic_uint', 'buffer', 'shared'
    ]);
    // 只检查「声明位置」上的标识符（类型名后面那一个），避免把 uActive 之类的误判
    const declRe =
      /^\s*(?:const\s+)?(?:attribute\s+|varying\s+|uniform\s+)?(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|sampler2D)\s+([A-Za-z_]\w*)/;
    for (const [name, sh] of [
      ['VERTEX_SHADER', VERTEX_SHADER],
      ['FRAGMENT_SHADER', FRAGMENT_SHADER],
      ['BLOOM_FRAGMENT_SHADER', BLOOM_FRAGMENT_SHADER]
    ] as const) {
      const code = sh.replace(/\/\/.*$/gm, ''); // 剥掉注释再查
      for (const line of code.split('\n')) {
        const m = line.match(declRe);
        expect(m && RESERVED.has(m[1]), `${name} 用保留字 ${m?.[1]} 当标识符`).toBeFalsy();
      }
    }
  });
});
