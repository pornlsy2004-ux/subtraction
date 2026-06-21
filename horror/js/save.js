// save.js — 《九百九十九》存档系统
// 负责：进度持久化、成就、设置存储。纯 ES Module，无依赖。
// 设计目标：
//   1. 健壮：localStorage 不可用（隐私模式/禁用）时透明降级到内存对象，所有方法照常工作。
//   2. 安全：JSON 解析失败 / 数据损坏时安全重置；schema 演进时做版本迁移与字段补全。
//   3. 高效：普通写操作防抖合并，关键进度（unlock/grant）确保最终落盘，页面卸载时强制 flush。

// ── 常量 ───────────────────────────────────────────────────────────────────

// 存档版本。结构变更时递增，并在 migrate() 中追加迁移逻辑。
const SCHEMA_VERSION = 1;

// localStorage key 用命名空间前缀，避免与同源其它脚本冲突。
const STORAGE_KEY = 'nhnn999:v1';

// 写防抖延迟（毫秒）：高频 set 在此窗口内合并为一次落盘。
const DEBOUNCE_MS = 250;

// ── 成就定义表（供 UI 渲染成就列表 / 弹出提示） ──────────────────────────────
// hidden:true 表示在未获得前 UI 应隐藏其名称与描述（只露出“???”）。
export const ACHIEVEMENTS = [
  { id: 'first_descent', name: '首次下沉',   desc: '踏出第一步，离开起点。' },
  { id: 'reach_100',     name: '百层之下',   desc: '抵达第 100 关。' },
  { id: 'reach_333',     name: '三分之一',   desc: '抵达第 333 关。' },
  { id: 'reach_666',     name: '不祥之数',   desc: '抵达第 666 关。' },
  { id: 'reach_999',     name: '终局',       desc: '抵达第 999 关。', hidden: true },
  { id: 'first_cipher',  name: '初解密文',   desc: '解开第一个密文。' },
  { id: 'patient_gaze',  name: '凝视到底',   desc: '在一关“等待/凝视”中坚持到最后。' },
  { id: 'collector',     name: '拾遗者',     desc: '找全某一章的全部隐藏物。' },
  { id: 'the_loop',      name: '回到起点',   desc: '循环回到了最初的地方。', hidden: true },
  { id: 'no_blink',      name: '不曾退缩',   desc: '在“长按抵抗”中从未松手。' },
  { id: 'deep_diver',    name: '深潜',       desc: '单次连续下沉超过 50 关。' },
  { id: 'the_listener',  name: '倾听者',     desc: '听见了墙缝里所有的低语。', hidden: true },
];

// 成就 id 集合（用于校验 grant 的合法性）
const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));

// ── 默认存档结构 ────────────────────────────────────────────────────────────
// 任何字段缺失都会在 load() 时由 fillDefaults() 补齐，保证向后兼容。
function defaultSave() {
  const now = Date.now();
  return {
    version: SCHEMA_VERSION,
    maxUnlocked: 1,      // 已解锁的最大关（永不回退）
    current: 1,          // 当前所在关
    fearPeak: 0,         // 历史最高恐惧值 0..1
    flags: {},           // 叙事分支标记（任意键值）
    settings: {
      volume: 0.6,
      muted: false,
      effects: true,
      reduceMotion: false,
      lang: 'zh',
    },
    achievements: [],    // 已获成就 id 列表
    stats: {
      started: now,      // 首次开始游玩时间
      lastPlayed: now,   // 最近一次游玩时间
      fails: 0,          // 失败/死亡次数
      deepestReached: 1, // 历史到达的最深关
      totalTime: 0,      // 累计游玩毫秒数（由引擎累加）
    },
    firstSeen: now,      // 首次创建存档时间
  };
}

// ── 存储后端：localStorage 探测 + 内存降级 ──────────────────────────────────

// 探测 localStorage 是否真正可用（隐私模式下可能存在但写入抛异常）。
function detectStorage() {
  try {
    const ls = window.localStorage;
    const probe = '__nhnn_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch (_e) {
    return null; // 不可用 → 走内存降级
  }
}

const _ls = detectStorage();          // null 表示降级
let _memoryStore = null;              // 降级时的内存字符串（模拟一条 localStorage 记录）

// 统一的底层读：返回原始字符串或 null。
function rawRead() {
  if (_ls) {
    try { return _ls.getItem(STORAGE_KEY); } catch (_e) { return _memoryStore; }
  }
  return _memoryStore;
}

// 统一的底层写：失败时回退到内存，绝不抛出。
function rawWrite(str) {
  if (_ls) {
    try { _ls.setItem(STORAGE_KEY, str); return; }
    catch (_e) { /* 配额满/被禁 → 落到内存 */ }
  }
  _memoryStore = str;
}

// 统一的底层删。
function rawRemove() {
  if (_ls) {
    try { _ls.removeItem(STORAGE_KEY); } catch (_e) { /* ignore */ }
  }
  _memoryStore = null;
}

// ── 内存中的当前存档（单一真相源） ──────────────────────────────────────────
let _state = null;        // 解析后的存档对象；首次访问时惰性 load
let _dirty = false;       // 是否有未落盘的更改
let _debounceTimer = null;

// ── schema 迁移 + 字段补全 ──────────────────────────────────────────────────

// 把任意（可能是旧版本/残缺）的对象迁移到当前版本结构。
function migrate(obj) {
  if (!obj || typeof obj !== 'object') return defaultSave();

  // 逐版本迁移：未来新增版本时在此 switch 链中累加。
  let v = typeof obj.version === 'number' ? obj.version : 0;
  // 示例：从 v0（无 version 字段的早期数据）升到 v1，仅需补字段，无破坏性改动。
  // while (v < SCHEMA_VERSION) { switch (v) { case 0: /* ... */ break; } v++; }
  if (v < SCHEMA_VERSION) v = SCHEMA_VERSION;
  obj.version = v;

  return fillDefaults(obj);
}

// 用默认值递归补全缺失字段（schema 演进安全：新加的字段自动出现）。
function fillDefaults(obj) {
  const def = defaultSave();
  const out = { ...def, ...obj };

  // 嵌套对象需要逐键合并，避免整体覆盖丢字段。
  out.settings = { ...def.settings, ...(obj.settings || {}) };
  out.stats = { ...def.stats, ...(obj.stats || {}) };
  out.flags = (obj.flags && typeof obj.flags === 'object') ? obj.flags : {};

  // 类型/范围净化，防止损坏数据污染运行时。
  out.version = SCHEMA_VERSION;
  out.maxUnlocked = clampInt(out.maxUnlocked, 1, 999, 1);
  out.current = clampInt(out.current, 1, 999, 1);
  out.fearPeak = clamp01(out.fearPeak);
  out.settings.volume = clamp01(out.settings.volume, 0.6);
  out.settings.muted = !!out.settings.muted;
  out.settings.effects = out.settings.effects !== false; // 默认 true
  out.settings.reduceMotion = !!out.settings.reduceMotion;
  if (typeof out.settings.lang !== 'string') out.settings.lang = 'zh';

  // 成就列表：去重 + 丢弃未知 id。
  const seen = new Set();
  out.achievements = (Array.isArray(obj.achievements) ? obj.achievements : [])
    .filter((id) => ACHIEVEMENT_IDS.has(id) && !seen.has(id) && seen.add(id));

  return out;
}

function clampInt(v, min, max, fallback) {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
function clamp01(v, fallback = 0) {
  v = Number(v);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

// ── 核心读写流程 ────────────────────────────────────────────────────────────

// 确保 _state 已加载（惰性）。
function ensureLoaded() {
  if (_state === null) doLoad();
  return _state;
}

// 从底层读取并解析；解析失败 → 安全重置为默认存档。
function doLoad() {
  const raw = rawRead();
  if (!raw) {
    _state = defaultSave();
    return _state;
  }
  try {
    const parsed = JSON.parse(raw);
    _state = migrate(parsed);
  } catch (_e) {
    // 数据损坏：不抛错、不阻塞游戏，直接重置（旧的坏数据会被下次写覆盖）。
    _state = defaultSave();
  }
  return _state;
}

// 安排一次防抖落盘（普通写用）。
function scheduleFlush() {
  _dirty = true;
  if (_debounceTimer !== null) return;
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    flush();
  }, DEBOUNCE_MS);
}

// 立即把内存状态写入底层存储（关键进度 / 卸载时调用）。
function flush() {
  if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (!_dirty || _state === null) return;
  try {
    rawWrite(JSON.stringify(_state));
    _dirty = false;
  } catch (_e) {
    // 序列化失败极罕见（如 flags 里塞了循环引用）；保留 dirty 以便后续重试。
  }
}

// ── 页面卸载时强制落盘，保证 unlock/grant 等关键进度不丢失 ───────────────────
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // visibilitychange（切到后台）是移动端最可靠的“即将离开”信号。
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  // pagehide 覆盖刷新/关闭/前进后退缓存。
  window.addEventListener('pagehide', flush);
  // beforeunload 兜底桌面端。
  window.addEventListener('beforeunload', flush);
}

// ── 公开 API：严格遵守 CONTRACT.md 的 Save 接口签名 ─────────────────────────
export const Save = {
  // 读取存档对象（不存在则返回带默认值的新对象）。返回引用即内存真相源。
  load() {
    return ensureLoaded();
  },

  // 用传入状态整体覆盖存档（做迁移/补全后），防抖落盘。
  save(state) {
    _state = migrate(state || {});
    scheduleFlush();
    return _state;
  },

  // 读取单个顶层字段。
  get(key) {
    const s = ensureLoaded();
    return s[key];
  },

  // 写入单个顶层字段并持久化（防抖）。
  set(key, val) {
    const s = ensureLoaded();
    s[key] = val;
    scheduleFlush();
    return val;
  },

  // 把 maxUnlocked 提升到至少 id（不回退），关键进度立即落盘。
  unlock(id) {
    const s = ensureLoaded();
    id = clampInt(id, 1, 999, 1);
    if (id > s.maxUnlocked) {
      s.maxUnlocked = id;
      if (id > s.stats.deepestReached) s.stats.deepestReached = id;
      s.stats.lastPlayed = Date.now();
      _dirty = true;
      flush(); // 进度类立即落盘
    }
    return s.maxUnlocked;
  },

  // 返回已解锁最大关（默认 1）。
  maxUnlocked() {
    return ensureLoaded().maxUnlocked;
  },

  // 返回已获成就 id 列表（副本，避免外部篡改内部数组）。
  achievements() {
    return ensureLoaded().achievements.slice();
  },

  // 授予一个成就（去重）。返回 true 表示本次为新授予（UI 可据此弹提示）。
  grant(id) {
    const s = ensureLoaded();
    if (!ACHIEVEMENT_IDS.has(id)) return false; // 未知成就忽略
    if (s.achievements.includes(id)) return false; // 已有 → 非新授予
    s.achievements.push(id);
    _dirty = true;
    flush(); // 成就类立即落盘，防止刷新丢失
    return true;
  },

  // 清空本项目存档（仅清自己的 key；二次确认由 UI 负责）。
  clear() {
    rawRemove();
    _state = defaultSave();
    _dirty = false;
    if (_debounceTimer !== null) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    return _state;
  },

  // ── 契约外的便捷扩展（不破坏接口；供同项目模块按需使用） ──
  // 立即落盘（引擎在关键时刻可主动调用）。
  flush() { flush(); },
  // 当前后端是否为持久化（false 表示降级到内存，UI 可提示玩家进度不会保存）。
  isPersistent() { return _ls !== null; },
};
