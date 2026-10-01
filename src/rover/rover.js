import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ROVER } from "../core/constants.js";
import { ARM, forward } from "../physics/armKinematics.js";
import { linkage, solveSide, solveVehicle, wheelLoadSplit, lateralLoad } from "../physics/rockerBogie.js";
import { createRoverMaterials } from "./roverMaterials.js";

// Perseverance-class rover — geometry, articulation and terrain conformance.
// Body frame: +Z forward, +Y up, +X = rover LEFT. Origin: ground level directly
// below the midpoint of the two rocker pivots.
const S = ROVER.suspension;
const WR = ROVER.wheel.radius, WW = ROVER.wheel.width;
const TH = ROVER.trackHalf;
const BEAM_X = TH - 0.17;               // rocker/bogie beams run just inboard of the wheels
const KNUCKLE_Y = 0.66;

// ------------------------------------------------------------ helpers
function mesh(geo, mat, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

// Rectangular-section beam between two points (local coords of its parent).
function beam(a, b, w, h, mat) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const m = mesh(new RoundedBoxGeometry(w, h, len, 2, Math.min(w, h) * 0.3), mat);
  orientBeam(m, a, b);
  return m;
}

function orientBeam(m, a, b) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  const dir = B.clone().sub(A).normalize();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
}

function cyl(r, len, mat, seg = 20, axis = "y") {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === "x") g.rotateZ(Math.PI / 2);
  if (axis === "z") g.rotateX(Math.PI / 2);
  return mesh(g, mat);
}

// ------------------------------------------------------------ wheel
// Machined aluminium drum, 48 gently curved grousers, six curved titanium
// flexure spokes, hub motor on the inboard face. Axle along X, outboard = +X.
function buildWheelGeometries() {
  const R = WR, w = WW;
  // drum: lathe profile (r, axial) → outer skin, outboard lip, inner skin
  const prof = [
    [R - 0.012, -w / 2], [R, -w / 2 + 0.006], [R, w / 2 - 0.006], [R - 0.004, w / 2],
    [R - 0.03, w / 2 + 0.002], [R - 0.036, w / 2 - 0.006], [R - 0.006, w / 2 - 0.01],
    [R - 0.006, -w / 2 + 0.01], [R - 0.02, -w / 2 + 0.004],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const drum = new THREE.LatheGeometry(prof, 72);
  drum.rotateZ(-Math.PI / 2);

  // grousers
  const gh = ROVER.wheel.grouserHeight * 1.6, gt = 0.006, N = ROVER.wheel.grousers;
  const one = [];
  const steps = 10;
  const pos = [];
  const idx = [];
  for (let i = 0; i <= steps; i++) {
    const ax = -w / 2 + 0.01 + ((w - 0.02) * i) / steps;
    const curve = 0.05 * Math.sin((Math.PI * i) / steps);          // gentle sweep
    for (const [rr, da] of [[R, -gt / R], [R + gh, -gt / (R * 2)], [R + gh, gt / (R * 2)], [R, gt / R]]) {
      const a = curve + da;
      pos.push(ax, Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < 3; k++) {
      const a = i * 4 + k, b = a + 1, c = a + 4, d = a + 5;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g1 = new THREE.BufferGeometry();
  g1.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g1.setIndex(idx);
  for (let k = 0; k < N; k++) one.push(g1.clone().rotateX((k / N) * Math.PI * 2));
  const grousers = mergeGeometries(one);
  grousers.computeVertexNormals();
  const drumMerged = mergeGeometries([drum.toNonIndexed(), grousers.toNonIndexed()].map((g) => {
    g.deleteAttribute("uv"); return g;
  }));
  drumMerged.computeVertexNormals();

  // spokes + hub (titanium)
  const parts = [];
  for (let k = 0; k < ROVER.wheel.spokes; k++) {
    const a0 = (k / ROVER.wheel.spokes) * Math.PI * 2;
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.125) {
      const r = 0.075 + t * (R - 0.09);
      const a = a0 + 0.55 * Math.sin(Math.PI * t) + 0.25 * t;    // S-curved flexure
      pts.push(new THREE.Vector3(w / 2 - 0.035 - 0.03 * Math.sin(Math.PI * t), Math.cos(a) * r, Math.sin(a) * r));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.011, 6, false);
    tube.deleteAttribute("uv");
    parts.push(tube.toNonIndexed());
  }
  const hub = new THREE.CylinderGeometry(0.08, 0.09, 0.1, 24).rotateZ(Math.PI / 2).translate(w / 2 - 0.05, 0, 0);
  hub.deleteAttribute("uv");
  parts.push(hub.toNonIndexed());
  const spokes = mergeGeometries(parts);
  spokes.computeVertexNormals();

  const motor = new THREE.CylinderGeometry(0.085, 0.085, 0.15, 24).rotateZ(Math.PI / 2).translate(-w / 2 + 0.04, 0, 0);
  return { drum: drumMerged, spokes, motor };
}

// ------------------------------------------------------------ rover
export class Rover {
  constructor(terrain) {
    this.terrain = terrain;
    this.mats = createRoverMaterials();
    this.group = new THREE.Group();          // world transform of the body
    this.body = new THREE.Group();           // body-frame content
    this.group.add(this.body);

    this.position = new THREE.Vector3();     // pivot-axis midpoint, horizontal
    this.heading = 0;                        // azimuth from north, clockwise (rad)
    this.pitch = 0; this.roll = 0; this.slope = 0;
    this.sinkage = 0;
    this.link = linkage(S);
    this._solve = { left: null, right: null };
    this.wheels = [];
    this.loads = null;

    // articulation state
    this.armQ = ARM.stow.slice();
    this.mastDeploy = 1;                     // 0 stowed … 1 deployed
    this.mastAz = 0; this.mastEl = -0.15;
    this.hgaAz = 0; this.hgaEl = 0.6;
    this.drillSpin = 0;

    this._buildBody();
    this._buildMobility();
    this._buildDifferential();
    this._buildMast();
    this._buildArm();
    this._buildRTG();
    this._buildAntennas();
    this._buildSampling();
    this._buildCameras();
  }

  // ---------------------------------------------------------- structure
  _buildBody() {
    const M = this.mats;
    const B = this.body;
    // Warm Electronics Box
    const web = mesh(new RoundedBoxGeometry(1.46, 0.48, 1.86, 3, 0.04), M.paint);
    web.position.set(0, 0.86, -0.04);
    B.add(web);
    // belly: gold MLI + RIMFAX radar antenna aft
    const belly = mesh(new RoundedBoxGeometry(1.4, 0.06, 1.8, 2, 0.02), M.gold);
    belly.position.set(0, 0.6, -0.04);
    B.add(belly);
    const rimfax = mesh(new THREE.BoxGeometry(0.42, 0.06, 0.3), M.anodizedBlack);
    rimfax.position.set(0.0, 0.55, -0.88);
    B.add(rimfax);
    // top deck plate with edge rails
    const deck = mesh(new RoundedBoxGeometry(1.5, 0.05, 1.92, 2, 0.015), M.paint);
    deck.position.set(0, 1.12, -0.04);
    B.add(deck);
    for (const sx of [-1, 1]) {
      const rail = mesh(new THREE.BoxGeometry(0.035, 0.05, 1.86), M.aluminium);
      rail.position.set(sx * 0.73, 1.16, -0.04);
      B.add(rail);
      // cable harness trays along the sides
      const tray = mesh(new THREE.BoxGeometry(0.05, 0.05, 1.5), M.cable);
      tray.position.set(sx * 0.745, 0.72, -0.05);
      B.add(tray);
      // rocker pivot bearing housings
      const brg = cyl(0.085, 0.24, M.aluminium, 24, "x");
      brg.position.set(sx * (0.73 + 0.1), S.rockerPivot[1], S.rockerPivot[0]);
      B.add(brg);
    }
    // front face: dark sample-handling bay + hazcam bracket
    const bay = mesh(new THREE.BoxGeometry(1.0, 0.3, 0.04), M.anodizedBlack);
    bay.position.set(0.05, 0.86, 0.9);
    B.add(bay);
    // deck equipment: avionics boxes, MEDA, calibration targets, plaque
    const boxes = [[0.25, 0.12, 0.3, 0.35, -0.25], [0.32, 0.1, 0.22, -0.15, -0.45], [0.2, 0.08, 0.25, 0.42, 0.25]];
    for (const [w, h, d, x, z] of boxes) {
      const bx = mesh(new RoundedBoxGeometry(w, h, d, 2, 0.01), M.silverMli);
      bx.position.set(x, 1.145 + h / 2, z);
      B.add(bx);
    }
    // Mastcam-Z calibration target (colour chips) on the deck near the mast
    const cal = new THREE.BoxGeometry(0.1, 0.012, 0.1, 4, 1, 4);
    const colors = [];
    const chip = [[0.8, 0.1, 0.1], [0.1, 0.6, 0.15], [0.1, 0.2, 0.75], [0.9, 0.8, 0.1], [0.92, 0.92, 0.9], [0.05, 0.05, 0.05]];
    const pos = cal.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = Math.floor((pos.getX(i) + 0.05) * 30) + 3 * Math.floor((pos.getZ(i) + 0.05) * 20);
      const c = chip[((k % chip.length) + chip.length) % chip.length];
      colors.push(...c);
    }
    cal.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const calM = mesh(cal, M.calTarget);
    calM.position.set(-0.45, 1.16, 0.45);
    B.add(calM);
    const post = cyl(0.008, 0.08, M.anodizedBlack, 8);
    post.position.set(-0.45, 1.19, 0.45);
    B.add(post);
    const plaque = mesh(new THREE.BoxGeometry(0.16, 0.006, 0.1), M.aluminium);
    plaque.position.set(0.5, 1.15, -0.65);
    B.add(plaque);
  }

  // ---------------------------------------------------------- mobility
  _buildMobility() {
    const M = this.mats;
    const geo = buildWheelGeometries();
    this.sides = {};
    for (const [side, sx] of [["left", 1], ["right", -1]]) {
      const P = [sx * BEAM_X, S.rockerPivot[1], S.rockerPivot[0]];
      const rocker = new THREE.Group();
      rocker.position.set(...P);
      this.body.add(rocker);
      // pivot shaft through the body bearing
      const shaft = cyl(0.05, 0.22, M.titanium, 16, "x");
      shaft.position.x = -sx * 0.08;
      rocker.add(shaft);

      // rocker arms (rocker-local coords: pivot at origin)
      const rel = (p) => [0, p[1] - S.rockerPivot[1], p[0] - S.rockerPivot[0]];
      const FK = rel([S.front[0], KNUCKLE_Y]);
      const BP = rel(S.bogiePivot);
      rocker.add(beam([0, 0, 0], FK, 0.07, 0.09, M.titanium));
      rocker.add(beam([0, 0, 0], BP, 0.07, 0.1, M.titanium));
      const hubP = cyl(0.075, 0.12, M.actuator, 20, "x");
      rocker.add(hubP);
      // differential lever rising from the pivot
      const lever = beam([0, 0, 0], [0, 0.28, 0], 0.045, 0.045, M.titanium);
      rocker.add(lever);

      const bogie = new THREE.Group();
      bogie.position.set(...BP);
      rocker.add(bogie);
      const bp = cyl(0.06, 0.13, M.actuator, 20, "x");
      bogie.add(bp);
      const relB = (p) => [0, p[1] - S.bogiePivot[1], p[0] - S.bogiePivot[0]];
      const MK = relB([S.mid[0], 0.5]);
      const RK = relB([S.rear[0], KNUCKLE_Y]);
      bogie.add(beam([0, 0, 0], MK, 0.06, 0.08, M.titanium));
      bogie.add(beam([0, 0, 0], RK, 0.06, 0.08, M.titanium));

      const mk = (parent, knuckle, centre, steer, name) => {
        // knuckle: arm end → (steering actuator) → bracket → wheel
        const k = new THREE.Group();
        k.position.set(...knuckle);
        parent.add(k);
        const stub = beam([0, 0, 0], [sx * (TH - BEAM_X), 0, 0], 0.07, 0.07, M.titanium);
        k.add(stub);
        const steerG = new THREE.Group();
        steerG.position.set(sx * (TH - BEAM_X), 0, 0);
        k.add(steerG);
        if (steer) {
          const act = cyl(0.07, 0.13, M.actuator, 20);
          act.position.y = 0.02;
          steerG.add(act);
          const cap = cyl(0.074, 0.02, M.aluminium, 20);
          cap.position.y = 0.09;
          steerG.add(cap);
        }
        // C-bracket down the inboard side to the hub
        const dy = centre[1] - knuckle[1];
        const inX = -sx * (WW / 2 + 0.05);
        steerG.add(beam([0, -0.02, 0], [inX, -0.06, 0], 0.05, 0.05, M.titanium));
        steerG.add(beam([inX, -0.06, 0], [inX, dy, 0], 0.055, 0.06, M.titanium));
        const wheelG = new THREE.Group();
        wheelG.position.set(0, dy, 0);
        wheelG.scale.x = sx; // mirror so the spoke face is outboard on both sides
        steerG.add(wheelG);
        const spin = new THREE.Group();
        wheelG.add(spin);
        spin.add(mesh(geo.drum, M.wheel));
        spin.add(mesh(geo.spokes, M.titanium));
        wheelG.add(mesh(geo.motor, M.actuator));
        const w = { side, name, steer, steerG, spin, group: wheelG, angle: 0 };
        this.wheels.push(w);
        return w;
      };
      const front = mk(rocker, FK, rel(S.front), true, "front");
      const mid = mk(bogie, MK, relB(S.mid), false, "mid");
      const rear = mk(bogie, RK, relB(S.rear), true, "rear");
      this.sides[side] = { rocker, bogie, lever, front, mid, rear, sx };
    }
  }

  _buildDifferential() {
    const M = this.mats;
    this.diff = new THREE.Group();
    this.diff.position.set(0, 1.2, -0.3);
    this.body.add(this.diff);
    const bar = mesh(new RoundedBoxGeometry(1.66, 0.05, 0.08, 2, 0.015), M.titanium);
    this.diff.add(bar);
    const piv = cyl(0.06, 0.08, M.actuator);
    this.diff.add(piv);
    this.diffLinks = [];
    for (const sx of [1, -1]) {
      const link = mesh(new RoundedBoxGeometry(0.035, 0.035, 1, 2, 0.01), M.titanium);
      this.body.add(link);
      this.diffLinks.push({ link, sx });
    }
  }

  // ---------------------------------------------------------- remote sensing mast
  _buildMast() {
    const M = this.mats;
    this.mastBase = new THREE.Group();
    this.mastBase.position.set(-0.52, 1.15, 0.7);     // front-right of the deck
    this.body.add(this.mastBase);
    const foot = cyl(0.09, 0.08, M.actuator, 20);
    this.mastBase.add(foot);
    this.mastDeployJ = new THREE.Group();             // deploy hinge (about X)
    this.mastDeployJ.position.y = 0.05;
    this.mastBase.add(this.mastDeployJ);
    this.mastAzJ = new THREE.Group();                 // azimuth (about Y)
    this.mastDeployJ.add(this.mastAzJ);
    const pole = mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.86, 20), M.paint);
    pole.position.y = 0.43;
    this.mastAzJ.add(pole);
    // MEDA wind-sensor booms
    for (const [a, y] of [[0.4, 0.55], [-2.2, 0.62]]) {
      const boom = beam([0, y, 0], [Math.sin(a) * 0.22, y + 0.02, Math.cos(a) * 0.22], 0.015, 0.015, M.aluminium);
      this.mastAzJ.add(boom);
      const tip = cyl(0.02, 0.05, M.anodizedBlack, 10);
      tip.position.set(Math.sin(a) * 0.22, y + 0.02, Math.cos(a) * 0.22);
      this.mastAzJ.add(tip);
    }
    this.mastElJ = new THREE.Group();                 // elevation (about X)
    this.mastElJ.position.y = 0.9;
    this.mastAzJ.add(this.mastElJ);
    const yoke = mesh(new RoundedBoxGeometry(0.5, 0.06, 0.12, 2, 0.02), M.actuator);
    yoke.position.y = -0.04;
    this.mastElJ.add(yoke);
    const head = mesh(new RoundedBoxGeometry(0.46, 0.2, 0.26, 3, 0.03), M.paint);
    head.position.set(0, 0.08, 0.02);
    this.mastElJ.add(head);
    // SuperCam: 110 mm telescope aperture, centred on top
    const sc = cyl(0.075, 0.12, M.paint, 28, "z");
    sc.position.set(0, 0.19, 0.06);
    this.mastElJ.add(sc);
    const scLens = cyl(0.055, 0.01, M.glass, 28, "z");
    scLens.position.set(0, 0.19, 0.125);
    this.mastElJ.add(scLens);
    // Mastcam-Z stereo pair (24.2 cm baseline) and NavCams (42.4 cm baseline)
    for (const sx of [-1, 1]) {
      const mz = cyl(0.038, 0.13, M.anodizedBlack, 20, "z");
      mz.position.set(sx * 0.121, 0.09, 0.14);
      this.mastElJ.add(mz);
      const mzl = cyl(0.026, 0.006, M.glass, 20, "z");
      mzl.position.set(sx * 0.121, 0.09, 0.208);
      this.mastElJ.add(mzl);
      const nc = mesh(new RoundedBoxGeometry(0.07, 0.06, 0.08, 2, 0.01), M.anodizedBlack);
      nc.position.set(sx * 0.212, 0.03, 0.13);
      this.mastElJ.add(nc);
      const ncl = cyl(0.018, 0.006, M.glass, 16, "z");
      ncl.position.set(sx * 0.212, 0.03, 0.172);
      this.mastElJ.add(ncl);
    }
    this.mastCamMount = new THREE.Object3D();
    this.mastCamMount.position.set(0, 0.09, 0.21);
    this.mastElJ.add(this.mastCamMount);
    this.navCamMount = new THREE.Object3D();
    this.navCamMount.position.set(0, 0.03, 0.18);
    this.mastElJ.add(this.navCamMount);
  }

  // ---------------------------------------------------------- 5-DOF robotic arm
  _buildArm() {
    const M = this.mats;
    this.arm = {};
    const j1 = new THREE.Group();
    j1.position.set(...ARM.shoulder);
    this.body.add(j1);
    j1.add(cyl(0.09, 0.14, M.actuator, 20));
    const j2 = new THREE.Group();
    j1.add(j2);
    j2.add(cyl(0.08, 0.2, M.actuator, 20, "x"));
    j2.add(beam([0, 0, 0.05], [0, 0, ARM.L1 - 0.05], 0.09, 0.1, M.paint));
    const j3 = new THREE.Group();
    j3.position.z = ARM.L1;
    j2.add(j3);
    j3.add(cyl(0.075, 0.18, M.actuator, 20, "x"));
    j3.add(beam([0, 0, 0.05], [0, 0, ARM.L2 - 0.05], 0.08, 0.085, M.paint));
    const j4 = new THREE.Group();
    j4.position.z = ARM.L2;
    j3.add(j4);
    j4.add(cyl(0.065, 0.16, M.actuator, 20, "x"));
    const j5 = new THREE.Group();
    j4.add(j5);

    // Turret (~45 kg): coring drill on the tool axis, PIXL, SHERLOC/WATSON,
    // GDRTT and the contact sensor arranged around it.
    const T = new THREE.Group();
    j5.add(T);
    const core = mesh(new RoundedBoxGeometry(0.22, 0.22, 0.2, 3, 0.04), M.paint);
    core.position.z = ARM.L3 * 0.6;
    T.add(core);
    const drillBody = cyl(0.07, 0.3, M.paint, 20, "z");
    drillBody.position.z = ARM.L3 + 0.05;
    T.add(drillBody);
    this.drillBit = new THREE.Group();
    this.drillBit.position.z = ARM.L3 + 0.2;
    T.add(this.drillBit);
    const bit = cyl(0.016, 0.1, M.aluminium, 12, "z");
    bit.position.z = 0.05;
    this.drillBit.add(bit);
    const flute = mesh(new THREE.TorusGeometry(0.017, 0.004, 6, 12), M.titanium);
    flute.position.z = 0.03;
    this.drillBit.add(flute);
    const pixl = mesh(new RoundedBoxGeometry(0.16, 0.14, 0.18, 2, 0.02), M.silverMli);
    pixl.position.set(0.17, 0, ARM.L3 * 0.6);
    T.add(pixl);
    const sherloc = cyl(0.06, 0.2, M.anodizedBlack, 16, "z");
    sherloc.position.set(-0.16, 0.02, ARM.L3 * 0.7);
    T.add(sherloc);
    const watson = cyl(0.025, 0.05, M.glass, 12, "z");
    watson.position.set(-0.16, 0.02, ARM.L3 * 0.7 + 0.11);
    T.add(watson);
    const gdrtt = cyl(0.045, 0.12, M.aluminium, 16, "z");
    gdrtt.position.set(0, 0.16, ARM.L3 * 0.6);
    T.add(gdrtt);
    const fcs = cyl(0.01, 0.16, M.titanium, 8, "z");
    fcs.position.set(0, -0.15, ARM.L3 * 0.7);
    T.add(fcs);
    this.arm = { j1, j2, j3, j4, j5, turret: T };
  }

  // ---------------------------------------------------------- MMRTG + heat rejection
  _buildRTG() {
    const M = this.mats;
    this.rtg = new THREE.Group();
    this.rtg.position.set(0, 1.12, -1.24);
    this.rtg.rotation.x = -2.44;            // tail-up, ~40° above horizontal, aft
    this.body.add(this.rtg);
    const core = cyl(0.2, 0.66, M.rtg, 24, "z");
    this.rtg.add(core);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const fin = mesh(new THREE.BoxGeometry(0.012, 0.13, 0.62), M.rtg);
      fin.position.set(Math.cos(a) * 0.265, Math.sin(a) * 0.265, 0);
      fin.rotation.z = a + Math.PI / 2;
      this.rtg.add(fin);
    }
    for (const z of [-0.34, 0.34]) {
      const cap = cyl(0.23, 0.03, M.anodizedBlack, 24, "z");
      cap.position.z = z;
      this.rtg.add(cap);
    }
    // heat-rejection system panels (the rover's "wings")
    for (const sx of [-1, 1]) {
      const hrs = mesh(new RoundedBoxGeometry(0.03, 0.42, 0.6, 2, 0.01), M.paint);
      hrs.position.set(sx * 0.46, 1.1, -1.18);
      hrs.rotation.order = "YXZ";
      hrs.rotation.set(-2.44 + Math.PI, sx * 0.4, 0);
      this.body.add(hrs);
      const pipe = beam([sx * 0.42, 0.95, -0.9], [sx * 0.2, 1.0, -1.05], 0.025, 0.025, M.cable);
      this.body.add(pipe);
    }
  }

  // ---------------------------------------------------------- antennas
  _buildAntennas() {
    const M = this.mats;
    // High-gain antenna: hexagonal flat plate on a 2-axis gimbal (X-band DTE)
    this.hgaBase = new THREE.Group();
    this.hgaBase.position.set(0.48, 1.15, -0.55);
    this.body.add(this.hgaBase);
    this.hgaBase.add(cyl(0.05, 0.22, M.actuator, 16));
    this.hgaAzJ = new THREE.Group();
    this.hgaAzJ.position.y = 0.16;
    this.hgaBase.add(this.hgaAzJ);
    this.hgaElJ = new THREE.Group();
    this.hgaAzJ.add(this.hgaElJ);
    this.hgaElJ.add(cyl(0.04, 0.14, M.actuator, 16, "x"));
    const plate = cyl(0.3, 0.035, M.paint, 6, "z");
    plate.position.z = 0.06;
    plate.rotation.z = Math.PI / 6;
    this.hgaElJ.add(plate);
    const face = cyl(0.27, 0.005, M.silverMli, 6, "z");
    face.position.z = 0.08;
    face.rotation.z = Math.PI / 6;
    this.hgaElJ.add(face);
    // UHF quadrifilar helix (relay to orbiters)
    const uhf = cyl(0.045, 0.3, M.paint, 16);
    uhf.position.set(-0.35, 1.3, -0.7);
    this.body.add(uhf);
    const helix = mesh(new THREE.TorusKnotGeometry(0.047, 0.004, 64, 4, 1, 8), M.cable);
    helix.position.set(-0.35, 1.3, -0.7);
    helix.scale.set(1, 3, 1);
    this.body.add(helix);
    // low-gain X-band
    const lga = cyl(0.03, 0.12, M.paint, 12);
    lga.position.set(0.22, 1.2, -0.85);
    this.body.add(lga);
  }

  // ---------------------------------------------------------- sample handling
  _buildSampling() {
    const M = this.mats;
    // Bit carousel: the large disk at the front of the rover
    this.carousel = new THREE.Group();
    this.carousel.position.set(0.25, 0.86, 0.94);
    this.carousel.rotation.x = 0.45;
    this.body.add(this.carousel);
    this.carousel.add(cyl(0.24, 0.07, M.paint, 36, "z"));
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const port = cyl(0.025, 0.02, M.anodizedBlack, 10, "z");
      port.position.set(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.04);
      this.carousel.add(port);
    }
    this.sampleTubes = new THREE.Group();
    this.body.add(this.sampleTubes);
  }

  // ---------------------------------------------------------- engineering cameras
  _buildCameras() {
    const M = this.mats;
    const pair = (z, y, x0, base, tilt, back) => {
      const g = new THREE.Group();
      g.position.set(x0, y, z);
      g.rotation.order = "YXZ";
      g.rotation.set(tilt, back ? Math.PI : 0, 0);
      this.body.add(g);
      for (const sx of [-1, 1]) {
        const c = mesh(new RoundedBoxGeometry(0.07, 0.06, 0.07, 2, 0.01), M.anodizedBlack);
        c.position.x = (sx * base) / 2;
        g.add(c);
        const l = cyl(0.016, 0.006, M.glass, 12, "z");
        l.position.set((sx * base) / 2, 0, 0.036);
        g.add(l);
      }
      const mount = new THREE.Object3D();
      mount.position.z = 0.05;
      g.add(mount);
      return mount;
    };
    this.hazFrontMount = pair(0.96, 0.72, -0.2, 0.248, 0.5, false);
    this.hazRearMount = pair(-1.0, 0.75, 0.0, 0.248, 0.45, true);
  }

  // ======================================================== articulation API
  setSteer(angles) {
    // angles: {front, rear} × {left, right} in radians (rotation about body +Y)
    for (const w of this.wheels) {
      if (!w.steer) continue;
      const a = angles[w.side]?.[w.name] ?? 0;
      w.angle = a;
      w.steerG.rotation.y = a;
    }
  }

  rollWheels(dist) {
    // dist: per-wheel rolled distance {left: {front, mid, rear}, right: ...}
    for (const w of this.wheels) w.spin.rotation.x += (dist[w.side]?.[w.name] ?? 0) / WR;
  }

  // Place the vehicle on the terrain: solve both suspension sides and the
  // differential, then set the body pose. Called every physics step.
  conform() {
    const t = this.terrain;
    const h = this.heading;
    const fx = Math.sin(h), fz = -Math.cos(h);  // forward (world)
    const lx = fz, lz = -fx;                    // left = up × forward... (+X body)
    const px = this.position.x, pz = this.position.z;
    const side = (sx) => (s) => t.contactHeight(px + fx * s + lx * sx * TH, pz + fz * s + lz * sx * TH);
    const L = solveSide(side(1), this.link, S.rockerPivot[0], this._solve.left);
    const R = solveSide(side(-1), this.link, S.rockerPivot[0], this._solve.right);
    this._solve.left = L; this._solve.right = R;
    const v = solveVehicle(L, R, TH);
    this.pitch = v.pitch; this.roll = v.roll;

    // body pose
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - h);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -v.pitch));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), v.roll));
    this.group.quaternion.copy(q);
    const pivotOffset = new THREE.Vector3(0, S.rockerPivot[1], S.rockerPivot[0]).applyQuaternion(q);
    this.group.position.set(px - pivotOffset.x + fx * S.rockerPivot[0], v.pivotY - pivotOffset.y - this.sinkage, pz - pivotOffset.z + fz * S.rockerPivot[0]);

    // joints relative to the body
    for (const [name, s] of [["left", L], ["right", R]]) {
      const sd = this.sides[name];
      sd.rocker.rotation.x = -v.rockerRel[name];
      sd.bogie.rotation.x = -s.bogieRel;
    }
    // differential bar: rocker levers push the bar ends fore/aft
    const lever = 0.28;
    const dz = lever * Math.sin(v.rockerRel.left);
    this.diff.rotation.y = Math.asin(Math.max(-1, Math.min(1, (2 * dz) / 1.66)));
    for (const { link, sx } of this.diffLinks) {
      const side = sx > 0 ? "left" : "right";
      const a = v.rockerRel[side];
      const tip = [sx * BEAM_X, S.rockerPivot[1] + lever * Math.cos(a), S.rockerPivot[0] - lever * Math.sin(a)];
      const end = new THREE.Vector3(sx * 0.8, 0, 0).applyEuler(this.diff.rotation).add(this.diff.position);
      orientBeam(link, tip, [end.x, end.y, end.z]);
      link.scale.z = Math.hypot(tip[0] - end.x, tip[1] - end.y, tip[2] - end.z);
    }

    // terrain slope under the vehicle (for HUD / safety)
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    this.slope = Math.acos(Math.min(1, n.y));

    // static wheel loads (fractions of total weight)
    const lat = lateralLoad(v.roll, TH, 0.95);
    const sl = wheelLoadSplit(L), sr = wheelLoadSplit(R);
    this.loads = {
      left: { front: sl.front * lat.left, mid: sl.mid * lat.left, rear: sl.rear * lat.left },
      right: { front: sr.front * (1 - lat.left), mid: sr.mid * (1 - lat.left), rear: sr.rear * (1 - lat.left) },
      stability: lat.margin,
    };
    this.suspension = { L, R, v };
  }

  // World position of each wheel's ground contact (for tracks & soil queries).
  wheelContacts() {
    const out = [];
    const p = new THREE.Vector3();
    this.group.updateMatrixWorld(true);
    for (const w of this.wheels) {
      w.group.getWorldPosition(p);
      out.push({ wheel: w, x: p.x, y: p.y - WR, z: p.z, side: w.side, name: w.name });
    }
    return out;
  }

  update(dt) {
    // mast deploy / pan / tilt
    this.mastDeployJ.rotation.x = -(1 - this.mastDeploy) * 1.45;
    this.mastAzJ.rotation.y = this.mastAz;
    this.mastElJ.rotation.x = -this.mastEl;
    // HGA gimbal
    this.hgaAzJ.rotation.y = this.hgaAz;
    this.hgaElJ.rotation.x = -this.hgaEl;
    // arm joints (see armKinematics for conventions)
    const [q1, q2, q3, q4, q5] = this.armQ;
    this.arm.j1.rotation.y = q1;
    this.arm.j2.rotation.x = -q2;
    this.arm.j3.rotation.x = -q3;
    this.arm.j4.rotation.x = -q4;
    this.arm.j5.rotation.z = q5;
    this.drillBit.rotation.z += this.drillSpin * dt;
  }

  // Drill tip in world space (for borehole placement / particles).
  drillTipWorld() {
    const tip = forward(this.armQ).tip;
    return new THREE.Vector3(...tip).applyMatrix4(this.group.matrixWorld);
  }

  addSampleTube(n) {
    const tube = cyl(0.014, 0.16, this.mats.titanium, 10, "x");
    tube.position.set(0.1 - (n % 10) * 0.035, 0.62, -0.2 - Math.floor(n / 10) * 0.05);
    this.sampleTubes.add(tube);
  }

  // Body-frame vector of a world direction (for gimbal pointing).
  toBody(worldDir) {
    return worldDir.clone().applyQuaternion(this.group.quaternion.clone().invert());
  }
}
