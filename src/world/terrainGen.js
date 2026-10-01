// Near-field terrain synthesis (pure; runs inside the terrain Web Worker).
//
// The surface is the sum of physically motivated layers, all in metres:
//   1. macro  — real MOLA elevation, bicubic, relative to the landing site
//   2. meso   — fBm undulation of the crater floor (HiRISE-like RMS slopes)
//   3. craters— power-law size–frequency population, Pike (1977) simple-crater
//               morphometry, degradation state per crater (fresh → infilled)
//   4. bedforms — transverse aeolian ridges / megaripples in sand patches
//   5. bedrock — layered, terraced outcrops (Séítah / Máaz-like units)
// A material map records where each unit is so rendering, rock placement and
// terramechanics all agree on what the wheels are driving on.
import { Noise } from "../core/noise.js";
import { clamp, mulberry32, smoothstep } from "../core/math.js";

export const NEAR = {
  size: 1024,       // metres per side
  res: 0.5,         // metres per height post
  matRes: 1.0,      // metres per material texel
  edgeFade: 56,     // detail fades to the macro surface at the border
  seed: 2021,
};

// Cumulative crater density N(>D) = C · D^-2 per m² (D in metres).
const CRATER_C = 0.010;
const CRATER_DMIN = 2.0, CRATER_DMAX = 140;

export function generateCraters(size, seed) {
  const rnd = mulberry32(seed ^ 0xc4a7e5);
  const area = size * size;
  const a = Math.pow(CRATER_DMIN, -2), b = Math.pow(CRATER_DMAX, -2);
  const count = Math.round(CRATER_C * area * (a - b));
  const craters = [];
  for (let i = 0; i < count; i++) {
    const D = Math.pow(a - rnd() * (a - b), -0.5);
    const x = (rnd() - 0.5) * size, z = (rnd() - 0.5) * size;
    // degradation: most small craters are old and softened; a few are fresh
    const k = Math.pow(rnd(), 0.45);
    craters.push({
      x, z, R: D / 2, D,
      degr: k,
      depth: D * (0.2 * (1 - k) + 0.035 * k),
      rim: D * (0.04 * Math.pow(1 - k, 1.5) + 0.003),
      fresh: Math.pow(1 - k, 2.5),
    });
  }
  // the landing site itself sits on a smooth patch: no craters on the start pad
  return craters.filter((c) => Math.hypot(c.x, c.z) > c.R * 1.6 + 12);
}

// Radial crater profile: height offset at normalised radius ρ = r/R.
export function craterProfile(c, rho) {
  let fresh;
  if (rho < 1) {
    const p = 2 + 1.5 * c.degr;
    fresh = -c.depth + (c.depth + c.rim) * Math.pow(rho, p);
  } else {
    fresh = c.rim * Math.pow(rho, -3) * (1 - smoothstep(2.0, 3.0, rho));
  }
  const q = Math.min(rho / 1.12, 1);
  const cq = Math.cos((q * Math.PI) / 2);
  const degraded = -c.depth * cq * cq + c.rim * Math.exp(-Math.pow((rho - 1) / 0.28, 2));
  return fresh + (degraded - fresh) * c.degr;
}

class CraterIndex {
  constructor(craters, cell = 32) {
    this.cell = cell;
    this.map = new Map();
    for (const c of craters) {
      const r = c.R * 3;
      for (let i = Math.floor((c.x - r) / cell); i <= Math.floor((c.x + r) / cell); i++)
        for (let j = Math.floor((c.z - r) / cell); j <= Math.floor((c.z + r) / cell); j++) {
          const k = i * 73856093 ^ j * 19349663;
          let arr = this.map.get(k);
          if (!arr) this.map.set(k, (arr = []));
          arr.push(c);
        }
    }
  }
  near(x, z) {
    const k = Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663;
    return this.map.get(k) || EMPTY;
  }
}
const EMPTY = [];

/**
 * Build the near-field height + material grids.
 * @param macro  (x, z) => metres relative to the site (from the DEM)
 * @param onProgress  (0..1) => void
 */
export function generateNearField(macro, opts = {}, onProgress = () => {}) {
  const P = { ...NEAR, ...opts };
  const n = Math.round(P.size / P.res) + 1;
  const half = P.size / 2;
  const noise = new Noise(P.seed);
  const noiseB = new Noise(P.seed + 17);
  const craters = generateCraters(P.size, P.seed);
  const index = new CraterIndex(craters);

  // Macro relief on a coarse lattice (DEM posts are 463 m; 16 m is plenty).
  const mStep = 16, mN = Math.round(P.size / mStep) + 1;
  const macroGrid = new Float32Array(mN * mN);
  for (let j = 0; j < mN; j++)
    for (let i = 0; i < mN; i++) macroGrid[j * mN + i] = macro(-half + i * mStep, -half + j * mStep);
  const macroAt = (x, z) => {
    const fx = clamp((x + half) / mStep, 0, mN - 1.0001), fz = clamp((z + half) / mStep, 0, mN - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = macroGrid[j * mN + i], b = macroGrid[j * mN + i + 1];
    const c = macroGrid[(j + 1) * mN + i], d = macroGrid[(j + 1) * mN + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };

  // Dominant formative wind for the bedforms: crests trend ~N60°E.
  const crest = (60 * Math.PI) / 180;
  const cA = Math.cos(crest), sA = Math.sin(crest);

  // Evaluate all layers at a point; returns height + material fractions.
  const out = { h: 0, bedrock: 0, sand: 0, albedo: 0, ejecta: 0 };
  function sample(x, z) {
    const edge = smoothstep(0, P.edgeFade, Math.min(half - Math.abs(x), half - Math.abs(z)));
    let h = noise.fbm(x / 150, z / 150, 5) * 2.6 + noise.fbm(x / 38 + 50, z / 38, 4) * 0.55;

    // --- bedrock outcrops: terraced layers with blocky relief
    const bMask = smoothstep(0.16, 0.34, noise.fbm(x / 230 - 31, z / 230 + 17, 4) + 0.06 * noiseB.noise2(x / 9, z / 9));
    if (bMask > 0) {
      const lift = 0.9 + 0.8 * noiseB.fbm(x / 60, z / 60, 3);
      const step = 0.35;
      const hl = h + lift;
      const f = hl / step, fl = Math.floor(f);
      const terraced = step * (fl + smoothstep(0.72, 1.0, f - fl)) + 0.12 * noise.ridged(x / 6, z / 6, 3);
      h += (terraced - h) * bMask;
    }

    // --- sand: TAR / megaripple fields in low-lying patches
    let sand = smoothstep(0.08, 0.3, noise.fbm(x / 170 + 11, z / 170 - 7, 3) - 0.35 * bMask);
    if (sand > 0) {
      const warp = 0.6 * noiseB.fbm(x / 40, z / 40, 3);
      const u = (x * sA - z * cA) / 7.5 + warp;
      const ridge = Math.pow(1 - Math.abs(Math.sin(Math.PI * u)), 1.8);
      const amp = 0.45 * (0.6 + 0.4 * noise.noise2(x / 55, z / 55));
      h += sand * (ridge * amp - 0.12);
    }

    // --- craters
    let ejecta = 0;
    const list = index.near(x, z);
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      const dx = x - c.x, dz = z - c.z;
      const r2 = dx * dx + dz * dz, lim = 9 * c.R * c.R;
      if (r2 >= lim) continue;
      const rho = Math.sqrt(r2) / c.R;
      h += craterProfile(c, rho);
      if (rho > 0.85) ejecta = Math.max(ejecta, c.fresh * (1 - smoothstep(1.0, 2.6, rho)));
      if (rho < 0.75 && c.degr > 0.55) sand = Math.max(sand, smoothstep(0.75, 0.35, rho) * (c.degr - 0.55) * 2.2);
    }

    const albedo = 0.5 + 0.32 * noiseB.fbm(x / 70 + 3, z / 70 - 9, 4) + 0.1 * noise.noise2(x / 9, z / 9);
    out.h = macroAt(x, z) + h * edge;
    out.bedrock = bMask * edge;
    out.sand = clamp(sand, 0, 1) * edge;
    out.albedo = clamp(albedo, 0, 1);
    out.ejecta = clamp(ejecta, 0, 1) * edge;
    return out;
  }

  const heights = new Float32Array(n * n);
  const mN2 = Math.round(P.size / P.matRes);
  const mat = new Uint8Array(mN2 * mN2 * 4);
  const ratio = Math.round(P.matRes / P.res);
  for (let j = 0; j < n; j++) {
    const z = -half + j * P.res;
    for (let i = 0; i < n; i++) {
      const x = -half + i * P.res;
      const s = sample(x, z);
      heights[j * n + i] = s.h;
      if (i % ratio === 0 && j % ratio === 0 && i / ratio < mN2 && j / ratio < mN2) {
        const t = ((j / ratio) * mN2 + i / ratio) * 4;
        mat[t] = s.bedrock * 255;
        mat[t + 1] = s.sand * 255;
        mat[t + 2] = s.albedo * 255;
        mat[t + 3] = s.ejecta * 255;
      }
    }
    if ((j & 63) === 0) onProgress(j / n);
  }
  onProgress(1);
  return {
    n, res: P.res, size: P.size, heights,
    matN: mN2, matRes: P.matRes, mat,
    craters: craters.map((c) => ({ x: c.x, z: c.z, D: c.D, fresh: c.fresh, degr: c.degr })),
  };
}
