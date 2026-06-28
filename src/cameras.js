import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Manages the active view camera and the rover's onboard camera mounts.
export const VIEWS = {
  1: { name: "跟随视角", fov: 55 },
  2: { name: "自由视角", fov: 50 },
  3: { name: "导航相机 NavCam", fov: 45 },
  4: { name: "避障相机 HazCam", fov: 105 },   // wide front hazard cam
  5: { name: "桅杆相机 MastCam-Z", fov: 18 }, // telephoto
};

export class CameraRig {
  constructor(renderer, rover) {
    this.rover = rover;
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 4000);
    this.camera.position.set(25, 12, 30);

    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI / 2.05;
    this.orbit.minDistance = 3;
    this.orbit.maxDistance = 220;
    this.orbit.enabled = false;

    this.view = 1;
    this._chasePos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  setView(n) {
    if (!VIEWS[n]) return;
    this.view = n;
    this.camera.fov = VIEWS[n].fov;
    this.camera.updateProjectionMatrix();
    this.orbit.enabled = n === 2;
    if (n === 2) {
      // park the orbit target on the rover
      this.orbit.target.copy(this.rover.group.position);
    }
  }

  recenter() {
    const r = this.rover;
    const back = new THREE.Vector3(-Math.sin(r.heading), 0, -Math.cos(r.heading));
    this._chasePos.copy(r.group.position).addScaledVector(back, 9).add(new THREE.Vector3(0, 6, 0));
    this.camera.position.copy(this._chasePos);
  }

  update(dt) {
    const r = this.rover;
    const rp = r.group.position;

    if (this.view === 2) {
      this.orbit.target.lerp(rp, 0.05);
      this.orbit.update();
      return;
    }

    if (this.view === 1) {
      // smooth chase behind & above
      const back = new THREE.Vector3(-Math.sin(r.heading), 0, -Math.cos(r.heading));
      const desired = this._tmp.copy(rp).addScaledVector(back, 8.5).add(new THREE.Vector3(0, 5.5, 0));
      this.camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
      this.camera.lookAt(rp.x, rp.y + 1.2, rp.z);
      return;
    }

    // First-person onboard cameras — derive world transform from mounts
    let mount, lookOffsetY = 0;
    if (this.view === 3 || this.view === 5) {
      mount = r.mastCamMount;            // NAVCAM / MASTCAM on the mast head
    } else if (this.view === 4) {
      // HAZCAM: low on the front of the body
      this._frontHazMount = this._frontHazMount || new THREE.Object3D();
      if (!this._frontHazMount.parent) {
        this._frontHazMount.position.set(0, -0.25, 1.15);
        r.chassis.add(this._frontHazMount);
      }
      mount = this._frontHazMount;
    }
    if (mount) {
      mount.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      mount.matrixWorld.decompose(wp, wq, new THREE.Vector3());
      this.camera.position.copy(wp);
      this.camera.quaternion.copy(wq);
      // mounts look down local +Z; the camera looks down -Z, so flip
      this.camera.rotateY(Math.PI);
    }
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
