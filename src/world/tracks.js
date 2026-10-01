import * as THREE from "three";
import { ROVER } from "../core/constants.js";
import { makeTrackTexture } from "./textures.js";

// Wheel tracks: one ring buffer of terrain-conforming quads per wheel, with a
// grouser-imprint normal map repeating once per grouser pitch (2πr / 48).
const SEGMENTS = 1600;
const STEP = 0.08;                                  // m between track samples
const PITCH = (2 * Math.PI * ROVER.wheel.radius) / ROVER.wheel.grousers;

export class WheelTracks {
  constructor(terrain, wheelCount = 6) {
    this.terrain = terrain;
    this.n = wheelCount;
    const quads = SEGMENTS * wheelCount;
    this.pos = new Float32Array(quads * 4 * 3);
    this.uv = new Float32Array(quads * 4 * 2);
    this.nrm = new Float32Array(quads * 4 * 3);
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("uv", new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("normal", new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geo = geo;

    const tex = makeTrackTexture();
    this.material = new THREE.MeshStandardMaterial({
      color: 0x7a5440, roughness: 1, metalness: 0,
      normalMap: tex, normalScale: new THREE.Vector2(1.6, 1.6),
      alphaMap: tex, transparent: true, opacity: 0.42, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    // alphaMap samples G; route our alpha channel instead
    this.material.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace("#include <alphamap_fragment>", "diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).a;");
    };
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.state = Array.from({ length: wheelCount }, () => ({ last: null, v: 0, head: 0 }));
    this.dirty = false;
  }

  // contacts: [{x, z, onRock}] in wheel order; sink: wheel sinkage (m)
  update(contacts, halfWidth = ROVER.wheel.width * 0.47) {
    for (let w = 0; w < contacts.length && w < this.n; w++) {
      const c = contacts[w], st = this.state[w];
      if (!st.last) { st.last = { x: c.x, z: c.z }; continue; }
      const dx = c.x - st.last.x, dz = c.z - st.last.z;
      const d = Math.hypot(dx, dz);
      if (d < STEP) continue;
      if (d > 2 || c.onRock) { st.last = { x: c.x, z: c.z }; continue; }
      const lx = -dz / d, lz = dx / d;
      const q = w * SEGMENTS + st.head;
      st.head = (st.head + 1) % SEGMENTS;
      const pts = [
        [st.last.x + lx * halfWidth, st.last.z + lz * halfWidth, 0, st.v],
        [st.last.x - lx * halfWidth, st.last.z - lz * halfWidth, 1, st.v],
        [c.x + lx * halfWidth, c.z + lz * halfWidth, 0, st.v + d / PITCH],
        [c.x - lx * halfWidth, c.z - lz * halfWidth, 1, st.v + d / PITCH],
      ];
      pts.forEach(([x, z, u, v], k) => {
        const i = q * 4 + k;
        const n = this.terrain.normalAt(x, z, 0.3);
        this.pos.set([x, this.terrain.heightAt(x, z) + 0.006, z], i * 3);
        this.nrm.set([n.x, n.y, n.z], i * 3);
        this.uv.set([u, v], i * 2);
      });
      st.v += d / PITCH;
      st.last = { x: c.x, z: c.z };
      this.dirty = true;
    }
  }

  flush() {
    if (!this.dirty) return;
    for (const k of ["position", "uv", "normal"]) this.geo.attributes[k].needsUpdate = true;
    this.dirty = false;
  }

  reset() {
    this.pos.fill(0);
    for (const s of this.state) { s.last = null; s.head = 0; }
    this.dirty = true;
  }
}
