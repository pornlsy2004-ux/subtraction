// ui.js — 《九百九十九》UI 层（标题 / 章节过场 / HUD / 叙事 / 完成过渡 / 设置）
// 职责：所有覆盖在 canvas 之上的“界面”呈现，挂载于 #ui-layer。
// 纯原生 DOM + 语义化 class。实际配色/排版由 css agent 在 css/main.css 提供；
// 这里仅给关键交互元素加最小内联兜底样式，保证 CSS 缺失时仍可用、可点。
//
// ── 供 css agent 对接的 class 清单 ───────────────────────────────────────────
// 根容器
//   .ui-root                  UI 总容器（充满 #ui-layer）
//   .ui-overlay               所有全屏覆盖层基类（title/chapter/narrative/complete/settings）
//   .is-active                覆盖层激活态（显示）
//   .is-leaving               覆盖层离场态（淡出动画用）
//   .ui-no-motion             reduceMotion 时附加到 .ui-root，CSS 可据此关闭动画
//   .ui-dim                   半透明压暗背景板
//
// 标题画面
//   .ui-title                 标题覆盖层
//   .ui-title-num             巨大数字 “999”
//   .ui-title-cn              中文 “九百九十九”
//   .ui-title-sub             副标题 / 警示语
//   .ui-title-actions         按钮组容器
//   .ui-title-warn            底部细小警示语
//
// 章节过场卡
//   .ui-chapter-card          章节卡覆盖层
//   .ui-chapter-index         “第 三 章”
//   .ui-chapter-title         章节标题
//   .ui-chapter-theme         章节主题词
//   .ui-chapter-summary       章节摘要
//   .ui-chapter-hint          “（点击继续下沉）”
//
// HUD（常驻）
//   .ui-hud                   HUD 容器（非全屏，常驻角落/顶栏）
//   .ui-hud-level             “137 / 999”
//   .ui-hud-cur               当前关号
//   .ui-hud-total             总数
//   .ui-hud-chapter           章节名
//   .ui-hud-depth             下降深度指示外壳
//   .ui-hud-depth-fill        深度进度填充
//   .ui-hud-tools             小按钮组（静音/设置）
//   .ui-hud-btn               HUD 小图标按钮
//
// 叙事
//   .ui-narrative             叙事覆盖层
//   .ui-narrative-body        段落容器
//   .ui-narrative-para        单个叙事段落
//   .is-revealed              已完整显示的段落
//   .ui-narrative-cursor      打字机光标
//   .ui-whisper               角落隐秘低语
//   .ui-narrative-advance     “继续 / 点击加速” 提示条
//
// 完成过渡 / 终局
//   .ui-complete              完成过渡覆盖层
//   .ui-complete-text         “下沉…” 文字
//   .ui-complete-deep         深度数字反馈
//   .ui-ending                第 999 关终局特殊态（附加到 .ui-complete）
//   .ui-ending-title          终局大字
//   .ui-ending-body           终局文本
//
// 设置面板
//   .ui-settings              设置覆盖层
//   .ui-settings-panel        面板主体
//   .ui-settings-title        “设置”标题
//   .ui-field                 单行设置项
//   .ui-field-label           设置项标签
//   .ui-field-control         控件容器
//   .ui-range                 滑块 input[type=range]
//   .ui-switch                开关（checkbox 包装）
//   .ui-select                下拉
//   .ui-settings-danger       危险区（重置进度）
//   .ui-settings-actions      底部按钮组
//
// 通用按钮
//   .ui-btn                   主按钮
//   .ui-btn-primary           主行动按钮（继续下沉）
//   .ui-btn-ghost             次要 / 幽灵按钮
//   .ui-btn-danger            危险按钮（重置）
//   .ui-btn-close             关闭按钮（×）
// ─────────────────────────────────────────────────────────────────────────────

import { State } from './state.js';
import { Save } from './save.js';

// ── 工具：阿拉伯数字 → 中文数字（用于“第 三 章”“第 一 关”等）─────────────────
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_UNITS = ['', '十', '百', '千'];
function cnNumber(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return '零';
  if (n === 0) return '零';
  if (n < 10) return CN_DIGITS[n];
  // 处理到万级别足够（章 ≤27，关 ≤999）
  if (n < 10000) {
    let s = '';
    const str = String(n);
    const len = str.length;
    let zeroPending = false;
    for (let i = 0; i < len; i++) {
      const d = Number(str[i]);
      const unit = CN_UNITS[len - 1 - i];
      if (d === 0) {
        zeroPending = true;
      } else {
        if (zeroPending) { s += '零'; zeroPending = false; }
        s += CN_DIGITS[d] + unit;
      }
    }
    // “一十X” → “十X”
    s = s.replace(/^一十/, '十');
    return s;
  }
  return String(n);
}

// ── 工具：安全读取 State / 设置（State 不可用时给默认）────────────────────────
function getSettings() {
  const def = { volume: 0.8, muted: false, effects: true, reduceMotion: false, lang: 'zh' };
  try {
    if (State && State.settings && typeof State.settings === 'object') {
      return { ...def, ...State.settings };
    }
  } catch (_) { /* 降级 */ }
  return def;
}
function patchSettings(patch) {
  try {
    if (State && typeof State.set === 'function') {
      State.set({ settings: patch });
      return true;
    }
  } catch (_) { /* 降级 */ }
  return false;
}
function prefersReduceMotion() {
  if (getSettings().reduceMotion) return true;
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) { return false; }
}

// ── 工具：从 Save 读取已解锁进度（容错）─────────────────────────────────────
function getMaxUnlocked() {
  // 优先 State（已 hydrate），再退回 Save，最后 1
  try {
    if (State && typeof State.maxUnlocked === 'number' && State.maxUnlocked >= 1) {
      return Math.floor(State.maxUnlocked);
    }
  } catch (_) { /* 继续尝试 Save */ }
  try {
    if (Save && typeof Save.maxUnlocked === 'function') {
      const m = Save.maxUnlocked();
      if (typeof m === 'number' && m >= 1) return Math.floor(m);
    }
  } catch (_) { /* 降级 */ }
  return 1;
}

// ── 工具：DOM 创建 ──────────────────────────────────────────────────────────
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.cls) node.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html;
  if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
  if (opts.style) node.setAttribute('style', opts.style);
  if (opts.on) for (const ev in opts.on) node.addEventListener(ev, opts.on[ev]);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// 按钮：键盘可达 + aria-label + 最小兜底样式
function button(label, onClick, { cls = 'ui-btn', aria, primary, ghost, danger } = {}) {
  const classes = ['ui-btn'];
  if (cls && cls !== 'ui-btn') classes.push(cls);
  if (primary) classes.push('ui-btn-primary');
  if (ghost) classes.push('ui-btn-ghost');
  if (danger) classes.push('ui-btn-danger');
  const b = el('button', {
    cls: classes,
    text: label,
    attrs: { type: 'button', 'aria-label': aria || label },
    // 兜底：保证无 CSS 时仍可见可点
    style: 'display:inline-block;margin:.4em;padding:.7em 1.4em;cursor:pointer;'
      + 'background:rgba(20,20,24,.85);color:#cfcfcf;border:1px solid #555;'
      + 'font:inherit;letter-spacing:.15em;border-radius:2px;',
    on: {
      click: (e) => { try { onClick(e); } catch (err) { console.warn('[UI] button handler error:', err); } },
    },
  });
  return b;
}

// ── 内部状态 ────────────────────────────────────────────────────────────────
let _root = null;          // .ui-root
let _hudEl = null;         // 常驻 HUD（独立于 overlay）
const _overlays = {};      // 各覆盖层引用（title/chapter/narrative/complete/settings）
const _timers = new Set(); // 待清理的定时器
const _cleanups = new Set(); // 待清理的事件解绑等

function track(timerId) { _timers.add(timerId); return timerId; }
function clearTrackedTimer(id) { clearTimeout(id); clearInterval(id); _timers.delete(id); }
function clearAllTimers() { _timers.forEach((id) => { clearTimeout(id); clearInterval(id); }); _timers.clear(); }
function runCleanups() { _cleanups.forEach((fn) => { try { fn(); } catch (_) {} }); _cleanups.clear(); }

// 应用 reduceMotion 标记到 root（CSS 可据此降级动画）
function syncMotionClass() {
  if (!_root) return;
  _root.classList.toggle('ui-no-motion', prefersReduceMotion());
}

// 创建一个全屏覆盖层骨架
function makeOverlay(name, extraCls) {
  const o = el('div', {
    cls: ['ui-overlay', extraCls].filter(Boolean),
    attrs: { 'data-overlay': name, role: 'region', 'aria-hidden': 'true' },
    style: 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;'
      + 'pointer-events:auto;',
  });
  return o;
}

// 显示覆盖层（淡入），返回该层
function activate(o) {
  if (!o) return o;
  o.style.display = 'flex';
  o.setAttribute('aria-hidden', 'false');
  // 触发 reflow 以让 CSS transition 生效
  // eslint-disable-next-line no-unused-expressions
  o.offsetHeight;
  o.classList.add('is-active');
  o.classList.remove('is-leaving');
  return o;
}

// 隐藏单个覆盖层（淡出后真正 display:none）
function deactivate(o, after) {
  if (!o) { if (after) after(); return; }
  o.classList.remove('is-active');
  o.classList.add('is-leaving');
  const finish = () => {
    o.style.display = 'none';
    o.setAttribute('aria-hidden', 'true');
    o.classList.remove('is-leaving');
    if (after) { try { after(); } catch (_) {} }
  };
  if (prefersReduceMotion()) { finish(); return; }
  // 给 CSS 一点淡出时间（无 CSS 时也会按计时结束）
  track(setTimeout(finish, 420));
}

// 隐藏除某层外的所有 overlay（HUD 不受影响）
function hideOverlays(except) {
  for (const k in _overlays) {
    const o = _overlays[k];
    if (o && o !== except) {
      o.classList.remove('is-active', 'is-leaving');
      o.style.display = 'none';
      o.setAttribute('aria-hidden', 'true');
    }
  }
}

// ── 公开 API：UI ────────────────────────────────────────────────────────────
export const UI = {
  // 挂载到 #ui-layer，建立容器结构
  mount(rootEl) {
    try {
      if (!rootEl) { console.warn('[UI] mount: rootEl 缺失'); return; }
      // 已挂载则复用
      if (_root && _root.parentNode === rootEl) { syncMotionClass(); return; }

      _root = el('div', {
        cls: 'ui-root',
        attrs: { 'data-ui-root': '' },
        style: 'position:absolute;inset:0;pointer-events:none;font-family:inherit;',
      });

      // 各覆盖层（默认隐藏）；overlay 自身 pointer-events 由激活时控制
      _overlays.title = makeOverlay('title', 'ui-title');
      _overlays.chapter = makeOverlay('chapter', 'ui-chapter-card');
      _overlays.narrative = makeOverlay('narrative', 'ui-narrative');
      _overlays.complete = makeOverlay('complete', 'ui-complete');
      _overlays.settings = makeOverlay('settings', 'ui-settings');

      // HUD 常驻（非全屏覆盖），默认隐藏直到 showHUD
      _hudEl = el('div', {
        cls: 'ui-hud',
        attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': '关卡状态' },
        style: 'position:absolute;top:0;left:0;right:0;display:none;pointer-events:none;',
      });

      _root.appendChild(_overlays.title);
      _root.appendChild(_overlays.chapter);
      _root.appendChild(_overlays.narrative);
      _root.appendChild(_overlays.complete);
      _root.appendChild(_hudEl);
      _root.appendChild(_overlays.settings); // 设置层最高（最后挂载）

      rootEl.appendChild(_root);
      syncMotionClass();

      // 设置变化时同步动画降级类
      try {
        if (State && typeof State.subscribe === 'function') {
          _cleanups.add(State.subscribe(() => syncMotionClass()));
        }
      } catch (_) { /* 降级 */ }
    } catch (e) {
      console.warn('[UI] mount failed:', e);
    }
  },

  // 标题画面
  showTitle(onStart) {
    const o = _overlays.title;
    if (!o) return;
    hideOverlays(o);
    o.innerHTML = '';
    o.style.flexDirection = 'column';
    o.style.background = 'radial-gradient(ellipse at center,#0a0a0c 0%,#000 80%)';

    const fire = (payload) => {
      if (typeof onStart === 'function') {
        try { onStart(payload); } catch (e) { console.warn('[UI] onStart error:', e); }
      }
    };

    const maxUnlocked = getMaxUnlocked();
    const hasProgress = maxUnlocked > 1;

    const num = el('div', { cls: 'ui-title-num', text: '999',
      style: 'font-size:clamp(4rem,22vw,12rem);line-height:1;letter-spacing:.1em;color:#e8e8e8;' });
    const cn = el('div', { cls: 'ui-title-cn', text: '九 百 九 十 九',
      style: 'font-size:clamp(1.1rem,4vw,2rem);letter-spacing:.6em;color:#9a9a9a;margin-top:.6em;' });
    const sub = el('div', { cls: 'ui-title-sub', text: '一段没有尽头的下降',
      style: 'font-size:clamp(.85rem,3vw,1.05rem);letter-spacing:.3em;color:#6f6f6f;margin-top:1.4em;' });

    const actions = el('div', { cls: 'ui-title-actions',
      style: 'display:flex;flex-direction:column;align-items:center;margin-top:2.4em;' });

    if (hasProgress) {
      actions.appendChild(button(
        `继续下沉（第 ${cnNumber(maxUnlocked)} 关）`,
        () => fire({ mode: 'continue', level: maxUnlocked }),
        { primary: true, aria: `继续下沉，从第 ${maxUnlocked} 关开始` },
      ));
      actions.appendChild(button(
        '从最初坠落',
        () => fire({ mode: 'new', level: 1 }),
        { ghost: true, aria: '从第一关重新开始' },
      ));
    } else {
      actions.appendChild(button(
        '从最初坠落',
        () => fire({ mode: 'new', level: 1 }),
        { primary: true, aria: '从第一关开始' },
      ));
    }

    actions.appendChild(button(
      '设置',
      () => UI.showSettings(),
      { ghost: true, aria: '打开设置' },
    ));

    const warn = el('div', { cls: 'ui-title-warn',
      text: '建议在安静、独处时佩戴耳机游玩。本作含闪烁、低频与不安内容。',
      style: 'position:absolute;bottom:1.6em;left:0;right:0;text-align:center;'
        + 'font-size:.72rem;letter-spacing:.15em;color:#4a4a4a;padding:0 1.2em;' });

    o.appendChild(num);
    o.appendChild(cn);
    o.appendChild(sub);
    o.appendChild(actions);
    o.appendChild(warn);

    activate(o);
    // 焦点落到主按钮，便于键盘操作
    const firstBtn = o.querySelector('.ui-btn-primary') || o.querySelector('.ui-btn');
    if (firstBtn) track(setTimeout(() => { try { firstBtn.focus(); } catch (_) {} }, 50));
  },

  // 章节过场卡
  showChapterCard(chapter, done) {
    const o = _overlays.chapter;
    const fin = () => { if (typeof done === 'function') { try { done(); } catch (e) { console.warn('[UI] chapter done error:', e); } } };
    if (!o) { fin(); return; }
    hideOverlays(o);
    o.innerHTML = '';
    o.style.flexDirection = 'column';

    const ch = chapter && typeof chapter === 'object' ? chapter : {};
    const pal = (ch.palette && typeof ch.palette === 'object') ? ch.palette : {};
    const bg = pal.bg || '#050505';
    const ink = pal.ink || '#dcdcdc';
    const accent = pal.accent || pal.glow || '#8a3a3a';
    const fog = pal.fog || '#1a1a1a';

    o.style.background = `radial-gradient(ellipse at center, ${fog} 0%, ${bg} 85%)`;
    o.style.color = ink;

    const n = Number.isFinite(Number(ch.n)) ? Number(ch.n) : '?';
    const index = el('div', { cls: 'ui-chapter-index',
      text: `第 ${typeof n === 'number' ? cnNumber(n) : n} 章`,
      style: `font-size:clamp(.9rem,3.5vw,1.3rem);letter-spacing:.5em;color:${accent};opacity:.85;` });
    const title = el('div', { cls: 'ui-chapter-title', text: ch.title || '无名',
      style: `font-size:clamp(2rem,9vw,4.5rem);letter-spacing:.12em;margin-top:.4em;color:${ink};` });

    const theme = ch.theme
      ? el('div', { cls: 'ui-chapter-theme', text: ch.theme,
          style: `font-size:clamp(.85rem,3vw,1.05rem);letter-spacing:.35em;margin-top:1em;color:${accent};opacity:.7;` })
      : null;
    const summary = ch.summary
      ? el('div', { cls: 'ui-chapter-summary', text: ch.summary,
          style: 'max-width:34em;text-align:center;line-height:1.9;margin-top:1.4em;'
            + 'font-size:clamp(.85rem,3vw,1rem);opacity:.78;padding:0 1.4em;' })
      : null;
    const hint = el('div', { cls: 'ui-chapter-hint', text: '（点击继续下沉）',
      style: 'margin-top:2.4em;font-size:.75rem;letter-spacing:.3em;opacity:.4;' });

    o.appendChild(index);
    o.appendChild(title);
    if (theme) o.appendChild(theme);
    if (summary) o.appendChild(summary);
    o.appendChild(hint);

    activate(o);

    // 点击或键盘可跳过；否则数秒后自动继续
    let closed = false;
    const proceed = () => {
      if (closed) return;
      closed = true;
      o.removeEventListener('click', proceed);
      document.removeEventListener('keydown', onKey);
      deactivate(o, fin);
    };
    const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') proceed(); };
    o.addEventListener('click', proceed);
    document.addEventListener('keydown', onKey);
    _cleanups.add(() => document.removeEventListener('keydown', onKey));

    const dwell = prefersReduceMotion() ? 2600 : 4800;
    track(setTimeout(proceed, dwell));
  },

  // 常驻 HUD
  showHUD(level) {
    const hud = _hudEl;
    if (!hud) return;
    const lv = level && typeof level === 'object' ? level : {};
    const id = Number.isFinite(Number(lv.id)) ? Math.max(1, Math.min(999, Number(lv.id))) : 1;
    const total = 999;
    const chapterTitle = lv.chapterTitle || '';
    const depth = id / total; // 0..1 下降深度

    hud.innerHTML = '';
    hud.style.display = 'block';

    const bar = el('div', { cls: 'ui-hud-bar',
      style: 'display:flex;align-items:center;justify-content:space-between;'
        + 'padding:.7em 1.1em;pointer-events:none;gap:1em;'
        + 'background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent);' });

    // 左：关号 / 总数 + 章节
    const left = el('div', { cls: 'ui-hud-info', style: 'pointer-events:none;' });
    const lvLine = el('div', { cls: 'ui-hud-level',
      style: 'font-variant-numeric:tabular-nums;letter-spacing:.18em;color:#cfcfcf;'
        + 'font-size:.95rem;opacity:.85;' }, [
      el('span', { cls: 'ui-hud-cur', text: String(id) }),
      el('span', { text: ' / ', style: 'opacity:.4;' }),
      el('span', { cls: 'ui-hud-total', text: String(total), style: 'opacity:.5;' }),
    ]);
    left.appendChild(lvLine);
    if (chapterTitle) {
      left.appendChild(el('div', { cls: 'ui-hud-chapter', text: chapterTitle,
        style: 'font-size:.72rem;letter-spacing:.3em;color:#7a7a7a;margin-top:.2em;' }));
    }

    // 中：下降深度指示（细腻的纵向/横向进度）
    const depthWrap = el('div', { cls: 'ui-hud-depth',
      attrs: { role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(total),
        'aria-valuenow': String(id), 'aria-label': `下降深度 ${id} / ${total}` },
      style: 'flex:1;max-width:240px;height:2px;background:rgba(120,120,120,.18);'
        + 'position:relative;overflow:hidden;border-radius:2px;' });
    const depthFill = el('div', { cls: 'ui-hud-depth-fill',
      style: `position:absolute;left:0;top:0;bottom:0;width:${(depth * 100).toFixed(2)}%;`
        + 'background:linear-gradient(to right,#3a3a44,#8a3a3a);' });
    depthWrap.appendChild(depthFill);

    // 右：静音 / 设置小按钮
    const tools = el('div', { cls: 'ui-hud-tools',
      style: 'display:flex;gap:.3em;pointer-events:auto;' });
    const muted = getSettings().muted;
    const muteBtn = el('button', {
      cls: ['ui-hud-btn'],
      text: muted ? '🔇' : '🔊',
      attrs: { type: 'button', 'aria-label': muted ? '取消静音' : '静音', 'aria-pressed': String(muted) },
      style: 'background:transparent;border:0;color:#9a9a9a;cursor:pointer;'
        + 'font-size:1rem;padding:.2em .35em;line-height:1;',
      on: { click: () => {
        const cur = getSettings().muted;
        patchSettings({ muted: !cur });
        muteBtn.textContent = !cur ? '🔇' : '🔊';
        muteBtn.setAttribute('aria-pressed', String(!cur));
        muteBtn.setAttribute('aria-label', !cur ? '取消静音' : '静音');
      } },
    });
    const setBtn = el('button', {
      cls: ['ui-hud-btn'],
      text: '⚙',
      attrs: { type: 'button', 'aria-label': '设置' },
      style: 'background:transparent;border:0;color:#9a9a9a;cursor:pointer;'
        + 'font-size:1rem;padding:.2em .35em;line-height:1;',
      on: { click: () => UI.showSettings() },
    });
    tools.appendChild(muteBtn);
    tools.appendChild(setBtn);

    bar.appendChild(left);
    bar.appendChild(depthWrap);
    bar.appendChild(tools);
    hud.appendChild(bar);
  },

  // 叙事文本逐段呈现
  showNarrative(level, onDone) {
    const o = _overlays.narrative;
    const fin = () => { if (typeof onDone === 'function') { try { onDone(); } catch (e) { console.warn('[UI] narrative onDone error:', e); } } };
    if (!o) { fin(); return; }
    hideOverlays(o);
    o.innerHTML = '';
    o.style.flexDirection = 'column';
    o.style.justifyContent = 'center';
    o.style.background = 'linear-gradient(to bottom,rgba(0,0,0,.72),rgba(0,0,0,.5))';

    const lv = level && typeof level === 'object' ? level : {};
    let paras = Array.isArray(lv.narrative) ? lv.narrative.filter((p) => typeof p === 'string' && p.length) : [];
    if (!paras.length) paras = ['……'];
    const whisper = (typeof lv.whisper === 'string' && lv.whisper.trim()) ? lv.whisper.trim() : '';

    const body = el('div', { cls: 'ui-narrative-body',
      style: 'max-width:36em;margin:0 auto;padding:0 1.6em;text-align:left;'
        + 'line-height:2.1;color:#d8d8d8;font-size:clamp(1rem,3.6vw,1.25rem);' });
    o.appendChild(body);

    // 角落低语（更隐秘的样式）
    if (whisper) {
      o.appendChild(el('div', { cls: 'ui-whisper', text: whisper,
        attrs: { 'aria-label': '低语：' + whisper },
        style: 'position:absolute;bottom:1.4em;right:1.4em;max-width:14em;text-align:right;'
          + 'font-size:.74rem;letter-spacing:.12em;color:#5a3a3a;opacity:.55;'
          + 'font-style:italic;pointer-events:none;' }));
    }

    const advance = el('div', { cls: 'ui-narrative-advance', text: '点击继续',
      attrs: { role: 'button', tabindex: '0', 'aria-label': '继续叙事' },
      style: 'position:absolute;bottom:1.2em;left:0;right:0;text-align:center;'
        + 'font-size:.75rem;letter-spacing:.3em;color:#6a6a6a;opacity:.6;pointer-events:none;' });
    o.appendChild(advance);

    activate(o);

    const reduce = prefersReduceMotion();
    let idx = 0;             // 当前正在显示的段落索引
    let typing = null;       // 当前打字定时器
    let curParaEl = null;
    let curText = '';
    let curPos = 0;
    let done = false;

    // 渐显/打字机显示一段
    const showPara = () => {
      if (idx >= paras.length) { complete(); return; }
      curText = paras[idx];
      curPos = 0;
      curParaEl = el('p', { cls: 'ui-narrative-para',
        style: 'margin:0 0 1.1em 0;opacity:' + (reduce ? '1' : '.0') + ';transition:opacity .9s ease;' });
      body.appendChild(curParaEl);

      if (reduce) {
        // 降级：整段直接出现
        curParaEl.textContent = curText;
        curParaEl.classList.add('is-revealed');
        idx += 1;
        // 自动留白后继续，但也允许点击
        track(setTimeout(() => { if (idx < paras.length) showPara(); else complete(); }, 1400));
        return;
      }

      // 渐显容器
      requestAnimationFrame(() => { if (curParaEl) curParaEl.style.opacity = '1'; });

      // 打字机：逐字
      const cursor = el('span', { cls: 'ui-narrative-cursor', text: '▌',
        style: 'opacity:.6;animation:none;' });
      const speed = 38; // ms/字
      typing = track(setInterval(() => {
        curPos += 1;
        curParaEl.textContent = curText.slice(0, curPos);
        curParaEl.appendChild(cursor);
        if (curPos >= curText.length) {
          clearTrackedTimer(typing); typing = null;
          curParaEl.textContent = curText; // 去掉光标
          curParaEl.classList.add('is-revealed');
          idx += 1;
          // 段落间停顿后自动进入下一段（也可点击加速）
          track(setTimeout(() => { if (!done && idx <= paras.length) {
            if (idx < paras.length) showPara(); else complete();
          } }, 900));
        }
      }, speed));
    };

    // 点击 / 键盘加速：正在打字则补全当前段；否则进入下一段
    const accelerate = () => {
      if (done) return;
      if (typing) {
        clearTrackedTimer(typing); typing = null;
        curParaEl.textContent = curText;
        curParaEl.classList.add('is-revealed');
        idx += 1;
        track(setTimeout(() => { if (!done) { if (idx < paras.length) showPara(); else complete(); } }, 120));
      } else {
        // 已显示完当前段，立即推进
        if (idx < paras.length) showPara(); else complete();
      }
    };

    const complete = () => {
      if (done) return;
      done = true;
      cleanup();
      fin();
    };

    const onClick = () => accelerate();
    const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); accelerate(); } };
    const cleanup = () => {
      o.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      if (typing) clearTrackedTimer(typing);
    };
    o.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    _cleanups.add(cleanup);

    showPara();
  },

  // 关卡完成过渡（第 999 关有终局特殊画面）
  showComplete(level, onNext) {
    const o = _overlays.complete;
    const go = () => { if (typeof onNext === 'function') { try { onNext(); } catch (e) { console.warn('[UI] onNext error:', e); } } };
    if (!o) { go(); return; }
    hideOverlays(o);
    o.innerHTML = '';
    o.classList.remove('ui-ending');
    o.style.flexDirection = 'column';

    const lv = level && typeof level === 'object' ? level : {};
    const id = Number.isFinite(Number(lv.id)) ? Number(lv.id) : 0;
    const isEnding = id === 999 || lv.ending === true || lv.isFinal === true;

    if (isEnding) {
      // ── 终局画面 ──
      o.classList.add('ui-ending');
      o.style.background = 'radial-gradient(ellipse at center,#100406 0%,#000 90%)';
      o.appendChild(el('div', { cls: 'ui-ending-title', text: '底',
        style: 'font-size:clamp(3rem,16vw,9rem);letter-spacing:.3em;color:#caa;opacity:.92;' }));
      o.appendChild(el('div', { cls: 'ui-ending-body',
        html: '你抵达了第 九百九十九 关。<br>下面，再没有台阶。<br><br>'
          + '回头看时，来路也已不见。',
        style: 'max-width:30em;text-align:center;line-height:2.2;margin-top:1.6em;'
          + 'font-size:clamp(.9rem,3.2vw,1.1rem);color:#9a8888;padding:0 1.4em;' }));
      const restart = button('回到地表', () => {
        // 终局后默认回标题；引擎也可通过 onNext 自行处理
        go();
      }, { ghost: true, aria: '回到标题画面' });
      const wrap = el('div', { style: 'margin-top:2.6em;' }, [restart]);
      o.appendChild(wrap);
      activate(o);
      const fb = o.querySelector('.ui-btn');
      if (fb) track(setTimeout(() => { try { fb.focus(); } catch (_) {} }, 60));
      return;
    }

    // ── 普通完成过渡：“下沉…” ──
    o.style.background = 'linear-gradient(to bottom,rgba(0,0,0,.85),#000)';
    const nextId = Math.min(999, (id || 0) + 1);
    o.appendChild(el('div', { cls: 'ui-complete-text', text: '下 沉 …',
      style: 'font-size:clamp(1.6rem,7vw,3rem);letter-spacing:.45em;color:#b8b8b8;'
        + (prefersReduceMotion() ? '' : 'animation:none;') }));
    o.appendChild(el('div', { cls: 'ui-complete-deep',
      text: `· 第 ${cnNumber(nextId)} 关 ·`,
      style: 'margin-top:1.4em;font-size:.8rem;letter-spacing:.3em;color:#5a5a5a;' }));

    activate(o);

    // 自动推进（可点击/按键跳过）
    let advanced = false;
    const proceed = () => {
      if (advanced) return;
      advanced = true;
      o.removeEventListener('click', proceed);
      document.removeEventListener('keydown', onKey);
      deactivate(o, go);
    };
    const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') proceed(); };
    o.addEventListener('click', proceed);
    document.addEventListener('keydown', onKey);
    _cleanups.add(() => document.removeEventListener('keydown', onKey));

    track(setTimeout(proceed, prefersReduceMotion() ? 1400 : 2600));
  },

  // 设置面板
  showSettings() {
    const o = _overlays.settings;
    if (!o) return;
    // 设置层覆盖在最上，不隐藏其它（关闭后回到原界面）
    o.innerHTML = '';
    o.style.background = 'rgba(0,0,0,.78)';

    const s = getSettings();

    const panel = el('div', { cls: 'ui-settings-panel',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置' },
      style: 'background:#0c0c0e;border:1px solid #333;color:#cfcfcf;'
        + 'width:min(440px,92vw);max-height:88vh;overflow:auto;padding:1.6em 1.6em 1.2em;'
        + 'border-radius:4px;box-shadow:0 0 40px rgba(0,0,0,.8);' });

    // 标题 + 关闭
    const head = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:1.2em;' }, [
      el('div', { cls: 'ui-settings-title', text: '设置',
        style: 'font-size:1.3rem;letter-spacing:.3em;color:#e0e0e0;' }),
    ]);
    const closeBtn = el('button', {
      cls: ['ui-btn', 'ui-btn-close'], text: '×',
      attrs: { type: 'button', 'aria-label': '关闭设置' },
      style: 'background:transparent;border:0;color:#999;font-size:1.6rem;cursor:pointer;'
        + 'line-height:1;padding:.1em .3em;',
      on: { click: () => UI.hideSettings() },
    });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // 字段工具
    const field = (labelText, control) => el('div', { cls: 'ui-field',
      style: 'display:flex;align-items:center;justify-content:space-between;gap:1em;'
        + 'padding:.7em 0;border-bottom:1px solid rgba(255,255,255,.06);' }, [
      el('label', { cls: 'ui-field-label', text: labelText,
        attrs: { for: control.id || '' },
        style: 'letter-spacing:.15em;font-size:.92rem;color:#bcbcbc;flex:1;' }),
      el('div', { cls: 'ui-field-control', style: 'flex:0 0 auto;' }, [control]),
    ]);

    // 音量滑块
    const volId = 'ui-set-volume';
    const vol = el('input', { cls: 'ui-range',
      attrs: { id: volId, type: 'range', min: '0', max: '100', step: '1',
        value: String(Math.round((s.volume ?? 0.8) * 100)), 'aria-label': '主音量' },
      on: { input: (e) => patchSettings({ volume: Number(e.target.value) / 100 }) } });
    panel.appendChild(field('音量', vol));

    // 静音
    const muteId = 'ui-set-mute';
    const mute = el('input', { cls: 'ui-switch',
      attrs: Object.assign({ id: muteId, type: 'checkbox', 'aria-label': '静音' }, s.muted ? { checked: 'checked' } : {}),
      on: { change: (e) => patchSettings({ muted: !!e.target.checked }) } });
    panel.appendChild(field('静音', mute));

    // 特效开关
    const fxId = 'ui-set-effects';
    const fx = el('input', { cls: 'ui-switch',
      attrs: Object.assign({ id: fxId, type: 'checkbox', 'aria-label': '视觉特效' }, s.effects ? { checked: 'checked' } : {}),
      on: { change: (e) => patchSettings({ effects: !!e.target.checked }) } });
    panel.appendChild(field('视觉特效', fx));

    // 减少动态
    const rmId = 'ui-set-reduce';
    const rm = el('input', { cls: 'ui-switch',
      attrs: Object.assign({ id: rmId, type: 'checkbox', 'aria-label': '减少动态效果' }, s.reduceMotion ? { checked: 'checked' } : {}),
      on: { change: (e) => { patchSettings({ reduceMotion: !!e.target.checked }); syncMotionClass(); } } });
    panel.appendChild(field('减少动态', rm));

    // 语言（暂仅中文）
    const langId = 'ui-set-lang';
    const lang = el('select', { cls: 'ui-select',
      attrs: { id: langId, 'aria-label': '语言' },
      on: { change: (e) => patchSettings({ lang: e.target.value }) } }, [
      el('option', { text: '中文', attrs: { value: 'zh', selected: 'selected' } }),
    ]);
    panel.appendChild(field('语言', lang));

    // 危险区：重置进度（二次确认）
    const danger = el('div', { cls: 'ui-settings-danger',
      style: 'margin-top:1.4em;padding-top:1em;border-top:1px solid rgba(180,60,60,.3);' });
    const resetState = { confirming: false };
    const resetBtn = button('重置进度', () => {
      if (!resetState.confirming) {
        resetState.confirming = true;
        resetBtn.textContent = '确认抹去全部记忆？（再次点击）';
        resetBtn.setAttribute('aria-label', '确认重置进度，再次点击执行');
        // 数秒未确认则回退
        track(setTimeout(() => {
          if (resetState.confirming) {
            resetState.confirming = false;
            resetBtn.textContent = '重置进度';
            resetBtn.setAttribute('aria-label', '重置进度');
          }
        }, 4000));
        return;
      }
      // 执行重置
      let ok = false;
      try {
        if (Save && typeof Save.clear === 'function') { Save.clear(); ok = true; }
      } catch (e) { console.warn('[UI] Save.clear failed:', e); }
      try {
        if (State && typeof State.reset === 'function') { State.reset(); ok = true; }
      } catch (e) { console.warn('[UI] State.reset failed:', e); }
      resetState.confirming = false;
      resetBtn.textContent = ok ? '已抹去' : '重置失败';
      resetBtn.disabled = ok;
      syncMotionClass();
    }, { danger: true, aria: '重置进度' });
    danger.appendChild(el('div', { cls: 'ui-field-label', text: '危险区',
      style: 'font-size:.78rem;letter-spacing:.2em;color:#a05a5a;margin-bottom:.6em;' }));
    danger.appendChild(resetBtn);
    panel.appendChild(danger);

    // 底部关闭
    const actions = el('div', { cls: 'ui-settings-actions',
      style: 'display:flex;justify-content:flex-end;margin-top:1.4em;' }, [
      button('完成', () => UI.hideSettings(), { ghost: true, aria: '关闭设置' }),
    ]);
    panel.appendChild(actions);

    o.appendChild(panel);
    activate(o);

    // Esc 关闭 + 焦点管理
    const onKey = (e) => { if (e.key === 'Escape') UI.hideSettings(); };
    document.addEventListener('keydown', onKey);
    o._settingsKeyHandler = onKey;
    track(setTimeout(() => { try { closeBtn.focus(); } catch (_) {} }, 50));
  },

  // 关闭设置（保留其它界面）
  hideSettings() {
    const o = _overlays.settings;
    if (!o) return;
    if (o._settingsKeyHandler) {
      document.removeEventListener('keydown', o._settingsKeyHandler);
      o._settingsKeyHandler = null;
    }
    deactivate(o);
  },

  // 隐藏所有覆盖层（HUD 也隐藏）
  hideAll() {
    clearAllTimers();
    for (const k in _overlays) {
      const o = _overlays[k];
      if (!o) continue;
      if (o._settingsKeyHandler) {
        document.removeEventListener('keydown', o._settingsKeyHandler);
        o._settingsKeyHandler = null;
      }
      o.classList.remove('is-active', 'is-leaving');
      o.style.display = 'none';
      o.setAttribute('aria-hidden', 'true');
    }
    if (_hudEl) _hudEl.style.display = 'none';
  },

  // 显式销毁（可选；engine.destroy 时可调用）
  destroy() {
    this.hideAll();
    runCleanups();
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
    _root = null;
    _hudEl = null;
    for (const k in _overlays) delete _overlays[k];
  },
};

export default UI;
