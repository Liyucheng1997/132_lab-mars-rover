// Mars timekeeping — NASA GISS "Mars24" algorithm
// (Allison & McEwen 2000, Planet. Space Sci. 48, 215; Allison 1997).
// Pure functions of UTC milliseconds; no rendering dependencies.
import { DEG, RAD, SITE } from "../core/constants.js";
import { mod } from "../core/math.js";

// TAI-UTC leap-second table (ms epoch → seconds). TT = TAI + 32.184 s.
const LEAPS = [
  [Date.UTC(1999, 0, 1), 32],
  [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34],
  [Date.UTC(2012, 6, 1), 35],
  [Date.UTC(2015, 6, 1), 36],
  [Date.UTC(2017, 0, 1), 37],
];

export function ttMinusUtc(ms) {
  let tai = 32;
  for (const [t, s] of LEAPS) if (ms >= t) tai = s;
  return tai + 32.184;
}

export const julianDateUT = (ms) => 2440587.5 + ms / 86400000;
export const julianDateTT = (ms) => julianDateUT(ms) + ttMinusUtc(ms) / 86400;

// Planetary perturbation terms (Mars24 table 5).
const PBS = [
  [0.0071, 2.2353, 49.409],
  [0.0057, 2.7543, 168.173],
  [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736],
  [0.0021, 2.1354, 15.704],
  [0.0020, 2.4694, 95.528],
  [0.0018, 32.8493, 49.095],
];

/**
 * Full Mars24 solution for a UTC instant at an east longitude / latitude.
 * Returns angles in degrees, times in hours.
 */
export function marsTime(ms, lonEastDeg = SITE.lonEastDeg, latDeg = SITE.latDeg) {
  const jdTT = julianDateTT(ms);
  const dt = jdTT - 2451545.0;

  const M = mod(19.3871 + 0.52402073 * dt, 360);
  const alphaFMS = mod(270.3871 + 0.524038496 * dt, 360);
  let pbs = 0;
  for (const [A, tau, phi] of PBS) pbs += A * Math.cos(DEG * ((0.985626 * dt) / tau + phi));
  const Mr = M * DEG;
  const eoc =
    (10.691 + 3.0e-7 * dt) * Math.sin(Mr) +
    0.623 * Math.sin(2 * Mr) +
    0.050 * Math.sin(3 * Mr) +
    0.005 * Math.sin(4 * Mr) +
    0.0005 * Math.sin(5 * Mr) +
    pbs; // ν − M, equation of centre
  const Ls = mod(alphaFMS + eoc, 360);
  const LsR = Ls * DEG;
  const eot = 2.861 * Math.sin(2 * LsR) - 0.071 * Math.sin(4 * LsR) + 0.002 * Math.sin(6 * LsR) - eoc;

  const msd = (jdTT - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626;
  const mst = mod(24 * msd, 24);
  const lmst = mod(mst + lonEastDeg / 15, 24);
  const ltst = mod(lmst + eot / 15, 24);
  const subsolarLonEast = mod(15 * (12 - mst) - eot, 360);

  const decl = Math.asin(0.42565 * Math.sin(LsR)) * RAD + 0.25 * Math.sin(LsR);
  const rHelioAU =
    1.5236 * (1.00436 - 0.09309 * Math.cos(Mr) - 0.004336 * Math.cos(2 * Mr) -
      0.00031 * Math.cos(3 * Mr) - 0.00003 * Math.cos(4 * Mr));

  // Local solar geometry (ENU unit vector to the Sun)
  const H = (ltst - 12) * 15 * DEG;
  const d = decl * DEG, phi = latDeg * DEG;
  const east = -Math.cos(d) * Math.sin(H);
  const north = Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.sin(phi) * Math.cos(H);
  const up = Math.sin(d) * Math.sin(phi) + Math.cos(d) * Math.cos(phi) * Math.cos(H);
  const sunElevDeg = Math.asin(up) * RAD;
  const sunAzDeg = mod(Math.atan2(east, north) * RAD, 360);

  return {
    jdTT, msd, mst, lmst, ltst, Ls, eot, M, decl, rHelioAU, subsolarLonEast,
    sunElevDeg, sunAzDeg, sunENU: [east, north, up],
    marsYear: marsYear(ms),
  };
}

// Mission sol number since landing (Sol 0 = landing sol), from the local MSD.
export function missionSol(ms, landingMs = SITE.landingUtc, lonEastDeg = SITE.lonEastDeg) {
  const localSol = (t) => Math.floor(marsTime(t).msd + lonEastDeg / 360);
  return localSol(ms) - localSol(landingMs);
}

// Mars Year (Clancy et al. convention: MY1 began 1955-04-11).
export function marsYear(ms) {
  const MY1 = Date.UTC(1955, 3, 11);
  return 1 + Math.floor((ms - MY1) / (686.9726 * 86400000));
}

export function formatHours(h) {
  h = mod(h, 24);
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const ss = Math.floor(((h - hh) * 60 - mm) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// Find the next UTC instant (after `ms`) when LMST equals `targetHour`.
export function nextLmst(ms, targetHour, lonEastDeg = SITE.lonEastDeg) {
  const cur = marsTime(ms, lonEastDeg).lmst;
  const dh = mod(targetHour - cur, 24);
  return ms + (dh / 24) * 88775244;
}

// Season name for an areocentric solar longitude (northern hemisphere).
export function seasonOf(Ls) {
  if (Ls < 90) return "北半球春季";
  if (Ls < 180) return "北半球夏季";
  if (Ls < 270) return "北半球秋季 · 沙尘季";
  return "北半球冬季 · 沙尘季";
}
