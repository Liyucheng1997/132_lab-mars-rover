import * as THREE from "three";
import { DEG, ROVER } from "../core/constants.js";
import { clamp, wrapPi } from "../core/math.js";
import { buildCostMap, planRoute } from "./globalPlanner.js";

// AutoNav: strategic route (A* over the orbital cost map) + tactical ENav-style
// arc evaluation. Each cycle the rover "images" the terrain ahead, scores a fan
// of candidate arcs against a rover-footprint hazard model (rock height,
// slope, roughness, sand), and drives the best arc toward a carrot point on
// the strategic route. No safe arc → turn in place toward the route; repeated
// failures → back up and replan.
const ARC_LEN = 3.0;
const HALF_W = 1.25;      // footprint half-width checked across the arc
const KMAX = 1 / 1.7;

export class AutoNav {
  constructor(terrain) {
    this.terrain = terrain;
    this.goal = null;
    this.route = null;
    this.status = "无目标";
    this.visuals = new THREE.Group();
    this._arcs = new THREE.Group();
    this.visuals.add(this._arcs);
    this._routeLine = null;
    this._marker = this._makeMarker();
    this._marker.visible = false;
    this.visuals.add(this._marker);
    this._lastPlanOdo = -1;
    this._choice = null;
    this._planHeading = 0;
    this._fails = 0;
    this._backup = 0;
    this.showArcs = true;
  }

  buildMap() {
    const t = this.terrain;
    const t0 = performance.now();
    this.map = buildCostMap({
      size: t.near.size, cell: 2,
      heightAt: (x, z) => t.heightAt(x, z),
      materialAt: (x, z) => t.materialAt(x, z),
      slopeLimitDeg: 25,
    });
    return performance.now() - t0;
  }

  _makeMarker() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x4ad6ff, transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 48), mat);
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 8), mat);
    pole.position.y = 1.2;
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 4), mat);
    flag.position.y = 2.6;
    flag.rotation.x = Math.PI;
    g.add(flag);
    this._flag = flag;
    return g;
  }

  setGoal(x, z, from) {
    this.goal = new THREE.Vector3(x, this.terrain.heightAt(x, z), z);
    this._marker.visible = true;
    this._marker.position.copy(this.goal).add(new THREE.Vector3(0, 0.05, 0));
    this._choice = null;
    const t0 = performance.now();
    this.route = this.map ? planRoute(this.map, from.x, from.z, x, z) : [[from.x, from.z], [x, z]];
    const ms = performance.now() - t0;
    this._drawRoute();
    this._fails = 0;
    this.status = this.route ? "路线已规划" : "无可行路线";
    return { ok: !!this.route, ms, nodes: this.route ? this.route.length : 0, length: this._routeLength() };
  }

  clear() {
    this.goal = null; this.route = null;
    this._marker.visible = false;
    this._clearArcs();
    if (this._routeLine) { this.visuals.remove(this._routeLine); this._routeLine.geometry.dispose(); this._routeLine = null; }
    this.status = "无目标";
  }

  _routeLength() {
    if (!this.route) return 0;
    let L = 0;
    for (let i = 1; i < this.route.length; i++) L += Math.hypot(this.route[i][0] - this.route[i - 1][0], this.route[i][1] - this.route[i - 1][1]);
    return L;
  }

  _drawRoute() {
    if (this._routeLine) { this.visuals.remove(this._routeLine); this._routeLine.geometry.dispose(); }
    this._routeLine = null;
    if (!this.route) return;
    const pts = [];
    for (let i = 1; i < this.route.length; i++) {
      const [ax, az] = this.route[i - 1], [bx, bz] = this.route[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.0));
      for (let s = 0; s <= n; s++) {
        const x = ax + ((bx - ax) * s) / n, z = az + ((bz - az) * s) / n;
        pts.push(new THREE.Vector3(x, this.terrain.heightAt(x, z) + 0.12, z));
      }
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this._routeLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x4ad6ff, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.8 }));
    this._routeLine.computeLineDistances();
    this.visuals.add(this._routeLine);
  }

  // Carrot point: project the rover onto the route polyline, then walk
  // `ahead` metres further along it (pure-pursuit look-ahead).
  _carrot(p, ahead = 6) {
    const R = this.route;
    if (!R || R.length < 2) return this.goal;
    let bestSeg = 0, bestT = 0, bestD = Infinity;
    for (let i = 0; i < R.length - 1; i++) {
      const [ax, az] = R[i], [bx, bz] = R[i + 1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.z - az) * dz) / L2));
      const d = Math.hypot(ax + dx * t - p.x, az + dz * t - p.z);
      if (d < bestD) { bestD = d; bestSeg = i; bestT = t; }
    }
    if (bestSeg > 0) { R.splice(0, bestSeg); bestSeg = 0; } // passed segments
    let remain = ahead;
    for (let i = bestSeg; i < R.length - 1; i++) {
      const [ax, az] = R[i], [bx, bz] = R[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const t0 = i === bestSeg ? bestT : 0;
      const left = L * (1 - t0);
      if (left >= remain) {
        const t = t0 + remain / Math.max(L, 1e-9);
        return new THREE.Vector3(ax + (bx - ax) * t, 0, az + (bz - az) * t);
      }
      remain -= left;
    }
    return this.goal;
  }

  // Hazard evaluation of one arc. Returns {cost, pts} or {blocked, pts}.
  _evalArc(x, z, h, k, dir) {
    const t = this.terrain;
    const steps = 12, ds = (ARC_LEN / steps) * dir;
    let cx = x, cz = z, ch = h, cost = 0;
    const pts = [];
    for (let i = 0; i < steps; i++) {
      ch -= k * ds;
      cx += Math.sin(ch) * ds; cz -= Math.cos(ch) * ds;
      pts.push(new THREE.Vector3(cx, t.heightAt(cx, cz) + 0.08, cz));
      if (!t.inBounds(cx, cz, 14)) return { blocked: "边界", pts };
      // footprint plane: sample across the body width
      const lx = -Math.cos(ch), lz = -Math.sin(ch);
      const yl = t.heightAt(cx + lx * HALF_W, cz + lz * HALF_W);
      const yr = t.heightAt(cx - lx * HALF_W, cz - lz * HALF_W);
      const yf = t.heightAt(cx + Math.sin(ch) * 1.3, cz - Math.cos(ch) * 1.3);
      const yb = t.heightAt(cx - Math.sin(ch) * 1.3, cz + Math.cos(ch) * 1.3);
      const roll = Math.atan2(Math.abs(yl - yr), 2 * HALF_W);
      const pitch = Math.atan2(Math.abs(yf - yb), 2.6);
      const tilt = Math.max(roll, pitch);
      if (tilt > 22 * DEG) return { blocked: "坡度", pts };
      const y0 = t.heightAt(cx, cz);
      const rough = Math.abs(y0 - 0.25 * (yl + yr + yf + yb));
      if (rough > 0.3) return { blocked: "粗糙度", pts };
      const m = t.materialAt(cx, cz);
      cost += tilt * 4 + rough * 6 + m.sand * 0.6;
    }
    // rocks: anything taller than the ENav threshold within the swept footprint
    if (t.rocks) {
      const mx = (x + cx) / 2, mz = (z + cz) / 2;
      for (const r of t.rocks.hazardsNear(mx, mz, ARC_LEN / 2 + HALF_W + 0.5, ROVER.hazardRockHeight)) {
        for (const p of pts) {
          if (Math.hypot(p.x - r.x, p.z - r.z) < r.r + HALF_W * 0.9) return { blocked: "岩石", pts };
        }
      }
      // shorter rocks are traversable but cost a little (suspension excursion)
      for (const r of t.rocks.hazardsNear(mx, mz, ARC_LEN / 2 + 1, 0.2)) {
        for (const p of pts) if (Math.hypot(p.x - r.x, p.z - r.z) < r.r + 0.6) cost += r.h * 2;
      }
    }
    return { cost, pts, ex: cx, ez: cz, eh: ch };
  }

  _clearArcs() {
    for (const c of this._arcs.children) c.geometry.dispose();
    this._arcs.clear();
  }

  _drawArc(pts, color, opacity = 0.75) {
    if (!this.showArcs || pts.length < 2) return;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    this._arcs.add(line);
  }

  /**
   * One AutoNav cycle. Returns a mobility command {speed, curvature, spot}
   * plus {arrived}. `odo` = vehicle odometer, used to re-plan every 0.5 m.
   */
  update(rover, odo, now) {
    if (!this.goal) return { speed: 0, curvature: 0, spot: 0 };
    this._flag.position.y = 2.6 + Math.sin(now * 0.004) * 0.1;
    const p = rover.position;
    const dist = Math.hypot(this.goal.x - p.x, this.goal.z - p.z);
    if (dist < 1.5) {
      this.status = "已到达";
      this._clearArcs();
      return { speed: 0, curvature: 0, spot: 0, arrived: true };
    }

    if (this._backup > 0) {
      this._backup -= 1;
      this.status = "后退并重规划";
      return { speed: -1, curvature: 0, spot: 0 };
    }

    // re-plan every 0.5 m of travel (or when stopped)
    const c = this._choice;
    const need = c === null || Math.abs(odo - this._lastPlanOdo) > 0.5 ||
      (c.spot && Math.abs(wrapPi(rover.heading - this._planHeading)) > 8 * DEG);
    if (need) {
      this._lastPlanOdo = odo;
      this._planHeading = rover.heading;
      this._clearArcs();
      const carrot = this._carrot(p);
      const goalH = Math.atan2(carrot.x - p.x, -(carrot.z - p.z));
      const herr = wrapPi(goalH - rover.heading);

      // large heading error: turn in place first (cheaper and safer than a long arc)
      if (Math.abs(herr) > 70 * DEG) {
        this._choice = { speed: 0, curvature: 0, spot: Math.sign(herr) };
        this.status = `原地转向 ${(herr / DEG).toFixed(0)}°`;
        return this._choice;
      }

      let best = null, blockedCount = 0;
      const N = 13;
      for (let i = 0; i < N; i++) {
        const k = -KMAX + (2 * KMAX * i) / (N - 1);
        const r = this._evalArc(p.x, p.z, rover.heading, k, 1);
        if (r.blocked) { blockedCount++; this._drawArc(r.pts, 0xff4a3a, 0.6); continue; }
        const endErr = Math.abs(wrapPi(Math.atan2(carrot.x - r.ex, -(carrot.z - r.ez)) - r.eh));
        const prog = Math.hypot(carrot.x - p.x, carrot.z - p.z) - Math.hypot(carrot.x - r.ex, carrot.z - r.ez);
        const score = -r.cost - endErr * 2.2 + prog * 1.5 - Math.abs(k) * 0.3;
        this._drawArc(r.pts, 0x52c878, 0.45);
        if (!best || score > best.score) best = { k, score, pts: r.pts };
      }
      if (!best) {
        this._fails++;
        if (this._fails > 3) { this._backup = 150; this._fails = 0; }
        this._choice = { speed: 0, curvature: 0, spot: Math.sign(herr) || 1 };
        this.status = `全部 ${blockedCount} 条弧线受阻 — 原地转向`;
        return this._choice;
      }
      this._fails = 0;
      this._drawArc(best.pts, 0x4ad6ff, 1);
      this._choice = { speed: clamp(dist / 3, 0.35, 1), curvature: best.k, spot: 0 };
      this.status = `ENav 行驶 · 剩余 ${dist.toFixed(1)} m · ${N - blockedCount}/${N} 安全弧`;
    }
    return this._choice;
  }
}
