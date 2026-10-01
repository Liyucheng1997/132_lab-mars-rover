import * as THREE from "three";
import { Noise } from "../core/noise.js";
import { mulberry32 } from "../core/math.js";

// Rover surface finishes. Every material gets the shared dust patch: Martian
// dust settles on up-facing surfaces and slowly coats the whole vehicle as
// sols pass (uDust 0 → 1), while wheels pick up dust from below.
export const dustUniforms = {
  uDust: { value: 0.18 },
  uDustColor: { value: new THREE.Color(0xb7845c) },
};

function patchDust(mat, { wheel = false } = {}) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uDust = dustUniforms.uDust;
    s.uniforms.uDustColor = dustUniforms.uDustColor;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDN;\nvarying vec3 vDP;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvDN = normalize(mat3(modelMatrix) * objectNormal);\nvDP = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDN;\nvarying vec3 vDP;\nuniform float uDust;\nuniform vec3 uDustColor;\nfloat dHash(vec3 p){ return fract(sin(dot(floor(p), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }")
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
float dUp = smoothstep(${wheel ? "-1.0, 1.0" : "0.1, 0.95"}, normalize(vDN).y);
float dMot = 0.75 + 0.5 * dHash(vDP * 140.0);
float dAmt = clamp(uDust * (${wheel ? "0.9" : "0.25 + 0.95 * dUp"}) * dMot, 0.0, 0.92);
diffuseColor.rgb = mix(diffuseColor.rgb, uDustColor, dAmt);
roughnessFactor = mix(roughnessFactor, 0.95, dAmt);`
      )
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - dAmt;");
  };
  mat.customProgramCacheKey = () => "dust-" + (wheel ? "w" : "b");
  return mat;
}

function canvasTexture(size, draw, repeat = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

// Height canvas → normal map texture.
function normalFromHeight(size, heightFn, strength = 2) {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = heightFn(x, y);
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
    data[i] = (-dx / l * 0.5 + 0.5) * 255;
    data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
    data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function createRoverMaterials() {
  const n = new Noise(9);
  const rnd = mulberry32(3);

  // Painted structure: panel seams + fastener rows.
  const panelNormal = normalFromHeight(256, (x, y) => {
    const seam = (v) => Math.exp(-Math.pow(((v % 128) - 0.5) / 1.2, 2));
    let h = -(seam(x) + seam(y)) * 2.5;
    const rx = x % 16, ry = y % 128;
    if ((ry < 6 || ry > 122) && Math.hypot(rx - 8, (ry < 64 ? ry : ry - 128) - 3) < 2.2) h += 1.5;
    return h + n.fbm2p(x / 32, y / 32, 8, 3) * 0.3;
  }, 1.4);

  // Multi-layer insulation: crinkled foil.
  const mliNormal = normalFromHeight(256, (x, y) =>
    Math.abs(n.fbm2p(x / 24, y / 24, 10.6667, 5)) * 6 + n.fbm2p(x / 8, y / 8, 32, 2) * 1.2, 2.5);

  // Brushed / machined aluminium roughness.
  const brushed = canvasTexture(256, (g, s) => {
    g.fillStyle = "#7a7a7a"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const v = 90 + rnd() * 90;
      g.strokeStyle = `rgba(${v},${v},${v},0.35)`;
      g.beginPath(); const y = rnd() * s; g.moveTo(0, y); g.lineTo(s, y + (rnd() - 0.5) * 3); g.stroke();
    }
  });

  const std = (o, opts) => patchDust(new THREE.MeshStandardMaterial(o), opts);
  return {
    paint: std({ color: 0xe8e6e0, roughness: 0.6, metalness: 0.05, normalMap: panelNormal, normalScale: new THREE.Vector2(0.6, 0.6) }),
    paintDark: std({ color: 0x3a3a3c, roughness: 0.55, metalness: 0.2 }),
    gold: std({ color: 0xd7a94a, roughness: 0.32, metalness: 0.95, normalMap: mliNormal, normalScale: new THREE.Vector2(1.2, 1.2) }),
    silverMli: std({ color: 0xc9ccd0, roughness: 0.3, metalness: 0.9, normalMap: mliNormal, normalScale: new THREE.Vector2(1.0, 1.0) }),
    aluminium: std({ color: 0xb8bcc0, roughness: 0.42, metalness: 0.85, roughnessMap: brushed }),
    titanium: std({ color: 0x9a968e, roughness: 0.38, metalness: 0.8 }),
    anodizedBlack: std({ color: 0x1d1e21, roughness: 0.45, metalness: 0.5 }),
    actuator: std({ color: 0x2c2d30, roughness: 0.5, metalness: 0.6 }),
    rtg: std({ color: 0x5b5c5e, roughness: 0.55, metalness: 0.7 }),
    wheel: patchDust(new THREE.MeshStandardMaterial({ color: 0xaeb2b6, roughness: 0.5, metalness: 0.75, side: THREE.DoubleSide }), { wheel: true }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b0d12, roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
    solarCell: std({ color: 0x1b2440, roughness: 0.25, metalness: 0.6 }),
    calTarget: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
    cable: std({ color: 0x8a6d3b, roughness: 0.7, metalness: 0.1 }),
  };
}
