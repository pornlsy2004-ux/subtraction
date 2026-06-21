// engine.js — 核心编排器
// 职责：建立 DOM 层级、管理单一渲染循环、加载关卡、按契约把 Level 对象分发给各模块，
//       并通过全方位 try/catch 降级，保证任何子模块缺失/报错都不会导致整页白屏。
//
// 关键设计：
// - 单一主 RAF 循环：每次切关都取消旧 RAF（_raf），避免多循环叠加。
// - 当前关的“可销毁资源”（scene / interaction）集中存放，loadLevel 前统一 destroy。
// - safe(label, fn, fallback)：包裹所有跨模块调用，捕获异常并打印，返回 fallback。
// - 任何子模块未实现（import 后为 undefined）都走降级分支，引擎主循环仍可运行。

import { State } from './state.js';
import { Save } from './save.js';
import { buildLevel, TOTAL_LEVELS } from './levels.js';
import { createScene } from './art.js';
import { Audio } from './audio.js';
import { mountInteraction } from './interactions.js';
import { Effects } from './effects.js';
import { UI } from './ui.js';
import { CHAPTERS, chapterOf } from './chapters.js';

// re-export，供 main.js / 其他消费者从 engine 取 State
export { State };

const TOTAL = (typeof TOTAL_LEVELS === 'number' && TOTAL_LEVELS > 0) ? TOTAL_LEVELS : 999;

// ---- 内部运行时句柄 ----
let _root = null;          // #game
let _canvas = null;        // #scene-canvas
let _ctx = null;           // 2D 上下文（仅用于降级纯黑背景）
let _effectsLayer = null;
let _interactionLayer = null;
let _uiLayer = null;

let _scene = null;         // 当前关美术对象 { render, resize, destroy }
let _interaction = null;   // 当前关互动对象 { destroy }
let _raf = 0;              // requestAnimationFrame 句柄
let _loadToken = 0;        // 防止异步过场回调串关：每次 loadLevel 递增
let _started = false;      // 是否已点击开始
let _lastChapterN = null;  // 上一关章节号，用于检测章节切换
let _resizeBound = null;   // resize 监听句柄（便于 destroy 解绑）
let _unlockBound = null;   // 首次交互解锁 audio 的句柄

// ---------------------------------------------------------------------------
// 工具：安全调用，吞掉异常并返回降级值
function safe(label, fn, fallback = undefined) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[Engine] ${label} 失败，降级：`, e);
    return fallback;
  }
}

// 工具：钳制
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 根据关卡 id 平滑计算恐惧值 0..1（缓动曲线：前期慢、后期逼近 1）。
// 若 level 自带 fear 则优先采用 level.fear。
function fearForLevel(id, level) {
  if (level && typeof level.fear === 'number') return clamp(level.fear, 0, 1);
  const t = clamp((id - 1) / (TOTAL - 1), 0, 1);
  // ease-in-out 偏后段加重，外加基础底噪
  const eased = t * t * (3 - 2 * t);
  return clamp(0.08 + eased * 0.92, 0, 1);
}

// ---------------------------------------------------------------------------
// DOM 构建
function buildDOM(rootEl) {
  _root = rootEl;
  if (!_root) throw new Error('Engine.init 缺少 root 元素');

  // 幂等：若已存在则复用，避免重复 init 叠加层
  _canvas = _root.querySelector('#scene-canvas');
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _canvas.id = 'scene-canvas';
    _root.appendChild(_canvas);
  }
  _effectsLayer = ensureLayer('effects-layer');
  _interactionLayer = ensureLayer('interaction-layer');
  _uiLayer = ensureLayer('ui-layer');

  // 2D 上下文用于降级纯黑底（art.js 缺失时）
  _ctx = safe('canvas.getContext', () => _canvas.getContext('2d'), null);

  resizeCanvas();
  _resizeBound = () => resizeCanvas();
  window.addEventListener('resize', _resizeBound, { passive: true });
}

function ensureLayer(id) {
  let el = _root.querySelector('#' + id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    _root.appendChild(el);
  }
  return el;
}

// canvas 自适应：考虑 devicePixelRatio，渲染分辨率匹配显示尺寸
function resizeCanvas() {
  if (!_canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // 上限 2 防止移动端过载
  const rect = _root.getBoundingClientRect();
  const w = Math.max(1, Math.floor((rect.width || window.innerWidth)));
  const h = Math.max(1, Math.floor((rect.height || window.innerHeight)));
  _canvas.style.width = w + 'px';
  _canvas.style.height = h + 'px';
  _canvas.width = Math.floor(w * dpr);
  _canvas.height = Math.floor(h * dpr);
  // 通知当前 scene 重新适配
  if (_scene && typeof _scene.resize === 'function') {
    safe('scene.resize', () => _scene.resize());
  }
}

// 首次用户交互解锁 AudioContext（浏览器自动播放策略）
function bindAudioUnlock() {
  if (_unlockBound) return;
  _unlockBound = () => {
    safe('Audio.init', () => Audio && Audio.init && Audio.init());
    // 应用当前音量/静音设置
    applyAudioSettings();
    window.removeEventListener('pointerdown', _unlockBound);
    window.removeEventListener('keydown', _unlockBound);
    _unlockBound = null;
  };
  window.addEventListener('pointerdown', _unlockBound, { once: false });
  window.addEventListener('keydown', _unlockBound, { once: false });
}

// 把 State.settings 同步到 Audio
function applyAudioSettings() {
  const s = State.settings || {};
  safe('Audio.setMaster', () => Audio && Audio.setMaster && Audio.setMaster(s.volume ?? 0.8));
  safe('Audio.setMuted', () => Audio && Audio.setMuted && Audio.setMuted(!!s.muted));
}

// ---------------------------------------------------------------------------
// 渲染循环（单一主循环）
function startRenderLoop() {
  cancelRenderLoop();
  const reduce = !!(State.settings && State.settings.reduceMotion);
  let lastDraw = 0;
  // reduceMotion 下降帧到 ~30fps（节流），否则尽量 60fps
  const minDelta = reduce ? 1000 / 30 : 0;

  const tick = (t) => {
    _raf = requestAnimationFrame(tick);
    if (minDelta && t - lastDraw < minDelta) return;
    lastDraw = t;
    renderFrame(t);
  };
  _raf = requestAnimationFrame(tick);
}

function renderFrame(t) {
  const fear = State.fear || 0;
  if (_scene && typeof _scene.render === 'function') {
    safe('scene.render', () => _scene.render(t, fear));
  } else if (_ctx) {
    // 降级：art.js 缺失 -> 纯黑背景（带极轻的恐惧泛红，避免完全空洞）
    drawFallbackBackground(fear);
  }
}

function drawFallbackBackground(fear) {
  if (!_ctx || !_canvas) return;
  safe('fallbackBG', () => {
    _ctx.fillStyle = '#000';
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    if (fear > 0) {
      const g = _ctx.createRadialGradient(
        _canvas.width / 2, _canvas.height / 2, 0,
        _canvas.width / 2, _canvas.height / 2, Math.max(_canvas.width, _canvas.height) / 1.2
      );
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(40,0,0,${0.25 * fear})`);
      _ctx.fillStyle = g;
      _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    }
  });
}

function cancelRenderLoop() {
  if (_raf) {
    cancelAnimationFrame(_raf);
    _raf = 0;
  }
}

// ---------------------------------------------------------------------------
// 销毁上一关的瞬态资源（scene / interaction）
function destroyTransient() {
  if (_interaction && typeof _interaction.destroy === 'function') {
    safe('interaction.destroy', () => _interaction.destroy());
  }
  _interaction = null;

  if (_scene && typeof _scene.destroy === 'function') {
    safe('scene.destroy', () => _scene.destroy());
  }
  _scene = null;

  // 清空互动层 DOM（防止降级按钮残留）
  if (_interactionLayer) _interactionLayer.innerHTML = '';
}

// ---------------------------------------------------------------------------
// 互动挂载（含降级：互动模块缺失/报错 -> 给一个“继续”按钮直接 next）
function mountInteractionSafe(level) {
  const callbacks = {
    onSolve: (result) => {
      safe('Audio.cue solve', () => Audio && Audio.cue && Audio.cue('solve'));
      if (level && level.flags) State.set({ flags: level.flags }); // 关卡可能带分支标记
      if (result && result.flags) State.set({ flags: result.flags });
      next();
    },
    onProgress: (p) => {
      // 进度可驱动特效/音频微调（可空实现）
      safe('Effects.setFear progress', () => {
        if (Effects && Effects.setFear) Effects.setFear(clamp((State.fear || 0) + (p || 0) * 0.05, 0, 1));
      });
    },
    onFail: () => {
      safe('Effects.glitch fail', () => Effects && Effects.glitch && Effects.glitch(400));
      safe('Effects.shake fail', () => Effects && Effects.shake && Effects.shake(300));
      safe('Audio.cue fail', () => Audio && Audio.cue && Audio.cue('fail'));
    },
    cue: (name) => safe('Audio.cue', () => Audio && Audio.cue && Audio.cue(name)),
  };

  let mounted = null;
  if (typeof mountInteraction === 'function') {
    mounted = safe('mountInteraction', () => mountInteraction(_interactionLayer, level, callbacks), null);
  }
  if (mounted) {
    _interaction = mounted;
  } else {
    // 降级：纯叙事 / 互动失败 -> “继续”按钮
    _interaction = buildFallbackContinue(level, callbacks);
  }
}

function buildFallbackContinue(level, callbacks) {
  const wrap = document.createElement('div');
  wrap.className = 'fallback-interaction';
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;pointer-events:none;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = (level && level.interaction && level.interaction.type === 'none') ? '继续下沉' : '继续';
  btn.style.cssText = 'pointer-events:auto;margin-bottom:12vh;padding:.8em 2.4em;background:rgba(0,0,0,.55);color:#cdd;border:1px solid rgba(180,200,210,.35);font:inherit;letter-spacing:.3em;cursor:pointer;';
  btn.addEventListener('click', () => {
    safe('Audio.cue solve', () => Audio && Audio.cue && Audio.cue('solve'));
    callbacks.onSolve && callbacks.onSolve({});
  });
  if (_interactionLayer) _interactionLayer.appendChild(wrap);
  wrap.appendChild(btn);
  return { destroy() { safe('fallback.destroy', () => wrap.remove()); } };
}

// ---------------------------------------------------------------------------
// 章节过场处理：若进入新章节，先放过场卡，done 后执行 cont
function handleChapter(id, cont) {
  let ch = safe('chapterOf', () => (typeof chapterOf === 'function' ? chapterOf(id) : null), null);
  if (!ch && Array.isArray(CHAPTERS)) {
    ch = CHAPTERS.find((c) => id >= (c.range ? c.range[0] : 1) && id <= (c.range ? c.range[1] : TOTAL)) || null;
  }
  const n = ch && (ch.n != null) ? ch.n : null;
  const changed = n != null && n !== _lastChapterN;
  _lastChapterN = (n != null) ? n : _lastChapterN;

  if (changed && ch && UI && typeof UI.showChapterCard === 'function') {
    const token = _loadToken;
    const ok = safe('UI.showChapterCard', () => {
      UI.showChapterCard(ch, () => { if (token === _loadToken) cont(); });
      return true;
    }, false);
    if (ok) return; // 等过场 done 回调
  }
  cont();
}

// ---------------------------------------------------------------------------
// 公共 API
export const Engine = {
  // 1) 初始化：建 DOM、挂 Effects/UI、绑定 audio 解锁、载入存档设置
  init(rootEl) {
    buildDOM(rootEl);
    safe('State.hydrate', () => State.hydrate && State.hydrate());

    safe('Effects.mount', () => Effects && Effects.mount && Effects.mount(_effectsLayer));
    safe('UI.mount', () => UI && UI.mount && UI.mount(_uiLayer));

    // 设置变化时实时同步到 Audio / 渲染循环帧率
    State.subscribe((snap) => {
      applyAudioSettings();
    });

    bindAudioUnlock();
    return this;
  },

  // 2) 启动：决定起始关，先显示标题，玩家点击后再 loadLevel
  start(id) {
    const maxUnlocked = safe('Save.maxUnlocked', () => (Save && Save.maxUnlocked ? Save.maxUnlocked() : null), null);
    const resume = (typeof maxUnlocked === 'number' && maxUnlocked >= 1) ? maxUnlocked : (State.maxUnlocked || 1);
    const startId = (typeof id === 'number' && id >= 1) ? id : resume;

    // onStart 回调约定（兼容两种调用形式）：
    //   字符串/数字： 'continue' | 'restart' | <关号>
    //   对象：        { mode:'continue'|'new'|'restart', level }
    //   语义：continue=从 resume 关继续；new/restart=从第 1 关重开（清进度）；
    //         数字=直接跳到该关；其它=默认 startId
    const onStart = (arg) => {
      if (_started) return;
      _started = true;
      // 归一化输入
      let mode = arg, lvl = null;
      if (arg && typeof arg === 'object') { mode = arg.mode; lvl = arg.level; }
      let target = startId;
      if (mode === 'restart' || mode === 'new') {
        safe('State.reset', () => State.reset && State.reset());
        target = 1;
      } else if (mode === 'continue') {
        target = (typeof lvl === 'number' && lvl >= 1) ? lvl : resume;
      } else if (typeof mode === 'number' && mode >= 1) {
        target = mode;
      } else if (typeof lvl === 'number' && lvl >= 1) {
        target = lvl;
      }
      this.loadLevel(target);
    };

    // 把“继续(第N关)”与“从头开始”的信息透传给 UI（UI 据此渲染两入口）
    if (UI && typeof UI.showTitle === 'function') {
      const shown = safe('UI.showTitle', () => {
        UI.showTitle(onStart, { resume, hasProgress: resume > 1, total: TOTAL });
        return true;
      }, false);
      if (shown) return this;
    }
    // 降级：UI 缺失 -> 直接进入起始关
    onStart('continue');
    return this;
  },

  // 3) 加载关卡：核心流程
  loadLevel(id) {
    // 边界处理
    id = Math.floor(Number(id));
    if (!Number.isFinite(id) || id < 1) id = 1;
    if (id > TOTAL) {
      this._finale();
      return;
    }

    const token = ++_loadToken; // 本次加载的令牌，过场异步回调用它防串关

    // 构建关卡（核心契约消费点）
    let level = safe('buildLevel', () => (typeof buildLevel === 'function' ? buildLevel(id) : null), null);
    if (!level) {
      // 降级：levels.js 缺失 -> 造一个最小可用的占位关卡，保证流程跑通
      level = makeFallbackLevel(id);
    }

    // 更新状态：当前关 + 平滑恐惧值
    const fear = fearForLevel(id, level);
    State.set({ current: id, fear, maxUnlocked: Math.max(State.maxUnlocked, id) });

    // 章节过场（若切章），done 后执行真正的关卡装配
    handleChapter(id, () => {
      if (token !== _loadToken) return; // 期间已切到别的关
      this._assemble(level, token);
    });
  },

  // 内部：装配一关的视听与互动（章节过场之后）
  _assemble(level, token) {
    // 销毁上一关瞬态资源
    destroyTransient();

    // 美术：createScene -> 主循环 render
    if (typeof createScene === 'function') {
      _scene = safe('createScene', () => createScene(_canvas, level), null);
    }
    if (_scene && typeof _scene.resize === 'function') safe('scene.resize init', () => _scene.resize());
    startRenderLoop();

    // 特效
    safe('Effects.apply', () => Effects && Effects.apply && Effects.apply(level));
    safe('Effects.setFear', () => Effects && Effects.setFear && Effects.setFear(State.fear || 0));

    // 音频
    safe('Audio.playLevel', () => Audio && Audio.playLevel && Audio.playLevel(level));
    safe('Audio.cue descend', () => Audio && Audio.cue && Audio.cue('descend'));

    // HUD
    safe('UI.showHUD', () => UI && UI.showHUD && UI.showHUD(level));

    // 叙事 -> 完成后挂载互动
    const afterNarrative = () => {
      if (token !== _loadToken) return; // 已切关
      mountInteractionSafe(level);
    };

    if (UI && typeof UI.showNarrative === 'function') {
      const ok = safe('UI.showNarrative', () => { UI.showNarrative(level, afterNarrative); return true; }, false);
      if (!ok) afterNarrative();
    } else {
      afterNarrative();
    }
  },

  // 4) 下一关：解锁 + 完成过渡 -> 加载 current+1
  next() {
    const cur = State.current || 1;
    const nextId = cur + 1;
    safe('Save.unlock', () => Save && Save.unlock && Save.unlock(nextId));
    State.set({ maxUnlocked: Math.max(State.maxUnlocked, nextId) });

    const level = safe('buildLevel(complete)', () => (typeof buildLevel === 'function' ? buildLevel(cur) : null), null) || makeFallbackLevel(cur);
    const token = _loadToken;
    const onNext = () => {
      if (token !== _loadToken) return;
      this.loadLevel(nextId);
    };

    if (UI && typeof UI.showComplete === 'function') {
      const ok = safe('UI.showComplete', () => { UI.showComplete(level, onNext); return true; }, false);
      if (!ok) onNext();
    } else {
      onNext();
    }
  },

  // 终局：通关 999
  _finale() {
    cancelRenderLoop();
    safe('Audio.stop', () => Audio && Audio.stop && Audio.stop());
    const finalLevel = safe('buildLevel(999)', () => (typeof buildLevel === 'function' ? buildLevel(TOTAL) : null), null) || makeFallbackLevel(TOTAL);
    // UI 负责展示通关；约定第二参回调可选择“停在终局”或“回到第1关循环”
    const onEnd = (mode) => {
      if (mode === 'restart') {
        safe('State.reset', () => State.reset && State.reset());
        _started = true;
        this.loadLevel(1);
      }
      // 默认：停在终局，不做任何事
    };
    if (UI && typeof UI.showComplete === 'function') {
      // 复用 showComplete 作为终局展示（带 final 标记）
      safe('UI.finale', () => UI.showComplete({ ...finalLevel, final: true }, () => onEnd('end')));
    }
    // 渲染一帧静态终局背景
    renderFrame(performance.now());
  },

  // 5) 销毁：清理一切
  destroy() {
    cancelRenderLoop();
    destroyTransient();
    if (_resizeBound) { window.removeEventListener('resize', _resizeBound); _resizeBound = null; }
    if (_unlockBound) {
      window.removeEventListener('pointerdown', _unlockBound);
      window.removeEventListener('keydown', _unlockBound);
      _unlockBound = null;
    }
    safe('Audio.stop', () => Audio && Audio.stop && Audio.stop());
    safe('Effects.destroy', () => Effects && Effects.destroy && Effects.destroy());
    safe('UI.hideAll', () => UI && UI.hideAll && UI.hideAll());
    _started = false;
    _lastChapterN = null;
  },
};

// ---------------------------------------------------------------------------
// 降级用最小关卡对象（levels.js 未实现时）。结构遵循契约 Level。
function makeFallbackLevel(id) {
  const chapterN = Math.max(1, Math.ceil(id / 37)); // 粗略 27 章映射
  const fear = fearForLevel(id, null);
  return {
    id,
    chapter: chapterN,
    chapterTitle: '虚无',
    title: `第 ${id} 关`,
    seed: id * 2654435761 >>> 0,
    narrative: ['信号中断。', '这一层还没有成形——但你仍在下沉。'],
    whisper: '',
    art: {
      scene: 'void',
      palette: { bg: '#000000', fog: '#0a0a0f', ink: '#cdd3d6', blood: '#5a0a0a', glow: '#16323a', accent: '#3a4a52' },
      motifs: [], intensity: fear, fog: 0.5, seed: id,
    },
    audio: { droneRoot: 55, mood: 'dread', heartbeat: fear, whispers: fear * 0.5, seed: id },
    interaction: { type: 'none', prompt: '继续下沉', config: {}, seed: id },
    fear,
  };
}
