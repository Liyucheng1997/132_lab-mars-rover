window.addEventListener("error", (e) => console.error("RUNTIME:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("PROMISE:", e.reason));

import * as THREE from "three";
import { MarsTerrain } from "./mars.js";
import { Rover } from "./rover.js";
import { CameraRig, VIEWS } from "./cameras.js";
import { InputManager } from "./controls.js";
import { Planner } from "./planning.js";
import { Comms } from "./comms.js";
import { Minimap, bind } from "./ui.js";
import { tryLoadJezeroDEM } from "./dem.js";

// ---------- Renderer / Scene ----------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xc99a73, 0.0016); // suspended dust haze

// ---------- Lighting (Martian: weaker, redder sun) ----------
const sun = new THREE.DirectionalLight(0xffd9b3, 2.1);
sun.position.set(120, 140, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;
const sc = sun.shadow.camera;
sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xd9a877, 0x4a2418, 0.6));
scene.add(new THREE.AmbientLight(0x6a4a3a, 0.35));

// ---------- World ----------
// Load real NASA MOLA elevation for Jezero Crater if the DEM is bundled;
// otherwise fall back to the procedural Jezero surface.
const dem = await tryLoadJezeroDEM();
const terrain = new MarsTerrain({ size: 600, segments: 320, seed: 2021, dem });
scene.add(terrain.group);

const rover = new Rover(terrain);
rover.position.set(20, 0, 20);
rover.heading = Math.PI * 0.75;
scene.add(rover.group);

const planner = new Planner(terrain);
scene.add(planner.visuals);

const cameras = new CameraRig(renderer, rover);
cameras.setView(1);

const comms = new Comms(bind("comm-log"));
const minimap = new Minimap(bind("minimap"), terrain, {
  onWaypoint: (x, z) => setWaypoint(x, z, "地图"),
  onState: ({ mode, zoom }) => {
    bind("map-zoom").textContent = "×" + zoom.toFixed(zoom < 10 ? (zoom % 1 ? 1 : 0) : 0);
    bind("map-local").classList.toggle("active", mode === "local");
    bind("map-global").classList.toggle("active", mode === "global");
  },
});

// Load the real MOLA global Mars map for the minimap's global mode.
(async () => {
  try {
    const meta = await (await fetch("./data/mars_global.json")).json();
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = "./data/" + meta.image;
    });
    minimap.setGlobal(img, meta);
    comms.log("已载入 MOLA 全球地图 — 按 N 查看整个火星");
  } catch (e) { /* global map optional */ }
})();

// Map controls
bind("map-local").addEventListener("click", () => minimap.setMode("local"));
bind("map-global").addEventListener("click", () => minimap.setMode("global"));

// ---------- State ----------
const state = {
  mode: "MANUAL",       // MANUAL | AUTONAV
  speed: 0,
  steerAngle: 0,
  maxSpeed: 2.4,        // sim m/s (real Perseverance ≈ 0.042 m/s; sped up here)
  maxSteer: THREE.MathUtils.degToRad(28),
  wheelbase: 2.1,
  odometer: 0,
  battery: 1.0,
  startTime: performance.now(),
  hudVisible: true,
  roverRadius: 1.35,    // collision footprint (half body length)
  bumped: false,
  samples: 0,           // drilled core samples cached
  drilling: false,
};

// ---------- Input wiring ----------
const input = new InputManager(canvas, {
  onCamera: (n) => { cameras.setView(n); updateCamOverlay(n); },
  onToggleAutoNav: () => toggleAutoNav(),
  onToggleMast: () => rover.setMastDeployed(!rover.mastDeployed),
  onToggleHud: () => {
    state.hudVisible = !state.hudVisible;
    bind("hud").classList.toggle("hidden", !state.hudVisible);
  },
  onRecenter: () => cameras.recenter(),
  onPick: (ndc) => pickWaypoint(ndc),
  onDrill: () => startDrill(),
  onPanorama: () => capturePanorama(),
  onToggleMap: () => minimap.toggleMode(),
});

// ---------- Toast helper ----------
let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = bind("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function toggleAutoNav() {
  if (state.mode === "AUTONAV") {
    state.mode = "MANUAL";
    comms.log("自主导航已解除 → 转手动驾驶");
  } else if (planner.goal) {
    state.mode = "AUTONAV";
    comms.log("自主导航已启用 → 正在驶向航点");
  } else {
    comms.log("自主导航需要航点 — 请先点击地面");
  }
}

const raycaster = new THREE.Raycaster();
function pickWaypoint(ndc) {
  raycaster.setFromCamera(ndc, cameras.camera);
  const hit = raycaster.intersectObject(terrain.mesh, false)[0];
  if (!hit) return;
  setWaypoint(hit.point.x, hit.point.z, "场景");
}

function setWaypoint(x, z, src) {
  if (!terrain.inBounds(x, z)) { toast("航点超出可驾驶区域"); return; }
  const p = new THREE.Vector3(x, terrain.heightAt(x, z), z);
  planner.setGoal(p);
  comms.log(`已设置航点[${src}] (${x.toFixed(0)}, ${z.toFixed(0)}) — 指令上行延迟 ${comms.formatHMS(comms.owlt)}`);
}

function updateCamOverlay(n) {
  const fp = n >= 3;
  bind("crosshair").classList.toggle("hidden", !fp);
  const ov = bind("cam-overlay");
  ov.classList.toggle("hidden", !fp);
  ov.dataset.label = VIEWS[n].name + " · 车载相机";
  bind("cam-name").textContent = VIEWS[n].name;
}

// ---------- Task: drill & cache a core sample ----------
const boreholes = new THREE.Group();
scene.add(boreholes);
function startDrill() {
  if (state.drilling) return;
  if (Math.abs(state.speed) > 0.06) { toast("请先停车再钻探"); return; }
  if (state.mode === "AUTONAV") { toast("钻探前请先解除自主导航(G)"); return; }
  state.drilling = true;
  rover.drilling = true;
  rover.setArmDeployed(true);
  toast("正在钻探… 研磨岩石并取芯");
  comms.log("SHERLOC / 取芯流程启动 — 机械臂已展开");

  setTimeout(() => {
    // place a borehole in front of the rover
    const fx = rover.position.x + Math.sin(rover.heading) * 1.7;
    const fz = rover.position.z + Math.cos(rover.heading) * 1.7;
    const fy = terrain.heightAt(fx, fz);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.14, 0.04, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 1 })
    );
    ring.position.set(fx, fy + 0.02, fz);
    ring.lookAt(fx + terrain.normalAt(fx, fz).x, fy + 1, fz + terrain.normalAt(fx, fz).z);
    ring.rotation.x += Math.PI / 2;
    boreholes.add(ring);

    state.samples += 1;
    state.battery = Math.max(0.2, state.battery - 0.03);
    rover.drilling = false;
    rover.setArmDeployed(false);
    state.drilling = false;
    toast(`岩芯样本 #${state.samples} 已密封并缓存`);
    comms.log(`样本管 #${state.samples} 已气密封存 ✓(缓存 ${state.samples}/38)`);
  }, 2800);
}

// ---------- Task: 360° MastCam-Z panorama (render-to-texture mosaic) ----------
let panoCam, panoRT;
function capturePanorama() {
  if (state.drilling) { toast("请先完成钻探"); return; }
  const cv = bind("pano-canvas");
  const ctx = cv.getContext("2d");
  const N = 12;
  const sw = cv.width / N, sh = cv.height;
  if (!panoCam) {
    panoCam = new THREE.PerspectiveCamera(42, sw / sh, 0.1, 4000);
    panoRT = new THREE.WebGLRenderTarget(Math.round(sw), Math.round(sh));
  }
  const head = new THREE.Vector3();
  rover.mastCamMount.getWorldPosition(head);

  const buf = new Uint8Array(panoRT.width * panoRT.height * 4);
  const tmpCv = document.createElement("canvas");
  tmpCv.width = panoRT.width; tmpCv.height = panoRT.height;
  const tctx = tmpCv.getContext("2d");
  const imgData = tctx.createImageData(panoRT.width, panoRT.height);

  for (let i = 0; i < N; i++) {
    const yaw = rover.heading + (i / N) * Math.PI * 2;
    panoCam.position.copy(head);
    panoCam.lookAt(head.x + Math.sin(yaw), head.y - 0.06, head.z + Math.cos(yaw));
    renderer.setRenderTarget(panoRT);
    renderer.render(scene, panoCam);
    renderer.readRenderTargetPixels(panoRT, 0, 0, panoRT.width, panoRT.height, buf);
    // WebGL pixels are bottom-up; flip rows and apply sRGB gamma
    const W = panoRT.width, H = panoRT.height;
    for (let y = 0; y < H; y++) {
      const sy = (H - 1 - y);
      for (let x = 0; x < W; x++) {
        const s = (sy * W + x) * 4, d = (y * W + x) * 4;
        imgData.data[d] = 255 * Math.pow(buf[s] / 255, 1 / 2.2);
        imgData.data[d + 1] = 255 * Math.pow(buf[s + 1] / 255, 1 / 2.2);
        imgData.data[d + 2] = 255 * Math.pow(buf[s + 2] / 255, 1 / 2.2);
        imgData.data[d + 3] = 255;
      }
    }
    tctx.putImageData(imgData, 0, 0);
    ctx.drawImage(tmpCv, i * sw, 0, sw, sh);
  }
  renderer.setRenderTarget(null);
  bind("pano").classList.remove("hidden");
  toast(`已拍摄 360° 全景 · ${N} 帧`);
  comms.log(`MastCam-Z 360° 全景已采集(${N} 帧)— 已排队下行`);
}
bind("pano").addEventListener("click", () => bind("pano").classList.add("hidden"));

// ---------- Driving model ----------
function drive(dt) {
  let cmd;
  if (state.mode === "AUTONAV") {
    cmd = planner.update(rover, true);
    if (cmd.arrived) {
      state.mode = "MANUAL";
      comms.log("已抵达目标 ✓ — 自主导航完成");
      planner.clearGoal();
    }
  } else {
    cmd = input.manualCommand();
    if (planner.goal) planner.update(rover, false); // keep marker pulsing
  }

  // Lock movement while the arm is drilling
  if (state.drilling) cmd = { throttle: 0, steer: 0 };

  // Slope safety: throttle back on dangerous inclines
  const slopeDeg = rover.slope * 180 / Math.PI;
  const slopeFactor = slopeDeg > 25 ? 0.15 : slopeDeg > 18 ? 0.55 : 1.0;

  // Accelerate speed toward target with limited accel
  const targetSpeed = cmd.throttle * state.maxSpeed * slopeFactor;
  const accel = 1.8;
  state.speed += THREE.MathUtils.clamp(targetSpeed - state.speed, -accel * dt, accel * dt);
  if (Math.abs(state.speed) < 0.005 && cmd.throttle === 0) state.speed = 0;

  // Steering angle eases toward command
  const targetSteer = cmd.steer * state.maxSteer;
  state.steerAngle += (targetSteer - state.steerAngle) * Math.min(1, dt * 6);
  rover.setSteer(state.steerAngle);

  // Yaw: Ackermann while moving, plus a gentle point-turn when nearly stopped
  let yawRate = (state.speed / state.wheelbase) * Math.tan(state.steerAngle);
  if (Math.abs(state.speed) < 0.3 && cmd.throttle === 0 && Math.abs(cmd.steer) > 0) {
    yawRate += cmd.steer * 0.5; // turn in place
    rover.rollWheels(Math.abs(cmd.steer) * 0.4 * dt); // wheels scrub
  }
  rover.heading += yawRate * dt;

  // Integrate position along heading
  const forward = new THREE.Vector3(Math.sin(rover.heading), 0, Math.cos(rover.heading));
  const move = state.speed * dt;
  let nx = rover.position.x + forward.x * move;
  let nz = rover.position.z + forward.z * move;
  if (terrain.inBounds(nx, nz)) {
    // Boulder collision: push the rover out of any overlapping rock
    const res = terrain.resolveCollision(nx, nz, state.roverRadius);
    nx = res.x; nz = res.z;
    if (res.hit) {
      state.speed *= 0.2;            // bump — bleed off momentum
      if (!state.bumped) { comms.log("⚠ 接触障碍物 — 检测到车轮打滑"); state.bumped = true; }
    } else {
      state.bumped = false;
    }
    const realMove = Math.hypot(nx - rover.position.x, nz - rover.position.z);
    rover.position.x = nx;
    rover.position.z = nz;
    state.odometer += realMove;
    rover.rollWheels(Math.sign(move) * realMove);
    // power draw while driving
    state.battery = Math.max(0.2, state.battery - realMove * 0.00008);
  } else {
    state.speed = 0;
  }
  // RTG slowly recharges battery when not driving hard
  state.battery = Math.min(1, state.battery + dt * 0.001);

  rover.update(dt);
}

// ---------- HUD ----------
function updateHUD(now) {
  // Mars Sol clock — a sol is 24h 39m 35s
  const elapsed = (now - state.startTime) / 1000;
  const solSeconds = 88775;
  const sol = Math.floor(elapsed / solSeconds);
  const inSol = elapsed % solSeconds;
  const lmstScale = 86400 / solSeconds;
  const lmst = inSol * lmstScale;
  const hh = String(Math.floor(lmst / 3600)).padStart(2, "0");
  const mm = String(Math.floor((lmst % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(lmst % 60)).padStart(2, "0");

  bind("t-sol").textContent = 100 + sol;
  bind("t-lmst").textContent = `${hh}:${mm}:${ss}`;
  bind("t-mode").textContent = state.mode === "AUTONAV" ? planner.status : "手动驾驶";
  bind("t-speed").textContent = `${Math.abs(state.speed).toFixed(2)} m/s`;
  bind("t-heading").textContent = `${((rover.heading * 180 / Math.PI % 360 + 360) % 360).toFixed(0)}°`;
  bind("t-slope").textContent = `${(rover.slope * 180 / Math.PI).toFixed(1)}°`;
  bind("t-odo").textContent = `${state.odometer.toFixed(1)} m`;
  bind("t-power").textContent = `110 W`;
  bind("t-batt").textContent = `${Math.round(state.battery * 100)}%`;
  bind("t-samples").textContent = `${state.samples} / 38`;

  bind("c-link").textContent = comms.station;
  bind("c-owlt").textContent = comms.formatHMS(comms.owlt);
  bind("c-rtt").textContent = comms.formatHMS(comms.rtt);
  bind("c-dist").textContent = `${(comms.distanceKm / 1e6).toFixed(1)}M km`;
  bind("c-rate").textContent = `${comms.dataRateMbps.toFixed(1)} Mbps`;
  bind("c-signal").textContent = "●".repeat(comms.signalBars) + "○".repeat(5 - comms.signalBars);

  minimap.update(rover, planner.goal);
}

// ---------- Loop ----------
let last = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  drive(dt);
  cameras.update(dt);
  comms.update(now, rover, state.mode);
  if (state.hudVisible) updateHUD(now);

  renderer.render(scene, cameras.camera);
  requestAnimationFrame(loop);
}

// ---------- Boot ----------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameras.onResize();
});

cameras.recenter();
bind("t-terrain").textContent = dem ? "真实 MOLA DEM" : "程序化生成";
comms.log("航天器状态正常 · 等待指令");
comms.log(dem
  ? `地形:真实 NASA MOLA 高程数据 · ${dem.label}`
  : "地形:程序化杰泽罗坑(未加载 DEM)");
comms.log(`地火单向光行时 ${comms.formatHMS(comms.owlt)}`);

// Settle the rover onto the terrain before the first paint.
for (let i = 0; i < 4; i++) { drive(0.05); cameras.update(0.05); }
updateHUD(performance.now());
renderer.render(scene, cameras.camera);

bind("loading").classList.add("hidden");
bind("hud").classList.remove("hidden");
setTimeout(() => bind("loading").remove(), 900);
loop();
