// Mars Rover Engineering Simulator — orchestrator.
// Boot: DEM → terrain worker → world → rover → loop.
// Loop: real-time render, fixed-step simulated physics under a time-warp clock.
import * as THREE from "three";
import { DEG, RAD, ROVER, SITE } from "./core/constants.js";
import { clamp, wrapPi, approach } from "./core/math.js";
import { marsTime, missionSol, formatHours, nextLmst, seasonOf } from "./physics/marsTime.js";
import { skyBodies, moons, enuBasis, marsRotation } from "./physics/ephemeris.js";
import { environment } from "./physics/environment.js";
import { PowerSystem } from "./physics/power.js";
import { solveDrill, slew, ARM } from "./physics/armKinematics.js";
import { loadJezeroDem } from "./world/demLoader.js";
import { localToLatLon } from "./world/geo.js";
import { Terrain } from "./world/terrain.js";
import { RockField } from "./world/rocks.js";
import { MarsSky } from "./world/sky.js";
import { WheelTracks } from "./world/tracks.js";
import { DustParticles } from "./world/particles.js";
import { Rover } from "./rover/rover.js";
import { Vehicle } from "./rover/vehicle.js";
import { dustUniforms } from "./rover/roverMaterials.js";
import { AutoNav } from "./nav/autonav.js";
import { Telecom } from "./ops/telecom.js";
import { CameraRig, VIEWS } from "./cameras.js";
import { InputManager } from "./controls.js";
import { Minimap, SuspensionView, bind, bar } from "./ui.js";

window.addEventListener("error", (e) => console.error("RUNTIME:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("PROMISE:", e.reason));

const params = new URLSearchParams(location.search);
const WARPS = [1, 5, 20, 60, 200, 1000, 5000];
const setLoading = (txt, p) => {
  bind("loading-text").textContent = txt;
  if (p !== undefined) bind("loading-bar").style.width = `${Math.round(p * 100)}%`;
};

// ============================================================ boot
setLoading("载入 MOLA 高程数据…", 0.02);
const demInfo = await loadJezeroDem();

setLoading("合成近场地形(陨石坑 · 风成沙丘 · 基岩露头)…", 0.05);
const tGen = performance.now();
const near = await new Promise((resolve, reject) => {
  const worker = new Worker(new URL("./world/terrainWorker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    if (e.data.type === "progress") setLoading(`合成近场地形… ${Math.round(e.data.p * 100)}%`, 0.05 + e.data.p * 0.6);
    else { resolve(e.data.result); worker.terminate(); }
  };
  worker.onerror = (e) => reject(e);
  const elev = demInfo.elev.slice();
  worker.postMessage({ elev, meta: demInfo.meta, opts: {} }, [elev.buffer]);
});

console.info(`terrain synthesis ${(performance.now() - tGen).toFixed(0)} ms`);
setLoading("构建地形网格与岩石场…", 0.7);
await new Promise((r) => setTimeout(r, 0));

const canvas = bind("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xc8996f, 1 / 26000);

const terrain = new Terrain(near, demInfo.dem);
const rocks = new RockField(terrain);
scene.add(terrain.group, rocks.group);

const sky = new MarsSky();
scene.add(sky.mesh);

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 260 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xd0a080, 0x4a2a1c, 0.6);
scene.add(hemi);

setLoading("装配火星车(摇臂-转向架 · 机械臂 · 桅杆)…", 0.8);
await new Promise((r) => setTimeout(r, 0));
const rover = new Rover(terrain);
rover.position.set(0, 0, 0);
rover.heading = 300 * DEG;
scene.add(rover.group);

const vehicle = new Vehicle(rover, terrain);
const tracks = new WheelTracks(terrain);
scene.add(tracks.mesh);
const dust = new DustParticles();
scene.add(dust.group);

setLoading("生成轨道代价地图(全局路径规划)…", 0.88);
await new Promise((r) => setTimeout(r, 0));
const nav = new AutoNav(terrain);
const mapMs = nav.buildMap();
scene.add(nav.visuals);

const power = new PowerSystem();
const telecom = new Telecom();
const cameras = new CameraRig(renderer, rover);

// boreholes / abrasion patches left by the drill
const boreholes = new THREE.Group();
scene.add(boreholes);

// ============================================================ simulation clock
let simMs = params.has("utc") ? Date.parse(params.get("utc")) : Date.now();
if (!params.has("utc")) {
  const lm = marsTime(simMs).lmst;
  if (lm < 8.5 || lm > 15.5) simMs = nextLmst(simMs, 9.5);
}
let warpIdx = Math.max(0, WARPS.indexOf(Number(params.get("warp")) || 20));
let lightTimeMode = false;
const pending = [];   // light-time-delayed commands: {at, label, run}

const S = {
  mode: "MANUAL",         // MANUAL | AUTONAV | SEQUENCE
  seq: null,              // active sequence
  samples: 0,
  hud: true,
  crumbs: [[0, 0]],
  armGoal: ARM.stow.slice(),
  mastGoal: 1,
  lastSol: -1,
  imaging: false,
};

// ============================================================ HUD wiring
const logEl = bind("log");
function log(msg, cls = "") {
  const mt = marsTime(simMs);
  const line = document.createElement("div");
  line.className = "ln " + cls;
  line.textContent = `S${missionSol(simMs)} ${formatHours(mt.lmst)}  ${msg}`;
  logEl.appendChild(line);
  while (logEl.children.length > 9) logEl.removeChild(logEl.firstChild);
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = bind("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

const minimap = new Minimap(bind("minimap"), terrain, {
  onWaypoint: (x, z) => command("航点(地图)", () => setGoal(x, z)),
  onState: ({ mode, zoom }) => {
    bind("map-zoom").textContent = "×" + (zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0));
    bind("map-local").classList.toggle("active", mode === "local");
    bind("map-global").classList.toggle("active", mode === "global");
  },
});
bind("map-local").addEventListener("click", () => minimap.setMode("local"));
bind("map-global").addEventListener("click", () => minimap.setMode("global"));
(async () => {
  try {
    const meta = await (await fetch("./data/mars_global.json")).json();
    const img = new Image();
    img.src = "./data/" + meta.image;
    await img.decode();
    minimap.setGlobal(img, meta);
  } catch { /* optional */ }
})();
const suspView = new SuspensionView(bind("susp"));

// Commands from "Earth": optionally delayed by the one-way light time.
function command(label, run) {
  if (!lightTimeMode) { run(); return; }
  const delay = telecom.owlt * 1000;
  pending.push({ at: simMs + delay, label, run });
  log(`↑ 上行指令「${label}」— 光行时 ${fmtDur(telecom.owlt)} 后执行`, "up");
}

function fmtDur(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function setGoal(x, z) {
  if (!terrain.inBounds(x, z, 16)) { toast("航点超出可驾驶区域"); return; }
  const r = nav.setGoal(x, z, rover.position);
  if (r.ok) log(`全局路径:${r.length.toFixed(0)} m · ${r.nodes} 节点 · A* ${r.ms.toFixed(0)} ms`);
  else { log("轨道代价地图上无可行路线(坡度 > 25°)", "warn"); toast("无可行路线"); }
}

// ============================================================ sequences
// A sequence is a list of timed/conditional steps advanced each physics tick.
function startDrill() {
  if (S.seq) return toast("已有序列在执行");
  if (S.mode === "AUTONAV") return toast("请先结束自主导航");
  if (Math.abs(vehicle.speed) > 1e-4) return toast("请先停车");
  if (power.soc < 0.3) return toast("电池电量不足 30%,无法钻探");
  // workspace target: 1.95 m ahead of the pivot axis, 0.25 m to the rover's right
  rover.group.updateMatrixWorld(true);
  const local = new THREE.Vector3(-0.25, 0, 1.95);
  const w = local.clone().applyMatrix4(rover.group.matrixWorld);
  w.y = terrain.heightAt(w.x, w.z);
  if (terrain.rocks.topAt(w.x, w.z) > w.y + 0.02) return toast("目标点被岩石覆盖,请移动车辆");
  const n = terrain.normalAt(w.x, w.z, 0.15);
  if (n.y < Math.cos(20 * DEG)) return toast("目标面过陡(> 20°)");
  const inv = rover.group.matrixWorld.clone().invert();
  const tb = w.clone().applyMatrix4(inv);
  const nb = rover.toBody(n);
  const ik = solveDrill([tb.x, tb.y, tb.z], [nb.x, nb.y, nb.z]);
  if (!ik.reachable) return toast(`目标超出机械臂工作空间(误差 ${(ik.error * 100).toFixed(0)} cm)`);
  const pre = solveDrill([tb.x + nb.x * 0.12, tb.y + nb.y * 0.12, tb.z + nb.z * 0.12], [nb.x, nb.y, nb.z]);
  const soil = terrain.soilAt(w.x, w.z);
  const steps = [
    { name: "机械臂展开 · 预定位", enter: () => { S.armGoal = pre.q; log("机械臂解锁 → 预接触位姿(IK 解算)"); }, done: (s) => s.armSettled },
    { name: "接触预载", enter: () => { S.armGoal = ik.q; }, done: (s) => s.armSettled },
    { name: soil === "bedrock" ? "研磨 + 旋转冲击取芯" : "旋转冲击取芯", time: 420, enter: () => { rover.drillSpin = 26; log(`取芯开始 · 目标岩性:${soil === "bedrock" ? "基岩" : soil === "sand" ? "风成沙" : "风化层"}`); }, tick: () => { if (Math.random() < 0.6) dust.emit(rover.drillTipWorld(), 2); } },
    { name: "退钻", enter: () => { rover.drillSpin = 4; S.armGoal = pre.q; }, done: (s) => s.armSettled },
    { name: "收臂", enter: () => { rover.drillSpin = 0; S.armGoal = ARM.stow.slice(); addBorehole(w, n); }, done: (s) => s.armSettled },
    { name: "样本管密封 · 缓存", time: 150, enter: () => log("钻头交接 → 适配式缓存组件 ACA") },
  ];
  runSequence("取芯 CORING", steps, () => {
    S.samples++;
    rover.addSampleTube(S.samples);
    telecom.addData(45);
    log(`✓ 样本管 #${S.samples} 已气密封存(${S.samples}/38)· 数据 45 Mbit 入队`, "ok");
    toast(`岩芯样本 #${S.samples} 已密封缓存`);
  });
}

function addBorehole(p, n) {
  const g = new THREE.Group();
  const abr = new THREE.Mesh(new THREE.CircleGeometry(0.025, 20), new THREE.MeshStandardMaterial({ color: 0x1a0e09, roughness: 1 }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.025, 0.05, 24), new THREE.MeshStandardMaterial({ color: 0x8c6f5e, roughness: 0.9 }));
  g.add(abr, ring);
  g.position.copy(p).addScaledVector(n, 0.004);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  boreholes.add(g);
}

let panoCam = null, panoRT = null;
function startPanorama() {
  if (S.seq) return toast("已有序列在执行");
  if (rover.mastDeploy < 0.99) return toast("请先展开桅杆(M)");
  const N = 12;
  const cv = bind("pano-canvas"), ctx = cv.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
  const sw = cv.width / N, sh = cv.height;
  if (!panoCam) {
    panoCam = new THREE.PerspectiveCamera(32, sw / sh, 0.05, 150000);
    panoRT = new THREE.WebGLRenderTarget(Math.round(sw), Math.round(sh), { colorSpace: THREE.SRGBColorSpace });
  }
  const az0 = S.mastAzGoal = 0;
  const steps = [];
  for (let i = 0; i < N; i++) {
    const az = wrapPi(az0 + (i / N) * Math.PI * 2);
    steps.push({ name: `Mastcam-Z 帧 ${i + 1}/${N}`, enter: () => { S.mastAzGoal = az; S.mastElGoal = -0.08; }, done: (s) => s.mastSettled, after: () => captureFrame(i, ctx, sw, sh) });
  }
  steps.push({ name: "桅杆回中", enter: () => { S.mastAzGoal = 0; S.mastElGoal = -0.15; }, done: (s) => s.mastSettled });
  S.imaging = true;
  runSequence("360° 全景 PANORAMA", steps, () => {
    S.imaging = false;
    telecom.addData(N * 18);
    bind("pano").classList.remove("hidden");
    log(`✓ 360° 全景完成(${N} 帧拼接)· ${N * 18} Mbit 入队待下行`, "ok");
  });
}

function captureFrame(i, ctx, sw, sh) {
  rover.update(0);                      // apply the current mast joint angles
  rover.group.updateMatrixWorld(true);
  const m = rover.mastCamMount;
  m.updateWorldMatrix(true, false);
  const q = new THREE.Quaternion();
  m.matrixWorld.decompose(panoCam.position, q, new THREE.Vector3());
  panoCam.quaternion.copy(q);
  panoCam.rotateY(Math.PI);
  sky.update(panoCam, skyParams);
  renderer.setRenderTarget(panoRT);
  renderer.render(scene, panoCam);
  const W = panoRT.width, H = panoRT.height;
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(panoRT, 0, 0, W, H, buf);
  renderer.setRenderTarget(null);
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  tmp.getContext("2d").putImageData(img, 0, 0);
  ctx.drawImage(tmp, i * sw, 0, sw, sh);
}

function runSequence(name, steps, onDone) {
  S.seq = { name, steps, i: -1, t: 0, onDone };
  S.mode = "SEQUENCE";
  vehicle.cmd = { speed: 0, curvature: 0, spot: 0 };
  log(`▶ 序列开始:${name}`);
  advance();
}

function advance() {
  const q = S.seq;
  if (q.i >= 0) q.steps[q.i].after?.();
  q.i++;
  q.t = 0;
  if (q.i >= q.steps.length) {
    const done = q.onDone;
    S.seq = null;
    S.mode = "MANUAL";
    done?.();
    return;
  }
  q.steps[q.i].enter?.();
}

function tickSequence(dt, flags) {
  const q = S.seq;
  if (!q) return;
  const st = q.steps[q.i];
  q.t += dt;
  st.tick?.(dt);
  if ((st.time !== undefined && q.t >= st.time) || (st.done && st.done(flags))) advance();
}

// ============================================================ input
const input = new InputManager(canvas, {
  onCamera: (n) => {
    cameras.setView(n);
    const v = VIEWS[n];
    bind("cam-name").textContent = v.name;
    bind("cam-overlay").classList.toggle("hidden", !v.onboard);
    bind("cam-overlay").dataset.label = v.name;
  },
  onPick: (ndc) => {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cameras.camera);
    const hit = terrain.raycast(ray.ray.origin, ray.ray.direction);
    if (hit) command("航点", () => setGoal(hit.x, hit.z));
  },
  onChaseOrbit: (dyaw, dist, wheel) => {
    if (cameras.view === 1) cameras.orbitChase(dyaw, dist);
    if (cameras.view === 5 && wheel) cameras.zoomMast(wheel < 0 ? 1 : -1);
  },
  onAction: (a) => {
    switch (a) {
      case "autonav":
        if (S.mode === "AUTONAV") { S.mode = "MANUAL"; vehicle.cmd = { speed: 0, curvature: 0, spot: 0 }; log("自主导航已解除"); }
        else if (!nav.goal) toast("请先点击地面设置航点");
        else if (S.seq) toast("序列执行中");
        else command("AutoNav 启动", () => { S.mode = "AUTONAV"; vehicle.clearFault(); log("AutoNav 启动 → 全局路线 + ENav 局部避障"); });
        break;
      case "clearGoal": nav.clear(); if (S.mode === "AUTONAV") S.mode = "MANUAL"; break;
      case "drill": command("取芯", startDrill); break;
      case "panorama": command("全景", startPanorama); break;
      case "mast": S.mastGoal = S.mastGoal > 0.5 ? 0 : 1; log(S.mastGoal ? "桅杆展开" : "桅杆收拢"); break;
      case "hud": S.hud = !S.hud; bind("hud").classList.toggle("hidden", !S.hud); break;
      case "recenter": cameras.recenter(); break;
      case "map": minimap.toggleMode(); break;
      case "arcs": nav.showArcs = !nav.showArcs; nav._arcs.visible = nav.showArcs; break;
      case "warpUp": warpIdx = Math.min(WARPS.length - 1, warpIdx + 1); break;
      case "warpDown": warpIdx = Math.max(0, warpIdx - 1); break;
      case "skipToMorning": {
        const t = nextLmst(simMs + 3600e3, 9.0);
        power.energyWh = Math.min(power.capacityWh, power.energyWh + ((t - simMs) / 3.6e6) * 30);
        simMs = t;
        log(`⏭ 跳至下一个火星日 09:00 LMST`);
        break;
      }
      case "lightTime": lightTimeMode = !lightTimeMode; log(lightTimeMode ? "光行时延迟模式:开(指令按真实地火延迟执行)" : "光行时延迟模式:关"); break;
      case "allStop": S.mode = "MANUAL"; vehicle.cmd = { speed: 0, curvature: 0, spot: 0 }; log("■ 全部停止"); break;
      case "help": bind("help").classList.toggle("hidden"); break;
      case "zoomIn": cameras.zoomMast(1); break;
      case "zoomOut": cameras.zoomMast(-1); break;
      case "clearFault": if (vehicle.fault) { log(`故障已清除:${vehicle.fault}`); vehicle.clearFault(); } break;
    }
  },
});
bind("pano").addEventListener("click", () => bind("pano").classList.add("hidden"));
bind("help").addEventListener("click", () => bind("help").classList.add("hidden"));

// ============================================================ physics step
S.mastAzGoal = 0; S.mastElGoal = -0.15;
let env = environment(marsTime(simMs), 0, 0);
let lastFault = null;

function physicsStep(h) {
  simMs += h * 1000;

  // delayed commands arriving at the rover
  for (let i = pending.length - 1; i >= 0; i--) {
    if (simMs >= pending[i].at) {
      const p = pending.splice(i, 1)[0];
      log(`↓ 指令「${p.label}」已在火星执行`, "up");
      p.run();
    }
  }

  // mobility command source
  if (S.mode === "AUTONAV") {
    const c = nav.update(rover, vehicle.odometer, performance.now());
    vehicle.cmd = { speed: c.speed, curvature: c.curvature, spot: c.spot };
    if (c.arrived) { S.mode = "MANUAL"; log("✓ 抵达目标 — AutoNav 完成", "ok"); nav.clear(); }
    if (vehicle.fault) { S.mode = "MANUAL"; log(`⚠ 故障保护:${vehicle.fault} — AutoNav 中止`, "warn"); }
  } else if (S.mode === "MANUAL") {
    vehicle.cmd = input.driveCommand(1 / 1.6);
  }

  vehicle.step(h);
  if (vehicle.fault && vehicle.fault !== lastFault) { log(`⚠ 故障保护:${vehicle.fault}(按 B 清除)`, "warn"); toast(vehicle.fault); }
  lastFault = vehicle.fault;

  // arm / mast / HGA actuators
  const armSettled = slew(rover.armQ, S.armGoal, h);
  rover.mastDeploy = approach(rover.mastDeploy, S.mastGoal, h / 25);
  const mc = input.mastCommand();
  if (!S.seq && (mc.pan || mc.tilt)) { S.mastAzGoal = wrapPi(S.mastAzGoal + mc.pan * 0.5 * h); S.mastElGoal = clamp(S.mastElGoal + mc.tilt * 0.4 * h, -1.2, 1.0); }
  rover.mastAz = approach(rover.mastAz, S.mastAzGoal, 0.35 * h);
  rover.mastEl = approach(rover.mastEl, S.mastElGoal, 0.3 * h);
  const mastSettled = Math.abs(rover.mastAz - S.mastAzGoal) < 1e-3 && Math.abs(rover.mastEl - S.mastElGoal) < 1e-3;
  if (telecom.earth && telecom.earth.el > 0) {
    const e = telecom.earth.enu;
    const b = rover.toBody(new THREE.Vector3(e[0], e[2], -e[1]));
    const az = Math.atan2(b.x, b.z), el = Math.asin(clamp(b.y, -1, 1));
    rover.hgaAz = approach(rover.hgaAz, az, 2 * DEG * h);
    rover.hgaEl = approach(rover.hgaEl, clamp(el, -0.2, 1.5), 2 * DEG * h);
  }
  tickSequence(h, { armSettled, mastSettled });

  // power, comms, dust
  const armMoving = !armSettled;
  // wake/sleep: the rover sleeps outside the daytime ops window unless it is
  // driving, sequencing, imaging or in a relay pass
  const awake = (mt.ltst >= 8 && mt.ltst < 17.5) || S.mode !== "MANUAL" || Math.abs(vehicle.speed) > 0 ||
    !!S.seq || cameras.view >= 3 || !!telecom.activePass || input.keys.size > 0;
  S.awake = awake;
  power.step(h, {
    ms: simMs, awake,
    driving: vehicle.driving, arm: armMoving, drilling: rover.drillSpin > 10,
    imaging: S.imaging || cameras.view >= 3, uhf: !!telecom.activePass, xband: telecom.xbandOn,
    heaterDuty: clamp((-55 - env.airC) / 40, 0, 1),
  });
  telecom.update(simMs, h, log, mt.ltst);
  dustUniforms.uDust.value = clamp(dustUniforms.uDust.value + h * (0.004 / 88775) * (1 + env.tau), 0, 0.9);

  // tracks + breadcrumbs
  if (Math.abs(vehicle.speed) > 0) {
    const contacts = rover.wheelContacts().map((c) => ({
      x: c.x, z: c.z, onRock: terrain.contactHeight(c.x, c.z) > terrain.heightAt(c.x, c.z) + 0.03,
    }));
    tracks.update(contacts);
    const last = S.crumbs[S.crumbs.length - 1];
    if (Math.hypot(rover.position.x - last[0], rover.position.z - last[1]) > 1) S.crumbs.push([rover.position.x, rover.position.z]);
  }
}

// ============================================================ environment & lighting
const skyParams = {
  sun: new THREE.Vector3(0, 1, 0), earth: new THREE.Vector3(), phobos: new THREE.Vector3(), deimos: new THREE.Vector3(),
  tau: 0.5, sunScale: 1, moonRad: [0.001, 0.0003], celestial: new THREE.Matrix3(),
};
const enuToWorld = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
let mt = marsTime(simMs), sb = skyBodies(simMs);
let exposure = 1, lastEnvMs = simMs;

function updateEnvironment(dtReal) {
  const jumped = Math.abs(simMs - lastEnvMs) > 1800e3; // time skip: snap exposure
  lastEnvMs = simMs;
  mt = marsTime(simMs);
  sb = skyBodies(simMs);
  const sol = missionSol(simMs);
  env = environment(mt, sol, simMs / 1000);
  if (sol !== S.lastSol) { if (S.lastSol >= 0) log(`☀ 新的火星日 Sol ${sol} 开始`); S.lastSol = sol; }

  skyParams.sun.copy(enuToWorld(mt.sunENU)).normalize();
  skyParams.earth.copy(enuToWorld(sb.earth.enu));
  const mm = moons(simMs);
  skyParams.phobos.copy(enuToWorld(mm[0].enu));
  skyParams.deimos.copy(enuToWorld(mm[1].enu));
  skyParams.moonRad = [(mm[0].angularDiamDeg / 2) * DEG, (mm[1].angularDiamDeg / 2) * DEG];
  skyParams.tau = env.tau;
  skyParams.sunScale = Math.pow(1.524 / mt.rHelioAU, 2);
  // world → Mars-inertial for the star field
  const b = enuBasis(SITE.latDeg, SITE.lonEastDeg);
  const W = marsRotation(simMs).W;
  const c = Math.cos(W), s = Math.sin(W);
  const cols = [b.E, b.U, b.N.map((v) => -v)];
  const m = new THREE.Matrix3().set(
    cols[0][0], cols[1][0], cols[2][0],
    cols[0][1], cols[1][1], cols[2][1],
    cols[0][2], cols[1][2], cols[2][2]);
  const rz = new THREE.Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
  skyParams.celestial.multiplyMatrices(rz, m);

  const L = sky.lighting(skyParams.sun, env.tau, skyParams.sunScale);
  sun.color.copy(L.sunColor);
  sun.intensity = L.sunIntensity;
  hemi.color.copy(L.sky).multiplyScalar(1 / Math.max(0.05, Math.max(L.sky.r, L.sky.g, L.sky.b)));
  hemi.intensity = 0.15 + Math.max(L.sky.r, L.sky.g, L.sky.b) * 0.9;
  hemi.groundColor.set(0x4a2a1c).multiplyScalar(0.4 + hemi.intensity * 0.5);
  scene.fog.color.copy(L.fog).multiplyScalar(0.95);
  scene.fog.density = (env.tau / 0.5) / 26000;

  // auto-exposure (like the rover's cameras, and our eyes) for twilight/night
  // key = ground illuminance (direct · cos + sky); cameras hold exposure while the Sun is up
  const key = sun.intensity * Math.max(skyParams.sun.y, 0.05) * 0.5 + hemi.intensity * 0.6 + 0.02;
  const target = clamp(2.1 / key, 0.8, skyParams.sun.y > 0.02 ? 1.7 : 6);
  exposure = jumped ? target : exposure + (target - exposure) * Math.min(1, dtReal * 1.5);
  renderer.toneMappingExposure = exposure;
  // night: faint starlight / Deimos skylight so night operations stay legible
  const night = 1 - clamp((skyParams.sun.y + 0.12) / 0.1, 0, 1);
  if (night > 0) {
    hemi.color.lerp(new THREE.Color(0x8a96b8), night);
    hemi.groundColor.lerp(new THREE.Color(0x2a2420), night);
    hemi.intensity = Math.max(hemi.intensity, 0.1 * night);
  }

  // shadow frustum follows the rover
  const rp = rover.group.position;
  sun.position.copy(rp).addScaledVector(skyParams.sun.y > 0 ? skyParams.sun : new THREE.Vector3(0, 1, 0), 120);
  sun.target.position.copy(rp);
}

// ============================================================ HUD update
const siteElev = demInfo.dem.elevation(SITE.latDeg, SITE.lonEastDeg);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const SOIL_CN = { regolith: "风化层", sand: "风成沙", bedrock: "基岩/岩石" };
function updateHUD() {
  const sol = missionSol(simMs);
  const [lat, lon] = localToLatLon(rover.position.x, rover.position.z);
  bind("clock").innerHTML =
    `<b>Sol ${sol}</b> · LMST <b>${formatHours(mt.lmst)}</b> · LTST ${formatHours(mt.ltst).slice(0, 5)} · ` +
    `L<sub>s</sub> ${fmt(mt.Ls)}° MY${mt.marsYear} · ${seasonOf(mt.Ls)} · UTC ${new Date(simMs).toISOString().slice(0, 16).replace("T", " ")}`;
  bind("warp").textContent = `时间倍率 ×${WARPS[warpIdx]}`;
  bind("lt").textContent = lightTimeMode ? `光行时延迟 开 · 待执行 ${pending.length}` : "光行时延迟 关";
  bind("lt").classList.toggle("on", lightTimeMode);
  const fb = bind("fault");
  fb.classList.toggle("hidden", !vehicle.fault);
  if (vehicle.fault) fb.textContent = `⚠ 故障保护 · ${vehicle.fault} · 按 B 清除`;

  const modeTxt = S.mode === "AUTONAV" ? nav.status : S.mode === "SEQUENCE" ? `${S.seq.name} · ${S.seq.steps[S.seq.i].name}` : vehicle.mode === "spot" && vehicle.speed ? "原地转向" : S.awake === false ? "休眠 SLEEP" : "手动驾驶";
  const rows = {
    "v-mode": modeTxt,
    "v-pos": `${fmt(lat, 5)}°N ${fmt(lon, 5)}°E`,
    "v-xy": `E ${fmt(rover.position.x)} · N ${fmt(-rover.position.z)} m`,
    "v-elev": `${fmt(siteElev + rover.group.position.y, 1)} m (MOLA)`,
    "v-speed": `${fmt(Math.abs(vehicle.groundSpeed) * 100, 2)} cm/s`,
    "v-att": `${fmt(((rover.heading * RAD) % 360 + 360) % 360, 0)}° / ${fmt(rover.pitch * RAD)}° / ${fmt(rover.roll * RAD)}°`,
    "v-tilt": `${fmt(rover.slope * RAD)}°`,
    "v-odo": `${fmt(vehicle.odometer, 1)} m · VO ${fmt(vehicle.voOdo, 1)} m`,
    "v-slip": `${fmt(vehicle.slip * 100, 0)}% · VO ${fmt(vehicle.measuredSlip * 100, 0)}%`,
    "v-sink": `${fmt(vehicle.sinkage * 100, 1)} cm`,
    "v-soil": `${SOIL_CN[vehicle.dominantSoil]} (${vehicle.soilCounts.regolith}/${vehicle.soilCounts.sand}/${vehicle.soilCounts.bedrock})`,
    "v-trac": `${fmt(vehicle.tractionMargin * 100, 0)}% · 稳定 ${fmt((rover.loads?.stability ?? 1) * 100, 0)}%`,
    "v-samples": `${S.samples} / 38`,
    "p-rtg": `${fmt(power.rtg, 1)} W`,
    "p-load": `${fmt(power.load, 0)} W (${power.net >= 0 ? "+" : ""}${fmt(power.net, 0)})`,
    "p-batt": `${bar(power.soc)} ${fmt(power.soc * 100, 0)}%`,
    "p-break": Object.entries(power.breakdown).filter(([, w]) => w > 0).map(([k, w]) => `${k} ${w.toFixed(0)}`).join(" · "),
    "c-dte": telecom.dte ? `${telecom.xbandOn ? "发射中" : "可用"} · ${telecom.dsn.id} ${telecom.dsn.name} (仰角 ${fmt(telecom.dsn.elDeg, 0)}°)` : telecom.conjunction ? "日凌 — 通信中断" : "无",
    "c-earth": telecom.earth ? `方位 ${fmt(telecom.earth.az, 0)}° 仰角 ${fmt(telecom.earth.el, 1)}°` : "—",
    "c-owlt": `${fmtDur(telecom.owlt)} · 往返 ${fmtDur(telecom.owlt * 2)}`,
    "c-dist": `${fmt(telecom.distanceKm / 1e6, 1)} M km`,
    "c-uhf": (() => {
      if (telecom.activePass) return `过境中 ${telecom.activePass.id} · 余 ${fmtDur((telecom.activePass.los - simMs) / 1000)}`;
      const n = telecom.nextPass(simMs);
      return n ? `${n.id} 于 ${fmtDur((n.aos - simMs) / 1000)} 后 (最高 ${fmt(n.maxEl, 0)}°)` : "—";
    })(),
    "c-rate": `${fmt((telecom.rateMbps || 0) * 1000, 1)} kbps`,
    "c-buf": `${fmt(telecom.bufferMbit, 0)} Mbit 待传 · 已下行 ${fmt(telecom.downlinkedMbit, 0)}`,
    "e-temp": `空气 ${fmt(env.airC, 0)}°C · 地表 ${fmt(env.groundC, 0)}°C`,
    "e-pres": `${fmt(env.pressurePa, 0)} Pa`,
    "e-wind": `${fmt(env.windSpeed, 1)} m/s 来自 ${fmt(env.windDirDeg, 0)}°`,
    "e-tau": `${fmt(env.tau, 2)}`,
    "e-sun": `方位 ${fmt(mt.sunAzDeg, 0)}° 仰角 ${fmt(mt.sunElevDeg, 1)}° · ${fmt(env.surfaceWm2, 0)} W/m²`,
    "e-dust": `${fmt(dustUniforms.uDust.value * 100, 0)}%`,
  };
  for (const k in rows) { const el = bind(k); if (el && el.textContent !== rows[k]) el.textContent = rows[k]; }
  bind("cam-fov").textContent = cameras.view === 5 ? `焦距 ${cameras.mastFocal.toFixed(0)} mm · 视场 ${(cameras.mastFovDeg * 4 / 3).toFixed(1)}°×${cameras.mastFovDeg.toFixed(1)}°` : `视场 ${(cameras.camera.fov).toFixed(0)}° (垂直)`;
  minimap.update(rover, nav, S.crumbs);
  suspView.draw(rover);
  bind("stats").textContent = `${renderer.info.render.calls} draw · ${(renderer.info.render.triangles / 1e6).toFixed(2)} M tri · 岩石 ${rocks.stats ? rocks.stats.lo + rocks.stats.hi : 0}`;
}

// ============================================================ loop
let last = performance.now(), hudT = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  tick(dtReal);
  requestAnimationFrame(frame);
}

function tick(dtReal) {
  const warp = WARPS[warpIdx];
  const simDt = dtReal * warp;
  // fixed physics step 0.1 s (sim); grow the step if the warp outruns 50 substeps
  const steps = Math.min(50, Math.max(1, Math.ceil(simDt / 0.1)));
  const h = simDt / steps;
  for (let i = 0; i < steps; i++) physicsStep(h);
  tracks.flush();
  rover.update(simDt);

  updateEnvironment(dtReal);
  cameras.update(dtReal);
  terrain.update(cameras.camera.position.distanceTo(rover.group.position) < 200 ? rover.group.position : cameras.camera.position);
  rocks.update(rover.group.position);
  const wdir = env.windDirDeg * DEG;
  dust.update(dtReal, cameras.camera.position, { x: -Math.sin(wdir) * env.windSpeed, z: Math.cos(wdir) * env.windSpeed });
  sky.update(cameras.camera, skyParams);

  hudT += dtReal;
  if (S.hud && hudT > 0.1) { hudT = 0; updateHUD(); }
  renderer.render(scene, cameras.camera);
}

addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); cameras.onResize(); });

// settle and go
setLoading("初始化完成", 1);
rover.conform();
terrain.buildInitial(rover.group.position);
rocks.update(rover.group.position, true);
for (let i = 0; i < 3; i++) physicsStep(0.05);
updateEnvironment(1);
cameras.setView(1);
cameras.recenter();
cameras.update(1);
updateHUD();
log(`着陆区:${SITE.name} · ${SITE.latDeg}°N ${SITE.lonEastDeg}°E`);
log(demInfo.real ? `地形:NASA MOLA MEGDR 真实高程(远场 ±60 km)+ 0.5 m 合成近场 · ${near.craters.length} 个陨石坑` : "地形:合成杰泽罗(未找到 DEM)");
log(`轨道代价地图 ${nav.map.n}² · ${mapMs.toFixed(0)} ms · 地火光行时 ${fmtDur(sb.owltSec)}`);
log("按 F1 或 ? 查看操作说明");
bind("loading")?.classList.add("fade");
bind("hud").classList.remove("hidden");
setTimeout(() => bind("loading")?.remove(), 900);
// debugging / automated-test handle
window.__sim = { tick, input, THREE, scene, renderer, rover, vehicle, terrain, rocks, nav, cameras, power, telecom, sky, S, get simMs() { return simMs; }, set simMs(v) { simMs = v; }, setWarp: (w) => { warpIdx = Math.max(0, WARPS.indexOf(w)); } };
requestAnimationFrame(frame);
