// state.js — 全局可观察状态机
// 职责：持有运行时状态（当前关、解锁进度、恐惧值、设置、叙事分支标记），
// 提供 get/set/subscribe/reset，并在变化时通过 Save 模块持久化。
//
// 设计要点：
// - State 是单例对象，对外暴露只读快照（get 返回浅拷贝，避免外部直接篡改内部引用）。
// - set(patch) 浅合并；对 settings / flags 做一层嵌套浅合并（patch 里只给增量即可）。
// - 任何 set 都会：1) 通知订阅者 2) 触发持久化（容错：Save 缺失/报错不影响主流程）。

import { Save } from './save.js';

// 内部真实状态
const _state = {
  current: 1,       // 当前所在关卡（1..999）
  maxUnlocked: 1,   // 已解锁的最大关卡号
  fear: 0,          // 综合恐惧值 0..1，驱动美术/特效/音频强度
  settings: {
    volume: 0.8,    // 主音量 0..1
    muted: false,   // 是否静音
    effects: true,  // 是否启用视觉后期特效
    reduceMotion: false, // 减弱动态（无障碍 / 移动端降级）
    lang: 'zh',     // 语言（默认中文）
  },
  flags: {},        // 叙事分支标记，例如 { sawMirror:true, choseLeft:false }
};

// 订阅者集合
const _subs = new Set();

// 工具：把 0..1 钳制到合法区间
function clamp01(v) {
  v = Number(v);
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 把内部状态做一份浅快照（settings/flags 也拷一层，防止外部改内部引用）
function snapshot() {
  return {
    current: _state.current,
    maxUnlocked: _state.maxUnlocked,
    fear: _state.fear,
    settings: { ..._state.settings },
    flags: { ..._state.flags },
  };
}

// 通知所有订阅者（容错：单个订阅者报错不影响其他）
function notify() {
  const snap = snapshot();
  _subs.forEach((fn) => {
    try { fn(snap); } catch (e) { console.warn('[State] subscriber error:', e); }
  });
}

// 持久化设置 / 进度到 Save（容错：Save 未实现时静默降级）
function persist() {
  try {
    if (!Save) return;
    if (typeof Save.set === 'function') {
      Save.set('settings', { ..._state.settings });
      Save.set('flags', { ..._state.flags });
      Save.set('current', _state.current);
    }
    // 进度解锁交给 Save.unlock（若存在），保证它内部能维护 maxUnlocked
    if (typeof Save.unlock === 'function') {
      Save.unlock(_state.maxUnlocked);
    }
  } catch (e) {
    console.warn('[State] persist failed:', e);
  }
}

export const State = {
  // 为兼容契约里 “State = { current, maxUnlocked, fear, settings, flags }” 的形态，
  // 暴露 getter（读取实时值），但写入请走 set()。
  get current() { return _state.current; },
  get maxUnlocked() { return _state.maxUnlocked; },
  get fear() { return _state.fear; },
  get settings() { return { ..._state.settings }; },
  get flags() { return { ..._state.flags }; },

  // 读取完整快照
  get() {
    return snapshot();
  },

  // 浅合并补丁；settings/flags 做嵌套合并。会通知订阅者 + 持久化。
  set(patch) {
    if (!patch || typeof patch !== 'object') return snapshot();

    if ('current' in patch) {
      const c = Math.floor(Number(patch.current));
      if (!Number.isNaN(c)) _state.current = c;
    }
    if ('maxUnlocked' in patch) {
      const m = Math.floor(Number(patch.maxUnlocked));
      if (!Number.isNaN(m)) _state.maxUnlocked = Math.max(_state.maxUnlocked, m);
    }
    if ('fear' in patch) {
      _state.fear = clamp01(patch.fear);
    }
    if (patch.settings && typeof patch.settings === 'object') {
      _state.settings = { ..._state.settings, ...patch.settings };
      // 钳制音量
      _state.settings.volume = clamp01(_state.settings.volume);
    }
    if (patch.flags && typeof patch.flags === 'object') {
      _state.flags = { ..._state.flags, ...patch.flags };
    }

    notify();
    persist();
    return snapshot();
  },

  // 订阅状态变化，返回取消订阅函数
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    _subs.add(fn);
    // 立即推一次当前快照，便于订阅者初始化
    try { fn(snapshot()); } catch (e) { console.warn('[State] subscriber init error:', e); }
    return () => { _subs.delete(fn); };
  },

  // 从 Save 载入持久化的设置 / 进度（engine 启动时调用）。
  // 不触发 persist（避免回写），但会通知订阅者。
  hydrate() {
    try {
      if (!Save) return snapshot();
      const saved = (typeof Save.get === 'function' && Save.get('settings')) || null;
      if (saved && typeof saved === 'object') {
        _state.settings = { ..._state.settings, ...saved };
        _state.settings.volume = clamp01(_state.settings.volume);
      }
      const flags = (typeof Save.get === 'function' && Save.get('flags')) || null;
      if (flags && typeof flags === 'object') _state.flags = { ...flags };

      const mu = (typeof Save.maxUnlocked === 'function') ? Save.maxUnlocked() : null;
      if (typeof mu === 'number' && mu >= 1) _state.maxUnlocked = Math.floor(mu);

      const cur = (typeof Save.get === 'function' && Save.get('current')) || null;
      if (typeof cur === 'number' && cur >= 1) _state.current = Math.floor(cur);
    } catch (e) {
      console.warn('[State] hydrate failed:', e);
    }
    notify();
    return snapshot();
  },

  // 重置到初始状态（清空进度 + 设置）。会通知 + 持久化（清空）。
  reset() {
    _state.current = 1;
    _state.maxUnlocked = 1;
    _state.fear = 0;
    _state.settings = {
      volume: 0.8, muted: false, effects: true, reduceMotion: false, lang: 'zh',
    };
    _state.flags = {};
    try {
      if (Save && typeof Save.clear === 'function') Save.clear();
    } catch (e) {
      console.warn('[State] reset clear failed:', e);
    }
    notify();
    persist();
    return snapshot();
  },
};
