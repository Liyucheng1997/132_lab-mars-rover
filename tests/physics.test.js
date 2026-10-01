// Physics model verification (node --test). Reference values are from
// published sources noted inline; tolerances reflect each model's fidelity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROVER, MARS, SITE } from "../src/core/constants.js";
import { marsTime, missionSol, nextLmst } from "../src/physics/marsTime.js";
import { skyBodies, dsnVisibility, orbiterPasses, moons } from "../src/physics/ephemeris.js";
import { linkage, solveSide, solveVehicle, wheelLoadSplit, lateralLoad } from "../src/physics/rockerBogie.js";
import { SOILS, solveSlip, sinkage } from "../src/physics/terramechanics.js";
import { solveDrill, forward, ARM } from "../src/physics/armKinematics.js";
import { environment, airTemperatureC, pressurePa } from "../src/physics/environment.js";
import { rtgWatts, PowerSystem } from "../src/physics/power.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);

// ---------------------------------------------------------------- time
test("Mars24 reproduces Allison & McEwen (2000) worked example A", () => {
  // 2000-01-06 00:00:00 UTC (TT−UTC = 64.184 s in 2000)
  const m = marsTime(Date.UTC(2000, 0, 6, 0, 0, 0), 0, 0);
  near(m.Ls, 277.18758, 2e-4, "Ls");
  near(m.eot, -5.18774, 2e-4, "EOT");
  near(m.decl, -25.2283, 2e-3, "solar declination");
  near(m.mst, 23.99425, 2e-4, "MST");
});

test("Perseverance landing: LMST ≈ 15:53 and Ls ≈ 5°", () => {
  const m = marsTime(SITE.landingUtc);
  near(m.lmst, 15.9, 0.05, "LMST (h)");
  near(m.Ls, 5.2, 0.6, "Ls");
  assert.equal(missionSol(SITE.landingUtc), 0);
  // Sol 1000 fell on 2023-12-12/13
  const sol = missionSol(Date.UTC(2023, 11, 12, 12));
  assert.ok(sol === 999 || sol === 1000, `sol ${sol}`);
});

test("nextLmst lands on the requested local mean solar time", () => {
  const t = nextLmst(Date.UTC(2024, 4, 1), 9.5);
  near(marsTime(t).lmst, 9.5, 1e-3);
});

test("independent IAU-vector Sun direction agrees with Mars24 to < 0.3°", () => {
  for (let k = 0; k < 40; k++) {
    const ms = Date.UTC(2021, 0, 1) + k * 37.3 * 86400e3 + k * 5113e3;
    const m = marsTime(ms);
    const sb = skyBodies(ms);
    near(sb.sun.el, m.sunElevDeg, 0.3, `elevation @${new Date(ms).toISOString()}`);
    // full direction: angular separation of the two unit vectors
    const a = m.sunENU, v = sb.sun.enu;
    const sep = (Math.acos(Math.min(1, a[0] * v[0] + a[1] * v[1] + a[2] * v[2])) * 180) / Math.PI;
    assert.ok(sep < 0.3, `directions differ by ${sep.toFixed(3)}°`);
  }
});

test("Earth–Mars one-way light time stays within 3–23 min", () => {
  let lo = Infinity, hi = 0;
  for (let d = 0; d < 365 * 8; d += 5) {
    const o = skyBodies(Date.UTC(2020, 0, 1) + d * 86400e3).owltSec / 60;
    lo = Math.min(lo, o); hi = Math.max(hi, o);
  }
  assert.ok(lo > 3 && lo < 4.6, `min ${lo}`);
  assert.ok(hi > 20.5 && hi < 23, `max ${hi}`);
});

test("DSN visibility lists the three complexes; at least one sees Mars most of the time", () => {
  let covered = 0;
  for (let h = 0; h < 48; h++) {
    const v = dsnVisibility(Date.UTC(2024, 6, 1) + h * 3600e3);
    assert.equal(v.length, 3);
    if (v[0].elDeg > 10) covered++;
  }
  assert.ok(covered >= 40, `covered ${covered}/48 h`);
});

test("relay passes: MRO sun-synchronous passes cluster near 03:00/15:00 LTST", () => {
  const passes = orbiterPasses(Date.UTC(2024, 2, 1)).filter((p) => p.id === "MRO");
  assert.ok(passes.length >= 1);
  for (const p of passes) {
    const ltst = marsTime((p.aos + p.los) / 2).ltst;
    const d = Math.min(Math.abs(ltst - 15), Math.abs(ltst - 3));
    assert.ok(d < 1.2, `MRO pass at LTST ${ltst.toFixed(2)}`);
    assert.ok(p.los - p.aos < 15 * 60e3, "pass duration < 15 min");
  }
});

test("Phobos apparent size is ~0.12–0.21° from Jezero", () => {
  for (let k = 0; k < 30; k++) {
    const ph = moons(Date.UTC(2024, 0, 1) + k * 2.1e6)[0];
    if (ph.el > 0) assert.ok(ph.angularDiamDeg > 0.12 && ph.angularDiamDeg < 0.21, `${ph.angularDiamDeg}`);
  }
});

// ---------------------------------------------------------------- suspension
const L = linkage(ROVER.suspension);
const P0 = ROVER.suspension.rockerPivot[0];

test("rocker-bogie: flat ground is the rest pose", () => {
  const s = solveSide(() => 0, L, P0);
  near(s.thetaR, 0, 1e-9); near(s.thetaB, 0, 1e-9);
  near(s.pivot[1], ROVER.suspension.rockerPivot[1], 1e-9);
  for (const k of ["front", "mid", "rear"]) near(s.clearance[k], 0, 1e-9, k);
});

test("rocker-bogie: uniform slope tilts every link by the slope angle", () => {
  const a = (12 * Math.PI) / 180;
  const s = solveSide((x) => x * Math.tan(a), L, P0);
  near(s.thetaR, a, 1e-4); near(s.thetaB, a, 1e-4);
});

test("rocker-bogie: a 20 cm step under the front wheel keeps all three wheels in contact", () => {
  const s = solveSide((x) => (x > 0.95 ? 0.2 : 0), L, P0);
  for (const k of ["front", "mid", "rear"]) near(s.clearance[k], 0, 1e-3, k);
  assert.ok(s.thetaR > 0.05, "rocker pitched up");
  assert.ok(s.pivot[1] > ROVER.suspension.rockerPivot[1], "body raised");
});

test("differential: body pitch is the mean of the two rocker angles", () => {
  const left = solveSide((x) => (x > 0.95 ? 0.2 : 0), L, P0);
  const right = solveSide(() => 0, L, P0);
  const v = solveVehicle(left, right, ROVER.trackHalf);
  near(v.pitch, left.thetaR / 2, 1e-9);
  near(v.rockerRel.left, -v.rockerRel.right, 1e-12);
  assert.ok(v.roll > 0, "left side higher → positive roll");
});

test("static load split is ~1/3 per wheel on flat ground and sums to 1", () => {
  const sp = wheelLoadSplit(solveSide(() => 0, L, P0));
  near(sp.front + sp.mid + sp.rear, 1, 1e-9);
  for (const k in sp) near(sp[k], 1 / 3, 0.03, k);
  assert.ok(lateralLoad(0.6, ROVER.trackHalf, 0.95).margin < lateralLoad(0.1, ROVER.trackHalf, 0.95).margin);
});

// ---------------------------------------------------------------- terramechanics
const W = ROVER.massKg * MARS.gravity;
const slipAt = (soil, deg) => {
  const a = (deg * Math.PI) / 180;
  const wheels = Array.from({ length: 6 }, () => ({ W: (W * Math.cos(a)) / 6, soil: SOILS[soil] }));
  return solveSlip(wheels, W * Math.sin(a), ROVER.wheel.radius, ROVER.wheel.width);
};

test("slip grows monotonically with slope and soil softness", () => {
  for (const soil of ["bedrock", "regolith", "sand"]) {
    let prev = -1;
    for (const deg of [0, 5, 10, 15]) {
      const s = slipAt(soil, deg).slip;
      assert.ok(s >= prev - 1e-9, `${soil} ${deg}°`);
      prev = s;
    }
  }
  assert.ok(slipAt("bedrock", 15).slip < slipAt("regolith", 15).slip);
  assert.ok(slipAt("regolith", 10).slip < slipAt("sand", 10).slip);
});

test("regolith ≈ 20 % slip at 20°; loose sand immobilises the rover past ~15°", () => {
  near(slipAt("regolith", 20).slip, 0.2, 0.08);
  assert.equal(slipAt("sand", 20).immobile, true);
  assert.equal(slipAt("regolith", 5).immobile, false);
});

test("static sinkage on regolith is centimetre-scale (MSL/M2020 observed 1–3 cm)", () => {
  const z = sinkage(W / 6, SOILS.regolith, ROVER.wheel.radius, ROVER.wheel.width);
  assert.ok(z > 0.005 && z < 0.04, `${z}`);
});

// ---------------------------------------------------------------- arm
test("arm IK places the drill tip exactly across the forward workspace", () => {
  for (let x = -0.5; x <= 0.4; x += 0.3)
    for (let z = 1.6; z <= 2.2; z += 0.2)
      for (const y of [-0.15, 0, 0.15]) {
        const r = solveDrill([x, y, z], [0, 1, 0]);
        assert.ok(r.reachable, `(${x},${y},${z})`);
        const tip = forward(r.q).tip;
        near(Math.hypot(tip[0] - x, tip[1] - y, tip[2] - z), 0, 1e-3);
        near(forward(r.q).toolAngle, -Math.PI / 2, 1e-6, "bit vertical");
      }
});

test("arm IK rejects out-of-reach targets", () => {
  assert.equal(solveDrill([0, 0, 3.6], [0, 1, 0]).reachable, false);
  assert.ok(ARM.L1 + ARM.L2 + ARM.L3 + ARM.bit < ROVER.arm.lengthM + 0.35);
});

// ---------------------------------------------------------------- environment & power
test("MEDA-like diurnal cycle: coldest pre-dawn, warmest early afternoon, P in Jezero range", () => {
  const temps = Array.from({ length: 24 }, (_, h) => airTemperatureC(h, 30, 0.5));
  const min = temps.indexOf(Math.min(...temps)), max = temps.indexOf(Math.max(...temps));
  assert.ok(min >= 3 && min <= 6, `min at ${min}h`);
  assert.ok(max >= 12 && max <= 15, `max at ${max}h`);
  assert.ok(Math.min(...temps) > -95 && Math.max(...temps) < 0);
  for (let Ls = 0; Ls < 360; Ls += 15) {
    const p = pressurePa(12, Ls);
    assert.ok(p > 580 && p < 800, `P(${Ls}) = ${p}`);
  }
  const e = environment(marsTime(Date.UTC(2024, 0, 1, 12)), 1000, 0);
  assert.ok(e.tau > 0.3 && e.tau < 2.5);
});

test("MMRTG output: 110 W at launch, ~95 W six years on", () => {
  near(rtgWatts(ROVER.mmrtg.launchUtc), 110, 1e-9);
  const w = rtgWatts(Date.UTC(2026, 6, 30));
  assert.ok(w > 88 && w < 100, `${w}`);
});

test("battery energy balance integrates net power", () => {
  const p = new PowerSystem();
  const e0 = p.energyWh;
  p.step(3600, { ms: Date.UTC(2024, 0, 1), awake: false });
  near(p.energyWh - e0, p.rtg - p.load, 1e-6, "Wh over one hour");
  assert.ok(p.net > 0, "RTG charges the battery while asleep");
});
