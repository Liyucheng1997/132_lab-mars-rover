// Keyboard + pointer input. Continuous keys are polled (driving, mast
// pointing); discrete keys fire named actions through `onAction`.
const ACTIONS = {
  g: "autonav", x: "clearGoal", p: "drill", c: "panorama", m: "mast",
  h: "hud", r: "recenter", n: "map", v: "arcs", t: "skipToMorning",
  l: "lightTime", " ": "allStop", "[": "warpDown", "]": "warpUp",
  f1: "help", "?": "help", "/": "help", "=": "zoomIn", "+": "zoomIn", "-": "zoomOut",
  b: "clearFault",
};

export class InputManager {
  constructor(canvas, { onAction, onCamera, onPick, onChaseOrbit }) {
    this.canvas = canvas;
    this.keys = new Set();
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "f1") e.preventDefault();
      if (!e.repeat) {
        if (k >= "1" && k <= "6") onCamera?.(parseInt(k, 10));
        if (ACTIONS[k]) onAction?.(ACTIONS[k]);
      }
      this.keys.add(k);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());

    // click = waypoint, drag = camera (orbit view) / chase-yaw (chase view)
    let down = null;
    canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), lx: e.clientX }; });
    canvas.addEventListener("pointermove", (e) => {
      if (!down || !(e.buttons & 1)) return;
      onChaseOrbit?.((e.clientX - down.lx) * -0.006, 0);
      down.lx = e.clientX;
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 400;
      down = null;
      if (moved < 6 && quick) {
        const r = canvas.getBoundingClientRect();
        onPick?.({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 });
      }
    });
    canvas.addEventListener("wheel", (e) => onChaseOrbit?.(0, e.deltaY > 0 ? 1.1 : 0.9, e.deltaY), { passive: true });
  }

  has(...ks) { return ks.some((k) => this.keys.has(k)); }

  // Operator drive command: {speed −1…1, curvature (1/m), spot −1/0/1}
  driveCommand(maxCurv) {
    let speed = 0, steer = 0, spot = 0;
    if (this.has("w", "arrowup")) speed += 1;
    if (this.has("s", "arrowdown")) speed -= 1;
    if (this.has("a", "arrowleft")) steer += 1;
    if (this.has("d", "arrowright")) steer -= 1;
    if (this.has("q")) spot -= 1;
    if (this.has("e")) spot += 1;
    if (!speed && steer && !spot) spot = -steer; // steer key alone = turn in place
    return { speed, curvature: steer * maxCurv, spot: speed ? 0 : spot };
  }

  mastCommand() {
    return {
      pan: (this.has("j") ? 1 : 0) - (this.has("l") ? 1 : 0),
      tilt: (this.has("i") ? 1 : 0) - (this.has("k") ? 1 : 0),
    };
  }
}
