// Wheel–soil interaction (Bekker–Wong terramechanics), rigid wheel.
//
//   pressure–sinkage   p = (k_c / b + k_φ) zⁿ                    (Bekker)
//   static sinkage     z₀ = [3W / ((3−n)(k_c + b k_φ)√D)]^(2/(2n+1))
//   slip sinkage       z = z₀ (1 + c_s · s)                       (Lyasko, empirical)
//   compaction resist. R_c = (k_c + b k_φ) z^(n+1) / (n+1)
//   thrust             H = (A c + W tanφ)[1 − K/(s l)(1 − e^(−s l / K))]   (Janosi–Hanamoto)
//
// The vehicle-level solve finds the wheel slip at which total thrust balances
// compaction + rolling + grade resistance — the quantity Perseverance's visual
// odometry measures and AutoNav limits.
import { bisect, clamp } from "../core/math.js";

// Soil parameter sets. Regolith after Wong (Mars Pathfinder estimates, crusted);
// sand typical of aeolian bedforms; bedrock as a high-strength limit case.
// Tuned so slip vs. slope tracks MSL/M2020 experience: regolith ≈ 20 % at 20°,
// sand ≈ 40 % at 10° and immobile past ~15° (cf. Spirit at Troy).
export const SOILS = {
  regolith: { name: "风化层 Regolith", n: 1.0, kc: 1.4e3, kphi: 1.5e6, c: 400, phiDeg: 37, K: 0.008, slipSink: 0.3 },
  sand:     { name: "风成沙 Aeolian sand", n: 1.0, kc: 1.0e3, kphi: 1.0e6, c: 150, phiDeg: 32, K: 0.025, slipSink: 0.25 },
  bedrock:  { name: "基岩 Bedrock", n: 1.0, kc: 1e6, kphi: 1e9, c: 4000, phiDeg: 38, K: 0.004, slipSink: 0 },
};
const ROLLING = 0.02; // internal rolling resistance coefficient (drive train, grousers)

export function sinkage(W, soil, r, b, slip = 0) {
  if (W <= 0) return 0;
  const D = 2 * r, n = soil.n;
  const k = soil.kc + b * soil.kphi;
  const z0 = Math.pow((3 * W) / ((3 - n) * k * Math.sqrt(D)), 2 / (2 * n + 1));
  return Math.min(z0 * (1 + soil.slipSink * clamp(slip, 0, 1)), r * 0.8);
}

export function compactionResistance(z, soil, b) {
  return ((soil.kc + b * soil.kphi) * Math.pow(z, soil.n + 1)) / (soil.n + 1);
}

export function contactLength(z, r) {
  return r * Math.acos(clamp(1 - z / r, -1, 1)) + 0.02; // +2 cm grouser engagement
}

export function thrust(W, soil, z, slip, r, b) {
  if (W <= 0 || slip <= 0) return 0;
  const l = contactLength(z, r);
  const A = b * l;
  const hMax = A * soil.c + W * Math.tan((soil.phiDeg * Math.PI) / 180);
  const x = (slip * l) / soil.K;
  return hMax * (1 - (1 - Math.exp(-x)) / x);
}

/** Forces on one wheel at a given slip. */
export function wheelForces(W, soil, slip, r, b) {
  const z = sinkage(W, soil, r, b, slip);
  return {
    z,
    H: thrust(W, soil, z, slip, r, b),
    R: compactionResistance(z, soil, b) + ROLLING * W,
  };
}

/**
 * Solve steady-state slip for the vehicle.
 * @param wheels  [{W: normal load N, soil}]
 * @param gradeForce  m g sin(pitch) opposing motion (N; negative downhill)
 */
export function solveSlip(wheels, gradeForce, r, b) {
  const net = (s) => {
    let H = 0, R = 0;
    for (const w of wheels) {
      const f = wheelForces(w.W, w.soil, s, r, b);
      H += f.H; R += f.R;
    }
    return H - R - gradeForce;
  };
  let slip, immobile = false;
  const atZero = net(0);
  if (atZero >= 0) {
    // Gravity alone overcomes resistance: wheels brake, small negative slip (skid).
    slip = -clamp(atZero / (wheels.reduce((a, w) => a + w.W, 0) || 1), 0, 0.3);
  } else if (net(1) < 0) {
    slip = 1; immobile = true;
  } else {
    slip = bisect(net, 0, 1, 32);
  }
  const s = clamp(slip, 0, 1);
  let zSum = 0, Rsum = 0, Hsum = 0, Hmax = 0;
  for (const w of wheels) {
    const f = wheelForces(w.W, w.soil, s, r, b);
    zSum += f.z; Rsum += f.R; Hsum += f.H;
    Hmax += thrust(w.W, w.soil, f.z, 1, r, b);
  }
  const Wsum = wheels.reduce((a, w) => a + w.W, 0) || 1;
  return {
    slip,
    immobile,
    sinkage: zSum / wheels.length,
    resistance: Rsum,
    thrust: Hsum,
    // drawbar-pull margin left at 100 % slip, as a fraction of weight
    tractionMargin: (Hmax - Rsum - gradeForce) / Wsum,
  };
}
