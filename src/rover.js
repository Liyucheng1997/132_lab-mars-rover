import * as THREE from "three";

// Perseverance-class rover, built from primitives.
// Forward direction is local +Z. Wheels: front/mid/rear × left/right.
// Corner wheels (front + rear) steer; rocker-bogie suspension follows terrain.
export class Rover {
  constructor(terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();

    // --- physical parameters (metres) ---
    this.wheelRadius = 0.34;
    this.trackHalf = 0.92;       // half distance between left/right wheels
    this.bodyClearance = 0.62;   // body underside above wheel axle plane
    this.wheelDefs = [
      { name: "FL", x: -this.trackHalf, z: 1.05, steer: true },
      { name: "FR", x: this.trackHalf, z: 1.05, steer: true },
      { name: "ML", x: -this.trackHalf, z: 0.0, steer: false },
      { name: "MR", x: this.trackHalf, z: 0.0, steer: false },
      { name: "RL", x: -this.trackHalf, z: -1.05, steer: true, rear: true },
      { name: "RR", x: this.trackHalf, z: -1.05, steer: true, rear: true },
    ];
    this.wheels = [];

    this._buildBody();
    this._buildSuspensionAndWheels();
    this._buildMast();
    this._buildArm();
    this._buildRTG();
    this._buildAntennas();
    this._buildIngenuity();

    this.mastDeployed = true;
    this.heading = 0;           // yaw, radians
    this.position = new THREE.Vector3(20, 0, 20);
    this.steerAngle = 0;
    this._armTargetX = 0;       // arm stow(0) → drill-down pose
    this.drilling = false;
  }

  setArmDeployed(down) { this._armTargetX = down ? 1.0 : 0; }

  // ---------------- BODY ----------------
  _buildBody() {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xdcdcd2, roughness: 0.55, metalness: 0.35 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xcaa75a, roughness: 0.4, metalness: 0.7 });
    this.bodyMat = bodyMat;

    this.chassis = new THREE.Group();
    // Warm Electronics Box (WEB) — main body
    const web = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.55, 2.1), bodyMat);
    web.castShadow = true;
    this.chassis.add(web);

    // Gold thermal blanket trim
    const trim = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 2.15), goldMat);
    trim.position.y = -0.2;
    this.chassis.add(trim);

    // Top deck equipment
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 1.9), bodyMat);
    deck.position.y = 0.32;
    this.chassis.add(deck);

    // The chassis floats at body height; suspension is separate
    this.chassis.position.y = this.wheelRadius + this.bodyClearance;
    this.group.add(this.chassis);
  }

  // ---------------- ROCKER-BOGIE + WHEELS ----------------
  _buildSuspensionAndWheels() {
    const linkMat = new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.5, metalness: 0.6 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.85, metalness: 0.2 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xb8b8b0, roughness: 0.4, metalness: 0.7 });

    this.suspension = new THREE.Group();
    this.suspension.position.y = this.wheelRadius + this.bodyClearance;
    this.group.add(this.suspension);

    for (const def of this.wheelDefs) {
      // steer pivot (vertical axis)
      const steerPivot = new THREE.Group();
      steerPivot.position.set(def.x, -this.bodyClearance, def.z);

      // suspension strut from body down to wheel
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, this.bodyClearance, 8), linkMat);
      strut.position.y = this.bodyClearance / 2;
      strut.castShadow = true;
      steerPivot.add(strut);

      // roll pivot (wheel spins around X)
      const rollPivot = new THREE.Group();

      // tire — Perseverance wheels have grousers (treads) and are aluminum
      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(this.wheelRadius, this.wheelRadius, 0.4, 24, 1, false),
        tireMat
      );
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      rollPivot.add(tire);

      // hub
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.42, 12), hubMat);
      hub.rotation.z = Math.PI / 2;
      rollPivot.add(hub);

      // grousers (treads) — small boxes around the rim for visual grip
      for (let g = 0; g < 18; g++) {
        const a = (g / 18) * Math.PI * 2;
        const grouser = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.08), hubMat);
        grouser.position.set(0, Math.sin(a) * this.wheelRadius, Math.cos(a) * this.wheelRadius);
        grouser.rotation.x = -a;
        rollPivot.add(grouser);
      }

      steerPivot.add(rollPivot);
      this.suspension.add(steerPivot);
      this.wheels.push({ def, steerPivot, rollPivot, contactY: 0 });
    }

    // Visible rocker links connecting the wheels (cosmetic)
    for (const side of [-1, 1]) {
      const x = side * this.trackHalf;
      const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 2.3), linkMat);
      rocker.position.set(x, this.wheelRadius + this.bodyClearance - 0.1, 0);
      rocker.castShadow = true;
      this.group.add(rocker);
    }
  }

  // ---------------- REMOTE SENSING MAST ----------------
  _buildMast() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5, metalness: 0.4 });
    this.mastPivot = new THREE.Group();
    this.mastPivot.position.set(-0.45, 0.6, 0.85); // front-left of deck
    this.chassis.add(this.mastPivot);

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.3, 10), mat);
    pole.position.y = 0.65;
    pole.castShadow = true;
    this.mastPivot.add(pole);

    // Camera head (RSM) — houses Mastcam-Z + SuperCam + Navcams
    this.mastHead = new THREE.Group();
    this.mastHead.position.y = 1.35;
    this.mastPivot.add(this.mastHead);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.22), mat);
    head.castShadow = true;
    this.mastHead.add(head);

    // Two Mastcam-Z "eyes"
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.2, metalness: 0.8 });
    for (const dx of [-0.15, 0.15]) {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), lensMat);
      lens.rotation.x = Math.PI / 2;
      lens.position.set(dx, 0.02, 0.14);
      this.mastHead.add(lens);
    }
    // SuperCam aperture (round, top center)
    const superCam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 12), lensMat);
    superCam.rotation.x = Math.PI / 2;
    superCam.position.set(0, 0.06, 0.14);
    this.mastHead.add(superCam);

    // mount point where the virtual MastCam THREE.Camera attaches (looks +Z)
    this.mastCamMount = new THREE.Object3D();
    this.mastCamMount.position.set(0, 0.02, 0.18);
    this.mastHead.add(this.mastCamMount);
  }

  // ---------------- ROBOTIC ARM ----------------
  _buildArm() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xc8c8c0, roughness: 0.5, metalness: 0.5 });
    this.armBase = new THREE.Group();
    this.armBase.position.set(0, 0.0, 1.05); // front of body
    this.chassis.add(this.armBase);

    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), mat);
    this.armBase.add(shoulder);

    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), mat);
    upper.position.set(0, -0.1, 0.35);
    upper.rotation.x = Math.PI / 2.4;
    upper.castShadow = true;
    this.armBase.add(upper);

    const elbow = new THREE.Group();
    elbow.position.set(0, -0.32, 0.62);
    this.armBase.add(elbow);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 8), mat);
    fore.position.set(0, -0.22, 0.05);
    fore.castShadow = true;
    elbow.add(fore);

    // Turret (instrument cluster) at the end
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 10), mat);
    turret.position.set(0, -0.46, 0.1);
    elbow.add(turret);
  }

  // ---------------- MMRTG (power) ----------------
  _buildRTG() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a6a66, roughness: 0.6, metalness: 0.6 });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x4a4a48, roughness: 0.7, metalness: 0.5 });
    this.rtg = new THREE.Group();
    this.rtg.position.set(0, 0.25, -1.25); // back of rover
    this.rtg.rotation.x = -0.35;
    this.chassis.add(this.rtg);

    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.7, 12), mat);
    core.rotation.x = Math.PI / 2;
    core.castShadow = true;
    this.rtg.add(core);

    // cooling fins radiating outward
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.36, 0.7), finMat);
      fin.position.set(Math.cos(a) * 0.28, Math.sin(a) * 0.28, 0);
      fin.rotation.z = a;
      this.rtg.add(fin);
    }
  }

  // ---------------- ANTENNAS ----------------
  _buildAntennas() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd0d0c8, roughness: 0.5, metalness: 0.4 });
    // High-Gain Antenna (HGA) — to Earth (X-band), hexagonal flat dish
    this.hga = new THREE.Group();
    this.hga.position.set(0.45, 0.45, -0.6);
    this.chassis.add(this.hga);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 6), mat);
    dish.rotation.x = -0.3;
    dish.castShadow = true;
    this.hga.add(dish);

    // Low-Gain UHF antenna — to orbiters (relay)
    const uhf = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8), mat);
    uhf.position.set(-0.5, 0.6, -0.7);
    uhf.castShadow = true;
    this.chassis.add(uhf);
    const uhfTip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mat);
    uhfTip.position.set(-0.5, 0.88, -0.7);
    this.chassis.add(uhfTip);
  }

  // ---------------- INGENUITY HELICOPTER (stowed companion) ----------------
  _buildIngenuity() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0a8, roughness: 0.4, metalness: 0.5 });
    this.heli = new THREE.Group();
    this.heli.position.set(0.0, -0.45, -0.2);
    this.chassis.add(this.heli);
    const fuselage = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), mat);
    this.heli.add(fuselage);
    const solar = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 0.34), new THREE.MeshStandardMaterial({ color: 0x223044, metalness: 0.6, roughness: 0.3 }));
    solar.position.y = 0.28;
    this.heli.add(solar);
    this.heliRotor = new THREE.Group();
    this.heliRotor.position.y = 0.24;
    for (const r of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.01, 0.04), mat);
      blade.rotation.y = r;
      this.heliRotor.add(blade);
    }
    this.heli.add(this.heliRotor);
    // legs
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.2, 6), mat);
      leg.position.set(s * 0.1, -0.18, 0);
      this.heli.add(leg);
    }
  }

  // ---------------- ANIMATION HELPERS ----------------
  setSteer(angle) {
    this.steerAngle = angle;
    for (const w of this.wheels) {
      if (!w.def.steer) continue;
      // rear corner wheels steer opposite for tighter turning
      w.steerPivot.rotation.y = w.def.rear ? -angle : angle;
    }
  }

  rollWheels(distance) {
    const dTheta = distance / this.wheelRadius;
    for (const w of this.wheels) w.rollPivot.rotation.x += dTheta;
  }

  setMastDeployed(deployed) {
    this.mastDeployed = deployed;
    // stow folds the mast forward & down
    this.mastTargetX = deployed ? 0 : -1.25;
  }

  // Sit the rover on the terrain using a 3-point plane fit (rocker-bogie behaviour)
  updateSuspension() {
    const t = this.terrain;
    const cos = Math.cos(this.heading), sin = Math.sin(this.heading);

    // Sample terrain under several wheels to estimate the support plane
    let avgY = 0;
    const pts = [];
    for (const w of this.wheels) {
      const lx = w.def.x, lz = w.def.z;
      const wx = this.position.x + (lx * cos + lz * sin);
      const wz = this.position.z + (-lx * sin + lz * cos);
      const gy = t.heightAt(wx, wz);
      pts.push(new THREE.Vector3(lx, gy, lz));
      avgY += gy;
    }
    avgY /= this.wheels.length;

    // Fit a tilt from front-rear and left-right height differences
    const frontY = (t.heightAt(
      this.position.x + (this.wheelDefs[0].z * sin),
      this.position.z + (this.wheelDefs[0].z * cos)) +
      t.heightAt(this.position.x + (this.wheelDefs[1].z * sin),
        this.position.z + (this.wheelDefs[1].z * cos))) / 2;
    const n = t.normalAt(this.position.x, this.position.z);

    // Position group
    this.group.position.set(this.position.x, avgY, this.position.z);

    // Orientation: yaw to heading, then tilt to terrain normal
    const up = n.clone();
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    // project forward onto the plane perpendicular to up
    forward.sub(up.clone().multiplyScalar(forward.dot(up))).normalize();
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, forward);
    this.group.quaternion.setFromRotationMatrix(m);

    this.slope = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));

    // Per-wheel vertical compliance so each wheel hugs the ground
    for (const w of this.wheels) {
      const lx = w.def.x, lz = w.def.z;
      const wx = this.position.x + (lx * cos + lz * sin);
      const wz = this.position.z + (-lx * sin + lz * cos);
      const gy = t.heightAt(wx, wz);
      const localDrop = (gy - avgY); // approximate
      w.steerPivot.position.y = -this.bodyClearance + THREE.MathUtils.clamp(localDrop, -0.25, 0.25);
    }

    // Smooth mast stow/deploy
    if (this.mastTargetX !== undefined) {
      this.mastPivot.rotation.x += (this.mastTargetX - this.mastPivot.rotation.x) * 0.08;
    }
  }

  update(dt) {
    this.updateSuspension();
    if (this.heliRotor) this.heliRotor.rotation.y += dt * 2; // idle shimmer
    // Robotic arm deploy / stow, with a drilling vibration at full extension
    const vib = this.drilling ? Math.sin(performance.now() * 0.05) * 0.03 : 0;
    this.armBase.rotation.x += (this._armTargetX + vib - this.armBase.rotation.x) * 0.12;
  }
}
