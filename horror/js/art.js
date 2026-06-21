// art.js — 程序化场景渲染器（Canvas 2D）
// 《九百九十九》美术核心：15 种心理恐怖场景，全部实时绘制，无任何图片。
// 所有随机性来自 rng.js，基于 level.seed，保证 999 关确定性。
//
// 契约：export function createScene(canvas, level) => { render(t, fear), resize(), destroy() }
//   render(t, fear): t=毫秒, fear=0..1（越高越扭曲、越暗、越不安），每帧由 engine 调用。
//
// 设计原则：
//   - 纵深/透视/层次，营造孤独与下沉。
//   - 程序化噪声生成纹理；离屏缓存静态底，避免每帧重算昂贵噪声。
//   - t 驱动缓慢动画（雾飘、光闪、脉动、漂浮）。
//   - fear 驱动细微异常（影子靠近、抖动、暗角内缩、一闪而过的人脸/眼睛）。
//   - 心理恐怖：靠暗示而非血腥，克制。

import { RNG, makeNoise2D, fbm2D, makeNoise1D } from './rng.js';

/* ============================================================
 * 颜色与数学小工具
 * ========================================================== */

// hex -> {r,g,b}
function hexRGB(hex) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
// {r,g,b} + alpha -> rgba()
function rgba(c, a = 1) { return `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`; }
// 线性插值两色
function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
// 调亮/调暗（k>1 变亮，k<1 变暗）
function scale(c, k) { return { r: Math.min(255, c.r * k), g: Math.min(255, c.g * k), b: Math.min(255, c.b * k) }; }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
// 平滑脉冲：0..1..0
const smooth = t => t * t * (3 - 2 * t);

/* ============================================================
 * createScene —— 主入口
 * ========================================================== */
export function createScene(canvas, level) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const art = level.art || {};
  const scene = art.scene || 'corridor';
  const seed = (art.seed ?? level.seed ?? 1) >>> 0;
  const motifs = art.motifs || [];
  const baseFog = clamp(art.fog ?? 0.5, 0, 1);
  const intensity = clamp(art.intensity ?? 0.5, 0, 1);

  // 调色板（带默认兜底，避免缺字段崩溃）
  const P = (() => {
    const p = art.palette || {};
    return {
      bg: hexRGB(p.bg || '#070608'),
      fog: hexRGB(p.fog || '#1a1822'),
      ink: hexRGB(p.ink || '#0a0a0c'),
      blood: hexRGB(p.blood || '#5a1018'),
      glow: hexRGB(p.glow || '#b9a07a'),
      accent: hexRGB(p.accent || '#3a4a55'),
    };
  })();

  // 各自独立的 RNG / 噪声，互不污染序列
  const rng = new RNG(seed);
  const noise = makeNoise2D(seed ^ 0x9e3779b9);
  const noiseB = makeNoise2D(seed ^ 0x85ebca6b);
  const n1 = makeNoise1D(seed ^ 0xc2b2ae35);

  // 尺寸/缓存
  let W = 0, H = 0, cx = 0, cy = 0, diag = 0;
  let texCanvas = null, texCtx = null;     // 离屏静态纹理（噪声底）
  let grainCanvas = null, grainCtx = null; // 颗粒图块（平铺）
  let destroyed = false;

  // 持久化的“随机布局”数据：在 resize 时由场景一次性生成，render 复用
  let layout = null;

  /* ---------- 离屏静态纹理：分形噪声底（墙面/有机感） ---------- */
  function bakeTexture() {
    const tw = Math.max(2, Math.min(512, Math.round(W / 2)));
    const th = Math.max(2, Math.min(512, Math.round(H / 2)));
    if (!texCanvas) texCanvas = document.createElement('canvas');
    texCanvas.width = tw; texCanvas.height = th;
    texCtx = texCanvas.getContext('2d');
    const img = texCtx.createImageData(tw, th);
    const d = img.data;
    const base = P.fog, dark = P.ink;
    const sc = 0.018; // 噪声频率
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const f = fbm2D(noise, x * sc, y * sc, 5);
        const blot = fbm2D(noiseB, x * sc * 0.4, y * sc * 0.4, 3);
        const v = clamp(f * 0.75 + blot * 0.35, 0, 1);
        const col = mix(dark, base, v * v);
        const i = (y * tw + x) * 4;
        d[i] = col.r; d[i + 1] = col.g; d[i + 2] = col.b; d[i + 3] = 255;
      }
    }
    texCtx.putImageData(img, 0, 0);
  }

  /* ---------- 离屏颗粒块（每帧随机平移以制造活动感） ---------- */
  function bakeGrain() {
    const g = 128;
    if (!grainCanvas) grainCanvas = document.createElement('canvas');
    grainCanvas.width = g; grainCanvas.height = g;
    grainCtx = grainCanvas.getContext('2d');
    const img = grainCtx.createImageData(g, g);
    const d = img.data;
    const gr = new RNG(seed ^ 0x27d4eb2f);
    for (let i = 0; i < d.length; i += 4) {
      const v = gr.next() * 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    grainCtx.putImageData(img, 0, 0);
  }

  /* ============================================================
   * 通用绘制工具（场景共享）
   * ========================================================== */

  // 飘动的体积雾：用 fbm 采样 + 时间偏移，浓度受 baseFog 与 fear 调制
  function drawFog(t, fear, opts = {}) {
    const density = clamp((opts.density ?? baseFog) + fear * 0.25, 0, 1.2);
    if (density <= 0.02) return;
    const layers = opts.layers ?? 3;
    const col = opts.color || P.fog;
    const top = opts.top ?? 0;
    const bottom = opts.bottom ?? H;
    const cols = 26;            // 雾团采样列（性能友好）
    const cw = W / cols;
    for (let L = 0; L < layers; L++) {
      const speed = 0.000018 * (L + 1) * (1 + fear * 0.6);
      const ph = t * speed;
      const yo = (L / layers);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i <= cols; i++) {
        const nx = i * 0.18 + L * 11.3;
        const f = fbm2D(noise, nx + ph * 40, yo * 3 + ph * 12, 3);
        const a = clamp(f * density * (0.10 + L * 0.05), 0, 0.4);
        if (a < 0.01) continue;
        const yBand = lerp(top, bottom, yo + (f - 0.5) * 0.3);
        const h = (bottom - top) * (0.4 + f * 0.5);
        const grad = ctx.createRadialGradient(i * cw, yBand, 0, i * cw, yBand, cw * 2.4);
        grad.addColorStop(0, rgba(col, a));
        grad.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(i * cw - cw * 2.4, yBand - h, cw * 4.8, h * 2);
      }
      ctx.restore();
    }
  }

  // 胶片颗粒：平铺颗粒块 + 随机偏移，强度随 fear
  function drawGrain(t, fear) {
    if (!grainCanvas) return;
    const a = 0.045 + fear * 0.07 + intensity * 0.02;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.globalCompositeOperation = 'overlay';
    const ox = (Math.sin(t * 0.013) * 64) | 0;
    const oy = ((t * 0.07) % 128) | 0;
    const g = 128;
    for (let y = -g + (oy % g); y < H; y += g) {
      for (let x = -g + (ox % g); x < W; x += g) {
        ctx.drawImage(grainCanvas, x, y);
      }
    }
    ctx.restore();
  }

  // 暗角：随 fear 内收、加深，制造被注视/收缩感
  function drawVignette(fear) {
    const inner = lerp(0.62, 0.30, fear);     // fear 越高，亮区越小
    const grad = ctx.createRadialGradient(cx, cy, diag * inner * 0.5, cx, cy, diag * 0.62);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.7, rgba(P.bg, 0.4 + fear * 0.3));
    grad.addColorStop(1, rgba(scale(P.bg, 0.3), 0.92));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // 单点透视引导线（走廊/隧道/地铁）
  function perspectiveLines(vx, vy, count, color, alpha) {
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = 1;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * TAU;
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(vx + Math.cos(ang) * diag, vy + Math.sin(ang) * diag);
      ctx.stroke();
    }
  }

  // 闪烁因子：组合多频噪声，偶发熄灭（坏灯感）
  function flicker(t, rate = 1) {
    const a = (n1(t * 0.004 * rate) + 1) * 0.5;
    const b = (n1(t * 0.021 * rate + 50) + 1) * 0.5;
    let v = 0.55 + a * 0.3 + b * 0.15;
    // 偶发骤暗
    if (n1(t * 0.0013 * rate + 200) > 0.72) v *= 0.25;
    return clamp(v, 0.05, 1);
  }

  // 抖动偏移（fear 驱动整体微颤）
  function jitter(t, fear, amp = 1) {
    const k = fear * amp * 2.2;
    return {
      x: n1(t * 0.03) * k,
      y: n1(t * 0.027 + 99) * k,
    };
  }

  // 人形剪影：站立的细长黑影（暗示而非细节）
  function drawSilhouette(x, groundY, h, color, alpha) {
    const w = h * 0.26;
    ctx.save();
    ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath();
    // 头
    const headR = w * 0.34;
    ctx.arc(x, groundY - h + headR, headR, 0, TAU);
    ctx.fill();
    // 身体（上窄下宽的柱形，略带肩）
    ctx.beginPath();
    ctx.moveTo(x - w * 0.3, groundY - h + headR * 1.6);
    ctx.quadraticCurveTo(x - w * 0.55, groundY - h * 0.5, x - w * 0.4, groundY);
    ctx.lineTo(x + w * 0.4, groundY);
    ctx.quadraticCurveTo(x + w * 0.55, groundY - h * 0.5, x + w * 0.3, groundY - h + headR * 1.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 眼睛：黑暗中浮现的一对/单只眼，随 alpha 淡入淡出
  function drawEye(x, y, r, color, alpha, look = 0) {
    if (alpha <= 0.01) return;
    ctx.save();
    // 眼白微光
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 1.6);
    grad.addColorStop(0, rgba(color, alpha * 0.9));
    grad.addColorStop(0.5, rgba(color, alpha * 0.4));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.4, r * 0.8, 0, 0, TAU);
    ctx.fill();
    // 瞳孔
    ctx.fillStyle = rgba(P.ink, Math.min(1, alpha * 1.4));
    ctx.beginPath();
    ctx.arc(x + look * r * 0.5, y, r * 0.42, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // 一闪而过的人脸：极暗处隐现的面孔轮廓（克制，靠暗示）
  function ghostFace(x, y, s, fear, t, salt = 0) {
    // 出现概率与节律由 fear 与噪声控制
    const trig = n1(t * 0.0009 + salt);
    const present = clamp((trig - (0.78 - fear * 0.45)) / 0.2, 0, 1);
    if (present <= 0.02) return;
    const a = present * (0.12 + fear * 0.2);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // 朦胧脸盘
    const fg = mix(P.fog, P.glow, 0.3);
    let grad = ctx.createRadialGradient(x, y, 0, x, y, s);
    grad.addColorStop(0, rgba(fg, a));
    grad.addColorStop(1, rgba(fg, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(x, y, s * 0.7, s, 0, 0, TAU); ctx.fill();
    // 眼窝（暗）
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = rgba(P.ink, a * 2.2);
    ctx.beginPath(); ctx.ellipse(x - s * 0.28, y - s * 0.15, s * 0.16, s * 0.1, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + s * 0.28, y - s * 0.15, s * 0.16, s * 0.1, 0, 0, TAU); ctx.fill();
    // 嘴（细暗痕）
    ctx.beginPath(); ctx.ellipse(x, y + s * 0.45, s * 0.22, s * 0.06, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 简易粒子系统（灰尘/碎片/气泡/孢子），数量适配画布面积
  function makeParticles(count, cfg) {
    const r = new RNG(seed ^ cfg.salt ?? 0);
    const arr = [];
    const n = Math.max(8, Math.round(count * (W * H) / (1280 * 720)));
    for (let i = 0; i < n; i++) {
      arr.push({
        x: r.float(0, 1), y: r.float(0, 1),
        z: r.float(0.2, 1),           // 深度（越大越近）
        r: r.float(cfg.minR, cfg.maxR),
        ph: r.float(0, TAU),
        spd: r.float(0.4, 1.2),
        sway: r.float(0.3, 1),
      });
    }
    return arr;
  }
  function drawParticles(arr, t, cfg, fear) {
    const dir = cfg.dir || -1;       // -1 上升 / 1 下沉
    const col = cfg.color || P.glow;
    ctx.save();
    ctx.globalCompositeOperation = cfg.blend || 'lighter';
    for (const p of arr) {
      const life = (t * 0.00004 * p.spd * (1 + fear * 0.4)) ;
      let py = (p.y + dir * life) ;
      py = py - Math.floor(py);                  // 环绕
      const swayX = Math.sin(t * 0.0006 * p.sway + p.ph) * cfg.swayAmp * p.z;
      const x = (p.x * W + swayX * W) ;
      const y = py * H;
      const rr = p.r * p.z * (cfg.scale || 1);
      const a = (cfg.alpha || 0.5) * p.z;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, rr * 2.5);
      grad.addColorStop(0, rgba(col, a));
      grad.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, rr * 2.5, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  // 背景基底填充（带垂直渐变，营造上暗下更暗或反之）
  function fillBase(topCol, botCol) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, rgba(topCol, 1));
    grad.addColorStop(1, rgba(botCol, 1));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // 把离屏纹理盖到某区域（带透明度与混合），用于墙面/有机质感
  function applyTexture(x, y, w, h, alpha, blend = 'overlay') {
    if (!texCanvas) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(texCanvas, x, y, w, h);
    ctx.restore();
  }

  // 污渍/血痕：缓慢下淌的暗色斑（克制，少量）
  function drawStain(x, y, w, h, color, alpha) {
    ctx.save();
    ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const r = new RNG((x * 13 + y * 7) | 0);
    ctx.ellipse(x, y, w, h * 0.4, 0, 0, TAU);
    ctx.fill();
    // 下淌细流
    const drips = r.int(2, 4);
    for (let i = 0; i < drips; i++) {
      const dx = x + r.float(-w, w);
      const dh = h * r.float(0.6, 1.8);
      ctx.beginPath();
      ctx.moveTo(dx, y);
      ctx.lineTo(dx - 1.5, y + dh);
      ctx.lineTo(dx + 1.5, y + dh);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /* ============================================================
   * MOTIF 点缀绘制器（可叠加在任意场景上）
   * key: door | eye | hand | figure | clock | stairs | water | candle
   * ========================================================== */
  const MOTIF = {
    // 远处微开的门，缝里透出异样的光
    door(t, fear) {
      const x = cx + (n1(seed) * W * 0.3);
      const groundY = H * 0.74;
      const dh = H * 0.34, dw = dh * 0.42;
      ctx.save();
      ctx.fillStyle = rgba(P.ink, 0.9);
      ctx.fillRect(x - dw / 2, groundY - dh, dw, dh);
      // 门缝光（呼吸）
      const open = 0.08 + fear * 0.06;
      const breathe = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.0011));
      const grad = ctx.createLinearGradient(x - dw * open, 0, x + dw * open, 0);
      grad.addColorStop(0, rgba(P.glow, 0));
      grad.addColorStop(0.5, rgba(P.glow, 0.5 * breathe));
      grad.addColorStop(1, rgba(P.glow, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x - dw * open, groundY - dh, dw * open * 2, dh);
      // fear 高时缝里有影
      if (fear > 0.55 && n1(t * 0.001 + 7) > 0.6) {
        drawSilhouette(x, groundY, dh * 0.85, P.ink, 0.5);
      }
      ctx.restore();
    },
    // 黑暗中睁开的眼（一对），随机方位
    eye(t, fear) {
      const pulse = n1(t * 0.0007 + 3);
      const a = clamp((pulse - 0.3) * (0.4 + fear), 0, 0.6);
      const x = cx + n1(seed + 11) * W * 0.34;
      const y = cy + n1(seed + 22) * H * 0.3;
      const r = H * 0.018 * (1 + fear);
      const look = Math.sin(t * 0.0009);
      drawEye(x - r * 1.8, y, r, P.glow, a, look);
      drawEye(x + r * 1.8, y, r, P.glow, a, look);
    },
    // 从下方/侧边探入的苍白手影
    hand(t, fear) {
      const reach = smooth(clamp((n1(t * 0.0006 + 5) + 1) * 0.5, 0, 1)) * (0.4 + fear * 0.6);
      const baseY = H + 10;
      const x = cx + n1(seed + 33) * W * 0.3;
      const len = H * 0.22 * reach;
      ctx.save();
      ctx.strokeStyle = rgba(mix(P.fog, P.glow, 0.4), 0.18 + fear * 0.2);
      ctx.lineCap = 'round';
      for (let f = 0; f < 5; f++) {
        const fx = x + (f - 2) * 9;
        ctx.lineWidth = 4 - Math.abs(f - 2) * 0.5;
        ctx.beginPath();
        ctx.moveTo(fx, baseY);
        ctx.quadraticCurveTo(fx + n1(f + t * 0.001) * 8, baseY - len * 0.6, fx, baseY - len);
        ctx.stroke();
      }
      ctx.restore();
    },
    // 远处静立人形
    figure(t, fear) {
      const x = cx + n1(seed + 44) * W * 0.28;
      const groundY = H * 0.78;
      const approach = fear;     // fear 越高越大越近
      const h = H * (0.18 + approach * 0.22);
      const sway = Math.sin(t * 0.0004 + 1) * 3 * (1 - fear); // 越近越静止（更可怕）
      drawSilhouette(x + sway, groundY + approach * H * 0.06, h, P.ink, 0.6 + fear * 0.3);
    },
    // 停摆的钟，指针偶尔抽动
    clock(t, fear) {
      const x = W * 0.18, y = H * 0.22, r = Math.min(W, H) * 0.07;
      ctx.save();
      ctx.strokeStyle = rgba(P.glow, 0.3);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
      // 指针：大多时间停滞，fear 高时倒走/抽搐
      const tick = Math.floor(t * 0.0008);
      const jitterA = fear > 0.5 ? n1(tick + 9) * 0.4 : 0;
      const ah = -1.7 + jitterA;
      const am = 0.6 - tick * 0.05 * fear;  // fear 时分针缓慢倒退
      ctx.strokeStyle = rgba(P.blood, 0.5);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ah) * r * 0.5, y + Math.sin(ah) * r * 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(am) * r * 0.75, y + Math.sin(am) * r * 0.75); ctx.stroke();
      ctx.restore();
    },
    // 下行的阶梯轮廓（侧投影）
    stairs(t, fear) {
      const x0 = W * 0.7, y0 = H * 0.5;
      ctx.save();
      ctx.strokeStyle = rgba(P.fog, 0.25 + fear * 0.15);
      ctx.lineWidth = 1.5;
      let x = x0, y = y0;
      const steps = 9;
      for (let i = 0; i < steps; i++) {
        const sw = 26 * (1 - i / steps * 0.5);
        const sh = 16 * (1 - i / steps * 0.5);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + sw, y); ctx.lineTo(x + sw, y + sh); ctx.stroke();
        x += sw; y += sh;
      }
      ctx.restore();
    },
    // 地面/底部的水面反光与涟漪
    water(t, fear) {
      const wy = H * 0.86;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 5; i++) {
        const yy = wy + i * (H - wy) / 5;
        const a = 0.06 * (1 - i / 6);
        const off = Math.sin(t * 0.0008 + i) * 8;
        ctx.strokeStyle = rgba(P.accent, a);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let xx = 0; xx <= W; xx += 12) {
          const yo = n1(xx * 0.02 + t * 0.0009 + i) * 4;
          if (xx === 0) ctx.moveTo(xx, yy + yo + off); else ctx.lineTo(xx, yy + yo + off);
        }
        ctx.stroke();
      }
      ctx.restore();
    },
    // 烛光：暖光晕 + 摇曳
    candle(t, fear) {
      const x = W * 0.5 + Math.sin(t * 0.0017) * 4;
      const y = H * 0.62;
      const fl = flicker(t, 2);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, H * 0.22 * fl);
      grad.addColorStop(0, rgba(scale(P.glow, 1.3), 0.5 * fl));
      grad.addColorStop(0.4, rgba(P.glow, 0.2 * fl));
      grad.addColorStop(1, rgba(P.glow, 0));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, H * 0.22 * fl, 0, TAU); ctx.fill();
      // 火苗
      ctx.fillStyle = rgba(scale(P.glow, 1.5), 0.8 * fl);
      ctx.beginPath();
      ctx.ellipse(x, y, 2.5, 7 + fl * 3, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    },
  };

  function drawMotifs(t, fear) {
    for (const m of motifs) {
      const fn = MOTIF[m];
      if (fn) { ctx.save(); fn(t, fear); ctx.restore(); }
    }
  }

  /* ============================================================
   * 15 种场景渲染器
   * 每个 SCENES[key] = function(t, fear)
   * layout 在 resize 时由 buildLayout() 预生成
   * ========================================================== */

  // 预生成各场景需要的随机布局（避免每帧 new RNG）
  function buildLayout() {
    const r = new RNG(seed);
    layout = {
      // 通用：随机污渍点
      stains: Array.from({ length: 6 }, () => ({
        x: r.float(0.1, 0.9), y: r.float(0.2, 0.7), w: r.float(8, 30), h: r.float(10, 40),
      })),
      // forest 树木
      trees: Array.from({ length: 26 }, () => ({
        x: r.float(-0.05, 1.05), z: r.float(0.15, 1), lean: r.float(-0.12, 0.12), w: r.float(0.4, 1.2),
      })).sort((a, b) => a.z - b.z),
      // forest 眼睛槽位
      eyeSlots: Array.from({ length: 7 }, () => ({ x: r.float(0.1, 0.9), y: r.float(0.3, 0.6), ph: r.float(0, TAU) })),
      // abyss 漂浮碎片
      shards: Array.from({ length: 30 }, () => ({
        x: r.float(0, 1), y: r.float(0, 1), z: r.float(0.1, 1), rot: r.float(0, TAU), s: r.float(3, 16), spin: r.float(-1, 1),
      })),
      // room 家具槽位
      furniture: r.shuffle(['chair', 'table', 'bed', 'frame', 'lamp']).slice(0, r.int(2, 4)),
      // hospital 病床
      beds: r.int(3, 5),
      // church 长椅 / 彩窗
      pews: r.int(4, 6),
      windowHue: r.shuffle([0, 1, 2]),
      // subway 灯
      lamps: Array.from({ length: 8 }, () => ({ z: r.float(0.05, 1), ph: r.float(0, TAU), bad: r.bool(0.4) })),
      // garden 雕像/藤
      statues: r.int(1, 3),
      vines: Array.from({ length: 12 }, () => ({ x: r.float(0, 1), len: r.float(0.3, 0.9), ph: r.float(0, TAU) })),
      // attic 悬挂物
      hangs: Array.from({ length: 6 }, () => ({ x: r.float(0.1, 0.9), len: r.float(0.1, 0.45), ph: r.float(0, TAU) })),
      // 通用粒子
      dust: makeParticles(40, { salt: 1, minR: 0.4, maxR: 1.6 }),
      bubbles: makeParticles(34, { salt: 2, minR: 0.6, maxR: 2.4 }),
      spores: makeParticles(28, { salt: 3, minR: 0.5, maxR: 2 }),
      r,
    };
  }

  const SCENES = {

    /* ---- 无尽走廊：单点透视、门、远处的影 ---- */
    corridor(t, fear) {
      fillBase(scale(P.bg, 1.1), P.ink);
      const vx = cx + n1(t * 0.0002) * W * 0.04;       // 灭点缓慢游移
      const vy = cy - H * 0.02;
      // 侧墙 + 地板 + 天花的透视梯形
      const half = W * 0.5;
      ctx.save();
      // 地板
      let g = ctx.createLinearGradient(0, vy, 0, H);
      g.addColorStop(0, rgba(P.ink, 1)); g.addColorStop(1, rgba(scale(P.fog, 0.7), 1));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(0, H); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      // 天花
      g = ctx.createLinearGradient(0, 0, 0, vy);
      g.addColorStop(0, rgba(scale(P.ink, 0.6), 1)); g.addColorStop(1, rgba(P.ink, 1));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(0, 0); ctx.lineTo(W, 0); ctx.closePath(); ctx.fill();
      // 侧墙（左右）带纹理
      ctx.fillStyle = rgba(P.fog, 1);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(vx, vy); ctx.lineTo(vx, vy); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(W, 0); ctx.lineTo(vx, vy); ctx.lineTo(vx, vy); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      applyTexture(0, 0, W, H, 0.4, 'multiply');
      ctx.restore();
      // 透视门框（递进缩小）
      const doors = 7;
      for (let i = doors; i >= 1; i--) {
        const k = i / doors;
        const dw = lerp(20, W * 0.9, k);
        const dh = lerp(14, H * 0.9, k);
        const dx = lerp(vx, cx, k);
        const dy = lerp(vy, cy, k);
        const a = lerp(0.05, 0.4, 1 - k);
        ctx.strokeStyle = rgba(scale(P.fog, 1.4), a);
        ctx.lineWidth = lerp(0.5, 3, k);
        ctx.strokeRect(dx - dw / 2, dy - dh / 2, dw, dh);
      }
      // 远处尽头的影（fear 越高越近越清晰）
      const figZ = clamp(0.1 + fear * 0.35, 0, 1);
      const figH = lerp(H * 0.05, H * 0.5, figZ);
      drawSilhouette(vx + Math.sin(t * 0.0004) * 6, lerp(vy + 10, H * 0.85, figZ), figH, P.ink, 0.4 + fear * 0.4);
      drawFog(t, fear, { density: baseFog * 0.8, top: vy, bottom: H });
      drawParticles(layout.dust, t, { color: P.glow, alpha: 0.18, swayAmp: 0.01, scale: 1, dir: -1 }, fear);
      ghostFace(vx, vy + 4, H * 0.05, fear, t, 1);
    },

    /* ---- 封闭房间：家具剪影、墙上污渍 ---- */
    room(t, fear) {
      fillBase(P.fog, scale(P.fog, 0.6));
      applyTexture(0, 0, W, H, 0.5, 'multiply');
      // 后墙踢脚线/地面分界
      const floorY = H * 0.72;
      ctx.fillStyle = rgba(scale(P.ink, 1.2), 1);
      ctx.fillRect(0, floorY, W, H - floorY);
      ctx.strokeStyle = rgba(P.ink, 0.6); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, floorY); ctx.lineTo(W, floorY); ctx.stroke();
      // 墙上污渍
      for (const s of layout.stains) {
        const slow = 1 + Math.sin(t * 0.0003 + s.x * 10) * 0.05;
        drawStain(s.x * W, s.y * floorY, s.w * slow, s.h, P.blood, 0.10 + fear * 0.12);
      }
      // 家具剪影
      const fr = layout.r;
      const items = layout.furniture;
      items.forEach((it, idx) => {
        const fx = lerp(W * 0.2, W * 0.8, (idx + 0.5) / items.length);
        ctx.fillStyle = rgba(P.ink, 0.85);
        if (it === 'chair') {
          ctx.fillRect(fx - 18, floorY - 60, 6, 60); ctx.fillRect(fx - 18, floorY - 60, 36, 6); ctx.fillRect(fx + 12, floorY - 26, 6, 26); ctx.fillRect(fx - 18, floorY - 26, 36, 6);
        } else if (it === 'table') {
          ctx.fillRect(fx - 40, floorY - 44, 80, 8); ctx.fillRect(fx - 36, floorY - 44, 6, 44); ctx.fillRect(fx + 30, floorY - 44, 6, 44);
        } else if (it === 'bed') {
          ctx.fillRect(fx - 60, floorY - 30, 120, 30); ctx.fillRect(fx - 60, floorY - 50, 12, 50);
        } else if (it === 'frame') {
          ctx.strokeStyle = rgba(P.ink, 0.9); ctx.lineWidth = 4; ctx.strokeRect(fx - 22, H * 0.25, 44, 56);
        } else if (it === 'lamp') {
          ctx.fillRect(fx - 2, floorY - 80, 4, 80); ctx.beginPath(); ctx.moveTo(fx - 16, floorY - 80); ctx.lineTo(fx + 16, floorY - 80); ctx.lineTo(fx + 8, floorY - 100); ctx.lineTo(fx - 8, floorY - 100); ctx.closePath(); ctx.fill();
          // 暖光
          const fl = flicker(t, 1.5);
          const gg = ctx.createRadialGradient(fx, floorY - 90, 0, fx, floorY - 90, 120 * fl);
          gg.addColorStop(0, rgba(P.glow, 0.25 * fl)); gg.addColorStop(1, rgba(P.glow, 0));
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gg; ctx.fillRect(fx - 130, floorY - 220, 260, 260); ctx.restore();
        }
      });
      drawFog(t, fear, { density: baseFog * 0.5 });
      drawParticles(layout.dust, t, { color: P.glow, alpha: 0.12, swayAmp: 0.008, dir: 1 }, fear);
      // 角落里的脸
      ghostFace(W * 0.85, H * 0.3, H * 0.06, fear, t, 4);
    },

    /* ---- 黑色树林：雾、间隙里的眼睛/人形 ---- */
    forest(t, fear) {
      fillBase(mix(P.bg, P.accent, 0.15), P.ink);
      // 远雾光
      const moon = ctx.createRadialGradient(cx, H * 0.3, 0, cx, H * 0.3, H * 0.6);
      moon.addColorStop(0, rgba(P.fog, 0.4)); moon.addColorStop(1, rgba(P.fog, 0));
      ctx.fillStyle = moon; ctx.fillRect(0, 0, W, H);
      // 多层树（按 z 由远及近）
      for (const tr of layout.trees) {
        const x = tr.x * W;
        const th = lerp(H * 0.4, H * 1.05, tr.z);
        const tw = lerp(4, 26, tr.z) * tr.w;
        const sway = Math.sin(t * 0.0003 + tr.x * 9) * (4 + tr.z * 6) + tr.lean * 40;
        const a = lerp(0.3, 0.95, tr.z);
        ctx.fillStyle = rgba(P.ink, a);
        ctx.beginPath();
        ctx.moveTo(x - tw / 2, H);
        ctx.quadraticCurveTo(x - tw * 0.2 + sway * 0.3, H - th * 0.5, x - tw * 0.1 + sway, H - th);
        ctx.lineTo(x + tw * 0.1 + sway, H - th);
        ctx.quadraticCurveTo(x + tw * 0.2 + sway * 0.3, H - th * 0.5, x + tw / 2, H);
        ctx.closePath(); ctx.fill();
      }
      // 间隙中的眼睛
      for (const e of layout.eyeSlots) {
        const blink = (n1(t * 0.0008 + e.ph) + 1) * 0.5;
        const a = clamp((blink - (0.55 - fear * 0.4)) * 1.2, 0, 0.5);
        const r = H * 0.012 * (1 + fear * 0.5);
        drawEye(e.x * W, e.y * H, r, P.blood, a, Math.sin(t * 0.001 + e.ph));
      }
      // 深处人形
      if (fear > 0.4) {
        const x = cx + n1(t * 0.0003) * W * 0.2;
        drawSilhouette(x, H * 0.82, H * (0.2 + fear * 0.15), P.ink, 0.5 + fear * 0.3);
      }
      drawFog(t, fear, { density: baseFog + 0.2, layers: 4, bottom: H });
      drawParticles(layout.spores, t, { color: P.fog, alpha: 0.15, swayAmp: 0.02, dir: -1 }, fear);
    },

    /* ---- 向下深渊：坠落感、漂浮碎片 ---- */
    abyss(t, fear) {
      // 中心向外的暗色井
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, diag * 0.6);
      g.addColorStop(0, rgba(scale(P.ink, 0.4), 1));
      g.addColorStop(0.5, rgba(P.bg, 1));
      g.addColorStop(1, rgba(P.ink, 1));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // 同心环向外膨胀 = 坠落
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const rings = 10;
      for (let i = 0; i < rings; i++) {
        const phase = ((t * 0.00012 * (1 + fear * 0.8)) + i / rings) % 1;
        const r = phase * diag * 0.6;
        const a = (1 - phase) * 0.12;
        ctx.strokeStyle = rgba(P.accent, a);
        ctx.lineWidth = 1 + phase * 3;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
      }
      ctx.restore();
      // 漂浮上升的碎片（相对坠落感）
      ctx.save();
      for (const s of layout.shards) {
        const life = (t * 0.00006 * (1 + fear)) ;
        let yy = (s.y - life) ; yy = yy - Math.floor(yy);
        // 透视：靠近中心远，向外放大
        const px = lerp(cx, s.x * W, yy);
        const py = lerp(cy, s.y * H, yy);
        const scl = lerp(0.2, 1, yy) * s.z;
        const rot = s.rot + t * 0.0003 * s.spin;
        ctx.save();
        ctx.translate(px, py); ctx.rotate(rot);
        ctx.fillStyle = rgba(P.fog, 0.4 * yy);
        ctx.fillRect(-s.s * scl / 2, -s.s * scl / 2, s.s * scl, s.s * scl * 0.6);
        ctx.restore();
      }
      ctx.restore();
      drawFog(t, fear, { density: baseFog * 0.4, color: P.accent });
      ghostFace(cx, cy, H * 0.12, fear, t, 9);
    },

    /* ---- 镜面：镜中倒影与本体不一致 ---- */
    mirror(t, fear) {
      fillBase(scale(P.fog, 0.6), P.ink);
      const midY = H * 0.5;
      // 上半：房间剪影
      ctx.save();
      // 简单家具/人影“本体”
      const selfX = cx + Math.sin(t * 0.0004) * 10;
      ctx.fillStyle = rgba(P.ink, 0.8);
      drawSilhouette(selfX, midY, H * 0.32, P.ink, 0.8);
      ctx.restore();
      // 镜框分界
      ctx.fillStyle = rgba(scale(P.glow, 0.6), 0.4);
      ctx.fillRect(0, midY - 2, W, 4);
      // 下半：倒影——故意不一致（偏移/延迟/多一个）
      ctx.save();
      ctx.translate(0, midY * 2);
      ctx.scale(1, -1);
      ctx.globalAlpha = 0.7;
      // 倒影的“自我”位置滞后且偏移，fear 高时偏离更大
      const lag = Math.sin(t * 0.0004 - 0.6) * 10;
      const drift = fear * (n1(t * 0.0005) * W * 0.25);
      drawSilhouette(selfX + lag + drift, midY, H * 0.32 * (1 + fear * 0.1), P.ink, 0.7);
      // fear 高：镜中多出一个、或回头（用第二个影暗示）
      if (fear > 0.5) {
        drawSilhouette(selfX + drift - W * 0.15, midY, H * 0.30, mix(P.ink, P.blood, 0.3), 0.4 * fear);
      }
      ctx.restore();
      // 镜面水汽/划痕纹理
      applyTexture(0, 0, W, midY, 0.25, 'overlay');
      drawFog(t, fear, { density: baseFog * 0.5, top: 0, bottom: midY });
      // 镜中浮现的脸
      ghostFace(selfX, midY * 1.5, H * 0.07, fear, t, 14);
      drawParticles(layout.dust, t, { color: P.glow, alpha: 0.1, swayAmp: 0.006, dir: 1 }, fear);
    },

    /* ---- 有机肉墙：脉动、毛孔/血管纹理 ---- */
    flesh(t, fear) {
      // 整屏肉色底 + 脉动
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.0016 * (1 + fear * 0.5));
      const base = mix(P.blood, scale(P.blood, 1.6), pulse * 0.4);
      fillBase(scale(base, 0.7), base);
      // 噪声纹理（有机起伏）
      applyTexture(0, 0, W, H, 0.55, 'overlay');
      // 血管：随机分叉细线（预生成布局复用 trees 槽位的不规则性）
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = rgba(scale(P.blood, 0.4), 0.5);
      const vr = layout.r;
      for (let i = 0; i < 14; i++) {
        const sx = (i / 14) * W;
        ctx.lineWidth = 1 + (i % 3);
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        let x = sx, y = 0;
        for (let s = 0; s < 8; s++) {
          x += n1(i * 3 + s + t * 0.0001) * 30;
          y += H / 8;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
      // 毛孔/孔洞（脉动开合）
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      for (const s of layout.stains) {
        const open = 0.6 + 0.4 * Math.sin(t * 0.002 + s.x * 8);
        const rr = s.w * (0.5 + open);
        const g = ctx.createRadialGradient(s.x * W, s.y * H, 0, s.x * W, s.y * H, rr);
        g.addColorStop(0, rgba(P.ink, 0.8));
        g.addColorStop(1, rgba(P.ink, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(s.x * W, s.y * H, rr, 0, TAU); ctx.fill();
      }
      ctx.restore();
      // fear：肉里睁开的眼
      if (fear > 0.45) {
        for (const e of layout.eyeSlots.slice(0, 3)) {
          const a = clamp((n1(t * 0.001 + e.ph) - 0.4) * fear, 0, 0.5);
          drawEye(e.x * W, e.y * H, H * 0.02, P.glow, a, Math.sin(t * 0.001));
        }
      }
      // 整体脉动暗角
      ctx.fillStyle = rgba(P.ink, 0.15 + pulse * 0.1);
      ctx.fillRect(0, 0, W, H);
    },

    /* ---- 电视雪花：信号噪点中浮现人脸 ---- */
    static(t, fear) {
      ctx.fillStyle = rgba(P.bg, 1); ctx.fillRect(0, 0, W, H);
      // 雪花：平铺移动的颗粒块（高对比）
      if (grainCanvas) {
        ctx.save();
        ctx.globalAlpha = 0.35 + fear * 0.2;
        const g = 128;
        const ox = (Math.random() * g) | 0, oy = (Math.random() * g) | 0; // 雪花本就随机
        for (let y = -oy; y < H; y += g) for (let x = -ox; x < W; x += g) ctx.drawImage(grainCanvas, x, y);
        ctx.restore();
      }
      // 水平扫描滚动条
      const bar = ((t * 0.12) % (H + 80)) - 40;
      const bg = ctx.createLinearGradient(0, bar - 40, 0, bar + 40);
      bg.addColorStop(0, 'rgba(255,255,255,0)');
      bg.addColorStop(0.5, rgba(P.glow, 0.12));
      bg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bg; ctx.fillRect(0, bar - 40, W, 80);
      // 信号中浮现的脸（周期性增强）
      const reveal = clamp(Math.sin(t * 0.0006) * 0.5 + 0.5 - (0.4 - fear * 0.4), 0, 1);
      if (reveal > 0.05) {
        ctx.save();
        ctx.globalAlpha = reveal * (0.4 + fear * 0.3);
        ctx.globalCompositeOperation = 'screen';
        // 用 ghostFace 的更实体版本
        const fg = mix(P.fog, P.glow, 0.5);
        const s = H * 0.22;
        let grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, s);
        grad.addColorStop(0, rgba(fg, 0.6)); grad.addColorStop(1, rgba(fg, 0));
        ctx.fillStyle = grad; ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.7, s, 0, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = rgba(P.ink, 0.9);
        ctx.beginPath(); ctx.ellipse(cx - s * 0.28, cy - s * 0.2, s * 0.13, s * 0.09, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx + s * 0.28, cy - s * 0.2, s * 0.13, s * 0.09, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx, cy + s * 0.5, s * 0.28, s * 0.05, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      // RGB 错位（轻微）
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.04 + fear * 0.06;
      ctx.fillStyle = rgba(P.blood, 1); ctx.fillRect(-2 - fear * 4, 0, W, H);
      ctx.fillStyle = rgba(P.accent, 1); ctx.fillRect(2 + fear * 4, 0, W, H);
      ctx.restore();
    },

    /* ---- 地窖：楼梯向下、摇曳光源 ---- */
    cellar(t, fear) {
      fillBase(scale(P.fog, 0.5), P.ink);
      applyTexture(0, 0, W, H, 0.5, 'multiply');
      // 向下的石阶（透视收束到下方暗处）
      const topY = H * 0.2, botY = H, vx = cx;
      const steps = 10;
      for (let i = 0; i < steps; i++) {
        const k = i / steps;
        const y = lerp(topY, botY, k * k);
        const w = lerp(W * 0.2, W * 0.95, k);
        const sh = lerp(6, 30, k);
        ctx.fillStyle = rgba(mix(P.fog, P.ink, k * 0.8), 1);
        ctx.fillRect(vx - w / 2, y, w, sh);
        ctx.fillStyle = rgba(P.ink, 0.7);
        ctx.fillRect(vx - w / 2, y + sh, w, 3);
      }
      // 底部黑暗深渊
      const dg = ctx.createRadialGradient(vx, botY, 0, vx, botY, H * 0.4);
      dg.addColorStop(0, rgba(P.ink, 1)); dg.addColorStop(1, rgba(P.ink, 0));
      ctx.fillStyle = dg; ctx.fillRect(0, H * 0.6, W, H * 0.4);
      // 摇曳光源（顶部一盏）
      const fl = flicker(t, 1.2);
      const lx = vx + Math.sin(t * 0.0011) * 14, ly = topY - 10;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, H * 0.55 * fl);
      lg.addColorStop(0, rgba(P.glow, 0.4 * fl)); lg.addColorStop(0.5, rgba(P.glow, 0.12 * fl)); lg.addColorStop(1, rgba(P.glow, 0));
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H); ctx.restore();
      drawFog(t, fear, { density: baseFog + 0.1, bottom: H, top: H * 0.4 });
      // 深处探出的东西
      if (fear > 0.5) drawEye(vx + n1(t * 0.001) * 30, botY - 30, H * 0.02, P.blood, fear * 0.5, 0);
      drawParticles(layout.dust, t, { color: P.glow, alpha: 0.14, swayAmp: 0.01, dir: 1 }, fear);
    },

    /* ---- 病房走廊：病床、滴落、惨白冷光 ---- */
    hospital(t, fear) {
      // 惨白冷底
      fillBase(scale(mix(P.fog, P.accent, 0.4), 1.3), scale(P.fog, 0.7));
      const vx = cx, vy = cy - H * 0.04;
      // 地板透视
      ctx.fillStyle = rgba(scale(P.fog, 1.1), 1);
      ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(0, H); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      // 天花日光灯（一排，闪烁）
      const lamps = 5;
      for (let i = 1; i <= lamps; i++) {
        const k = i / lamps;
        const ly = lerp(vy, H * 0.1, 0) + lerp(0, -H * 0.02, k);
        const lx = vx, ly2 = lerp(vy, H * 0.05, k * 0.0 + (1 - k));
        const yy = lerp(vy - 4, 4, k);
        const ww = lerp(8, W * 0.5, k);
        const fl = flicker(t + i * 300, 1.5 + i);
        ctx.fillStyle = rgba(scale(P.glow, 1.4), 0.15 + 0.4 * fl * k);
        ctx.fillRect(vx - ww / 2, yy, ww, lerp(2, 10, k));
        // 灯下光
        if (k > 0.4) {
          const lg = ctx.createRadialGradient(vx, yy, 0, vx, yy, ww);
          lg.addColorStop(0, rgba(P.glow, 0.1 * fl * k)); lg.addColorStop(1, rgba(P.glow, 0));
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = lg; ctx.fillRect(vx - ww, yy, ww * 2, H); ctx.restore();
        }
      }
      // 两侧病床（透视递进）
      for (let i = layout.beds; i >= 1; i--) {
        const k = i / (layout.beds + 1);
        const y = lerp(vy + 20, H * 0.92, k);
        const bw = lerp(10, W * 0.22, k);
        const bh = lerp(4, H * 0.1, k);
        for (const side of [-1, 1]) {
          const bx = vx + side * lerp(20, W * 0.5, k);
          ctx.fillStyle = rgba(scale(P.fog, 1.2), 0.9);
          ctx.fillRect(bx - bw / 2, y - bh, bw, bh);
          // 床上隆起的形（被单下）—— fear 高时微动
          ctx.fillStyle = rgba(scale(P.fog, 0.85), 0.9);
          const lump = bh * (0.5 + (fear > 0.5 ? Math.abs(Math.sin(t * 0.001 + i)) * 0.2 : 0));
          ctx.beginPath(); ctx.ellipse(bx, y - bh, bw * 0.4, lump, 0, Math.PI, TAU); ctx.fill();
        }
      }
      // 滴落（点滴/血）
      const dripX = vx + (n1(seed) * W * 0.3);
      const dt = (t * 0.18) % (H * 0.4);
      ctx.fillStyle = rgba(P.blood, 0.5);
      ctx.beginPath(); ctx.arc(dripX, H * 0.4 + dt, 2.2, 0, TAU); ctx.fill();
      // 地面积渍
      ctx.fillStyle = rgba(P.blood, 0.15);
      ctx.beginPath(); ctx.ellipse(dripX, H * 0.86, 18, 5, 0, 0, TAU); ctx.fill();
      drawFog(t, fear, { density: baseFog * 0.6, color: scale(P.fog, 1.2) });
      // 走廊尽头的影
      drawSilhouette(vx, lerp(vy + 8, H * 0.8, clamp(fear * 0.5, 0, 0.6)), lerp(H * 0.04, H * 0.35, fear), P.accent, 0.3 + fear * 0.4);
      drawGrain(t, fear * 0.5);
    },

    /* ---- 纯粹虚空：极简、一个微小光点或文字 ---- */
    void(t, fear) {
      // 近乎全黑，极缓渐变
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, diag * 0.5);
      g.addColorStop(0, rgba(scale(P.bg, 1.2), 1));
      g.addColorStop(1, rgba(P.ink, 1));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // 一个微小、呼吸的光点
      const breathe = 0.5 + 0.5 * Math.sin(t * 0.0008);
      const drift = { x: cx + Math.sin(t * 0.0003) * W * 0.05, y: cy + Math.cos(t * 0.00023) * H * 0.05 };
      const pr = (2 + breathe * 3) * (1 + intensity);
      const pg = ctx.createRadialGradient(drift.x, drift.y, 0, drift.x, drift.y, pr * 14);
      pg.addColorStop(0, rgba(scale(P.glow, 1.4), 0.9 * (0.5 + breathe * 0.5)));
      pg.addColorStop(0.2, rgba(P.glow, 0.3));
      pg.addColorStop(1, rgba(P.glow, 0));
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(drift.x, drift.y, pr * 14, 0, TAU); ctx.fill(); ctx.restore();
      // fear：光点周围浮现极淡的注视者轮廓 / 光点远离
      if (fear > 0.4) {
        ghostFace(drift.x, drift.y - H * 0.1, H * 0.1, fear, t, 21);
        // 远处第二个更冷的点
        const fx = cx - Math.sin(t * 0.0004) * W * 0.2 * fear;
        const fg2 = ctx.createRadialGradient(fx, cy, 0, fx, cy, 30);
        fg2.addColorStop(0, rgba(P.blood, 0.3 * fear)); fg2.addColorStop(1, rgba(P.blood, 0));
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = fg2;
        ctx.beginPath(); ctx.arc(fx, cy, 30, 0, TAU); ctx.fill(); ctx.restore();
      }
      drawGrain(t, fear * 0.3);
    },

    /* ---- 深海下沉：光线衰减、巨大暗影掠过 ---- */
    ocean(t, fear) {
      // 上亮下暗的水柱（光线衰减）
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgba(scale(P.accent, 1.1), 1));
      g.addColorStop(0.4, rgba(mix(P.accent, P.bg, 0.6), 1));
      g.addColorStop(1, rgba(P.ink, 1));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // 上方光束（god rays）
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const bx = lerp(W * 0.2, W * 0.8, i / 4) + Math.sin(t * 0.0003 + i) * 30;
        const bw = lerp(30, 80, n1(i + t * 0.0002) * 0.5 + 0.5);
        const bg = ctx.createLinearGradient(bx, 0, bx, H * 0.7);
        bg.addColorStop(0, rgba(scale(P.glow, 1.2), 0.06));
        bg.addColorStop(1, rgba(P.glow, 0));
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.moveTo(bx - bw * 0.3, 0); ctx.lineTo(bx + bw * 0.3, 0); ctx.lineTo(bx + bw, H * 0.7); ctx.lineTo(bx - bw, H * 0.7); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // 上升气泡 = 下沉感
      drawParticles(layout.bubbles, t, { color: scale(P.accent, 1.3), alpha: 0.25, swayAmp: 0.015, dir: -1, blend: 'lighter' }, fear);
      // 巨大暗影缓慢掠过（leviathan）
      const passT = ((t * 0.00003 * (1 + fear)) % 1);
      const sx = lerp(-W * 0.5, W * 1.5, passT);
      const sy = H * (0.45 + Math.sin(t * 0.0002) * 0.1);
      const sl = W * 0.7, sh = H * 0.18;
      const a = Math.sin(passT * Math.PI) * (0.25 + fear * 0.3);
      if (a > 0.01) {
        ctx.save();
        ctx.fillStyle = rgba(P.ink, a);
        ctx.beginPath();
        ctx.ellipse(sx, sy, sl * 0.5, sh, 0.1, 0, TAU);
        ctx.fill();
        // 尾鳍暗示
        ctx.beginPath();
        ctx.moveTo(sx - sl * 0.5, sy);
        ctx.lineTo(sx - sl * 0.62, sy - sh);
        ctx.lineTo(sx - sl * 0.62, sy + sh);
        ctx.closePath(); ctx.fill();
        // fear 高：暗影上的一只冷眼
        if (fear > 0.5) drawEye(sx + sl * 0.3, sy - sh * 0.3, H * 0.014, P.glow, a * 1.5, 0);
        ctx.restore();
      }
      // 漂浮微粒/浮游
      drawParticles(layout.spores, t, { color: P.fog, alpha: 0.12, swayAmp: 0.02, dir: -1 }, fear);
      // 深度暗压
      ctx.fillStyle = rgba(P.ink, 0.1 + fear * 0.15); ctx.fillRect(0, H * 0.6, W, H * 0.4);
    },

    /* ---- 阁楼：横梁、悬挂物剪影、灰尘漂浮 ---- */
    attic(t, fear) {
      fillBase(scale(P.fog, 0.7), P.ink);
      applyTexture(0, 0, W, H, 0.45, 'multiply');
      // 斜屋顶（两面）
      ctx.fillStyle = rgba(scale(P.ink, 1.3), 1);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(cx, H * 0.18); ctx.lineTo(cx, H * 0.55); ctx.lineTo(0, H * 0.4); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(W, 0); ctx.lineTo(cx, H * 0.18); ctx.lineTo(cx, H * 0.55); ctx.lineTo(W, H * 0.4); ctx.closePath(); ctx.fill();
      // 中央横梁
      ctx.fillStyle = rgba(P.ink, 1);
      ctx.fillRect(cx - 6, H * 0.18, 12, H * 0.5);
      ctx.fillRect(0, H * 0.2, W, 10);
      // 一束窗光（屋顶天窗）
      const fl = 0.6 + 0.4 * Math.sin(t * 0.0005);
      const wg = ctx.createLinearGradient(cx, H * 0.18, cx - W * 0.1, H);
      wg.addColorStop(0, rgba(P.glow, 0.18 * fl)); wg.addColorStop(1, rgba(P.glow, 0));
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = wg;
      ctx.beginPath(); ctx.moveTo(cx - 30, H * 0.18); ctx.lineTo(cx + 30, H * 0.18); ctx.lineTo(cx - W * 0.1, H); ctx.lineTo(cx - W * 0.25, H); ctx.closePath(); ctx.fill(); ctx.restore();
      // 悬挂物剪影（从横梁垂下，缓慢摆动）
      for (const hg of layout.hangs) {
        const x = hg.x * W;
        const len = hg.len * H;
        const sway = Math.sin(t * 0.0006 + hg.ph) * (4 + len * 0.02) * (1 + fear);
        ctx.strokeStyle = rgba(P.ink, 0.7); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, H * 0.2); ctx.lineTo(x + sway, H * 0.2 + len); ctx.stroke();
        // 末端物（布袋/形）
        ctx.fillStyle = rgba(P.ink, 0.85);
        ctx.beginPath(); ctx.ellipse(x + sway, H * 0.2 + len, 8, 16, 0, 0, TAU); ctx.fill();
        // fear：某个悬挂物像人形
        if (fear > 0.6 && hg.ph > 4) {
          drawSilhouette(x + sway, H * 0.2 + len + 24, 40, P.ink, 0.5 * fear);
        }
      }
      // 灰尘在光束里漂浮
      drawParticles(layout.dust, t, { color: P.glow, alpha: 0.2, swayAmp: 0.012, dir: 1 }, fear);
      drawFog(t, fear, { density: baseFog * 0.4, bottom: H, top: H * 0.5 });
      ghostFace(cx - W * 0.18, H * 0.6, H * 0.06, fear, t, 24);
    },

    /* ---- 废弃教堂：彩窗残光、长椅、十字剪影 ---- */
    church(t, fear) {
      fillBase(scale(P.fog, 0.5), P.ink);
      const vx = cx, vy = H * 0.42;
      // 拱顶透视（地板）
      ctx.fillStyle = rgba(scale(P.ink, 1.2), 1);
      ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(0, H); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      // 尽头彩窗（圆/尖拱），透出残光
      const winColors = [P.blood, P.accent, P.glow];
      const wh = H * 0.3, ww = W * 0.16;
      const wx = vx, wy = vy - wh * 0.2;
      const bloom = 0.5 + 0.5 * Math.sin(t * 0.0006);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const c = winColors[layout.windowHue[i]];
        const ox = (i - 1) * ww * 1.1;
        const g = ctx.createRadialGradient(wx + ox, wy, 0, wx + ox, wy, ww);
        g.addColorStop(0, rgba(c, 0.3 * bloom)); g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(wx + ox - ww * 0.3, wy + wh * 0.5);
        ctx.lineTo(wx + ox - ww * 0.3, wy - wh * 0.2);
        ctx.quadraticCurveTo(wx + ox, wy - wh * 0.6, wx + ox + ww * 0.3, wy - wh * 0.2);
        ctx.lineTo(wx + ox + ww * 0.3, wy + wh * 0.5);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // 十字剪影（逆光，黑）
      ctx.fillStyle = rgba(P.ink, 0.9);
      ctx.fillRect(vx - 4, vy - wh * 0.5, 8, wh * 0.7);
      ctx.fillRect(vx - 18, vy - wh * 0.3, 36, 7);
      // 两侧长椅（透视递进）
      for (let i = layout.pews; i >= 1; i--) {
        const k = i / (layout.pews + 1);
        const y = lerp(vy + 20, H * 0.95, k);
        const pw = lerp(14, W * 0.34, k);
        const ph = lerp(4, 18, k);
        for (const side of [-1, 1]) {
          const px = vx + side * lerp(24, W * 0.36, k);
          ctx.fillStyle = rgba(P.ink, 0.8);
          ctx.fillRect(px - pw / 2, y - ph, pw, ph);
        }
      }
      // 长椅上偶尔的坐影
      if (fear > 0.45) {
        const k = 0.6;
        const y = lerp(vy + 20, H * 0.95, k);
        drawSilhouette(vx - lerp(24, W * 0.36, k) + 10, y, lerp(4, 18, k) * 3, P.ink, 0.5 * fear);
      }
      drawFog(t, fear, { density: baseFog * 0.6, bottom: H });
      // 浮尘
      drawParticles(layout.dust, t, { color: mix(P.glow, winColors[layout.windowHue[0]], 0.4), alpha: 0.16, swayAmp: 0.01, dir: 1 }, fear);
    },

    /* ---- 废弃地铁隧道：轨道延伸、闪烁灯、尽头的东西 ---- */
    subway(t, fear) {
      fillBase(scale(P.fog, 0.6), P.ink);
      const vx = cx, vy = cy;
      // 隧道拱（同心透视环）
      ctx.save();
      for (let i = 12; i >= 1; i--) {
        const k = i / 12;
        const rw = lerp(W * 0.04, W * 0.95, k);
        const rh = lerp(H * 0.04, H * 1.05, k);
        ctx.strokeStyle = rgba(mix(P.fog, P.ink, 1 - k), lerp(0.5, 0.1, k));
        ctx.lineWidth = lerp(1, 4, k);
        ctx.beginPath(); ctx.ellipse(vx, vy, rw / 2, rh / 2, 0, 0, TAU); ctx.stroke();
      }
      ctx.restore();
      // 轨道（两条向灭点收束的线 + 枕木）
      ctx.strokeStyle = rgba(scale(P.glow, 0.8), 0.3); ctx.lineWidth = 2;
      const railSpread = W * 0.06;
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(vx + side * 4, vy); ctx.lineTo(vx + side * railSpread * 6, H); ctx.stroke();
      }
      for (let i = 1; i < 12; i++) {
        const k = i / 12;
        const y = lerp(vy, H, k * k);
        const sw = lerp(8, railSpread * 12, k);
        ctx.strokeStyle = rgba(P.ink, lerp(0.1, 0.5, k)); ctx.lineWidth = lerp(1, 4, k);
        ctx.beginPath(); ctx.moveTo(vx - sw / 2, y); ctx.lineTo(vx + sw / 2, y); ctx.stroke();
      }
      // 隧道壁挂的灯（闪烁，有坏的）
      for (const lp of layout.lamps) {
        const k = lp.z;
        const y = lerp(vy - H * 0.3, -H * 0.05, 0) + lerp(vy * 0.4, -10, k);
        const x = vx + (lp.ph > Math.PI ? 1 : -1) * lerp(W * 0.02, W * 0.46, k);
        const yy = lerp(vy - 4, H * 0.05, k);
        const fl = lp.bad ? (flicker(t + lp.ph * 100, 3) * (n1(t * 0.005 + lp.ph) > 0.3 ? 1 : 0.1)) : flicker(t, 0.6);
        const lg = ctx.createRadialGradient(x, yy, 0, x, yy, lerp(20, 120, k) * fl);
        lg.addColorStop(0, rgba(P.glow, 0.4 * fl)); lg.addColorStop(1, rgba(P.glow, 0));
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = lg;
        ctx.beginPath(); ctx.arc(x, yy, lerp(20, 120, k) * fl, 0, TAU); ctx.fill(); ctx.restore();
      }
      // 尽头的东西（灭点处的影，fear 越高越出来）
      const out = clamp(fear, 0, 1);
      const figH = lerp(H * 0.03, H * 0.4, out);
      drawSilhouette(vx + Math.sin(t * 0.0005) * 4, lerp(vy + 4, H * 0.9, out * 0.6), figH, P.ink, 0.4 + fear * 0.5);
      drawFog(t, fear, { density: baseFog + 0.1, color: mix(P.fog, P.accent, 0.3) });
      drawGrain(t, fear * 0.6);
      ghostFace(vx, vy, H * 0.04, fear, t, 30);
    },

    /* ---- 枯萎花园：藤蔓、雕像、迷宫感 ---- */
    garden(t, fear) {
      fillBase(mix(P.bg, P.accent, 0.2), P.ink);
      // 远处雾月
      const mg = ctx.createRadialGradient(cx, H * 0.25, 0, cx, H * 0.25, H * 0.5);
      mg.addColorStop(0, rgba(P.fog, 0.3)); mg.addColorStop(1, rgba(P.fog, 0));
      ctx.fillStyle = mg; ctx.fillRect(0, 0, W, H);
      // 迷宫感：层层后退的树篱墙（透视矩形框）
      for (let i = 5; i >= 1; i--) {
        const k = i / 5;
        const mw = lerp(W * 0.1, W * 0.98, k);
        const mh = lerp(H * 0.06, H * 0.7, k);
        const my = lerp(cy, H * 0.95, k);
        ctx.fillStyle = rgba(mix(P.ink, P.accent, k * 0.3 * (1 - k)), lerp(0.9, 0.4, k));
        // 两侧树篱
        ctx.fillRect(cx - mw / 2, my - mh, mw * 0.12, mh);
        ctx.fillRect(cx + mw / 2 - mw * 0.12, my - mh, mw * 0.12, mh);
      }
      // 中央通往深处的小径暗影
      const pg = ctx.createLinearGradient(cx, cy, cx, H);
      pg.addColorStop(0, rgba(P.ink, 0)); pg.addColorStop(1, rgba(P.ink, 0.6));
      ctx.fillStyle = pg; ctx.fillRect(cx - W * 0.15, cy, W * 0.3, H * 0.5);
      // 枯藤（从顶部/两侧垂下，缠绕摆动）
      ctx.save();
      ctx.strokeStyle = rgba(scale(P.ink, 1.4), 0.6);
      for (const v of layout.vines) {
        const x = v.x * W;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        let yy = 0, xx = x;
        const len = v.len * H;
        while (yy < len) {
          yy += 12;
          xx += Math.sin(yy * 0.05 + v.ph + t * 0.0004) * 6;
          ctx.lineTo(xx, yy);
        }
        ctx.stroke();
        // 枯花/刺
        ctx.fillStyle = rgba(P.blood, 0.3);
        ctx.beginPath(); ctx.arc(xx, yy, 3, 0, TAU); ctx.fill();
      }
      ctx.restore();
      // 雕像（苍白人形剪影，静止——比动的更不安）
      for (let i = 0; i < layout.statues; i++) {
        const sx = lerp(W * 0.25, W * 0.75, layout.statues === 1 ? 0.5 : i / (layout.statues - 1));
        const sy = H * 0.8;
        ctx.save();
        // 略带苍白石质
        drawSilhouette(sx, sy, H * 0.26, mix(P.ink, P.fog, 0.5), 0.7);
        // 基座
        ctx.fillStyle = rgba(P.ink, 0.8);
        ctx.fillRect(sx - 18, sy, 36, 14);
        ctx.restore();
        // fear：雕像“看向”你（加眼）
        if (fear > 0.5) drawEye(sx, sy - H * 0.24, H * 0.01, P.glow, (fear - 0.5) * 0.8, 0);
      }
      drawFog(t, fear, { density: baseFog + 0.15, bottom: H, layers: 4 });
      drawParticles(layout.spores, t, { color: P.fog, alpha: 0.12, swayAmp: 0.02, dir: -1 }, fear);
    },
  };

  /* ============================================================
   * resize / render / destroy
   * ========================================================== */
  function resize() {
    W = canvas.width || canvas.clientWidth || 1;
    H = canvas.height || canvas.clientHeight || 1;
    cx = W / 2; cy = H / 2;
    diag = Math.hypot(W, H);
    bakeTexture();
    bakeGrain();
    buildLayout();
  }

  // 主渲染：每帧
  function render(t, fear) {
    if (destroyed || W === 0) return;
    fear = clamp(fear ?? level.fear ?? 0, 0, 1);

    // 整体 fear 抖动（轻微平移整个画面）
    const j = jitter(t, fear, 1);
    ctx.save();
    if (fear > 0.15) ctx.translate(j.x, j.y);

    // 选择场景（缺失则兜底 corridor）
    const draw = SCENES[scene] || SCENES.corridor;
    draw(t, fear);

    // 场景之上的 motif 点缀
    drawMotifs(t, fear);

    ctx.restore();

    // 全屏后处理：颗粒 + 暗角（最后叠加，覆盖抖动留下的边）
    drawGrain(t, fear);
    drawVignette(fear);

    // fear 极高时偶发瞬闪暗（潜意识惊吓，克制）
    if (fear > 0.7 && n1(t * 0.0006 + 999) > 0.93) {
      ctx.fillStyle = rgba(P.ink, 0.5);
      ctx.fillRect(0, 0, W, H);
    }
  }

  function destroy() {
    destroyed = true;
    texCanvas = texCtx = null;
    grainCanvas = grainCtx = null;
    layout = null;
  }

  // 初始化尺寸/缓存
  resize();

  return { render, resize, destroy };
}
