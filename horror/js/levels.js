// levels.js — 《九百九十九》关卡整合器（内容枢纽）
// 把【叙事 story.js】+【章节 chapters.js】+【美术 art.js 所需 art】+
// 【音频 audio.js 所需 audio】+【互动 interactions.js 所需 interaction】整合成
// engine.js 消费的完整 Level 对象。
//
// 三条铁律：
//   1) 纯函数 / 确定性：同一 id 永远产出同一关卡（所有随机来自 RNG(seed)）。
//   2) 极致健壮：任何依赖模块（chapters / story）缺失或抛错都降级，buildLevel
//      对任意整数都不抛异常——这样即便别的 agent 没写完，引擎照样能跑满 999 关。
//   3) 严守契约枚举：scene / mood / interaction.type 非法一律回退到安全默认。

import { RNG, hashSeed } from './rng.js';
import { CHAPTERS, chapterOf } from './chapters.js';
import { getNarrative } from './story.js';

export const TOTAL_LEVELS = 999;

// ---------------------------------------------------------------------------
// 契约枚举（白名单）：任何输出前都要据此校验，非法即回退。
// ---------------------------------------------------------------------------
export const SCENES = [
  'corridor', 'room', 'forest', 'abyss', 'mirror', 'flesh', 'static',
  'cellar', 'hospital', 'void', 'ocean', 'attic', 'church', 'subway', 'garden',
];
export const MOODS = [
  'dread', 'sorrow', 'panic', 'numb', 'hunt', 'calm-before', 'revelation',
];
export const INTERACTIONS = [
  'reveal', 'choice', 'find', 'sequence', 'hold', 'decrypt',
  'trace', 'avoid', 'wait', 'none',
];

const _SCENE_SET = new Set(SCENES);
const _MOOD_SET = new Set(MOODS);
const _INTER_SET = new Set(INTERACTIONS);

// 安全默认：枚举非法时回退到这些值（永远合法）。
const SAFE_SCENE = 'void';
const SAFE_MOOD = 'dread';
const SAFE_INTER = 'none';

// 章节场景与「邻近场景」映射：少数关卡切到相关场景，避免整章 37 关雷同，
// 但仍保持叙事协调（如 corridor 关章里偶尔露出 room / stairs→cellar 等）。
// 仅使用合法 scene 枚举；非法基底场景也会在这里被纠正。
const SCENE_NEIGHBORS = {
  corridor: ['room', 'cellar', 'attic'],
  room: ['corridor', 'attic', 'mirror'],
  forest: ['garden', 'abyss', 'ocean'],
  abyss: ['void', 'ocean', 'forest'],
  mirror: ['room', 'flesh', 'void'],
  flesh: ['mirror', 'hospital', 'cellar'],
  static: ['void', 'mirror', 'subway'],
  cellar: ['corridor', 'flesh', 'attic'],
  hospital: ['corridor', 'flesh', 'static'],
  void: ['abyss', 'static', 'mirror'],
  ocean: ['abyss', 'forest', 'cellar'],
  attic: ['room', 'corridor', 'cellar'],
  church: ['room', 'corridor', 'void'],
  subway: ['corridor', 'static', 'void'],
  garden: ['forest', 'ocean', 'room'],
};

// 与情绪相邻的情绪（少数关卡情绪微变，仍协调）。
const MOOD_NEIGHBORS = {
  'dread': ['numb', 'sorrow', 'panic'],
  'sorrow': ['dread', 'numb', 'calm-before'],
  'panic': ['hunt', 'dread'],
  'numb': ['dread', 'sorrow', 'calm-before'],
  'hunt': ['panic', 'dread'],
  'calm-before': ['dread', 'revelation', 'numb'],
  'revelation': ['calm-before', 'sorrow'],
};

// 特殊意象池：偶尔混入章节固有 motifs 之外的元素，制造「不该出现」的不安。
const SPECIAL_MOTIFS = [
  'eye', 'hand', 'figure', 'door', 'clock', 'stairs',
  'water', 'candle', 'mouth', 'teeth', 'mirror', 'hair', 'crack', 'name',
];

// 里程碑关卡：固定指定互动类型 / 强化恐惧，制造「整数关」的仪式感。
// 这些数字与叙事中的关键节点（333/666/999 等）呼应。
const MILESTONES = {
  1: { interaction: 'reveal' },     // 序章：第一次点开黑暗
  37: { interaction: 'choice' },    // 章末抉择
  148: { interaction: 'sequence' },
  185: { interaction: 'wait' },
  259: { interaction: 'choice' },   // 幕一终
  333: { interaction: 'avoid', fearBoost: 0.12 },  // 林子同时转头
  444: { interaction: 'hold' },
  518: { interaction: 'decrypt' },  // 写下名字
  555: { interaction: 'choice' },
  629: { interaction: 'hold' },
  666: { interaction: 'avoid', fearBoost: 0.14 },  // 对上焦的「你」
  703: { interaction: 'decrypt' },
  740: { interaction: 'wait' },
  777: { interaction: 'find' },
  814: { interaction: 'reveal' },   // 推开那扇门（幕三终）
  851: { interaction: 'choice' },
  888: { interaction: 'trace' },
  925: { interaction: 'wait', fearBoost: 0.08 },
  962: { interaction: 'hold' },
  999: { interaction: 'choice', fearBoost: 0.0 },  // 终局抉择
};

// ---------------------------------------------------------------------------
// 内置降级章节：chapters.js 不可用 / 抛错时使用。
// 仍按四幕粗分 27 章，scene/mood/palette 全部合法，保证引擎可运行。
// ---------------------------------------------------------------------------
const FALLBACK_PALETTE = {
  bg: '#06070a', fog: '#101318', ink: '#c2c6cc',
  blood: '#4a1316', glow: '#222a32', accent: '#52606e',
};

function fallbackChapterOf(id) {
  const n = clampId(id);
  const idx = Math.min(26, Math.floor((n - 1) / 37)); // 0..26
  const chN = idx + 1;
  // 按幕给一个合理的场景/情绪/主色，越深越异常。
  let scene, mood, accent;
  if (chN <= 7) { scene = 'corridor'; mood = 'dread'; accent = '#52606e'; }
  else if (chN <= 14) { scene = 'ocean'; mood = 'sorrow'; accent = '#3c6a86'; }
  else if (chN <= 22) { scene = 'mirror'; mood = 'numb'; accent = '#48486e'; }
  else { scene = 'void'; mood = 'revelation'; accent = '#b0466a'; }
  return {
    n: chN,
    title: '第 ' + chN + ' 章',
    range: [idx * 37 + 1, Math.min(999, (idx + 1) * 37)],
    theme: '下沉',
    scene,
    mood,
    palette: Object.assign({}, FALLBACK_PALETTE, { accent }),
    motifs: ['door', 'figure', 'stairs'],
    summary: '这一层尚未成形，但你仍在下沉。',
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function clampId(id) {
  let n = Math.floor(Number(id));
  if (!Number.isFinite(n)) n = 1;
  return Math.max(1, Math.min(TOTAL_LEVELS, n));
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// 校验单个 hex 颜色，非法回退到 fallback。
function safeHex(c, fallback) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (typeof c === 'string' && /^#[0-9a-fA-F]{3}$/.test(c)) {
    // #abc -> #aabbcc
    return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
  }
  return fallback;
}

// hex <-> rgb
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
function rgbToHex(r, g, b) {
  const to = (v) => {
    const n = Math.max(0, Math.min(255, Math.round(v)));
    return n.toString(16).padStart(2, '0');
  };
  return '#' + to(r) + to(g) + to(b);
}

// RGB <-> HSL（用于明度/色相轻微扰动，保持配色协调）
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

// 在 HSL 空间对单色做轻微扰动：色相 ±dh、饱和 ±ds、明度 ±dl。
function jitterColor(hex, rng, dh, ds, dl) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  let h = (hsl.h + rng.float(-dh, dh)) % 1;
  if (h < 0) h += 1;
  const s = clamp01(hsl.s + rng.float(-ds, ds));
  const l = clamp01(hsl.l + rng.float(-dl, dl));
  const out = hslToRgb(h, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

// 平滑曲线工具
function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------------------
// 恐惧曲线 fearOf(id)：从 ~0.05 平滑非线性上升到接近 1（越深越快）。
// 里程碑关临时拉高（叠加 fearBoost，最终 clamp 到 1）。
// 纯函数，确定性，供内部与外部（engine 可选）使用。
// ---------------------------------------------------------------------------
export function fearOf(id) {
  const n = clampId(id);
  const t = (n - 1) / (TOTAL_LEVELS - 1); // 0..1
  // 基线：0.05 起步；用 pow 让深处加速（指数 1.85 偏后段陡峭）。
  let f = 0.05 + 0.9 * Math.pow(t, 1.85);
  // 章内微起伏：每章开头略降（喘息），章末略升（推进感）。用 37 关周期。
  const within = ((n - 1) % 37) / 36; // 0..1 章内进度
  f += (within - 0.5) * 0.05;
  // 里程碑临时拉高
  const ms = MILESTONES[n];
  if (ms && typeof ms.fearBoost === 'number') f += ms.fearBoost;
  // 终局（最后一章）整体再抬一档
  if (n >= 963) f += 0.04;
  return clamp01(f);
}

// ---------------------------------------------------------------------------
// 互动类型选择算法：
//   目标——分布合理、节奏有变化、难度随深度递增、不连续重复、none 作喘息。
//   策略：
//     1) 里程碑关强制指定类型（仪式感、与叙事呼应）。
//     2) 否则按「深度加权池」用 RNG 抽取：浅层偏轻互动(reveal/choice/wait/none)，
//        深层难度型(sequence/decrypt/avoid/hold/trace)权重上升。
//     3) 避免与前一关相同：若撞上，则在池内换一个（用 id 派生的二次 RNG）。
//     4) none 作为喘息穿插：每隔若干关、且非里程碑时小概率出现。
// 全部确定性：仅依赖 id 与从 seed 派生的 RNG。
// ---------------------------------------------------------------------------
function pickInteractionType(id, seed) {
  const ms = MILESTONES[id];
  if (ms && ms.interaction && _INTER_SET.has(ms.interaction)) return ms.interaction;

  const t = (id - 1) / (TOTAL_LEVELS - 1); // 深度 0..1
  const deep = smoothstep(t);              // 平滑深度因子

  // 深度加权池：权重随 deep 调整。
  // 轻互动随深度略降但不消失；难度型随深度上升。
  const pool = [
    { v: 'reveal', w: 1.6 - 0.7 * deep },
    { v: 'choice', w: 1.3 - 0.3 * deep },
    { v: 'find', w: 1.0 + 0.3 * deep },
    { v: 'wait', w: 0.9 - 0.2 * deep },
    { v: 'trace', w: 0.6 + 0.6 * deep },
    { v: 'hold', w: 0.5 + 0.9 * deep },
    { v: 'sequence', w: 0.4 + 1.2 * deep },
    { v: 'decrypt', w: 0.3 + 1.1 * deep },
    { v: 'avoid', w: 0.25 + 1.3 * deep },
    { v: 'none', w: 0.35 },               // 喘息，保持低而恒定
  ];

  // 「喘息」节奏：大约每 6~8 关安排一次纯叙事，缓冲难度。
  // 用 id 的确定性判断，错峰避免与里程碑冲突。
  const restCycle = ((id * 7 + 3) % 13); // 0..12 的确定性相位
  const wantRest = restCycle === 0 && !ms;

  const rng = new RNG(seed ^ 0x9e3779b9);
  let type = wantRest ? 'none' : rng.weighted(pool);

  // 防连续重复：与「上一关」类型比对（递归仅 1 层，确定性，不会无限）。
  const prevType = id > 1 ? _quickPrevType(id - 1) : null;
  if (type === prevType && type !== 'none') {
    // 在池里换一个不同的（用二次 RNG，确定性）。
    const alt = new RNG(seed ^ 0x85ebca6b);
    let guard = 0;
    do { type = alt.weighted(pool); guard++; } while (type === prevType && guard < 8);
  }

  return _INTER_SET.has(type) ? type : SAFE_INTER;
}

// 轻量预测「某关类型」（不递归 pickInteractionType 以避免链式回溯）。
// 仅用于「防连续重复」的前一关比对：复刻里程碑 + 加权逻辑，但不再做去重。
function _quickPrevType(id) {
  const ms = MILESTONES[id];
  if (ms && ms.interaction && _INTER_SET.has(ms.interaction)) return ms.interaction;
  const restCycle = ((id * 7 + 3) % 13);
  if (restCycle === 0) return 'none';
  const t = (id - 1) / (TOTAL_LEVELS - 1);
  const deep = smoothstep(t);
  const pool = [
    { v: 'reveal', w: 1.6 - 0.7 * deep },
    { v: 'choice', w: 1.3 - 0.3 * deep },
    { v: 'find', w: 1.0 + 0.3 * deep },
    { v: 'wait', w: 0.9 - 0.2 * deep },
    { v: 'trace', w: 0.6 + 0.6 * deep },
    { v: 'hold', w: 0.5 + 0.9 * deep },
    { v: 'sequence', w: 0.4 + 1.2 * deep },
    { v: 'decrypt', w: 0.3 + 1.1 * deep },
    { v: 'avoid', w: 0.25 + 1.3 * deep },
    { v: 'none', w: 0.35 },
  ];
  const seed = hashSeed('level-' + id);
  const rng = new RNG(seed ^ 0x9e3779b9);
  const type = rng.weighted(pool);
  return _INTER_SET.has(type) ? type : SAFE_INTER;
}

// ---------------------------------------------------------------------------
// 互动提示语 & 参数配置：与 interactions.js 各 type 的实现含义对齐。
// 参数随难度（depth/fear）递增。全部确定性（来自 rng）。
// ---------------------------------------------------------------------------
const INTERACTION_PROMPTS = {
  reveal: ['点击黑暗处', '把光探进去', '触碰那片更黑的地方', '看清它'],
  choice: ['你要怎么做', '选择一条路', '门，还是楼梯', '回头，或继续下沉'],
  find: ['找出不对劲的东西', '有什么藏在画面里', '它在看你——找到它', '数清这里多出来的'],
  sequence: ['记住它亮起的顺序', '按相同的次序重复', '跟上这串心跳', '复述这段记忆'],
  hold: ['按住，别松手', '撑住，直到它过去', '咬紧，抵住那股拉力', '不要放开'],
  decrypt: ['还原这行字', '读出墙上的真话', '把名字拼回去', '解开这句低语'],
  trace: ['沿着裂缝描下去', '不要离开这条线', '把它的轮廓画完', '跟着血迹走'],
  avoid: ['别让它碰到你', '躲开那些目光', '不要被发现', '在它够到你之前移开'],
  wait: ['凝视，不要移开', '等它先动', '屏住呼吸，数到它走', '停在原地，看着'],
  none: ['继续下沉', '往下走', '让它带你下去', '再深一层'],
};

function buildInteractionConfig(type, id, fear, rng) {
  const t = (id - 1) / (TOTAL_LEVELS - 1);
  const deep = smoothstep(t); // 0..1

  switch (type) {
    case 'reveal': {
      // 需要点亮的隐藏点数量随深度增多；超时随深度收紧。
      const spots = clamp(1 + Math.floor(deep * 4) + rng.int(0, 1), 1, 6);
      return {
        spots,
        radius: clamp(90 - deep * 40, 40, 90),     // 光圈半径随深度变小
        timeLimit: Math.round(clamp(12 - deep * 5, 5, 12) * 1000),
      };
    }
    case 'choice': {
      const options = clamp(2 + Math.floor(deep * 2) + (rng.bool(0.3) ? 1 : 0), 2, 4);
      return {
        options,
        // 是否有「错误」分支（深处更可能有不可逆抉择）
        irreversible: rng.bool(0.2 + deep * 0.4),
        timeLimit: rng.bool(0.3 + deep * 0.4) ? Math.round(clamp(8 - deep * 4, 3, 8) * 1000) : 0,
      };
    }
    case 'find': {
      const count = clamp(1 + Math.floor(deep * 3) + rng.int(0, 1), 1, 5);
      return {
        count,
        decoys: clamp(2 + Math.floor(deep * 6), 2, 10),
        timeLimit: Math.round(clamp(20 - deep * 8, 8, 20) * 1000),
      };
    }
    case 'sequence': {
      // length 随 id 增长（核心难度旋钮）
      const length = clamp(3 + Math.floor(deep * 6) + rng.int(0, 1), 3, 9);
      return {
        length,
        speed: clamp(1 - deep * 0.45, 0.45, 1),    // 播放速度（越深越快）
        tolerance: clamp(2 - Math.floor(deep * 2), 0, 2), // 容错次数
      };
    }
    case 'hold': {
      // 长按秒数随深度递增
      const seconds = +(clamp(2 + deep * 6, 2, 8) + rng.float(-0.4, 0.4)).toFixed(1);
      return {
        seconds: Math.max(1.5, seconds),
        // 中途是否有「抖动/松动」干扰（深处更多）
        wobble: clamp01(0.2 + deep * 0.6),
        slipChance: clamp01(deep * 0.3),
      };
    }
    case 'decrypt': {
      // 解密难度：被替换的字符数 / 候选干扰
      const len = clamp(4 + Math.floor(deep * 8), 4, 14);
      return {
        length: len,
        difficulty: clamp(1 + Math.floor(deep * 3), 1, 4), // 1..4
        scramble: clamp01(0.3 + deep * 0.6),
        timeLimit: Math.round(clamp(30 - deep * 12, 12, 30) * 1000),
      };
    }
    case 'trace': {
      // 描线：路径节点数 / 允许偏离
      const nodes = clamp(4 + Math.floor(deep * 8), 4, 14);
      return {
        nodes,
        tolerance: clamp(28 - deep * 18, 8, 28),   // 允许偏离像素，越深越严
        speed: clamp(1 - deep * 0.4, 0.5, 1),
      };
    }
    case 'avoid': {
      // 避让：持续时长 / 威胁数量 / 速度
      const duration = Math.round(clamp(6 + deep * 14, 6, 22) * 1000);
      return {
        duration,
        threats: clamp(1 + Math.floor(deep * 5), 1, 7),
        speed: clamp(0.6 + deep * 1.4, 0.6, 2.2),
      };
    }
    case 'wait': {
      // 凝视/等待秒数随深度增加；可能要求「不许移动鼠标」
      const seconds = Math.round(clamp(4 + deep * 10, 4, 16));
      return {
        seconds,
        steady: rng.bool(0.3 + deep * 0.5),        // 是否要求保持静止
        blinkPenalty: rng.bool(0.2 + deep * 0.4),  // 是否「眨眼/移动」即失败
      };
    }
    case 'none':
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// 主入口：buildLevel(id) —— 返回完整 Level 对象，永不抛错。
// ---------------------------------------------------------------------------
export function buildLevel(id) {
  // 1) clamp
  const lid = clampId(id);

  // 2) seed & rng（所有随机来自此）
  const seed = hashSeed('level-' + lid);
  const rng = new RNG(seed);

  // 3) chapter（容错：chapters 不可用 -> 内置降级章节）
  let chapter = null;
  try {
    if (typeof chapterOf === 'function') chapter = chapterOf(lid);
  } catch (_) { chapter = null; }
  if (!chapter || typeof chapter !== 'object') chapter = fallbackChapterOf(lid);

  // 章节字段兜底（防 chapters.js 字段缺失）
  const chapterN = clamp(Number(chapter.n) || Math.min(27, Math.ceil(lid / 37)), 1, 27);
  const chapterTitle = (typeof chapter.title === 'string' && chapter.title) ? chapter.title : ('第 ' + chapterN + ' 章');
  const chMotifs = Array.isArray(chapter.motifs) && chapter.motifs.length ? chapter.motifs : ['door', 'figure', 'stairs'];

  // 章节基底 palette（逐色校验）
  const cp = (chapter.palette && typeof chapter.palette === 'object') ? chapter.palette : {};
  const basePalette = {
    bg: safeHex(cp.bg, FALLBACK_PALETTE.bg),
    fog: safeHex(cp.fog, FALLBACK_PALETTE.fog),
    ink: safeHex(cp.ink, FALLBACK_PALETTE.ink),
    blood: safeHex(cp.blood, FALLBACK_PALETTE.blood),
    glow: safeHex(cp.glow, FALLBACK_PALETTE.glow),
    accent: safeHex(cp.accent, FALLBACK_PALETTE.accent),
  };

  // 章节基底 scene（校验枚举；chapters.js 里 ch2 用了非法 'stairs' -> 这里纠正）
  let baseScene = _SCENE_SET.has(chapter.scene) ? chapter.scene : SAFE_SCENE;
  if (!_SCENE_SET.has(chapter.scene)) {
    // 把常见非法值映射到合理合法场景（如 stairs -> cellar）
    const map = { stairs: 'cellar', basement: 'cellar', sky: 'void', sea: 'ocean' };
    baseScene = map[chapter.scene] || SAFE_SCENE;
  }

  // 章节基底 mood（校验枚举）
  const baseMood = _MOOD_SET.has(chapter.mood) ? chapter.mood : SAFE_MOOD;

  // 4) 叙事（容错：失败 -> 降级占位文本，保证永不抛错）
  let narr = null;
  try {
    if (typeof getNarrative === 'function') {
      // 契约：getNarrative(id, chapter, rng)，传入独立 RNG（同 seed，不污染主 rng 序列）
      narr = getNarrative(lid, chapter, new RNG(seed));
    }
  } catch (_) { narr = null; }
  narr = normalizeNarrative(narr, lid, chapterTitle, rng);

  // 综合恐惧值
  const fear = fearOf(lid);

  // 5) 组装 art
  const art = buildArt(lid, seed, rng, baseScene, basePalette, chMotifs, fear);

  // 6) 组装 audio
  const audio = buildAudio(lid, seed, baseMood, fear, rng);

  // 7) 组装 interaction
  const interaction = buildInteraction(lid, seed, fear);

  // 9) 完整 Level 对象
  return {
    id: lid,
    chapter: chapterN,
    chapterTitle,
    title: narr.title,
    seed,
    narrative: narr.narrative,
    whisper: narr.whisper,
    art,
    audio,
    interaction,
    fear,
  };
}

// ---------------------------------------------------------------------------
// 叙事归一化：保证 { title, narrative:[非空字符串...], whisper:string }。
// ---------------------------------------------------------------------------
function normalizeNarrative(narr, id, chapterTitle, rng) {
  const fallbackTitles = [
    '第 ' + id + ' 关 · 更下面',
    '第 ' + id + ' 关 · 还在下沉',
    '第 ' + id + ' 关 · ' + chapterTitle,
    '第 ' + id + ' 关 · 信号未明',
  ];
  const fallbackBodies = [
    ['又一层。', '空气更冷了一点，黑也更厚了一点。', '你不记得自己是什么时候开始往下走的。'],
    ['这一层和上一层几乎一样——这才是最让人害怕的地方。', '你伸手摸墙，墙是温的。'],
    ['脚下传来回声，像是有人替你走过同样的路。', '可这里只有你。', '应该只有你。'],
    ['楼层的数字又少了一个。', '那个声音说：快到了。', '你不记得「到」是要去哪里。'],
  ];
  const fallbackWhispers = ['', '别回头。', '你听见了吗。', '再下面一点。', '它记得你。', ''];

  let title, body, whisper;
  if (narr && typeof narr === 'object') {
    title = (typeof narr.title === 'string' && narr.title.trim()) ? narr.title : null;
    if (Array.isArray(narr.narrative)) {
      body = narr.narrative.filter((s) => typeof s === 'string' && s.trim().length).map((s) => s);
    } else if (typeof narr.narrative === 'string' && narr.narrative.trim()) {
      body = [narr.narrative];
    } else {
      body = null;
    }
    whisper = (typeof narr.whisper === 'string') ? narr.whisper : null;
  }

  if (!title) title = rng.pick(fallbackTitles);
  if (!body || !body.length) body = rng.pick(fallbackBodies).slice();
  if (whisper == null) whisper = rng.pick(fallbackWhispers);

  return { title, narrative: body, whisper };
}

// ---------------------------------------------------------------------------
// art 组装
// ---------------------------------------------------------------------------
function buildArt(id, seed, rng, baseScene, basePalette, chMotifs, fear) {
  const t = (id - 1) / (TOTAL_LEVELS - 1);
  const deep = smoothstep(t);

  // —— scene：以章节基底为主，少数关卡（约 18%）切到「相邻场景」破除整章雷同 ——
  let scene = baseScene;
  if (rng.bool(0.18)) {
    const neighbors = SCENE_NEIGHBORS[baseScene] || [];
    const cand = neighbors.filter((s) => _SCENE_SET.has(s));
    if (cand.length) scene = rng.pick(cand);
  }
  if (!_SCENE_SET.has(scene)) scene = SAFE_SCENE;

  // —— palette：在基底上做细微扰动（色相/饱和/明度轻微偏移），保持协调 ——
  // 越深扰动幅度略大，制造「世界在变质」的不安；但 bg 始终压得很暗。
  const dh = 0.015 + deep * 0.02;   // 色相偏移
  const ds = 0.04 + deep * 0.06;    // 饱和偏移
  const dl = 0.03 + deep * 0.05;    // 明度偏移
  const palette = {
    bg: jitterColor(basePalette.bg, rng, dh * 0.5, ds * 0.5, dl * 0.4),
    fog: jitterColor(basePalette.fog, rng, dh, ds, dl),
    ink: jitterColor(basePalette.ink, rng, dh * 0.4, ds * 0.4, dl * 0.5),
    blood: jitterColor(basePalette.blood, rng, dh, ds, dl * 0.8),
    glow: jitterColor(basePalette.glow, rng, dh, ds, dl),
    accent: jitterColor(basePalette.accent, rng, dh, ds, dl),
  };
  // 再次逐色校验（jitter 输出理论上恒为合法 hex，这里兜底）
  palette.bg = safeHex(palette.bg, basePalette.bg);
  palette.fog = safeHex(palette.fog, basePalette.fog);
  palette.ink = safeHex(palette.ink, basePalette.ink);
  palette.blood = safeHex(palette.blood, basePalette.blood);
  palette.glow = safeHex(palette.glow, basePalette.glow);
  palette.accent = safeHex(palette.accent, basePalette.accent);

  // —— motifs：从章节固有 motifs 取子集 + 偶尔混入特殊意象 ——
  const pool = chMotifs.filter((m) => typeof m === 'string' && m);
  const shuffled = rng.shuffle(pool);
  const take = clamp(1 + Math.floor(deep * 2) + rng.int(0, 1), 1, Math.max(1, pool.length));
  const motifs = shuffled.slice(0, take);
  // 偶尔（约 22%，越深越可能）混入一个「不该出现」的特殊意象
  if (rng.bool(0.15 + deep * 0.2)) {
    const special = rng.pick(SPECIAL_MOTIFS);
    if (!motifs.includes(special)) motifs.push(special);
  }

  // —— intensity & fog：随 id 上升（结合恐惧），各带轻微随机 ——
  const intensity = clamp01(0.2 + 0.7 * deep + (fear - deep) * 0.3 + rng.float(-0.05, 0.05));
  const fog = clamp01(0.25 + 0.55 * deep + rng.float(-0.08, 0.08));

  return { scene, palette, motifs, intensity, fog, seed };
}

// ---------------------------------------------------------------------------
// audio 组装
// ---------------------------------------------------------------------------
function buildAudio(id, seed, baseMood, fear, rng) {
  const t = (id - 1) / (TOTAL_LEVELS - 1);
  const deep = smoothstep(t);

  // —— droneRoot：随下降逐渐降低/变化的低频根音 Hz ——
  // 从约 58Hz 缓降到约 30Hz（越深越低、越压抑），叠加每关细微抖动。
  const base = 58 - deep * 26;                 // 58 -> 32
  const drift = rng.float(-2.5, 2.5);          // 每关微变化（确定性）
  const droneRoot = +clamp(base + drift, 24, 64).toFixed(2);

  // —— mood：以章节 mood 为主，偶有变化（约 15%）切到相邻情绪，仍须合法枚举 ——
  let mood = _MOOD_SET.has(baseMood) ? baseMood : SAFE_MOOD;
  if (rng.bool(0.15)) {
    const neighbors = (MOOD_NEIGHBORS[mood] || []).filter((m) => _MOOD_SET.has(m));
    if (neighbors.length) mood = rng.pick(neighbors);
  }
  if (!_MOOD_SET.has(mood)) mood = SAFE_MOOD;

  // —— heartbeat & whispers：随 fear 上升 ——
  // 心跳在中后段才明显起来（panic/hunt 情绪额外加成）。
  const moodPulse = (mood === 'panic' || mood === 'hunt') ? 0.2 : 0;
  const heartbeat = clamp01(Math.pow(fear, 1.3) + moodPulse + rng.float(-0.05, 0.05));
  const moodWhisper = (mood === 'dread' || mood === 'revelation') ? 0.12 : 0;
  const whispers = clamp01(fear * 0.85 + moodWhisper + rng.float(-0.05, 0.05));

  return { droneRoot, mood, heartbeat, whispers, seed };
}

// ---------------------------------------------------------------------------
// interaction 组装
// ---------------------------------------------------------------------------
function buildInteraction(id, seed, fear) {
  let type = pickInteractionType(id, seed);
  if (!_INTER_SET.has(type)) type = SAFE_INTER;

  // 提示语 RNG（独立派生，确定性）
  const prng = new RNG(seed ^ 0x27d4eb2f);
  const prompts = INTERACTION_PROMPTS[type] || INTERACTION_PROMPTS.none;
  const prompt = prng.pick(prompts);

  // 参数 RNG（独立派生，确定性）
  const crng = new RNG(seed ^ 0x165667b1);
  const config = buildInteractionConfig(type, id, fear, crng);

  return { type, prompt, config, seed };
}

// ---------------------------------------------------------------------------
// 默认导出（便于按需引用）
// ---------------------------------------------------------------------------
export default { buildLevel, fearOf, TOTAL_LEVELS, SCENES, MOODS, INTERACTIONS };
