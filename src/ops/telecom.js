// Telecommunications: direct-to-Earth X-band via the HGA and UHF relay passes.
// Link availability is computed from real geometry (ephemeris.js):
//   DTE  — Earth above the local horizon, a DSN complex with Mars above its
//          horizon, and Sun–Earth separation clear of solar conjunction
//   UHF  — relay orbiter overflights predicted from their orbits
// Science/engineering data accumulate in onboard storage and drain through
// whichever link is up.
import { dsnVisibility, orbiterPasses, skyBodies } from "../physics/ephemeris.js";

export class Telecom {
  constructor() {
    this.bufferMbit = 120;      // stored data awaiting downlink
    this.downlinkedMbit = 0;
    this.passes = [];
    this.activePass = null;
    this.dte = false;
    this.xbandOn = false;
    this.dsn = null;
    this.earth = null;
    this.owlt = 0;
    this.distanceKm = 0;
    this.conjunction = false;
    this._nextPassRefresh = 0;
    this._lastSky = 0;
  }

  addData(mbit) { this.bufferMbit += mbit; }

  // DTE X-band rate falls off with range²; ~2 kbps … 30 kbps to a 70 m dish.
  dteRateKbps() {
    const au = this.distanceKm / 1.496e8;
    return Math.min(30, Math.max(0.5, 6.5 / (au * au)));
  }

  // ltst: local true solar time — DTE sessions are scheduled in a morning
  // window (09:00–11:00 LTST) when Earth is up; UHF relay carries the bulk.
  update(ms, dt, log, ltst = 10) {
    // sky geometry is cheap but needn't run every substep
    if (Math.abs(ms - this._lastSky) > 5000) {
      this._lastSky = ms;
      const sky = skyBodies(ms);
      this.earth = sky.earth;
      this.owlt = sky.owltSec;
      this.distanceKm = sky.earthDistKm;
      this.conjunction = sky.sunEarthSepDeg < 3;
      const vis = dsnVisibility(ms);
      this.dsn = vis[0].elDeg > 10 ? vis[0] : null;
      this.dsnAll = vis;
      const was = this.dte;
      this.dte = !this.conjunction && this.earth.el > 10 && !!this.dsn;
      if (this.dte !== was && log) log(this.dte ? `X 频段对地链路建立 · ${this.dsn.id} ${this.dsn.name}` : "对地链路中断(地球落山 / 测控站交接)");
    }

    if (ms > this._nextPassRefresh || !this.passes.length) {
      this.passes = orbiterPasses(ms - 30 * 60e3).filter((p) => p.los > ms);
      this._nextPassRefresh = ms + 2 * 3600e3;
    }
    const prev = this.activePass;
    this.activePass = this.passes.find((p) => ms >= p.aos && ms < p.los) || null;
    if (this.activePass && this.activePass !== prev && log) log(`UHF 中继过境开始 · ${this.activePass.id} 最大仰角 ${this.activePass.maxEl.toFixed(0)}°`);
    if (prev && !this.activePass && log) {
      log(`UHF 过境结束 · ${prev.id}`);
      this.passes = this.passes.filter((p) => p !== prev);
    }

    this.xbandOn = this.dte && this.bufferMbit > 0 && ltst >= 9 && ltst < 11;
    let rate = 0; // Mbit/s
    if (this.activePass) rate += this.activePass.rateMbps;
    if (this.xbandOn) rate += this.dteRateKbps() / 1000;
    const out = Math.min(this.bufferMbit, rate * dt);
    this.bufferMbit -= out;
    this.downlinkedMbit += out;
    this.rateMbps = rate;
  }

  nextPass(ms) { return this.passes.find((p) => p.aos > ms) || null; }
}
