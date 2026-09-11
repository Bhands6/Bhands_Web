// ============================================================
//  粒子舞台的 GLSL 着色器源码
//
//  独立成模块（而不是留在 ParticleStage.tsx 里）有两个原因：
//  1. react-refresh 要求「组件文件只导出组件」。把着色器常量导出到组件文件里会让
//     该文件失去 Fast Refresh —— 改一行 GLSL 就整页重载、播放状态丢失。
//  2. 着色器可以脱离组件被直接单测（见 ParticleStage.bloom.test.ts）。
//
//  顶点 Shader（移植桌面版 vs，去掉桌面专属：手势/扭曲/加载雾/深度图）
// ============================================================
export const VERTEX_SHADER = /* glsl */ `
precision highp float;
uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;
uniform float uBurstAge;  // 距本次迸发开始的秒数（迸发预设用；只在切歌时归零，之后一直增长，不回绕）
uniform float uPreset, uIntensity, uPointScale, uSpeed;
uniform float uVinylSpin;
uniform float uColorBoost, uCoverRes;
uniform float uHasCover, uEdgeEnabled;
uniform float uMouseActive, uPixel, uColorMixT;
// 流星相关：uResolution 是**渲染缓冲**像素尺寸（与 gl_FragCoord 同一坐标系），
// uMeteorSize 是拖尾的像素长度，uGrid 是粒子网格边长（用来推出每颗粒子的连续编号）
uniform vec2 uResolution;
uniform float uMeteorSize, uGrid;
uniform sampler2D uCoverTex, uPrevCoverTex, uEdgeTex, uRippleTex;
uniform int uRippleCount;
uniform vec2 uMouseXY;
uniform vec3 uTintColor;
uniform float uTintStrength;
attribute vec2 aUv;
attribute float aRand;
varying vec3 vColor;
// ⚠️ varying 槽位是 GLSL ES 1.00 里最硬的资源限制：规范只保证
//    MAX_VARYING_VECTORS = 8，而且 **ANGLE/D3D11（Windows Chrome 默认后端）不会把
//    多个「varying float a, b, c;」合并进同一个槽**，每个声明都实打实占一个。
//    超限的后果不是画得难看，而是**顶点着色器编译失败 → 主层 + 泛光层全都不渲染**，
//    表现成「所有粒子效果都没了」，而 tsc / vitest / oxlint / vite build / glsl-parser
//    全都不报错（唯一线索是 Console 里的 Vertex shader is not compiled.）。
//    ❗注意：本文件的着色器是 **JS 模板字符串**，注释里绝对不能出现反引号（会提前结束字符串）。
//
//    这里用**打包 + 宏别名**把槽位从 7 压到 4，同时不改动下面几百行里
//    对 vBright / vRipple … 的读写（宏展开后 vBright 就是 vPack0.x，读写都合法）：
//      vColor        vec3 → 1 槽
//      vPack0        vec4 → 1 槽（原 vBright / vRipple / vEdgeBoost / vAlpha）
//      vPack1        vec4 → 1 槽（原 vSourceLum / 流星强度 / 拖尾方向角 / 尘埃带强度）
//      vMeteorCenter vec2 → 1 槽（拖尾窗口中心，不能用有 y 轴歧义的 gl_PointCoord 代替）
//    **以后要加 varying，先来这几个 vec4 里找一个空闲分量，不要新开声明。**
varying vec4 vPack0;   // .x=vBright  .y=vRipple  .z=vEdgeBoost  .w=vAlpha
varying vec4 vPack1;   // .x=vSourceLum  .y=vMeteor  .z=拖尾方向角(弧度)  .w=尘埃带强度(星云)
varying vec2 vMeteorCenter;   // 流星拖尾的窗口像素中心（与片元 gl_FragCoord 同系）
// 宏别名：让旧代码里的名字继续可用（宏是纯文本替换，赋值语句同样生效）
#define vBright    vPack0.x
#define vRipple    vPack0.y
#define vEdgeBoost vPack0.z
#define vAlpha     vPack0.w
#define vSourceLum vPack1.x
#define vMeteor    vPack1.y

#define PI 3.14159265359
// 极光预设里划给「流星」的粒子数：一颗流星就是**一个粒子**（拖尾画在它的点精灵内部）。
// 5 个槽位 × 每波随机启用 3~5 个。
#define METEOR_SLOTS 5
// 流星波次周期（秒）：每波出场 3~5 颗，波与波之间留一段干净的间歇。
#define METEOR_WAVE_PERIOD 7.0

// 螺旋星云（Preset 10）的盘半径基准。
// ⚠️ 这个值必须与 ParticleStage.tsx 里 spiral 机位的 camera radius 一起调：
//    盘半径变了、相机没跟着动，星云就会缩在画面中央或者直接冲出取景框。
//    FOV45 下横向可见半宽 = R·tan(22.5°)·宽高比；16:9 时 ≈ R·0.5969。
//    当前 R=8.8 → 半宽 ≈ 5.25，盘半径 6.4 会略微出血到画面边缘之外
//    （这是刻意的：让星云有"铺满画面"的观感，边缘用 vAlpha 的淡出窗口收住）。
#define SPIRAL_RMAX 6.4

// 螺旋星云的**臂条数**。
// ⚠️ 参考图（用户提供的银河照片）里明显不止两条臂，能数出 3~4 条细密旋臂。
//    条数多才读得出「层层缠绕」的层次；2 条臂只能是两根对称的带。
//    ⚠️ 改了条数请同步改单测里的断言范围（1~8）。
#define SPIRAL_ARMS 4.0

// 螺旋星云的**角度散射**（每颗粒子独立，这是「像云而不是像线」的唯一来源）。
// ⚠️⚠️ 这两个常量必须配套使用：散射幅度 = MIN + GROW·(r/RMAX)²。
//    **随半径增大**是关键 —— 内侧 scatter 小 → 臂细而清晰；外侧 scatter 大 → 臂化开成雾。
//    这正是参考图「中心细密、外缘弥漫」的观感来源。
//    ⚠️ MIN 不能小到 0：那会让内侧退化成一条精确的弧线（v2/v3 的坑）。
#define SPIRAL_SCATTER_MIN 0.06
#define SPIRAL_SCATTER_GROW 0.85

// 螺旋星云的核球（紧致高斯核）在亮度和不透明度上的额外权重。
// ⚠️ 参考图的核心是一个**又小又极亮**的白点，所以核函数要收紧（exp 系数 1.35）、
//    亮度给足（BOOST）。但 0.95 宽度的 bulge 仍要保留，否则中心变成一个针尖。
#define SPIRAL_CORE_BOOST 2.6
#define SPIRAL_CORE_ALPHA 0.30

// 螺旋星云的臂密度调制权重。
// ⚠️ 只能给 0.1 量级。权重一大（v5 用了 0.52）臂就变成「手绘描边的硬线条」。
//    臂是靠点的**疏密**读出来的，不是靠高对比亮带画出来的。
#define SPIRAL_ARM_ALPHA 0.16

// 三角波往返：0 → 1 → 0（周期 1）。
// ⚠️ 无缝循环的关键工具：用 fract() 做循环时，1 会**硬跳**回 0（波前从远处瞬移回近处，
//    视觉上就是一次突兀的"抽搐"）。三角波在两端都取到端点值、且位置连续，
//    所以「由远及近再退回」看起来是自然的往复，而不是跳变。
//    x=0 → 1，x=0.25 → 0.5，x=0.5 → 0，x=0.75 → 0.5，x=1 → 1。
float triWave(float x){
  float f = fract(x);
  return abs(f * 2.0 - 1.0);
}

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

vec2 safeCoverUv(vec2 uv) {
  return clamp(uv, vec2(0.0012), vec2(0.9988));
}

vec3 sampleNewCoverColor(vec2 uv) {
  return texture2D(uCoverTex, safeCoverUv(uv)).rgb;
}

vec3 samplePrevCoverColor(vec2 uv) {
  return texture2D(uPrevCoverTex, safeCoverUv(uv)).rgb;
}

float rippleSumAt(vec2 p, out float maxAmp) {
  float sum = 0.0; maxAmp = 0.0;
  for (int ri = 0; ri < 12; ri++) {
    if (ri >= uRippleCount) break;
    float vCoord = (float(ri) + 0.5) / 12.0;
    vec4 rd = texture2D(uRippleTex, vec2(0.5, vCoord));
    float age = rd.z; float str = rd.w;
    if (str < 0.005 || age < 0.0 || age > 2.0) continue;
    float dx = p.x - rd.x, dy = p.y - rd.y;
    float dist = sqrt(dx*dx + dy*dy);
    float lifeN = age / 2.0;
    float fadeIn  = smoothstep(0.0, 0.06, age);
    float fadeOut = 1.0 - smoothstep(0.7, 1.0, lifeN);
    float env = fadeIn * fadeOut;
    float bulgeW = 0.55 + age * 0.80;
    float bulge  = exp(-dist*dist / (2.0 * bulgeW * bulgeW)) * (1.0 - smoothstep(0.0, 0.55, lifeN));
    float waveR  = age * 2.10;
    float ringW  = 0.40 + age * 0.22;
    // 用 rw*rw 代替 pow(rw, 2.0)：GLSL 对负底数的 pow 未定义（部分驱动返回 NaN），
    // 而 (dist - waveR) 显然会变负。公式完全等价且恒定有定义。
    float rw     = (dist - waveR) / ringW;
    float ring   = exp(-rw * rw);
    float local  = (bulge * 2.4 + ring * 1.30) * env * str;
    sum += local;
    maxAmp = max(maxAmp, abs(local));
  }
  return sum;
}

void main(){
  float t = uTime * uSpeed;
  vec3 pos;
  vec2 sampleUv = safeCoverUv(aUv);
  vec3 newCol = sampleNewCoverColor(sampleUv);
  vec3 prevCol = samplePrevCoverColor(sampleUv);
  vec3 coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
  float edgeVal = texture2D(uEdgeTex, safeCoverUv(aUv)).g;
  float maxRippleAmp = 0.0;
  float rippleZ = 0.0;
  // 螺旋星云的「核球强度」：分支里赋值，分支外的粒子尺寸公式要用它。
  // ⚠️ 必须在这里声明 —— 分支内声明的话，尺寸计算（在分支之外）看不到它。
  float nebBulge = 0.0;
  // 流星：默认关闭（普通粒子 vMeteor=0，片元里就不走拖尾分支）
  vMeteor = 0.0;
  vMeteorCenter = vec2(0.0);
  vPack1.z = 0.0;   // 拖尾方向角
  vPack1.w = 0.0;   // 尘埃带强度（只有 SPIRAL 预设会写非零值）
  // >0 时覆盖粒子尺寸（单位：与 gl_PointSize 相同的像素）。
  // 流星要一个「长条」点精灵，尺寸按屏高算，跟粒子的景深/音量尺寸公式无关。
  float sizeOverride = -1.0;

  vec3 defaultColor = mix(
    vec3(0.36, 0.28, 0.72),
    mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), aUv.x),
    aUv.y
  );
  vColor = mix(defaultColor, coverColor, uHasCover);
  vAlpha = 1.0;

  // 律动强度的真实倍数
  float K = uIntensity * 1.6;

  // ====================================================
  //  Preset 0: SILK — 丝绸 (xy 平面, z 涟漪)
  // ====================================================
  if (uPreset < 0.5) {
    pos = position;
    rippleZ = rippleSumAt(pos.xy, maxRippleAmp);

    float midN = snoise(vec3(pos.x*1.4, pos.y*1.4, t*0.55)) * 0.6
               + snoise(vec3(pos.x*2.8+5.0, pos.y*2.8-3.0, t*0.85)) * 0.4;
    float midMask = 0.55 + 0.45 * snoise(vec3(pos.x*0.4, pos.y*0.4, t*0.18));
    float midDisp = midN * uMid * 0.55 * midMask * K;

    float trebleJ = snoise(vec3(pos.x*6.5, pos.y*6.5, t*3.5 + aRand*4.0)) * uTreble * 0.18 * K;
    float bassBreath = snoise(vec3(pos.x*0.35, pos.y*0.35, t*0.4)) * uBass * 0.42 * K;

    pos.z = rippleZ * 1.30 + midDisp + trebleJ + bassBreath;
  }

  // ====================================================
  //  Preset 1: TUNNEL — 隧道 + 自旋
  // ====================================================
  else if (uPreset < 1.5) {
    float spin = t * 0.12;
    float angle = aUv.x * 2.0 * PI + spin;
    float flow = aUv.y - t * 0.08 * (1.0 + uBass * 0.55);
    flow = fract(flow);
    float zPos = (flow - 0.5) * 9.0;
    float baseR = 2.0 - uBass * 0.28 * K;
    float ripG  = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (uMid + uTreble) * K;
    float r = baseR + ripG;
    pos.x = cos(angle) * r;
    pos.y = sin(angle) * r;
    pos.z = zPos;

    sampleUv = vec2(aUv.x, flow);
    sampleUv = safeCoverUv(sampleUv);
    newCol = sampleNewCoverColor(sampleUv);
    prevCol = samplePrevCoverColor(sampleUv);
    coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
    vColor = mix(defaultColor, coverColor, uHasCover);

    float depthFade = smoothstep(-4.5, 4.5, zPos);
    vColor *= 0.4 + depthFade * 0.7;
  }

  // ====================================================
  //  Preset 2: ORBIT — 星球 (自转)
  // ====================================================
  else if (uPreset < 2.5) {
    float theta = aUv.x * 2.0 * PI;
    float phi   = (aUv.y - 0.5) * PI;
    float baseR = 2.2;
    float trebFlare = snoise(vec3(theta * 1.5, phi * 1.5, t * 0.7)) * uTreble * 0.85 * K;
    float bassExpand = uBass * 0.35 * K;
    float r = baseR * (1.0 + bassExpand) + trebFlare;

    pos.x = r * cos(phi) * cos(theta);
    pos.y = r * sin(phi);
    pos.z = r * cos(phi) * sin(theta);

    float yaw = t * 0.18;
    float cy = cos(yaw), sy = sin(yaw);
    pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;
  }

  // ====================================================
  //  Preset 3: VOID — 虚空 (无粒子, 纯背景)
  // ====================================================
  else if (uPreset < 3.5) {
    pos = vec3((aUv.x - 0.5) * 0.01, (aUv.y - 0.5) * 0.01, -90.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    maxRippleAmp = 0.0;
  }

  // ====================================================
  //  Preset 4: VINYL — 唱片 (圆形封面 + 黑胶纹路 + 白色边缘)
  // ====================================================
  else if (uPreset < 4.5) {
    float bassDrive = smoothstep(0.08, 0.78, uBass + uBeat * 0.82);
    float highDrive = smoothstep(0.05, 0.46, uTreble);
    float hiResGuard = smoothstep(1.08, 1.55, uCoverRes);
    float edgeGuard = mix(1.0, 0.38, hiResGuard);
    float depthGuard = mix(1.0, 0.44, hiResGuard);
    float grooveGuard = mix(1.0, 0.48, hiResGuard);
    float beatGuard = mix(1.0, 0.36, hiResGuard);

    vec2 p = (aUv - 0.5) * 5.12;
    float spin = uVinylSpin;
    float cs = cos(spin), sn = sin(spin);
    vec2 rp = mat2(cs, -sn, sn, cs) * p;
    float d = length(p);
    float angle0 = atan(p.y, p.x);
    float recordR = 2.46;
    float coverR = 1.18;
    float recordAlpha = 1.0 - smoothstep(recordR - 0.02, recordR + 0.05, d);
    float coverMask = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
    // 同上：底数可负，改用乘法（pow(x,2.0) 等价形式）
    float bz = (d - coverR) / 0.064;
    float oz = (d - (recordR - 0.050)) / 0.055;
    float border = exp(-bz * bz) * edgeGuard;
    float outerRim = exp(-oz * oz) * edgeGuard;
    float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);

    pos = vec3(rp * (1.0 + bassDrive * 0.012 * beatGuard + uBeat * 0.026 * beatGuard), 0.0);
    vAlpha = recordAlpha;

    if (coverMask > 0.02) {
      vec2 coverUv = p / (coverR * 2.0) + 0.5;
      newCol = sampleNewCoverColor(coverUv);
      prevCol = samplePrevCoverColor(coverUv);
      coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
      if (hiResGuard > 0.001) {
        vec2 sx = vec2(0.0026, 0.0);
        vec2 sy = vec2(0.0, 0.0026);
        vec3 softNew = (sampleNewCoverColor(coverUv + sx) + sampleNewCoverColor(coverUv - sx) + sampleNewCoverColor(coverUv + sy) + sampleNewCoverColor(coverUv - sy)) * 0.25;
        vec3 softPrev = (samplePrevCoverColor(coverUv + sx) + samplePrevCoverColor(coverUv - sx) + samplePrevCoverColor(coverUv + sy) + samplePrevCoverColor(coverUv - sy)) * 0.25;
        coverColor = mix(coverColor, mix(softPrev, softNew, clamp(uColorMixT, 0.0, 1.0)), hiResGuard * 0.42);
      }
      vColor = mix(defaultColor, coverColor, uHasCover);
      float coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR, d));
      vColor *= coverShade;
      vColor = mix(vColor, vec3(1.0), border * 0.54);
      pos.z = 0.040 + border * 0.026 * depthGuard + uBeat * 0.018 * beatGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.30 + bassDrive * 0.075 * beatGuard + uBeat * 0.075 * beatGuard);
    } else {
      float groove = 0.5 + 0.5 * sin((d - coverR) * mix(98.0, 58.0, hiResGuard));
      float fineGroove = 0.5 + 0.5 * sin((d - coverR) * mix(170.0, 92.0, hiResGuard) + aRand * 3.0);
      float tick = smoothstep(0.82, 0.995, hash11(floor((angle0 + PI) * 38.0) + floor(d * 72.0) * 2.1));
      vec3 vinyl = vec3(0.052, 0.054, 0.058) + vec3(0.052 * grooveGuard) * groove + vec3(0.026 * grooveGuard) * fineGroove;
      vinyl = mix(vinyl, coverColor * 0.32, 0.18 * (1.0 - vinylN));
      float whiteRing = max(border * 0.92, outerRim * 0.26);
      vColor = mix(vinyl, vec3(0.92, 0.94, 0.94), whiteRing);
      vColor = mix(vColor, vec3(1.0), tick * highDrive * (0.06 + border * 0.12) * grooveGuard);
      pos.z = groove * 0.010 * grooveGuard + border * 0.024 * depthGuard + bassDrive * vinylN * 0.016 * K * beatGuard + tick * highDrive * 0.010 * grooveGuard;
      maxRippleAmp = max(maxRippleAmp, border * 0.32 + outerRim * 0.12 + bassDrive * vinylN * 0.11 * beatGuard + tick * highDrive * 0.10 * grooveGuard + uBeat * vinylN * 0.08 * beatGuard);
    }
  }

  // ====================================================
  //  Preset 5: WALLPAPER PULSE — 星河壁纸 (极光缎带 + 深度星尘)
  // ====================================================
  else if (uPreset < 5.5) {
    float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;
    float midGlow = smoothstep(0.07, 0.62, uMid) * 0.42;
    float highGlow = smoothstep(0.04, 0.46, uTreble) * 0.46;
    float lane = aUv.y;
    float transition = clamp(uBurstAmt, 0.0, 1.0);

    if (lane < 0.80) {
      float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;
      float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
      float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
      float band = floor(bandCoord);
      float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);
      float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
      float seed = hash11(band * 19.17 + aRand * 31.0);
      float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);
      float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);
      float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);
      float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;
      float x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5);
      float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;
      float broadWave = sin(ribbonPhase) * 0.92;
      float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;
      float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92;
      float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;
      // 同上：底数可负，改用乘法（pow(x,2.0) 等价形式）
      float rz = (local - ridgeCenter) / (0.25 + seed * 0.04);
      float ridge = exp(-rz * rz);
      float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
      float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;
      float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;

      pos.x = x + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;
      pos.y = yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);
      pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;

      float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);
      vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);
      aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);
      vAlpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);
      vColor = mix(coverColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);
      maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + midGlow * 0.05) + pulseLine * highGlow * 0.045 + bassGlow * 0.030);
    } else {
      float q = (lane - 0.80) / 0.20;
      float seed = hash11(aRand * 917.0 + floor(q * 130.0));
      float depth = mix(-32.0, 18.0, seed);
      float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);
      float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));
      float x = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;
      float y = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;
      float z = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;
      float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);
      float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));

      pos = vec3(x, y, z);
      vAlpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);
      vColor = mix(coverColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);
      maxRippleAmp = max(maxRippleAmp, twinkle * highGlow * 0.055 + dust * bassGlow * 0.030);
    }

    if (transition > 0.001) {
      float bloom = smoothstep(0.0, 1.0, transition);
      vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;
      vec2 burstDir = burstVec / max(length(burstVec), 0.001);
      pos.xy += burstDir * bloom * 0.026;
      pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;
      pos.xy *= 1.0 + bloom * 0.014;
      pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;
      vAlpha *= 0.86 + bloom * 0.22;
      maxRippleAmp = max(maxRippleAmp, bloom * 0.10);
    }
  }

  // ====================================================
  //  Preset 6: AURORA — 极光（三层垂直光幕 + 高频火花）+ 流星
  //  帘幕：网格用 aUv.y 切成 3 层、层内作为幕高推进；低频抬高幕高，高频驱动闪烁与火花。
  //  流星：网格最前面的 METEOR_SLOTS 颗粒子被征用为「流星槽位」。一颗流星＝一个粒子，
  //        拖尾画在它的点精灵内部（见片元着色器），每波随机出场 3~5 颗。
  // ====================================================
  else if (uPreset < 6.5) {
    // aUv = (i+0.5)/uGrid，所以 floor(aUv*uGrid) 能精确还原格点坐标，从而得到连续编号。
    // 被征用的 5 颗在帘幕里留出 5/14000 的空缺，肉眼不可见。
    float gx = floor(aUv.x * uGrid);
    float gy = floor(aUv.y * uGrid);
    float pid = gy * uGrid + gx;

    // ---------- 流星槽位的前置判定 ----------
    // ⚠️ 这里必须**先算出本波颗数**，只有 pid < count 的槽位才是真·流星。
    //    早先的写法是「pid < METEOR_SLOTS 就整段走流星分支」，于是每波剩余的
    //    空闲槽位（METEOR_SLOTS 固定 5，但每波只用 3~5 颗）也被设上了大尺寸覆盖，
    //    却因为 vMeteor=0 而在片元里落回普通点精灵路径 —— 表现为画面上几个
    //    「又大又圆、不成形状的白斑」。绝不能只靠 vMeteor 在片元里兜底。
    float waveIdx = floor(t / METEOR_WAVE_PERIOD);
    float wphase = fract(t / METEOR_WAVE_PERIOD);
    // 每波颗数：3、4 或 5（由波次哈希决定，波内固定）
    float meteorsThisWave = 3.0 + floor(hash11(waveIdx * 13.71 + 3.3) * 3.0);

    if (pid < meteorsThisWave) {
      // ---------- 流星：一颗粒子从右上角斜掠到左下角，拖尾在片元里绘制 ----------
      // 进到这里的一定是「本波启用」的槽位（pid < meteorsThisWave 已保证），无需再判一次。
      // 每波每槽一组独立随机：换波即换一批轨迹与俯角
      float s1 = hash11(waveIdx * 31.7 + pid * 12.9898 + 1.7);
      float s2 = hash11(waveIdx * 57.3 + pid * 78.233 + 4.1);
      float s3 = hash11(waveIdx * 91.1 + pid * 37.719 + 8.3);

      // 波内错峰出发，单颗行进窗口占 0.34 个周期 → 同屏能同时看到数道，
      // 一波划完后剩下的相位是干净的间歇。
      float mph = (wphase - pid * 0.055) / 0.34;
      // 淡入极快、尾段收掉：不在起手瞬间就全亮（否则会在起点糊出一坨亮斑）
      float life = smoothstep(0.0, 0.06, mph) * (1.0 - smoothstep(0.86, 1.0, mph));

      // 方向：左下，俯角 22°~32°（PI + 0.38 ≈ 202°）。世界 y 与窗口 y 同向（相机无 roll），
      // 所以同一条向量既用于世界位移、也直接当作拖尾朝向。
      float ang = PI + 0.38 + s1 * 0.18;
      vec2 dir = vec2(cos(ang), sin(ang));

      // 起点在画面右上角外侧；行程足够让它从画面左下角外离开
      vec2 p0 = vec2(4.2 + s2 * 4.6, 4.6 - s3 * 1.2);
      vec2 headP = p0 + dir * (mph * (16.0 + s3 * 3.0));

      pos = vec3(headP, 1.0 - s2 * 1.6);   // z 为正 → 画在帘幕之前，压着极光才看得清
      // 流星强度写进 vPack1.y；方向角写进 vPack1.z（末尾统一换算窗口中心）
      vMeteor = life;
      vPack1.z = ang;
      vColor = mix(vec3(0.74, 0.87, 1.0), coverColor, 0.30);   // 冷白偏蓝，再按封面混一点
      vAlpha = 1.0;
      // 拖尾是个「长条」精灵：尺寸按屏高给（与景深/音量无关，见片元的尺寸覆盖）
      sizeOverride = uMeteorSize / max(0.0001, uPixel * uPointScale);
    } else {
      // 走到这里的包括「未被征用的格子」和「本波没启用的流星槽位」——
      // 两者都必须按普通帘幕粒子渲染，否则空闲槽位会变成几个大圆斑。
      float layer = floor(aUv.y * 3.0);
      float ly = fract(aUv.y * 3.0);
      float lseed = hash11(layer * 17.3 + aRand * 3.1);

      float x = (aUv.x - 0.5) * 11.0;
      float floorY = -3.2 + lseed * 1.0;
      float height = 3.0 + lseed * 1.5 + uBass * 0.9 * K;
      float phase = t * (0.20 + lseed * 0.14) + aRand * 6.28;

      // 幕面横向摆动（大尺度噪声 + 小尺度褶皱）
      float wave = snoise(vec3(aUv.x * 3.4 + lseed * 9.0, layer * 2.3, t * 0.16 + lseed * 4.0)) * 1.15
                 + sin(aUv.x * 9.0 + t * 0.7 + lseed * 6.0) * 0.40;

      pos.x = x + wave * ly * 1.05 + sin(phase) * 0.18;
      pos.y = floorY + ly * height + sin(aUv.x * 12.0 - t * 1.3 + lseed * 3.0) * 0.22 * (0.4 + ly);
      pos.z = -3.4 + layer * 1.7 + wave * 0.70 + snoise(vec3(aUv.x * 2.0, ly * 3.0, t * 0.24)) * 0.80;

      // 高频火花：稀疏亮点，逐点相位不同
      float spark = pow(max(0.0, sin(t * (3.2 + lseed * 4.0) + aRand * 31.0)), 12.0);
      float shimmer = 0.55 + 0.45 * sin(t * (2.0 + lseed * 1.6) + aUv.x * 22.0 + layer * 2.0);

      // 真实极光配色：幕底青绿 → 幕顶紫 → 顶端一丝品红，再按封面混色
      float hMix = clamp(ly * 1.15, 0.0, 1.0);
      vec3 auroraCol = mix(vec3(0.22, 0.98, 0.66), vec3(0.62, 0.42, 1.0), hMix);
      auroraCol = mix(auroraCol, vec3(0.98, 0.55, 0.82), pow(hMix, 3.0) * 0.55);

      vColor = mix(auroraCol, coverColor, 0.34) * (0.72 + shimmer * 0.34 + spark * 0.9);
      float curtainFade = smoothstep(0.0, 0.20, ly) * (1.0 - smoothstep(0.74, 1.0, ly));
      vAlpha = (0.10 + ly * 0.34 + spark * 0.50 + uTreble * 0.16) * curtainFade;
      maxRippleAmp = max(maxRippleAmp, ly * uBass * 0.34 + spark * 0.34 + shimmer * uMid * 0.10 + uBeat * 0.12);
    }
  }


  // ====================================================
  //  Preset 7: KALEIDO — 万花筒（封面径向镜像成 10 瓣对称花纹）
  //  aUv.y 切成 10 个扇区、隔扇区镜像、aUv.x 作半径，形成十重旋转对称。
  // ====================================================
  else if (uPreset < 7.5) {
    float secAngle = PI * 2.0 / 10.0;
    float sector = floor(aUv.y * 10.0);
    float a0 = fract(aUv.y * 10.0) * secAngle;
    float a = (mod(sector, 2.0) < 0.5) ? a0 : (secAngle - a0);
    float ang = sector * secAngle + a + t * 0.10;

    float rr = pow(aUv.x, 0.72) * 4.6 + 0.20;
    pos.x = cos(ang) * rr;
    // 纵向压扁 0.62：舞台取景框是宽矩形，正圆会在上下被裁掉
    pos.y = sin(ang) * rr * 0.62;
    // 轻微锥形起伏 + 低频整体鼓起，让花纹有立体感而不是一张贴纸
    pos.z = snoise(vec3(cos(ang) * rr * 0.45, sin(ang) * rr * 0.45, t * 0.12)) * 1.35
          + (1.0 - aUv.x) * 0.85 + uBass * 0.50 * K;

    // 同心环纹（缓慢旋转）+ 每瓣一个色相，再按封面混色
    float ring = 0.5 + 0.5 * sin(aUv.x * 26.0 - t * 0.9 + sector * 1.7);
    vec3 kaleCol = mix(vec3(0.86, 0.72, 1.0), vec3(0.18, 0.96, 0.84), fract(sector * 0.37));
    kaleCol = mix(kaleCol, coverColor, 0.46 + aUv.x * 0.20);
    vColor = kaleCol * (0.78 + ring * 0.28 + uBeat * 0.12);
    vAlpha = (0.16 + ring * 0.30 + (1.0 - aUv.x) * 0.22 + uMid * 0.12)
           * (1.0 - smoothstep(0.88, 1.0, aUv.x));
    maxRippleAmp = max(maxRippleAmp, ring * uMid * 0.30 + uBass * 0.12 + (1.0 - aUv.x) * uBeat * 0.18);
  }

  // ====================================================
  //  Preset 8: BURST — 迸发（每次换歌爆开一次）→ 之后常驻：匀速缓慢自转 + 整片上下浮动
  //  uBurstAge = 距本次迸发开始的秒数，只在切歌时归零；不像之前每拍重置。
  //  爆开之后粒子**不再消失**，停在各自的稳定轨道上：恒定角速度自转，整片云一起缓慢上下平移。
  // ====================================================
  else if (uPreset < 8.5) {
    // 错峰飞出：4 批，每批晚 0.075s；单批行程 0.80s，所以最后一批在 1.05s 前飞完。
    // 常驻期 lph 恒为 1（不会回绕），粒子停在稳定轨道上。
    float wave = floor(hash11(aRand * 137.0) * 4.0);
    float lph = clamp((uBurstAge - wave * 0.075) / 0.80, 0.0, 1.0);

    // 每颗粒子的稳定轨道半径与轨道角度
    float orbitR = (0.32 + hash11(aRand * 71.0) * 0.85) * 4.4;
    float rr = (0.10 + 0.90 * pow(lph, 0.62)) * orbitR;

    // 缓慢自转：**恒定角速度**，不接任何音频量。
    // （原先角速度带 uBass 调制，低频一变转速就变，看起来像自旋被推了一下，观感不干净。）
    float ang = hash11(aRand * 37.0) * PI * 2.0 + t * 0.10;

    // 极慢的上下浮动：做成**整片云一起平移**（所有粒子共用同一个偏移），
    // 而不是逐粒子加在 z 上 —— 逐粒子改 z 会因透视让外圈粒子的屏幕半径来回缩放，
    // 看起来就像自旋在抖。整片平移是刚体运动，不会干扰自转的花纹。
    float driftY = sin(t * 0.35) * 0.12;
    pos.x = cos(ang) * rr;
    pos.y = sin(ang) * rr * 0.62 + driftY;
    pos.z = (hash11(aRand * 91.0) - 0.5) * 1.6 + (1.0 - lph) * 0.80;

    // 冲击环：只在「飞出去」的过程中亮一下，到位后淡掉（常驻期不该有环）
    // 注意不能用 pow(x, 2.0) —— GLSL 里底数为负时 pow 未定义（部分驱动直接 NaN），
    // 所以这里用 dz*dz 代替（公式等价且恒定有定义）。
    float dz = (lph - 0.90) / 0.18;
    float shell = exp(-dz * dz) * (1.0 - smoothstep(0.90, 1.0, lph));
    vec3 burstCol = mix(vec3(0.20, 0.96, 0.86), vec3(1.0, 0.60, 0.78), hash11(aRand * 53.0) * 0.5);
    vColor = mix(burstCol, coverColor, 0.36) * (0.80 + shell * 0.75);

    // 只在起爆瞬间做一次快速淡入（避免粒子全挤在中心糊成亮斑）；
    // 之后**不再淡出** —— 这正是「迸发后不要消失」。
    vAlpha = smoothstep(0.0, 0.10, lph) * (0.34 + hash11(aRand * 19.0) * 0.42 + shell * 0.55);
    // uBeat 只给很小的权重（位置已不接节拍）：这里再大就会变成「闪」
    maxRippleAmp = max(maxRippleAmp, uBass * 0.20 + uMid * 0.10 + shell * 0.45 + uBeat * 0.06);
  }

  // ====================================================
  //  Preset 9: SONIC — 声波地形
  //  一张随音乐起伏的「山脊地图」：横向是扫描线，纵深（aUv.y）是远近，
  //  高度由多层噪声叠加而成，低频整体抬高、高频加细碎波纹，
  //  再叠一道自远而近、再由近而远往复推进的扫描波前（波前处最亮）。
  //  相机贴地平视（phi=0.30），所以纵向位移会读成「地形起伏」。
  //
  //  ⚠️ 三个已修正的观感问题（都只能靠眼睛发现）：
  //   ① 地形**整体偏上**：h 恒为正（depthFall + ridge + bassLift 三项都偏正），
  //      实测 h∈[-0.74,1.75]、中心 +0.51 → 画面上半部挤满、下半部空。
  //      修法：显式减一个 centerY 把中轴拉到 0，而不是靠调整某个系数碰运气。
  //   ② **上下起伏范围不够**：振幅偏小（总跨度仅 2.5）。这里把三层噪声振幅整体放大，
  //      并把 depthFall 改成**双向**（近处抬、远处压）以强化纵深。
  //   ③ **循环不连贯**：原先用 fract(t*0.13) 做扫描，每 7.7 秒硬跳一次（波前瞬移）；
  //      地形的时间种子又是无限线性漂移（噪声永不重复）。现在扫描改 triWave 往复，
  //      时间种子也走 triWave 的**有界**往返 → 地形在同一片山谷里"呼吸"，永不飘走。
  // ====================================================
  else if (uPreset < 9.5) {
    float gx = aUv.x;                       // 横向扫描线
    float gz = aUv.y;                       // 纵深（0 = 近，1 = 远）

    // 纵深方向按网格铺开；宽度比高度大，形成一条「带状地形」
    float worldX = (gx - 0.5) * 13.0;
    float worldZ = (gz - 0.5) * 7.0;

    // 时间种子一律走 triWave 的**有界往返**（振幅 span 与各自周期都不同）：
    // 噪声采样点因此始终在一小块区域内来回，地形不会随时间长成"另一张地图"。
    // 三个周期取 27 / 19 / 13 秒，互不成简单整数比，合起来不会显出机械的同步感。
    float tSeed1 = triWave(t / 27.0) * 0.62;
    float tSeed2 = triWave(t / 19.0) * 1.10;
    float tSeed3 = triWave(t / 13.0) * 3.30;

    // 山脊高度：三层噪声（大起伏 + 中褶皱 + 细砂砾），逐层提高频率、降低振幅。
    // 噪点用 worldX/worldZ 采样，保证相邻格点连续 → 看起来是「地形」而不是「散点」。
    // ⚠️ 振幅比初版整体放大（1.15→1.28 / 0.42→0.49 / 0.14→0.16），否则上下起伏太平。
    //    数值是**仿真扫出来的**：再放大 30% 就会在鼓点峰值时顶出可见范围（占满 98% 高度）。
    float ridge = snoise(vec3(worldX * 0.55, worldZ * 0.42 + tSeed1, tSeed1)) * 1.28
                + snoise(vec3(worldX * 1.60, worldZ * 1.25 + tSeed2, tSeed2)) * 0.49
                + snoise(vec3(worldX * 4.20, worldZ * 3.40, tSeed3)) * 0.16;

    // 纵深：近处抬、远处压（**双向**），形成"脚下是谷、远处是岭"的纵深层次；
    // 初版 (1.0-gz)*0.55 是单向抬升，与 ridge 叠加后把整体顶到了 y>0。
    float depthShape = (0.5 - gz) * 1.05;
    float bassLift = uBass * 0.95 * clamp(1.0 - gz * 0.7, 0.3, 1.0);
    float h = ridge * (0.92 + uMid * 0.42) + depthShape + bassLift;

    // 把地形中轴拉到 y = 0。
    // ⚠️ 这个常数是**量出来的**不是在纸面上推的：仿真扫出 h 的中轴约在 +0.35 附近
    //    （depthShape 与 ridge 的正偏所致），bassLift 峰值再往上顶约 0.5。
    //    减掉 0.42 后地形中心基本落回 0，上下各留约 1.2 的余量。
    //    改动上面任何一个振幅 / depthShape / bassLift 系数，都要重新仿真核对这个值。
    float centerY = 0.42;
    h -= centerY;

    // 扫描波前：**triWave 往复**（由远 gz=1 到近 gz=0，再退回），一个来回 36 秒。
    // 用 triWave 而不是 fract：fract 会在 1→0 处把波前从远处瞬移回近处（突兀的跳），
    // triWave 在端点自然折返，观感是"潮水来回"。
    //
    // ⚠️⚠️ 波前位置**绝不能把 uBeat 乘在绝对时间上**（踩过，会随播放时长越来越糟）：
    //     错例（注释里不要写反引号，会截断本文件的 JS 模板字符串）：
    //       scanPhase = t / 36.0 * (1.0 + uBeat * 0.55)
    //     代数上它 = t/36 + (t * uBeat * 0.55)/36，那第二项**与 t 成正比** ——
    //     t 是已播放秒数、只增不减，所以同一个 uBeat 突变在 t=60s 只让相位跳 0.46，
    //     到 t=900s 就会跳 6.9 个整周期，波前表现为**瞬间乱闪**（用户报的"抖动"）。
    //     现在 uBeat 只用于**亮度增益**（见下方 scanBand），位置纯 t/36 匀速往复，跳变恒为 0。
    float scanPos = triWave(t / 36.0);
    // ⚠️ 不能用 exp(-pow(d, 2.0))：GLSL 对**负底数**的 pow 未定义（部分驱动直接返回 NaN），
    //    而 d 显然会取负。必须自己乘自己（dz*dz），公式等价且恒有定义。
    float dz = (gz - scanPos) * 4.2;
    // 拍点让波前"更亮"而不是"更靠前"：
    // 基准亮度压到 0.72，留出 uBeat 的提升空间（0.72 → 1.0），最后钳回 [0,1] ——
    // 下游拿 scanBand 当 mix 权重和 alpha 增益，超过 1 会让颜色外推（过曝）或 alpha 溢出。
    float scanBand = min(1.0, exp(-dz * dz) * (0.72 + uBeat * 0.42));

    pos.x = worldX;
    pos.y = h;
    // 整体推远：相机 radius=9.2、phi=0.30 俯视，地形若有粒子跑到 z>0 就会贴到相机前
    // （透视放大成一团糊）。这里把整块地形压到 z ∈ [-7.5, -0.5]，全部落在相机前方。
    pos.z = worldZ - 4.0;

    // 配色：谷底深青 → 山脊暖白（hN 用 ±1 归一化，与居中的 h 配套）
    float hN = clamp(h * 0.26 + 0.5, 0.0, 1.0);
    vec3 sonicCol = mix(vec3(0.10, 0.52, 0.62), vec3(0.86, 0.94, 0.98), hN);
    sonicCol = mix(sonicCol, vec3(0.72, 0.48, 1.0), scanBand * 0.55);
    vColor = mix(sonicCol, coverColor, 0.30) * (0.78 + hN * 0.30 + scanBand * 0.55);

    // 波前与脊顶更亮；谷底保持可见但不抢眼
    vAlpha = (0.10 + hN * 0.30 + scanBand * 0.52 + uTreble * 0.10)
           * (1.0 - smoothstep(0.86, 1.0, gz));   // 最远处淡出，藏住地形边缘
    maxRippleAmp = max(maxRippleAmp, scanBand * 0.55 + hN * uBass * 0.28 + uTreble * 0.14);
  }

  // ====================================================
  //  Preset 10: SPIRAL — 螺旋星云（v7：对齐参考图「多条细密旋臂 + 锐利星点」）
  //
  //  参考图特征（用户提供的银河照片）：
  //    · **多条**细密旋臂（能数出 3~4 条），互相缠绕
  //    · 臂是**锐利**的亮丝，但整片仍是弥散的云（不是硬描边）
  //    · 核心白→粉紫，外臂青白，深蓝底，对比强
  //    · 臂外有暗色尘埃带切过，层次多
  //
  //  ⚠️ 与 v6 的关系：v6 是「2 条臂 + 大散射」的弥散云（用户认可「大体样式可以」）。
  //     v7 保留 v6 的**弥散底子**（角度 SD 仍 ≈ 3.5，不是线），但把臂做**锐**：
  //
  //     ⚠️⚠️ 关键是「**散射随半径变化**」这把钥匙：
  //        · 内侧（核球附近）scatter 小 → 臂细而清晰（参考图中心那几圈是细密的）
  //        · 外侧 scatter 大 → 臂化开成雾（参考图外缘是弥散的）
  //     实测「臂内角散 SD」：v6 外缘 0.37~0.40 rad → v7 0.25~0.29 rad（更锐利），
  //     而整体角度 SD 仍保持 3.2~3.6（确认没有退化成线）。
  //
  //     ⚠️ 另一个关键是**臂的条数**：2 条 → 4 条。参考图明显不止两条臂，
  //        条数多才读得出「缠绕的层次」。实测覆盖率 59.4% → 75.7%。
  //
  //  ⚠️ 仍然不要做的事（v5 的教训）：
  //     不要用高对比掩码去「画」臂的横截面（armCore² 那种）—— 那会变成手绘描边。
  //     臂的锐利度靠**散射幅度**控制，不靠亮度掩码。
  // ====================================================
  else {
    // ---- 半径分布：必须「中心密」 ----
    // ⚠️ 别用 sqrt(aUv.x)（那是「面积均匀」的正确分布）—— 星云的面亮度是从中心向外
    //    衰减的，面积均匀会得到一个**中空的甜甜圈**。用 pow 让点向中心聚集。
    // ❗注意注释里别写「带不配对括号的示例」：本文件的括号平衡由静态核查脚本和单测
    //    按**逐字符**统计（不剥注释），注释里多出一个圆括号就会被误报成编译级错误。
    // 这里 clamp 一次底数：aUv.x 是 UV（正常 ∈ 0..1），但若被异常数据污染成负数，
    //    pow 会返回 NaN 并让整片星云消失 —— clamp 掉既消除告警也让行为确定。
    float rr = pow(clamp(aUv.x, 0.0, 1.0), 1.45) * SPIRAL_RMAX + 0.05;
    float tR = clamp(rr / SPIRAL_RMAX, 0.0, 1.0);   // 归一化半径，后面反复用

    // ---- 臂心：**多条**臂（参考图能数出 3~4 条）----
    // ⚠️ 条数写在 SPIRAL_ARMS 里，臂偏移均分 2π；一条臂一个增量，点不会跨臂。
    float armPick = floor(hash11(aRand * 313.0) * SPIRAL_ARMS);
    float armOffset = (armPick / SPIRAL_ARMS) * 2.0 * PI;

    // ---- ① 弥散底子：每颗粒子独立的角度散射（v1/v6 的成功要素，不能删）----
    // ⚠️⚠️ 这一项是「像云而不是像线」的唯一来源。
    //    但 v7 让它**随半径变化**：内小外大 → 内侧臂锐利、外缘化开成雾。
    //    这就是参考图「中心细密、外缘弥漫」的观感来源。
    float sBase = SPIRAL_SCATTER_MIN + SPIRAL_SCATTER_GROW * tR * tR;
    float scatter = (hash11(aRand * 511.0) - 0.5) * sBase;

    // ---- ② 对数螺线：θ = k·ln(r) + 臂偏移 + 散射 ----
    // 系数 2.6 比 v6 的 2.4 略大 —— 臂条数变多后，需要略大的缠绕才看得出层次，
    // 但仍远低于会把臂甩出取景框的量级。
    float ang = 2.6 * log(max(rr, 0.12)) + armOffset + scatter + t * 0.075;

    // ---- 盘面起伏（薄盘）+ 核球在 z 上鼓起 ----
    float bulge = exp(-rr * rr * 0.14) * 0.95;
    nebBulge = bulge;                                       // 传给分支外的尺寸公式

    // ⚠️ v7：核球用**紧致的高斯核**（0.95 → 1.35 + 半径 0.34）。
    //    参考图的核心是一个又小又极亮的白点，不是一大团亮雾。
    //    但 vAlpha 用的 bulge 仍要保留一定宽度，否则中心会变成一个「针尖」。
    float core = exp(-rr * rr * 1.35);
    float diskZ = snoise(vec3(cos(ang) * rr * 0.7, sin(ang) * rr * 0.7, t * 0.12)) * 0.30;

    pos.x = cos(ang) * rr;
    // 盘面压扁 0.42：侧视角度下让星云读成「盘」而不是「球」
    pos.y = sin(ang) * rr * 0.42 + diskZ * 0.32;
    pos.z = diskZ + bulge * 0.45 + (1.0 - bulge) * 0.30 - 1.6;

    // ---- 配色：核心白 → 粉紫 → 青白 → 外缘蓝（对齐参考图的冷色系）----
    // ⚠️ v7 调整：参考图的核心是**白偏粉**（不是 v6 的暖黄），
    //    中段是**粉紫**亮环，外臂是青白，最外转深蓝。整体比 v6 更冷、对比更强。
    vec3 coreCol  = vec3(1.00, 0.96, 0.92);   // 中心近白（略带暖）
    vec3 innerCol = vec3(0.94, 0.62, 0.99);   // 内环粉紫（参考图最醒目的那圈）
    vec3 midCol   = vec3(0.55, 0.86, 1.00);   // 中段青白
    vec3 edgeCol  = vec3(0.36, 0.46, 0.98);   // 外缘蓝
    vec3 spCol;
    if (tR < 0.22) {
      spCol = mix(coreCol, innerCol, tR / 0.22);
    } else if (tR < 0.55) {
      spCol = mix(innerCol, midCol, (tR - 0.22) / 0.33);
    } else {
      spCol = mix(midCol, edgeCol, (tR - 0.55) / 0.45);
    }
    // ⚠️ 与封面的混合比例 0.26 → 0.12：这是**星云**预设，参考图的色调是主角；
    //    混太多封面会把冷色系冲淡成灰。仍留一点以保留「跟随封面」的关联感。
    // 亮度：核球附近额外抬一档（参考图核心是过曝的白），外缘压暗。
    float lumCore = 1.0 + core * SPIRAL_CORE_BOOST;

    // ---- 星尘亮度尖峰：参考图有大量**明亮锐利的星点** ----
    // 取一小部分粒子（约 5%）给一个高亮度尖峰，模拟参考图里那些「撒盐」般的亮星。
    // ⚠️ 用 step 挑出少数粒子而不是整体提亮 —— 整体提亮会让星云糊成一片白。
    float star = step(0.95, hash11(aRand * 731.0));
    lumCore += star * 1.5;
    vColor = mix(spCol, coverColor, 0.12) * (0.80 + lumCore * 0.34 + uMid * 0.14);

    // ---- 臂的密度调制（v5 翻车处，保持克制）----
    // ⚠️ 权重只能给 0.1 量级。星云的臂是靠**点的疏密**读出来的，
    //    不是靠一条高对比的亮带画出来的。这里只让臂上密一点、臂间稀一点。
    float armMask = 0.55 + 0.45 * cos(scatter * 9.0);

    // 核球实、臂上中等、臂间空旷处压暗（散斑给出星尘的颗粒感）。
    vAlpha = (0.075 + bulge * 0.62 + core * SPIRAL_CORE_ALPHA + (1.0 - tR) * 0.13
              + armMask * SPIRAL_ARM_ALPHA + uMid * 0.09)
           * (1.0 - smoothstep(0.94, 1.0, aUv.x));   // 外缘淡出，不留硬边
    maxRippleAmp = max(maxRippleAmp, bulge * 0.50 + uBass * 0.16 + uTreble * 0.12);
  }

  // ====================================================
  //  鼠标交互 (仅 SILK)
  // ====================================================
  if (uMouseActive > 0.5 && uPreset < 0.5) {
    float mdx = pos.x - uMouseXY.x;
    float mdy = pos.y - uMouseXY.y;
    float md = sqrt(mdx*mdx + mdy*mdy);
    if (md < 1.0) {
      float push = (1.0 - md) * (1.0 - md);
      pos.z += push * 0.55;
    }
  }

  // ====================================================
  //  颜色：边缘增益 / 黑粒子保护 / 取色 / 主色染色
  // ====================================================
  float edgeBoost = uEdgeEnabled * edgeVal;
  vSourceLum = dot(max(vColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
  float blackParticleGuard = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  vEdgeBoost = edgeBoost * (uPreset > 3.5 ? 0.22 : 1.0) * (1.0 - blackParticleGuard);
  vColor = pow(max(vColor, vec3(0.0)), vec3(1.0 / max(0.35, uColorBoost)));
  float edgeColorMix = edgeBoost * (uPreset > 3.5 ? 0.20 : 0.50) * (1.0 - blackParticleGuard);
  vColor = mix(vColor, vColor + vec3(0.20), edgeColorMix);
  float tintLum = max(max(vColor.r, vColor.g), vColor.b);
  vec3 tintedColor = uTintColor * max(0.24, tintLum * 1.12);
  vColor = mix(vColor, tintedColor, clamp(uTintStrength, 0.0, 1.0) * (1.0 - blackParticleGuard));
  // 暗封面下限保护（丝绸/星河）：避免整片过黑看不清；唱片预设保持黑胶质感不提亮
  if (uPreset < 0.5 || uPreset > 4.5) {
    vColor = max(vColor, vec3(0.13));
  }

  vBright = 0.92 + maxRippleAmp * 0.55 + uBass * 0.10 + edgeBoost * 0.30 + uEnergy * 0.05 + uBurstAmt * 0.40;
  if (uPreset > 5.5) {
    // 极光/万花筒/迸发/声波地形/螺旋星云：亮度改由各自的 maxRippleAmp 承担
    // （迸发＝冲击环的相位驱动），刻意不接 uBeat —— 那是每拍都会跳的量，
    // 会让迸发与迸发之间也在闪。
    vBright = 0.94 + maxRippleAmp * 0.72 + uBass * 0.055 + uEnergy * 0.055 + uBurstAmt * 0.26;
    if (uPreset > 8.5 && uPreset < 9.5) {
      // 声波地形：亮度主要由「高度」给（分支里已算进 vColor），这里压低额外增益，
      // 否则脊顶会过曝成一条白线，看不出地形层次。
      vBright = 0.86 + maxRippleAmp * 0.42 + uBass * 0.045 + uEnergy * 0.030;
    } else if (uPreset > 9.5) {
      // 螺旋星云（v6）：核球亮、外缘暗，靠点的疏密与 vAlpha 表达，亮度增益保持克制。
      // ⚠️ 回到 v1 的公式（0.50 的 maxRippleAmp 权重）—— v5 曾用 0.46 + 显式臂脊加成，
      //    那会把旋臂推成一条高对比亮带，正是「像手绘描边」的成因之一。
      vBright = 0.90 + maxRippleAmp * 0.50 + uBass * 0.040 + uEnergy * 0.035;
    }
  } else if (uPreset > 4.5) {
    vBright = 1.02 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025;
  } else if (uPreset > 3.5) {
    vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08 + edgeBoost * 0.12 + uEnergy * 0.05 + uBeat * 0.16 + uBurstAmt * 0.16;
  }
  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.5, -mvPos.z);
  float audioBoost = 1.0 + maxRippleAmp * 0.7 + edgeBoost * 0.55 + uBeat * 0.30 + uBurstAmt * 0.5;
  float sz = clamp(depthSize * audioBoost, 1.05, 4.95);
  if (uPreset > 5.5 && uPreset < 6.5) {
    // 极光（AURORA）：帘幕是靠**上万个细点**堆出「幕」的质感，点太大就变成一团颗粒，
    // 看不出丝绸般的垂帘感。基准尺寸和上限都往下压，并且把音频驱动收敛一些
    // （原来的 uBeat*0.30 会让鼓点一来整片幕「炸毛」成大颗粒）。
    float auroraDrive = maxRippleAmp * 0.28 + uBass * 0.10 + uMid * 0.06 + uBeat * 0.10;
    sz = clamp(depthSize * 0.62 * (1.0 + auroraDrive), 0.72, 2.60);
  } else if (uPreset > 9.5) {
    // 螺旋星云（SPIRAL v7）：参考图是「大量**锐利小星点** + 细密旋臂」。
    // ⚠️ 点必须**小**才锐利 —— 点一大就糊成一片绒球，参考图那种「撒盐般的亮星」就没了。
    //    v6 的基准 0.50 / 上限 3.60 是按「弥散云」定的，偏大。
    //    现在：基准 0.34、上限 2.20，并且**核球不再显著放大**（靠亮度而非尺寸读核心）。
    //    核球只留一点点尺寸加成（0.10），避免中心变成一坨大点。
    float nebDrive = nebBulge * 0.20 + uBass * 0.05 + uMid * 0.04;
    sz = clamp(depthSize * (0.34 + nebBulge * 0.10) * (1.0 + nebDrive), 0.42, 2.20);
  } else if (uPreset > 8.5) {
    // 声波地形（SONIC）：地形是「连续的脊」，点尺寸要小而均匀，
    // 尺寸若跟着高度变化，脊顶会鼓成一串珠子、破坏地形的连续感。
    sz = clamp(depthSize * 0.52 * (1.0 + uTreble * 0.12), 0.62, 2.30);
  } else if (uPreset > 5.5) {
    // 粒子尺寸同样跟随 maxRippleAmp（迸发＝冲击环所在的那一圈更大），不用 uBeat
    float punchDrive = uBass * 0.075 + uMid * 0.050 + uTreble * 0.070 + maxRippleAmp * 0.30 + uBurstAmt * 0.120;
    sz = clamp(depthSize * (1.05 + punchDrive), 1.00, 5.45);
  } else if (uPreset > 4.5) {
    float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060 + uBurstAmt * 0.090 + uBeat * 0.055;
    sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
  } else if (uPreset > 3.5) {
    float ringDrive = uBass * 0.30 + uMid * 0.18 + uTreble * 0.22 + uBeat * 0.30;
    sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
  }
  // 流星覆盖尺寸：拖尾长度是按屏高给的像素值，与景深/音量那套公式无关
  if (sizeOverride > 0.0) sz = sizeOverride;
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
  // 把粒子中心换算到**窗口像素**（与片元里的 gl_FragCoord 同一坐标系），供拖尾几何使用。
  // 之所以不用 gl_PointCoord：它在不同平台/驱动上的 y 轴方向有歧义，
  // 一旦反了拖尾的「头」就会画到后面去（变成倒着飞的流星）。
  vMeteorCenter = (gl_Position.xy / gl_Position.w * 0.5 + 0.5) * uResolution;
}
`;

// ============================================================
//  片元 Shader（主层：可读性边缘 — 亮粒子描暗边、暗粒子描亮边）
// ============================================================
export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uPreset, uMeteorSize;
varying vec3 vColor;
varying vec4 vPack0;   // .x=vBright .y=vRipple .z=vEdgeBoost .w=vAlpha
varying vec4 vPack1;   // .x=vSourceLum .y=vMeteor .z=拖尾方向角 .w=尘埃带强度(仅星云)
varying vec2 vMeteorCenter;
#define vBright    vPack0.x
#define vRipple    vPack0.y
#define vEdgeBoost vPack0.z
#define vAlpha     vPack0.w
#define vSourceLum vPack1.x
#define vMeteor    vPack1.y
#define vDustLane  vPack1.w

void main(){
  // ====================================================
  //  流星拖尾
  //  一颗流星 = 一个粒子：拖尾直接画在它的点精灵内部（参考《巫师 3》的流星实现 ——
  //  每颗就是一个细长条，且**头部远亮于尾部**，尾部按二次曲线渐隐）。
  //  几何全部用窗口坐标（gl_FragCoord）计算，与顶点写入的窗口中心 / 方向角
  //  同一坐标系，因此不存在点精灵 y 轴方向的平台歧义，拖尾朝向恒定正确。
  // ====================================================
  if (vMeteor > 0.002) {
    vec2 vMeteorAxis = vec2(cos(vPack1.z), sin(vPack1.z));
    vec2 d = gl_FragCoord.xy - vMeteorCenter;
    float along = dot(d, vMeteorAxis);                       // >0 指向头部（左下）
    float perp  = dot(d, vec2(-vMeteorAxis.y, vMeteorAxis.x));

    // 拖尾长度：**不等于**精灵边长。
    // ⚠️ 点精灵是正方形，边长 = uMeteorSize。若让拖尾铺满整个精灵，
    //    它就会顶到精灵边界被硬裁，而且视觉上又粗又短像一块白斑。
    //    这里只取边长的一部分作长度，剩下留作横向余量（避免斜向拖尾被方框切掉）。
    float L  = max(uMeteorSize, 1.0) * 0.82;
    float hf = L * 0.5;
    // u: 0 = 头部（沿 axis 正方向的最前端，即飞行前方），1 = 尾端
    // ⚠️ 「头部在哪一端」由 axis 的正方向决定：axis = (cos(vPack1.z), sin(vPack1.z))，
    //    vPack1.z = ang = PI + 0.38 + … ≈ 202°，在 gl_FragCoord（y 向上）系里指向**左下**，
    //    与世界里的飞行方向 dir 完全同向。所以 u=0 在左下 —— 流星从右上飞向左下，
    //    头部在最前方（左下），拖尾朝来路（右上）拖。这是正确的，别把符号反过来。
    //
    // ⚠️⚠️ 这里**绝对不能**写成 u = clamp((hf - along) / L, 0.0, 1.0)（踩过，被用户抓到）：
    //    钳制会让 along > hf（拖尾前端之外、精灵框内还剩 uMeteorSize*0.09 ≈ 22px）
    //    的整片区域都取到 u = 0，也就是「头部轮廓」——轮廓不衰减、prof 仍为 1，
    //    于是**头部前方凭空多出一截和头部一样亮的拖尾**。
    //    视觉后果：亮核前方还有 20 多 px 的亮块，看起来像「头长在拖尾中间」。
    //    正解是让 u 在头部前方**线性外推后截断**（见下面的 headCut），
    //    使形状在 along > hf 处迅速收束成 0。
    float axialT = (hf - along) / L;
    float u  = clamp(axialT, 0.0, 1.0);

    // 横向轮廓：**头部一个小圆头 + 向后收细的拖尾**（叶片形）。
    // ⚠️ 这里试过两个极端，都不对：
    //    ① w = wMax*(0.16+0.84*tail²) —— 头端留 0.16 保底宽度 → 钝头，叠上圆核像「棒子黏珠子」；
    //    ② w = wMax*sqrt(u)*(…)      —— 头端宽度直接归 0 → 太单薄，像「棍子前端一个孤立小点」。
    //    正解：宽度在头端**不为零但不最大**，最大值落在头部稍后一点，再向尾端收细。
    //    这样头部是个饱满的小圆头（配合 head 亮核），拖尾自然变丝。
    float wMax = max(uMeteorSize * 0.013, 1.4);
    // u=0 头 → 宽度 0.62；u≈0.12 处最宽 1.0；之后缓降；u=1 尾端 0.24
    float profileW = 0.62 + 0.38 * sin(u * 3.14159 * 0.92) - 0.38 * u;
    float w  = wMax * clamp(profileW, 0.10, 1.2);
    // 头部前方的收束：axialT < 0 表示已越过拖尾前端（飞行方向的最前沿）。
    // 用一个快速衰减的窗把形状切掉，头部才真正「到边即止」，而不是拖出一截同样亮的余量。
    // ⚠️ 斜率**不能太缓**：初版用 6.0，意味着从「完全消失」到「完全显现」横跨
    //    1/6 * L ≈ 34px（精灵框内头部前方那 22px 全落在过渡带里）。
    //    实测 along=+123 时 alpha 仍有 0.319、+108 时 0.739 —— 用户看到的就是
    //    「头部左侧伸出一根短须」。改成 14.0 后过渡带收到约 14px，前缘干净。
    float headCut = clamp(1.0 + axialT * 14.0, 0.0, 1.0);
    // 横向同时也收窄，让切面是个尖角而不是一刀平的直角
    w *= mix(0.20, 1.0, headCut);
    float cc = perp / max(w, 0.0001);
    // 纵向：四次渐隐，让尾巴真正收成一根丝（二次方在尾部还留得太粗）
    float tail = 1.0 - u;
    float prof = tail * tail * tail * tail * headCut;
    float body = exp(-cc * cc) * prof;

    // 头部亮核：压在拖尾最前锋（along = +hf，即飞行方向最前沿）的一个**小而亮**的点。
    // ⚠️ 横向别给太宽：初版 headW = wMax*0.95，比拖尾头端（wMax*0.62）宽 1.5 倍，
    //    横向剖面在 ±3px 处仍有明显亮度 → 看起来是一颗圆滚滚的珠子，不像流星的尖头。
    //    现在收到与拖尾头端**同宽**（wMax*0.62），纵向 hr 略长一点做出纵向拉伸感，
    //    于是头部是「顺着飞行方向的一点亮」而不是「一颗球」。
    float ha = along - hf;
    float hr = max(uMeteorSize * 0.018, 1.5);
    float headW = max(wMax * 0.62, 0.8);
    float head = exp(-(ha * ha) / (hr * hr) - (perp * perp) / (headW * headW)) * headCut;

    // 头部只给「亮」，不要给「大」：body 已经很细，head 只负责点亮前缘。
    // head 权重略低于 body，避免尖端过曝成一颗白珠。
    float a = clamp(body * 0.90 + head * 0.50, 0.0, 1.0) * vMeteor * uAlpha;
    if (a < 0.004) discard;
    vec3 col = mix(vColor, vec3(1.0), clamp(prof * 0.30 + head * 0.95, 0.0, 1.0));
    // 头部再加一点点亮度增益（0.45 而非 0.7，避免尖端过曝成纯白一颗珠）
    gl_FragColor = vec4(col * (0.95 + head * 0.45), a);
    return;
  }

  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = vColor * vBright;
  col = mix(col, col * 1.3 + vec3(0.05), vEdgeBoost * 0.35);
  col = mix(col, col * 1.2, vRipple * 0.4);
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float nonBlack = 1.0 - keepBlack;
  float dotDist = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float readableRim = smoothstep(0.44, 0.94, dotDist) * (1.0 - smoothstep(0.94, 1.08, dotDist)) * tex.a;
  float outLum = dot(col, vec3(0.299, 0.587, 0.114));
  float lightParticle = smoothstep(0.50, 0.82, outLum) * nonBlack;
  float darkParticle = (1.0 - smoothstep(0.20, 0.50, outLum)) * nonBlack;
  col = mix(col, vec3(0.0), readableRim * lightParticle * 0.38);
  col = mix(col, vec3(1.0), readableRim * darkParticle * 0.20);
  // 星云尘埃带：把粒子本身再压暗一档并轻微偏冷，读成「遮挡在发光气体前面的尘埃」。
  // vDustLane 只在 SPIRAL 预设里非零，其它预设该通道为 0 → 这里是恒等变换，无副作用。
  col = mix(col, col * vec3(0.34, 0.30, 0.42), vDustLane);
  col = clamp(col, vec3(0.0), vec3(1.6));
  gl_FragColor = vec4(col, tex.a * uAlpha * vAlpha);
}
`;

// 泛光层顶点着色器由主着色器**派生**（两份 500 行 GLSL 没法手工同步），
// 派生要打两个补丁：① 声明 uBloomSize ② 把它乘进 gl_PointSize。
//
// ⚠️ 这里踩过一个坑：② 原本是整行字面量匹配 `'gl_PointSize = sz * uPixel * uPointScale;'`。
// 后来往那行加了一个系数（`sz * sizeMul * uPixel * uPointScale`），
// 整行不再逐字相等 → **替换静默失效** → uBloomSize 没被乘进去，
// 泛光层从 2.65× 退化成 1×、粒子失去加色光晕（观感就是「粒子效果都没了」），
// 而 tsc / vitest / vite build 全都不会报错。
//
// 所以现在锚定**结构**（`gl_PointSize = … uPointScale`）而不是整行字面量：
// 以后调整尺寸表达式（再加/减系数）都不会破坏补丁。
// 并且补丁没命中就**直接抛错** —— 宁可启动就报，也不要静默变丑再花一轮排查。
const BLOOM_UNIFORM_ANCHOR = 'uniform float uMouseActive, uPixel, uColorMixT;';

export function deriveBloomVertexShader(src: string): string {
  const withUniform = src.replace(BLOOM_UNIFORM_ANCHOR, 'uniform float uMouseActive, uPixel, uColorMixT, uBloomSize;');
  // 锚定 gl_PointSize 赋值语句里的 uPointScale（语句内只有它一个），在其后追加倍率
  const out = withUniform.replace(/(gl_PointSize\s*=\s*[^;]*?uPointScale)(?![\w])/, '$1 * uBloomSize');
  if (!withUniform.includes('uBloomSize;') || !out.includes('* uBloomSize')) {
    throw new Error(
      '[ParticleStage] 泛光顶点着色器派生失败（补丁未命中）。泛光层的点依赖 uBloomSize 放大 2.65×，' +
        '补丁失效会让它退化成 1×、粒子的加色光晕几乎消失（观感＝粒子效果没了）。' +
        '请检查 VERTEX_SHADER 里 uMouseActive/uPixel/uColorMixT 的声明与 gl_PointSize 赋值是否还在。'
    );
  }
  return out;
}

export const BLOOM_VERTEX_SHADER = deriveBloomVertexShader(VERTEX_SHADER);

export const BLOOM_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uBloomStrength, uPreset;
varying vec3 vColor;
varying vec4 vPack0;
varying vec4 vPack1;
#define vBright    vPack0.x
#define vRipple    vPack0.y
#define vEdgeBoost vPack0.z
#define vAlpha     vPack0.w
#define vSourceLum vPack1.x
#define vMeteor    vPack1.y

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.01) discard;
  float soft = tex.a * tex.a;
  vec3 col = vColor * (0.55 + vBright * 0.62);
  col = mix(col, col + vec3(0.22, 0.18, 0.10), vEdgeBoost * 0.35);
  col = clamp(col, vec3(0.0), vec3(1.8));
  float pulse = 1.0 + vRipple * 0.65;
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float bloomKeep = 1.0 - keepBlack * 0.92;
  // 流星：泛光层会把点放大 2.65×，叠加圆点纹理就成了一坨大光斑。
  // 压掉 92% 只留一点柔和光晕，拖尾本体交给主层画（主层才是长条形）。
  bloomKeep *= 1.0 - vMeteor * 0.92;
  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * pulse * 0.55 * vAlpha * bloomKeep);
}
`;

// ============================================================
//  浮尘层 Shader：星河同款柔光圆点（uDotTex）+ 封面主色染色
//  + 逐粒闪烁 + 低音/节拍律动 + 缓慢漂浮
// ============================================================
export const DUST_VERTEX_SHADER = /* glsl */ `
precision highp float;
uniform float uTime, uBass, uEnergy, uBeat, uPixel, uFlowSpeed, uSize;
uniform vec3 uTintColor;
attribute float aRand;
varying vec3 vColor;
varying float vAlpha;

float hash11(float n){ return fract(sin(n * 78.233) * 43758.5453); }

void main(){
  float t = uTime * uFlowSpeed;
  float rnd = hash11(aRand * 127.1 + 311.7);
  float rnd2 = hash11(aRand * 269.5 + 183.3);

  vec3 pos = position;
  // 缓慢漂浮：各自相位的轻微摆动（近景尘埃悬浮感）
  pos.x += sin(t * 0.09 + rnd * 6.2831) * 1.8;
  pos.y += sin(t * 0.065 + rnd2 * 6.2831) * 1.3;
  pos.z += cos(t * 0.08 + rnd * 4.712) * 1.1;

  // 闪烁（星河粒子的呼吸感）：频率/相位逐粒不同
  float twinkle = 0.5 + 0.5 * sin(t * (0.7 + rnd * 1.6) + rnd2 * 6.2831);
  twinkle = 0.35 + 0.65 * twinkle;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  // 点尺寸：随机基数 × 闪烁调制 × 节拍冲击，透视衰减
  float sz = uSize * (0.6 + rnd2 * 1.1) * (0.75 + twinkle * 0.5) * (1.0 + uBeat * 0.35 + uBass * 0.25);
  gl_PointSize = sz * uPixel * (140.0 / max(1.0, -mvPos.z));

  // 颜色：银白与封面主色逐粒混合（星河的层次感）
  vec3 col = mix(vec3(1.0), uTintColor, 0.35 + rnd * 0.4);
  vColor = col * (0.55 + 0.75 * twinkle + uEnergy * 0.35 + uBeat * 0.3);
  vAlpha = 0.4 + 0.6 * twinkle;
  gl_Position = projectionMatrix * mvPos;
}
`;

export const DUST_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha;
varying vec3 vColor;
varying float vAlpha;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  gl_FragColor = vec4(vColor, tex.a * vAlpha * uAlpha);
}
`;
