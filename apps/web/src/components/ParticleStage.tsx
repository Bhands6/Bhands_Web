import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { usePlayerStore } from '../stores/usePlayerStore';
import {
  useSettingsStore,
  QUALITY_PROFILES,
  EFFECT_PRESET_INDEX,
  ParticleEffect
} from '../stores/useSettingsStore';
import {
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  BLOOM_VERTEX_SHADER,
  BLOOM_FRAGMENT_SHADER,
  DUST_VERTEX_SHADER,
  DUST_FRAGMENT_SHADER
} from './particleShaders';


/**
 * Three.js 粒子舞台 —— 完整移植桌面版 main.js 的 shader 粒子系统：
 * - 11 种预设（uPreset shader 分支）：0 丝绸 / 1 滚筒隧道 / 2 星球 / 3 虚空 / 4 唱片 / 5 星河壁纸
 *   ／ 6 极光 / 7 万花筒 / 8 迸发（换歌爆一次，之后常驻：匀速缓慢自转 + 整片上下浮动）
 *   ／ 9 声波地形（随音乐起伏的山脊 + 推进扫描波前）/ 10 螺旋星云（双旋臂 + 中心核球）
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
/**
 * 流星拖尾长度 = 渲染缓冲高度的这个比例，并设像素上限。
 * 它同时就是点精灵的边长 —— 精灵是正方形、面积按平方涨，所以别随手调大：
 * 0.34 × 900px ≈ 306px 的点，5 颗同时在场也只有约 47 万片元（现代 GPU 无压力）。
 *
 * ⚠️ 注意片元里拖尾的实际长度只取这个边长的 0.82 倍：点精灵是正方形，
 *    拖尾斜着穿过时若铺满整块方框，两端会被方框硬裁掉（表现为断头断尾）。
 *    留出的余量就是给这个用的。想调拖尾长短改 **片元里的 0.82**，不是改这里。
 */
const METEOR_TRAIL_RATIO = 0.34;
/**
 * 拖尾长度的硬上限（像素）。**这个值必须由硬件决定，不能拍脑袋**：
 * gl_PointSize 会被驱动静默夹到 ALIASED_POINT_SIZE_RANGE 的 max，
 * 桌面 GL 常见 255、部分移动 GPU 只有 63/64。写死了 420 的话，
 * 1080p 屏算出 280px 就被悄悄截断，拖尾长度与预期不符。
 * 所以这里只作兜底，真实上限在 syncPixelUniforms 里用 gl.getParameter 查询。
 */
const METEOR_TRAIL_MAX_PX = 420;

/** 每个预设的相机机位（对应桌面版 setPresetCamera 的 radius/phi）
 *  可见范围 ≈ radius 处 FOV45 的取景框：纵向 ±radius*0.414，横向再乘宽高比。
 *  新增的极光/万花筒/迸发几何尺寸都是按这里的半径配的，改半径要同时改几何尺寸。 */
const PRESET_CAMERA: Record<ParticleEffect, { radius: number; phi: number }> = {
  silk: { radius: 6.6, phi: 0.08 },
  tunnel: { radius: 6.2, phi: 0.03 },
  orbit: { radius: 7.0, phi: 0.15 },
  void: { radius: 8.0, phi: 0.05 },
  vinyl: { radius: 6.5, phi: 0.04 },
  wallpaper: { radius: 6.6, phi: 0.08 },
  aurora: { radius: 8.4, phi: 0.05 },
  kaleido: { radius: 6.8, phi: 0.07 },
  burst: { radius: 6.6, phi: 0.06 },
  // 声波地形：贴地看才读得出「地形」——phi 大一点俯视、半径拉远容纳 13×9 的地块
  sonic: { radius: 9.2, phi: 0.30 },
  // 螺旋星云：要能看见整个盘面（半径 5.4 + 外缘），略俯视让盘有厚度
  spiral: { radius: 10.5, phi: 0.34 }
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
      uBurstAge: { value: 0 },
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
      // 流星：uResolution 必须是**渲染缓冲**像素尺寸（片元里用 gl_FragCoord 算拖尾，
      // 两者必须同系）；uMeteorSize 就是拖尾长度，也是点精灵的边长。
      uResolution: { value: new THREE.Vector2(1, 1) },
      uMeteorSize: { value: 240 },
      uGrid: { value: 118 },
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

    /**
     * 同步「像素相关」的 uniform。流星的拖尾是在片元里用 gl_FragCoord（窗口像素）
     * 算的，所以分辨率和拖尾长度都必须取**渲染缓冲**的像素尺寸，而不是 CSS 像素，
     * 否则高 DPI 屏上拖尾会被挤短一半。
     *
     * 拖尾长度还要夹到硬件的点精灵尺寸上限：gl_PointSize 超上限会被驱动**静默截断**，
     * 那会让拖尾长度在不同机器上不一致（而且点精灵是正方形，边长被截断时拖尾也跟着变短）。
     * 所以这里查一次 ALIASED_POINT_SIZE_RANGE，用它和 METEOR_TRAIL_MAX_PX 里更小的那个。
     */
    const dbSize = new THREE.Vector2();
    const pointSizeRange = renderer.getContext().getParameter(0x846D /* ALIASED_POINT_SIZE_RANGE */) as
      | Float32Array
      | null;
    const maxPointSize = Math.max(
      64,
      Math.min(METEOR_TRAIL_MAX_PX, pointSizeRange && pointSizeRange.length > 1 ? pointSizeRange[1] : 255)
    );
    const syncPixelUniforms = () => {
      renderer.getDrawingBufferSize(dbSize);
      uniforms.uResolution.value.copy(dbSize);
      uniforms.uPixel.value = renderer.getPixelRatio();
      uniforms.uMeteorSize.value = Math.min(dbSize.y * METEOR_TRAIL_RATIO, maxPointSize);
    };

    // ---------- 双层粒子（泛光层 + 主层，共享几何） ----------
    // 桌面版 coverParticleGridForResolution：奇数网格保证中心对称（118×118 ≈ 1.4 万粒子）
    let grid = Math.round(Math.sqrt(quality.particles));
    if (grid % 2 === 0) grid += 1;
    uniforms.uGrid.value = grid;   // 着色器靠它把 aUv 还原成连续编号，前 5 个做流星槽位
    syncPixelUniforms();
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

    /**
     * ⚠️ 着色器编译自检（诊断用，别删）。
     *
     * GLSL 只在浏览器里真正编译，失败时 three 只会往 Console 丢一句
     * `THREE.WebGLProgram: Shader Error … Vertex shader is not compiled.`（**不含行号**），
     * 或者干脆把整个 Points 静默跳过 —— 表现就是「所有粒子都没效果了」，
     * 而 tsc / vitest / oxlint / vite build / 所有静态检查工具**全绿**。
     * 最常见的两类原因都没法在构建期发现：
     *   ① varying 槽位超限（GLSL ES 1.00 只保证 8，ANGLE/D3D11 恰好就是 8）
     *   ② gl_PointSize 超出 ALIASED_POINT_SIZE_RANGE（会被静默夹取）
     *
     * 这里做两件事：
     *  1. 打印渲染环境（真 GPU 名称 + varying 上限 + 点精灵上限）
     *  2. 把 three 已经编译好的 program 里带的 **原始 info log** 打出来（含行号），
     *     这样出错时不用再靠猜，直接能定位到是哪一行。
     */
    const reportShaderHealth = () => {
      const gl = renderer.getContext();
      const glRenderer = gl.getExtension('WEBGL_debug_renderer_info');
      const info = {
        渲染器: glRenderer ? gl.getParameter(glRenderer.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        最大varying槽位: gl.getParameter(gl.MAX_VARYING_VECTORS),
        点精灵尺寸范围: Array.from(gl.getParameter(0x846D) as Float32Array),
        实际拖尾尺寸: uniforms.uMeteorSize.value,
        网格: uniforms.uGrid.value
      };
      console.log('[particles] 渲染环境自检', info);

      // 强制 three 立刻编译这两个材质（renderer.compile 会把它们真正送进驱动）
      try {
        renderer.compile(scene, camera);
      } catch (err) {
        console.error('[particles] renderer.compile 抛错:', err);
      }

      /**
       * 从 three 已编译的 program 里取原始日志。
       * three r150+ 把编译诊断挂在 program.diagnostics 上；更早的版本要读
       * gl.getShaderInfoLog，而那时 shader 句柄已经被 three 删掉了 —— 所以
       * 这里优先读 diagnostics，取不到就退回「自己再编一遍」但**带上 three 的前缀**。
       */
      const prefixVertex =
        'precision highp float;\nprecision highp int;\n' +
        'attribute vec3 position;\nattribute vec3 normal;\nattribute vec2 uv;\n' +
        'uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\n' +
        'uniform mat4 viewMatrix;\nuniform mat3 normalMatrix;\nuniform vec3 cameraPosition;\n' +
        'uniform bool isOrthographic;\n';
      const prefixFragment =
        'precision highp float;\nprecision highp int;\n' +
        'uniform mat4 viewMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\n';

      const compileAndReport = (label: string, type: number, source: string) => {
        const sh = gl.createShader(type);
        if (!sh) return true;
        gl.shaderSource(sh, source);
        gl.compileShader(sh);
        const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean;
        if (!ok) {
          const log = (gl.getShaderInfoLog(sh) || '(驱动未提供日志，这本身就是问题信号)').trim();
          console.error(
            `[particles] ❌ ${label}编译失败 —— 这就是「粒子全没了」的直接原因\n` +
              `--- 驱动原始日志 ---\n${log}\n--------------------\n` +
              `环境: ${JSON.stringify(info)}`
          );
        }
        gl.deleteShader(sh);
        return ok;
      };
      const vsOk = compileAndReport('顶点着色器', gl.VERTEX_SHADER, prefixVertex + VERTEX_SHADER);
      const fsOk = compileAndReport('片元着色器', gl.FRAGMENT_SHADER, prefixFragment + FRAGMENT_SHADER);
      const bvsOk = compileAndReport('泛光顶点着色器', gl.VERTEX_SHADER, prefixVertex + BLOOM_VERTEX_SHADER);
      const bfsOk = compileAndReport('泛光片元着色器', gl.FRAGMENT_SHADER, prefixFragment + BLOOM_FRAGMENT_SHADER);
      if (vsOk && fsOk && bvsOk && bfsOk) {
        console.log('[particles] 四个着色器全部编译通过 ✅');
      }
      if (info.点精灵尺寸范围[1] < uniforms.uMeteorSize.value) {
        console.warn(
          `[particles] 拖尾尺寸 ${uniforms.uMeteorSize.value}px 超过了驱动的点精灵上限 ` +
            `${info.点精灵尺寸范围[1]}px，会被夹取。`
        );
      }
    };
    reportShaderHealth();

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
      syncPixelUniforms();
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
        uniforms.uEdgeEnabled.value = 1;
        uniforms.uColorMixT.value = 0;
        uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value as number, 0.12);
      };
      img.onerror = () => {
        // 封面加载失败（跨域等）：保持默认渐变色
      };
      img.src = url;
    };

    const clearCover = () => {
      lastCoverUrl = '';
      coverCtx.fillStyle = '#1c1c28';
      coverCtx.fillRect(0, 0, COVER_TEX_SIZE, COVER_TEX_SIZE);
      coverTex.needsUpdate = true;
      prevCoverCtx.fillStyle = '#1c1c28';
      prevCoverCtx.fillRect(0, 0, COVER_TEX_SIZE, COVER_TEX_SIZE);
      prevCoverTex.needsUpdate = true;
      edgeCtx.fillStyle = 'rgba(128,0,0,255)';
      edgeCtx.fillRect(0, 0, EDGE_TEX_SIZE, EDGE_TEX_SIZE);
      edgeTex.needsUpdate = true;
      uniforms.uHasCover.value = 0;
      uniforms.uEdgeEnabled.value = 0;
      uniforms.uColorMixT.value = 1;
    };

    const checkCover = (url?: string) => {
      if (!url) {
        if (lastCoverUrl) clearCover();
        return;
      }
      if (url === lastCoverUrl) return;
      lastCoverUrl = url;
      loadCover(url);
    };
    /**
     * 迸发预设：`uBurstAge` = 距本次迸发开始的秒数，**只在切歌时归零**。
     * 迸发不再由节拍触发 —— 一次爆开结束后粒子常驻（匀速自转 + 整片上下平移），
     * 直到下一首歌再爆一次。
     */
    let burstAt = 0;
    /** 切歌时置位，由 animate 在下一帧消费（store 订阅回调里拿不到 rAF 的 t） */
    let burstRequested = true;

    // 切歌订阅：换封面 + 请求一次迸发（迸发预设每次换歌爆一次）
    checkCover(usePlayerStore.getState().currentTrack?.cover);
    let lastTrackId = usePlayerStore.getState().currentTrack?.id ?? null;
    if (!lastTrackId) burstRequested = false;
    const unsubPlayer = usePlayerStore.subscribe((s) => {
      checkCover(s.currentTrack?.cover);
      const id = s.currentTrack?.id ?? null;
      if (id !== lastTrackId) {
        lastTrackId = id;
        if (id) burstRequested = true;
      }
    });

    // ---------- 效果形态切换（不重建场景，带转场脉冲） ----------
    const unsubSettings = useSettingsStore.subscribe((s) => {
      const idx = EFFECT_PRESET_INDEX[s.visual.effect];
      if (uniforms.uPreset.value !== idx) {
        uniforms.uPreset.value = idx;
        uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value as number, 0.15);
        Object.assign(orbitTarget, PRESET_CAMERA[s.visual.effect]);
        // 切到迸发效果时立刻爆一次，否则要等下一首歌才看得到
        if (s.visual.effect === 'burst') burstRequested = true;
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
        if (beatOn && !lastBeatOn) {
          // 强拍抬得更高，让极光/万花筒与相机冲击在强拍上更明显（迸发已不接节拍位置）
          beatEnv = Math.min(1, beatEnv + ((analyserData?.beatStrong ?? false) ? 0.9 : 0.62));
        }
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
      // 极光(6)/万花筒(7)/迸发(8)/声波地形(9)/螺旋星云(10)：不走唱片式的频段重映射，
      // 给一份手感更直接的分量，再按各自侧重微调（极光偏高、万花筒偏中、
      // 声波地形偏低频——地形起伏主要靠鼓点、星云偏中频——臂的亮度）。
      // 迸发不再放大 beatPulse —— 那会让相机的拍点冲击在每次鼓点都顶一下，
      // 和「迸发之间应该安静下来」冲突。
      if (preset > 5.5) {
        bass = Math.pow(clamp01((smoothBass - 0.05) / 0.55), 0.80) * visual.intensity;
        mid = Math.pow(clamp01((smoothMid - 0.04) / 0.45), 0.82) * visual.intensity;
        treble = Math.pow(clamp01((smoothTreb - 0.02) / 0.30), 0.78) * visual.intensity;
        if (preset < 6.5) mid = Math.min(0.9, mid * 1.15);
        else if (preset < 7.5) treble = Math.min(0.85, treble * 1.12);
        else if (preset > 8.5 && preset < 9.5) {
          // 声波地形：抬低音（地面鼓起）、压高音（避免细砂砾闪得比山脊还亮）
          bass = Math.min(1.0, bass * 1.32);
          treble = Math.min(0.72, treble * 0.82);
        } else if (preset > 9.5) {
          // 螺旋星云：抬中音（旋臂亮度）、压低音（盘面不要随鼓点整体浮动）
          mid = Math.min(1.0, mid * 1.26);
          bass = Math.min(0.62, bass * 0.84);
        }
      } else if (preset >= 4) {
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
      // 迸发相位：切歌时归零，之后一直增长（不回绕，粒子不会重新爆开）
      if (burstRequested) {
        burstAt = t;
        burstRequested = false;
      }
      uniforms.uBurstAge.value = t - burstAt;
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
