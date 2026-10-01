import * as THREE from "three";
import { DEG, MARS, ROVER } from "../core/constants.js";
import { approach, clamp, wrapPi } from "../core/math.js";
import { SOILS, solveSlip } from "../physics/terramechanics.js";

// Mobility flight-software analogue.
//   • Ackermann arcs about the middle-wheel axle; turn-in-place with corner
//     wheels toed in; steering actuators slew-rate limited and the rover
//     holds position until wheels reach their commanded angles
//   • per-wheel normal loads from the rocker-bogie solution feed Bekker–Wong
//     terramechanics → slip, sinkage, traction margin
//   • wheel odometry vs. visual odometry (VO) → measured slip, as on Mars
//   • fault protection: tilt, slip, stability margin, hazardous-rock contact
const SUS = ROVER.suspension;
const WR = ROVER.wheel.radius;
const TH = ROVER.trackHalf;
const STEER_RATE = 12 * DEG;       // rad/s per actuator
const MIN_RADIUS = 1.6;            // tightest arc before switching to turn-in-place
const SPOT_RATE = 4.5 * DEG;       // turn-in-place yaw rate (rad/s)
const BODY_RADIUS = 1.45;          // collision footprint for un-climbable rocks
const WEIGHT = ROVER.massKg * MARS.gravity;

const WHEELS = [];
for (const [side, sx] of [["left", 1], ["right", -1]])
  for (const name of ["front", "mid", "rear"]) WHEELS.push({ side, name, x: sx * TH, z: SUS[name][0] });
const ZC = SUS.mid[0];

export class Vehicle {
  constructor(rover, terrain) {
    this.rover = rover;
    this.terrain = terrain;
    this.cmd = { speed: 0, curvature: 0, spot: 0 };   // what the operator / AutoNav asks for
    this.speed = 0;                // commanded wheel speed actually being applied (m/s)
    this.groundSpeed = 0;          // true body speed over ground
    this.steer = { left: { front: 0, rear: 0 }, right: { front: 0, rear: 0 } };
    this.mode = "arc";
    this.slip = 0; this.measuredSlip = 0;
    this.sinkage = 0;
    this.tractionMargin = 1;
    this.immobile = false;
    this.soilCounts = { regolith: 0, sand: 0, bedrock: 0 };
    this.dominantSoil = "regolith";
    this.odometer = 0;             // true distance
    this.wheelOdo = 0;             // integrated wheel rotation
    this.voOdo = 0;                // visual-odometry estimate
    this.fault = null;
    this.contact = false;
    this.driving = 0;              // 0..1 actuator duty for the power model
    this._voNoise = 0;
  }

  // ---- steering geometry ----
  _targetSteer() {
    const c = this.cmd;
    const out = { left: { front: 0, rear: 0 }, right: { front: 0, rear: 0 } };
    if (c.spot) {
      for (const w of WHEELS) if (w.name !== "mid") out[w.side][w.name] = Math.atan(-(w.z - ZC) / w.x);
      return { mode: "spot", angles: out };
    }
    if (Math.abs(c.curvature) > 1e-4) {
      const R = 1 / c.curvature;
      for (const w of WHEELS) if (w.name !== "mid") out[w.side][w.name] = Math.atan((w.z - ZC) / (R - w.x));
    }
    return { mode: "arc", angles: out };
  }

  _steerSettled(target, tol = 1.5 * DEG) {
    for (const s of ["left", "right"])
      for (const n of ["front", "rear"])
        if (Math.abs(this.steer[s][n] - target[s][n]) > tol) return false;
    return true;
  }

  // Per-wheel speed ratio (wheel linear speed / body reference speed).
  _wheelRatios(mode) {
    const r = { left: {}, right: {} };
    for (const w of WHEELS) {
      if (mode === "spot") r[w.side][w.name] = Math.hypot(w.x, w.z - ZC) * Math.sign(w.x);
      else if (Math.abs(this.cmd.curvature) < 1e-4) r[w.side][w.name] = 1;
      else {
        const R = 1 / this.cmd.curvature;
        r[w.side][w.name] = Math.hypot(R - w.x, w.z - ZC) / Math.abs(R);
      }
    }
    return r;
  }

  clearFault() { this.fault = null; this.immobile = false; }

  step(dt) {
    const rover = this.rover, terrain = this.terrain;
    const c = this.cmd;
    if (Math.abs(c.curvature) > 1 / MIN_RADIUS) c.curvature = Math.sign(c.curvature) / MIN_RADIUS;

    // 1. steering actuators slew toward the commanded geometry
    const target = this._targetSteer();
    for (const s of ["left", "right"])
      for (const n of ["front", "rear"])
        this.steer[s][n] = approach(this.steer[s][n], target.angles[s][n], STEER_RATE * dt);
    rover.setSteer(this.steer);
    const settled = this._steerSettled(target.angles);
    this.mode = target.mode;

    // 2. commanded wheel speed (zero while steering or faulted)
    let want = 0;
    if (!this.fault && settled) want = target.mode === "spot" ? SPOT_RATE * Math.sign(c.spot) : clamp(c.speed, -1, 1) * ROVER.maxWheelSpeed;
    if (!settled && Math.abs(this.speed) < 1e-4) want = 0;
    this.speed = approach(this.speed, want, ROVER.maxWheelSpeed * 2 * dt);
    this.driving = Math.min(1, Math.abs(this.speed) / ROVER.maxWheelSpeed * (target.mode === "spot" ? 0 : 1) + (target.mode === "spot" && this.speed ? 0.8 : 0) + (settled ? 0 : 0.25));

    // 3. terramechanics: per-wheel soil + load → slip / sinkage
    const contacts = rover.wheelContacts();
    const counts = { regolith: 0, sand: 0, bedrock: 0 };
    const wheels = contacts.map((w) => {
      const soil = terrain.soilAt(w.x, w.z);
      const onRock = terrain.contactHeight(w.x, w.z) > terrain.heightAt(w.x, w.z) + 0.02;
      const key = onRock ? "bedrock" : soil;
      counts[key]++;
      const frac = rover.loads ? rover.loads[w.side][w.name] : 1 / 6;
      return { W: WEIGHT * Math.cos(rover.slope) * frac, soil: SOILS[key] };
    });
    this.soilCounts = counts;
    this.dominantSoil = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const dir = Math.sign(this.speed) || 1;
    const grade = target.mode === "spot" ? 0 : WEIGHT * Math.sin(rover.pitch) * dir;
    const sol = solveSlip(wheels, grade, WR, ROVER.wheel.width);
    const moving = Math.abs(this.speed) > 1e-5;
    this.slip = moving ? sol.slip : 0;
    this.immobile = moving && sol.immobile;
    this.tractionMargin = sol.tractionMargin;
    this.sinkage += (sol.sinkage - this.sinkage) * Math.min(1, dt * 0.5);
    rover.sinkage = this.sinkage * 0.8;

    // 4. kinematics
    const fwd = new THREE.Vector3(Math.sin(rover.heading), 0, -Math.cos(rover.heading));
    let ds = 0;
    const ratios = this._wheelRatios(target.mode);
    const rolled = { left: {}, right: {} };
    if (target.mode === "spot") {
      const yaw = this.speed * (1 - clamp(this.slip, 0, 1) * 0.6);
      rover.heading = wrapPi(rover.heading + yaw * dt);
      for (const w of WHEELS) rolled[w.side][w.name] = this.speed * ratios[w.side][w.name] * dt;
    } else {
      this.groundSpeed = this.speed * (1 - this.slip);
      ds = this.groundSpeed * dt;
      rover.heading = wrapPi(rover.heading - c.curvature * ds);
      for (const w of WHEELS) rolled[w.side][w.name] = this.speed * ratios[w.side][w.name] * dt;
    }
    if (target.mode === "spot") this.groundSpeed = 0;
    rover.rollWheels(rolled);

    let nx = rover.position.x + fwd.x * ds;
    let nz = rover.position.z + fwd.z * ds;
    // body collision with rocks too tall for the wheels to climb (> ~wheel diameter)
    this.contact = false;
    if (terrain.rocks) {
      for (const h of terrain.rocks.hazardsNear(nx, nz, BODY_RADIUS + 1.5, 0.55)) {
        const dx = nx - h.x, dz = nz - h.z, d = Math.hypot(dx, dz), min = h.r + BODY_RADIUS;
        if (d < min && d > 1e-4) {
          nx += (dx / d) * (min - d); nz += (dz / d) * (min - d);
          this.contact = true;
        }
      }
    }
    if (!terrain.inBounds(nx, nz, 8)) { nx = rover.position.x; nz = rover.position.z; this.speed = 0; }
    const real = Math.hypot(nx - rover.position.x, nz - rover.position.z);
    rover.position.x = nx; rover.position.z = nz;
    this.odometer += real;
    this.wheelOdo += Math.abs(this.speed) * dt * (target.mode === "spot" ? 0 : 1);
    this._voNoise += (Math.random() - 0.5) * 0.002 * real;
    this.voOdo += real * (1 + this._voNoise * 0.02);
    // VO-measured slip over a sliding window
    if (Math.abs(this.speed) > 0 && target.mode !== "spot") {
      const inst = 1 - (real / Math.max(1e-6, Math.abs(this.speed) * dt));
      this.measuredSlip += (inst - this.measuredSlip) * Math.min(1, dt * 0.3);
    } else this.measuredSlip *= 1 - Math.min(1, dt * 0.2);

    rover.conform();

    // 5. fault protection
    const tilt = rover.slope / DEG;
    if (!this.fault) {
      if (tilt > ROVER.hazardSlopeDeg) this.fault = `倾角超限 ${tilt.toFixed(1)}° > ${ROVER.hazardSlopeDeg}°`;
      else if (this.immobile) this.fault = "牵引力不足 — 车轮 100% 滑转(陷车)";
      else if (this.measuredSlip * 100 > ROVER.slipFaultPct) this.fault = `滑转率超限 ${(this.measuredSlip * 100).toFixed(0)}%`;
      else if (rover.loads && rover.loads.stability < 0.25) this.fault = "静稳定裕度过低 — 侧翻风险";
      if (this.fault) this.speed = 0;
    }
  }
}
