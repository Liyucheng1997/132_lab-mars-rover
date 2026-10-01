import * as THREE from "three";
import { Noise } from "../core/noise.js";
import { mulberry32 } from "../core/math.js";

// Procedurally generated, seamlessly tiling surface-detail textures.
// Each texture packs a tangent-space normal in RGB and a cavity/albedo
// modulation term in A, computed from a periodic height field.

function heightToTexture(size, heightFn, strength) {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = heightFn(x, y);
  let mn = Infinity, mx = -Infinity;
  for (const v of H) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[i + 3] = ((at(x, y) - mn) / (mx - mn || 1)) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Scatter smooth bumps (pebbles / grains) with wrap-around.
function bumps(size, count, rMin, rMax, seed) {
  const rnd = mulberry32(seed);
  const field = new Float32Array(size * size);
  for (let k = 0; k < count; k++) {
    const cx = rnd() * size, cy = rnd() * size;
    const r = rMin + Math.pow(rnd(), 2.5) * (rMax - rMin);
    const hgt = r * (0.5 + rnd() * 0.5);
    const R = Math.ceil(r);
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const d2 = (x * x + y * y) / (r * r);
      if (d2 >= 1) continue;
      const px = (Math.floor(cx) + x + size) % size, py = (Math.floor(cy) + y + size) % size;
      const v = hgt * Math.sqrt(1 - d2);
      if (v > field[py * size + px]) field[py * size + px] = v;
    }
  }
  return field;
}

export function makeTerrainDetail(size = 512) {
  const n = new Noise(77);
  const P = 8; // noise periods per tile

  // Regolith: fine granular texture + scattered pebbles (1 tile = 1 m).
  const peb = bumps(size, 1400, 1.2, 9, 5);
  const regolith = heightToTexture(size, (x, y) => {
    const u = (x / size) * P, v = (y / size) * P;
    return n.fbm2p(u, v, P, 6) * 6 + n.fbm2p(u * 4, v * 4, P * 4, 3) * 1.6 + peb[y * size + x] * 0.55;
  }, 0.9);

  // Sand: wind ripples, ~10 cm wavelength, gently sinuous.
  const sand = heightToTexture(size, (x, y) => {
    const u = x / size, v = y / size;
    const warp = n.fbm2p(u * 4, v * 4, 4, 3) * 0.6;
    const ripple = Math.sin(2 * Math.PI * (10 * (u + 0.35 * v) + warp));
    return ripple * 2.2 + n.fbm2p(u * 32, v * 32, 32, 2) * 0.5;
  }, 1.2);

  // Bedrock: layered, fractured surface with cavities.
  const bedrock = heightToTexture(size, (x, y) => {
    const u = (x / size) * P, v = (y / size) * P;
    const layers = Math.sin(2 * Math.PI * (v * 1.5 + n.fbm2p(u, v, P, 3) * 0.35)) * 2;
    const cracks = Math.pow(Math.abs(n.noise2p(u * 1.5, v * 1.5, P * 1.5)), 0.35) * 5;
    return layers + cracks + n.fbm2p(u * 2, v * 2, P * 2, 5) * 5;
  }, 1.0);

  return { regolith, sand, bedrock };
}

// Wheel-track imprint: grouser chevrons across the track, raised side berms.
// RGB = normal, A = coverage (edges fade out). V repeats once per grouser pitch.
export function makeTrackTexture() {
  const w = 64, h = 32;
  const H = (x, y) => {
    const u = x / w;                       // across the track 0..1
    const v = y / h;                       // along, one grouser per repeat
    const edge = Math.min(u, 1 - u);
    const berm = Math.exp(-Math.pow((edge - 0.03) / 0.04, 2)) * 1.4;
    const curve = 0.12 * Math.sin(Math.PI * u);
    const g = Math.abs(((v + curve) % 1 + 1) % 1 - 0.5) * 2; // 0 at grouser groove
    const groove = -Math.exp(-g * g * 30) * 1.0;
    return berm + (edge > 0.06 ? groove - 0.5 : 0);
  };
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(Math.min(x + 1, w - 1), y) - H(Math.max(x - 1, 0), y)) * 3;
    const dy = (H(x, (y + 1) % h) - H(x, (y - 1 + h) % h)) * 3;
    const l = Math.hypot(dx, dy, 1);
    const i = (y * w + x) * 4;
    const u = x / (w - 1);
    data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
    data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
    data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
    data[i + 3] = Math.min(1, Math.min(u, 1 - u) * 12) * 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
