// Electrical power subsystem: MMRTG + two Li-ion batteries on a 28 V bus.
// Load table values are representative engineering estimates for a
// Perseverance-class rover (W). Positive net power charges the battery.
import { ROVER } from "../core/constants.js";
import { clamp } from "../core/math.js";

export const LOADS = {
  avionics: 62,      // RCE + payload interfaces, awake
  sleep: 22,         // deep sleep keep-alive
  mobility: 185,     // 6 drive + 4 steer actuators, average while driving
  arm: 95,           // 5 arm joints
  drill: 140,        // coring drill percussion + rotation
  cameras: 18,       // Mastcam-Z / NavCam imaging
  uhf: 70,           // Electra-Lite UHF transceiver during a relay pass
  xband: 110,        // SDST + TWTA, direct-to-Earth
  heaterMax: 60,     // actuator / camera survival heaters (WEB is kept warm by MMRTG waste heat)
};

export function rtgWatts(ms) {
  const { bolWatts, launchUtc, degradePerYear } = ROVER.mmrtg;
  const years = Math.max(0, (ms - launchUtc) / (365.25 * 86400000));
  return bolWatts * Math.exp(-degradePerYear * years);
}

export class PowerSystem {
  constructor() {
    const b = ROVER.battery;
    this.capacityWh = b.cells * b.ampHours * b.busVolts; // ≈ 2477 Wh
    this.energyWh = this.capacityWh * 0.82;
    this.breakdown = {};
    this.net = 0;
    this.rtg = 0;
    this.load = 0;
  }

  get soc() { return this.energyWh / this.capacityWh; }

  /**
   * @param dt seconds of simulated time
   * @param state { ms, awake, driving, arm, drilling, imaging, uhf, xband, heaterDuty }
   */
  step(dt, s) {
    const L = LOADS;
    const br = {
      avionics: s.awake ? L.avionics : L.sleep,
      mobility: s.driving ? L.mobility * s.driving : 0,
      arm: s.arm ? L.arm : 0,
      drill: s.drilling ? L.drill : 0,
      cameras: s.imaging ? L.cameras : 0,
      uhf: s.uhf ? L.uhf : 0,
      xband: s.xband ? L.xband : 0,
      heaters: L.heaterMax * clamp(s.heaterDuty || 0, 0, 1),
    };
    let load = 0;
    for (const k in br) load += br[k];
    this.rtg = rtgWatts(s.ms);
    this.load = load;
    this.net = this.rtg - load;
    this.breakdown = br;
    this.energyWh = clamp(this.energyWh + (this.net * dt) / 3600, 0, this.capacityWh);
    return this;
  }
}
