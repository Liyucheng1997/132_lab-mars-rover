import * as THREE from "three";
import { Noise } from "./noise.js";

// Jezero-Crater-inspired Martian terrain.
// The height field is defined ANALYTICALLY so the rover can query the exact
// same surface the mesh is built from (heightAt / normalAt).
export class MarsTerrain {
  constructor({ size = 600, segments = 320, seed = 2021, dem = null } = {}) {
    this.size = size;            // metres across
    this.segments = segments;    // mesh resolution
    this.half = size / 2;
    this.noise = new Noise(seed);
    this.noiseB = new Noise(seed + 99);
    this.group = new THREE.Group();
    this.craterCenter = new THREE.Vector2(-40, 60);
    this.craterRadius = 230;     // Jezero is ~45km; scaled here

    // Optional real Digital Elevation Model (NASA HiRISE/MOLA). When present the
    // surface is sampled from it; otherwise we fall back to procedural Jezero.
    this.dem = dem;              // { sample(u,v)->[0,1], range (m), vScale }
    this.demRange = dem ? (dem.range || 120) : 0;
    this.demVScale = dem ? (dem.vScale || 1) : 1;
    this.source = dem ? (dem.label || "DEM") : "Procedural Jezero";

    this.obstacles = [];         // { x, z, r } rocks the rover must avoid
    this._grid = new Map();      // spatial hash for obstacle lookup
    this._cell = 24;             // metres per grid cell

    this._build();
  }

  // ---- Surface height (metres) — dispatches DEM vs procedural ----
  heightAt(x, z) {
    if (this.dem) return this._demHeight(x, z);
    return this._proceduralHeight(x, z);
  }

  _demHeight(x, z) {
    // world → normalised texture coords
    let u = x / this.size + 0.5;
    let v = z / this.size + 0.5;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const s = this.dem.sample(u, v);            // 0..1
    let h = (s - 0.5) * this.demRange * this.demVScale;
    // sub-pixel roughness so wheels have texture between DEM posts
    h += this.noiseB.fbm(x * 0.12, z * 0.12, 3) * 0.35;
    return h;
  }

  _proceduralHeight(x, z) {
    const n = this.noise;
    // Base rolling regolith
    let h = n.fbm(x * 0.0045, z * 0.0045, 6) * 14;
    // Medium dunes / ripples (aeolian bedforms)
    h += n.fbm(x * 0.02 + 100, z * 0.02, 4) * 3.2;
    // Fine surface roughness
    h += this.noiseB.fbm(x * 0.09, z * 0.09, 3) * 0.7;

    // Jezero crater rim: raised ring around the center
    const dx = x - this.craterCenter.x;
    const dz = z - this.craterCenter.y;
    const r = Math.sqrt(dx * dx + dz * dz);
    const rim = this.craterRadius;
    // Bowl floor inside, raised rim at the edge
    const bowl = -Math.exp(-Math.pow((r) / (rim * 0.85), 2)) * 22;
    const ring = Math.exp(-Math.pow((r - rim) / 26, 2)) * 30;
    const ridge = n.ridged(x * 0.01, z * 0.01, 4) * (ring > 1 ? 8 : 2);
    h += bowl + ring + ridge;

    // The river delta (NW of crater) — a fan of sediment Perseverance studies
    const ddx = x - (this.craterCenter.x - 120);
    const ddz = z - (this.craterCenter.y - 70);
    const dr = Math.sqrt(ddx * ddx + ddz * ddz);
    h += Math.exp(-Math.pow(dr / 70, 2)) * 9 * (0.6 + 0.4 * n.fbm(x * 0.05, z * 0.05, 3));

    return h;
  }

  normalAt(x, z) {
    const e = 0.6;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    const n = new THREE.Vector3(hL - hR, 2 * e, hD - hU);
    return n.normalize();
  }

  slopeAt(x, z) {
    const n = this.normalAt(x, z);
    return Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)); // radians from vertical
  }

  inBounds(x, z) {
    return Math.abs(x) < this.half - 6 && Math.abs(z) < this.half - 6;
  }

  _build() {
    const { size, segments } = this;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cLow = new THREE.Color(0x7a3b22);   // shadowed basalt
    const cMid = new THREE.Color(0xb35a33);   // rusty regolith
    const cHigh = new THREE.Color(0xd98c5f);  // dusty highlights
    const cDust = new THREE.Color(0xe0b48f);  // bright dust on peaks
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);

      // Color by elevation + a little noise mottling
      const slope = this.slopeAt(x, z);
      const mott = this.noiseB.fbm(x * 0.15, z * 0.15, 3) * 0.5 + 0.5;
      const t = THREE.MathUtils.clamp((h + 12) / 40, 0, 1);
      if (t < 0.4) tmp.copy(cLow).lerp(cMid, t / 0.4);
      else if (t < 0.75) tmp.copy(cMid).lerp(cHigh, (t - 0.4) / 0.35);
      else tmp.copy(cHigh).lerp(cDust, (t - 0.75) / 0.25);
      // Steep faces are darker (less dust accumulates)
      tmp.multiplyScalar(0.78 + 0.22 * mott);
      tmp.multiplyScalar(1 - Math.min(slope / 1.2, 0.45));
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0,
      flatShading: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.group.add(this.mesh);

    this._scatterRocks();
    this._buildSky();
  }

  _scatterRocks() {
    const rockGeoA = new THREE.DodecahedronGeometry(1, 0);
    const rockGeoB = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b3a26, roughness: 1, metalness: 0 });
    const count = 1400;
    const mesh = new THREE.InstancedMesh(rockGeoA, mat, count);
    const mesh2 = new THREE.InstancedMesh(rockGeoB, mat.clone(), count);
    mesh2.material.color.set(0x824a30);
    const dummy = new THREE.Object3D();
    const rand = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();

    let i1 = 0, i2 = 0;
    for (let i = 0; i < count * 2; i++) {
      const x = (rand() - 0.5) * (this.size - 20);
      const z = (rand() - 0.5) * (this.size - 20);
      const y = this.heightAt(x, z);
      const scale = 0.18 + Math.pow(rand(), 3) * 2.6;
      dummy.position.set(x, y + scale * 0.3, z);
      dummy.rotation.set(rand() * 6, rand() * 6, rand() * 6);
      dummy.scale.set(scale, scale * (0.6 + rand() * 0.5), scale);
      dummy.updateMatrix();
      if (i % 2 === 0 && i1 < count) mesh.setMatrixAt(i1++, dummy.matrix);
      else if (i2 < count) mesh2.setMatrixAt(i2++, dummy.matrix);

      // Boulders large enough to block the rover become physical obstacles
      if (scale > 0.95) this.obstacles.push({ x, z, r: scale * 0.62 });
    }
    mesh.castShadow = mesh2.castShadow = true;
    mesh.receiveShadow = mesh2.receiveShadow = true;
    this.group.add(mesh, mesh2);
    this._buildObstacleGrid();
  }

  // ---- Obstacle spatial hash + collision queries ----
  _buildObstacleGrid() {
    this._grid.clear();
    for (const o of this.obstacles) {
      const key = this._key(o.x, o.z);
      if (!this._grid.has(key)) this._grid.set(key, []);
      this._grid.get(key).push(o);
    }
  }

  _key(x, z) {
    return `${Math.floor(x / this._cell)},${Math.floor(z / this._cell)}`;
  }

  // Obstacles in the 3×3 cell neighbourhood of (x,z)
  obstaclesNear(x, z) {
    const cx = Math.floor(x / this._cell);
    const cz = Math.floor(z / this._cell);
    const out = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const arr = this._grid.get(`${cx + i},${cz + j}`);
        if (arr) out.push(...arr);
      }
    return out;
  }

  // Push (x,z) out of any overlapping boulder. Returns corrected {x, z, hit}.
  resolveCollision(x, z, radius) {
    let hit = false;
    for (const o of this.obstaclesNear(x, z)) {
      const dx = x - o.x, dz = z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + radius;
      if (d < min && d > 1e-4) {
        const push = (min - d);
        x += (dx / d) * push;
        z += (dz / d) * push;
        hit = true;
      }
    }
    return { x, z, hit };
  }

  // True if a boulder blocks a point (used by the planner for hazard arcs)
  blocked(x, z, clearance) {
    for (const o of this.obstaclesNear(x, z)) {
      if (Math.hypot(x - o.x, z - o.z) < o.r + clearance) return true;
    }
    return false;
  }

  _buildSky() {
    // Butterscotch Martian sky (dust scattering reddens it)
    const geo = new THREE.SphereGeometry(this.size * 1.4, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x6a4a3a) },
        bottom: { value: new THREE.Color(0xd9a877) },
      },
      vertexShader: `
        varying vec3 vP;
        void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        varying vec3 vP;
        uniform vec3 top; uniform vec3 bottom;
        void main(){
          float h = clamp(normalize(vP).y * 0.5 + 0.5, 0.0, 1.0);
          vec3 c = mix(bottom, top, pow(h, 0.8));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.group.add(this.sky);
  }
}
