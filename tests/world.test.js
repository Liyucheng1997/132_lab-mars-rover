// Terrain / rocks / navigation model verification (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SITE } from "../src/core/constants.js";
import { localToLatLon, latLonToLocal, curvatureDrop, DemGrid, syntheticJezero } from "../src/world/geo.js";
import { generateCraters, craterProfile, generateNearField } from "../src/world/terrainGen.js";
import { fractionalArea, golombekQ, numberDensity, countBetween, generateChunkRocks, STRIDE } from "../src/world/rockGen.js";
import { buildCostMap, planRoute } from "../src/nav/globalPlanner.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);

test("site frame ↔ lat/lon round trip is sub-millimetre over ±60 km", () => {
  for (const [x, z] of [[0, 0], [1234.5, -987.6], [-60000, 45000]]) {
    const [lat, lon] = localToLatLon(x, z);
    const [x2, z2] = latLonToLocal(lat, lon);
    near(x2, x, 1e-6); near(z2, z, 1e-6);
  }
  // 1° of latitude on Mars ≈ 59.16 km; north is −Z
  const [lat] = localToLatLon(0, -59158);
  near(lat - SITE.latDeg, 1, 1e-3);
  near(curvatureDrop(20000), 59, 1, "curvature drop at 20 km (m)");
});

test("DEM bicubic sampler reproduces the grid at pixel centres", () => {
  const elev = new Float32Array(16 * 16).map((_, i) => Math.sin(i * 0.37) * 100);
  const g = new DemGrid(elev, { widthPx: 16, heightPx: 16, ppd: 128, latTopDeg: 20, lonLeftDeg: 70 });
  for (const [r, c] of [[5, 5], [7, 9], [10, 3]]) {
    near(g.elevation(20 - (r + 0.5) / 128, 70 + (c + 0.5) / 128), elev[r * 16 + c], 1e-3);
  }
});

test("crater population follows the N(>D) ∝ D⁻² size–frequency law", () => {
  const cr = generateCraters(1024, 7);
  const n4 = cr.filter((c) => c.D > 4).length, n16 = cr.filter((c) => c.D > 16).length;
  assert.ok(n16 > 3);
  near(n4 / n16, 16, 6, "cumulative ratio for 4× diameter");
});

test("crater profile: bowl below datum, raised rim, continuous at the rim", () => {
  for (const degr of [0, 0.5, 1]) {
    const c = { R: 10, D: 20, degr, depth: 20 * (0.2 * (1 - degr) + 0.035 * degr), rim: 20 * (0.04 * Math.pow(1 - degr, 1.5) + 0.003) };
    assert.ok(craterProfile(c, 0) < -0.5);
    assert.ok(craterProfile(c, 1) > 0);
    near(craterProfile(c, 0.9999), craterProfile(c, 1.0001), 0.02, `rim continuity degr=${degr}`);
    near(craterProfile(c, 3.2), 0, 1e-9, "no influence beyond 3R");
  }
});

test("near-field synthesis is deterministic and blends into the macro DEM at the border", () => {
  const dem = syntheticJezero();
  const macro = (x, z) => dem.localHeight(x, z);
  const opts = { size: 256, res: 1, matRes: 2, edgeFade: 32, seed: 99 };
  const a = generateNearField(macro, opts), b = generateNearField(macro, opts);
  assert.deepEqual(a.heights.slice(0, 500), b.heights.slice(0, 500));
  const n = a.n;
  for (const [i, j] of [[0, 0], [n - 1, 0], [0, n - 1], [n >> 1, 0]]) {
    const x = -128 + i, z = -128 + j;
    near(a.heights[j * n + i], macro(x, z), 0.6, `edge (${i},${j})`);
  }
  near(a.heights[(n >> 1) * n + (n >> 1)], 0, 3, "site near datum");
});

test("Golombek rock model: F(0) = k, density decreasing, sampled area matches the model", () => {
  for (const k of [0.03, 0.1, 0.2]) {
    near(fractionalArea(0, k), k, 1e-12);
    assert.ok(numberDensity(0.2, k) > numberDensity(0.5, k));
    near(golombekQ(k), 1.79 + 0.152 / k, 1e-12);
  }
  const k = 0.08, size = 32, Dmin = 0.1;
  let area = 0, runs = 12;
  for (let r = 0; r < runs; r++) {
    const recs = generateChunkRocks({ ci: r, cj: 3, x0: 0, z0: 0, size, seed: 5, kAt: () => k, heightAt: () => 0, Dmin, protos: 4 });
    for (let i = 0; i < recs.length; i += STRIDE) area += (Math.PI * recs[i + 9] ** 2) / 4;
  }
  const measured = area / (runs * size * size);
  const expected = fractionalArea(Dmin, k) - fractionalArea(3.5, k);
  near(measured / expected, 1, 0.2, "covered-area fraction");
  assert.ok(countBetween(0.1, 3.5, k) > countBetween(0.5, 3.5, k));
});

test("A* global route avoids an impassable ridge and string-pulls the path", () => {
  // flat 200 m field with a steep wall at z∈[-5,5] except a gap at x>60
  const heightAt = (x, z) => (Math.abs(z) < 5 && x < 60 ? 40 * (5 - Math.abs(z)) : 0);
  const map = buildCostMap({ size: 200, cell: 2, heightAt, materialAt: () => ({ sand: 0 }), slopeLimitDeg: 25 });
  const route = planRoute(map, -50, -40, -50, 40);
  assert.ok(route, "route found");
  assert.ok(route.some(([x]) => x > 58), "detours through the gap");
  for (let i = 1; i < route.length; i++) {
    const [ax, az] = route[i - 1], [bx, bz] = route[i];
    for (let t = 0; t <= 1; t += 0.05) {
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      assert.ok(!(Math.abs(z) < 4 && x < 58), `segment crosses the wall at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
  }
  assert.ok(route.length < 12, "smoothed");
});
