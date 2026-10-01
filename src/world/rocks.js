import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { Noise } from "../core/noise.js";
import { clamp, mulberry32 } from "../core/math.js";
import { generateChunkRocks, rockVisibleHeight, STRIDE } from "./rockGen.js";

// Rock field: procedural rock geometry library + deterministic per-chunk
// populations (Golombek model) + LOD'd instanced rendering + physics queries
// (wheel contact surface, hazard detection, body collision).
const CHUNK = 32;          // rock chunk size (m)
const GRID = 2;            // physics lookup cell (m)
const N_PROTO = 10;
const SEED = 4242;

// --- procedural rock shapes ---------------------------------------------------
function makeRockGeometry(seed, detail, kind) {
  const n = new Noise(seed);
  const rnd = mulberry32(seed * 31 + 7);
  let geo = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo);
  const cuts = [];
  const nCuts = kind === "blocky" ? 5 + Math.floor(rnd() * 3) : kind === "slab" ? 3 : 1;
  for (let i = 0; i < nCuts; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.7, rnd() * 2 - 1).normalize();
    cuts.push({ n: v, d: 0.55 + rnd() * 0.3 });
  }
  const p = new THREE.Vector3();
  const pos = geo.attributes.position;
  const ox = rnd() * 100, oy = rnd() * 100, oz = rnd() * 100;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let r = 1 + 0.28 * n.fbm3(p.x * 1.3 + ox, p.y * 1.3 + oy, p.z * 1.3 + oz, 4);
    r += 0.06 * n.fbm3(p.x * 5 + oz, p.y * 5 + ox, p.z * 5 + oy, 3);
    if (kind === "slab") r += 0.035 * Math.sin(p.y * 26 + 3 * n.noise3(p.x * 2, p.y * 2, p.z * 2));
    if (kind === "pitted") r -= 0.05 * Math.max(0, n.noise3(p.x * 7 + 9, p.y * 7, p.z * 7) - 0.15) * 4;
    p.multiplyScalar(r);
    for (const c of cuts) {
      const d = p.dot(c.n);
      if (d > c.d) p.addScaledVector(c.n, -(d - c.d) * 0.92);
    }
    if (p.y < -0.45) p.y = -0.45 + (p.y + 0.45) * 0.25; // settled base
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  // normalise to the unit bounding ellipsoid the physics model assumes
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = 2 / (bb.max.x - bb.min.x), sy = 2 / (bb.max.y - bb.min.y), sz = 2 / (bb.max.z - bb.min.z);
  const cx = (bb.max.x + bb.min.x) / 2, cy = (bb.max.y + bb.min.y) / 2, cz = (bb.max.z + bb.min.z) / 2;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, (pos.getX(i) - cx) * sx, (pos.getY(i) - cy) * sy, (pos.getZ(i) - cz) * sz);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function createRockMaterial(detailTex) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  const uniforms = {
    uDet: { value: detailTex },
    uDust: { value: new THREE.Color(0xb47a52) },
    uDustAmt: { value: 0.75 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRPos;\nvarying vec3 vRNrm;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvRPos = position * 1.7;\n#ifdef USE_INSTANCING\nvRNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);\n#else\nvRNrm = normalize(mat3(modelMatrix) * objectNormal);\n#endif"
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vRPos;
varying vec3 vRNrm;
uniform sampler2D uDet;
uniform vec3 uDust;
uniform float uDustAmt;
vec4 triDet(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture2D(uDet, p.yz) * w.x + texture2D(uDet, p.xz) * w.y + texture2D(uDet, p.xy) * w.z;
}`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec4 rdet = triDet(vRPos, normalize(vRNrm));
diffuseColor.rgb *= 0.65 + 0.7 * rdet.a;
float dustCover = smoothstep(0.25, 0.85, normalize(vRNrm).y) * uDustAmt;
diffuseColor.rgb = mix(diffuseColor.rgb, uDust * (0.85 + 0.3 * rdet.a), dustCover);`
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  vec3 dn = rdet.rgb * 2.0 - 1.0;
  vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  nW = normalize(nW + (dn.x * vec3(1.0, 0.0, 0.0) + dn.y * vec3(0.0, 0.0, 1.0)) * 0.55 * (1.0 - dustCover * 0.6));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`
      );
  };
  mat.customProgramCacheKey = () => "mars-rock-v2";
  return mat;
}

const PALETTE = [0x4b3a31, 0x6b4433, 0x5d4f46, 0x7d5a45, 0x3e342f, 0x84624c].map((h) => new THREE.Color(h));

export class RockField {
  constructor(terrain) {
    this.terrain = terrain;
    terrain.rocks = this;
    this.group = new THREE.Group();
    this.cache = new Map();
    this.material = createRockMaterial(terrain.detail.bedrock);

    const kinds = ["blocky", "blocky", "rounded", "slab", "pitted", "blocky", "rounded", "slab", "blocky", "pitted"];
    this.protos = kinds.map((k, i) => ({
      lo: makeRockGeometry(101 + i * 13, 1, k),
      hi: makeRockGeometry(101 + i * 13, 3, k),
    }));
    this.meshes = { lo: [], hi: [] };
    this._focusKey = null;
  }

  // ---- population ----
  _kAt(x, z) {
    const m = this.terrain.materialAt(x, z);
    const pad = Math.hypot(x, z) < 8 ? 0.2 : 1; // the start pad is mostly clear
    return clamp((0.035 + 0.19 * m.ejecta + 0.04 * m.bedrock - 0.03 * m.sand) * pad, 0.004, 0.22);
  }

  chunk(ci, cj) {
    const key = ci * 4096 + cj;
    let c = this.cache.get(key);
    if (c) return c;
    const t = this.terrain;
    const recs = generateChunkRocks({
      ci, cj, x0: ci * CHUNK, z0: cj * CHUNK, size: CHUNK, seed: SEED,
      kAt: (x, z) => (t.inNear(x, z) ? this._kAt(x, z) : 0),
      heightAt: (x, z) => t.heightAt(x, z),
      Dmin: 0.1, protos: N_PROTO,
    });
    // fine lookup grid for physics
    const gN = CHUNK / GRID;
    const grid = Array.from({ length: gN * gN }, () => []);
    for (let i = 0; i < recs.length; i += STRIDE) {
      const x = recs[i], z = recs[i + 2], R = Math.max(recs[i + 3], recs[i + 5]);
      const a0 = Math.floor((x - R - ci * CHUNK) / GRID), a1 = Math.floor((x + R - ci * CHUNK) / GRID);
      const b0 = Math.floor((z - R - cj * CHUNK) / GRID), b1 = Math.floor((z + R - cj * CHUNK) / GRID);
      for (let a = Math.max(0, a0); a <= Math.min(gN - 1, a1); a++)
        for (let b = Math.max(0, b0); b <= Math.min(gN - 1, b1); b++) grid[b * gN + a].push(i);
    }
    const big = [];
    for (let i = 0; i < recs.length; i += STRIDE) if (recs[i + 9] >= 0.3) big.push(i);
    c = { ci, cj, recs, grid, big, count: recs.length / STRIDE };
    this.cache.set(key, c);
    return c;
  }

  _cellRocks(x, z) {
    const ci = Math.floor(x / CHUNK), cj = Math.floor(z / CHUNK);
    const c = this.chunk(ci, cj);
    const a = Math.floor((x - ci * CHUNK) / GRID), b = Math.floor((z - cj * CHUNK) / GRID);
    return { c, list: c.grid[b * (CHUNK / GRID) + a] };
  }

  // Top surface of any rock covering (x, z), or -Infinity.
  topAt(x, z) {
    const { c, list } = this._cellRocks(x, z);
    let top = -Infinity;
    const r = c.recs;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const dx = x - r[i], dz = z - r[i + 2];
      const cs = Math.cos(-r[i + 6]), sn = Math.sin(-r[i + 6]);
      const u = (dx * cs - dz * sn) / r[i + 3], v = (dx * sn + dz * cs) / r[i + 5];
      const t = u * u + v * v;
      if (t < 1) {
        const y = r[i + 1] + r[i + 4] * 0.9 * Math.sqrt(1 - t);
        if (y > top) top = y;
      }
    }
    return top;
  }

  // Rocks taller than `minHeight` within `radius` of (x, z).
  hazardsNear(x, z, radius, minHeight) {
    const out = [];
    const c0 = Math.floor((x - radius) / CHUNK), c1 = Math.floor((x + radius) / CHUNK);
    const d0 = Math.floor((z - radius) / CHUNK), d1 = Math.floor((z + radius) / CHUNK);
    for (let ci = c0; ci <= c1; ci++)
      for (let cj = d0; cj <= d1; cj++) {
        const c = this.chunk(ci, cj), r = c.recs;
        const list = minHeight >= 0.3 * 0.7 ? c.big : null;
        const n = list ? list.length : r.length / STRIDE;
        for (let k = 0; k < n; k++) {
          const i = list ? list[k] : k * STRIDE;
          if (r[i + 9] < minHeight) continue; // visible height ≤ 0.7 D
          const R = Math.max(r[i + 3], r[i + 5]);
          if (Math.hypot(r[i] - x, r[i + 2] - z) > radius + R) continue;
          const hv = rockVisibleHeight(r, i, this.terrain.heightAt(r[i], r[i + 2]));
          if (hv >= minHeight) out.push({ x: r[i], z: r[i + 2], r: R, h: hv });
        }
      }
    return out;
  }

  // ---- rendering ----
  _ensureMeshes(kind, counts) {
    const list = this.meshes[kind];
    for (let p = 0; p < N_PROTO; p++) {
      const need = counts[p];
      if (!list[p] || list[p].instanceMatrix.count < need) {
        if (list[p]) { this.group.remove(list[p]); list[p].dispose(); }
        const cap = Math.max(64, Math.ceil(need * 1.5));
        const m = new THREE.InstancedMesh(this.protos[p][kind], this.material, cap);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        m.castShadow = kind === "hi";
        m.receiveShadow = true;
        m.frustumCulled = false;
        list[p] = m;
        this.group.add(m);
      }
      list[p].count = need;
    }
  }

  update(focus, force = false) {
    const fci = Math.floor(focus.x / CHUNK), fcj = Math.floor(focus.z / CHUNK);
    const key = fci + ":" + fcj;
    if (!force && key === this._focusKey) return;
    this._focusKey = key;

    const sel = { lo: [], hi: [] };
    const R = 10;
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) {
        const ring = Math.max(Math.abs(di), Math.abs(dj));
        const dMin = ring <= 1 ? 0.1 : ring === 2 ? 0.28 : ring <= 4 ? 0.65 : ring <= 7 ? 1.3 : 2.0;
        const ci = fci + di, cj = fcj + dj;
        if (!this.terrain.inNear(ci * CHUNK + 1, cj * CHUNK + 1)) continue;
        const c = this.chunk(ci, cj), r = c.recs;
        for (let i = 0; i < r.length; i += STRIDE) {
          const D = r[i + 9];
          if (D < dMin) continue;
          (D >= 0.32 ? sel.hi : sel.lo).push(r, i);
        }
      }

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
    for (const kind of ["lo", "hi"]) {
      const items = sel[kind];
      const counts = new Array(N_PROTO).fill(0);
      for (let k = 0; k < items.length; k += 2) counts[items[k][items[k + 1] + 10]]++;
      this._ensureMeshes(kind, counts);
      const fill = new Array(N_PROTO).fill(0);
      for (let k = 0; k < items.length; k += 2) {
        const r = items[k], i = items[k + 1];
        const p = r[i + 10];
        e.set(r[i + 7], r[i + 6], r[i + 8]);
        q.setFromEuler(e);
        pos.set(r[i], r[i + 1], r[i + 2]);
        scl.set(r[i + 3], r[i + 4], r[i + 5]);
        m4.compose(pos, q, scl);
        const mesh = this.meshes[kind][p];
        mesh.setMatrixAt(fill[p], m4);
        const t = r[i + 11];
        col.copy(PALETTE[Math.floor(t * PALETTE.length) % PALETTE.length]).multiplyScalar(0.85 + 0.3 * ((t * 7.3) % 1));
        mesh.setColorAt(fill[p], col);
        fill[p]++;
      }
      for (const m of this.meshes[kind]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    this.stats = { lo: sel.lo.length / 2, hi: sel.hi.length / 2 };
  }
}
