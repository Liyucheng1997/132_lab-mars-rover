import * as THREE from "three";

// Physically based Martian surface material.
// Extends MeshStandardMaterial via onBeforeCompile so it keeps three's lighting,
// shadows, fog and logarithmic depth while adding:
//   • geologic unit blending from the material map (bedrock / sand / dust / ejecta)
//   • slope-exposed bedrock on crater walls and scarps
//   • two-scale procedural detail normals per unit (anti-tiling)
//   • distance-faded micro detail, km-scale albedo variation in the far field
export function createTerrainMaterial({ matMap, nearHalf, detail }) {
  const col = (hex) => new THREE.Color(hex);
  const uniforms = {
    uMat: { value: matMap },
    uNearHalf: { value: nearHalf },
    uDetReg: { value: detail.regolith },
    uDetSand: { value: detail.sand },
    uDetRock: { value: detail.bedrock },
    cRegolith: { value: col(0x94664a) },
    cDust: { value: col(0xb08463) },
    cSand: { value: col(0x5c4a3f) },
    cBedrock: { value: col(0x857063) },
    cEjecta: { value: col(0x93796a) },
    uDetailStrength: { value: 0.9 },
  };

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);"
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uMat, uDetReg, uDetSand, uDetRock;
uniform float uNearHalf, uDetailStrength;
uniform vec3 cRegolith, cDust, cSand, cBedrock, cEjecta;

vec4 tMat;      // r bedrock, g sand, b albedo, a ejecta
float tBed, tSand, tFade;

vec4 matAt(vec2 xz) {
  vec2 uv = (xz + uNearHalf) / (2.0 * uNearHalf);
  vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  float inside = inb.x * inb.y;
  return mix(vec4(0.0, 0.0, 0.5, 0.0), texture2D(uMat, uv), inside);
}
// Two scales, rotated against each other, so the 1 m tile never reads as a grid.
vec4 detail2(sampler2D t, vec2 p) {
  vec4 a = texture2D(t, p);
  vec4 b = texture2D(t, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.27 + 0.31);
  return mix(a, b, 0.4);
}`
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
{
  tMat = matAt(vWPos.xz);
  float slope = 1.0 - clamp(normalize(vWNormal).y, 0.0, 1.0);
  tBed = clamp(tMat.r + smoothstep(0.18, 0.4, slope), 0.0, 1.0);
  tSand = tMat.g * (1.0 - tBed);
  float dist = length(vWPos - cameraPosition);
  tFade = 1.0 - smoothstep(25.0, 160.0, dist);

  // km-scale albedo variation outside the synthesised near field
  float big = texture2D(uDetReg, vWPos.xz / 2300.0).a * 0.6 + texture2D(uDetSand, vWPos.xz / 9100.0).a * 0.4;
  float alb = mix(tMat.b, big, smoothstep(uNearHalf * 0.9, uNearHalf * 1.1, max(abs(vWPos.x), abs(vWPos.z))));

  vec3 base = mix(cRegolith, cDust, smoothstep(0.3, 0.8, alb));
  base = mix(base, cSand, tSand);
  base = mix(base, cBedrock, tBed);
  base = mix(base, cEjecta, tMat.a * 0.7);

  vec4 dReg = detail2(uDetReg, vWPos.xz);
  vec4 dSand = detail2(uDetSand, vWPos.xz * 0.8);
  vec4 dRock = detail2(uDetRock, vWPos.xz * 0.45 + vWPos.y * 0.2);
  vec4 det = mix(mix(dReg, dSand, tSand), dRock, tBed);
  base *= mix(1.0, 0.72 + 0.56 * det.a, tFade);
  diffuseColor.rgb *= base;
}`
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(0.96, 0.9, tSand), 0.82, tBed);"
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
{
  vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec4 dReg = detail2(uDetReg, vWPos.xz);
  vec4 dSand = detail2(uDetSand, vWPos.xz * 0.8);
  vec4 dRock = detail2(uDetRock, vWPos.xz * 0.45 + vWPos.y * 0.2);
  vec3 dn = mix(mix(dReg.rgb, dSand.rgb, tSand), dRock.rgb, tBed) * 2.0 - 1.0;
  float k = uDetailStrength * mix(0.25, 1.0, tFade);
  nW = normalize(nW + vec3(dn.x, 0.0, dn.y) * k);
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`
      );
  };
  mat.customProgramCacheKey = () => "mars-terrain-v2";
  return mat;
}
