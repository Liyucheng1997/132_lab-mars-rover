// HUD widgets: navigation map (local hillshade + global MOLA), live
// rocker-bogie schematic, and small formatting helpers.
import { ROVER } from "./core/constants.js";
import { clamp } from "./core/math.js";

export const bind = (id) => document.getElementById(id);

export class Minimap {
  constructor(canvas, terrain, { onWaypoint, onState } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.terrain = terrain;
    this.size = canvas.width;
    this.onWaypoint = onWaypoint;
    this.onState = onState;
    this.mode = "local";
    this.zoom = 4;
    this.global = null;
    this._renderBase();
    canvas.addEventListener("wheel", (e) => {
      if (this.mode !== "local") return;
      e.preventDefault();
      this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.25 : 0.8), 1, 32);
      this._emit();
    }, { passive: false });
    canvas.addEventListener("click", (e) => {
      if (this.mode !== "local" || !this._lp) return;
      const r = canvas.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.size, py = ((e.clientY - r.top) / r.height) * this.size;
      const { cx, cz, half } = this._lp;
      this.onWaypoint?.(cx - half + (px / this.size) * 2 * half, cz - half + (py / this.size) * 2 * half);
    });
  }

  _emit() { this.onState?.({ mode: this.mode, zoom: this.zoom }); }
  setGlobal(img, meta) { this.global = { img, meta }; }
  setMode(m) { if (m === "global" && !this.global) return; this.mode = m; this._emit(); }
  toggleMode() { this.setMode(this.mode === "local" ? "global" : "local"); }

  // Hillshade + unit colouring of the near field, 2 m per pixel.
  _renderBase() {
    const t = this.terrain, N = 512, half = t.half;
    this.base = document.createElement("canvas");
    this.base.width = this.base.height = N;
    const g = this.base.getContext("2d");
    const img = g.createImageData(N, N);
    const L = [-0.6, 0.55, -0.6];
    for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
      const x = -half + ((px + 0.5) / N) * 2 * half, z = -half + ((py + 0.5) / N) * 2 * half;
      const e = 1.5;
      const gx = (t.heightAt(x + e, z) - t.heightAt(x - e, z)) / (2 * e);
      const gz = (t.heightAt(x, z + e) - t.heightAt(x, z - e)) / (2 * e);
      const l = Math.hypot(gx, 1, gz);
      const shade = clamp((-gx * L[0] + L[1] - gz * L[2]) / l / 0.95, 0.25, 1.25);
      const m = t.materialAt(x, z);
      let r = 176, gg = 104, b = 70;
      r = r * (1 - m.sand * 0.45) + m.bedrock * 20; gg = gg * (1 - m.sand * 0.35) + m.bedrock * 18; b = b * (1 - m.sand * 0.2) + m.bedrock * 14;
      const slope = Math.atan(Math.hypot(gx, gz));
      const haz = slope > 0.44 ? 1 : 0;
      const i = (py * N + px) * 4;
      img.data[i] = clamp(r * shade + haz * 70, 0, 255);
      img.data[i + 1] = clamp(gg * shade - haz * 20, 0, 255);
      img.data[i + 2] = clamp(b * shade - haz * 20, 0, 255);
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  update(rover, nav, crumbs) {
    if (this.mode === "global" && this.global) return this._drawGlobal();
    const ctx = this.ctx, s = this.size, T = this.terrain.half;
    const half = T / this.zoom;
    const cx = clamp(rover.position.x, -T + half, T - half), cz = clamp(rover.position.z, -T + half, T - half);
    this._lp = { cx, cz, half };
    const B = this.base.width;
    const sx = ((cx - half + T) / (2 * T)) * B, sy = ((cz - half + T) / (2 * T)) * B, sw = (B * half) / T;
    ctx.imageSmoothingEnabled = this.zoom < 8;
    ctx.drawImage(this.base, sx, sy, sw, sw, 0, 0, s, s);
    const P = (x, z) => [((x - cx + half) / (2 * half)) * s, ((z - cz + half) / (2 * half)) * s];

    // scale bar
    const meters = [1, 2, 5, 10, 20, 50, 100, 200].find((m) => (m / (2 * half)) * s > 30) || 200;
    const len = (meters / (2 * half)) * s;
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(6, s - 16, len + 8, 12);
    ctx.fillStyle = "#e9e2d8"; ctx.fillRect(10, s - 8, len, 2);
    ctx.font = "9px monospace"; ctx.fillText(`${meters} m`, 12, s - 10);
    ctx.fillText("N ↑", s - 26, 12);

    // breadcrumbs (driven path)
    if (crumbs.length > 1) {
      ctx.strokeStyle = "rgba(255,225,190,0.7)"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      crumbs.forEach(([x, z], i) => { const [a, b] = P(x, z); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      ctx.stroke();
    }
    if (nav.route) {
      ctx.strokeStyle = "#4ad6ff"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(...P(rover.position.x, rover.position.z));
      for (const [x, z] of nav.route) ctx.lineTo(...P(x, z));
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (nav.goal) {
      const [gx, gy] = P(nav.goal.x, nav.goal.z);
      ctx.strokeStyle = "#4ad6ff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(gx, gy, 5, 0, Math.PI * 2); ctx.stroke();
    }
    const [rx, ry] = P(rover.position.x, rover.position.z);
    const h = rover.heading, f = [Math.sin(h), -Math.cos(h)];
    ctx.fillStyle = "#ffe1c2"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
    ctx.beginPath();
    const k = 7;
    ctx.moveTo(rx + f[0] * k, ry + f[1] * k);
    ctx.lineTo(rx - f[0] * k * 0.6 + f[1] * k * 0.55, ry - f[1] * k * 0.6 - f[0] * k * 0.55);
    ctx.lineTo(rx - f[0] * k * 0.6 - f[1] * k * 0.55, ry - f[1] * k * 0.6 + f[0] * k * 0.55);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  _drawGlobal() {
    const ctx = this.ctx, s = this.size, { img, meta } = this.global;
    const gh = s / 2, gy0 = (s - gh) / 2;
    ctx.fillStyle = "#08060a"; ctx.fillRect(0, 0, s, s);
    ctx.drawImage(img, 0, gy0, s, gh);
    const u = (meta.landingLonDeg - meta.lonMinDeg) / (meta.lonMaxDeg - meta.lonMinDeg);
    const v = (meta.latMaxDeg - meta.landingLatDeg) / (meta.latMaxDeg - meta.latMinDeg);
    const mx = u * s, my = gy0 + v * gh;
    ctx.strokeStyle = "#4ad6ff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, 4 + Math.sin(performance.now() * 0.005) * 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#ffe1c2"; ctx.font = "9px monospace";
    ctx.fillText("杰泽罗 Jezero", mx + 7, my + 3);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("MOLA 全球地形", 6, gy0 + gh + 11);
  }
}

// Side-view schematic of both rocker-bogie sides with joint angles + wheel loads.
export class SuspensionView {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
  }

  draw(rover) {
    const g = this.g, W = this.c.width, H = this.c.height;
    g.clearRect(0, 0, W, H);
    const s = rover.suspension;
    if (!s) return;
    const sides = [["左 L", s.L, rover.loads?.left, 0], ["右 R", s.R, rover.loads?.right, H / 2]];
    for (const [label, sd, loads, y0] of sides) {
      const sc = 34, ox = W / 2, oy = y0 + H / 2 - 12;
      const base = sd.pivot[1];
      const P = ([z, y]) => [ox + z * sc, oy - (y - base + 0.62) * sc];
      g.strokeStyle = "rgba(224,123,83,0.25)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(8, oy + 0.0); g.lineTo(W - 8, oy); g.stroke();
      // links
      g.strokeStyle = "#e9e2d8"; g.lineWidth = 2.5;
      const p = P(sd.pivot), b = P(sd.bogiePivot);
      const wf = P(sd.wheels.front), wm = P(sd.wheels.mid), wr = P(sd.wheels.rear);
      g.beginPath(); g.moveTo(...wf); g.lineTo(...p); g.lineTo(...b); g.stroke();
      g.strokeStyle = "#ffb27a";
      g.beginPath(); g.moveTo(...wm); g.lineTo(...b); g.lineTo(...wr); g.stroke();
      // wheels with load-proportional fill
      const order = [["front", wf], ["mid", wm], ["rear", wr]];
      for (const [n, w] of order) {
        const load = loads ? loads[n] : 1 / 6;
        g.beginPath(); g.arc(w[0], w[1], ROVER.wheel.radius * sc, 0, Math.PI * 2);
        g.fillStyle = `rgba(111,227,155,${clamp(load * 4, 0.1, 0.9)})`;
        g.fill();
        g.strokeStyle = sd.lifted === n ? "#ff6b6b" : "#a89e90"; g.lineWidth = 1.2; g.stroke();
      }
      g.fillStyle = "#e9e2d8";
      g.beginPath(); g.arc(...p, 3, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(...b, 2.5, 0, Math.PI * 2); g.fill();
      g.font = "10px monospace"; g.fillStyle = "#a89e90";
      const rel = s.v.rockerRel[label.includes("L") ? "left" : "right"];
      g.fillText(`${label}  摇臂 ${(rel * 57.3).toFixed(1)}°  转向架 ${(sd.bogieRel * 57.3).toFixed(1)}°`, 8, y0 + 12);
    }
  }
}

export function bar(frac, n = 10) {
  const k = Math.round(clamp(frac, 0, 1) * n);
  return "▮".repeat(k) + "▯".repeat(n - k);
}
