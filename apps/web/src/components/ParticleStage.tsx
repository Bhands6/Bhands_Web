import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { usePlayerStore } from '../stores/usePlayerStore';
import {
  useSettingsStore,
  QUALITY_PROFILES,
  EFFECT_PRESET_INDEX,
  ParticleEffect
} from '../stores/useSettingsStore';

/**
 * Three.js 粒子舞台 —— 完整移植桌面版 main.js 的 shader 粒子系统：
 * - 6 种预设（uPreset shader 分支）：0 丝绸 / 1 滚筒隧道 / 2 星球 / 3 虚空 / 4 唱片 / 5 星河壁纸
 * - 封面纹理采样取色（新旧封面 crossfade）+ CPU 端 Sobel 边缘纹理（丝绸轮廓增益）
 * - 涟漪系统：bass 上升沿在 3×3 宫格随机触发 DataTexture 涟漪
 * - 音频包络（attack/release）+ 唱片/壁纸预设专用频段重映射
 * - 双层渲染：NormalBlending 主层 + AdditiveBlending 泛光层
 * - 环绕相机：预设机位 + 鼠标视差 + 电影漂移 + 节拍 FOV 冲击
 * 切换预设不重建场景（只改 uPreset + 相机目标 + 转场脉冲），与桌面版一致。
 */

const PLANE_SIZE = 4.8;
const RIPPLE_MAX = 12;
const BASS_THRESHOLD = 0.3;
const RIPPLE_COOLDOWN = 0.32;
const COVER_TEX_SIZE = 256;
const EDGE_TEX_SIZE = 96;
const BASE_FOV = 45;

/** 每个预设的相机机位（对应桌面版 setPresetCamera 的 radius/phi） */
const PRESET_CAMERA: Record<ParticleEffect, { radius: number; phi: number }> = {
  silk: { radius: 6.6, phi: 0.08 },
  tunnel: { radius: 6.2, phi: 0.03 },
  orbit: { radius: 7.0, phi: 0.15 },
  void: { radius: 8.0, phi: 0.05 },
  vinyl: { radius: 6.5, phi: 0.04 },
  wallpaper: { radius: 6.6, phi: 0.08 }
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ============================================================
//  粒子点纹理（干净圆点，无 glow）
// ============================================================
function makeDotTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0.0, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// ============================================================
//  顶点 Shader（移植桌面版 vs，去掉桌面专属：手势/扭曲/加载雾/深度图）
// ============================================================
const VERTEX_SHADER = /* glsl */ `
precision highp float;
uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;
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
    float ring   = exp(-pow((dist - waveR) / ringW, 2.0));
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
    float border = exp(-pow((d - coverR) / 0.064, 2.0)) * edgeGuard;
    float outerRim = exp(-pow((d - (recordR - 0.050)) / 0.055, 2.0)) * edgeGuard;
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
  else {
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
      float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));
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
  if (uPreset > 4.5) {
    vBright = 1.02 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025;
  } else if (uPreset > 3.5) {
    vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08 + edgeBoost * 0.12 + uEnergy * 0.05 + uBeat * 0.16 + uBurstAmt * 0.16;
  }
  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.5, -mvPos.z);
  float audioBoost = 1.0 + maxRippleAmp * 0.7 + edgeBoost * 0.55 + uBeat * 0.30 + uBurstAmt * 0.5;
  float sz = clamp(depthSize * audioBoost, 1.05, 4.95);
  if (uPreset > 4.5) {
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
const FRAGMENT_SHADER = /* glsl */ `
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

// 泛光层：大点 + 加法混合
const BLOOM_VERTEX_SHADER = VERTEX_SHADER.replace(
  'uniform float uMouseActive, uPixel, uColorMixT;',
  'uniform float uMouseActive, uPixel, uColorMixT, uBloomSize;'
).replace(
  'gl_PointSize = sz * uPixel * uPointScale;',
  'gl_PointSize = sz * uPixel * uPointScale * uBloomSize;'
);

const BLOOM_FRAGMENT_SHADER = /* glsl */ `
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
const DUST_VERTEX_SHADER = /* glsl */ `
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

const DUST_FRAGMENT_SHADER = /* glsl */ `
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

// ============================================================
//  封面粒子几何：grid×grid 网格铺在 PLANE_SIZE 平面，附带 aUv/aRand
// ============================================================
function buildCoverParticleGeometry(grid: number): THREE.BufferGeometry {
  const count = grid * grid;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const rand = new Float32Array(count);
  const texelStep = 1 / grid;
  for (let i = 0; i < count; i++) {
    const gx = i % grid;
    const gy = Math.floor(i / grid);
    const u = (gx + 0.5) * texelStep;
    const v = (gy + 0.5) * texelStep;
    const px = gx / (grid - 1);
    const py = gy / (grid - 1);
    positions[i * 3] = (px - 0.5) * PLANE_SIZE;
    positions[i * 3 + 1] = (py - 0.5) * PLANE_SIZE;
    positions[i * 3 + 2] = 0;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
    rand[i] = Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  return geo;
}

export default function ParticleStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  // 画质档位改变需重建场景；效果形态切换走 store 订阅（不重建，带转场脉冲）
  const renderQuality = useSettingsStore((s) => s.visual.renderQuality);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ---------- 基础场景 ----------
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 100);

    const quality = QUALITY_PROFILES[useSettingsStore.getState().visual.renderQuality];
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const dotTexture = makeDotTexture();

    // ---------- 封面纹理（current/prev crossfade）+ 边缘纹理 ----------
    const coverCanvas = document.createElement('canvas');
    coverCanvas.width = coverCanvas.height = COVER_TEX_SIZE;
    const coverCtx = coverCanvas.getContext('2d')!;
    coverCtx.fillStyle = '#1c1c28';
    coverCtx.fillRect(0, 0, COVER_TEX_SIZE, COVER_TEX_SIZE);
    const coverTex = new THREE.CanvasTexture(coverCanvas);
    coverTex.minFilter = coverTex.magFilter = THREE.LinearFilter;
    coverTex.wrapS = coverTex.wrapT = THREE.ClampToEdgeWrapping;

    const prevCoverCanvas = document.createElement('canvas');
    prevCoverCanvas.width = prevCoverCanvas.height = COVER_TEX_SIZE;
    const prevCoverCtx = prevCoverCanvas.getContext('2d')!;
    prevCoverCtx.fillStyle = '#1c1c28';
    prevCoverCtx.fillRect(0, 0, COVER_TEX_SIZE, COVER_TEX_SIZE);
    const prevCoverTex = new THREE.CanvasTexture(prevCoverCanvas);
    prevCoverTex.minFilter = prevCoverTex.magFilter = THREE.LinearFilter;

    // 边缘纹理：R=depth(占位) G=edge(Sobel) B=fg-mask A=lum
    const edgeCanvas = document.createElement('canvas');
    edgeCanvas.width = edgeCanvas.height = EDGE_TEX_SIZE;
    const edgeCtx = edgeCanvas.getContext('2d')!;
    edgeCtx.fillStyle = 'rgba(128,0,0,255)';
    edgeCtx.fillRect(0, 0, EDGE_TEX_SIZE, EDGE_TEX_SIZE);
    const edgeTex = new THREE.CanvasTexture(edgeCanvas);
    edgeTex.minFilter = edgeTex.magFilter = THREE.LinearFilter;
    edgeTex.wrapS = edgeTex.wrapT = THREE.ClampToEdgeWrapping;

    /** CPU 端 Sobel 边缘检测 → 边缘纹理（丝绸轮廓增益用） */
    const rebuildEdgeTexture = (img: HTMLImageElement) => {
      const S = EDGE_TEX_SIZE;
      edgeCtx.drawImage(img, 0, 0, S, S);
      const src = edgeCtx.getImageData(0, 0, S, S);
      const data = src.data;
      const lum = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) {
        lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      }
      const out = edgeCtx.createImageData(S, S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const gx = lum[y * S + Math.min(x + 1, S - 1)] - lum[y * S + Math.max(x - 1, 0)];
          const gy = lum[Math.min(y + 1, S - 1) * S + x] - lum[Math.max(y - 1, 0) * S + x];
          const edge = Math.min(1, (Math.abs(gx) + Math.abs(gy)) * 2.6);
          out.data[i * 4] = 128;
          out.data[i * 4 + 1] = edge * 255;
          out.data[i * 4 + 2] = lum[i] > 0.35 ? 255 : 0;
          out.data[i * 4 + 3] = lum[i] * 255;
        }
      }
      edgeCtx.putImageData(out, 0, 0);
      edgeTex.needsUpdate = true;
    };

    // ---------- 涟漪数据纹理 ----------
    const rippleData = new Float32Array(RIPPLE_MAX * 4);
    const rippleTex = new THREE.DataTexture(rippleData, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType);
    rippleTex.magFilter = rippleTex.minFilter = THREE.NearestFilter;
    const ripples = Array.from({ length: RIPPLE_MAX }, () => ({ x: 0, y: 0, age: -10, str: 0 }));
    let rippleIdx = 0;
    let lastRippleAt = -10;
    let lastBassRising = false;
    const regions: Array<{ x: number; y: number }> = [];
    for (let ry = 0; ry < 3; ry++) {
      for (let rx = 0; rx < 3; rx++) {
        regions.push({
          x: (rx / 2 - 0.5) * PLANE_SIZE * 0.72,
          y: (ry / 2 - 0.5) * PLANE_SIZE * 0.72
        });
      }
    }

    // ---------- uniforms ----------
    const uniforms: Record<string, THREE.IUniform> = {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uBeat: { value: 0 },
      uEnergy: { value: 0 },
      uBurstAmt: { value: 0 },
      uVinylSpin: { value: 0 },
      uPreset: { value: EFFECT_PRESET_INDEX[useSettingsStore.getState().visual.effect] },
      uIntensity: { value: 0.85 },
      uPointScale: { value: 1.0 },
      uSpeed: { value: 1.0 },
      uColorBoost: { value: 1.1 },
      uCoverRes: { value: 1.0 },
      uHasCover: { value: 0 },
      uEdgeEnabled: { value: 1 },
      uMouseXY: { value: new THREE.Vector2(-999, -999) },
      uMouseActive: { value: 0 },
      uPixel: { value: renderer.getPixelRatio() },
      uColorMixT: { value: 1.0 },
      uTintColor: { value: new THREE.Color('#9db8cf') },
      uTintStrength: { value: 0 },
      uCoverTex: { value: coverTex },
      uPrevCoverTex: { value: prevCoverTex },
      uEdgeTex: { value: edgeTex },
      uRippleTex: { value: rippleTex },
      uRippleCount: { value: 0 },
      uDotTex: { value: dotTexture },
      uAlpha: { value: 0 },
      uBloomStrength: { value: 0.88 },
      uBloomSize: { value: 2.65 }
    };

    // ---------- 双层粒子（泛光层 + 主层，共享几何） ----------
    // 桌面版 coverParticleGridForResolution：奇数网格保证中心对称（118×118 ≈ 1.4 万粒子）
    let grid = Math.round(Math.sqrt(quality.particles));
    if (grid % 2 === 0) grid += 1;
    const geo = buildCoverParticleGeometry(grid);

    const bloomMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: BLOOM_VERTEX_SHADER,
      fragmentShader: BLOOM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    const bloomParticles = new THREE.Points(geo, bloomMaterial);
    bloomParticles.frustumCulled = false;
    bloomParticles.renderOrder = 0;
    scene.add(bloomParticles);

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
    const particles = new THREE.Points(geo, material);
    particles.frustumCulled = false;
    particles.renderOrder = 1;
    scene.add(particles);

    // ---------- 浮尘层（星河同款粒子：柔光圆点 + 封面主色 + 闪烁律动，可在视觉控制台开关） ----------
    const dustCount = quality.dust;
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(dustCount * 3);
    const dustRand = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      dustPos[i * 3] = (Math.random() - 0.5) * 110;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 60;
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * 80 - 10;
      dustRand[i] = Math.random();
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('aRand', new THREE.BufferAttribute(dustRand, 1));
    // 共享主材质的 uTintColor / uPixel uniform 对象：封面取色与像素比更新自动同步
    const dustUniforms = {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uEnergy: { value: 0 },
      uBeat: { value: 0 },
      uFlowSpeed: { value: 1 },
      uSize: { value: 0.9 },
      uAlpha: { value: 0.75 },
      uPixel: uniforms.uPixel,
      uTintColor: uniforms.uTintColor,
      uDotTex: { value: dotTexture }
    };
    const dustMat = new THREE.ShaderMaterial({
      uniforms: dustUniforms,
      vertexShader: DUST_VERTEX_SHADER,
      fragmentShader: DUST_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    dust.frustumCulled = false;
    dust.renderOrder = 2;
    scene.add(dust);

    // ---------- 交互状态 ----------
    let mouseNX = 0, mouseNY = 0;
    let disposed = false;
    let punch = 0;

    // 环绕相机（当前值 → 预设目标值 lerp）
    const orbit = { theta: 0, phi: 0.2, radius: 9.2 };
    const orbitTarget = { ...PRESET_CAMERA[useSettingsStore.getState().visual.effect] };

    const planeZ0 = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    let pointerInside = false;

    const onMouseMove = (e: MouseEvent) => {
      mouseNX = (e.clientX / window.innerWidth) * 2 - 1;
      mouseNY = (e.clientY / window.innerHeight) * 2 - 1;
      pointerInside = true;
    };
    const onMouseLeave = () => {
      pointerInside = false;
      uniforms.uMouseActive.value = 0;
      uniforms.uMouseXY.value.set(-999, -999);
    };
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('mouseleave', onMouseLeave);

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      uniforms.uPixel.value = renderer.getPixelRatio();
    };
    window.addEventListener('resize', onResize);

    // ---------- 封面加载（切歌 crossfade） ----------
    let lastCoverUrl = '';
    let coverLoadToken = 0;

    const loadCover = (url: string) => {
      const token = ++coverLoadToken;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        if (disposed || token !== coverLoadToken) return;
        // prev ← current，然后 current ← 新封面，uColorMixT 从 0 渐变到 1
        prevCoverCtx.drawImage(coverCanvas, 0, 0);
        prevCoverTex.needsUpdate = true;
        coverCtx.drawImage(img, 0, 0, COVER_TEX_SIZE, COVER_TEX_SIZE);
        coverTex.needsUpdate = true;
        rebuildEdgeTexture(img);
        uniforms.uHasCover.value = 1;
        uniforms.uColorMixT.value = 0;
        uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value as number, 0.12);
      };
      img.onerror = () => {
        // 封面加载失败（跨域等）：保持默认渐变色
      };
      img.src = url;
    };

    const checkCover = (url?: string) => {
      if (!url || url === lastCoverUrl) return;
      lastCoverUrl = url;
      loadCover(url);
    };
    checkCover(usePlayerStore.getState().currentTrack?.cover);
    const unsubPlayer = usePlayerStore.subscribe((s) => checkCover(s.currentTrack?.cover));

    // ---------- 效果形态切换（不重建场景，带转场脉冲） ----------
    const unsubSettings = useSettingsStore.subscribe((s) => {
      const idx = EFFECT_PRESET_INDEX[s.visual.effect];
      if (uniforms.uPreset.value !== idx) {
        uniforms.uPreset.value = idx;
        uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value as number, 0.15);
        Object.assign(orbitTarget, PRESET_CAMERA[s.visual.effect]);
      }
    });

    // ---------- 主色（视觉控制台自定义色 / 封面取色 CSS 变量） ----------
    let targetTint = new THREE.Color('#9db8cf');
    const tintTimer = setInterval(() => {
      const css = getComputedStyle(document.documentElement).getPropertyValue('--visual-tint').trim();
      if (css) {
        try {
          targetTint = new THREE.Color(css);
        } catch {
          // 非法色值忽略
        }
      }
    }, 800);

    // ---------- 渲染循环 ----------
    const startTime = performance.now();
    let last = startTime;
    let raf = 0;

    // 音频包络（attack/release，对应桌面版 smoothBass/Mid/Treb/Energy）
    let smoothBass = 0, smoothMid = 0, smoothTreb = 0, smoothEnergy = 0;
    let beatEnv = 0;
    let lastBeatOn = false;
    const env = (prev: number, next: number, attack: number, release: number) =>
      prev + (next - prev) * (next > prev ? attack : release);

    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      if (document.hidden) return;

      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - startTime) / 1000;

      // 视觉设置直读
      const visual = useSettingsStore.getState().visual;

      // ---------- 音频包络 ----------
      const { analyserData, isPlaying } = usePlayerStore.getState();
      const rawBass = analyserData?.bass ?? 0;
      const rawMid = analyserData?.mid ?? 0;
      const rawTreble = analyserData?.treble ?? 0;
      const rawEnergy = analyserData?.energy ?? 0;

      if (isPlaying) {
        smoothBass = env(smoothBass, Math.min(0.82, rawBass * 0.78 + rawEnergy * 0.025), 0.28, 0.075);
        smoothMid = env(smoothMid, Math.min(0.68, rawMid * 0.64 + rawEnergy * 0.025), 0.18, 0.06);
        smoothTreb = env(smoothTreb, Math.min(0.56, rawTreble * 0.54), 0.18, 0.055);
        smoothEnergy = env(smoothEnergy, Math.min(0.72, rawEnergy), 0.16, 0.055);
        // 二值节拍 → 模拟包络（上升沿抬升，指数衰减）
        const rawBeat = analyserData?.beatPulse ?? 0;
        const beatOn = rawBeat > 0.5;
        if (beatOn && !lastBeatOn) beatEnv = Math.min(1, beatEnv + 0.62);
        lastBeatOn = beatOn;
      } else {
        smoothBass *= 0.91; smoothMid *= 0.91; smoothTreb *= 0.91; smoothEnergy *= 0.91;
        lastBeatOn = false;
      }
      beatEnv *= Math.pow(0.36, dt);

      let bass = Math.min(0.9, smoothBass * 1.05 + beatEnv * 0.18) * visual.intensity;
      let mid = Math.min(0.72, smoothMid * 1.12) * visual.intensity;
      let treble = Math.min(0.62, smoothTreb * 1.2) * visual.intensity;
      let beatPulse = beatEnv;
      const audioEnergy = Math.max(smoothEnergy, beatEnv * 0.3);

      // 唱片(4)/壁纸(5)预设专用频段重映射（对应桌面版 fx.preset >= 4 分支）
      const preset = uniforms.uPreset.value as number;
      if (preset >= 4) {
        const wallpaperAudio = preset === 5;
        const ringBass = smoothBass * (wallpaperAudio ? 1.1 : 1.58) + beatEnv * (wallpaperAudio ? 0.18 : 0.42) - smoothMid * 0.16 - smoothTreb * 0.06;
        const ringMid = smoothMid * (wallpaperAudio ? 1.16 : 1.82) - smoothBass * 0.14 - smoothTreb * 0.07;
        const ringTreble = smoothTreb * (wallpaperAudio ? 1.34 : 2.28) - smoothMid * 0.1 - smoothBass * 0.05;
        bass = Math.pow(clamp01((ringBass - 0.05) / 0.58), 0.72) * visual.intensity;
        mid = Math.pow(clamp01((ringMid - 0.045) / 0.46), 0.78) * visual.intensity;
        treble = Math.pow(clamp01((ringTreble - 0.03) / 0.34), 0.84) * visual.intensity;
        if (wallpaperAudio) {
          bass = Math.min(bass, 0.46 * visual.intensity);
          mid = Math.min(mid, 0.4 * visual.intensity);
          treble = Math.min(treble, 0.36 * visual.intensity);
          beatPulse *= 0.34;
        }
      }

      // ---------- uniforms ----------
      uniforms.uTime.value = t;
      uniforms.uBass.value = bass;
      uniforms.uMid.value = mid;
      uniforms.uTreble.value = treble;
      uniforms.uBeat.value = beatPulse;
      uniforms.uEnergy.value = audioEnergy;
      uniforms.uIntensity.value = visual.intensity;
      // 粒子尺寸：设置值 × 1.3 全局增益（对齐桌面版长期使用调大 point 的观感，面积放大 ~1.7 倍）
      uniforms.uPointScale.value = visual.particleSize * 1.3;
      uniforms.uSpeed.value = visual.flowSpeed;
      uniforms.uBurstAmt.value = (uniforms.uBurstAmt.value as number) * 0.9;

      // 唱片自转
      const spinMul = Math.max(0.05, visual.flowSpeed);
      uniforms.uVinylSpin.value =
        ((uniforms.uVinylSpin.value as number) + dt * (0.4 + smoothBass * 0.09) * spinMul) % (Math.PI * 2);

      // 封面 crossfade 推进 + 整体 fade-in（桌面版 920ms tween 节奏）
      if ((uniforms.uColorMixT.value as number) < 1) {
        uniforms.uColorMixT.value = Math.min(1, (uniforms.uColorMixT.value as number) + dt * 1.2);
      }
      uniforms.uAlpha.value += (0.96 - (uniforms.uAlpha.value as number)) * Math.min(1, dt * 2.2);

      // 主色：auto=封面原色（tint 0）/ custom=自定义色染色
      (uniforms.uTintColor.value as THREE.Color).lerp(targetTint, 0.03);
      uniforms.uTintStrength.value = visual.tintMode === 'custom' ? 0.85 : 0;

      // ---------- 涟漪（bass 上升沿触发） ----------
      const isBassHit = bass > BASS_THRESHOLD && !lastBassRising;
      lastBassRising = bass > BASS_THRESHOLD * 0.75;
      if (isBassHit && t - lastRippleAt > RIPPLE_COOLDOWN) {
        lastRippleAt = t;
        const count = 2 + (Math.random() < 0.5 ? 0 : 1);
        const used: Record<number, boolean> = {};
        for (let k = 0; k < count; k++) {
          let idx = 0, tries = 0;
          do {
            idx = Math.floor(Math.random() * 9);
            tries++;
          } while (used[idx] && tries < 12);
          used[idx] = true;
          const reg = regions[idx];
          const r = ripples[rippleIdx];
          r.x = reg.x + (Math.random() - 0.5) * 0.7;
          r.y = reg.y + (Math.random() - 0.5) * 0.7;
          r.age = 0;
          r.str = 0.65 + bass * 1.4 + Math.random() * 0.25;
          rippleIdx = (rippleIdx + 1) % RIPPLE_MAX;
        }
      }
      let activeRipples = 0;
      for (let i = 0; i < RIPPLE_MAX; i++) {
        const r = ripples[i];
        if (r.str > 0.005) {
          r.age += dt;
          if (r.age > 2.0) {
            r.str = 0;
            r.age = -10;
          } else {
            activeRipples++;
          }
        }
        const off = i * 4;
        rippleData[off] = r.x;
        rippleData[off + 1] = r.y;
        rippleData[off + 2] = r.age;
        rippleData[off + 3] = r.str;
      }
      rippleTex.needsUpdate = true;
      uniforms.uRippleCount.value = activeRipples;

      // ---------- 相机：预设机位 + 鼠标视差 + 电影漂移 + 节拍冲击 ----------
      const targetTheta = mouseNX * 0.1 + Math.sin(t * 0.05) * 0.05;
      const targetPhi = orbitTarget.phi - mouseNY * 0.06 + Math.sin(t * 0.041) * 0.02;
      orbit.theta += (targetTheta - orbit.theta) * 0.05;
      orbit.phi += (targetPhi - orbit.phi) * 0.06;
      orbit.radius += (orbitTarget.radius - orbit.radius) * 0.045;

      const beatKick = beatPulse * 0.9;
      punch += (beatKick - punch) * (beatKick > punch ? 0.35 : 0.08);
      const radius = orbit.radius - punch * 0.1;
      const cy = Math.cos(orbit.phi), sy = Math.sin(orbit.phi);
      const ct = Math.cos(orbit.theta), st = Math.sin(orbit.theta);
      camera.position.set(radius * cy * st, radius * sy, radius * cy * ct);
      camera.lookAt(0, 0, 0);
      const targetFov = BASE_FOV - punch * 2.35;
      camera.fov += (targetFov - camera.fov) * (targetFov < camera.fov ? 0.24 : 0.12);
      camera.updateProjectionMatrix();

      // ---------- 鼠标世界坐标（仅丝绸预设推开粒子） ----------
      if (preset === 0 && pointerInside) {
        ndc.set(mouseNX, -mouseNY);
        raycaster.setFromCamera(ndc, camera);
        if (raycaster.ray.intersectPlane(planeZ0, hitPoint)) {
          uniforms.uMouseXY.value.set(hitPoint.x, hitPoint.y);
          uniforms.uMouseActive.value = 1;
        } else {
          uniforms.uMouseActive.value = 0;
        }
      } else {
        uniforms.uMouseActive.value = 0;
      }

      // ---------- 浮尘层（星河同款：音频律动驱动亮度/尺寸） ----------
      dust.visible = visual.dustLayer;
      dust.rotation.y += 0.02 * visual.flowSpeed * dt;
      dustUniforms.uTime.value = t;
      dustUniforms.uBass.value = bass;
      dustUniforms.uEnergy.value = audioEnergy;
      dustUniforms.uBeat.value = beatPulse;
      dustUniforms.uFlowSpeed.value = Math.max(0.25, visual.flowSpeed * 0.55);
      dustUniforms.uSize.value = 0.85 * visual.particleSize;
      dustUniforms.uAlpha.value = 0.5 + audioEnergy * 0.42 * visual.intensity;

      renderer.render(scene, camera);
    };
    animate();

    console.log(`[particles] desktop shader stage ready, grid=${grid}x${grid}, preset=${uniforms.uPreset.value}`);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(tintTimer);
      unsubPlayer();
      unsubSettings();
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('resize', onResize);
      geo.dispose();
      material.dispose();
      bloomMaterial.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      coverTex.dispose();
      prevCoverTex.dispose();
      edgeTex.dispose();
      rippleTex.dispose();
      dotTexture.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [renderQuality]);

  return <div id="canvas-container" ref={containerRef} />;
}
