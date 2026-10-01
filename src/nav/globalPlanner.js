// Global route planner over an "orbital" traversability map (pure).
//
// Mirrors how Mars 2020 strategic routes are drawn on HiRISE-derived maps:
// slope and terrain class are known from orbit, individual rocks below ~1 m
// are not — those are left to the onboard local planner (ENav).
// A* on an 8-connected grid; cost = distance × (1 + slope + sand + roughness).

export function buildCostMap({ size, cell, heightAt, materialAt, slopeLimitDeg = 25 }) {
  const n = Math.round(size / cell);
  const half = size / 2;
  const cost = new Float32Array(n * n);
  const lim = Math.tan((slopeLimitDeg * Math.PI) / 180);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
      const e = cell * 0.75;
      const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const grad = Math.hypot(gx, gz);
      // roughness: deviation of the centre from the plane through the samples
      const rough = Math.abs(heightAt(x, z) - 0.25 * (heightAt(x + e, z) + heightAt(x - e, z) + heightAt(x, z + e) + heightAt(x, z - e)));
      const m = materialAt(x, z);
      if (grad > lim || Math.abs(x) > half - 12 || Math.abs(z) > half - 12) { cost[j * n + i] = Infinity; continue; }
      cost[j * n + i] = 1 + 6 * (grad / lim) ** 2 + 2.5 * m.sand + 8 * rough;
    }
  }
  return { n, cell, half, cost };
}

class Heap {
  constructor() { this.a = []; }
  push(k, p) {
    const a = this.a; a.push([k, p]);
    let i = a.length - 1;
    while (i > 0) { const q = (i - 1) >> 1; if (a[q][1] <= a[i][1]) break; [a[q], a[i]] = [a[i], a[q]]; i = q; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/** A* from (x0,z0) to (x1,z1). Returns [[x,z], …] or null. */
export function planRoute(map, x0, z0, x1, z1) {
  const { n, cell, half, cost } = map;
  const toI = (v) => Math.min(n - 1, Math.max(0, Math.floor((v + half) / cell)));
  const si = toI(x0), sj = toI(z0), gi = toI(x1), gj = toI(z1);
  const start = sj * n + si, goal = gj * n + gi;
  if (!isFinite(cost[goal])) return null;
  const g = new Float32Array(n * n).fill(Infinity);
  const from = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const h = (k) => Math.hypot((k % n) - gi, Math.floor(k / n) - gj) * 0.95;
  const open = new Heap();
  g[start] = 0;
  open.push(start, h(start));
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  let expanded = 0;
  while (open.size) {
    const [k] = open.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === goal) break;
    if (++expanded > n * n) break;
    const ci = k % n, cj = (k - ci) / n;
    for (const [di, dj, len] of D) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nk = nj * n + ni;
      // the start cell is allowed even if it reads as hazardous
      const c = nk === start ? 1 : cost[nk];
      if (!isFinite(c) || closed[nk]) continue;
      const ng = g[k] + len * 0.5 * (c + (k === start ? 1 : cost[k]));
      if (ng < g[nk]) { g[nk] = ng; from[nk] = k; open.push(nk, ng + h(nk)); }
    }
  }
  if (from[goal] < 0 && goal !== start) return null;
  const path = [];
  for (let k = goal; k >= 0; k = from[k]) {
    path.push([-half + ((k % n) + 0.5) * cell, -half + (Math.floor(k / n) + 0.5) * cell]);
    if (k === start) break;
  }
  path.reverse();
  path[0] = [x0, z0];
  path[path.length - 1] = [x1, z1];
  return smoothPath(path, map);
}

// String-pull: drop intermediate nodes while the straight segment stays cheap.
function smoothPath(path, map) {
  const out = [path[0]];
  let a = 0;
  const ok = (p, q) => {
    const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (map.cell * 0.5));
    for (let s = 1; s < steps; s++) {
      const x = p[0] + ((q[0] - p[0]) * s) / steps, z = p[1] + ((q[1] - p[1]) * s) / steps;
      const i = Math.floor((x + map.half) / map.cell), j = Math.floor((z + map.half) / map.cell);
      const c = map.cost[j * map.n + i];
      if (!isFinite(c) || c > 2.2) return false;
    }
    return true;
  };
  while (a < path.length - 1) {
    let b = path.length - 1;
    while (b > a + 1 && !ok(path[a], path[b])) b--;
    out.push(path[b]);
    a = b;
  }
  return out;
}
