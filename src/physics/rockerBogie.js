// Rocker-bogie suspension kinematics (planar per side + differential).
//
// Each side is a 2-link passive mechanism in the vehicle's vertical plane:
//   rocker — pivots on the body at P, carries the front wheel and the bogie pivot B
//   bogie  — pivots at B, carries the middle and rear wheels
// Given the terrain profile under a side, we solve the world-frame rocker and
// bogie angles that put all three wheel rims in contact with the ground
// (rim contact, not centre-point contact, so wheels climb steps and rocks).
// The differential bar forces the two rockers to rotate equal-and-opposite
// relative to the body, so body pitch is the mean of the two rocker angles.
//
// Coordinates: s = forward distance (m), y = up (m). Angles positive nose-up.
import { clamp } from "../core/math.js";
import { DEG } from "../core/constants.js";

const rot = (v, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};

// Derive the rest-pose link vectors from absolute rest positions ([z, y]).
export function linkage(geo) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  return {
    r: geo.front[1],
    pF: sub(geo.front, geo.rockerPivot),
    pB: sub(geo.bogiePivot, geo.rockerPivot),
    bM: sub(geo.mid, geo.bogiePivot),
    bR: sub(geo.rear, geo.bogiePivot),
    pivot: geo.rockerPivot,
    bogieLimit: (geo.bogieLimitDeg ?? 32) * DEG,
    rockerLimit: (geo.rockerLimitDeg ?? 25) * DEG,
  };
}

// Height of a wheel centre resting on the ground profile near station s:
// the lowest centre height at which the rim clears every ground sample.
export function rimContactY(ground, s, r, samples = 9) {
  let y = -Infinity;
  for (let k = 0; k < samples; k++) {
    const d = r * (-0.92 + (1.84 * k) / (samples - 1));
    const v = ground(s + d) + Math.sqrt(r * r - d * d);
    if (v > y) y = v;
  }
  return y;
}

/**
 * Solve one side.
 * @param ground  (s) => ground height along this side's wheel line
 * @param L       linkage(geo)
 * @param sPivot  forward station of the rocker pivot
 * @param guess   optional previous solution {thetaR, thetaB} (warm start)
 */
export function solveSide(ground, L, sPivot, guess) {
  let thetaR = guess ? guess.thetaR : 0;
  let thetaB = guess ? guess.thetaB : 0;
  let P = [sPivot, 0], B, F, M, R;
  const aBog0 = Math.atan2(L.bM[1] - L.bR[1], L.bM[0] - L.bR[0]);
  const aRock0 = Math.atan2(L.pF[1] - L.pB[1], L.pF[0] - L.pB[0]);
  let lifted = null;

  for (let it = 0; it < 5; it++) {
    // stations of each wheel with the current angles (pivot station fixed)
    const pb = rot(L.pB, thetaR), pf = rot(L.pF, thetaR);
    const sB = sPivot + pb[0];
    const sF = sPivot + pf[0];
    const sM = sB + rot(L.bM, thetaB)[0];
    const sR = sB + rot(L.bR, thetaB)[0];
    F = [sF, rimContactY(ground, sF, L.r)];
    M = [sM, rimContactY(ground, sM, L.r)];
    R = [sR, rimContactY(ground, sR, L.r)];

    // bogie: the line through the middle and rear wheel centres
    thetaB = Math.atan2(M[1] - R[1], M[0] - R[0]) - aBog0;
    // bogie joint limit relative to the rocker: if hit, the higher wheel lifts
    lifted = null;
    const rel = thetaB - thetaR;
    if (Math.abs(rel) > L.bogieLimit) {
      thetaB = thetaR + Math.sign(rel) * L.bogieLimit;
      lifted = rel > 0 ? "rear" : "mid";
    }
    const anchor = lifted === "mid" ? R : M;
    const anchorVec = lifted === "mid" ? L.bR : L.bM;
    const av = rot(anchorVec, thetaB);
    B = [anchor[0] - av[0], anchor[1] - av[1]];

    // rocker: the line through the bogie pivot and the front wheel centre
    thetaR = Math.atan2(F[1] - B[1], F[0] - B[0]) - aRock0;
    const pbv = rot(L.pB, thetaR);
    P = [B[0] - pbv[0], B[1] - pbv[1]];
  }

  // final wheel centres from the solved linkage (rigid-body consistent)
  const pf = rot(L.pF, thetaR);
  F = [P[0] + pf[0], P[1] + pf[1]];
  const mv = rot(L.bM, thetaB), rv = rot(L.bR, thetaB);
  M = [B[0] + mv[0], B[1] + mv[1]];
  R = [B[0] + rv[0], B[1] + rv[1]];
  const clear = (w) => w[1] - rimContactY(ground, w[0], L.r);

  return {
    thetaR, thetaB,
    bogieRel: thetaB - thetaR,
    pivot: P, bogiePivot: B,
    wheels: { front: F, mid: M, rear: R },
    clearance: { front: clear(F), mid: clear(M), rear: clear(R) },
    lifted,
  };
}

/**
 * Combine both sides through the differential.
 * Returns body pitch/roll, pivot height, each rocker's angle relative to the
 * body (equal and opposite), and static wheel normal-load fractions.
 */
export function solveVehicle(left, right, trackHalf) {
  const pitch = 0.5 * (left.thetaR + right.thetaR);
  const roll = Math.atan2(left.pivot[1] - right.pivot[1], 2 * trackHalf);
  const pivotY = 0.5 * (left.pivot[1] + right.pivot[1]);
  const diff = 0.5 * (left.thetaR - right.thetaR); // left rocker rel. to body
  return {
    pitch, roll, pivotY,
    rockerRel: { left: diff, right: -diff },
    bogieRel: { left: left.bogieRel, right: right.bogieRel },
  };
}

/**
 * Static normal-load distribution (vertical force balance about the passive
 * joints). Returns per-side {front, mid, rear} fractions of that side's load.
 */
export function wheelLoadSplit(side) {
  const sP = side.pivot[0], sB = side.bogiePivot[0];
  const { front: F, mid: M, rear: R } = side.wheels;
  const fF = clamp((sP - sB) / Math.max(1e-6, F[0] - sB), 0, 1);
  const fB = 1 - fF;
  const fMid = clamp((sB - R[0]) / Math.max(1e-6, M[0] - R[0]), 0, 1);
  const out = { front: fF, mid: fB * fMid, rear: fB * (1 - fMid) };
  if (side.lifted) { out[side.lifted === "mid" ? "rear" : "mid"] += out[side.lifted]; out[side.lifted] = 0; }
  return out;
}

/**
 * Lateral load transfer on a cross-slope. Returns the fraction of total
 * weight on the left side and the static stability margin (0 = tip-over).
 */
export function lateralLoad(rollRad, trackHalf, cgHeight) {
  const t = Math.tan(rollRad) * cgHeight / trackHalf;
  return { left: clamp(0.5 * (1 - t), 0, 1), margin: clamp(1 - Math.abs(t), 0, 1) };
}
