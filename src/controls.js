import * as THREE from "three";

// Keyboard + pointer input. Records key state and fires callbacks for
// discrete actions (camera switch, autonav toggle, waypoint pick, etc.).
export class InputManager {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.cb = callbacks;
    this.keys = new Set();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    window.addEventListener("keydown", (e) => this._onKey(e, true));
    window.addEventListener("keyup", (e) => this._onKey(e, false));
    // Distinguish a click (set waypoint) from a drag (orbit the camera).
    canvas.addEventListener("pointerdown", (e) => {
      this._down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!this._down) return;
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      const dt = performance.now() - this._down.t;
      this._down = null;
      if (moved < 6 && dt < 400) this._onPointer(e); // a deliberate click
    });
  }

  _onKey(e, down) {
    const k = e.key.toLowerCase();
    if (down) {
      // discrete actions on press
      if (k >= "1" && k <= "5") this.cb.onCamera?.(parseInt(k, 10));
      if (k === "g") this.cb.onToggleAutoNav?.();
      if (k === "m") this.cb.onToggleMast?.();
      if (k === "h") this.cb.onToggleHud?.();
      if (k === "r") this.cb.onRecenter?.();
      if (k === "p") this.cb.onDrill?.();
      if (k === "c") this.cb.onPanorama?.();
      if (k === "n") this.cb.onToggleMap?.();
      this.keys.add(k);
    } else {
      this.keys.delete(k);
    }
  }

  _onPointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.cb.onPick?.(this.pointer.clone());
  }

  // Manual driving command from WASD. Returns {throttle:-1..1, steer:-1..1}
  manualCommand() {
    let throttle = 0, steer = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) throttle += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) throttle -= 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) steer += 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) steer -= 1;
    return { throttle, steer };
  }
}
