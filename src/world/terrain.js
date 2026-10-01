import * as THREE from "three";
import { clamp } from "../core/math.js";
import { curvatureDrop } from "./geo.js";
import { createTerrainMaterial } from "./terrainMaterial.js";
import { makeTerrainDetail } from "./textures.js";

// Terrain = high-resolution synthesised near field (1 km², 0.5 m posts,
// chunked with distance LOD + skirts) embedded in a true-scale MOLA far field
// (±60 km, Jezero rim and delta on the horizon, planetary curvature applied).
const CHUNK = 64;              // metres per chunk
const LOD_STEPS = [1, 2, 4, 8]; // post stride per LOD level
const LOD_DIST = [110, 240, 480]; // switch distances (m)
const FAR_EXTENT = 60000;      // far-field half extent (m)

export class Terrain {
  constructor(near, dem) {
    this.near = near;           // { n, res, size, heights, matN, mat, craters }
    this.dem = dem;             // DemGrid (far field + outside queries)
    this.half = near.size / 2;
    this.group = new THREE.Group();
    this.rocks = null;          // RockField attaches itself

    this.matTex = new THREE.DataTexture(near.mat, near.matN, near.matN, THREE.RGBAFormat);
    this.matTex.magFilter = THREE.LinearFilter;
    this.matTex.minFilter = THREE.LinearFilter;
    this.matTex.needsUpdate = true;

    this.detail = makeTerrainDetail();
    this.material = createTerrainMaterial({ matMap: this.matTex, nearHalf: this.half, detail: this.detail });
    this.material.side = THREE.DoubleSide; // skirts may face away from the camera

    this.chunksPerSide = near.size / CHUNK;
    this.chunks = [];
    for (let j = 0; j < this.chunksPerSide; j++)
      for (let i = 0; i < this.chunksPerSide; i++)
        this.chunks.push({ i, j, lod: -1, want: 3, mesh: null });
    this._queue = [];

    this._buildFarField();
  }

  // ---------------- height / surface queries ----------------
  _post(i, j) {
    const n = this.near.n;
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    return this.near.heights[j * n + i];
  }

  inNear(x, z) { return Math.abs(x) < this.half && Math.abs(z) < this.half; }

  // Bare-ground elevation (m, site frame).
  heightAt(x, z) {
    if (!this.inNear(x, z)) return this.dem.localHeight(x, z) - curvatureDrop(Math.hypot(x, z));
    const r = this.near.res;
    const fx = (x + this.half) / r, fz = (z + this.half) / r;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = this._post(i, j), b = this._post(i + 1, j);
    const c = this._post(i, j + 1), d = this._post(i + 1, j + 1);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  // Ground including rock tops — what a wheel actually rests on.
  contactHeight(x, z) {
    const h = this.heightAt(x, z);
    return this.rocks ? Math.max(h, this.rocks.topAt(x, z, h)) : h;
  }

  normalAt(x, z, e = 0.5) {
    const n = new THREE.Vector3(
      this.heightAt(x - e, z) - this.heightAt(x + e, z),
      2 * e,
      this.heightAt(x, z - e) - this.heightAt(x, z + e)
    );
    return n.normalize();
  }

  slopeAt(x, z, e = 0.5) {
    return Math.acos(clamp(this.normalAt(x, z, e).y, -1, 1));
  }

  // Material fractions at a point: {bedrock, sand, albedo, ejecta} in 0..1
  materialAt(x, z) {
    if (!this.inNear(x, z)) return { bedrock: 0, sand: 0, albedo: 0.5, ejecta: 0 };
    const m = this.near.matN;
    const i = clamp(Math.floor((x + this.half) / this.near.matRes), 0, m - 1);
    const j = clamp(Math.floor((z + this.half) / this.near.matRes), 0, m - 1);
    const t = (j * m + i) * 4, d = this.near.mat;
    return { bedrock: d[t] / 255, sand: d[t + 1] / 255, albedo: d[t + 2] / 255, ejecta: d[t + 3] / 255 };
  }

  soilAt(x, z) {
    const m = this.materialAt(x, z);
    if (m.bedrock > 0.55 || this.slopeAt(x, z) > 0.35) return "bedrock";
    if (m.sand > 0.5) return "sand";
    return "regolith";
  }

  inBounds(x, z, margin = 20) {
    return Math.abs(x) < this.half - margin && Math.abs(z) < this.half - margin;
  }

  // ---------------- near-field chunk meshes ----------------
  _buildChunk(c, lod) {
    const step = LOD_STEPS[lod];
    const postsPerChunk = CHUNK / this.near.res;
    const seg = postsPerChunk / step;
    const vSide = seg + 1;
    const r = this.near.res;
    const i0 = c.i * postsPerChunk, j0 = c.j * postsPerChunk;
    const skirtDepth = 0.6 * step + 0.4;

    const nMain = vSide * vSide, nSkirt = seg * 4;
    const pos = new Float32Array((nMain + nSkirt) * 3);
    const nor = new Float32Array((nMain + nSkirt) * 3);
    const idx = [];
    const writeV = (k, gi, gj, drop) => {
      const h = this._post(gi, gj);
      pos[k * 3] = -this.half + gi * r;
      pos[k * 3 + 1] = h - drop;
      pos[k * 3 + 2] = -this.half + gj * r;
      const s = step;
      const nx = this._post(gi - s, gj) - this._post(gi + s, gj);
      const nz = this._post(gi, gj - s) - this._post(gi, gj + s);
      const ny = 2 * s * r;
      const l = Math.hypot(nx, ny, nz);
      nor[k * 3] = nx / l; nor[k * 3 + 1] = ny / l; nor[k * 3 + 2] = nz / l;
    };
    for (let b = 0; b < vSide; b++)
      for (let a = 0; a < vSide; a++) writeV(b * vSide + a, i0 + a * step, j0 + b * step, 0);
    for (let b = 0; b < seg; b++)
      for (let a = 0; a < seg; a++) {
        const p = b * vSide + a;
        idx.push(p, p + vSide, p + 1, p + 1, p + vSide, p + vSide + 1);
      }
    // skirts: walk the border, drop a duplicate ring, stitch quads outward-facing
    const ring = [];
    for (let a = 0; a < seg; a++) ring.push([a, 0]);
    for (let b = 0; b < seg; b++) ring.push([seg, b]);
    for (let a = seg; a > 0; a--) ring.push([a, seg]);
    for (let b = seg; b > 0; b--) ring.push([0, b]);
    ring.forEach(([a, b], k) => writeV(nMain + k, i0 + a * step, j0 + b * step, skirtDepth));
    for (let k = 0; k < ring.length; k++) {
      const k2 = (k + 1) % ring.length;
      const top0 = ring[k][1] * vSide + ring[k][0], top1 = ring[k2][1] * vSide + ring[k2][0];
      const bot0 = nMain + k, bot1 = nMain + k2;
      idx.push(top0, top1, bot0, top1, bot1, bot0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    if (c.mesh) { c.mesh.geometry.dispose(); this.group.remove(c.mesh); }
    c.mesh = new THREE.Mesh(geo, this.material);
    c.mesh.receiveShadow = true;
    c.lod = lod;
    this.group.add(c.mesh);
  }

  // Build every chunk at a coarse LOD so the world is complete on frame one.
  buildInitial(focus) {
    for (const c of this.chunks) {
      c.want = this._lodFor(c, focus);
      this._buildChunk(c, Math.max(c.want, 1));
    }
    this.update(focus, 1e9);
  }

  _lodFor(c, p) {
    const cx = -this.half + (c.i + 0.5) * CHUNK, cz = -this.half + (c.j + 0.5) * CHUNK;
    const d = Math.max(0, Math.hypot(cx - p.x, cz - p.z) - CHUNK * 0.7);
    return d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : d < LOD_DIST[2] ? 2 : 3;
  }

  // Re-tessellate chunks whose wanted LOD changed, within a time budget.
  update(focus, budgetMs = 4) {
    for (const c of this.chunks) c.want = this._lodFor(c, focus);
    const t0 = performance.now();
    const pending = this.chunks
      .filter((c) => c.want !== c.lod)
      .sort((a, b) => a.want - b.want);
    for (const c of pending) {
      this._buildChunk(c, c.want);
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  // ---------------- far field ----------------
  _buildFarField() {
    const N = 360, k = 5.7, S = FAR_EXTENT;
    const map = (t) => Math.sign(t) * S * (Math.exp(k * Math.abs(t)) - 1) / (Math.exp(k) - 1);
    const pos = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      const z = map(-1 + (2 * j) / (N - 1));
      for (let i = 0; i < N; i++) {
        const x = map(-1 + (2 * i) / (N - 1));
        let y = this.dem.localHeight(x, z) - curvatureDrop(Math.hypot(x, z));
        // sink under the near field; its skirts cover the seam
        if (Math.abs(x) < this.half - 2 && Math.abs(z) < this.half - 2) y -= 3;
        const p = (j * N + i) * 3;
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
      }
    }
    const idx = [];
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        const p = j * N + i;
        idx.push(p, p + N, p + 1, p + 1, p + N, p + N + 1);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.far = new THREE.Mesh(geo, this.material);
    this.far.receiveShadow = false;
    this.far.frustumCulled = false;
    this.group.add(this.far);
  }

  // Ray-march pick against the analytic surface (cheap, exact to 5 cm).
  raycast(origin, dir, maxDist = 3000) {
    let t = 0.5, prevT = 0;
    let prevAbove = origin.y - this.heightAt(origin.x, origin.z);
    while (t < maxDist) {
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const above = y - this.heightAt(x, z);
      if (above < 0) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 20; i++) {
          const m = 0.5 * (lo + hi);
          const a = origin.y + dir.y * m - this.heightAt(origin.x + dir.x * m, origin.z + dir.z * m);
          if (a > 0) lo = m; else hi = m;
        }
        const tt = 0.5 * (lo + hi);
        return new THREE.Vector3(origin.x + dir.x * tt, origin.y + dir.y * tt, origin.z + dir.z * tt);
      }
      prevT = t; prevAbove = above;
      t += Math.max(0.05, Math.min(above * 0.5, 25));
    }
    return null;
  }
}
