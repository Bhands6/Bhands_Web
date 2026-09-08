import { useEffect, useRef } from 'react';

/**
 * 桌面版同款启动页背景动画（移植自 desktop main.js）：
 * - WebGL 单三角形全屏着色器：三色光带环绕 + 流动隧道 + 扫描线 + 颗粒噪声（GPU 渲染，流畅）
 * - 双画布 + 三重自愈：WebGL 初始化失败 / 上下文丢失 / 帧率过低（软件渲染）时，
 *   自动切换到独立 2D 画布（尘埃粒子 + 流光 + 中央光缝），背景永远有动画
 * 组件随启动页挂载/卸载，自动跟随窗口尺寸。
 */

interface SplashDust { x: number; y: number; vx: number; vy: number; r: number; a: number; p: number }
interface SplashStreak { x: number; y: number; len: number; width: number; speed: number; angle: number; phase: number; color: string; delay: number; alpha: number }
interface SplashShard { ox: number; oy: number; w: number; h: number; skew: number; phase: number; color: string; alpha: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / Math.max(0.0001, e1 - e0));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

export default function SplashCanvas() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const fbRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const glCanvas = glRef.current;
    const fbCanvas = fbRef.current;
    if (!glCanvas || !fbCanvas) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let startedAt = performance.now();
    let raf = 0;
    let disposed = false;
    // 当前承载动画的画布：默认 WebGL 画布，自愈切换后指向 2D 画布
    let host: HTMLCanvasElement = glCanvas;

    // ---------- WebGL 着色器（桌面版 initBhandsMusicSplashWebgl 同源） ----------
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let aPos = 0;
    let uRes: WebGLUniformLocation | null = null;
    let uTime: WebGLUniformLocation | null = null;

    const vertexSource = [
      'attribute vec2 aPosition;',
      'varying vec2 vUv;',
      'void main(){',
      '  vUv = aPosition * 0.5 + 0.5;',
      '  gl_Position = vec4(aPosition, 0.0, 1.0);',
      '}'
    ].join('\n');

    const fragmentSource = [
      'precision highp float;',
      'varying vec2 vUv;',
      'uniform vec2 uResolution;',
      'uniform float uTime;',
      '',
      'float saturate(float v){ return clamp(v, 0.0, 1.0); }',
      'float ease(float v){ v = saturate(v); return v * v * (3.0 - 2.0 * v); }',
      'mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
      'float noise(vec2 p){',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(hash(i), hash(i + vec2(1.0,0.0)), u.x), mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);',
      '}',
      '',
      'float animatedLoop(vec2 uv, float t, float channel){',
      '  vec2 q = uv;',
      '  q *= rot(0.28 + sin(t * 0.18) * 0.12);',
      '  q.x += 0.055 * sin(t * 0.30 + channel);',
      '  q.y += 0.040 * cos(t * 0.24 + channel * 1.7);',
      '  float ang = atan(q.y, q.x);',
      '  float angularShift = sin(ang * 3.0 + t * 0.72 + channel * 1.9) * 0.078;',
      '  angularShift += sin(ang * 7.0 - t * 0.54 + channel) * 0.020;',
      '  float neonD = length(q) + angularShift;',
      '  float warpD = length(q * vec2(1.34 + 0.06 * sin(t * 0.25), 0.82 + 0.04 * cos(t * 0.31)));',
      '  warpD += 0.026 * sin(q.x * 4.4 + t * 0.62) + 0.018 * sin(q.y * 5.2 - t * 0.45);',
      '  float diamondD = abs(q.x) * 1.20 + abs(q.y) * 0.84;',
      '  float d = mix(warpD, diamondD, 0.32);',
      '  d = mix(d, neonD, 0.20 + 0.04 * sin(t * 0.18 + channel));',
      '  float pattern = mod((q.x + q.y) * 0.62 + sin(q.x * 5.5 + t) * 0.015 + sin(q.y * 7.0 - t * 0.75) * 0.012, 0.20);',
      '  float acc = 0.0;',
      '  for (int i = 1; i <= 6; i++) {',
      '    float fi = float(i);',
      '    float f = fract(t * 0.152 - channel * 0.018 + 0.011 * fi) * 4.70 - d + pattern;',
      '    acc += 0.00110 * fi * fi / max(abs(f), 0.0065);',
      '  }',
      '  float threadCoord = q.x * 0.92 - q.y * 0.58 + 0.030 * sin(q.x * 5.2 + t * 0.72);',
      '  float threadLines = 0.0065 / max(abs(sin((threadCoord + t * 0.10 + channel * 0.035) * 27.0)), 0.070);',
      '  acc += threadLines * (0.50 + 0.30 * sin(ang * 1.2 + t + channel));',
      '  return min(acc, 1.95);',
      '}',
      '',
      'void main(){',
      '  vec2 p = vUv * 2.0 - 1.0;',
      '  p.x *= uResolution.x / max(uResolution.y, 1.0);',
      '  float t = uTime;',
      '  float intro = ease(t / 0.72);',
      '  float bloomIn = ease((t - 0.10) / 1.10);',
      '  float climax = exp(-pow((t - 3.62) / 0.58, 2.0));',
      '  float preClimax = ease((t - 2.15) / 1.25) * (1.0 - ease((t - 3.86) / 0.72));',
      '  float afterglow = exp(-pow((t - 4.14) / 0.62, 2.0));',
      '  float calm = 1.0 - 0.22 * ease((t - 4.75) / 0.70);',
      '  float settle = 1.0 - 0.34 * ease((t - 5.05) / 0.52);',
      '  vec2 uv = p * (0.98 + 0.05 * sin(t * 0.25));',
      '  uv += vec2(0.0, -0.025);',
      '  vec2 flowAxis = normalize(vec2(0.86, -0.50));',
      '  vec2 crossAxis = vec2(-flowAxis.y, flowAxis.x);',
      '  float lane = dot(p, flowAxis);',
      '  float crossLane = dot(p, crossAxis);',
      '  float syncWave = sin(crossLane * 5.4 + lane * 1.1 - t * 1.85);',
      '  uv += flowAxis * syncWave * 0.055 * climax;',
      '  uv += crossAxis * sin(lane * 7.2 + t * 1.25) * 0.034 * climax;',
      '  uv *= 1.0 + 0.045 * preClimax - 0.020 * climax;',
      '  vec3 ch1 = vec3(1.00, 0.13, 0.31);',
      '  vec3 ch2 = vec3(0.16, 1.00, 0.86);',
      '  vec3 ch3 = vec3(1.00, 0.76, 0.28);',
      '  float a = animatedLoop(uv, t, 0.0);',
      '  float b = animatedLoop(uv * 1.018 + vec2(0.012, -0.008), t + 0.18, 1.0);',
      '  float c = animatedLoop(uv * 0.986 + vec2(-0.010, 0.010), t + 0.35, 2.0);',
      '  vec3 loopCol = ch1 * a + ch2 * b + ch3 * c;',
      '  float tunnel = animatedLoop(uv * 1.42 + vec2(sin(t * 0.2) * 0.08, cos(t * 0.17) * 0.05), t * 1.12 + 1.7, 2.7);',
      '  loopCol += mix(ch2, ch3, 0.35 + 0.25 * sin(t)) * tunnel * (0.30 + 0.24 * preClimax);',
      '  float syncBand = exp(-pow((lane + 0.08 * sin(t * 0.72)) / 0.62, 2.0));',
      '  float phaseThread = pow(0.5 + 0.5 * sin(crossLane * 13.5 + lane * 2.2 - t * 3.1), 8.0);',
      '  float phaseThread2 = pow(0.5 + 0.5 * sin(crossLane * 9.0 - lane * 5.4 + t * 2.4), 10.0);',
      '  vec3 climaxCol = (mix(ch2, ch3, 0.36) * phaseThread + ch1 * phaseThread2 * 0.52) * syncBand * climax;',
      '  float afterBand = exp(-pow((lane - 0.34) / 0.72, 2.0));',
      '  climaxCol += mix(ch1, ch2, vUv.x) * afterBand * afterglow * 0.13;',
      '  float centerBeam = exp(-abs(p.y + 0.005 * sin(t * 3.0)) * 24.0) * (0.14 + 0.52 * exp(-pow((t - 0.74) / 0.34, 2.0)));',
      '  float bladeMask = smoothstep(-1.55, -0.08, p.x) * (1.0 - smoothstep(0.08, 1.55, p.x));',
      '  vec3 blade = mix(ch1, ch2, vUv.x) * centerBeam * bladeMask * (0.40 + 0.28 * climax);',
      '  float flare = exp(-dot(p, p) * 3.6) * exp(-pow((t - 0.88) / 0.40, 2.0));',
      '  vec3 col = vec3(0.002, 0.004, 0.005);',
      '  col += loopCol * (0.56 + 0.46 * bloomIn) * calm * settle;',
      '  col += climaxCol * 0.22;',
      '  float diagonalGlint = exp(-pow(lane * 1.2 + crossLane * 0.10, 2.0) / 0.030) * climax;',
      '  col += blade + vec3(1.0, 0.78, 0.42) * flare * 0.18 + vec3(1.0, 0.86, 0.58) * diagonalGlint * 0.07;',
      '  float scan = 0.92 + 0.08 * sin((vUv.y * uResolution.y + t * 52.0) * 0.72);',
      '  float grain = noise(vUv * uResolution.xy * 0.52 + t * 17.0) - 0.5;',
      '  col *= scan;',
      '  col += grain * 0.018;',
      '  col *= intro;',
      '  col = max(col - vec3(0.010, 0.012, 0.012), 0.0);',
      '  col = vec3(1.0) - exp(-max(col, 0.0) * (0.62 + 0.18 * climax));',
      '  float vignette = smoothstep(1.52, 0.20, length(p * vec2(0.78, 1.04)));',
      '  col *= 0.38 + 0.86 * vignette;',
      '  col += vec3(0.020, 0.010, 0.014) * (1.0 - vignette);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n');

    // 上下文属性与桌面版逐项一致。刻意不加 desynchronized 等额外标志：
    // 部分 Windows 驱动上 desynchronized 会导致"画布在渲染但合成器不更新"的画面冻结。
    const setupWebgl = (target: HTMLCanvasElement): boolean => {
      let ctx: WebGLRenderingContext | null = null;
      try {
        ctx = target.getContext('webgl', {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance'
        }) as WebGLRenderingContext | null;
      } catch {
        ctx = null;
      }
      if (!ctx) return false;

      const compile = (type: number, source: string): WebGLShader | null => {
        const shader = ctx!.createShader(type)!;
        ctx!.shaderSource(shader, source);
        ctx!.compileShader(shader);
        if (!ctx!.getShaderParameter(shader, ctx!.COMPILE_STATUS)) {
          console.warn('[splash] shader compile failed:', ctx!.getShaderInfoLog(shader));
          ctx!.deleteShader(shader);
          return null;
        }
        return shader;
      };

      const vs = compile(ctx.VERTEX_SHADER, vertexSource);
      const fs = compile(ctx.FRAGMENT_SHADER, fragmentSource);
      if (!vs || !fs || !ctx) return false;

      const prog = ctx.createProgram()!;
      ctx.attachShader(prog, vs);
      ctx.attachShader(prog, fs);
      ctx.linkProgram(prog);
      ctx.deleteShader(vs);
      ctx.deleteShader(fs);
      if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
        console.warn('[splash] program link failed:', ctx.getProgramInfoLog(prog));
        ctx.deleteProgram(prog);
        return false;
      }

      const buf = ctx.createBuffer()!;
      ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
      ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
      const pos = ctx.getAttribLocation(prog, 'aPosition');
      const res = ctx.getUniformLocation(prog, 'uResolution');
      const time = ctx.getUniformLocation(prog, 'uTime');
      if (pos < 0 || !res || !time) return false;

      ctx.disable(ctx.DEPTH_TEST);
      ctx.disable(ctx.CULL_FACE);
      // 全链路成功才提交闭包状态
      gl = ctx;
      program = prog;
      buffer = buf;
      aPos = pos;
      uRes = res;
      uTime = time;
      return true;
    };

    // ---------- 2D 兜底粒子（桌面版 drawBhandsMusicSplash 同源） ----------
    let ctx2d: CanvasRenderingContext2D | null = null;
    let w = 0;
    let h = 0;
    let pixelRatio = 1;

    // WebGL 自适应分辨率：按实测帧耗时动态增减渲染倍率（初始 1.25，下限 0.62）
    let renderScale = Math.min(1.25, Math.max(1, window.devicePixelRatio || 1));
    const maxScale = renderScale;
    let frameEma = 16.7;
    let lastFrameAt = performance.now();
    let checkCounter = 0;
    let lastAdjustAt = 0;
    let frameCount = 0;
    // 慢帧普查：软件渲染（无硬件加速的 WebView 常见）单帧几百毫秒，必须统计并整体切 2D，
    // 仅降分辨率救不回来。注意不能过滤掉慢帧，否则自适应逻辑被"蒙眼"。
    const recentDeltas: number[] = [];

    let dust: SplashDust[] = [];
    let streaks: SplashStreak[] = [];
    let shards: SplashShard[] = [];

    const streakColors = [
      'rgba(244,210,138,',
      'rgba(122,215,194,',
      'rgba(255,83,103,',
      'rgba(157,184,207,'
    ];

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      // WebGL 用自适应倍率（乘在 CSS 尺寸上），2D 兜底用固定 DPR 上限
      pixelRatio = gl ? renderScale : Math.min(1.6, Math.max(1, window.devicePixelRatio || 1));
      host.width = Math.max(1, Math.floor(w * pixelRatio));
      host.height = Math.max(1, Math.floor(h * pixelRatio));
      if (ctx2d) ctx2d.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      if (gl) gl.viewport(0, 0, host.width, host.height);

      dust = [];
      streaks = [];
      shards = [];
      const count = reduceMotion ? 28 : 84;
      for (let i = 0; i < count; i++) {
        dust.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.18,
          vy: (Math.random() - 0.5) * 0.11,
          r: Math.random() * 1.35 + 0.28,
          a: Math.random() * 0.105 + 0.025,
          p: Math.random() * Math.PI * 2
        });
      }
      const streakCount = reduceMotion ? 6 : 22;
      for (let s = 0; s < streakCount; s++) {
        streaks.push({
          x: Math.random() * w,
          y: h * (0.20 + Math.random() * 0.62),
          len: w * (0.12 + Math.random() * 0.24),
          width: 0.75 + Math.random() * 2.1,
          speed: w * (0.00028 + Math.random() * 0.00042),
          angle: (-10 + Math.random() * 20) * Math.PI / 180,
          phase: Math.random() * Math.PI * 2,
          color: streakColors[s % streakColors.length],
          delay: Math.random() * 1.1,
          alpha: 0.18 + Math.random() * 0.36
        });
      }
      const shardCount = reduceMotion ? 10 : 34;
      for (let sh = 0; sh < shardCount; sh++) {
        shards.push({
          ox: (Math.random() - 0.5) * w * 0.92,
          oy: (Math.random() - 0.5) * h * 0.22,
          w: 18 + Math.random() * 86,
          h: 1 + Math.random() * 5,
          skew: (Math.random() - 0.5) * 20,
          phase: Math.random() * Math.PI * 2,
          color: streakColors[sh % streakColors.length],
          alpha: 0.10 + Math.random() * 0.24
        });
      }
    };

    /** 弃用 WebGL，切换到独立 2D 画布兜底（两块画布上下文互相独立，互不污染） */
    const activate2d = (reason: string, warn = true) => {
      if (disposed || ctx2d) return;
      if (gl) {
        try {
          if (buffer) gl.deleteBuffer(buffer);
          if (program) gl.deleteProgram(program);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch {
          // 释放失败不影响 2D 切换
        }
      }
      gl = null;
      program = null;
      buffer = null;
      glCanvas.style.display = 'none';
      fbCanvas.style.display = '';
      host = fbCanvas;
      ctx2d = fbCanvas.getContext('2d');
      startedAt = performance.now(); // 2D 编舞从头播放
      recentDeltas.length = 0;
      frameEma = 16.7;
      resize();
      (warn ? console.warn : console.info)(`[splash] ${reason}，已切换 2D 动画`);
    };

    const draw2d = (elapsed: number) => {
      if (!ctx2d) return;
      ctx2d.clearRect(0, 0, w, h);

      const base = ctx2d.createLinearGradient(0, 0, w, h);
      base.addColorStop(0, 'rgba(1,6,7,0.68)');
      base.addColorStop(0.45, 'rgba(10,9,12,0.74)');
      base.addColorStop(1, 'rgba(0,0,0,0.84)');
      ctx2d.fillStyle = base;
      ctx2d.fillRect(0, 0, w, h);

      ctx2d.save();
      ctx2d.globalAlpha = 0.22;
      ctx2d.fillStyle = 'rgba(255,255,255,0.035)';
      const scanOffset = (elapsed * 28) % 36;
      for (let sy = -scanOffset; sy < h; sy += 36) ctx2d.fillRect(0, sy, w, 1);
      ctx2d.restore();

      for (const d of dust) {
        d.x += d.vx;
        d.y += d.vy;
        d.p += 0.018;
        if (d.x < -10) d.x = w + 10;
        if (d.x > w + 10) d.x = -10;
        if (d.y < -10) d.y = h + 10;
        if (d.y > h + 10) d.y = -10;
        const alpha = d.a * (0.58 + Math.sin(d.p + elapsed * 0.8) * 0.34);
        ctx2d.beginPath();
        ctx2d.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx2d.fillStyle = 'rgba(255,255,255,' + Math.max(0, alpha) + ')';
        ctx2d.fill();
      }

      ctx2d.save();
      ctx2d.globalCompositeOperation = 'lighter';
      for (const st of streaks) {
        const travel = (elapsed * st.speed * 240 + st.x + Math.sin(elapsed * 0.8 + st.phase) * 28) % (w + st.len + 180);
        const px = travel - st.len - 90;
        const py = st.y + Math.sin(elapsed * 0.75 + st.phase) * 18;
        const fade = smoothstep(st.delay * 0.55, st.delay * 0.55 + 0.52, elapsed) * (1 - smoothstep(3.52, 4.12, elapsed));
        ctx2d.save();
        ctx2d.translate(px, py);
        ctx2d.rotate(st.angle);
        const sg = ctx2d.createLinearGradient(-st.len * 0.5, 0, st.len * 0.5, 0);
        sg.addColorStop(0, st.color + '0)');
        sg.addColorStop(0.52, st.color + (st.alpha * fade).toFixed(3) + ')');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx2d.strokeStyle = sg;
        ctx2d.lineWidth = st.width;
        ctx2d.shadowColor = st.color + (0.34 * fade).toFixed(3) + ')';
        ctx2d.shadowBlur = 18;
        ctx2d.beginPath();
        ctx2d.moveTo(-st.len * 0.5, 0);
        ctx2d.lineTo(st.len * 0.5, 0);
        ctx2d.stroke();
        ctx2d.restore();
      }

      const lineT = easeOutCubic((elapsed - 0.12) / 1.18);
      const exitFade = 1 - smoothstep(3.58, 4.12, elapsed);
      if (lineT > 0 && exitFade > 0) {
        const centerY = h * 0.5 + Math.sin(elapsed * 1.4) * 1.6;
        const slitW = w * (0.16 + lineT * 0.72);
        const left = w * 0.5 - slitW * 0.5;
        const right = w * 0.5 + slitW * 0.5;
        const coreAlpha = (0.34 + lineT * 0.58) * exitFade;
        const slitGrad = ctx2d.createLinearGradient(left, centerY, right, centerY);
        slitGrad.addColorStop(0, 'rgba(255,83,103,0)');
        slitGrad.addColorStop(0.18, 'rgba(255,83,103,' + (0.18 * exitFade).toFixed(3) + ')');
        slitGrad.addColorStop(0.50, 'rgba(255,255,255,' + coreAlpha.toFixed(3) + ')');
        slitGrad.addColorStop(0.68, 'rgba(244,210,138,' + (0.38 * exitFade).toFixed(3) + ')');
        slitGrad.addColorStop(0.84, 'rgba(122,215,194,' + (0.20 * exitFade).toFixed(3) + ')');
        slitGrad.addColorStop(1, 'rgba(122,215,194,0)');
        ctx2d.shadowColor = 'rgba(244,210,138,' + (0.48 * exitFade).toFixed(3) + ')';
        ctx2d.shadowBlur = 42 + lineT * 42;
        ctx2d.lineCap = 'round';
        ctx2d.strokeStyle = slitGrad;
        ctx2d.lineWidth = 1.4 + lineT * 2.2;
        ctx2d.beginPath();
        ctx2d.moveTo(left, centerY);
        ctx2d.lineTo(right, centerY);
        ctx2d.stroke();

        const ignition = Math.exp(-Math.pow((elapsed - 0.72) / 0.26, 2));
        if (ignition > 0.018) {
          const ig = ctx2d.createLinearGradient(0, centerY, w, centerY);
          ig.addColorStop(0, 'rgba(122,215,194,0)');
          ig.addColorStop(0.46, 'rgba(122,215,194,' + (0.07 * ignition).toFixed(3) + ')');
          ig.addColorStop(0.50, 'rgba(255,255,255,' + (0.16 * ignition).toFixed(3) + ')');
          ig.addColorStop(0.54, 'rgba(255,83,103,' + (0.08 * ignition).toFixed(3) + ')');
          ig.addColorStop(1, 'rgba(244,210,138,0)');
          ctx2d.fillStyle = ig;
          ctx2d.fillRect(0, centerY - 48 * ignition, w, 96 * ignition);
        }

        const waveAlpha = smoothstep(0.72, 1.95, elapsed) * exitFade;
        if (waveAlpha > 0) {
          ctx2d.shadowBlur = 20;
          ctx2d.strokeStyle = 'rgba(244,210,138,' + (0.22 * waveAlpha).toFixed(3) + ')';
          ctx2d.lineWidth = 1;
          ctx2d.beginPath();
          const steps = 82;
          for (let wi = 0; wi <= steps; wi++) {
            const u = wi / steps;
            const x = left + slitW * u;
            const edge = 1 - Math.abs(u - 0.5) * 2;
            const amp = (4 + 18 * lineT) * Math.pow(Math.max(0, edge), 1.4) * waveAlpha;
            const y = centerY + Math.sin(u * 34 + elapsed * 8.2) * amp + Math.sin(u * 87 - elapsed * 5.1) * amp * 0.18;
            if (wi === 0) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          }
          ctx2d.stroke();
        }

        const shardT = smoothstep(0.72, 2.45, elapsed) * exitFade;
        for (const sh of shards) {
          const drift = Math.sin(elapsed * 1.7 + sh.phase) * 22;
          const sx = w * 0.5 + sh.ox * (0.18 + shardT * 0.82) + drift;
          const sy = centerY + sh.oy * (0.20 + shardT * 0.92);
          const localAlpha = sh.alpha * shardT * (0.62 + Math.sin(elapsed * 5 + sh.phase) * 0.38);
          if (localAlpha <= 0) continue;
          ctx2d.save();
          ctx2d.translate(sx, sy);
          ctx2d.rotate((-6 + sh.skew * 0.10) * Math.PI / 180);
          ctx2d.fillStyle = sh.color + Math.max(0, localAlpha).toFixed(3) + ')';
          ctx2d.shadowColor = sh.color + Math.min(0.38, localAlpha * 1.2).toFixed(3) + ')';
          ctx2d.shadowBlur = 14;
          ctx2d.beginPath();
          ctx2d.moveTo(-sh.w * 0.5, -sh.h * 0.5);
          ctx2d.lineTo(sh.w * 0.5, -sh.h * 0.5);
          ctx2d.lineTo(sh.w * 0.5 + sh.skew, sh.h * 0.5);
          ctx2d.lineTo(-sh.w * 0.5 + sh.skew, sh.h * 0.5);
          ctx2d.closePath();
          ctx2d.fill();
          ctx2d.restore();
        }

        const flash = Math.exp(-Math.pow((elapsed - 2.52) / 0.38, 2));
        if (flash > 0.015) {
          const fg = ctx2d.createLinearGradient(0, centerY, w, centerY);
          fg.addColorStop(0, 'rgba(255,83,103,0)');
          fg.addColorStop(0.48, 'rgba(255,255,255,' + (0.20 * flash).toFixed(3) + ')');
          fg.addColorStop(0.52, 'rgba(244,210,138,' + (0.24 * flash).toFixed(3) + ')');
          fg.addColorStop(1, 'rgba(122,215,194,0)');
          ctx2d.fillStyle = fg;
          ctx2d.fillRect(0, centerY - 46 * flash, w, 92 * flash);
        }
      }
      ctx2d.restore();
    };

    // ---------- 主循环 ----------
    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const nowMs = performance.now();
      const elapsed = (nowMs - startedAt) / 1000;

      if (gl && program && uRes && uTime) {
        const delta = nowMs - lastFrameAt;
        lastFrameAt = nowMs;
        // 只剔除异常巨帧（如切后台回来），慢帧必须计入——否则自适应被"蒙眼"
        if (delta > 0 && delta < 500) {
          frameEma = frameEma * 0.88 + delta * 0.12;
          recentDeltas.push(delta);
          if (recentDeltas.length > 120) recentDeltas.shift();
          // 慢帧普查：超过 1/3 帧慢于 45ms → 疑似软件渲染，整体切 2D
          if (recentDeltas.length >= 60 && elapsed > 1.2) {
            const slow = recentDeltas.filter((d) => d > 45).length;
            if (slow > recentDeltas.length / 3) {
              activate2d('GPU 渲染过慢（疑似软件渲染）');
              return;
            }
          }
        }
        frameCount++;
        // 分辨率自适应：每 ~45 帧评估一次，带冷却防抖
        checkCounter++;
        if (checkCounter >= 45 && nowMs - lastAdjustAt > 900) {
          checkCounter = 0;
          if (frameEma > 21 && renderScale > 0.62) {
            renderScale = Math.max(0.62, renderScale - 0.15);
            resize();
            lastAdjustAt = nowMs;
          } else if (frameEma < 12.5 && renderScale < maxScale) {
            renderScale = Math.min(maxScale, renderScale + 0.1);
            resize();
            lastAdjustAt = nowMs;
          }
          // 分辨率已降到底仍然掉帧 → 这块 GPU 带不动着色器，切 2D
          if (renderScale <= 0.63 && frameEma > 30) {
            activate2d('降分辨率后仍无法流畅渲染');
            return;
          }
        }
        // 心跳日志：约每 2 秒一条，用于诊断"代码在跑但画面冻结"之类的呈现层问题
        if (frameCount % 120 === 0) {
          console.info(
            `[splash] webgl t=${elapsed.toFixed(1)}s frames=${frameCount} avg=${frameEma.toFixed(1)}ms ` +
            `scale=${renderScale.toFixed(2)} size=${host.width}x${host.height} glErr=${gl.getError()}`
          );
        }
        try {
          gl.viewport(0, 0, host.width, host.height);
          gl.useProgram(program);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
          gl.uniform2f(uRes, host.width, host.height);
          gl.uniform1f(uTime, elapsed);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        } catch (err) {
          activate2d(`WebGL 渲染异常：${err}`);
        }
        return;
      }
      draw2d(elapsed);
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      activate2d('WebGL 上下文丢失');
    };
    glCanvas.addEventListener('webglcontextlost', onContextLost);

    if (reduceMotion) {
      activate2d('系统启用了"减少动态效果"', false);
    } else if (setupWebgl(glCanvas)) {
      console.info('[splash] WebGL active');
    } else {
      activate2d('WebGL 不可用');
    }
    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      glCanvas.removeEventListener('webglcontextlost', onContextLost);
      if (gl) {
        try {
          if (buffer) gl.deleteBuffer(buffer);
          if (program) gl.deleteProgram(program);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch {
          // 忽略释放异常
        }
        gl = null;
      }
    };
  }, []);

  return (
    <>
      <canvas id="splash-canvas" ref={glRef} aria-hidden="true" />
      <canvas id="splash-canvas-2d" ref={fbRef} style={{ display: 'none' }} aria-hidden="true" />
    </>
  );
}
