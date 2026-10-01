import * as THREE from "three";

function spriteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Two particle systems:
//   ambient — suspended dust motes advected by the MEDA wind around the camera
//   plume   — drill tailings / abrasion dust emitted at the bit
export class DustParticles {
  constructor() {
    this.group = new THREE.Group();
    const tex = spriteTexture();

    const N = 1400;
    this.ambientPos = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) this.ambientPos[i] = (Math.random() - 0.5) * 40;
    const ag = new THREE.BufferGeometry();
    ag.setAttribute("position", new THREE.BufferAttribute(this.ambientPos, 3));
    this.ambient = new THREE.Points(ag, new THREE.PointsMaterial({
      color: 0xd9a77c, size: 0.035, map: tex, transparent: true, opacity: 0.35, depthWrite: false,
    }));
    this.ambient.frustumCulled = false;
    this.group.add(this.ambient);

    const M = 500;
    this.plumePos = new Float32Array(M * 3);
    this.plumeVel = new Float32Array(M * 3);
    this.plumeLife = new Float32Array(M);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(this.plumePos, 3));
    this.plume = new THREE.Points(pg, new THREE.PointsMaterial({
      color: 0xb98a63, size: 0.06, map: tex, transparent: true, opacity: 0.7, depthWrite: false,
    }));
    this.plume.frustumCulled = false;
    this.group.add(this.plume);
    this._next = 0;
  }

  emit(p, count = 6) {
    for (let k = 0; k < count; k++) {
      const i = this._next;
      this._next = (this._next + 1) % this.plumeLife.length;
      this.plumePos.set([p.x, p.y + 0.02, p.z], i * 3);
      const a = Math.random() * Math.PI * 2, s = 0.15 + Math.random() * 0.35;
      this.plumeVel.set([Math.cos(a) * s, 0.2 + Math.random() * 0.4, Math.sin(a) * s], i * 3);
      this.plumeLife[i] = 1.5 + Math.random();
    }
  }

  // dt is real time (visual effect); wind in m/s (world x/z)
  update(dt, camPos, wind, gravity = 3.721) {
    const a = this.ambientPos;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += wind.x * dt * 0.25; a[i + 2] += wind.z * dt * 0.25;
      a[i + 1] += Math.sin(i + performance.now() * 0.0007) * dt * 0.05;
      // keep motes in a box around the camera
      for (let k = 0; k < 3; k++) {
        const c = k === 0 ? camPos.x : k === 1 ? camPos.y : camPos.z;
        const span = k === 1 ? 12 : 30;
        if (a[i + k] - c > span) a[i + k] -= 2 * span;
        else if (a[i + k] - c < -span) a[i + k] += 2 * span;
      }
    }
    this.ambient.geometry.attributes.position.needsUpdate = true;

    const p = this.plumePos, v = this.plumeVel, L = this.plumeLife;
    for (let i = 0; i < L.length; i++) {
      if (L[i] <= 0) { p[i * 3 + 1] = -1e4; continue; }
      L[i] -= dt;
      v[i * 3 + 1] -= gravity * 0.15 * dt;
      v[i * 3] += wind.x * 0.2 * dt; v[i * 3 + 2] += wind.z * 0.2 * dt;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
    }
    this.plume.geometry.attributes.position.needsUpdate = true;
  }
}
