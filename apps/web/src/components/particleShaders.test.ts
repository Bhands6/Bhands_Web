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
    // 流星分支里不得出现 gl_PointCoord（那个分支只允许走窗口坐标）。
    // ⚠️ 终点锚是流星分支之后的第一条主路径语句：星云分支（合法使用 gl_PointCoord）
    //    也排在圆点纹理采样之前，不能拿 tex 采样行当锚点。
    const branch = FRAGMENT_SHADER.slice(
      FRAGMENT_SHADER.indexOf('if (vMeteor > 0.002)'),
      FRAGMENT_SHADER.indexOf('vec3 col = vColor * vBright;')
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

describe('声波地形 / 螺旋星云（预设 9 / 10）', () => {
  it('两个预设都注册了 shader 分支（9 用 else if 区间、10 用兜底 else）', () => {
    // 9 必须写成区间判定，才能给 10 留出 > 9.5 的空间；10 是最后一个分支，用 else 兜底
    expect(VERTEX_SHADER).toMatch(/else if \(uPreset < 9\.5\)/);
    // 第八个预设（迸发 8）必须收窄成区间，不能再是裸 else —— 否则 9/10 永远走不到
    expect(VERTEX_SHADER).toMatch(/else if \(uPreset < 8\.5\)/);
    const i9 = VERTEX_SHADER.indexOf('else if (uPreset < 9.5)');
    const i10 = VERTEX_SHADER.indexOf('Preset 10: SPIRAL');
    expect(i9, '预设 9 的分支必须存在').toBeGreaterThan(-1);
    expect(i10, '预设 10 的分支必须存在').toBeGreaterThan(i9);
  });

  /**
   * ⚠️ SONIC 的地形整块必须落在相机**前方**（z < 0）。
   *
   * 相机 radius=9.2 / phi=0.30，若地形有粒子跑到 z >= 0 就会贴到镜头上，
   * 表现为一块糊在屏幕上的亮斑。这里用「纵深世界坐标 + 整体推远量」静态验算
   * 最远端（gz=1）与最近端（gz=0）的 z 都小于 0。
   */
  it('声波地形的 z 必须整体在相机前方（否则会糊到镜头上）', () => {
    const mZ = VERTEX_SHADER.match(/float worldZ = \(gz - 0\.5\) \* ([\d.]+);/);
    const mPush = VERTEX_SHADER.match(/pos\.z = worldZ - ([\d.]+);/);
    expect(mZ, '未找到 worldZ 定义').toBeTruthy();
    expect(mPush, '未找到 pos.z 的推远量').toBeTruthy();
    const halfDepth = Number(mZ![1]) / 2;
    const push = Number(mPush![1]);
    // gz=0 → worldZ = -halfDepth；gz=1 → worldZ = +halfDepth；两者都要 +(-push) 后 < 0
    expect(+halfDepth - push, '最近端（gz=0）跑到了相机后方').toBeLessThan(0);
    expect(halfDepth - push, '最远端（gz=1）跑到了相机后方').toBeLessThan(0);
  });

  /**
   * ⚠️ 不能用 exp(-pow(d, 2.0))。
   *
   * GLSL 的 pow 在底数为负时**未定义**，部分驱动直接返回 NaN，
   * 于是整个扫描波前（进而整个预设）变成 NaN 消失。
   * 平方必须写成 d * d。
   */
  it('声波扫描波前不得用 pow 求平方（负底数 pow 未定义 → NaN）', () => {
    const sonic = VERTEX_SHADER.slice(
      VERTEX_SHADER.indexOf('Preset 9: SONIC'),
      VERTEX_SHADER.indexOf('Preset 10: SPIRAL')
    ).replace(/\/\/.*$/gm, '');
    expect(sonic.length, '没截到 SONIC 分支').toBeGreaterThan(100);
    expect(sonic).not.toMatch(/pow\s*\([^)]*\*\s*[^)]*,\s*2\.0\)/);
    // 必须是先算差值再自乘
    expect(sonic).toMatch(/float dz = \(gz - scanPos\) \* [\d.]+;/);
    expect(sonic).toMatch(/exp\(-dz \* dz\)/);
  });

  /**
   * ⚠️ SPIRAL 的半径分布必须是「中心密」，不能用 sqrt（面积均匀）。
   *
   * 星云的面亮度从中心向外衰减；用 sqrt 会得到一个中空的甜甜圈
   * （实测外圈 r 在 4.5~5.4 那段占 33% 的点，而核球只占 3%）。
   * 正确做法是 pow(aUv.x, >1) 把点往中心压（v8 用 GALAXY_RADIAL_POW 常量）。
   */
  it('螺旋星云的半径分布必须向中心聚集（不能用 sqrt 的面积均匀分布）', () => {
    const spiral = VERTEX_SHADER.slice(VERTEX_SHADER.indexOf('Preset 10: SPIRAL'));
    expect(spiral.length, '没截到 SPIRAL 分支').toBeGreaterThan(100);
    // 底数允许被 clamp() 包一层（防 NaN）；幂次可以是字面量，也可以是 #define 常量
    const m = spiral.match(/float rr = pow\(clamp\(aUv\.x, 0\.0, 1\.0\), ([A-Za-z_][\w.]*)\) \* SPIRAL_RMAX/);
    expect(m, '未找到半径分布公式').toBeTruthy();
    const raw = m![1];
    const power = /^\d/.test(raw)
      ? Number(raw)
      : Number(VERTEX_SHADER.match(new RegExp(`#define ${raw} ([\\d.]+)`))?.[1] ?? 0);
    expect(power, '半径幂次必须 > 1 才会向中心聚集').toBeGreaterThan(1);
    expect(spiral).not.toMatch(/float rr = sqrt\(aUv\.x\)/);
  });

  /**
   * ⚠️ 星等 / 闪烁必须在**分支之外**可见（v8 用 galaxyStar / galaxyTwinkle）。
   *
   * 两者在 SPIRAL 分支里赋值，但粒子尺寸公式在分支之外 ——
   * 若把声明写在分支内，尺寸公式就看不到它（GLSL 编译失败或取到垃圾值）。
   * 所以必须在所有分支之前先声明并初始化为中性值。
   */
  it('螺旋星云的星等/闪烁必须在分支外声明并初始化', () => {
    expect(VERTEX_SHADER).toMatch(/float galaxyStar = 1\.0;/);
    expect(VERTEX_SHADER).toMatch(/float galaxyTwinkle = 0\.5;/);
    const iDecl = VERTEX_SHADER.indexOf('float galaxyStar = 1.0;');
    const iAssign = VERTEX_SHADER.indexOf('galaxyStar = pow(clamp(hash11(');
    const iUse = VERTEX_SHADER.indexOf('depthSize * galaxyStar', iDecl);
    expect(iAssign, 'SPIRAL 分支里必须给 galaxyStar 赋值').toBeGreaterThan(iDecl);
    expect(iUse, '尺寸公式必须读 galaxyStar 才能体现星等分化').toBeGreaterThan(iAssign);
  });

  it('两个新预设都有独立的尺寸档与亮度档', () => {
    // 尺寸：9 要小而均匀（否则脊顶鼓成珠子）；10 走星等分化档（galaxyStar 驱动，
    //   少量大亮星 + 大量小星）—— 这里只要求「各自有独立档」，
    //   具体数值由 v8 那组断言（下限 ≥0.3、上限 ≥5.0）负责。
    expect(VERTEX_SHADER).toMatch(/uPreset > 9\.5[\s\S]{0,700}?sz = clamp\(depthSize \* galaxyStar/);
    expect(VERTEX_SHADER).toMatch(/uPreset > 8\.5[\s\S]{0,220}?sz = clamp\(depthSize \* 0\.5\d/);
    // 亮度：两者都要有独立档，不能共用 6~8 的通用档
    expect(VERTEX_SHADER).toMatch(/uPreset > 8\.5 && uPreset < 9\.5/);
    expect(VERTEX_SHADER).toMatch(/else if \(uPreset > 9\.5\)/);
  });
});

describe('螺旋星云 v8（2 主旋臂 + 差速自转，对齐新参考实现）', () => {
  const spiral = () =>
    VERTEX_SHADER.slice(VERTEX_SHADER.indexOf('Preset 10: SPIRAL')).replace(/\/\/.*$/gm, '');
  const num = (re: RegExp, label: string): number => {
    const m = VERTEX_SHADER.match(re);
    if (!m) throw new Error(`未找到 ${label}`);
    return Number(m[1]);
  };

  /**
   * 新参考实现的核心形态：**2 条主旋臂** + 线性缠绕（spinAngle = r * spin）。
   * v7 的 4 臂 log 螺线方案已整体替换；条数必须由 GALAXY_BRANCHES 统一控制。
   */
  it('旋臂必须是 2 条主臂 + 线性缠绕（r * SPIN），由常量统一控制', () => {
    const branches = num(/#define GALAXY_BRANCHES ([\d.]+)/, 'GALAXY_BRANCHES');
    expect(branches, '新参考图是 2 条主旋臂 + 分支').toBe(2);
    const spin = num(/#define GALAXY_SPIN ([\d.]+)/, 'GALAXY_SPIN');
    expect(spin, '缠绕系数过小看不出螺旋').toBeGreaterThanOrEqual(1.0);
    expect(spin, '缠绕系数过大会把外缘甩出取景框').toBeLessThanOrEqual(2.0);
    const s = spiral();
    expect(s, '臂偏移必须由 GALAXY_BRANCHES 均分 2π').toMatch(
      /float armOffset = \(armPick \/ GALAXY_BRANCHES\) \* 2\.0 \* PI;/,
    );
    expect(s, '臂相必须是线性缠绕（对齐参考实现 spinAngle = r * spin）').toMatch(
      /float ang = armOffset \+ rr \* GALAXY_SPIN;/,
    );
    // v7 的 log 螺线必须已移除
    expect(s, 'log 螺线必须已替换为线性缠绕').not.toMatch(/log\(max\(rr/);
  });

  /**
   * ⚠️「像云而不是像线」的唯一来源：臂内弥散必须是 **pow 长尾 × 随机正负**。
   * pow(h, P)（P>1）让绝大多数点贴着臂心、少量甩得远 —— 均匀散布会糊成一片，
   * 确定性偏移会退化成平行线束。
   */
  it('臂内弥散必须是 pow 长尾随机（armScatter），法向压薄成盘', () => {
    const power = num(/#define GALAXY_RANDOMNESS_POWER ([\d.]+)/, 'GALAXY_RANDOMNESS_POWER');
    expect(power, '长尾幂次必须 >2.5 才能既贴臂又有星云晕').toBeGreaterThanOrEqual(2.5);
    const rnd = num(/#define GALAXY_RANDOMNESS ([\d.]+)/, 'GALAXY_RANDOMNESS');
    expect(rnd, '弥散太小镇不住噪声、太大会糊成一片').toBeGreaterThanOrEqual(0.25);
    expect(rnd).toBeLessThanOrEqual(0.8);
    const s = spiral();
    expect(s, '弥散必须经由 armScatter 辅助函数（长尾 × 随机正负）').toMatch(/float scX = armScatter\(/);
    expect(s).toMatch(/float scZ = armScatter\(/);
    expect(s, '盘面法向必须压薄（GALAXY_THICKNESS）').toMatch(
      /float scY = armScatter\([^)]+\) \* GALAXY_THICKNESS;/,
    );
    // 辅助函数本体：pow 长尾 + 随机正负
    const helper = VERTEX_SHADER.slice(VERTEX_SHADER.indexOf('float armScatter('), VERTEX_SHADER.indexOf('void main'));
    expect(helper).toMatch(/pow\(max\(hash11\(seed\), 0\.0\), GALAXY_RANDOMNESS_POWER\)/);
    expect(helper).toMatch(/mix\(-1\.0, 1\.0, step\(0\.5, hash11\(seed \+ [\d.]+\)\)\)/);
  });

  /**
   * ⚠️⚠️ 差速自转是本版的灵魂：内快外慢。必须同时锁住三件事：
   *  ① 公式 = 整体慢速自转 + 差速项（DIFF / r）；
   *  ② 半径夹下限（r→0 角速度 →∞，核心频闪成雪花）；
   *  ③ 相位 uGalaxyAge 从切入预设起算 —— 差速会让旋臂随时间越缠越紧
   *     （缠绕问题），不归零的话播几分钟后 2 条臂就搅成同心环。
   */
  it('差速自转：内快外慢 + 半径夹下限 + 相位从切入预设起算', () => {
    const base = num(/#define GALAXY_BASE_SPIN ([\d.]+)/, 'GALAXY_BASE_SPIN');
    const diff = num(/#define GALAXY_DIFF_SPEED ([\d.]+)/, 'GALAXY_DIFF_SPEED');
    expect(base, '整体自转兜底动感（参考实现 autoRotate 的等效物）').toBeGreaterThan(0);
    expect(diff, '差速太小没有「内快外慢」的层次').toBeGreaterThanOrEqual(0.05);
    expect(diff, '差速太大会在十几秒内把臂搅成同心环（缠绕问题）').toBeLessThanOrEqual(0.15);
    const s = spiral();
    expect(s, '差速必须作用在含弥散的盘面坐标上，且相位用 uGalaxyAge').toMatch(
      /float dAng = uGalaxyAge \* uSpeed \* \(GALAXY_BASE_SPIN \+ GALAXY_DIFF_SPEED \/ dSafe\);/,
    );
    const m = s.match(/float dSafe = max\(length\(diskP\), ([\d.]+)\);/);
    expect(m, '半径必须夹下限，否则核心频闪').toBeTruthy();
    expect(Number(m![1]), '下限太小仍会频闪').toBeGreaterThanOrEqual(0.3);
  });

  /** 高斯厚度：参考实现用 Box-Muller 生成星云的「呼吸」微粒感，这里等价移植。 */
  it('高斯抖动（Box-Muller）必须存在并用于微粒呼吸感', () => {
    const helper = VERTEX_SHADER.slice(VERTEX_SHADER.indexOf('float gaussRand('), VERTEX_SHADER.indexOf('void main'));
    expect(helper, '必须是 Box-Muller（sqrt(-2 ln u) cos 2πv）').toMatch(
      /sqrt\(-2\.0 \* log\(h1\)\) \* cos\(/,
    );
    const s = spiral();
    expect(s).toMatch(/float jitX = gaussRand\(/);
    expect(s).toMatch(/float jitY = gaussRand\(/);
    expect(s).toMatch(/float jitZ = gaussRand\(/);
  });

  /** 三段配色是参考图的辨识度来源：粉白核心 → 亮青中段 → 深蓝外缘。 */
  it('配色必须是三段渐变（粉白核心 / 亮青中段 / 深蓝外缘）', () => {
    const s = spiral();
    expect(s).toMatch(/vec3 coreCol = vec3\(1\.00, 0\.84, 0\.96\);/);   // #ffd6f5
    expect(s).toMatch(/vec3 midCol\s+= vec3\(0\.37, 0\.85, 1\.00\);/);  // #5fd9ff
    expect(s).toMatch(/vec3 edgeCol = vec3\(0\.13, 0\.27, 0\.80\);/);   // #2244cc
    expect(s, '分段点 0.35：核心段略短、更亮').toMatch(/tN < 0\.35/);
    // 封面混色必须保持小权重（色板是主角）
    const m = s.match(/vColor = mix\(spCol, coverColor, ([\d.]+)\)/);
    expect(m, '必须有少量封面混色（保留跟随封面的关联感）').toBeTruthy();
    expect(Number(m![1]), '封面混色过大会把三段配色冲成灰').toBeLessThanOrEqual(0.2);
  });

  /**
   * 参考实现用 scales[i] = pow(rand,3)*2+0.3 做出「少量大亮星 + 大量小星」的
   * 星等两极分化，配合闪烁与节拍脉冲（pulseScale = 1 + uPulse * 0.6）。
   */
  it('星等两极分化 + 闪烁 + 节拍脉冲必须齐备', () => {
    const s = spiral();
    expect(s, '星等必须是 pow(h,3) 长尾（少量大亮星 + 大量小星）').toMatch(
      /galaxyStar = pow\(clamp\(hash11\(aRand \* [\d.]+\), 0\.0, 1\.0\), 3\.0\) \* 2\.0 \+ 0\.3;/,
    );
    expect(s, '闪烁必须逐粒相位不同（相位来自高斯抖动）').toMatch(
      /galaxyTwinkle = 0\.5 \+ 0\.5 \* sin\(t \* [\d.]+ \+ jitX \* [\d.]+\);/,
    );
    const size = VERTEX_SHADER.match(
      /uPreset > 9\.5[\s\S]{0,700}?sz = clamp\(depthSize \* galaxyStar \* galaxyDrive \* mix\(GALAXY_CORE_SHRINK, 1\.0, galaxyCore\), ([\d.]+), ([\d.]+)\);/,
    );
    expect(size, '尺寸档必须读 galaxyStar × galaxyDrive × 核心尺寸补偿').toBeTruthy();
    expect(Number(size![1]), '下限太小会闪成噪点').toBeGreaterThanOrEqual(0.3);
    expect(Number(size![2]), '上限必须容纳大亮星（pow8 衰减保证不糊）').toBeGreaterThanOrEqual(5.0);
    expect(size![0], '节拍脉冲必须撑大粒子（对齐 pulseScale = 1 + uPulse*0.6）').toMatch(/1\.0 \+ uBeat \* 0\.6/);
  });

  /**
   * ⚠️ v8.1 核心防糊：半径分布把大量粒子压进核心，而网格点尺寸远大于参考实现的
   * 18 万小点 —— 核心不处理会叠成一整块过曝的白斑（用户截图确认）。
   * 必须同时锁住：① 核球 3D 高斯弥散 ② galaxyCore 亮度/尺寸/脉冲补偿 ③ 补偿在分支外声明。
   */
  it('核心必须有核球弥散 + 亮度/尺寸/脉冲补偿（防过曝糊芯）', () => {
    // ① 补偿系数必须在分支外声明并初始化为 1（与外围一致）
    expect(VERTEX_SHADER).toMatch(/float galaxyCore = 1\.0;/);
    const iDecl = VERTEX_SHADER.indexOf('float galaxyCore = 1.0;');
    const iAssign = VERTEX_SHADER.indexOf('galaxyCore = smoothstep(');
    expect(iAssign, 'SPIRAL 分支里必须给 galaxyCore 赋值').toBeGreaterThan(iDecl);
    // ② 核球：exp 高斯包络 + 面内/深度双向弥散
    const tight = num(/#define GALAXY_BULGE_TIGHT ([\d.]+)/, 'GALAXY_BULGE_TIGHT');
    expect(tight, '核球太松会连到旋臂、太紧退化成一个点').toBeGreaterThanOrEqual(0.3);
    expect(tight).toBeLessThanOrEqual(1.2);
    const s = spiral();
    expect(s, '核球必须用 exp(-rr*rr*k) 包络').toMatch(/float bulge = exp\(-rr \* rr \* GALAXY_BULGE_TIGHT\)/);
    expect(s, '核球弥散必须乘回 pos（面内 + 深度）').toMatch(/vec3\(\s*gaussRand\([\s\S]{0,80}?GALAXY_BULGE_XY[\s\S]{0,120}?GALAXY_BULGE_Z[\s\S]{0,40}?\) \* bulge;/);
    // ③ 亮度补偿：vAlpha 基础项必须乘 galaxyCore 映射出的暗档；大亮星加成不得乘它
    expect(s, 'vAlpha 基础项必须做核心变暗补偿').toMatch(
      /vAlpha = \(0\.\d+ \* mix\(GALAXY_CORE_DIM, 1\.0, galaxyCore\) \+ \(galaxyStar - 0\.3\) \* 0\.\d+\)/,
    );
    // ④ 尺寸与脉冲补偿在尺寸档里
    expect(VERTEX_SHADER).toMatch(
      /uPreset > 9\.5[\s\S]{0,700}?mix\(GALAXY_CORE_PULSE, 1\.0, galaxyCore\)/,
    );
    const dim = num(/#define GALAXY_CORE_DIM ([\d.]+)/, 'GALAXY_CORE_DIM');
    expect(dim, '核心太亮仍会糊、太暗核心会消失').toBeGreaterThanOrEqual(0.25);
    expect(dim).toBeLessThanOrEqual(0.7);
  });

  /**
   * ⚠️ 盘半径由 SPIRAL_RMAX 统一定义，且必须与相机机位配套。
   * 两者是**一对**（见 ParticleStage 的 spiral 机位），单独改一个会导致
   * 「缩小在中央」或「冲出取景框」。
   */
  it('盘半径必须由 SPIRAL_RMAX 定义，且放大到 6.0 以上', () => {
    const rmax = num(/#define SPIRAL_RMAX ([\d.]+)/, 'SPIRAL_RMAX');
    expect(rmax, '盘半径必须 ≥ 6.0（用户要求铺满画面）').toBeGreaterThanOrEqual(6.0);
    const s = spiral();
    expect(s, '半径必须用 SPIRAL_RMAX，不能写死').toMatch(
      /pow\(clamp\(aUv\.x, 0\.0, 1\.0\), GALAXY_RADIAL_POW\) \* SPIRAL_RMAX/,
    );
    expect(s, '归一化半径 tN 也要用 SPIRAL_RMAX').toMatch(/clamp\(rr \/ SPIRAL_RMAX, 0\.0, 1\.0\)/);
  });

  /**
   * ⚠️ 外缘淡出窗口必须收在最后（不能太早），否则外缘被截成硬边圆环。
   */
  it('外缘淡出窗口必须贴到最外（smoothstep 起点 ≥ 0.9）', () => {
    const s = spiral();
    const m = s.match(/1\.0 - smoothstep\((0\.[\d]+), 1\.0, aUv\.x\)/);
    if (!m) throw new Error('未找到外缘淡出窗口');
    expect(Number(m[1]), '淡出起点太早会让外缘出现硬边圆环').toBeGreaterThanOrEqual(0.9);
  });

  /**
   * 片元端：螺旋星云不再采样圆点纹理，改用参考实现的柔光球衰减 pow(1-d, 8)，
   * 主层与泛光层同形；可读性描边只属于圆点路径。
   */
  it('片元端必须是柔光球衰减（主层 + 泛光层同形），星云分支不走圆点纹理', () => {
    for (const [name, fs] of [
      ['FRAGMENT_SHADER', FRAGMENT_SHADER],
      ['BLOOM_FRAGMENT_SHADER', BLOOM_FRAGMENT_SHADER]
    ] as const) {
      expect(fs, `${name} 缺少星云柔光球分支`).toMatch(
        /if \(uPreset > 9\.5\) \{[\s\S]*?pow\(max\(0\.0, 1\.0 - d\), 8\.0\)/,
      );
    }
    // 主层的星云分支排在圆点纹理采样之前，且分支内不得采样 uDotTex
    const spiralFrag = FRAGMENT_SHADER.slice(
      FRAGMENT_SHADER.indexOf('if (uPreset > 9.5)'),
      FRAGMENT_SHADER.indexOf('vec4 tex = texture2D')
    );
    expect(spiralFrag).not.toContain('uDotTex');
  });

  /** uGalaxyAge 必须在顶点声明（差速自转的相位源），由 ParticleStage 每帧写入。 */
  it('差速自转相位 uGalaxyAge 必须在顶点着色器声明', () => {
    expect(VERTEX_SHADER).toMatch(/uniform float uGalaxyAge;/);
  });
});
describe('声波地形的观感修正（居中 / 起伏 / 无缝循环）', () => {
  const sonic = () => {
    const s = VERTEX_SHADER.slice(
      VERTEX_SHADER.indexOf('Preset 9: SONIC'),
      VERTEX_SHADER.indexOf('Preset 10: SPIRAL')
    );
    expect(s.length, '没截到 SONIC 分支').toBeGreaterThan(100);
    return s;
  };

  /**
   * ⚠️ 地形必须**居中**在 y=0 附近（用户截图：地形整体偏上，下半屏空着）。
   *
   * 初版 `pos.y = h` 直接用：h 的三项（ridge / depthFall / bassLift）都偏正，
   * 实测 h 中轴 +0.51 → 画面里地形挤在上半部。
   * 修法是显式减一个 centerY，而不是去微调某个系数碰运气。
   */
  it('地形必须显式居中（减掉 centerY），不能直接用 h', () => {
    const s = sonic();
    // 必须有 centerY 这个显式居中量
    expect(s, '缺少显式居中量 centerY').toMatch(/float centerY = [\d.]+;/);
    expect(s, 'centerY 必须实际减进 h').toMatch(/h -= centerY;/);
    // 居中量要落在合理区间（0.2~0.8），太小平不了偏移、太大把地形压到底部
    const cy = Number(s.match(/float centerY = ([\d.]+);/)![1]);
    expect(cy, 'centerY 太小，平不了 h 的正偏').toBeGreaterThan(0.2);
    expect(cy, 'centerY 太大，会把地形压到画面下部').toBeLessThan(0.8);
  });

  /**
   * ⚠️ 纵深项必须是**双向**的（近处抬、远处压），不能用单向的 (1-gz)*k。
   *
   * 单向抬升是与 ridge 叠加后把整体顶到 y>0 的元凶之一。
   * 用 (0.5 - gz) 才能让近端为正、远端为负，形成真正的纵深层次。
   */
  it('纵深项必须是双向的（近处抬、远处压），不能用单向抬升', () => {
    const s = sonic();
    expect(s, '纵深项必须围绕 0.5 居中').toMatch(/float depthShape = \(0\.5 - gz\) \* [\d.]+;/);
    // 不允许退回单向写法
    expect(s).not.toMatch(/float depthFall = \(1\.0 - gz\)/);
  });

  /**
   * ⚠️ 上下起伏必须够大（用户反馈"上下范围再大一下"）。
   *
   * 初版三层振幅 1.15/0.42/0.14 加起来跨度仅 2.49，视觉上是一条扁带。
   * 现在放大到 1.28/0.49/0.16 并配套双向纵深，仿真跨度约 5.0（翻倍）。
   * 这条测试锁住"第一层振幅不能又缩回去"。
   */
  it('地形起伏振幅不得缩回初版的小值', () => {
    const s = sonic();
    const amps = [...s.matchAll(/snoise\(vec3\(worldX \* [\d.]+, worldZ \* [\d.]+(?: \+ \w+)?, \w+\)\) \* ([\d.]+)/g)].map(
      (m) => Number(m[1])
    );
    expect(amps.length, '没解析出三层噪声振幅').toBe(3);
    expect(amps[0], '第一层（大起伏）振幅太小，地形会变成扁带').toBeGreaterThanOrEqual(1.2);
    // 逐层递减（高频低振幅）才像地形
    expect(amps[0]).toBeGreaterThan(amps[1]);
    expect(amps[1]).toBeGreaterThan(amps[2]);
  });

  /**
   * ⚠️⚠️ 无缝循环：扫描波前必须用 triWave 往复，不能用 fract 硬绕回。
   *
   * `fract(t * 0.13)` 每 7.7 秒从 1 **硬跳**回 0 —— 波前从远处瞬移回近处，
   * 视觉上是一次突兀的抽搐（用户反馈"循环不够连贯"）。
   * triWave 在两端自然折返，观感是"潮水来回"。
   */
  it('扫描波前必须用 triWave 往复，不能用 fract 硬绕回', () => {
    const s = sonic();
    expect(s, '扫描位置必须用 triWave').toMatch(/float scanPos = triWave\(/);
    // 不允许退回 fract 写法
    expect(s, '扫描波前不得用 fract 做循环（1→0 会硬跳）').not.toMatch(/float scanPos = fract\(/);
  });

  /**
   * ⚠️⚠️ 波前位置**绝不能含 uBeat**，无论以何种形式。
   *
   * 踩过两次，第二次比第一次隐蔽得多：
   *   ① 初版 `fract(t*0.13 + uBeat*0.10)` —— uBeat 直接加位移，每拍踹一下；
   *   ② 「修好版」`t/36.0 * (1.0 + uBeat*0.55)` —— 看着像"只改速度"，实际代数上是
   *      `t/36 + (t*uBeat*0.55)/36`，第二项**与 t 成正比**。t 是已播放秒数、只增不减，
   *      所以同一个 uBeat 突变在 t=60s 让相位跳 0.46、到 t=900s 跳 **6.9 个整周期**，
   *      波前瞬间乱闪（用户报的"抖动"）。**这是个随播放时长线性恶化的 bug。**
   *
   * 正解：位置纯 `triWave(t / 36.0)`（跳变恒为 0），uBeat 只用于亮度增益。
   */
  it('波前位置绝不含 uBeat（乘在绝对时间上会随播放时长线性恶化）', () => {
    const s = sonic();
    // ⚠️ 断言必须基于**剥掉注释**的代码：注释里会写错例做说明，不剥就会被自己的反例命中。
    const code = s.replace(/\/\/.*$/gm, '');
    // 位置必须是纯 t/36 的三角波
    expect(code, '波前位置必须是不含 uBeat 的纯时间函数').toMatch(/float scanPos = triWave\(t \/ [\d.]+\);/);
    // scanPos 那一行不得出现 uBeat
    const scanPosLine = code.match(/float scanPos = [^;]+;/)?.[0] ?? '';
    expect(scanPosLine, 'uBeat 不得以任何形式进入波前位置').not.toContain('uBeat');
    // 禁止「t / 常数 * (1.0 + uBeat...」这种会把 uBeat 放大成 t 倍的写法
    expect(code, '不得把 uBeat 乘在绝对时间 t 上（会随 t 放大）').not.toMatch(/t\s*\/\s*[\d.]+\s*\*\s*\(1\.0 \+ uBeat/);
  });

  /**
   * uBeat 改为只驱动**亮度**：位置恒定，拍点表现为波前"闪一下"。
   * 且增益结果必须钳回 [0,1] —— 下游拿 scanBand 当 mix 权重与 alpha 增益，超过 1 会外推过曝。
   */
  it('节拍只能调波前亮度（且必须钳回 [0,1]）', () => {
    const s = sonic();
    expect(s, 'scanBand 必须带 uBeat 亮度增益').toMatch(
      /float scanBand = min\(1\.0, exp\(-dz \* dz\) \* \([\d.]+ \+ uBeat \* [\d.]+\)\);/
    );
    // 必须有 min(1.0, ...) 钳制
    expect(s).toMatch(/float scanBand = min\(1\.0,/);
    // 基准亮度要留出提升空间（不能是 1.0，否则 uBeat 的增益全被钳掉、失去效果）
    const base = Number(s.match(/float scanBand = min\(1\.0, exp\(-dz \* dz\) \* \(([\d.]+) \+ uBeat/)![1]);
    expect(base, '基准亮度太接近 1，uBeat 提亮会被钳掉、失去效果').toBeLessThan(0.9);
    expect(base, '基准亮度太低，波前平时会暗到看不见').toBeGreaterThan(0.5);
  });

  /**
   * ⚠️ 地形噪声的时间种子必须是**有界往返**，不能无限线性漂移。
   *
   * 旧写法 `snoise(vec3(..., t * 0.16))` 让采样点沿时间轴无限前进 →
   * 地形永不重复、一直"长成另一张地图"，观感上就是"没有循环"。
   * 改成 triWave 的有界往返后，地形在同一片山谷里呼吸。
   */
  it('地形噪声的时间种子必须有界往返（不能无限线性漂移）', () => {
    const s = sonic();
    // 三个时间种子都必须来自 triWave
    expect(s, '层1 时间种子必须有界').toMatch(/float tSeed1 = triWave\(t \/ [\d.]+\) \* [\d.]+;/);
    expect(s, '层2 时间种子必须有界').toMatch(/float tSeed2 = triWave\(t \/ [\d.]+\) \* [\d.]+;/);
    expect(s, '层3 时间种子必须有界').toMatch(/float tSeed3 = triWave\(t \/ [\d.]+\) \* [\d.]+;/);
    // 噪声调用里不得再出现裸的 t 线性项
    const noiseCalls = [...s.matchAll(/snoise\(vec3\([^)]*\)\)/g)].map((m) => m[0]);
    expect(noiseCalls.length).toBe(3);
    for (const call of noiseCalls) {
      expect(call, `噪声调用里残留了线性时间漂移: ${call}`).not.toMatch(/\bt \*/);
    }
  });

  it('triWave 必须定义在顶点着色器里（且只在顶点用）', () => {
    // 定义在 VERTEX_SHADER 的公共前缀区（snoise 附近）
    expect(VERTEX_SHADER).toMatch(/float triWave\(float x\)\{\s*float f = fract\(x\);\s*return abs\(f \* 2\.0 - 1\.0\);/);
    const iDef = VERTEX_SHADER.indexOf('float triWave(float x)');
    const iSonic = VERTEX_SHADER.indexOf('Preset 9: SONIC');
    expect(iDef, 'triWave 必须在 SONIC 分支之前定义').toBeGreaterThan(-1);
    expect(iDef).toBeLessThan(iSonic);
    // 片元着色器不需要它（只有顶点算位置）
    expect(FRAGMENT_SHADER).not.toContain('triWave');
  });
});

describe('唱片封面显著度（用户反馈「头像不够明显」）', () => {
  const vinyl = () => {
    const s = VERTEX_SHADER.slice(
      VERTEX_SHADER.indexOf('Preset 4: VINYL'),
      VERTEX_SHADER.indexOf('Preset 5: WALLPAPER')
    );
    expect(s.length, '没截到 VINYL 分支').toBeGreaterThan(100);
    return s.replace(/\/\/.*$/gm, '');
  };

  /**
   * ⚠️ 封面占比：coverR 1.18 时头像只占盘面 48%，被黑胶底色包围观感「不明显」。
   * 放大到 1.50（61%）是平衡点 —— 再大会吃掉黑胶纹路区，唱片就不像唱片了。
   */
  it('封面半径必须 ≥ 1.45 且给黑胶纹路区留出 ≥ 0.7 的径向空间', () => {
    const s = vinyl();
    const coverR = Number(s.match(/float coverR = ([\d.]+);/)?.[1] ?? 0);
    const recordR = Number(s.match(/float recordR = ([\d.]+);/)?.[1] ?? 0);
    expect(coverR, '封面太小，头像不显眼').toBeGreaterThanOrEqual(1.45);
    expect(recordR - coverR, '纹路区太窄会失去黑胶质感').toBeGreaterThanOrEqual(0.7);
  });

  /**
   * ⚠️ 封面必须比底色亮：全局的 max(vColor, 0.13) 暗部下限**刻意排除了唱片**
   * （保黑胶质感），所以封面区需要自己的提亮与下限 —— 否则暗封面整个沉进黑胶底色。
   */
  it('封面必须有亮度增益与暗部下限（旧值 1.02/无下限，封面糊在黑胶里认不出）', () => {
    const s = vinyl();
    const m = s.match(/float coverShade = ([\d.]+) \+ ([\d.]+) \* \(1\.0 - smoothstep/);
    expect(m, '未找到 coverShade').toBeTruthy();
    expect(Number(m![1]), '亮度基准太低封面不显眼').toBeGreaterThanOrEqual(1.10);
    expect(Number(m![2]), '中心增益太小说明没有纵深感').toBeGreaterThanOrEqual(0.12);
    expect(s, '封面区必须有暗部下限（且低于全局 0.13，别毁掉黑胶对比）').toMatch(
      /vColor = max\(vColor, vec3\(0\.10\)\);/,
    );
  });

  /**
   * ⚠️ 可读性描边与照片封面冲突：描边给亮粒子压黑边、暗粒子描白边，
   * 叠在封面上等于给照片做半调网点 —— 封面必须读成「照片」而不是「描边粒子」。
   */
  it('片元的可读性描边在唱片预设下必须减弱（rimKeep ≤ 0.5）', () => {
    const m = FRAGMENT_SHADER.match(
      /float rimKeep = \(uPreset > 3\.5 && uPreset < 4\.5\) \? (0\.\d+) : 1\.0;/,
    );
    expect(m, '未找到 rimKeep（唱片预设的描边衰减）').toBeTruthy();
    expect(Number(m![1]), '描边衰减不到位，封面仍会被网点化').toBeLessThanOrEqual(0.5);
    expect(FRAGMENT_SHADER, 'rimKeep 必须真正乘回 readableRim').toMatch(/readableRim \*= rimKeep;/);
  });
});
