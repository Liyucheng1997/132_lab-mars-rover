import * as THREE from "three";

// AutoNav-style local planner.
// Casts a fan of candidate steering arcs ahead of the rover, scores each by
// terrain hazard (slope + roughness + out-of-bounds), and picks the safest arc
// that makes progress toward the goal. Mirrors the real rover's GESTALT/ENav idea.
export class Planner {
  constructor(terrain) {
    this.terrain = terrain;
    this.goal = null;
    this.status = "无目标";
    this.maxSteer = THREE.MathUtils.degToRad(28);
    this.lookahead = 7;       // metres
    this.slopeLimit = THREE.MathUtils.degToRad(25); // rover safety slope
    this.arriveRadius = 2.0;

    this.visuals = new THREE.Group();
    this._marker = this._makeMarker();
    this.visuals.add(this._marker);
    this._marker.visible = false;

    this._pathLine = null;
    this._arcLines = new THREE.Group();
    this.visuals.add(this._arcLines);
  }

  _makeMarker() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.0, 0.08, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x4ad6ff })
    );
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    const beacon = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 1.2, 12),
      new THREE.MeshBasicMaterial({ color: 0x4ad6ff, transparent: true, opacity: 0.8 })
    );
    beacon.position.y = 1.4;
    beacon.rotation.x = Math.PI;
    g.add(beacon);
    this._beacon = beacon;
    return g;
  }

  setGoal(point) {
    this.goal = point.clone();
    this.status = "规划中";
    this._marker.visible = true;
    this._marker.position.copy(point);
    this._marker.position.y = this.terrain.heightAt(point.x, point.z) + 0.05;
  }

  clearGoal() {
    this.goal = null;
    this.status = "无目标";
    this._marker.visible = false;
    this._clearArcs();
  }

  _clearArcs() {
    while (this._arcLines.children.length) {
      const c = this._arcLines.children.pop();
      c.geometry.dispose();
      this._arcLines.remove(c);
    }
  }

  // Simulate an arc with given steer; return hazard cost + end pose, or null if blocked
  _evaluateArc(x, z, heading, steer, points) {
    const t = this.terrain;
    const steps = 12;
    const ds = this.lookahead / steps;
    let cx = x, cz = z, ch = heading;
    let cost = 0, maxSlope = 0, prevY = t.heightAt(cx, cz);
    const turnRate = steer / this.lookahead; // rad per metre
    for (let i = 0; i < steps; i++) {
      ch += turnRate * ds;
      cx += Math.sin(ch) * ds;
      cz += Math.cos(ch) * ds;
      if (!t.inBounds(cx, cz)) return null;
      // Boulder hazard — give the rover a body-width berth
      if (t.blocked(cx, cz, 1.7)) return null;
      const slope = t.slopeAt(cx, cz);
      maxSlope = Math.max(maxSlope, slope);
      if (slope > this.slopeLimit) return null; // hard hazard
      const y = t.heightAt(cx, cz);
      const rough = Math.abs(y - prevY); // step roughness
      prevY = y;
      cost += slope * 2 + rough * 4;
      if (points) points.push(new THREE.Vector3(cx, y + 0.15, cz));
    }
    return { cost, maxSlope, ex: cx, ez: cz, eh: ch };
  }

  // Returns {throttle, steer, status}
  update(rover, showArcs = true) {
    if (!this.goal) return { throttle: 0, steer: 0, status: this.status };

    const px = rover.position.x, pz = rover.position.z;
    const dx = this.goal.x - px, dz = this.goal.z - pz;
    const dist = Math.hypot(dx, dz);

    // Pulse the beacon
    this._beacon.position.y = 1.4 + Math.sin(performance.now() * 0.004) * 0.15;

    if (dist < this.arriveRadius) {
      this.status = "已到达";
      this._clearArcs();
      return { throttle: 0, steer: 0, status: this.status, arrived: true };
    }

    const goalHeading = Math.atan2(dx, dz);

    // Fan of candidate steer angles
    const N = 11;
    let best = null, bestScore = -Infinity;
    if (showArcs) this._clearArcs();

    for (let i = 0; i < N; i++) {
      const steer = THREE.MathUtils.lerp(-this.maxSteer, this.maxSteer, i / (N - 1));
      const pts = showArcs ? [] : null;
      const res = this._evaluateArc(px, pz, rover.heading, steer, pts);
      if (!res) {
        if (showArcs && pts && pts.length) this._drawArc(pts, 0xff4444);
        continue;
      }
      // Heading alignment of the arc's endpoint toward goal
      const endHeadingErr = Math.abs(this._angleDiff(Math.atan2(this.goal.x - res.ex, this.goal.z - res.ez), res.eh));
      const score = -res.cost - endHeadingErr * 3 - Math.abs(steer) * 0.5;
      if (showArcs && pts) this._drawArc(pts, 0x44aa66);
      if (score > bestScore) { bestScore = score; best = { steer, res }; }
    }

    if (!best) {
      this.status = "受阻 — 重新规划";
      return { throttle: -0.3, steer: 0.6, status: this.status }; // back up & turn
    }

    if (showArcs && best) {
      const pts = [];
      this._evaluateArc(px, pz, rover.heading, best.steer, pts);
      this._drawArc(pts, 0x4ad6ff, 3);
    }

    // Convert chosen steer to normalized command; throttle eases near goal
    const steerCmd = THREE.MathUtils.clamp(best.steer / this.maxSteer, -1, 1);
    const throttle = THREE.MathUtils.clamp(dist / 5, 0.25, 1);
    this.status = `行驶中 · 距目标 ${dist.toFixed(1)} m`;
    return { throttle, steer: steerCmd, status: this.status, dist };
  }

  _drawArc(points, color, width = 1) {
    if (points.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    this._arcLines.add(line);
  }

  _angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
}
