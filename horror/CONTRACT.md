# 心理恐怖网站 —— 模块接口契约（所有 agent 必读）

项目代号：**《九百九十九》(NINE HUNDRED NINETY-NINE)**
一个纯静态、程序化生成的心理恐怖叙事网站。玩家在 999 关连续故事中不断下降，
每一关都有程序化生成的独特画面、氛围音、互动机制。

## 技术约束（强制）

- 纯静态：HTML + CSS + 原生 ES Modules（`<script type="module">`），**无构建步骤、无外部依赖、无 CDN**。
- 必须能直接用 `python3 -m http.server` 打开 `horror/index.html` 运行。
- 全部美术程序化生成（Canvas 2D / SVG / CSS），不使用任何图片文件。
- 全部音频程序化生成（Web Audio API），不使用任何音频文件。
- 所有随机性必须来自共享的 `js/rng.js`（种子化），保证确定性。
- 性能：单关渲染循环目标 60fps，移动端可降级。
- 兼容现代浏览器（Chrome/Firefox/Safari 最新版）。

## 文件归属（每个 agent 只动自己的文件，避免冲突）

| Agent | 文件 | 职责 |
|---|---|---|
| 1 引擎 | `js/engine.js`, `js/state.js` | 核心引擎、关卡加载、渲染循环、状态机、模块编排 |
| 2 美术 | `js/art.js` | 程序化场景渲染器（Canvas） |
| 3 音频 | `js/audio.js` | Web Audio 程序化氛围与音效 |
| 4 互动 | `js/interactions.js` | 互动机制库（8+ 种） |
| 5 叙事 | `js/story.js`, `js/chapters.js` | 999 关连续叙事 + 27 章定义 |
| 6 UI | `js/ui.js` | 标题/过场/HUD/设置/完成过渡 |
| 7 特效 | `js/effects.js` | 视觉后期特效（CRT/故障/暗角/抖动） |
| 8 存档 | `js/save.js` | localStorage 存档/进度/成就/设置 |
| 9 样式 | `css/main.css`, `css/themes.css`, `css/effects.css` | 全局样式、27 章配色主题、特效 CSS |
| 10 关卡 | `js/levels.js` | 把叙事+美术+音频+互动整合成关卡对象 |

`js/rng.js`（共享，已完成）、`index.html`、`js/main.js`（集成入口）由协调者维护。

## 共享数据结构：Level 对象（最核心契约）

`levels.js` 的 `buildLevel(id)` 返回此对象。`engine.js` 消费它并分发给各模块：

```js
{
  id: 1..999,                  // 关卡号
  chapter: 1..27,              // 所属章节
  chapterTitle: "下沉",        // 章节中文名
  title: "第 N 关 · 标题",      // 关卡标题
  seed: 1234567,               // 该关唯一种子（= hashSeed("level-"+id)）

  narrative: ["段落1", "段落2"], // 主叙事文本（逐段呈现）
  whisper: "墙缝里的低语",        // 隐藏/角落文字（可空）

  art: {                       // 交给 art.js
    scene: "corridor",         // 场景类型 key（见下方枚举）
    palette: { bg, fog, ink, blood, glow, accent }, // 6 个 hex 颜色
    motifs: ["door","eye"],    // 点缀元素 key 列表
    intensity: 0..1,           // 视觉强度
    fog: 0..1,                 // 雾浓度
    seed: 1234567
  },

  audio: {                     // 交给 audio.js
    droneRoot: 55,             // 低频根音 Hz
    mood: "dread",             // 情绪 key（见枚举）
    heartbeat: 0..1,           // 心跳强度
    whispers: 0..1,            // 低语强度
    seed: 1234567
  },

  interaction: {               // 交给 interactions.js
    type: "reveal",            // 互动类型 key（见枚举）
    prompt: "点击黑暗处",        // 玩家提示
    config: { /* 类型相关 */ },
    seed: 1234567
  },

  fear: 0..1                   // 综合恐惧值，驱动特效强度（随 id 上升）
}
```

### 枚举值（各 agent 必须支持这些 key）

- `art.scene`: `corridor` | `room` | `forest` | `abyss` | `mirror` | `flesh` | `static` | `cellar` | `hospital` | `void` | `ocean` | `attic` | `church` | `subway` | `garden`
- `audio.mood`: `dread` | `sorrow` | `panic` | `numb` | `hunt` | `calm-before` | `revelation`
- `interaction.type`: `reveal`（点击揭示）| `choice`（分支选择）| `find`（寻找隐藏物）| `sequence`（序列记忆）| `hold`（长按抵抗）| `decrypt`（解密文字）| `trace`（描线）| `avoid`（避让）| `wait`（等待/凝视）| `none`（纯叙事）

## 模块接口签名（ES Module 导出）

### `js/art.js`
```js
export function createScene(canvas, level);   // 返回 { render(t, fear), resize(), destroy() }
// render(t, fear): t=毫秒时间戳, fear=0..1; 每帧由 engine 调用
// 内部用 level.art + RNG(level.seed) 程序化绘制。必须实现全部 scene 枚举。
```

### `js/audio.js`
```js
export const Audio = {
  init(),                       // 用户首次交互后调用（解锁 AudioContext）
  playLevel(level),             // 切换到某关氛围
  stop(),
  setMaster(vol),               // 0..1
  setMuted(bool),
  cue(name),                    // 触发一次性音效：'reveal'|'solve'|'fail'|'descend'|'whisper'|'sting'
  isReady()
};
```

### `js/interactions.js`
```js
export function mountInteraction(container, level, callbacks);
// callbacks: { onSolve(result), onProgress(p), onFail(), cue(name) }
// 返回 { destroy() }。必须实现全部 interaction.type 枚举。
// 解决后调用 onSolve()，engine 据此进入下一关。
```

### `js/story.js`
```js
export function getNarrative(id, chapter, rng); // 返回 { title, narrative:[], whisper }
export function getChapterArc();                // 返回整体 27 章弧线说明（供 UI）
```

### `js/chapters.js`
```js
export const CHAPTERS = [ // 27 个
  { n:1, title:"下沉", range:[1,37], theme:"...", scene:"corridor",
    mood:"dread", palette:{...}, motifs:[...], summary:"..." }, ...
];
export function chapterOf(id); // id -> chapter 对象
```

### `js/levels.js`
```js
export function buildLevel(id);  // 返回上面的 Level 对象（核心整合器）
export const TOTAL_LEVELS = 999;
```

### `js/engine.js`
```js
export const Engine = {
  init(rootEl),       // 挂载到 DOM，建立 canvas + UI 层
  start(id),          // 从第 id 关开始（默认读存档）
  loadLevel(id),
  next(),             // 进入下一关（含过场）
  destroy()
};
export const State = { /* 见 state.js */ };
```

### `js/state.js`
```js
export const State = {
  current: 1, maxUnlocked: 1, fear: 0,
  settings: { volume, muted, effects, reduceMotion, lang },
  flags: {},          // 叙事分支标记
  get(), set(patch), subscribe(fn), reset()
};
```

### `js/effects.js`
```js
export const Effects = {
  mount(layerEl),                 // 挂载特效覆盖层
  apply(level),                   // 按关卡设定特效
  setFear(fear),                  // 0..1 实时调节
  glitch(ms), shake(ms), flash(color), vignettePulse(),
  destroy()
};
```

### `js/ui.js`
```js
export const UI = {
  mount(rootEl),
  showTitle(onStart),             // 标题画面
  showChapterCard(chapter, done), // 章节过场卡
  showHUD(level),                 // 关卡 HUD（关号/进度/章节）
  showNarrative(level, onDone),   // 叙事文本逐段呈现
  showComplete(level, onNext),    // 关卡完成过渡
  showSettings(), hideAll()
};
```

### `js/save.js`
```js
export const Save = {
  load(),                         // -> 存档对象
  save(state),
  get(key), set(key, val),
  unlock(id), maxUnlocked(),
  achievements(), grant(id),
  clear()
};
```

## DOM 层级约定（engine 建立，各模块挂载到对应层）

```
#game (root)
  canvas#scene-canvas      <- art.js 绘制
  #effects-layer           <- effects.js
  #interaction-layer       <- interactions.js
  #ui-layer                <- ui.js (HUD/叙事/菜单)
```

## 美学方向（统一风格）

- 心理恐怖，非血腥猎奇。重氛围、暗示、不安、孤独、下沉感。
- 配色以深黑、暗红、惨白、冷青为主；每章有独立主色调（themes.css）。
- 字体：衬线（叙事，营造旧书感）+ 等宽（系统/解密文字）。用 CSS 内联 @font-face 或系统字体栈，禁止外链。
- 文案中文为主，冷峻、诗性、克制。可夹杂少量扭曲的系统提示。
- 27 章是一条连续的"下降"叙事弧：从日常裂缝 → 深入潜意识 → 直面核心 → 第 999 关的终局。

## 中文优先
所有面向玩家的文字默认中文。代码注释中文。
