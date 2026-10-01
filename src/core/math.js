// Small dependency-free math helpers shared by physics and rendering code.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mod = (a, n) => ((a % n) + n) % n;

// Wrap an angle to (-π, π].
export function wrapPi(a) {
  a = mod(a + Math.PI, Math.PI * 2) - Math.PI;
  return a === -Math.PI ? Math.PI : a;
}

// Move `cur` toward `target` by at most `maxStep`.
export function approach(cur, target, maxStep) {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
}

// Seeded PRNG (mulberry32). Returns floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash of two ints and a seed → uint32 (for per-chunk seeding).
export function hash2(x, y, seed = 0) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (y | 0), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Bisection root finder on a monotone function over [lo, hi].
export function bisect(f, lo, hi, iters = 40) {
  let flo = f(lo);
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// 3-vector helpers on plain arrays (used by the ephemeris code).
export const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

export function rotX(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
export function rotZ(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
