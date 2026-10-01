// 5-DOF robotic arm kinematics (Perseverance-class: shoulder azimuth,
// shoulder elevation, elbow, wrist, turret). Pure functions in the rover body
// frame (+Z forward, +Y up, +X left). Angles in radians.
//
//   J1 azimuth about body +Y (0 = arm plane pointing forward)
//   J2 shoulder elevation in the arm plane (0 = horizontal, + = up)
//   J3 elbow (relative), J4 wrist (relative) — tool axis angle = J2+J3+J4
//   J5 turret rotation about the tool axis (selects instrument)
export const ARM = {
  shoulder: [-0.38, 0.98, 0.95],
  L1: 0.92,          // shoulder → elbow
  L2: 0.88,          // elbow → wrist
  L3: 0.24,          // wrist → turret centre (along tool axis)
  bit: 0.30,         // turret centre → drill bit tip
  limits: {
    j1: [-1.9, 1.9], j2: [-1.75, 1.6], j3: [-3.0, 0.2], j4: [-3.1, 3.1], j5: [-3.14, 3.14],
  },
  stow: [1.5, 0.05, -2.95, 1.45, 0],
  rateRad: 0.35,     // joint slew rate (rad/s), Perseverance arm is deliberate
};

const clampJ = (v, [a, b]) => Math.min(Math.max(v, a), b);

/** Forward kinematics: returns elbow, wrist, turret centre and tool tip. */
export function forward(q, A = ARM) {
  const [j1, j2, j3, j4] = q;
  const d = [Math.sin(j1), 0, Math.cos(j1)];
  const S = A.shoulder;
  const at = (base, ang, len) => [
    base[0] + d[0] * Math.cos(ang) * len,
    base[1] + Math.sin(ang) * len,
    base[2] + d[2] * Math.cos(ang) * len,
  ];
  const elbow = at(S, j2, A.L1);
  const wrist = at(elbow, j2 + j3, A.L2);
  const phi = j2 + j3 + j4;
  const turret = at(wrist, phi, A.L3);
  const tip = at(wrist, phi, A.L3 + A.bit);
  return { elbow, wrist, turret, tip, toolAngle: phi };
}

/**
 * Inverse kinematics for placing the drill tip on `target` with the bit
 * pointing into the surface along −`normal` (both in the body frame).
 * Returns {q, reachable, error}.
 */
export function solveDrill(target, normal, A = ARM) {
  const n = normal;
  const reach = A.L3 + A.bit;
  const W = [target[0] + n[0] * reach, target[1] + n[1] * reach, target[2] + n[2] * reach];
  const S = A.shoulder;
  const dx = W[0] - S[0], dz = W[2] - S[2];
  const j1 = Math.atan2(dx, dz);
  const rho = Math.hypot(dx, dz);
  const h = W[1] - S[1];
  const r2 = rho * rho + h * h;
  let D = (r2 - A.L1 * A.L1 - A.L2 * A.L2) / (2 * A.L1 * A.L2);
  const reachable = Math.abs(D) <= 1;
  D = Math.min(Math.max(D, -1), 1);
  const j3 = -Math.acos(D); // elbow-up branch
  const j2 = Math.atan2(h, rho) - Math.atan2(A.L2 * Math.sin(j3), A.L1 + A.L2 * Math.cos(j3));
  // desired tool direction (−n) expressed as an angle in the arm plane
  const horiz = -(n[0] * Math.sin(j1) + n[2] * Math.cos(j1));
  const phi = Math.atan2(-n[1], horiz);
  const j4 = phi - j2 - j3;
  const L = A.limits;
  const q = [clampJ(j1, L.j1), clampJ(j2, L.j2), clampJ(j3, L.j3), clampJ(wrapPi(j4), L.j4), 0];
  const tip = forward(q, A).tip;
  const error = Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2]);
  return { q, reachable: reachable && error < 0.02, error };
}

function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Slew each joint toward the goal at the arm's rate limit. Returns true when settled.
export function slew(q, goal, dt, rate = ARM.rateRad) {
  let settled = true;
  for (let i = 0; i < q.length; i++) {
    const d = goal[i] - q[i];
    const step = rate * dt;
    if (Math.abs(d) > step) { q[i] += Math.sign(d) * step; settled = false; } else q[i] = goal[i];
  }
  return settled;
}
