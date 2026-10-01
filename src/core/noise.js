// Deterministic gradient (Perlin-style) noise + fractal Brownian motion.
// Self-contained, no dependencies, so terrain is reproducible from a seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Noise {
  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  _lerp(a, b, t) { return a + t * (b - a); }
  _grad(hash, x, y) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
  }

  // 2D Perlin noise in roughly [-1, 1]
  noise2(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = this._fade(x);
    const v = this._fade(y);
    const p = this.perm;
    const A = p[X] + Y, B = p[X + 1] + Y;
    return this._lerp(
      this._lerp(this._grad(p[A], x, y), this._grad(p[B], x - 1, y), u),
      this._lerp(this._grad(p[A + 1], x, y - 1), this._grad(p[B + 1], x - 1, y - 1), u),
      v
    ) * 0.7;
  }

  // Fractal Brownian motion: layered noise for natural-looking terrain
  fbm(x, y, octaves = 6, lacunarity = 2.0, gain = 0.5) {
    let amp = 0.5, freq = 1.0, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged noise — good for ridgelines / crater rims
  ridged(x, y, octaves = 4) {
    let amp = 0.5, freq = 1.0, sum = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise2(x * freq, y * freq));
      sum += amp * n * n;
      amp *= 0.5;
      freq *= 2.0;
    }
    return sum;
  }
}

// ---------- 3D gradient noise (rock shapes) ----------
const G3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
Noise.prototype.noise3 = function (x, y, z) {
  const p = this.perm;
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  x -= X; y -= Y; z -= Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const f = this._fade;
  const u = f(x), v = f(y), w = f(z);
  const g = (ix, iy, iz, dx, dy, dz) => {
    const gr = G3[p[(p[(p[(xi + ix) & 255] + yi + iy) & 255] + zi + iz) & 255] % 12];
    return gr[0] * dx + gr[1] * dy + gr[2] * dz;
  };
  const l = this._lerp;
  return l(
    l(l(g(0, 0, 0, x, y, z), g(1, 0, 0, x - 1, y, z), u), l(g(0, 1, 0, x, y - 1, z), g(1, 1, 0, x - 1, y - 1, z), u), v),
    l(l(g(0, 0, 1, x, y, z - 1), g(1, 0, 1, x - 1, y, z - 1), u), l(g(0, 1, 1, x, y - 1, z - 1), g(1, 1, 1, x - 1, y - 1, z - 1), u), v),
    w
  );
};

Noise.prototype.fbm3 = function (x, y, z, octaves = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * this.noise3(x * freq, y * freq, z * freq);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
};

// ---------- Periodic 2D noise (seamless tiling textures) ----------
// Lattice wraps every `period` cells so a [0, period) square tiles exactly.
Noise.prototype.noise2p = function (x, y, period) {
  const X = Math.floor(x), Y = Math.floor(y);
  x -= X; y -= Y;
  const m = (a) => ((a % period) + period) % period;
  const p = this.perm;
  const h = (ix, iy) => p[(p[m(X + ix) & 255] + m(Y + iy)) & 255];
  const u = this._fade(x), v = this._fade(y);
  return this._lerp(
    this._lerp(this._grad(h(0, 0), x, y), this._grad(h(1, 0), x - 1, y), u),
    this._lerp(this._grad(h(0, 1), x, y - 1), this._grad(h(1, 1), x - 1, y - 1), u),
    v
  ) * 0.7;
};

Noise.prototype.fbm2p = function (x, y, period, octaves = 5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * this.noise2p(x * freq, y * freq, period * freq);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
};
