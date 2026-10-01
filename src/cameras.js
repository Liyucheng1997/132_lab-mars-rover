import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Camera rig: external views plus the rover's engineering and science
// cameras at their mounting points, with representative fields of view
// (three.js fov is vertical).
//   NavCam  (EECAM)   96° × 73°
//   HazCam  (EECAM)  136° × 102°
//   Mastcam-Z         25.6° × 19.2° (26 mm) … 6.2° × 4.6° (110 mm) zoom
export const VIEWS = {
  1: { name: "跟随视角 Chase", fov: 50 },
  2: { name: "自由视角 Orbit", fov: 50 },
  3: { name: "导航相机 NavCam", fov: 62, onboard: true },
  4: { name: "前避障相机 Front HazCam", fov: 92, onboard: true },
  5: { name: "桅杆相机 Mastcam-Z", fov: 19.2, onboard: true, zoom: true },
  6: { name: "后避障相机 Rear HazCam", fov: 92, onboard: true },
};

export class CameraRig {
  constructor(renderer, rover) {
    this.rover = rover;
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 150000);
    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 2;
    this.orbit.maxDistance = 600;
    this.orbit.enabled = false;
    this.view = 1;
    this.mastFocal = 26;                 // Mastcam-Z focal length (mm)
    this.chaseDist = 7.5;
    this.chaseYaw = 0;
    this._tmp = new THREE.Vector3();
    this._lastRover = new THREE.Vector3();
  }

  setView(n) {
    if (!VIEWS[n]) return;
    this.view = n;
    this.orbit.enabled = n === 2;
    if (n === 2) {
      this.orbit.target.copy(this.rover.group.position).add(new THREE.Vector3(0, 1, 0));
      this._lastRover.copy(this.rover.group.position);
    }
    this._applyFov();
  }

  zoomMast(dir) {
    this.mastFocal = Math.min(110, Math.max(26, this.mastFocal * (dir > 0 ? 1.15 : 1 / 1.15)));
    this._applyFov();
  }

  get mastFovDeg() {
    // sensor height 7.4 mm (1600 px × 7.4 µm) → vertical FOV
    return (2 * Math.atan(8.9 / (2 * this.mastFocal)) * 180) / Math.PI;
  }

  _applyFov() {
    this.camera.fov = this.view === 5 ? this.mastFovDeg : VIEWS[this.view].fov;
    this.camera.updateProjectionMatrix();
  }

  recenter() {
    this.chaseYaw = 0;
    this.chaseDist = 7.5;
  }

  orbitChase(dx, dist) {
    this.chaseYaw += dx;
    if (dist) this.chaseDist = Math.min(40, Math.max(3.5, this.chaseDist * dist));
  }

  update(dt) {
    const r = this.rover;
    const rp = r.group.position;
    if (this.view === 2) {
      // follow the rover by translating both target and camera
      const d = this._tmp.copy(rp).sub(this._lastRover);
      this.orbit.target.add(d);
      this.camera.position.add(d);
      this._lastRover.copy(rp);
      this.orbit.update();
      return;
    }
    if (this.view === 1) {
      const h = r.heading + Math.PI + this.chaseYaw;
      const desired = this._tmp.set(
        rp.x + Math.sin(h) * this.chaseDist,
        rp.y + 2.2 + this.chaseDist * 0.35,
        rp.z - Math.cos(h) * this.chaseDist
      );
      this.camera.position.lerp(desired, 1 - Math.pow(0.02, dt));
      this.camera.lookAt(rp.x, rp.y + 1.0, rp.z);
      return;
    }
    const mount = this.view === 3 ? r.navCamMount
      : this.view === 4 ? r.hazFrontMount
      : this.view === 5 ? r.mastCamMount
      : r.hazRearMount;
    mount.updateWorldMatrix(true, false);
    const q = new THREE.Quaternion();
    mount.matrixWorld.decompose(this.camera.position, q, this._tmp);
    this.camera.quaternion.copy(q);
    this.camera.rotateY(Math.PI); // mounts look down +Z, cameras down −Z
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
