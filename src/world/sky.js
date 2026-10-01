import * as THREE from "three";

// Martian sky: single + approximate multiple scattering by suspended dust.
//
// Mars dust (r_eff ≈ 1.5 µm) absorbs blue more than red (lower single-
// scattering albedo ω at short wavelengths) and scatters blue more strongly
// forward (larger Henyey–Greenstein g). Result: a butterscotch sky by day and
// a blue aureole around the setting Sun — both emerge from the same model.
// The same model runs on the CPU to derive sun / sky / fog light colours, so
// scene lighting and the sky background never disagree.
const W_ALB = [0.97, 0.84, 0.55];   // single-scattering albedo  (R, G, B)
const G_HG = [0.55, 0.65, 0.86];       // HG asymmetry parameter
const EXT = [1.0, 1.0, 1.02];       // relative extinction
const SUN_E = 22.0;                  // exposure-scaled solar irradiance

const airmass = (mu) => {
  const m = Math.min(Math.max(mu, 0), 1);
  return 1 / (m + 0.06 * Math.pow(1 - m, 4) + 0.005);
};
const hg = (cos, g) => (1 - g * g) / Math.pow(1 + g * g - 2 * g * cos, 1.5);

// Radiance (linear RGB) of the sky in unit direction v for unit sun direction s.
export function skyRadiance(v, s, tau, sunScale = 1) {
  const muV = v.y, muS = s.y;
  const cos = v.x * s.x + v.y * s.y + v.z * s.z;
  const mv = airmass(muV), ms = airmass(Math.max(muS, -0.1));
  const twilight = smooth(-0.16, 0.02, muS);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const t = tau * EXT[c];
    const view = 1 - Math.exp(-t * mv);
    const sunT = Math.exp(-0.55 * t * ms);
    const single = W_ALB[c] * hg(cos, G_HG[c]) * view * sunT;
    const multi = W_ALB[c] * W_ALB[c] * 0.55 * view * (1 - Math.exp(-t * ms)) * Math.max(muS + 0.12, 0);
    out[c] = SUN_E * sunScale * twilight * 0.022 * (single + multi * 4.5);
  }
  return out;
}

function smooth(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// Direct solar beam at the surface (linear RGB, before light intensity).
export function sunTransmittance(muS, tau) {
  const ms = airmass(muS);
  return EXT.map((e) => Math.exp(-tau * e * ms));
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSun, uEarth, uPhobos, uDeimos;
uniform vec2 uMoonRad;      // angular radius (rad) of Phobos, Deimos
uniform float uTau, uSunScale, uStars, uSunRad;
uniform mat3 uCelestial;    // world → Mars-inertial (stars rotate with the sol)
const vec3 W_ALB = vec3(${W_ALB.join(",")});
const vec3 G_HG = vec3(${G_HG.join(",")});
const vec3 EXT = vec3(${EXT.join(",")});

float airmass(float mu) { float m = clamp(mu, 0.0, 1.0); return 1.0 / (m + 0.06 * pow(1.0 - m, 4.0) + 0.005); }
vec3 hg(float c, vec3 g) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, vec3(1.5)); }
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

vec3 moonDisk(vec3 v, vec3 dir, float rad, vec3 sun, vec3 albedo) {
  float a = acos(clamp(dot(v, dir), -1.0, 1.0));
  if (a > rad * 1.2) return vec3(0.0);
  vec3 t = (v - dir * dot(v, dir)) / max(rad, 1e-5);
  float r2 = dot(t, t);
  float edge = 1.0 - smoothstep(0.85, 1.0, sqrt(r2));
  vec3 n = normalize(t - dir * sqrt(max(1.0 - r2, 0.0)));
  return albedo * max(dot(n, sun), 0.0) * edge;
}

void main() {
  vec3 v = normalize(vDir);
  vec3 s = normalize(uSun);
  float muV = v.y, muS = s.y;
  float cosT = dot(v, s);
  float mv = airmass(muV), ms = airmass(max(muS, -0.1));
  float twilight = smoothstep(-0.16, 0.02, muS);
  vec3 t = uTau * EXT;
  vec3 view = 1.0 - exp(-t * mv);
  vec3 sunT = exp(-0.55 * t * ms);
  vec3 single = W_ALB * hg(cosT, G_HG) * view * sunT;
  vec3 multi = W_ALB * W_ALB * 0.55 * view * (1.0 - exp(-t * ms)) * max(muS + 0.12, 0.0);
  vec3 col = ${SUN_E.toFixed(1)} * uSunScale * twilight * 0.022 * (single + multi * 4.5);

  // below the horizon: dark ground-haze so the far terrain edge reads cleanly
  col *= mix(0.55, 1.0, smoothstep(-0.08, 0.0, muV));

  // solar disk with limb darkening, dimmed by the line-of-sight dust
  float ang = acos(clamp(cosT, -1.0, 1.0));
  if (ang < uSunRad * 1.3) {
    float r = ang / uSunRad;
    float limb = r < 1.0 ? 0.4 + 0.6 * sqrt(1.0 - r * r) : 0.0;
    col += 300.0 * uSunScale * limb * exp(-t * airmass(muS)) * smoothstep(1.3, 1.0, r);
  }

  // night sky: stars, Earth, moons (fade out as the sky brightens)
  float dark = uStars * (1.0 - smoothstep(0.02, 0.25, dot(col, vec3(0.33)))) * smoothstep(-0.02, 0.06, muV);
  if (dark > 0.001) {
    vec3 c = uCelestial * v;
    vec3 cell = floor(c * 260.0);
    float h = hash(cell);
    if (h > 0.9975) {
      vec3 sp = (cell + 0.5 + 0.35 * vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) - 0.175) / 260.0;
      float d = length(normalize(sp) - c) * 260.0;
      float mag = pow((h - 0.9975) / 0.0025, 3.0);
      vec3 tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash(cell + 9.0));
      col += tint * mag * 2.5 * exp(-d * d * 18.0) * dark;
    }
    float e = acos(clamp(dot(v, normalize(uEarth)), -1.0, 1.0));
    col += vec3(0.55, 0.75, 1.0) * 4.0 * exp(-pow(e / 0.0012, 2.0)) * dark;
  }
  col += moonDisk(v, normalize(uPhobos), uMoonRad.x, s, vec3(0.9, 0.82, 0.75)) * (0.2 + 0.8 * dark) * 1.4;
  col += moonDisk(v, normalize(uDeimos), uMoonRad.y, s, vec3(0.95, 0.88, 0.8)) * (0.2 + 0.8 * dark) * 1.4;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class MarsSky {
  constructor() {
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uEarth: { value: new THREE.Vector3(0, -1, 0) },
      uPhobos: { value: new THREE.Vector3(0, -1, 0) },
      uDeimos: { value: new THREE.Vector3(0, -1, 0) },
      uMoonRad: { value: new THREE.Vector2(0.0015, 0.0003) },
      uTau: { value: 0.5 },
      uSunScale: { value: 1 },
      uStars: { value: 1 },
      uSunRad: { value: 0.0045 },
      uCelestial: { value: new THREE.Matrix3() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  /**
   * @param p { sun, earth, phobos, deimos: world unit Vector3; tau; sunScale;
   *            moonRad: [rad, rad]; celestial: Matrix3 }
   */
  update(camera, p) {
    this.mesh.position.copy(camera.position);
    const u = this.uniforms;
    u.uSun.value.copy(p.sun);
    u.uEarth.value.copy(p.earth);
    u.uPhobos.value.copy(p.phobos);
    u.uDeimos.value.copy(p.deimos);
    u.uMoonRad.value.set(p.moonRad[0], p.moonRad[1]);
    u.uTau.value = p.tau;
    u.uSunScale.value = p.sunScale;
    u.uCelestial.value.copy(p.celestial);
  }

  // Scene light colours from the same scattering model.
  lighting(sun, tau, sunScale) {
    const T = sunTransmittance(Math.max(sun.y, 0), tau);
    const above = smooth(-0.02, 0.05, sun.y);
    const sunColor = new THREE.Color(T[0], T[1], T[2]);
    const sunIntensity = 3.2 * sunScale * above * Math.max(T[0], T[1], T[2]);
    if (sunColor.r > 0) sunColor.multiplyScalar(1 / Math.max(T[0], T[1], T[2]));

    // hemisphere sky term: average radiance of a few upper-hemisphere directions
    const dirs = [[0, 1, 0], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0.7, 0.7], [0, 0.7, -0.7], [0.5, 0.3, 0.8], [-0.5, 0.3, -0.8]];
    const acc = [0, 0, 0];
    for (const d of dirs) {
      const L = skyRadiance({ x: d[0], y: d[1], z: d[2] }, sun, tau, sunScale);
      for (let c = 0; c < 3; c++) acc[c] += L[c] / dirs.length;
    }
    const sky = new THREE.Color(acc[0], acc[1], acc[2]);

    // horizon colour (fog) averaged around the azimuth
    const fog = [0, 0, 0];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const L = skyRadiance({ x: Math.cos(a), y: 0.03, z: Math.sin(a) }, sun, tau, sunScale);
      for (let c = 0; c < 3; c++) fog[c] += L[c] / 8;
    }
    return { sunColor, sunIntensity, sky, fog: new THREE.Color(fog[0], fog[1], fog[2]) };
  }
}
