// rng.js — 确定性种子随机数引擎（所有程序化生成的共享基础）
// 同一个种子永远产生同一序列，保证 999 关每次加载视觉/音频/互动一致。

// mulberry32：快速、质量足够的 32 位种子 PRNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 把任意字符串哈希成 32 位整数种子
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// RNG 工具类：封装常用的随机操作，便于程序化生成调用
export class RNG {
  constructor(seed) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : (seed >>> 0);
    this._next = mulberry32(this.seed);
  }
  // [0,1)
  next() { return this._next(); }
  // [min,max)
  float(min = 0, max = 1) { return min + this._next() * (max - min); }
  // [min,max] 整数
  int(min, max) { return Math.floor(this.float(min, max + 1)); }
  // 布尔，p 为 true 概率
  bool(p = 0.5) { return this._next() < p; }
  // 数组随机取一
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  // 加权取一：items=[{v,w}] 或并行数组
  weighted(items) {
    const total = items.reduce((s, it) => s + (it.w || it.weight || 1), 0);
    let r = this._next() * total;
    for (const it of items) { r -= (it.w || it.weight || 1); if (r <= 0) return it.v ?? it.value ?? it; }
    return items[items.length - 1].v ?? items[items.length - 1];
  }
  // 洗牌（返回新数组）
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // 高斯近似（中心极限），mean/sd
  gauss(mean = 0, sd = 1) {
    let s = 0; for (let i = 0; i < 6; i++) s += this._next();
    return mean + (s - 3) / 3 * sd;
  }
}

// 1D 值噪声（用于程序化纹理/雾/起伏），seeded
export function makeNoise1D(seed) {
  const rng = new RNG(seed);
  const perm = rng.shuffle([...Array(256).keys()]);
  const grad = perm.map(() => rng.float(-1, 1));
  return function (x) {
    const i = Math.floor(x) & 255;
    const f = x - Math.floor(x);
    const u = f * f * (3 - 2 * f);
    return grad[i] * (1 - u) + grad[(i + 1) & 255] * u;
  };
}

// 2D 值噪声（用于程序化场景纹理、雾团、墙面）
export function makeNoise2D(seed) {
  const rng = new RNG(seed);
  const size = 256;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const at = (x, y) => grid[((y & 255) * size) + (x & 255)];
  const lerp = (a, b, t) => a + (b - a) * t;
  return function (x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = lerp(at(x0, y0), at(x0 + 1, y0), u);
    const b = lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), u);
    return lerp(a, b, v);
  };
}

// 分形噪声（多个八度叠加）
export function fbm2D(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
