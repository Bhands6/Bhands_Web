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
uniform sampler2D uCoverTex, uPrevCoverTex, uEdgeTex, uRippleTex;
uniform int uRippleCount;
uniform vec2 uMouseXY;
uniform vec3 uTintColor;
uniform float uTintStrength;
attribute vec2 aUv;
attribute float aRand;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

#define PI 3.14159265359

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
  //  Preset 6: AURORA — 极光（三层垂直光幕 + 高频火花）
  //  网格用 aUv.y 切成 3 层、层内作为幕高推进；低频抬高幕高，高频驱动闪烁与火花。
  // ====================================================
  else if (uPreset < 6.5) {
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
  else {
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
    // 极光/万花筒/迸发：亮度改由各自的 maxRippleAmp 承担（迸发＝冲击环的相位驱动），
    // 刻意不接 uBeat —— 那是每拍都会跳的量，会让迸发与迸发之间也在闪。
    vBright = 0.94 + maxRippleAmp * 0.72 + uBass * 0.055 + uEnergy * 0.055 + uBurstAmt * 0.26;
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
  if (uPreset > 5.5) {
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
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

// ============================================================
//  片元 Shader（主层：可读性边缘 — 亮粒子描暗边、暗粒子描亮边）
// ============================================================
export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uPreset;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
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
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

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
