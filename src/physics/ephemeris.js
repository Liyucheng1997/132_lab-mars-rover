// Solar-system geometry for the rover's sky:
//   • heliocentric Earth / Mars from JPL Keplerian elements (Standish, 1800–2050)
//   • IAU 2009 Mars rotation model (pole + prime meridian) → body-fixed frame
//   • local azimuth / elevation of the Sun, Earth, Phobos, Deimos, relay orbiters
//   • DSN complex visibility of Mars (which antenna can hold the link)
// All pure functions; directions are returned as local ENU unit vectors.
import { AU_KM, C_KMS, DEG, RAD, MARS, DSN, ORBITERS, SITE } from "../core/constants.js";
import { mod, v3, rotX, rotZ } from "../core/math.js";
import { julianDateTT, julianDateUT, marsTime } from "./marsTime.js";

// [a, e, I, L, ϖ, Ω] and their rates per Julian century.
const ELEMENTS = {
  earth: [
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  ],
  mars: [
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  ],
};
const OBLIQUITY = 23.43928 * DEG;

// Heliocentric J2000 *equatorial* position (AU).
export function helioPosition(body, ms) {
  const T = (julianDateTT(ms) - 2451545.0) / 36525;
  const [e0, rate] = ELEMENTS[body];
  const [a, e, I, L, wbar, O] = e0.map((v, i) => v + rate[i] * T);
  const w = (wbar - O) * DEG, Om = O * DEG, inc = I * DEG;
  const M = mod(L - wbar + 180, 360) - 180;
  let E = M * DEG + e * Math.sin(M * DEG);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M * DEG) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om);
  const cI = Math.cos(inc), sI = Math.sin(inc);
  const ecl = [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
  return rotX(ecl, OBLIQUITY);
}

// IAU 2009 Mars orientation.
export function marsRotation(ms) {
  const d = julianDateTT(ms) - 2451545.0;
  const T = d / 36525;
  return {
    alpha0: (317.68143 - 0.1061 * T) * DEG,
    delta0: (52.8865 - 0.0609 * T) * DEG,
    W: mod(176.63 + MARS.siderealRotDegPerDay * d, 360) * DEG,
  };
}

// ICRF/J2000 equatorial vector → Mars body-fixed vector.
export function icrfToMarsFixed(v, rot) {
  let r = rotZ(v, -(Math.PI / 2 + rot.alpha0));
  r = rotX(r, -(Math.PI / 2 - rot.delta0));
  return rotZ(r, -rot.W);
}

// Local East/North/Up basis at a planetocentric site, in body-fixed coords.
export function enuBasis(latDeg, lonEastDeg) {
  const p = latDeg * DEG, l = lonEastDeg * DEG;
  return {
    E: [-Math.sin(l), Math.cos(l), 0],
    N: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    U: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
  };
}

export function toLocal(vFixed, basis) {
  return [v3.dot(vFixed, basis.E), v3.dot(vFixed, basis.N), v3.dot(vFixed, basis.U)];
}

export function azEl(enu) {
  const n = v3.norm(enu);
  return { az: mod(Math.atan2(n[0], n[1]) * RAD, 360), el: Math.asin(n[2]) * RAD, enu: n };
}

// Sun and Earth as seen from the site.
export function skyBodies(ms, latDeg = SITE.latDeg, lonEastDeg = SITE.lonEastDeg) {
  const rot = marsRotation(ms);
  const basis = enuBasis(latDeg, lonEastDeg);
  const mars = helioPosition("mars", ms);
  const earth = helioPosition("earth", ms);
  const toSun = v3.scale(mars, -1);
  const toEarth = v3.sub(earth, mars);
  const distAU = v3.len(toEarth);
  return {
    sun: azEl(toLocal(icrfToMarsFixed(toSun, rot), basis)),
    earth: azEl(toLocal(icrfToMarsFixed(toEarth, rot), basis)),
    earthDistKm: distAU * AU_KM,
    owltSec: (distAU * AU_KM) / C_KMS,
    sunDistAU: v3.len(mars),
    // Sun–Earth–Mars: Earth's solar elongation seen from Mars (conjunction < 2–3°)
    sunEarthSepDeg: Math.acos(v3.dot(v3.norm(toSun), v3.norm(toEarth))) * RAD,
    rot,
  };
}

// ---------- Earth side: which DSN complex sees Mars ----------
export function gmstDeg(ms) {
  return mod(280.46061837 + 360.98564736629 * (julianDateUT(ms) - 2451545.0), 360);
}

export function dsnVisibility(ms) {
  const mars = helioPosition("mars", ms);
  const earth = helioPosition("earth", ms);
  const g = v3.norm(v3.sub(mars, earth));
  const ra = Math.atan2(g[1], g[0]);
  const dec = Math.asin(g[2]);
  const gmst = gmstDeg(ms) * DEG;
  return DSN.map((s) => {
    const H = gmst + s.lonDeg * DEG - ra;
    const p = s.latDeg * DEG;
    const el = Math.asin(Math.sin(p) * Math.sin(dec) + Math.cos(p) * Math.cos(dec) * Math.cos(H)) * RAD;
    return { ...s, elDeg: el };
  }).sort((a, b) => b.elDeg - a.elDeg);
}

// ---------- Natural satellites & relay orbiters ----------
// Circular-orbit propagation in an inertial frame aligned with Mars' equator,
// converted to body-fixed by the IAU prime-meridian angle W. Phases are
// representative (not ephemeris-accurate); geometry and periods are real.
const MOONS = [
  { id: "Phobos", aKm: 9376, periodDays: 0.31891023, incDeg: 1.08, phase0: 0.0, radiusKm: 11.1 },
  { id: "Deimos", aKm: 23463.2, periodDays: 1.263, incDeg: 1.79, phase0: 2.1, radiusKm: 6.2 },
];

function orbitFixed(aKm, incDeg, nodeFixedRad, argLatRad) {
  const cu = Math.cos(argLatRad), su = Math.sin(argLatRad);
  const ci = Math.cos(incDeg * DEG), si = Math.sin(incDeg * DEG);
  const x = cu, y = su * ci, z = su * si;
  const cn = Math.cos(nodeFixedRad), sn = Math.sin(nodeFixedRad);
  return [aKm * (cn * x - sn * y), aKm * (sn * x + cn * y), aKm * z];
}

function siteVector(latDeg, lonEastDeg) {
  const b = enuBasis(latDeg, lonEastDeg);
  return v3.scale(b.U, MARS.radiusKm - 2.6); // Jezero floor ≈ −2.6 km below datum
}

function lookFrom(site, basis, target) {
  const rel = v3.sub(target, site);
  const r = azEl(toLocal(rel, basis));
  r.rangeKm = v3.len(rel);
  return r;
}

export function moons(ms, latDeg = SITE.latDeg, lonEastDeg = SITE.lonEastDeg) {
  const d = julianDateTT(ms) - 2451545.0;
  const W = marsRotation(ms).W;
  const basis = enuBasis(latDeg, lonEastDeg);
  const site = siteVector(latDeg, lonEastDeg);
  return MOONS.map((m) => {
    const u = m.phase0 + (2 * Math.PI * d) / m.periodDays;
    const pos = orbitFixed(m.aKm, m.incDeg, -W, u);
    const look = lookFrom(site, basis, pos);
    look.id = m.id;
    look.angularDiamDeg = 2 * Math.atan(m.radiusKm / look.rangeKm) * RAD;
    return look;
  });
}

export function orbiterPeriodSec(altKm) {
  const a = MARS.radiusKm + altKm;
  return 2 * Math.PI * Math.sqrt((a * a * a) / MARS.muKm3s2);
}

export function orbiterLook(o, ms, latDeg = SITE.latDeg, lonEastDeg = SITE.lonEastDeg) {
  const a = MARS.radiusKm + o.altKm;
  const P = orbiterPeriodSec(o.altKm);
  const tSec = (ms - Date.UTC(2020, 0, 1)) / 1000;
  const u = (2 * Math.PI * tSec) / P + (o.phase0 || 0);
  let node;
  if (o.ltstNode !== undefined) {
    // Sun-synchronous: node locked to a local solar time.
    const mt = marsTime(ms, 0, 0);
    node = (mt.subsolarLonEast + 15 * (o.ltstNode - 12)) * DEG;
  } else {
    const d = julianDateTT(ms) - 2451545.0;
    node = (o.raan0Deg + o.raanDotDegDay * d) * DEG - marsRotation(ms).W;
  }
  const pos = orbitFixed(a, o.incDeg, node, u);
  const look = lookFrom(siteVector(latDeg, lonEastDeg), enuBasis(latDeg, lonEastDeg), pos);
  look.id = o.id;
  return look;
}

// Scan forward for the next relay pass above `minEl` (coarse 20 s steps, then
// refined). Returns {id, aos, los, maxEl} in UTC ms, or null within `horizonH`.
export function nextPass(o, fromMs, minEl = 10, horizonH = 30) {
  const step = 20000;
  const end = fromMs + horizonH * 3600e3;
  let aos = null, maxEl = -90;
  if (orbiterLook(o, fromMs).el > minEl) {
    // already in a pass: walk back to its acquisition of signal
    aos = fromMs;
    while (orbiterLook(o, aos - step).el > minEl && fromMs - aos < 3600e3) aos -= step;
  }
  for (let t = fromMs; t < end; t += step) {
    const el = orbiterLook(o, t).el;
    if (aos === null) {
      if (el > minEl) { aos = t; maxEl = el; }
    } else {
      maxEl = Math.max(maxEl, el);
      if (el <= minEl) return { id: o.id, aos, los: t, maxEl, rateMbps: o.rateMbps };
    }
  }
  return null;
}

export function orbiterPasses(fromMs) {
  return ORBITERS.map((o) => nextPass(o, fromMs)).filter(Boolean).sort((a, b) => a.aos - b.aos);
}
