// HUD helpers: minimap (local nav map + global Mars map) and bindings.
// The minimap supports:
//   • local mode  — zoomable top-down nav map, click to set a waypoint
//   • global mode — real MOLA shaded-relief map of all of Mars with the
//                   landing site marked (informational; you can't drive there)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Minimap {
  constructor(canvas, terrain, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.terrain = terrain;
    this.size = canvas.width;
    this.onWaypoint = opts.onWaypoint || null;
    this.onState = opts.onState || null;

    this.mode = "local";
    this.zoom = 1;
    this.minZoom = 1;
    this.maxZoom = 8;
    this.global = null;          // { img, meta }
    this._rover = null;
    this._lp = null;             // last local view params (for click mapping)

    this._renderBase();
    this._wire();
  }

  setGlobal(img, meta) { this.global = { img, meta }; this._emit(); }

  setMode(m) {
    if (m === "global" && !this.global) return;
    this.mode = m;
    this._emit();
  }
  toggleMode() { this.setMode(this.mode === "local" ? "global" : "local"); }

  zoomBy(factor) {
    if (this.mode !== "local") return;
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    this._emit();
  }

  _emit() { this.onState && this.onState({ mode: this.mode, zoom: this.zoom }); }

  _wire() {
    this.canvas.style.cursor = "crosshair";
    this.canvas.addEventListener("wheel", (e) => {
      if (this.mode !== "local") return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
    }, { passive: false });

    this.canvas.addEventListener("click", (e) => {
      if (this.mode !== "local" || !this._lp || !this.onWaypoint) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * this.size;
      const py = ((e.clientY - rect.top) / rect.height) * this.size;
      const { cx, cz, viewHalf } = this._lp;
      const wx = (cx - viewHalf) + (px / this.size) * 2 * viewHalf;
      const wz = (cz - viewHalf) + (py / this.size) * 2 * viewHalf;
      this.onWaypoint(wx, wz);
    });
  }

  // Pre-render a shaded top-down elevation map of the whole driving area once.
  _renderBase() {
    const s = this.size, t = this.terrain;
    this.base = document.createElement("canvas");
    this.base.width = this.base.height = s;
    const bctx = this.base.getContext("2d");
    const img = bctx.createImageData(s, s);
    const half = t.half;
    for (let py = 0; py < s; py++) {
      for (let px = 0; px < s; px++) {
        const wx = (px / s - 0.5) * 2 * half;
        const wz = (py / s - 0.5) * 2 * half;
        const h = t.heightAt(wx, wz);
        const slope = t.slopeAt(wx, wz);
        const shade = clamp((h + 25) / 60, 0, 1);
        const haz = slope > 0.44 ? 0.5 : 0;
        const i = (py * s + px) * 4;
        img.data[i] = 120 + shade * 110 + haz * 80;
        img.data[i + 1] = 60 + shade * 70 - haz * 30;
        img.data[i + 2] = 40 + shade * 40 - haz * 30;
        img.data[i + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
  }

  update(rover, goal) {
    this._rover = rover;
    if (this.mode === "global" && this.global) this._drawGlobal(rover);
    else this._drawLocal(rover, goal);
  }

  _drawLocal(rover, goal) {
    const ctx = this.ctx, s = this.size, half = this.terrain.half;
    const viewHalf = half / this.zoom;
    const cx = clamp(rover.position.x, -(half - viewHalf), half - viewHalf);
    const cz = clamp(rover.position.z, -(half - viewHalf), half - viewHalf);
    this._lp = { cx, cz, viewHalf };

    // zoomed crop of the cached base
    const srcX = ((cx - viewHalf) / half * 0.5 + 0.5) * s;
    const srcY = ((cz - viewHalf) / half * 0.5 + 0.5) * s;
    const srcWH = s / this.zoom;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.base, srcX, srcY, srcWH, srcWH, 0, 0, s, s);

    const toPx = (wx, wz) => [
      ((wx - (cx - viewHalf)) / (2 * viewHalf)) * s,
      ((wz - (cz - viewHalf)) / (2 * viewHalf)) * s,
    ];

    if (goal) {
      const [gx, gy] = toPx(goal.x, goal.z);
      ctx.strokeStyle = "#4ad6ff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(gx, gy, 5, 0, Math.PI * 2); ctx.stroke();
      const [rx, rz] = toPx(rover.position.x, rover.position.z);
      ctx.strokeStyle = "rgba(74,214,255,0.5)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(rx, rz); ctx.lineTo(gx, gy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // rover heading triangle
    const [rx, rz] = toPx(rover.position.x, rover.position.z);
    const h = rover.heading;
    ctx.fillStyle = "#ffe1c2"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
    ctx.beginPath();
    const len = 7;
    ctx.moveTo(rx + Math.sin(h) * len, rz + Math.cos(h) * len);
    ctx.lineTo(rx + Math.sin(h + 2.5) * len * 0.7, rz + Math.cos(h + 2.5) * len * 0.7);
    ctx.lineTo(rx + Math.sin(h - 2.5) * len * 0.7, rz + Math.cos(h - 2.5) * len * 0.7);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  _drawGlobal(rover) {
    const ctx = this.ctx, s = this.size, { img, meta } = this.global;
    const gh = s / 2, gy0 = (s - gh) / 2;
    ctx.fillStyle = "#08060a"; ctx.fillRect(0, 0, s, s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, gy0, s, gh);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.strokeRect(0.5, gy0 + 0.5, s - 1, gh - 1);

    // landing-site marker
    const u = (meta.landingLonDeg - meta.lonMinDeg) / (meta.lonMaxDeg - meta.lonMinDeg);
    const v = (meta.latMaxDeg - meta.landingLatDeg) / (meta.latMaxDeg - meta.latMinDeg);
    const mx = u * s, my = gy0 + v * gh;
    const pulse = 4 + Math.sin(performance.now() * 0.005) * 1.5;
    ctx.strokeStyle = "#4ad6ff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#4ad6ff";
    ctx.beginPath(); ctx.arc(mx, my, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffe1c2"; ctx.font = "9px monospace";
    ctx.fillText("着陆点", mx + 6, my + 3);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("整个火星 · MOLA", 6, gy0 + gh + 11);
  }
}

export function bind(id) {
  return document.getElementById(id);
}
