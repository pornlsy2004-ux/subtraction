// interactions.js — 互动机制库（10 种）
// 契约：export function mountInteraction(container, level, callbacks) -> { destroy() }
//   container = #interaction-layer（覆盖层）
//   level.interaction = { type, prompt, config, seed }
//   callbacks = { onSolve(result), onProgress(p 0..1), onFail(), cue(name) }
//   cue 名称：'reveal' | 'solve' | 'fail' | 'whisper' | 'sting'
//
// 全部原生 DOM / CSS / Canvas，pointer 事件统一桌面鼠标 + 移动触摸。
// 难度随 level.id / level.fear 平滑上升。失败不惩罚进度，只重来 + cue('fail')。
// 任何类型在最差情况下都提供"继续"兜底解法，绝不抛未捕获异常卡死。
//
// 供 css agent 对接的语义化 class 清单（关键处带内联兜底样式，CSS 缺失也可用）：
//   通用：.itx-root .itx-prompt .itx-btn .itx-btn--ghost .itx-fallback .itx-hint
//   reveal：.itx-reveal .itx-reveal-canvas .itx-reveal-target
//   choice：.itx-choice .itx-choice-list .itx-choice-option .itx-choice-outcome
//   find：.itx-find .itx-find-canvas .itx-find-counter .itx-find-mark
//   sequence：.itx-seq .itx-seq-grid .itx-seq-cell .itx-seq-cell--lit .itx-seq-cell--wrong .itx-seq-status
//   hold：.itx-hold .itx-hold-pad .itx-hold-ring .itx-hold-label
//   decrypt：.itx-decrypt .itx-decrypt-text .itx-decrypt-cipher .itx-decrypt-slot .itx-decrypt-keys .itx-decrypt-key .itx-decrypt-input
//   trace：.itx-trace .itx-trace-canvas
//   avoid：.itx-avoid .itx-avoid-canvas .itx-avoid-timer
//   wait：.itx-wait .itx-wait-eye .itx-wait-ring .itx-wait-label
//   none：.itx-none .itx-none-btn

import { RNG } from './rng.js';

// ── 工具 ──────────────────────────────────────────────────────────────────
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

// 安全包裹回调，绝不让异常冒泡导致引擎卡死
function safe(fn) {
  return (...args) => { try { return fn && fn(...args); } catch (e) { /* swallow */ } };
}

// 难度系数 0..1（早期宽松，后期严苛）。999 关平滑上升，叠加 fear 微调。
function diff(level) {
  const id = (level && level.id) || 1;
  const fear = (level && level.fear) || 0;
  // 用平滑曲线，让前 ~100 关增长缓慢，中后段更陡
  const base = clamp(Math.pow((id - 1) / 998, 0.85));
  return clamp(base * 0.85 + fear * 0.15);
}

// 标准化交互配置读取
function read(level) {
  const itx = (level && level.interaction) || {};
  return {
    type: itx.type || 'none',
    prompt: itx.prompt || '',
    config: itx.config || {},
    seed: itx.seed != null ? itx.seed : ((level && level.seed) || 1),
  };
}

// 提示条
function makePrompt(root, text) {
  if (!text) return null;
  const p = el('div', 'itx-prompt', root);
  p.textContent = text;
  Object.assign(p.style, {
    position: 'absolute', left: '0', right: '0', top: '6%',
    textAlign: 'center', color: '#cfc7bd', font: '500 clamp(13px,3.4vw,18px)/1.6 ui-serif, Georgia, serif',
    letterSpacing: '0.06em', padding: '0 6%', pointerEvents: 'none',
    textShadow: '0 0 12px rgba(0,0,0,0.9)', zIndex: '5',
  });
  return p;
}

// 通用兜底"继续"按钮（任何卡死场景都能解）
function makeFallback(root, label, onClick) {
  const b = el('button', 'itx-fallback itx-btn itx-btn--ghost', root);
  b.type = 'button';
  b.textContent = label || '……继续下沉';
  Object.assign(b.style, {
    position: 'absolute', left: '50%', bottom: '5%', transform: 'translateX(-50%)',
    background: 'transparent', color: 'rgba(170,160,150,0.45)',
    border: '1px solid rgba(140,130,120,0.25)', borderRadius: '2px',
    font: '400 12px/1 ui-monospace, monospace', letterSpacing: '0.18em',
    padding: '8px 16px', cursor: 'pointer', zIndex: '6',
  });
  b.addEventListener('pointerup', safe(onClick));
  return b;
}

function styleBtn(b) {
  Object.assign(b.style, {
    background: 'rgba(20,16,16,0.6)', color: '#d8d0c6',
    border: '1px solid rgba(150,40,40,0.35)', borderRadius: '2px',
    font: '400 clamp(13px,3.4vw,16px)/1.5 ui-serif, Georgia, serif',
    letterSpacing: '0.05em', padding: '12px 18px', cursor: 'pointer',
    textAlign: 'left', backdropFilter: 'blur(2px)',
  });
}

// 让一个 DOM 充满容器并接收指针
function fill(node) {
  Object.assign(node.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
}

// 取容器尺寸（带兜底）
function dims(root) {
  const r = root.getBoundingClientRect();
  return { w: r.width || window.innerWidth || 360, h: r.height || window.innerHeight || 640, rect: r };
}

// 指针坐标 -> 容器内相对坐标
function localPt(e, rect) {
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ── 主入口 ───────────────────────────────────────────────────────────────
export function mountInteraction(container, level, callbacks) {
  const cb = callbacks || {};
  const onSolve = safe(cb.onSolve);
  const onProgress = safe(cb.onProgress);
  const onFail = safe(cb.onFail);
  const cue = safe(cb.cue);

  const cfg = read(level);
  const rng = new RNG(cfg.seed);
  const d = diff(level);

  // 每个交互挂载到自己的 root，destroy 统一清掉
  const root = el('div', 'itx-root itx-' + cfg.type, container || document.body);
  fill(root);
  root.style.touchAction = 'none';
  root.style.zIndex = '3';

  // 资源回收登记
  const cleanups = [];
  const reg = (fn) => cleanups.push(fn);
  const timer = (fn, ms) => { const t = setTimeout(fn, ms); reg(() => clearTimeout(t)); return t; };
  const interval = (fn, ms) => { const t = setInterval(fn, ms); reg(() => clearInterval(t)); return t; };
  const raf = (loop) => {
    let id = 0, alive = true;
    const tick = (t) => { if (!alive) return; try { loop(t); } catch (e) {} if (alive) id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    reg(() => { alive = false; cancelAnimationFrame(id); });
  };
  const listen = (node, type, fn, opts) => { node.addEventListener(type, fn, opts); reg(() => node.removeEventListener(type, fn, opts)); };

  let solved = false;
  const solve = (result) => {
    if (solved) return; solved = true;
    cue('solve');
    onProgress(1);
    onSolve(result || { type: cfg.type });
  };
  const fail = () => { cue('fail'); onFail(); };

  // 安全失败-重来辅助：闪一下红
  function flashFail() {
    fail();
    const ov = el('div', 'itx-failflash', root);
    Object.assign(ov.style, {
      position: 'absolute', inset: '0', background: 'rgba(120,10,10,0.28)',
      pointerEvents: 'none', transition: 'opacity .5s', zIndex: '8',
    });
    requestAnimationFrame(() => { ov.style.opacity = '0'; });
    timer(() => ov.remove(), 600);
  }

  const ctx = { root, cfg, rng, d, level, cue, onProgress, solve, fail, flashFail,
                reg, timer, interval, raf, listen, makePrompt: (t) => makePrompt(root, t),
                fallback: (l, f) => makeFallback(root, l, f) };

  // 分发到具体实现；任何异常都退化为纯叙事继续，绝不卡死
  try {
    switch (cfg.type) {
      case 'reveal':   buildReveal(ctx); break;
      case 'choice':   buildChoice(ctx); break;
      case 'find':     buildFind(ctx); break;
      case 'sequence': buildSequence(ctx); break;
      case 'hold':     buildHold(ctx); break;
      case 'decrypt':  buildDecrypt(ctx); break;
      case 'trace':    buildTrace(ctx); break;
      case 'avoid':    buildAvoid(ctx); break;
      case 'wait':     buildWait(ctx); break;
      case 'none':     buildNone(ctx); break;
      default:         buildNone(ctx); break;
    }
  } catch (e) {
    // 兜底：保证总能继续
    makePrompt(root, cfg.prompt || '前路已断，但你仍要下沉。');
    makeFallback(root, '继续', () => solve({ type: cfg.type, fallback: true }));
  }

  return {
    destroy() {
      for (let i = cleanups.length - 1; i >= 0; i--) { try { cleanups[i](); } catch (e) {} }
      cleanups.length = 0;
      try { root.remove(); } catch (e) {}
    }
  };
}

// ════════════════════════════════════════════════════════════════════════
// 1. REVEAL —— 手电筒光圈跟随指针，照亮隐藏目标即解
//    config: { targets:[{x,y,r,label}] 归一化 0..1 坐标 | count }
// ════════════════════════════════════════════════════════════════════════
function buildReveal(c) {
  const { root, cfg, rng, d } = c;
  c.makePrompt(cfg.prompt || '黑暗中有什么。移动光照亮它。');

  const wrap = el('div', 'itx-reveal', root); fill(wrap);
  const cv = el('canvas', 'itx-reveal-canvas', wrap);
  fill(cv); cv.style.cursor = 'none';
  const g = cv.getContext('2d');

  const { w, h } = dims(root);
  let W = Math.max(1, w), H = Math.max(1, h);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    const dd = dims(root); W = Math.max(1, dd.w); H = Math.max(1, dd.h);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  c.listen(window, 'resize', resize);

  // 目标点
  let targets = Array.isArray(cfg.config.targets) ? cfg.config.targets.slice() : null;
  if (!targets || !targets.length) {
    const count = clamp(cfg.config.count || 1, 1, 4);
    targets = [];
    for (let i = 0; i < count; i++) {
      targets.push({ x: rng.float(0.18, 0.82), y: rng.float(0.28, 0.78), r: 0.05, found: false });
    }
  }
  targets.forEach(t => { t.found = false; t.x = t.x ?? 0.5; t.y = t.y ?? 0.5; t.r = t.r || 0.05; });

  // 光圈半径随难度收缩
  const baseR = lerp(120, 64, d);
  let px = W / 2, py = H / 2, hasPtr = false;

  c.listen(cv, 'pointermove', (e) => {
    const p = localPt(e, root.getBoundingClientRect()); px = p.x; py = p.y; hasPtr = true;
  });
  c.listen(cv, 'pointerdown', (e) => {
    const p = localPt(e, root.getBoundingClientRect()); px = p.x; py = p.y; hasPtr = true;
  });
  c.listen(cv, 'pointerleave', () => { hasPtr = false; });

  let foundCount = 0;
  const total = targets.length;

  c.raf((t) => {
    g.clearRect(0, 0, W, H);
    // 整层暗幕
    g.fillStyle = 'rgba(2,2,4,0.94)'; g.fillRect(0, 0, W, H);

    if (hasPtr) {
      // 检测照亮
      for (const tg of targets) {
        if (tg.found) continue;
        const tx = tg.x * W, ty = tg.y * H;
        const dist = Math.hypot(px - tx, py - ty);
        if (dist < baseR * 0.6) {
          tg.found = true; foundCount++;
          c.cue('reveal'); c.onProgress(foundCount / total);
          if (foundCount >= total) { c.cue('sting'); c.timer(() => c.solve({ type: 'reveal', found: foundCount }), 600); }
        }
      }
      // 挖出光圈（destination-out）
      const flick = 1 + Math.sin(t / 90) * 0.04;
      const r = baseR * flick;
      const grad = g.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.7, 'rgba(0,0,0,0.85)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = grad; g.beginPath(); g.arc(px, py, r, 0, 7); g.fill();
      g.globalCompositeOperation = 'source-over';

      // 在光圈内绘出已照亮/正在照亮的目标
      for (const tg of targets) {
        const tx = tg.x * W, ty = tg.y * H;
        const dist = Math.hypot(px - tx, py - ty);
        const vis = clamp(1 - dist / (baseR * 1.2));
        if (vis <= 0 && !tg.found) continue;
        g.save();
        g.globalAlpha = tg.found ? 0.9 : vis;
        g.translate(tx, ty);
        // 一个惨白的扭曲符号 / 眼
        g.strokeStyle = 'rgba(200,190,180,0.8)'; g.lineWidth = 1.4;
        const rr = (tg.r || 0.05) * Math.min(W, H);
        g.beginPath(); g.ellipse(0, 0, rr, rr * 0.55, 0, 0, 7); g.stroke();
        g.fillStyle = 'rgba(140,20,20,0.85)';
        g.beginPath(); g.arc(0, 0, rr * 0.28, 0, 7); g.fill();
        g.restore();
      }
      // 光晕
      g.save(); g.globalCompositeOperation = 'lighter';
      const halo = g.createRadialGradient(px, py, 0, px, py, baseR * 1.1);
      halo.addColorStop(0, 'rgba(120,110,90,0.10)');
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo; g.fillRect(0, 0, W, H); g.restore();
    } else {
      g.fillStyle = 'rgba(150,140,130,0.35)';
      g.font = '13px ui-monospace, monospace'; g.textAlign = 'center';
      g.fillText('移动指针 / 触摸屏幕', W / 2, H / 2);
    }
  });

  c.fallback('看不清……强行下沉', () => c.solve({ type: 'reveal', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 2. CHOICE —— 2-4 个冷峻选项，选后给后果文字再 onSolve(含选择)
//    config: { options:[{text, outcome}] }
// ════════════════════════════════════════════════════════════════════════
function buildChoice(c) {
  const { root, cfg, rng } = c;
  c.makePrompt(cfg.prompt || '你必须做出选择。');

  let opts = Array.isArray(cfg.config.options) ? cfg.config.options.slice() : null;
  if (!opts || opts.length < 2) {
    const pool = [
      { text: '伸手推开那扇门。', outcome: '门后没有空间，只有更深的门。你已经做了决定。' },
      { text: '转身，假装什么都没看见。', outcome: '背后传来轻微的、像是认同的笑声。' },
      { text: '叫出声。', outcome: '没有回音。原来这里早已没有空气。' },
      { text: '闭上眼，往前走。', outcome: '地面消失了。你想这或许就是答案。' },
    ];
    opts = rng.shuffle(pool).slice(0, 2 + rng.int(0, 1)); // 2..3 个
  }
  opts = opts.slice(0, 4);

  const box = el('div', 'itx-choice', root);
  Object.assign(box.style, {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    width: 'min(86%, 520px)', display: 'flex', flexDirection: 'column', gap: '12px', zIndex: '5',
  });
  const list = el('div', 'itx-choice-list', box);
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '12px' });

  const outcomeEl = el('div', 'itx-choice-outcome', box);
  Object.assign(outcomeEl.style, {
    color: '#bfb6aa', font: '400 clamp(13px,3.4vw,16px)/1.7 ui-serif, Georgia, serif',
    letterSpacing: '0.04em', minHeight: '1.7em', textAlign: 'center', opacity: '0',
    transition: 'opacity .8s', textShadow: '0 0 10px rgba(0,0,0,0.8)',
  });

  let picked = false;
  opts.forEach((o, i) => {
    const b = el('button', 'itx-choice-option itx-btn', list);
    b.type = 'button';
    b.textContent = o.text || ('选项 ' + (i + 1));
    styleBtn(b);
    b.addEventListener('pointerenter', () => { if (!picked) b.style.borderColor = 'rgba(180,50,50,0.7)'; });
    b.addEventListener('pointerleave', () => { if (!picked) b.style.borderColor = 'rgba(150,40,40,0.35)'; });
    c.listen(b, 'pointerup', () => {
      if (picked) return; picked = true;
      c.cue('whisper');
      // 标记选中、淡出其它
      Array.from(list.children).forEach(ch => { if (ch !== b) ch.style.opacity = '0.25'; ch.style.pointerEvents = 'none'; });
      b.style.borderColor = 'rgba(200,60,60,0.9)'; b.style.color = '#efe6da';
      outcomeEl.textContent = o.outcome || '决定已经无法收回。';
      requestAnimationFrame(() => { outcomeEl.style.opacity = '1'; });
      c.timer(() => c.solve({ type: 'choice', index: i, text: o.text, value: o.value != null ? o.value : i, outcome: o.outcome }), 1800);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════
// 3. FIND —— 场景中寻找 config.count 个隐藏异常物，全部找到即解
// ════════════════════════════════════════════════════════════════════════
function buildFind(c) {
  const { root, cfg, rng, d } = c;
  const total = clamp(cfg.config.count || (2 + Math.round(d * 4)), 1, 8);
  c.makePrompt(cfg.prompt || ('有 ' + total + ' 处不对劲。找出它们。'));

  const wrap = el('div', 'itx-find', root); fill(wrap);
  const cv = el('canvas', 'itx-find-canvas', wrap); fill(cv);
  const g = cv.getContext('2d');

  let W = 1, H = 1; const dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    const dd = dims(root); W = Math.max(1, dd.w); H = Math.max(1, dd.h);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize(); c.listen(window, 'resize', resize);

  const counter = el('div', 'itx-find-counter', root);
  Object.assign(counter.style, {
    position: 'absolute', right: '6%', top: '6%', color: 'rgba(190,180,170,0.7)',
    font: '400 13px/1 ui-monospace, monospace', letterSpacing: '0.12em', zIndex: '6',
  });

  // 隐藏异常物（归一化坐标），命中半径随难度收缩
  const items = [];
  for (let i = 0; i < total; i++) {
    items.push({ x: rng.float(0.08, 0.92), y: rng.float(0.14, 0.9), found: false, ph: rng.float(0, 7), kind: rng.int(0, 2) });
  }
  const hitR = lerp(0.07, 0.035, d) * Math.min(W, H);
  let found = 0;
  const updCounter = () => { counter.textContent = found + ' / ' + total; };
  updCounter();

  // 噪点背景纹理（让异常物难以一眼看出）
  c.raf((t) => {
    g.clearRect(0, 0, W, H);
    // 微弱起伏背景
    g.fillStyle = 'rgba(8,8,10,0.0)';
    // 静态噪声（稀疏，避免性能问题）
    g.save();
    g.globalAlpha = 0.05 + d * 0.05;
    for (let i = 0; i < 60; i++) {
      const nx = (Math.sin(i * 12.9898 + t * 0.0003) * 43758.5) % 1;
      const ny = (Math.sin(i * 78.233 + t * 0.0002) * 43758.5) % 1;
      g.fillStyle = 'rgba(120,118,110,0.4)';
      g.fillRect(((Math.abs(nx)) * W), ((Math.abs(ny)) * H), 2, 2);
    }
    g.restore();

    for (const it of items) {
      const ix = it.x * W, iy = it.y * H;
      const pulse = 0.5 + 0.5 * Math.sin(t / 700 + it.ph);
      g.save(); g.translate(ix, iy);
      if (it.found) {
        // 已找到：红圈标记
        g.strokeStyle = 'rgba(200,40,40,0.85)'; g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, hitR * 0.8, 0, 7); g.stroke();
      } else {
        // 隐藏异常：几乎与背景融合，靠极微弱脉动暗示
        g.globalAlpha = 0.10 + pulse * (0.10 - d * 0.05);
        g.strokeStyle = 'rgba(190,185,175,1)'; g.lineWidth = 1;
        const r = hitR * 0.55;
        if (it.kind === 0) { g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke(); }
        else if (it.kind === 1) { g.beginPath(); g.moveTo(-r, -r); g.lineTo(r, r); g.moveTo(r, -r); g.lineTo(-r, r); g.stroke(); }
        else { g.beginPath(); g.ellipse(0, 0, r, r * 0.5, 0, 0, 7); g.stroke(); g.beginPath(); g.arc(0, 0, r * 0.2, 0, 7); g.fillStyle = 'rgba(150,20,20,0.6)'; g.fill(); }
      }
      g.restore();
    }
  });

  c.listen(cv, 'pointerdown', (e) => {
    const p = localPt(e, root.getBoundingClientRect());
    let near = null, best = hitR * 1.4;
    for (const it of items) {
      if (it.found) continue;
      const dist = Math.hypot(p.x - it.x * W, p.y - it.y * H);
      if (dist < best) { best = dist; near = it; }
    }
    if (near) {
      near.found = true; found++; updCounter();
      c.cue('reveal'); c.onProgress(found / total);
      if (found >= total) { c.cue('sting'); c.timer(() => c.solve({ type: 'find', found }), 700); }
    } else {
      // 差一点：轻微反馈，不惩罚
      const miss = el('div', 'itx-find-mark', root);
      Object.assign(miss.style, {
        position: 'absolute', left: p.x + 'px', top: p.y + 'px', width: '8px', height: '8px',
        marginLeft: '-4px', marginTop: '-4px', borderRadius: '50%',
        border: '1px solid rgba(120,110,100,0.4)', pointerEvents: 'none', transition: 'opacity .6s', zIndex: '7',
      });
      requestAnimationFrame(() => { miss.style.opacity = '0'; });
      c.timer(() => miss.remove(), 700);
    }
  });

  c.fallback('放弃寻找，下沉', () => c.solve({ type: 'find', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 4. SEQUENCE —— 序列记忆：闪现位置，玩家复现。错误 onFail 重来
//    config: { length, grid }  难度随 level.id 上升
// ════════════════════════════════════════════════════════════════════════
function buildSequence(c) {
  const { root, cfg, d } = c;
  const grid = clamp(cfg.config.grid || (d > 0.5 ? 3 : 2) + (d > 0.8 ? 1 : 0), 2, 4);
  const len = clamp(cfg.config.length || (3 + Math.round(d * 5)), 2, 9);
  c.makePrompt(cfg.prompt || '记住它们闪现的顺序，然后复现。');

  const box = el('div', 'itx-seq', root);
  Object.assign(box.style, {
    position: 'absolute', left: '50%', top: '52%', transform: 'translate(-50%,-50%)', zIndex: '5',
  });
  const gridEl = el('div', 'itx-seq-grid', box);
  Object.assign(gridEl.style, {
    display: 'grid', gap: '10px', gridTemplateColumns: `repeat(${grid}, 1fr)`,
    width: 'min(80vw, 360px)', aspectRatio: '1 / 1',
  });
  const status = el('div', 'itx-seq-status', box);
  Object.assign(status.style, {
    marginTop: '16px', textAlign: 'center', color: 'rgba(190,180,170,0.7)',
    font: '400 13px/1.4 ui-monospace, monospace', letterSpacing: '0.1em', minHeight: '1.4em',
  });

  const cells = [];
  const N = grid * grid;
  for (let i = 0; i < N; i++) {
    const cell = el('button', 'itx-seq-cell', gridEl);
    cell.type = 'button'; cell.dataset.i = i;
    Object.assign(cell.style, {
      background: 'rgba(18,16,18,0.7)', border: '1px solid rgba(120,110,100,0.2)',
      borderRadius: '3px', cursor: 'pointer', transition: 'background .12s, box-shadow .12s',
    });
    cells.push(cell);
  }

  // 用 RNG 生成确定的目标序列
  const seq = [];
  for (let i = 0; i < len; i++) seq.push(c.rng.int(0, N - 1));

  let inputIdx = 0, accepting = false, attempts = 0;

  function litOn(cell) { cell.classList.add('itx-seq-cell--lit'); cell.style.background = 'rgba(180,40,40,0.85)'; cell.style.boxShadow = '0 0 18px rgba(200,40,40,0.6)'; }
  function litOff(cell) { cell.classList.remove('itx-seq-cell--lit'); cell.style.background = 'rgba(18,16,18,0.7)'; cell.style.boxShadow = 'none'; }

  function playback() {
    accepting = false; inputIdx = 0;
    status.textContent = '凝视……';
    const step = Math.max(280, 620 - d * 260); // 后期更快
    seq.forEach((idx, k) => {
      c.timer(() => { litOn(cells[idx]); c.cue('whisper'); }, step * k + 400);
      c.timer(() => litOff(cells[idx]), step * k + 400 + step * 0.6);
    });
    c.timer(() => { accepting = true; status.textContent = '现在，复现。'; }, step * seq.length + 600);
  }

  cells.forEach((cell, i) => {
    c.listen(cell, 'pointerdown', () => {
      if (!accepting) return;
      litOn(cell); c.timer(() => litOff(cell), 180);
      if (i === seq[inputIdx]) {
        inputIdx++;
        c.cue('reveal'); c.onProgress(inputIdx / seq.length);
        if (inputIdx >= seq.length) {
          accepting = false; status.textContent = '……正确。';
          c.cue('sting'); c.timer(() => c.solve({ type: 'sequence', length: len, attempts: attempts + 1 }), 600);
        }
      } else {
        accepting = false; attempts++;
        cell.classList.add('itx-seq-cell--wrong'); cell.style.background = 'rgba(60,10,10,0.9)';
        status.textContent = '错了。重新记忆。';
        c.flashFail();
        c.timer(() => { litOff(cell); cell.classList.remove('itx-seq-cell--wrong'); playback(); }, 1100);
      }
    });
  });

  c.timer(playback, 700);
  c.fallback('记不住……跳过', () => c.solve({ type: 'sequence', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 5. HOLD —— 长按抵抗 N 秒，松手过早 onFail。onProgress 显示进度
//    config: { seconds }
// ════════════════════════════════════════════════════════════════════════
function buildHold(c) {
  const { root, cfg, d } = c;
  const seconds = clamp(cfg.config.seconds || (2.5 + d * 4), 1.5, 9);
  c.makePrompt(cfg.prompt || '有什么在拉你。按住，不要松手。');

  const pad = el('div', 'itx-hold-pad', root);
  Object.assign(pad.style, {
    position: 'absolute', left: '50%', top: '54%', transform: 'translate(-50%,-50%)',
    width: 'min(48vw, 200px)', height: 'min(48vw, 200px)', borderRadius: '50%',
    border: '1px solid rgba(150,40,40,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', userSelect: 'none', zIndex: '5', touchAction: 'none',
    background: 'radial-gradient(circle, rgba(40,12,12,0.5), rgba(8,6,8,0.2))',
  });
  const label = el('div', 'itx-hold-label', pad);
  Object.assign(label.style, { color: 'rgba(210,200,190,0.8)', font: '400 14px/1.4 ui-monospace, monospace', textAlign: 'center', pointerEvents: 'none' });
  label.textContent = '按住';

  // 进度环 canvas
  const ring = el('canvas', 'itx-hold-ring', pad);
  Object.assign(ring.style, { position: 'absolute', inset: '-6px', width: 'calc(100% + 12px)', height: 'calc(100% + 12px)', pointerEvents: 'none' });
  const rg = ring.getContext('2d');
  function sizeRing() { const s = pad.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1); ring.width = (s.width + 12) * dpr; ring.height = (s.height + 12) * dpr; rg.setTransform(dpr, 0, 0, dpr, 0, 0); }
  c.timer(sizeRing, 0); c.listen(window, 'resize', sizeRing);

  let holding = false, startT = 0, prog = 0, done = false;
  const pressureMsg = ['不要松手', '它更用力了', '别看下面', '快了', '坚持'];

  function begin(e) {
    if (done) return;
    holding = true; startT = performance.now();
    try { pad.setPointerCapture && e.pointerId != null && pad.setPointerCapture(e.pointerId); } catch (er) {}
    c.cue('whisper');
  }
  function end() {
    if (done || !holding) return;
    holding = false;
    if (prog < 0.999) {
      // 松手过早
      prog = 0; c.onProgress(0); label.textContent = '它把你拽回去了。';
      c.flashFail();
      c.timer(() => { if (!done) label.textContent = '按住'; }, 1000);
    }
  }
  c.listen(pad, 'pointerdown', begin);
  c.listen(pad, 'pointerup', end);
  c.listen(pad, 'pointercancel', end);
  c.listen(pad, 'pointerleave', () => { /* 用 capture，不在离开时强制结束，但若无 capture 则结束 */ if (holding && !pad.hasPointerCapture) end(); });

  c.raf((t) => {
    if (holding) {
      const elapsed = (t - startT) / 1000;
      prog = clamp(elapsed / seconds);
      c.onProgress(prog);
      const msgI = Math.min(pressureMsg.length - 1, Math.floor(prog * pressureMsg.length));
      label.textContent = prog >= 1 ? '……松手。' : pressureMsg[msgI];
      if (prog >= 1 && !done) {
        done = true; c.cue('sting'); c.timer(() => c.solve({ type: 'hold', seconds }), 500);
      }
    }
    // 画进度环
    const s = ring.width / (Math.min(2, window.devicePixelRatio || 1));
    const cx = s / 2, cy = ring.height / (Math.min(2, window.devicePixelRatio || 1)) / 2;
    const r = Math.min(cx, cy) - 4;
    rg.clearRect(0, 0, ring.width, ring.height);
    rg.strokeStyle = 'rgba(80,70,70,0.3)'; rg.lineWidth = 3;
    rg.beginPath(); rg.arc(cx, cy, r, 0, 7); rg.stroke();
    rg.strokeStyle = 'rgba(210,50,50,0.9)'; rg.lineWidth = 4; rg.lineCap = 'round';
    rg.beginPath(); rg.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); rg.stroke();
    // 抵抗抖动
    if (holding && prog < 1) {
      const jx = (Math.random() - 0.5) * (2 + prog * 6);
      const jy = (Math.random() - 0.5) * (2 + prog * 6);
      pad.style.transform = `translate(calc(-50% + ${jx}px), calc(-50% + ${jy}px))`;
    } else {
      pad.style.transform = 'translate(-50%,-50%)';
    }
  });

  c.fallback('坚持不住……放手', () => c.solve({ type: 'hold', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 6. DECRYPT —— 解密文字：凯撒位移还原隐藏讯息
//    config: { message, shift }  玩家用按钮调整位移，对齐即解
// ════════════════════════════════════════════════════════════════════════
function buildDecrypt(c) {
  const { root, cfg, rng, d } = c;
  c.makePrompt(cfg.prompt || '墙上的字被搅乱了。把它还原。');

  // 取讯息（中文则用乱序还原模式，拉丁则用凯撒）
  const message = (cfg.config.message || 'THE DOOR IS INSIDE YOU').toString();
  const isLatin = /[A-Za-z]/.test(message);

  const box = el('div', 'itx-decrypt', root);
  Object.assign(box.style, {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    width: 'min(88%, 560px)', textAlign: 'center', zIndex: '5',
  });

  if (isLatin) {
    // 凯撒位移
    const trueShift = clamp(cfg.config.shift || rng.int(3, 20), 1, 25);
    const enc = caesar(message, trueShift);
    let cur = rng.int(1, 25); if (cur === 0) cur = 1;

    const cipher = el('div', 'itx-decrypt-cipher itx-decrypt-text', box);
    Object.assign(cipher.style, {
      font: '500 clamp(16px,5vw,28px)/1.5 ui-monospace, monospace', letterSpacing: '0.16em',
      color: '#cfc6ba', margin: '0 0 22px', wordBreak: 'break-word', textShadow: '0 0 12px rgba(120,20,20,0.5)',
    });
    const keys = el('div', 'itx-decrypt-keys', box);
    Object.assign(keys.style, { display: 'flex', gap: '14px', justifyContent: 'center', alignItems: 'center' });

    const mk = (txt) => { const b = el('button', 'itx-decrypt-key itx-btn', keys); b.type = 'button'; b.textContent = txt; Object.assign(b.style, { background: 'rgba(20,16,16,0.7)', color: '#d8d0c6', border: '1px solid rgba(150,40,40,0.4)', borderRadius: '2px', font: '600 20px/1 ui-monospace, monospace', padding: '10px 18px', cursor: 'pointer' }); return b; };
    const left = mk('◀'), shiftLabel = el('div', '', keys), right = mk('▶');
    Object.assign(shiftLabel.style, { color: 'rgba(180,170,160,0.7)', font: '400 13px/1 ui-monospace, monospace', minWidth: '72px' });

    const render = () => {
      cipher.textContent = caesar(enc, (26 - cur) % 26);
      shiftLabel.textContent = '位移 ' + cur;
      const matches = caesar(enc, (26 - cur) % 26) === message;
      c.onProgress(matches ? 1 : clamp(1 - Math.abs(((trueShift) - cur)) / 26));
      if (matches) {
        cipher.style.color = '#efe6da'; cipher.style.textShadow = '0 0 18px rgba(60,200,120,0.4)';
        left.disabled = right.disabled = true; c.cue('sting');
        c.timer(() => c.solve({ type: 'decrypt', message, shift: cur }), 1200);
      }
    };
    c.listen(left, 'pointerup', () => { cur = (cur + 25) % 26; if (cur === 0) cur = 26; cur = ((cur - 1 + 26) % 26) + 0; cur = clamp(cur, 1, 26); c.cue('reveal'); render(); });
    // 简化：用直接增减
    left.onclick = null;
    c.listen(left, 'pointerup', () => { cur = cur <= 1 ? 25 : cur - 1; c.cue('reveal'); render(); });
    c.listen(right, 'pointerup', () => { cur = cur >= 25 ? 1 : cur + 1; c.cue('reveal'); render(); });
    render();
  } else {
    // 中文/非拉丁：缺字填空 —— 挖掉若干字，玩家从候选里点回正确字
    const chars = Array.from(message);
    const holes = clamp(Math.round(chars.length * (0.25 + d * 0.25)), 1, Math.max(1, chars.length - 1));
    const holeIdx = rng.shuffle(chars.map((_, i) => i)).slice(0, holes).sort((a, b) => a - b);
    const holeSet = new Set(holeIdx);

    const textEl = el('div', 'itx-decrypt-text', box);
    Object.assign(textEl.style, {
      font: '500 clamp(18px,5.5vw,30px)/1.8 ui-serif, Georgia, serif', letterSpacing: '0.12em',
      color: '#cfc6ba', margin: '0 0 26px', textShadow: '0 0 12px rgba(120,20,20,0.4)',
    });
    const slots = [];
    chars.forEach((ch, i) => {
      const s = el('span', 'itx-decrypt-slot', textEl);
      if (holeSet.has(i)) {
        s.textContent = '＿'; s.dataset.answer = ch; s.dataset.filled = '0';
        Object.assign(s.style, { color: 'rgba(200,60,60,0.9)', borderBottom: '1px solid rgba(200,60,60,0.6)' });
        slots.push(s);
      } else { s.textContent = ch; }
    });

    // 候选键（正确字 + 干扰字）打乱
    const decoyPool = Array.from('影门眼血夜骨梦渊裂喉缝井雾尘魂');
    const answerChars = holeIdx.map(i => chars[i]);
    const pool = c.rng.shuffle(answerChars.concat(c.rng.shuffle(decoyPool).slice(0, clamp(holes, 2, 6))));
    const keys = el('div', 'itx-decrypt-keys', box);
    Object.assign(keys.style, { display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center' });

    let curSlot = 0; let filled = 0;
    const markActive = () => slots.forEach((s, i) => { s.style.background = i === curSlot && s.dataset.filled === '0' ? 'rgba(200,60,60,0.18)' : 'transparent'; });
    // 让下一个未填的槽为活动
    const nextSlot = () => { curSlot = slots.findIndex(s => s.dataset.filled === '0'); if (curSlot < 0) curSlot = slots.length; markActive(); };

    pool.forEach((ch) => {
      const b = el('button', 'itx-decrypt-key itx-btn', keys); b.type = 'button'; b.textContent = ch;
      Object.assign(b.style, { background: 'rgba(20,16,16,0.7)', color: '#d8d0c6', border: '1px solid rgba(150,40,40,0.4)', borderRadius: '2px', font: '500 22px/1 ui-serif, serif', padding: '10px 14px', cursor: 'pointer' });
      c.listen(b, 'pointerup', () => {
        const slot = slots[curSlot];
        if (!slot) return;
        if (slot.dataset.answer === ch) {
          slot.textContent = ch; slot.dataset.filled = '1';
          slot.style.color = '#efe6da'; slot.style.borderBottom = '1px solid rgba(120,200,140,0.5)';
          b.disabled = true; b.style.opacity = '0.25';
          filled++; c.cue('reveal'); c.onProgress(filled / slots.length);
          nextSlot();
          if (filled >= slots.length) { c.cue('sting'); c.timer(() => c.solve({ type: 'decrypt', message }), 1000); }
        } else {
          c.flashFail(); slot.style.color = 'rgba(255,80,80,1)';
          c.timer(() => { if (slot.dataset.filled === '0') slot.style.color = 'rgba(200,60,60,0.9)'; }, 400);
        }
      });
    });
    // 点槽切换当前槽
    slots.forEach((s, i) => c.listen(s, 'pointerup', () => { if (s.dataset.filled === '0') { curSlot = i; markActive(); } }));
    nextSlot();
  }

  c.fallback('看不懂这些字……下沉', () => c.solve({ type: 'decrypt', fallback: true }));
}

function caesar(str, shift) {
  return str.replace(/[A-Za-z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
  });
}

// ════════════════════════════════════════════════════════════════════════
// 7. TRACE —— 描线：沿指引轨迹描出符号/封印，偏离过多 onFail，完成即解
//    config: { shape:'line'|'circle'|'sigil', tolerance }
// ════════════════════════════════════════════════════════════════════════
function buildTrace(c) {
  const { root, cfg, rng, d } = c;
  c.makePrompt(cfg.prompt || '沿着那道痕迹，把它缝合。');

  const wrap = el('div', 'itx-trace', root); fill(wrap);
  const cv = el('canvas', 'itx-trace-canvas', wrap); fill(cv); cv.style.cursor = 'crosshair';
  const g = cv.getContext('2d');
  let W = 1, H = 1; const dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() { const dd = dims(root); W = Math.max(1, dd.w); H = Math.max(1, dd.h); cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(dpr, 0, 0, dpr, 0, 0); buildPath(); }

  // 生成引导路径点（归一化），多种形状
  const shape = cfg.config.shape || rng.pick(['line', 'circle', 'sigil', 'zigzag']);
  let path = [];
  function buildPath() {
    path = [];
    const cx = 0.5, cy = 0.52, R = 0.3;
    const seg = 120;
    if (shape === 'line') {
      const ax = rng.float(0.15, 0.3), ay = rng.float(0.25, 0.4);
      const bx = rng.float(0.7, 0.85), by = rng.float(0.6, 0.78);
      for (let i = 0; i <= seg; i++) { const t = i / seg; path.push({ x: lerp(ax, bx, t), y: lerp(ay, by, t) + Math.sin(t * Math.PI) * 0.04 }); }
    } else if (shape === 'circle') {
      for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2 - Math.PI / 2; path.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.9 }); }
    } else if (shape === 'zigzag') {
      const pts = 5 + Math.round(d * 3);
      for (let i = 0; i <= seg; i++) { const t = i / seg; path.push({ x: lerp(0.16, 0.84, t), y: cy + Math.sin(t * Math.PI * pts) * 0.18 }); }
    } else { // sigil：星形封印
      const points = 5; const inner = R * 0.45;
      const verts = [];
      for (let i = 0; i <= points * 2; i++) { const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2; const rad = i % 2 === 0 ? R : inner; verts.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad }); }
      for (let i = 0; i < verts.length - 1; i++) { for (let j = 0; j <= 16; j++) { const t = j / 16; path.push({ x: lerp(verts[i].x, verts[i + 1].x, t), y: lerp(verts[i].y, verts[i + 1].y, t) }); } }
    }
  }
  resize(); c.listen(window, 'resize', resize);

  const tol = (cfg.config.tolerance || lerp(0.09, 0.045, d)); // 容忍偏离（归一化）
  let progressIdx = 0; let tracing = false; let trail = []; let done = false;

  function nearestAhead(px, py) {
    // 在当前进度之后的小窗口内找最近点
    let bestD = Infinity, bestI = progressIdx;
    const win = Math.min(path.length, progressIdx + 12);
    for (let i = progressIdx; i < win; i++) {
      const dx = px - path[i].x * W, dy = py - path[i].y * H;
      const dist = Math.hypot(dx, dy);
      if (dist < bestD) { bestD = dist; bestI = i; }
    }
    return { dist: bestD, idx: bestI };
  }

  c.listen(cv, 'pointerdown', (e) => { if (done) return; tracing = true; trail = []; const p = localPt(e, root.getBoundingClientRect()); trail.push(p); try { cv.setPointerCapture(e.pointerId); } catch (er) {} });
  c.listen(cv, 'pointermove', (e) => {
    if (!tracing || done) return;
    const p = localPt(e, root.getBoundingClientRect()); trail.push(p); if (trail.length > 40) trail.shift();
    const { dist, idx } = nearestAhead(p.x, p.y);
    const tolPx = tol * Math.min(W, H);
    if (dist > tolPx * 1.8) {
      // 偏离过多
      tracing = false; c.flashFail(); progressIdx = Math.max(0, progressIdx - 8); c.onProgress(progressIdx / path.length);
      return;
    }
    if (idx > progressIdx) { progressIdx = idx; c.cue('whisper'); c.onProgress(progressIdx / (path.length - 1)); }
    if (progressIdx >= path.length - 2) { done = true; c.cue('sting'); c.timer(() => c.solve({ type: 'trace', shape }), 500); }
  });
  const stop = () => { if (!done) { tracing = false; } };
  c.listen(cv, 'pointerup', stop); c.listen(cv, 'pointercancel', stop);

  c.raf((t) => {
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(4,3,5,0.6)'; g.fillRect(0, 0, W, H);
    // 引导路径（虚线、微弱）
    g.lineWidth = 2; g.strokeStyle = 'rgba(150,140,130,0.25)'; g.setLineDash([6, 8]);
    g.beginPath(); path.forEach((pt, i) => { const x = pt.x * W, y = pt.y * H; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.setLineDash([]);
    // 已描部分（发红发亮，像缝合的伤口）
    g.lineWidth = 4; g.lineCap = 'round'; g.strokeStyle = 'rgba(200,40,40,0.85)'; g.shadowColor = 'rgba(200,40,40,0.7)'; g.shadowBlur = 8;
    g.beginPath(); for (let i = 0; i <= progressIdx && i < path.length; i++) { const x = path[i].x * W, y = path[i].y * H; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    g.shadowBlur = 0;
    // 起点光标提示
    if (progressIdx < 2) { const s = path[0]; const pl = 0.5 + 0.5 * Math.sin(t / 300); g.fillStyle = `rgba(220,210,200,${0.4 + pl * 0.4})`; g.beginPath(); g.arc(s.x * W, s.y * H, 8, 0, 7); g.fill(); }
    // 当前指尖目标
    if (tracing && progressIdx < path.length - 1) { const nx = path[Math.min(path.length - 1, progressIdx + 4)]; g.strokeStyle = 'rgba(220,200,180,0.5)'; g.lineWidth = 1; g.beginPath(); g.arc(nx.x * W, nx.y * H, tol * Math.min(W, H), 0, 7); g.stroke(); }
  });

  c.fallback('手不听使唤……跳过', () => c.solve({ type: 'trace', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 8. AVOID —— 在限定时间内躲开缓慢逼近的影，坚持到时间结束即解，被触到 onFail
//    config: { seconds, chasers, speed }
// ════════════════════════════════════════════════════════════════════════
function buildAvoid(c) {
  const { root, cfg, rng, d } = c;
  const seconds = clamp(cfg.config.seconds || (6 + d * 8), 4, 18);
  const nChasers = clamp(cfg.config.chasers || (1 + Math.round(d * 3)), 1, 5);
  c.makePrompt(cfg.prompt || '它们在找你。别让它们碰到。坚持住。');

  const wrap = el('div', 'itx-avoid', root); fill(wrap);
  const cv = el('canvas', 'itx-avoid-canvas', wrap); fill(cv); cv.style.cursor = 'none';
  const g = cv.getContext('2d');
  let W = 1, H = 1; const dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() { const dd = dims(root); W = Math.max(1, dd.w); H = Math.max(1, dd.h); cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(dpr, 0, 0, dpr, 0, 0); }
  resize(); c.listen(window, 'resize', resize);

  const timerEl = el('div', 'itx-avoid-timer', root);
  Object.assign(timerEl.style, { position: 'absolute', left: '50%', top: '6%', transform: 'translateX(-50%)', color: 'rgba(200,190,180,0.7)', font: '400 14px/1 ui-monospace, monospace', letterSpacing: '0.14em', zIndex: '6' });

  let px = W / 2, py = H * 0.7, hasPtr = false;
  c.listen(cv, 'pointermove', (e) => { const p = localPt(e, root.getBoundingClientRect()); px = p.x; py = p.y; hasPtr = true; });
  c.listen(cv, 'pointerdown', (e) => { const p = localPt(e, root.getBoundingClientRect()); px = p.x; py = p.y; hasPtr = true; });

  const baseSpeed = (cfg.config.speed || lerp(0.45, 1.1, d)); // 像素/帧 比例
  const chasers = [];
  for (let i = 0; i < nChasers; i++) {
    const edge = rng.int(0, 3);
    let x = rng.float(0.1, 0.9) * W, y = rng.float(0.1, 0.9) * H;
    if (edge === 0) y = -20; else if (edge === 1) y = H + 20; else if (edge === 2) x = -20; else x = W + 20;
    chasers.push({ x, y, r: lerp(18, 30, d) + rng.float(0, 8), spd: baseSpeed * rng.float(0.85, 1.2), ph: rng.float(0, 7) });
  }

  let startT = 0, done = false, lost = false;
  c.raf((t) => {
    if (!startT) startT = t;
    const elapsed = (t - startT) / 1000;
    const remain = Math.max(0, seconds - elapsed);
    timerEl.textContent = '坚持 ' + remain.toFixed(1) + 's';
    c.onProgress(clamp(elapsed / seconds));

    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(3,2,4,0.55)'; g.fillRect(0, 0, W, H);

    // 玩家光点
    if (hasPtr) {
      const halo = g.createRadialGradient(px, py, 0, px, py, 40);
      halo.addColorStop(0, 'rgba(210,200,180,0.55)'); halo.addColorStop(1, 'rgba(210,200,180,0)');
      g.fillStyle = halo; g.beginPath(); g.arc(px, py, 40, 0, 7); g.fill();
      g.fillStyle = 'rgba(240,235,225,0.9)'; g.beginPath(); g.arc(px, py, 5, 0, 7); g.fill();
    } else {
      g.fillStyle = 'rgba(180,170,160,0.5)'; g.font = '13px ui-monospace, monospace'; g.textAlign = 'center';
      g.fillText('移动指针躲避', W / 2, H / 2);
    }

    // 追逐影
    for (const ch of chasers) {
      if (hasPtr && !done && !lost) {
        const dx = px - ch.x, dy = py - ch.y; const dist = Math.hypot(dx, dy) || 1;
        // 速度随时间略增，制造压迫
        const sp = ch.spd * (1 + elapsed / seconds * 0.5);
        ch.x += (dx / dist) * sp * (W / 360);
        ch.y += (dy / dist) * sp * (W / 360);
        // 碰到
        if (dist < ch.r + 5) { lost = true; }
      }
      // 绘制：模糊的黑影 + 微红芯
      const wob = Math.sin(t / 200 + ch.ph) * 3;
      const grad = g.createRadialGradient(ch.x, ch.y, 0, ch.x, ch.y, ch.r + 10);
      grad.addColorStop(0, 'rgba(10,0,0,0.95)'); grad.addColorStop(0.6, 'rgba(20,2,2,0.8)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.beginPath(); g.arc(ch.x, ch.y, ch.r + 10 + wob, 0, 7); g.fill();
      g.fillStyle = 'rgba(120,15,15,0.6)'; g.beginPath(); g.arc(ch.x, ch.y, ch.r * 0.3, 0, 7); g.fill();
    }

    if (lost && !done) {
      done = true; c.flashFail();
      // 重置：影回边缘，时间重来
      c.timer(() => {
        if (c.root.isConnected === false) return;
        lost = false; done = false; startT = 0;
        chasers.forEach((ch) => { const edge = Math.floor(Math.random() * 4); ch.x = Math.random() * W; ch.y = edge === 0 ? -20 : H + 20; });
      }, 900);
      return;
    }
    if (remain <= 0 && !done) { done = true; c.cue('sting'); c.timer(() => c.solve({ type: 'avoid', seconds }), 400); }
  });

  c.fallback('躲不掉……束手', () => c.solve({ type: 'avoid', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 9. WAIT —— 凝视：保持不动不点不动鼠标一段时间，乱动则重置，时间到即解
//    config: { seconds }
// ════════════════════════════════════════════════════════════════════════
function buildWait(c) {
  const { root, cfg, d } = c;
  const seconds = clamp(cfg.config.seconds || (5 + d * 6), 3, 14);
  c.makePrompt(cfg.prompt || '什么都不要做。凝视它。不要移动。');

  const center = el('div', 'itx-wait', root);
  Object.assign(center.style, { position: 'absolute', left: '50%', top: '52%', transform: 'translate(-50%,-50%)', textAlign: 'center', zIndex: '5' });

  // 凝视目标：一只缓慢睁开的眼 (canvas)
  const eye = el('canvas', 'itx-wait-eye', center);
  Object.assign(eye.style, { width: 'min(50vw, 220px)', height: 'min(30vw, 132px)', display: 'block', margin: '0 auto' });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  function sizeEye() { const r = eye.getBoundingClientRect(); eye.width = r.width * dpr; eye.height = r.height * dpr; }
  c.timer(sizeEye, 0); c.listen(window, 'resize', sizeEye);
  const eg = eye.getContext('2d');

  const ringCv = el('canvas', 'itx-wait-ring', center);
  Object.assign(ringCv.style, { width: '120px', height: '120px', position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'none' });
  function sizeRing() { ringCv.width = 120 * dpr; ringCv.height = 120 * dpr; }
  c.timer(sizeRing, 0);
  const rg = ringCv.getContext('2d');

  const label = el('div', 'itx-wait-label', center);
  Object.assign(label.style, { marginTop: '24px', color: 'rgba(190,180,170,0.7)', font: '400 13px/1.5 ui-monospace, monospace', letterSpacing: '0.12em', minHeight: '1.5em' });

  let startT = 0, done = false, last = { x: null, y: null };
  const pressureMsgs = ['……', '不要移开视线', '它正在看回来', '再一会', '别动'];
  const settle = 600; // 移动后多久不动才重新开始累计的宽容期

  function disturb(reason) {
    if (done) return;
    startT = 0; c.onProgress(0);
    label.textContent = '你动了。它停了下来，等你重新安静。';
    c.cue('whisper');
  }
  c.listen(root, 'pointerdown', () => disturb('click'));
  c.listen(root, 'pointermove', (e) => {
    if (last.x == null) { last = { x: e.clientX, y: e.clientY }; return; }
    const dx = e.clientX - last.x, dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
    if (Math.hypot(dx, dy) > 6) disturb('move'); // 小幅抖动宽容
  });
  // 键盘也算动
  c.listen(window, 'keydown', () => disturb('key'));

  c.raf((t) => {
    if (!startT) startT = t;
    const elapsed = (t - startT) / 1000;
    const p = clamp(elapsed / seconds);
    c.onProgress(p);
    const mi = Math.min(pressureMsgs.length - 1, Math.floor(p * pressureMsgs.length));
    if (!done) label.textContent = pressureMsgs[mi];

    // 眼睛随进度睁开
    const ew = eye.width, eh = eye.height;
    eg.clearRect(0, 0, ew, eh); eg.save(); eg.scale(dpr, dpr);
    const w = ew / dpr, h = eh / dpr, cx = w / 2, cy = h / 2;
    const open = lerp(0.06, 1, p);
    eg.strokeStyle = 'rgba(200,190,180,0.7)'; eg.lineWidth = 2; eg.fillStyle = 'rgba(2,2,3,0.9)';
    eg.beginPath();
    eg.moveTo(cx - w * 0.42, cy);
    eg.quadraticCurveTo(cx, cy - h * 0.42 * open, cx + w * 0.42, cy);
    eg.quadraticCurveTo(cx, cy + h * 0.42 * open, cx - w * 0.42, cy);
    eg.fill(); eg.stroke();
    if (open > 0.3) {
      eg.save(); eg.beginPath();
      eg.moveTo(cx - w * 0.42, cy); eg.quadraticCurveTo(cx, cy - h * 0.42 * open, cx + w * 0.42, cy);
      eg.quadraticCurveTo(cx, cy + h * 0.42 * open, cx - w * 0.42, cy); eg.clip();
      const ir = h * 0.34 * open;
      eg.fillStyle = 'rgba(150,30,30,0.9)'; eg.beginPath(); eg.arc(cx, cy, ir, 0, 7); eg.fill();
      eg.fillStyle = 'rgba(0,0,0,1)'; eg.beginPath(); eg.arc(cx, cy, ir * 0.45, 0, 7); eg.fill();
      eg.restore();
    }
    eg.restore();

    // 进度环
    rg.clearRect(0, 0, ringCv.width, ringCv.height); rg.save(); rg.scale(dpr, dpr);
    rg.strokeStyle = 'rgba(70,60,60,0.3)'; rg.lineWidth = 2; rg.beginPath(); rg.arc(60, 60, 54, 0, 7); rg.stroke();
    rg.strokeStyle = 'rgba(190,170,150,0.7)'; rg.lineWidth = 3; rg.lineCap = 'round';
    rg.beginPath(); rg.arc(60, 60, 54, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); rg.stroke(); rg.restore();

    if (p >= 1 && !done) { done = true; label.textContent = '它看够了。'; c.cue('sting'); c.timer(() => c.solve({ type: 'wait', seconds }), 700); }
  });

  c.fallback('受不了这凝视……移开目光', () => c.solve({ type: 'wait', fallback: true }));
}

// ════════════════════════════════════════════════════════════════════════
// 10. NONE —— 纯叙事，一个克制的"继续下沉"按钮直接 onSolve
// ════════════════════════════════════════════════════════════════════════
function buildNone(c) {
  const { root, cfg } = c;
  if (cfg.prompt) c.makePrompt(cfg.prompt);
  const wrap = el('div', 'itx-none', root);
  Object.assign(wrap.style, { position: 'absolute', left: '50%', top: '60%', transform: 'translate(-50%,-50%)', zIndex: '5' });
  const b = el('button', 'itx-none-btn itx-btn', wrap); b.type = 'button';
  b.textContent = cfg.config.label || '继续下沉';
  Object.assign(b.style, {
    background: 'transparent', color: 'rgba(200,190,180,0.7)',
    border: '1px solid rgba(150,40,40,0.4)', borderRadius: '2px',
    font: '400 clamp(13px,3.6vw,16px)/1 ui-serif, Georgia, serif', letterSpacing: '0.18em',
    padding: '14px 28px', cursor: 'pointer', transition: 'all .3s',
  });
  b.addEventListener('pointerenter', () => { b.style.borderColor = 'rgba(200,60,60,0.8)'; b.style.color = '#efe6da'; });
  b.addEventListener('pointerleave', () => { b.style.borderColor = 'rgba(150,40,40,0.4)'; b.style.color = 'rgba(200,190,180,0.7)'; });
  c.listen(b, 'pointerup', () => { c.cue('whisper'); c.solve({ type: 'none' }); });
}
