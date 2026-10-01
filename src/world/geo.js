// Georeferencing between the local site frame and Mars planetocentric
// coordinates, plus a bicubic sampler over the MOLA MEGDR elevation grid.
// Pure module (usable from the terrain worker and from Node tests).
import { DEG, MARS, SITE } from "../core/constants.js";

const R_M = MARS.radiusKm * 1000;

// Local tangent-plane (x east, z south, metres) ↔ lat/lon (deg). Equirectangular
// about the site — sub-millimetre error over the ±60 km far field we render.
export function localToLatLon(x, z, site = SITE) {
  const lat = site.latDeg - z / (R_M * DEG);
  const lon = site.lonEastDeg + x / (R_M * Math.cos(site.latDeg * DEG) * DEG);
  return [lat, lon];
}

export function latLonToLocal(lat, lon, site = SITE) {
  const z = -(lat - site.latDeg) * R_M * DEG;
  const x = (lon - site.lonEastDeg) * R_M * Math.cos(site.latDeg * DEG) * DEG;
  return [x, z];
}

// Drop of the surface below the tangent plane at horizontal range r.
export const curvatureDrop = (r) => (r * r) / (2 * R_M);

const cubic = (p0, p1, p2, p3, t) =>
  p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));

/**
 * Elevation grid in simple-cylindrical projection.
 * @param elev   Float32Array of elevations (m, MOLA areoid datum)
 * @param meta   { widthPx, heightPx, ppd, latTopDeg, lonLeftDeg }
 */
export class DemGrid {
  constructor(elev, meta) {
    this.elev = elev;
    this.w = meta.widthPx;
    this.h = meta.heightPx;
    this.ppd = meta.ppd;
    this.latTop = meta.latTopDeg;
    this.lonLeft = meta.lonLeftDeg;
    this.meta = meta;
  }

  _at(c, r) {
    c = c < 0 ? 0 : c >= this.w ? this.w - 1 : c;
    r = r < 0 ? 0 : r >= this.h ? this.h - 1 : r;
    return this.elev[r * this.w + c];
  }

  // Catmull-Rom bicubic elevation at lat/lon (pixel centres at +0.5).
  elevation(lat, lon) {
    const fr = (this.latTop - lat) * this.ppd - 0.5;
    const fc = (lon - this.lonLeft) * this.ppd - 0.5;
    const r0 = Math.floor(fr), c0 = Math.floor(fc);
    const tr = fr - r0, tc = fc - c0;
    const rows = [];
    for (let j = -1; j <= 2; j++) {
      rows.push(cubic(
        this._at(c0 - 1, r0 + j), this._at(c0, r0 + j),
        this._at(c0 + 1, r0 + j), this._at(c0 + 2, r0 + j), tc));
    }
    return cubic(rows[0], rows[1], rows[2], rows[3], tr);
  }

  // Elevation relative to the site (m) at local coordinates.
  localHeight(x, z, site = SITE) {
    if (this._siteElev === undefined) this._siteElev = this.elevation(site.latDeg, site.lonEastDeg);
    const [lat, lon] = localToLatLon(x, z, site);
    return this.elevation(lat, lon) - this._siteElev;
  }
}

// Decode the RG16 PNG payload (RGBA bytes) into metres.
export function decodeRG16(rgba, w, h, minM, maxM) {
  const out = new Float32Array(w * h);
  const span = maxM - minM;
  for (let i = 0; i < w * h; i++) {
    out[i] = minM + ((rgba[i * 4] * 256 + rgba[i * 4 + 1]) / 65535) * span;
  }
  return out;
}

// Analytic Jezero stand-in used when the DEM files are absent: a 45 km
// crater (Pike d/D for complex craters) with the western delta fan.
export function syntheticJezero() {
  const ppd = 128, w = 640, h = 640;
  const latTop = 20.8828125, lonLeft = 75.078125;
  const elev = new Float32Array(w * h);
  const center = latLonToLocal(18.38, 77.58);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const lat = latTop - (r + 0.5) / ppd, lon = lonLeft + (c + 0.5) / ppd;
      const [x, z] = latLonToLocal(lat, lon);
      const d = Math.hypot(x - center[0], z - center[1]) / 22500;
      let e = -2200 - 300 * (z / 150000);
      e += d < 1 ? -650 * (1 - d * d * d * d) : 0;
      e += 520 * Math.exp(-Math.pow((d - 1.03) / 0.12, 2));
      const fan = Math.hypot(x - (center[0] - 14000), z - (center[1] - 3000)) / 6000;
      e += 90 * Math.exp(-fan * fan);
      elev[r * w + c] = e;
    }
  }
  return new DemGrid(elev, { widthPx: w, heightPx: h, ppd, latTopDeg: latTop, lonLeftDeg: lonLeft, label: "合成杰泽罗(无 DEM)" });
}
