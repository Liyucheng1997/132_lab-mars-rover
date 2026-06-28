// Deep Space Network communication model.
// Computes real Earth–Mars geometry (simplified circular heliocentric orbits)
// to derive light-time delay, then simulates DSN/UHF-relay telemetry.
const AU = 149_597_870.7;          // km
const C = 299_792.458;             // km/s
const J2000 = Date.UTC(2000, 0, 1, 12) / 86400000; // days

// Mean longitudes / orbital elements (deg, deg/day) — simplified, circular
const EARTH = { a: 1.00000, period: 365.256, L0: 100.46 };
const MARS  = { a: 1.52371, period: 686.980, L0: 355.45 };

function planetXY(p, days) {
  const L = THREE_RAD((p.L0 + (360 / p.period) * days) % 360);
  return [p.a * Math.cos(L), p.a * Math.sin(L)];
}
function THREE_RAD(d) { return (d * Math.PI) / 180; }

export class Comms {
  constructor(logEl) {
    this.logEl = logEl;
    this.stations = ["DSN-14 Goldstone", "DSN-63 Madrid", "DSN-43 Canberra"];
    this.stationIdx = 0;
    this.orbiters = ["MRO", "Mars Odyssey", "MAVEN", "ESA TGO"];
    this.lastLog = 0;
    this.lastStationSwitch = 0;
    this.packetSeq = 1000;
    this._refresh(new Date());
  }

  _refresh(date) {
    const days = date.getTime() / 86400000 - J2000;
    const [ex, ey] = planetXY(EARTH, days);
    const [mx, my] = planetXY(MARS, days);
    const distAU = Math.hypot(mx - ex, my - ey);
    this.distanceKm = distAU * AU;
    this.owlt = this.distanceKm / C;              // seconds, one-way
    this.rtt = this.owlt * 2;
    // Direct-to-Earth X-band rate falls with distance²; UHF relay is steadier
    const norm = THREE_CLAMP((4.0e8 - this.distanceKm) / (3.5e8), 0, 1);
    this.dataRateMbps = (0.5 + norm * 1.5);       // 0.5–2.0 Mbps
    this.signalBars = Math.round(1 + norm * 4);   // 1–5
  }

  formatHMS(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
    return `${s}s`;
  }

  log(msg) {
    const line = document.createElement("div");
    line.className = "ln";
    const stamp = new Date().toLocaleTimeString("en-GB");
    line.textContent = `${stamp}  ${msg}`;
    this.logEl.appendChild(line);
    while (this.logEl.children.length > 6) this.logEl.removeChild(this.logEl.firstChild);
  }

  update(now, rover, mode) {
    // periodic telemetry downlink packets
    if (now - this.lastLog > 2600) {
      this.lastLog = now;
      const orb = this.orbiters[Math.floor(Math.random() * this.orbiters.length)];
      const modeCN = mode === "AUTONAV" ? "自主导航" : "手动";
      const kinds = [
        `遥测包 #${this.packetSeq++} 经 ${orb} 中继`,
        `位姿确认:航向 ${((rover.heading * 180 / Math.PI) % 360).toFixed(0)}° ✓`,
        `IMU + 视觉里程计正常 · 坡度 ${(rover.slope * 180 / Math.PI).toFixed(1)}°`,
        `图像下行:NavCam 左/右像对`,
        `电源:RTG 110W · 电池正常`,
        `${modeCN}指令已确认(延迟 ${this.formatHMS(this.owlt)})`,
      ];
      this.log(kinds[Math.floor(Math.random() * kinds.length)]);
    }
    // rotate DSN station occasionally (Earth rotation hands off antennas)
    if (now - this.lastStationSwitch > 18000) {
      this.lastStationSwitch = now;
      this.stationIdx = (this.stationIdx + 1) % this.stations.length;
      this.log(`测控站切换 → ${this.stations[this.stationIdx]}`);
    }
  }

  get station() { return this.stations[this.stationIdx]; }
}

function THREE_CLAMP(v, a, b) { return Math.max(a, Math.min(b, v)); }
