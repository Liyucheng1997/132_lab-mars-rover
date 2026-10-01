// Physical constants and the reference vehicle specification.
// Every number here is either a published value or flagged as an engineering
// estimate taken from public imagery. Modules import from here rather than
// hard-coding magic numbers.

export const MARS = {
  radiusKm: 3389.5,            // IAU mean volumetric radius
  gravity: 3.721,              // m/s² at the surface
  muKm3s2: 42828.37,           // GM, km³/s²
  solSeconds: 88775.244,       // mean solar day
  siderealRotDegPerDay: 350.89198226, // IAU 2009 W rate
};

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const AU_KM = 149_597_870.7;
export const C_KMS = 299_792.458;

// Octavia E. Butler landing site (Perseverance, 2021-02-18 20:55 UTC).
// The local site frame is centred here: +X east, +Y up, +Z south.
export const SITE = {
  name: "Octavia E. Butler Landing",
  latDeg: 18.4447,             // planetocentric
  lonEastDeg: 77.4508,
  landingUtc: Date.UTC(2021, 1, 18, 20, 43, 49), // spacecraft event time (ERT 20:55)
};

// Perseverance (Mars 2020) mobility system.
// Sources: NASA Mars 2020 press kit, JPL mobility papers. Where a dimension is
// not published it is estimated from scaled imagery and marked `est`.
export const ROVER = {
  massKg: 1025,
  lengthM: 3.0,
  widthM: 2.7,
  heightM: 2.2,
  maxWheelSpeed: 0.042,        // m/s (4.2 cm/s, hard flat ground)
  wheel: {
    radius: 0.2625,            // 52.5 cm diameter
    width: 0.38,               // est
    grousers: 48,
    grouserHeight: 0.0075,     // est
    spokes: 6,
  },
  trackHalf: 1.12,             // est: half lateral wheel-centre spacing
  // Rocker-bogie side geometry in the body frame (+Z forward, +Y up, metres),
  // wheel centres at rest on flat ground. est from scaled imagery.
  suspension: {
    rockerPivot: [0.0, 0.86],   // [z, y] differential pivot on the body side
    bogiePivot: [-0.54, 0.58],
    front: [1.12, 0.2625],
    mid: [0.02, 0.2625],
    rear: [-1.10, 0.2625],
    bogieLimitDeg: 32,
    rockerLimitDeg: 24,
  },
  maxSteerDeg: 30,             // per-wheel steer actuator, Ackermann regime
  hazardRockHeight: 0.35,      // AutoNav rock-height hazard (m)
  hazardSlopeDeg: 30,          // tip-over keep-out
  slipFaultPct: 60,            // drive aborted when slip exceeds this
  battery: { cells: 2, ampHours: 43, busVolts: 28.8 },
  mmrtg: { bolWatts: 110, launchUtc: Date.UTC(2020, 6, 30), degradePerYear: 0.028 },
  arm: { lengthM: 2.1, dof: 5, turretKg: 45 },
};

// Deep Space Network complexes (geodetic, deg) and Mars relay orbiters.
export const DSN = [
  { id: "DSS-14", name: "Goldstone", latDeg: 35.4259, lonDeg: -116.8895 },
  { id: "DSS-63", name: "Madrid", latDeg: 40.4313, lonDeg: -4.2480 },
  { id: "DSS-43", name: "Canberra", latDeg: -35.4024, lonDeg: 148.9813 },
];

// Circular approximations. `ltstNode` = local true solar time of the
// ascending node for sun-synchronous orbits; otherwise `raan0Deg` + drift.
export const ORBITERS = [
  { id: "MRO", altKm: 300, incDeg: 92.6, ltstNode: 15.0, rateMbps: 2.0 },
  { id: "ODY", altKm: 400, incDeg: 93.1, ltstNode: 17.3, rateMbps: 0.128 },
  { id: "TGO", altKm: 400, incDeg: 74.0, raan0Deg: 40, raanDotDegDay: -1.4, rateMbps: 2.0 },
  { id: "MVN", altKm: 1200, incDeg: 75.0, raan0Deg: 210, raanDotDegDay: -0.5, rateMbps: 0.5 },
];
