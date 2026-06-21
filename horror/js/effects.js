// effects.js —— 视觉后期特效层（CRT / 故障 / 暗角 / 抖动 / 闪光 / 色差）
// 职责：在 #effects-layer（覆盖于 canvas 之上、UI 之下）叠加一组覆盖层，
//       由 fear（恐惧值）实时驱动其强度，并提供一次性事件特效（glitch/shake/flash/vignettePulse）。
//
// 性能原则：
//   - 多数效果用纯 CSS 覆盖层（transform / opacity / 渐变），GPU 友好，避免频繁 layout。
//   - 仅噪点与进行中的 glitch 用一个内部 RAF 主循环逐帧驱动；无活动效果时自动停止以省电。
//   - 噪点用一个小尺寸 canvas（每隔几帧重绘随机噪点）放大平铺，开销极低。
//   - 所有覆盖层 pointer-events:none，绝不挡住下方互动。
//
// 无障碍 / 设置：尊重 State.settings.reduceMotion 与 State.settings.effects（容错读取）。
//   - effects=false：禁用全部覆盖层（layer 隐藏）。
//   - reduceMotion=true：禁用滚动/抖动/逐帧噪点等动态，仅保留极弱的静态暗角。
//
// 对接 CSS（css/effects.css 由样式 agent 负责，可选增强）——本文件用到的 class：
//   .fx-root            特效根容器（pointer-events:none，铺满）
//   .fx-scanlines       CRT 扫描线层（repeating-linear-gradient）
//   .fx-scanlines--roll 扫描线缓慢滚动动画修饰
//   .fx-noise           噪点/颗粒层（背景由 JS 注入 canvas dataURL 或 CSS）
//   .fx-vignette        暗角层（径向渐变）
//   .fx-vignette--pulse 暗角脉冲一次的动画修饰
//   .fx-aberration      色差层容器（红/青错位边缘叠加）
//   .fx-aberration__r / .fx-aberration__c  红 / 青 两个错位子层
//   .fx-flash           全屏闪光层
//   .fx-glitch          故障层容器（内含随机错位条 .fx-glitch__bar）
//   .fx-glitch__bar     单条水平错位/色彩分离条
//   .fx-shaking         施加在 #game 上的抖动修饰类（CSS 可定义关键帧；本文件另有 JS 兜底）
// 说明：以上 class 若 CSS 缺失，本文件均提供内联样式兜底，保证模块独立可用。

import { RNG } from './rng.js';

// 容错读取 State：State agent 的文件可能尚未就绪或导出形态不同，全部包在 try 中。
let State = null;
try {
  // 动态 import 失败不影响主功能（默认开启全部、不减弱动态）。
  const mod = await import('./state.js');
  State = mod.State || mod.default || null;
} catch (_) {
  State = null;
}

// 读取设置（容错）：返回 { effects, reduceMotion }
function readSettings() {
  try {
    const snap = State && typeof State.get === 'function' ? State.get() : (State || {});
    const s = (snap && snap.settings) || {};
    return {
      effects: s.effects !== false,        // 默认开
      reduceMotion: s.reduceMotion === true // 默认不减弱
    };
  } catch (_) {
    return { effects: true, reduceMotion: false };
  }
}

// 数值钳制
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

export const Effects = (() => {
  // ── 内部状态 ──────────────────────────────────────────────
  let root = null;            // .fx-root
  let layerEl = null;         // 外部传入的 #effects-layer
  let els = {};               // 各覆盖子层 DOM 引用
  let noiseCanvas = null;     // 噪点离屏小 canvas
  let noiseCtx = null;
  let rng = new RNG('effects-default');

  let rafId = 0;              // 主循环句柄
  let running = false;        // 主循环是否在跑
  let lastNoiseFrame = 0;     // 噪点节流计数

  let fear = 0;               // 当前恐惧值 0..1
  let baseIntensity = 0.5;    // apply(level) 设定的基线强度（art.intensity）
  let mood = 'dread';         // 当前情绪（影响色差/闪光基调）

  // 进行中的一次性效果
  let glitchUntil = 0;        // glitch 持续到的时间戳
  let glitchSeed = 0;         // 本次 glitch 的随机种子
  let shakeUntil = 0;         // shake 持续到的时间戳
  let shakeTarget = null;     // 被抖动的元素（#game 优先，否则 root）

  // 偶发抖动调度（fear 越高频率越高）
  let nextSpontaneousShake = 0;

  // ── 工具：创建子层 ────────────────────────────────────────
  function mk(cls, inlineStyle) {
    const d = document.createElement('div');
    d.className = cls;
    // 公共兜底：铺满、不挡点击
    d.style.position = 'absolute';
    d.style.inset = '0';
    d.style.pointerEvents = 'none';
    d.style.willChange = 'opacity, transform';
    if (inlineStyle) Object.assign(d.style, inlineStyle);
    return d;
  }

  // 生成噪点 canvas 的 dataURL（小尺寸，平铺放大）
  function paintNoise() {
    if (!noiseCtx) return;
    const w = noiseCanvas.width, h = noiseCanvas.height;
    const img = noiseCtx.createImageData(w, h);
    const data = img.data;
    const r = rng;
    for (let i = 0; i < data.length; i += 4) {
      const v = (r.next() * 255) | 0;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
      data[i + 3] = 255;
    }
    noiseCtx.putImageData(img, 0, 0);
    // 用 dataURL 作为噪点层背景；放大平铺产生颗粒感
    try {
      els.noise.style.backgroundImage = `url(${noiseCanvas.toDataURL()})`;
      els.noise.style.backgroundSize = '128px 128px';
      els.noise.style.imageRendering = 'pixelated';
    } catch (_) { /* toDataURL 在某些环境受限，静默降级 */ }
  }

  // ── mount：建立特效子层 ──────────────────────────────────
  function mount(_layerEl) {
    layerEl = _layerEl;
    if (!layerEl) return;
    destroyDom(); // 防重复挂载

    root = mk('fx-root', { overflow: 'hidden', mixBlendMode: 'normal' });

    // 1) CRT 扫描线层：细密水平暗线 + 轻微滚动
    els.scanlines = mk('fx-scanlines fx-scanlines--roll', {
      backgroundImage:
        'repeating-linear-gradient(0deg, rgba(0,0,0,0.0) 0px, rgba(0,0,0,0.0) 1px, rgba(0,0,0,0.28) 2px, rgba(0,0,0,0.28) 3px)',
      backgroundSize: '100% 3px',
      mixBlendMode: 'multiply',
      opacity: '0'
    });

    // 2) 噪点层（背景图由 JS 逐帧更新）
    els.noise = mk('fx-noise', {
      mixBlendMode: 'overlay',
      opacity: '0'
    });
    noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = 128; noiseCanvas.height = 128;
    noiseCtx = noiseCanvas.getContext('2d');

    // 3) 暗角层（径向渐变；半径/浓度随 fear 收紧，用 CSS 变量驱动）
    els.vignette = mk('fx-vignette', {
      backgroundImage:
        'radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.85) 100%)',
      opacity: '0.4',
      transformOrigin: 'center center'
    });

    // 4) 色差层：红 / 青 两层错位叠加（screen 混合模拟通道分离）
    els.aberration = mk('fx-aberration', { mixBlendMode: 'screen', opacity: '0' });
    els.aberrationR = mk('fx-aberration__r', {
      position: 'absolute', inset: '0',
      boxShadow: 'inset 2px 0 0 rgba(255,0,40,0.0)',
      background:
        'linear-gradient(90deg, rgba(255,0,40,0.10) 0%, rgba(255,0,40,0) 6%, rgba(255,0,40,0) 94%, rgba(255,0,40,0.10) 100%)',
      transform: 'translateX(0px)'
    });
    els.aberrationC = mk('fx-aberration__c', {
      position: 'absolute', inset: '0',
      background:
        'linear-gradient(90deg, rgba(0,255,230,0.10) 0%, rgba(0,255,230,0) 6%, rgba(0,255,230,0) 94%, rgba(0,255,230,0.10) 100%)',
      transform: 'translateX(0px)'
    });
    els.aberration.appendChild(els.aberrationR);
    els.aberration.appendChild(els.aberrationC);

    // 5) 故障层（glitch 期间动态填充错位条）
    els.glitch = mk('fx-glitch', { opacity: '0', overflow: 'hidden' });

    // 6) 闪光层（一次性全屏闪）
    els.flash = mk('fx-flash', {
      background: '#fff',
      opacity: '0',
      mixBlendMode: 'screen',
      transition: 'opacity 60ms linear'
    });

    // 叠放顺序（从下到上）：扫描线 → 噪点 → 暗角 → 色差 → 故障 → 闪光
    root.appendChild(els.scanlines);
    root.appendChild(els.noise);
    root.appendChild(els.vignette);
    root.appendChild(els.aberration);
    root.appendChild(els.glitch);
    root.appendChild(els.flash);
    layerEl.appendChild(root);

    // 注入抖动关键帧（CSS 兜底，避免依赖 effects.css）
    injectKeyframes();

    // 初次根据设置 / fear 刷新一遍基线
    refreshBaseline();
  }

  // 注入一次性的 CSS 关键帧（抖动 / 扫描线滚动 / 暗角脉冲）作为兜底
  let styleTag = null;
  function injectKeyframes() {
    if (document.getElementById('fx-inline-keyframes')) return;
    styleTag = document.createElement('style');
    styleTag.id = 'fx-inline-keyframes';
    styleTag.textContent = `
      @keyframes fxScanRoll { from { background-position: 0 0; } to { background-position: 0 3px; } }
      .fx-scanlines--roll { animation: fxScanRoll 0.6s steps(3) infinite; }
      @keyframes fxShake {
        0%,100% { transform: translate(0,0); }
        20% { transform: translate(var(--fx-sx,2px), calc(var(--fx-sy,2px)*-1)); }
        40% { transform: translate(calc(var(--fx-sx,2px)*-1), var(--fx-sy,2px)); }
        60% { transform: translate(var(--fx-sx,2px), var(--fx-sy,2px)); }
        80% { transform: translate(calc(var(--fx-sx,2px)*-1), calc(var(--fx-sy,2px)*-1)); }
      }
      .fx-shaking { animation: fxShake 0.08s linear infinite; }
      @keyframes fxVignettePulse {
        0% { opacity: var(--fx-vig,0.4); transform: scale(1); }
        45% { opacity: calc(var(--fx-vig,0.4) + 0.45); transform: scale(1.06); }
        100% { opacity: var(--fx-vig,0.4); transform: scale(1); }
      }
      .fx-vignette--pulse { animation: fxVignettePulse 1.4s ease-in-out; }
      @media (prefers-reduced-motion: reduce) {
        .fx-scanlines--roll, .fx-shaking, .fx-vignette--pulse { animation: none !important; }
      }
    `;
    document.head.appendChild(styleTag);
  }

  // ── apply：按关卡设定基线 ────────────────────────────────
  function apply(level) {
    try {
      const art = (level && level.art) || {};
      const audio = (level && level.audio) || {};
      baseIntensity = clamp01(typeof art.intensity === 'number' ? art.intensity : 0.5);
      mood = audio.mood || 'dread';
      // 用关卡 seed 初始化噪点/故障的随机序列，保证确定性
      const seed = (level && level.seed) || (art.seed) || 'effects-default';
      rng = new RNG(seed);
      // fear 基线优先用 level.fear（若 setFear 还没被调用）
      if (typeof level?.fear === 'number') fear = clamp01(level.fear);
    } catch (_) { /* 容错 */ }
    refreshBaseline();
  }

  // ── setFear：实时调节所有持续特效强度 ────────────────────
  function setFear(f) {
    fear = clamp01(typeof f === 'number' ? f : 0);
    refreshBaseline();
  }

  // 根据 fear + baseIntensity + 设置，刷新所有持续覆盖层的强度
  function refreshBaseline() {
    if (!root) return;
    const { effects, reduceMotion } = readSettings();

    // effects 关闭：整层隐藏并停循环
    if (!effects) {
      root.style.display = 'none';
      stopLoop();
      return;
    }
    root.style.display = '';

    // 综合强度：fear 为主，baseIntensity 提供下限托底
    const k = clamp01(Math.max(fear, baseIntensity * 0.6));

    // 暗角：fear 越高越紧（内圈半径收缩 + 浓度上升）
    const vigInner = lerp(42, 14, k);            // 内圈透明半径 %
    const vigDark = lerp(0.45, 0.95, k);          // 外圈黑度
    const vigOpacity = lerp(0.35, 0.9, k);
    els.vignette.style.backgroundImage =
      `radial-gradient(ellipse at center, rgba(0,0,0,0) ${vigInner.toFixed(0)}%, rgba(0,0,0,${vigDark.toFixed(2)}) 100%)`;
    els.vignette.style.opacity = vigOpacity.toFixed(2);
    els.vignette.style.setProperty('--fx-vig', vigOpacity.toFixed(2));

    // 扫描线：fear 越高越明显
    els.scanlines.style.opacity = lerp(0.12, 0.55, k).toFixed(2);

    // 噪点：fear 越高越重
    els.noise.style.opacity = lerp(0.04, 0.30, k).toFixed(2);

    // 色差：轻微基线偏移，随 fear 上升
    const ab = lerp(0.0, 1.0, Math.max(0, k - 0.25) / 0.75); // 低 fear 时几乎无
    els.aberration.style.opacity = (0.4 * ab).toFixed(2);
    const off = lerp(0, 2.5, ab);
    els.aberrationR.style.transform = `translateX(${(-off).toFixed(2)}px)`;
    els.aberrationC.style.transform = `translateX(${off.toFixed(2)}px)`;

    // reduceMotion：禁用动态（滚动 / 逐帧噪点 / 偶发抖动）
    if (reduceMotion) {
      els.scanlines.classList.remove('fx-scanlines--roll');
      // 噪点改为静态一帧（仍画一次），不进主循环
      if (els.noise && !els.noise.style.backgroundImage) paintNoise();
      stopLoop();
    } else {
      els.scanlines.classList.add('fx-scanlines--roll');
      // 偶发抖动概率随 fear 上升；安排下一次
      scheduleSpontaneous(k);
      // 需要逐帧的效果（噪点）→ 启动主循环
      if (els.noise && parseFloat(els.noise.style.opacity) > 0.001) startLoop();
    }
  }

  // 安排下一次偶发抖动（fear 越高越频繁）
  function scheduleSpontaneous(k) {
    if (k < 0.45) { nextSpontaneousShake = Infinity; return; }
    // 间隔从 ~12s（k=0.45）压缩到 ~2.5s（k=1）
    const base = lerp(12000, 2500, (k - 0.45) / 0.55);
    nextSpontaneousShake = performance.now() + base * rng.float(0.6, 1.4);
  }

  // ── glitch：一次数字故障（RGB 撕裂 / 错位 / 方块） ────────
  function glitch(ms = 320) {
    if (!root) return;
    const { effects, reduceMotion } = readSettings();
    if (!effects) return;
    if (reduceMotion) { // 降级：仅一次极短的色差脉冲，无逐帧撕裂
      els.aberration.style.opacity = '0.6';
      setTimeout(() => refreshBaseline(), 90);
      return;
    }
    glitchSeed = (rng.int(1, 1e9));
    glitchUntil = performance.now() + Math.max(60, ms);
    els.glitch.style.opacity = '1';
    startLoop();
  }

  // 逐帧绘制 glitch：随机水平错位条 + 通道分离色块 + 噪块
  function renderGlitch(now) {
    const remain = glitchUntil - now;
    if (remain <= 0) {
      els.glitch.innerHTML = '';
      els.glitch.style.opacity = '0';
      // 故障结束后把色差拉回基线
      refreshBaselineSoft();
      return;
    }
    // 每帧重建错位条（数量随剩余强度）
    const r = new RNG(glitchSeed ^ (now | 0));
    const intensity = clamp01(0.5 + fear * 0.5);
    const bars = r.int(3, Math.round(4 + intensity * 8));
    let html = '';
    for (let i = 0; i < bars; i++) {
      const top = r.float(0, 100);
      const h = r.float(0.6, 6);
      const dx = r.float(-12, 12) * (0.5 + intensity);
      const hue = r.pick(['rgba(255,0,40,0.55)', 'rgba(0,255,230,0.5)', 'rgba(255,255,255,0.6)', 'rgba(0,0,0,0.7)']);
      html += `<div class="fx-glitch__bar" style="position:absolute;left:0;right:0;`
        + `top:${top.toFixed(1)}%;height:${h.toFixed(1)}%;`
        + `transform:translateX(${dx.toFixed(1)}px);`
        + `background:${hue};mix-blend-mode:screen;"></div>`;
    }
    // 偶发整屏 RGB 撕裂（强烈色差）
    const tear = r.float(-8, 8) * intensity;
    els.aberrationR.style.transform = `translateX(${(-3 - Math.abs(tear)).toFixed(1)}px)`;
    els.aberrationC.style.transform = `translateX(${(3 + Math.abs(tear)).toFixed(1)}px)`;
    els.aberration.style.opacity = '0.8';
    els.glitch.innerHTML = html;
  }

  // glitch 结束后柔和恢复基线（不重排关键帧/调度）
  function refreshBaselineSoft() {
    // 仅恢复色差到基线值
    const k = clamp01(Math.max(fear, baseIntensity * 0.6));
    const ab = lerp(0.0, 1.0, Math.max(0, k - 0.25) / 0.75);
    els.aberration.style.opacity = (0.4 * ab).toFixed(2);
    const off = lerp(0, 2.5, ab);
    els.aberrationR.style.transform = `translateX(${(-off).toFixed(2)}px)`;
    els.aberrationC.style.transform = `translateX(${off.toFixed(2)}px)`;
  }

  // ── shake：画面抖动 ──────────────────────────────────────
  function shake(ms = 400) {
    const { effects, reduceMotion } = readSettings();
    if (!effects || reduceMotion) return; // 尊重减弱动态
    // 优先抖 #game（连同 canvas + 特效一起），否则抖 root
    shakeTarget = document.getElementById('game') || root;
    if (!shakeTarget) return;
    // 抖动幅度随 fear
    const amp = lerp(2, 8, clamp01(fear)).toFixed(1);
    shakeTarget.style.setProperty('--fx-sx', `${amp}px`);
    shakeTarget.style.setProperty('--fx-sy', `${amp}px`);
    shakeTarget.classList.add('fx-shaking');
    shakeUntil = performance.now() + Math.max(80, ms);
    startLoop();
  }

  // ── flash：全屏一闪（淡出） ─────────────────────────────
  function flash(color) {
    const { effects } = readSettings();
    if (!effects || !els.flash) return;
    // 默认色按情绪：panic/hunt 偏血红，否则惨白
    const def = (mood === 'panic' || mood === 'hunt') ? '#c8000f' : '#ffffff';
    els.flash.style.background = color || def;
    els.flash.style.transition = 'opacity 30ms linear';
    els.flash.style.opacity = '0.9';
    // 下一帧开始淡出
    requestAnimationFrame(() => {
      els.flash.style.transition = 'opacity 380ms ease-out';
      els.flash.style.opacity = '0';
    });
  }

  // ── vignettePulse：暗角脉冲一次（呼吸 / 逼近感） ─────────
  function vignettePulse() {
    const { effects, reduceMotion } = readSettings();
    if (!effects || !els.vignette) return;
    if (reduceMotion) return; // 静态下不做脉冲动画
    els.vignette.classList.remove('fx-vignette--pulse');
    // 强制重排以重启动画
    void els.vignette.offsetWidth;
    els.vignette.classList.add('fx-vignette--pulse');
    // 动画结束后清理 class（避免重复触发失效）
    setTimeout(() => {
      if (els.vignette) els.vignette.classList.remove('fx-vignette--pulse');
    }, 1500);
  }

  // ── RAF 主循环：仅在有活动逐帧效果时运行 ────────────────
  function loop(now) {
    let active = false;

    // 噪点：每 3 帧重绘一次（节流）
    if (els.noise && parseFloat(els.noise.style.opacity) > 0.001) {
      const { reduceMotion } = readSettings();
      if (!reduceMotion) {
        if (++lastNoiseFrame % 3 === 0) paintNoise();
        active = true;
      }
    }

    // 进行中的 glitch
    if (now < glitchUntil) {
      renderGlitch(now);
      active = true;
    } else if (els.glitch && els.glitch.style.opacity === '1') {
      renderGlitch(now); // 触发收尾
    }

    // 进行中的 shake
    if (now < shakeUntil) {
      active = true;
    } else if (shakeTarget && shakeTarget.classList.contains('fx-shaking')) {
      shakeTarget.classList.remove('fx-shaking');
      shakeTarget.style.transform = '';
    }

    // 偶发抖动调度
    if (now >= nextSpontaneousShake) {
      shake(lerp(180, 320, clamp01(fear)));
      scheduleSpontaneous(clamp01(Math.max(fear, baseIntensity * 0.6)));
    }
    if (nextSpontaneousShake !== Infinity) active = true;

    if (active) {
      rafId = requestAnimationFrame(loop);
    } else {
      running = false;
      rafId = 0;
    }
  }

  function startLoop() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    running = false;
  }

  // ── 清理 ─────────────────────────────────────────────────
  function destroyDom() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; els = {};
  }

  function destroy() {
    stopLoop();
    // 清理可能残留在 #game 上的抖动 class / 内联 transform
    if (shakeTarget) {
      shakeTarget.classList.remove('fx-shaking');
      shakeTarget.style.transform = '';
      shakeTarget.style.removeProperty('--fx-sx');
      shakeTarget.style.removeProperty('--fx-sy');
    }
    shakeTarget = null;
    destroyDom();
    noiseCanvas = null; noiseCtx = null;
    glitchUntil = 0; shakeUntil = 0; nextSpontaneousShake = Infinity;
    if (styleTag && styleTag.parentNode) {
      styleTag.parentNode.removeChild(styleTag);
      styleTag = null;
    }
  }

  return { mount, apply, setFear, glitch, shake, flash, vignettePulse, destroy };
})();

export default Effects;
