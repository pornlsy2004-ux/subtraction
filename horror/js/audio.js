// audio.js — Web Audio API 程序化氛围与音效（《九百九十九》）
// 全部声音实时合成，禁止任何音频文件。所有随机变化来自 js/rng.js（确定性）。
//
// 合成架构（信号链）：
//   [各声源] -> dryBus ─┬─────────────────────────► masterGain -> compressor -> destination
//                       └─ reverbSend -> convolver ─┘
//   masterGain 受 setMaster/setMuted 控制；compressor 防止叠加爆音；
//   convolver 的脉冲响应用指数衰减噪声程序生成。
//
// 声景由三个常驻图层 + 一次性 cue 组成：
//   1) drone   —— 失谐振荡器堆，LFO 调制滤波器（呼吸感），mood 决定音程与音色。
//   2) heartbeat—— 低频正弦双击包络（咚-咚），强度/速度随参数。
//   3) whispers —— bandpass 扫频噪声 + 随机气音包络，立体声左右游移。
// 切关时把旧图层整体淡出并在淡出后断开，杜绝内存泄漏与声音叠加。

import { RNG } from './rng.js';

// ── 模块级私有状态 ────────────────────────────────────────────────
let ctx = null;                 // AudioContext
let master = null;              // 主增益（音量/静音）
let compressor = null;          // 总线压缩器
let dryBus = null;              // 干声汇流
let wetBus = null;              // 湿声（送入混响）
let convolver = null;           // 程序化混响
let reverbSend = null;          // 混响发送量（随 mood 调整）

let ready = false;              // AudioContext 是否就绪
let muted = false;
let masterVol = 0.5;            // 默认音量适中

let noiseBuffer = null;         // 复用的粉/白噪声 buffer

// 当前常驻声景图层（切关时整体替换）
let scape = null;               // { id, nodes:[], gain, lfos:[], stop() }
let heartTimer = null;          // 心跳调度 timeout id
let whisperTimer = null;        // 低语调度 timeout id

// ── 内部工具 ─────────────────────────────────────────────────────

const now = () => (ctx ? ctx.currentTime : 0);

// 安全获取时间常数下的平滑设值
function ramp(param, value, t = 0.05, when = null) {
  if (!param) return;
  const at = when == null ? now() : when;
  // setTargetAtTime 用时间常数平滑趋近，杜绝咔哒声
  param.setTargetAtTime(value, at, t);
}

function rampLinear(param, value, dur = 0.5, when = null) {
  if (!param) return;
  const at = when == null ? now() : when;
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(value, at + dur);
}

// 生成（一次）白噪声 buffer，供噪声源复用
function ensureNoiseBuffer() {
  if (noiseBuffer || !ctx) return noiseBuffer;
  const len = Math.floor(ctx.sampleRate * 2.0); // 2 秒，循环用
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // 用确定性 RNG 填充，使噪声纹理在不同会话间一致
  const rng = new RNG(0x9e3779b9);
  // 轻度低通积分 -> 偏粉噪，气音更柔和
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = rng.float(-1, 1);
    last = last * 0.96 + w * 0.04;
    data[i] = (w * 0.4 + last * 6.0) * 0.5;
  }
  noiseBuffer = buf;
  return buf;
}

// 程序化混响脉冲响应：指数衰减噪声（立体声）
function buildImpulse(seconds = 3.2, decay = 3.0) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  const rng = new RNG(0x1b873593);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      d[i] = rng.float(-1, 1) * env;
    }
  }
  return impulse;
}

// 创建一个噪声源（BufferSource），循环播放
function noiseSource() {
  ensureNoiseBuffer();
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  return src;
}

// 把一组节点串联，返回首尾（便于断开）
function disconnectAll(nodes) {
  for (const n of nodes) {
    try { n.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (n.stop) n.stop(); } catch (e) { /* 已停止 */ }
  }
}

// ── mood -> 声学参数表 ────────────────────────────────────────────
// 每种情绪通过音程、滤波、混响量、调制速率、密度等塑造不同心理质感。
// intervals: 相对根音的半音偏移（用于叠加振荡器，制造和谐或紧张音程）
//   小二度(1)/三全音(6) 制造尖锐不安；纯五度(7)/八度(12) 稳定空旷。
function moodParams(mood) {
  switch (mood) {
    case 'dread': // 恐惧：低沉、三全音的隐约张力、慢呼吸、湿润
      return { intervals: [0, 12, 6], cutoff: 420, q: 6, lfoRate: 0.06,
               lfoDepth: 280, reverb: 0.55, gain: 0.5, detune: 7, brightness: 0.3 };
    case 'sorrow': // 悲伤：小三度/小六度，温和但下坠，长混响
      return { intervals: [0, 12, 3, 8], cutoff: 520, q: 3, lfoRate: 0.04,
               lfoDepth: 200, reverb: 0.7, gain: 0.45, detune: 5, brightness: 0.4 };
    case 'panic': // 恐慌：高密度拍频、三全音+小二度，快速调制，明亮刺耳
      return { intervals: [0, 1, 6, 13], cutoff: 1100, q: 9, lfoRate: 0.5,
               lfoDepth: 700, reverb: 0.3, gain: 0.5, detune: 16, brightness: 0.8 };
    case 'numb': // 麻木：单一持续、几乎无调制、闷
      return { intervals: [0, 12], cutoff: 300, q: 2, lfoRate: 0.02,
               lfoDepth: 80, reverb: 0.4, gain: 0.4, detune: 3, brightness: 0.15 };
    case 'hunt': // 追猎：脉动的五度、中速调制、紧绷
      return { intervals: [0, 7, 12, 19], cutoff: 700, q: 7, lfoRate: 0.22,
               lfoDepth: 420, reverb: 0.35, gain: 0.5, detune: 10, brightness: 0.55 };
    case 'calm-before': // 暴风雨前：空旷纯五度，极慢，深混响，欺骗性的安宁
      return { intervals: [0, 7, 12], cutoff: 600, q: 2, lfoRate: 0.025,
               lfoDepth: 150, reverb: 0.8, gain: 0.4, detune: 4, brightness: 0.45 };
    case 'revelation': // 揭示：大调泛音、上扬、明亮、宽广（崇高的恐怖）
      return { intervals: [0, 7, 12, 16, 19], cutoff: 1400, q: 3, lfoRate: 0.08,
               lfoDepth: 300, reverb: 0.75, gain: 0.42, detune: 6, brightness: 0.9 };
    default:
      return { intervals: [0, 12, 6], cutoff: 450, q: 5, lfoRate: 0.06,
               lfoDepth: 250, reverb: 0.5, gain: 0.45, detune: 7, brightness: 0.35 };
  }
}

// 半音 -> 频率比
const semi = (n) => Math.pow(2, n / 12);

// ── 常驻声景构建 ─────────────────────────────────────────────────

function buildDrone(audio, rng, p, parent) {
  const root = audio.droneRoot || 55;
  const nodes = [];
  const lfos = [];

  // drone 自身的滤波器 + 增益
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = p.cutoff;
  filter.Q.value = p.q;
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.0; // 由上层 scape.gain 控制总淡入
  filter.connect(droneGain);
  droneGain.connect(parent);
  nodes.push(filter, droneGain);

  // 为每个音程叠加一对微微失谐的振荡器，形成拍频
  p.intervals.forEach((iv, idx) => {
    const f = root * semi(iv);
    if (f > 8000) return; // 防止过高
    const oscGain = ctx.createGain();
    // 越高的音程音量越低，保持低频为主
    oscGain.gain.value = (idx === 0 ? 0.5 : 0.5 / (idx + 1)) * (0.5 + p.brightness * 0.5);
    oscGain.connect(filter);
    nodes.push(oscGain);

    for (let d = -1; d <= 1; d += 2) {
      const o = ctx.createOscillator();
      // 低音用三角/正弦更厚，高音用锯齿增加泛音明度
      o.type = idx === 0 ? 'sine' : (p.brightness > 0.6 ? 'sawtooth' : 'triangle');
      o.frequency.value = f;
      o.detune.value = d * (p.detune + rng.float(-3, 3)); // 失谐 -> 拍频
      o.connect(oscGain);
      o.start();
      nodes.push(o);
    }
  });

  // LFO 调制滤波器截止 —— 呼吸感
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = p.lfoRate + rng.float(-0.01, 0.02);
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = p.lfoDepth;
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);
  lfo.start();
  lfos.push(lfo);
  nodes.push(lfo, lfoGain);

  // 第二个慢 LFO 轻微调制整体音量，增加“活物”感
  const ampLfo = ctx.createOscillator();
  ampLfo.type = 'sine';
  ampLfo.frequency.value = 0.03 + rng.float(0, 0.04);
  const ampLfoGain = ctx.createGain();
  ampLfoGain.gain.value = 0.08;
  ampLfo.connect(ampLfoGain);
  ampLfoGain.connect(droneGain.gain);
  ampLfo.start();
  lfos.push(ampLfo);
  nodes.push(ampLfo, ampLfoGain);

  return { nodes, lfos, droneGain };
}

// 调度一次心跳双击（咚-咚）
function scheduleHeartbeat(intensity, parent, rng) {
  if (!ctx || intensity <= 0) return;
  const t0 = now();

  const beat = (offset, vol) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = ctx.createGain();
    const t = t0 + offset;
    // 频率随包络下滑，模拟肉感的“咚”
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(g);
    g.connect(parent);
    osc.start(t);
    osc.stop(t + 0.34);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
  };

  const amp = 0.35 + intensity * 0.5;
  beat(0, amp);           // 第一击（强）
  beat(0.28, amp * 0.7);  // 第二击（弱）

  // 速度随强度加快：强度高 -> 间隔短（更急促）
  const bpm = 42 + intensity * 46 + rng.float(-3, 3);
  const interval = (60 / bpm) * 1000;
  heartTimer = setTimeout(() => scheduleHeartbeat(intensity, parent, rng), interval);
}

// 调度一次低语气音（bandpass 扫频噪声 + 立体声游移）
function scheduleWhisper(intensity, parent, rng) {
  if (!ctx || intensity <= 0) return;

  const src = noiseSource();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  // 人声气音集中在 1k~3k
  const startF = rng.float(900, 1800);
  const endF = startF + rng.float(-500, 900);
  bp.frequency.setValueAtTime(startF, now());
  bp.Q.value = rng.float(4, 9);
  const g = ctx.createGain();
  // 立体声游移：随机起始声像，缓慢漂移
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  const t = now();
  const dur = rng.float(0.7, 1.6);
  const peak = 0.05 + intensity * 0.12;

  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + dur * 0.4);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  bp.frequency.linearRampToValueAtTime(endF, t + dur);

  src.connect(bp);
  bp.connect(g);
  if (pan) {
    const startPan = rng.float(-0.9, 0.9);
    pan.pan.setValueAtTime(startPan, t);
    pan.pan.linearRampToValueAtTime(-startPan * rng.float(0.3, 1), t + dur);
    g.connect(pan);
    pan.connect(parent);
  } else {
    g.connect(parent);
  }

  src.start(t);
  src.stop(t + dur + 0.05);
  src.onended = () => {
    try { src.disconnect(); bp.disconnect(); g.disconnect(); if (pan) pan.disconnect(); } catch (e) {}
  };

  // 下一次低语的间隔：强度越高越频繁
  const gap = rng.float(1.5, 5.0) * (1.4 - intensity) * 1000;
  whisperTimer = setTimeout(() => scheduleWhisper(intensity, parent, rng),
    Math.max(400, gap));
}

// 淡出并销毁当前声景
function teardownScape(fadeOut = 0.8) {
  if (heartTimer) { clearTimeout(heartTimer); heartTimer = null; }
  if (whisperTimer) { clearTimeout(whisperTimer); whisperTimer = null; }
  const old = scape;
  scape = null;
  if (!old) return;
  const g = old.gain;
  if (g && ctx) {
    rampLinear(g.gain, 0.0001, fadeOut);
  }
  // 淡出完成后断开所有节点，防止泄漏与叠加
  const delay = (fadeOut * 1000) + 120;
  setTimeout(() => {
    disconnectAll(old.lfos || []);
    disconnectAll(old.nodes || []);
    try { if (old.gain) old.gain.disconnect(); } catch (e) {}
  }, delay);
}

// ── 公共 API ─────────────────────────────────────────────────────

export const Audio = {
  // 用户首次交互后调用，解锁/恢复 AudioContext。幂等。
  init() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return; // 不支持，静默
        ctx = new AC();

        // 总线：master -> compressor -> destination
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 24;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.25;

        master = ctx.createGain();
        master.gain.value = muted ? 0 : masterVol;

        master.connect(compressor);
        compressor.connect(ctx.destination);

        // 干/湿汇流
        dryBus = ctx.createGain();
        dryBus.gain.value = 1.0;
        dryBus.connect(master);

        // 程序化混响
        convolver = ctx.createConvolver();
        convolver.buffer = buildImpulse(3.4, 3.0);
        wetBus = ctx.createGain();
        wetBus.gain.value = 1.0;
        reverbSend = ctx.createGain();
        reverbSend.gain.value = 0.5;
        // 干声也送一份进混响
        dryBus.connect(reverbSend);
        reverbSend.connect(convolver);
        convolver.connect(wetBus);
        wetBus.connect(master);

        ensureNoiseBuffer();
      }
      // 处理 autoplay 策略：suspended 时 resume
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => { ready = true; }).catch(() => {});
      }
      ready = ctx.state === 'running' || true; // resume 异步，标记为可调度
    } catch (e) {
      // 任何失败都静默，保持安全
      ready = false;
    }
  },

  // 切换到某关氛围。平滑交叉淡入淡出。
  playLevel(level) {
    if (!ctx || !level || !level.audio) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }

    const audio = level.audio;
    const rng = new RNG(audio.seed >>> 0);
    const p = moodParams(audio.mood);

    // 1) 淡出旧声景（交叉淡入淡出的“出”半段）
    teardownScape(1.0);

    // 2) 调整混响送量以匹配 mood
    if (reverbSend) ramp(reverbSend.gain, p.reverb, 0.8);

    // 3) 新声景：统一总增益用于淡入
    const sGain = ctx.createGain();
    sGain.gain.value = 0.0001;
    sGain.connect(dryBus);

    const drone = buildDrone(audio, rng, p, sGain);
    // 打开 drone 内部增益（其初值为 0）
    ramp(drone.droneGain.gain, p.gain, 0.6);

    const nodes = [sGain, ...drone.nodes];
    scape = { id: level.id, nodes, lfos: drone.lfos, gain: sGain };

    // 总增益淡入（交叉淡入淡出的“入”半段）
    rampLinear(sGain.gain, 1.0, 1.2);

    // 4) 心跳与低语：用各自的 RNG 派生序列保持确定性
    const hb = Math.max(0, Math.min(1, audio.heartbeat || 0));
    const wh = Math.max(0, Math.min(1, audio.whispers || 0));
    if (hb > 0) {
      const hbRng = new RNG((audio.seed ^ 0x55aa55aa) >>> 0);
      scheduleHeartbeat(hb, sGain, hbRng);
    }
    if (wh > 0) {
      const whRng = new RNG((audio.seed ^ 0x33cc33cc) >>> 0);
      scheduleWhisper(wh, sGain, whRng);
    }
  },

  // 淡出并停止所有声源。
  stop() {
    if (!ctx) return;
    teardownScape(0.6);
  },

  // 设置主音量 0..1（不影响 muted 状态语义）
  setMaster(vol) {
    masterVol = Math.max(0, Math.min(1, vol == null ? masterVol : vol));
    if (master && !muted) ramp(master.gain, masterVol, 0.05);
  },

  // 静音/取消静音
  setMuted(bool) {
    muted = !!bool;
    if (master) ramp(master.gain, muted ? 0 : masterVol, 0.04);
  },

  // 一次性音效
  cue(name) {
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    const t = now();
    const out = dryBus; // 经主线，也会带混响

    // 一次性临时图层，自动清理
    const tmp = ctx.createGain();
    tmp.gain.value = 1.0;
    tmp.connect(out);
    const cleanup = (after) => setTimeout(() => { try { tmp.disconnect(); } catch (e) {} }, after);

    switch (name) {
      case 'reveal': { // 上行微光铃音（FM 风格的清脆泛音）
        const base = 660;
        [0, 4, 7].forEach((iv, i) => {
          const o = ctx.createOscillator();
          o.type = 'sine';
          const f = base * semi(iv);
          o.frequency.setValueAtTime(f * 0.98, t + i * 0.05);
          o.frequency.linearRampToValueAtTime(f, t + i * 0.05 + 0.08);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t + i * 0.05);
          g.gain.exponentialRampToValueAtTime(0.18 / (i + 1), t + i * 0.05 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.05 + 0.9);
          o.connect(g); g.connect(tmp);
          o.start(t + i * 0.05); o.stop(t + i * 0.05 + 1.0);
        });
        cleanup(1400);
        break;
      }
      case 'solve': { // 解脱感的和谐大三和弦琶音，温暖
        const base = 392; // G
        [0, 4, 7, 12].forEach((iv, i) => {
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = base * semi(iv);
          const g = ctx.createGain();
          const st = t + i * 0.08;
          g.gain.setValueAtTime(0.0001, st);
          g.gain.exponentialRampToValueAtTime(0.16, st + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, st + 1.4);
          o.connect(g); g.connect(tmp);
          o.start(st); o.stop(st + 1.5);
        });
        cleanup(2000);
        break;
      }
      case 'fail': { // 下行失谐刺响：两个相邻不和谐音下滑
        [0, 1].forEach((k) => {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          const f0 = 320 + k * 23; // 小二度失谐
          o.frequency.setValueAtTime(f0, t);
          o.frequency.exponentialRampToValueAtTime(f0 * 0.4, t + 0.9);
          const g = ctx.createGain();
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 4;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
          o.connect(lp); lp.connect(g); g.connect(tmp);
          o.start(t); o.stop(t + 1.1);
        });
        cleanup(1500);
        break;
      }
      case 'descend': { // 下降扫频 + 轰鸣，进入下一关
        // 低频轰鸣
        const rum = ctx.createOscillator();
        rum.type = 'sine';
        rum.frequency.setValueAtTime(80, t);
        rum.frequency.exponentialRampToValueAtTime(28, t + 2.2);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(0.0001, t);
        rg.gain.exponentialRampToValueAtTime(0.28, t + 0.3);
        rg.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
        rum.connect(rg); rg.connect(tmp);
        rum.start(t); rum.stop(t + 2.5);
        // 噪声下行扫频（坠落的风声）
        const src = noiseSource();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(3000, t);
        lp.frequency.exponentialRampToValueAtTime(160, t + 2.2);
        lp.Q.value = 3;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(0.18, t + 0.4);
        ng.gain.linearRampToValueAtTime(0.0001, t + 2.3);
        src.connect(lp); lp.connect(ng); ng.connect(tmp);
        src.start(t); src.stop(t + 2.4);
        cleanup(2800);
        break;
      }
      case 'whisper': { // 贴耳气音（强制居中偏一侧的短促低语）
        const src = noiseSource();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1600, t);
        bp.frequency.linearRampToValueAtTime(2400, t + 0.5);
        bp.Q.value = 8;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.15);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.6);
        src.connect(bp); bp.connect(g);
        if (ctx.createStereoPanner) {
          const pan = ctx.createStereoPanner();
          pan.pan.value = 0.6;
          g.connect(pan); pan.connect(tmp);
        } else { g.connect(tmp); }
        src.start(t); src.stop(t + 0.7);
        cleanup(1000);
        break;
      }
      case 'sting': { // 突发高频刺音，吓人但克制（短促、快速衰减）
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(2400, t);
        o.frequency.exponentialRampToValueAtTime(1800, t + 0.12);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 1200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.005); // 极快起音
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35); // 克制衰减
        o.connect(hp); hp.connect(g); g.connect(tmp);
        o.start(t); o.stop(t + 0.4);
        // 叠一点噪声增加“刺”的质感
        const src = noiseSource();
        const bp = ctx.createBiquadFilter();
        bp.type = 'highpass'; bp.frequency.value = 3000;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.exponentialRampToValueAtTime(0.1, t + 0.004);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        src.connect(bp); bp.connect(ng); ng.connect(tmp);
        src.start(t); src.stop(t + 0.25);
        cleanup(600);
        break;
      }
      default:
        try { tmp.disconnect(); } catch (e) {}
    }
  },

  // AudioContext 是否就绪
  isReady() {
    return !!(ctx && (ctx.state === 'running' || ctx.state === 'suspended') && ready);
  }
};

export default Audio;
