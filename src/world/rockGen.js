// Rock population model (pure).
//
// Golombek & Rapp (1997) / Golombek et al. (2003) exponential model of the
// cumulative fractional area covered by rocks of diameter ≥ D:
//      F_k(D) = k · exp(−q(k) · D),     q(k) = 1.79 + 0.152 / k
// where k is the total rock abundance (Jezero floor ≈ 3–6 %, fresh ejecta
// blankets ≈ 15–25 %). Differentiating and dividing by a rock's footprint
// (π D² / 4) gives the number density n(D) per m² per metre of diameter.
// Rocks are generated per terrain chunk from a seeded PRNG so they are
// identical every time a chunk is (re)loaded.
import { hash2, mulberry32 } from "../core/math.js";

export const golombekQ = (k) => 1.79 + 0.152 / k;
export const fractionalArea = (D, k) => k * Math.exp(-golombekQ(k) * D);
export function numberDensity(D, k) {
  const q = golombekQ(k);
  return (k * q * Math.exp(-q * D)) / ((Math.PI * D * D) / 4);
}

// Integral of n(D) over [a, b] (log-space trapezoid).
export function countBetween(a, b, k, steps = 48) {
  let sum = 0, prevD = a, prevN = numberDensity(a, k);
  for (let i = 1; i <= steps; i++) {
    const D = a * Math.pow(b / a, i / steps);
    const nD = numberDensity(D, k);
    sum += 0.5 * (nD + prevN) * (D - prevD);
    prevD = D; prevN = nD;
  }
  return sum;
}

export const STRIDE = 12; // x, cy, z, rx, ry, rz, yaw, tiltX, tiltZ, D, proto, tint
export const K_MAX = 0.22;

/**
 * @param o { ci, cj, x0, z0, size, seed, kAt(x,z), heightAt(x,z), Dmin, Dmax, protos }
 * @returns Float32Array of STRIDE-packed rock records
 */
export function generateChunkRocks(o) {
  const rnd = mulberry32(hash2(o.ci, o.cj, o.seed));
  const Dmin = o.Dmin ?? 0.1, Dmax = o.Dmax ?? 3.5;
  const bins = 22, area = o.size * o.size;
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = Dmin * Math.pow(Dmax / Dmin, b / bins);
    const hi = Dmin * Math.pow(Dmax / Dmin, (b + 1) / bins);
    const lambda = area * countBetween(lo, hi, K_MAX, 6);
    const count = Math.floor(lambda + rnd());
    for (let c = 0; c < count; c++) {
      const D = lo * Math.pow(hi / lo, rnd());
      const x = o.x0 + rnd() * o.size, z = o.z0 + rnd() * o.size;
      const k = o.kAt(x, z);
      const u = rnd();
      if (k <= 0 || u > numberDensity(D, k) / numberDensity(D, K_MAX)) continue;
      const hRatio = 0.32 + 0.38 * rnd();            // visible height / D (median ≈ 0.5)
      const embed = 0.2 + 0.25 * rnd();              // fraction buried
      const ry = (D * hRatio) / (2 * (1 - embed));
      const ground = o.heightAt(x, z);
      out.push(
        x, ground + ry * (1 - 2 * embed), z,
        (D / 2) * (0.85 + 0.3 * rnd()), ry, (D / 2) * (0.62 + 0.38 * rnd()),
        rnd() * Math.PI * 2, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3,
        D, Math.floor(rnd() * o.protos), rnd()
      );
    }
  }
  return new Float32Array(out);
}

// Visible height of a rock above the ground at its centre.
export function rockVisibleHeight(recs, i, ground) {
  return recs[i + 1] + recs[i + 4] - ground;
}
