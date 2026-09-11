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
   * 正确做法是 pow(aUv.x, >1) 把点往中心压。
   */
  it('螺旋星云的半径分布必须向中心聚集（不能用 sqrt 的面积均匀分布）', () => {
    const spiral = VERTEX_SHADER.slice(VERTEX_SHADER.indexOf('Preset 10: SPIRAL'));
    expect(spiral.length, '没截到 SPIRAL 分支').toBeGreaterThan(100);
    // 底数允许被 clamp() 包一层（防 NaN），幂次与倍率仍要能取到
    const m = spiral.match(/float rr = pow\(clamp\(aUv\.x, 0\.0, 1\.0\), ([\d.]+)\) \* SPIRAL_RMAX/);
    expect(m, '未找到半径分布公式').toBeTruthy();
    expect(Number(m![1]), '半径幂次必须 > 1 才会向中心聚集').toBeGreaterThan(1);
    expect(spiral).not.toMatch(/float rr = sqrt\(aUv\.x\)/);
  });

  /**
   * ⚠️ 核球强度必须在**分支之外**可见。
   *
   * nebBulge 是 SPIRAL 分支里算出来的，但粒子尺寸公式在分支之外 ——
   * 若把变量声明写在分支内，尺寸公式就看不到它（GLSL 编译失败或取到垃圾值）。
   * 所以必须在所有分支之前先声明并初始化为 0。
   */
  it('螺旋星云的核球强度必须在分支外声明并初始化', () => {
    expect(VERTEX_SHADER).toMatch(/float nebBulge = 0\.0;/);
    const iDecl = VERTEX_SHADER.indexOf('float nebBulge = 0.0;');
    const iAssign = VERTEX_SHADER.indexOf('nebBulge = bulge;');
    const iUse = VERTEX_SHADER.indexOf('uPreset > 9.5', iDecl); // 尺寸档里会用到
    expect(iAssign, 'SPIRAL 分支里必须把 bulge 传给 nebBulge').toBeGreaterThan(iDecl);
    expect(iUse, '尺寸公式必须读 nebBulge 才能体现核球').toBeGreaterThan(iAssign);
  });

  it('两个新预设都有独立的尺寸档与亮度档', () => {
    // 尺寸：9 要小而均匀（否则脊顶鼓成珠子）；10 也走小点（v7 对齐参考图的锐利小星点，
    //   基准 0.34，比 9 的 0.52 更小）—— 这里只要求「各自有独立档」，
    //   具体数值由 v7 那组断言（基准 ≤0.45、上限 ≤2.5）负责。
    expect(VERTEX_SHADER).toMatch(/uPreset > 9\.5[\s\S]{0,420}?sz = clamp\(depthSize \* \(0\.\d/);
    expect(VERTEX_SHADER).toMatch(/uPreset > 8\.5[\s\S]{0,220}?sz = clamp\(depthSize \* 0\.5\d/);
    // 亮度：两者都要有独立档，不能共用 6~8 的通用档
    expect(VERTEX_SHADER).toMatch(/uPreset > 8\.5 && uPreset < 9\.5/);
    expect(VERTEX_SHADER).toMatch(/else if \(uPreset > 9\.5\)/);
  });
});

describe('螺旋星云 v7（多条细密旋臂 + 锐利星点，对齐参考图）', () => {
  const spiral = () =>
    VERTEX_SHADER.slice(VERTEX_SHADER.indexOf('Preset 10: SPIRAL')).replace(/\/\/.*$/gm, '');
  const num = (re: RegExp, label: string): number => {
    const m = VERTEX_SHADER.match(re);
    if (!m) throw new Error(`未找到 ${label}`);
    return Number(m[1]);
  };

  /**
   * ⚠️⚠️ 最关键的一条：**每颗粒子独立的角度散射**（这是「像云而不是像线」的唯一来源）。
   *
   * 一旦把它改小、或改成由半径唯一决定，同一半径的点就会收拢到同一条弧线上
   * → 整片退化成一维曲线（＝线）。v2/v3 就是这么翻车的。
   *
   * v7 的形式：散射幅度 = MIN + GROW·(r/RMAX)²，**随半径增大**。
   *   内侧 scatter 小 → 臂细而清晰；外侧 scatter 大 → 臂化开成雾。
   *   这就是参考图「中心细密、外缘弥漫」的观感来源。
   *
   * ⚠️ MIN 不能小到 0（内侧会退化成一条精确的弧线），也不能大到丢失臂的锐利度。
   */
  it('必须有每颗粒子独立的角度散射，且随半径增大（MIN 小、GROW 大）', () => {
    const s = spiral();
    // 散射必须是 hash 形式 × (MIN + GROW·tR²)
    expect(s, '散射必须是「hash 随机 × (MIN + GROW·tR²)」的形式').toMatch(
      /float scatter = \(hash11\(aRand \* [\d.]+\) - 0\.5\) \* sBase;/,
    );
    expect(s, 'sBase 必须由 SPIRAL_SCATTER_MIN + SPIRAL_SCATTER_GROW 组成').toMatch(
      /float sBase = SPIRAL_SCATTER_MIN \+ SPIRAL_SCATTER_GROW \* tR \* tR;/,
    );
    const min = num(/#define SPIRAL_SCATTER_MIN ([\d.]+)/, 'SPIRAL_SCATTER_MIN');
    const grow = num(/#define SPIRAL_SCATTER_GROW ([\d.]+)/, 'SPIRAL_SCATTER_GROW');
    expect(min, 'MIN 太小会让内侧臂退化成一条精确弧线').toBeGreaterThanOrEqual(0.03);
    expect(min, 'MIN 太大内侧臂会糊，丢失「细密」感').toBeLessThanOrEqual(0.25);
    expect(grow, 'GROW 太小则内外一样弥散（v6 的老问题：臂不锐利）').toBeGreaterThanOrEqual(0.5);
    // 角度绝不能是「只由半径决定」的确定性函数
    expect(s, '角度不能写成只由半径决定的 cos/sin（会退化成一条线）').not.toMatch(
      /float ang = [\d.]+ \* (?:cos|sin)\(/,
    );
  });

  /**
   * ⚠️ 臂必须有**多条**（参考图能数出 3~4 条），且条数由常量统一控制。
   *
   * 2 条臂只能是两根对称的带，读不出参考图那种「层层缠绕」的层次。
   * 实测：2 条 → 盘面覆盖率 59.4%；4 条 → 75.7%，密度图上出现明显的多股细丝。
   */
  it('臂条数必须 ≥ 3 且由 SPIRAL_ARMS 常量控制（对齐参考图的多臂）', () => {
    const arms = num(/#define SPIRAL_ARMS ([\d.]+)/, 'SPIRAL_ARMS');
    expect(arms, '臂条数至少 3 条才读得出参考图的缠绕层次').toBeGreaterThanOrEqual(3);
    expect(arms, '臂条数过多（>8）每片都太密，反而看不出螺旋').toBeLessThanOrEqual(8);
    const s = spiral();
    expect(s, '臂偏移必须由 SPIRAL_ARMS 均分 2π，不能写死 2 条').toMatch(
      /float armOffset = \(armPick \/ SPIRAL_ARMS\) \* 2\.0 \* PI;/,
    );
    expect(s, '臂的挑选必须用 SPIRAL_ARMS').toMatch(
      /float armPick = floor\(hash11\(aRand \* [\d.]+\) \* SPIRAL_ARMS\);/,
    );
  });

  /**
   * ⚠️ 臂的锐利度靠**散射幅度**控制，绝不能靠高对比掩码去「画」。
   *
   * v5 用了 armCore² × 大系数 + vAlpha 0.52 的臂脊权重，结果边缘硬得像手绘描边。
   */
  it('臂的强度调制必须克制，且 v5 的「画臂」机制必须彻底消失', () => {
    const s = spiral();
    expect(s, 'armMask 必须保持散斑形式（0.55 + 0.45·cos(scatter·k)）').toMatch(
      /float armMask = 0\.\d+ \+ 0\.\d+ \* cos\(scatter \* [\d.]+\);/,
    );
    const armW = num(/#define SPIRAL_ARM_ALPHA ([\d.]+)/, 'SPIRAL_ARM_ALPHA');
    expect(armW, '臂密度权重 >0.3 会让臂变成「描边的硬线条」而不是云').toBeLessThanOrEqual(0.3);
    expect(armW, '臂密度权重必须有实际作用（不能是 0）').toBeGreaterThan(0.02);
    // v5 的机制必须彻底消失
    expect(s, 'v5 的 armCore 高对比横截面必须已移除').not.toMatch(/armCore/);
    expect(s, 'v5 的径向厚度 dR 必须已移除').not.toMatch(/float dR = /);
    expect(s, 'v5 的 sqrt 臂相必须已移除（会把臂甩出取景框）').not.toMatch(
      /float armPhase = 2\.0 \* \(sqrt\(rArm\)/,
    );
  });

  /**
   * ⚠️ 臂相必须用 **log 螺线**（等角螺线），不能用 sqrt/幂次。
   *
   * log 螺线的「等角」性质让所有臂在全盘保持相似形状，且圈数温和，
   * 不会像 sqrt 配方那样在大半径处把臂甩出画面。
   */
  it('臂相必须是 log 螺线（等角螺线），系数在 2~3.5 之间', () => {
    const s = spiral();
    const m = s.match(/float ang = ([\d.]+) \* log\(max\(rr, [\d.]+\)\) \+ armOffset \+ scatter/);
    if (!m) throw new Error('未找到 log 螺线形式的臂相');
    const k = Number(m[1]);
    expect(k, 'log 系数过小 → 几乎不旋（看不出螺旋）').toBeGreaterThanOrEqual(2.0);
    expect(k, 'log 系数过大 → 臂会绕太紧/甩出取景框').toBeLessThanOrEqual(3.5);
  });

  /**
   * ⚠️ 盘半径由 SPIRAL_RMAX 统一定义，且必须与相机机位配套。
   *
   * 两者是**一对**（见 ParticleStage 的 spiral 机位），单独改一个会导致
   * 「缩小在中央」或「冲出取景框」。
   */
  it('盘半径必须由 SPIRAL_RMAX 定义，且放大到 6.0 以上', () => {
    const rmax = num(/#define SPIRAL_RMAX ([\d.]+)/, 'SPIRAL_RMAX');
    expect(rmax, '盘半径必须 ≥ 6.0（v1 是 5.4，用户要求扩大）').toBeGreaterThanOrEqual(6.0);
    const s = spiral();
    expect(s, '半径必须用 SPIRAL_RMAX，不能写死').toMatch(
      /pow\(clamp\(aUv\.x, 0\.0, 1\.0\), [\d.]+\) \* SPIRAL_RMAX/,
    );
    expect(s, '归一化半径 tR 也要用 SPIRAL_RMAX').toMatch(/clamp\(rr \/ SPIRAL_RMAX, 0\.0, 1\.0\)/);
  });

  /**
   * ⚠️ 外缘淡出窗口必须收在最后（不能太早），否则放大后外缘被截成硬边圆环。
   */
  it('外缘淡出窗口必须贴到最外（smoothstep 起点 ≥ 0.9）', () => {
    const s = spiral();
    const m = s.match(/1\.0 - smoothstep\((0\.[\d]+), 1\.0, aUv\.x\)/);
    if (!m) throw new Error('未找到外缘淡出窗口');
    expect(Number(m[1]), '淡出起点太早会让放大后的外缘出现硬边圆环').toBeGreaterThanOrEqual(0.9);
  });

  /**
   * ⚠️ 核球（参考图那个又小又极亮的白点）必须有**独立的紧致核** + 亮度加成。
   *
   * 参考图的核心是一个过曝的白点，不是一大团亮雾。
   * 所以：紧致高斯核 `exp(-rr²·k)`（k 要够大）+ 亮度 BOOST，
   * 但宽核 bulge 仍要保留（否则中心会变成一个针尖、失去星云的体积感）。
   */
  it('核球必须有紧致核 + 亮度加成，且宽核 bulge 仍保留', () => {
    const s = spiral();
    const mCore = s.match(/float core = exp\(-rr \* rr \* ([\d.]+)\)/);
    if (!mCore) throw new Error('必须有紧致核 core = exp(-rr*rr*k)');
    const coreK = Number(mCore[1]);
    expect(coreK, '紧致核的系数太小 → 核心是一团雾而不是一个亮核').toBeGreaterThanOrEqual(0.9);
    expect(s, '核球必须保留宽核 bulge（否则中心变针尖）').toMatch(/float bulge = exp\(-rr \* rr \* [\d.]+\)/);
    const boost = num(/#define SPIRAL_CORE_BOOST ([\d.]+)/, 'SPIRAL_CORE_BOOST');
    expect(boost, '核球亮度加成太小 → 看不出参考图那个过曝的白核').toBeGreaterThanOrEqual(1.5);
    // vAlpha 里核球权重仍必须远大于臂
    const armW = num(/#define SPIRAL_ARM_ALPHA ([\d.]+)/, 'SPIRAL_ARM_ALPHA');
    const mBulge = s.match(/vAlpha = \([\d.]+ \+ bulge \* ([\d.]+)/);
    if (!mBulge) throw new Error('vAlpha 里未找到 bulge 权重');
    const bulgeW = Number(mBulge[1]);
    expect(bulgeW, '核球权重必须 ≥ 0.5').toBeGreaterThanOrEqual(0.5);
    expect(bulgeW, '核球权重必须是臂的 3 倍以上').toBeGreaterThan(armW * 3);
  });

  /**
   * ⚠️ 参考图有大量**明亮锐利的星点**（像撒盐）。必须有一小部分粒子被挑出来提亮。
   *
   * ⚠️ 关键是「只挑少数」（step 阈值 ≥ 0.9），不能整体提亮 ——
   *    整体提亮会让星云糊成一片白，失去参考图的点状质感。
   */
  it('必须有少量粒子的亮度尖峰（模拟参考图的「撒盐」亮星）', () => {
    const s = spiral();
    const m = s.match(/float star = step\((0\.\d+), hash11\(aRand \* [\d.]+\)\);/);
    if (!m) throw new Error('未找到 星点尖峰 star');
    const thr = Number(m[1]);
    expect(thr, '阈值太低会挑出太多粒子，整体过亮成一片白').toBeGreaterThanOrEqual(0.88);
    expect(thr, '阈值太高则亮星太少，看不出参考图的点状质感').toBeLessThanOrEqual(0.98);
    expect(s, '星点尖峰必须真正加到亮度上').toMatch(/lumCore \+= star \* [\d.]+/);
  });

  /**
   * ⚠️ 点尺寸必须**小**才锐利（参考图是锐利小星点，不是绒球）。
   *
   * v6 的基准 0.50 / 上限 3.60 是按「弥散云」定的，偏大。
   */
  it('螺旋星云的点尺寸档必须明显变小（锐利小点）', () => {
    const m = VERTEX_SHADER.match(
      /uPreset > 9\.5[\s\S]{0,420}?sz = clamp\(depthSize \* \((0\.\d+) \+ nebBulge \* ([\d.]+)\) \* \(1\.0 \+ nebDrive\), ([\d.]+), ([\d.]+)\);/,
    );
    if (!m) throw new Error('未找到螺旋星云的尺寸档');
    const base = Number(m[1]);
    const cap = Number(m[4]);
    expect(base, '点尺寸基准必须 ≤0.45 才锐利（参考图是锐利小星点）').toBeLessThanOrEqual(0.45);
    expect(cap, '点尺寸上限必须 ≤2.5，否则臂被糊成绒球').toBeLessThanOrEqual(2.5);
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
