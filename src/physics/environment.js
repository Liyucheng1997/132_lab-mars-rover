// Near-surface environment model for Jezero (MEDA-like observables).
// Empirical fits shaped after Mars 2020 MEDA and REMS climatologies:
//   • air temperature at 1.5 m and ground temperature (diurnal + seasonal)
//   • surface pressure (CO₂ seasonal cycle + thermal tides)
//   • dust optical depth τ (seasonal dust storm season, Ls 180–360)
//   • wind speed / direction (daytime convection, nocturnal drainage)
// Inputs are LTST (hours), Ls (deg) and sun elevation (deg).
import { DEG } from "../core/constants.js";
import { clamp, mulberry32 } from "../core/math.js";

export function dustTau(Ls, solIndex = 0) {
  // background ~0.45, broad dust season peak near perihelion (Ls 250)
  const season = 0.38 * Math.exp(-Math.pow((((Ls - 245 + 540) % 360) - 180) / 55, 2));
  // regional dust events: deterministic per sol so they persist for a while
  const rnd = mulberry32(Math.floor(solIndex / 5) * 7919 + 13)();
  const event = Ls > 180 && rnd > 0.82 ? (rnd - 0.82) * 4 : 0;
  return 0.42 + season + event;
}

// Diurnal shape: 0 at pre-dawn minimum, 1 at early-afternoon maximum.
function diurnalShape(ltst) {
  const rise = 6.0, peak = 13.2;
  if (ltst >= rise && ltst <= peak) {
    const x = (ltst - rise) / (peak - rise);
    return Math.sin((x * Math.PI) / 2);
  }
  const hoursSincePeak = ((ltst - peak) + 24) % 24;          // 0 … 16.8 h
  const span = 24 - (peak - rise);
  return Math.exp(-3.2 * (hoursSincePeak / span)) * (1 - hoursSincePeak / span);
}

export function airTemperatureC(ltst, Ls, tau = 0.5) {
  const seasonal = 7 * Math.cos((Ls - 250) * DEG);  // warmer near perihelion
  const tMin = -82 + seasonal + 18 * (tau - 0.45);   // dust warms nights
  const amp = (60 + seasonal) * (1 - 0.45 * (tau - 0.45));
  return tMin + amp * diurnalShape(ltst);
}

export function groundTemperatureC(ltst, Ls, tau = 0.5) {
  const seasonal = 9 * Math.cos((Ls - 250) * DEG);
  const tMin = -88 + seasonal + 20 * (tau - 0.45);
  const amp = (90 + seasonal) * (1 - 0.5 * (tau - 0.45));
  return tMin + amp * diurnalShape(((ltst - 0.6) + 24) % 24);
}

export function pressurePa(ltst, Ls) {
  const seasonal = 690 + 55 * Math.sin((Ls - 160) * DEG) + 18 * Math.sin(2 * (Ls - 10) * DEG);
  const tide = 1 + 0.016 * Math.cos(((ltst - 8) / 24) * 2 * Math.PI) + 0.007 * Math.cos(((ltst - 10) / 12) * 2 * Math.PI);
  return seasonal * tide;
}

export function wind(ltst, sunElevDeg, t) {
  const conv = clamp(Math.sin(clamp(sunElevDeg, 0, 90) * DEG), 0, 1);
  const gust = 0.5 + 0.5 * Math.sin(t * 0.37) * Math.sin(t * 0.113 + 1.3);
  const speed = 1.8 + 5.5 * conv + 3.0 * conv * gust;
  // upslope (from SE) by day, drainage from the western rim at night
  const dirDeg = (conv > 0.15 ? 135 : 280) + 25 * Math.sin(t * 0.05);
  return { speed, dirDeg: ((dirDeg % 360) + 360) % 360 };
}

export function environment(mt, solIndex, simSeconds) {
  const tau = dustTau(mt.Ls, solIndex);
  const air = airTemperatureC(mt.ltst, mt.Ls, tau);
  const ground = groundTemperatureC(mt.ltst, mt.Ls, tau);
  const w = wind(mt.ltst, mt.sunElevDeg, simSeconds);
  // top-of-atmosphere insolation scales with 1/r², attenuated by dust
  const toa = 1361 / (mt.rHelioAU * mt.rHelioAU);
  const mu = Math.sin(clamp(mt.sunElevDeg, 0, 90) * DEG);
  const surfaceFlux = mu > 0 ? toa * mu * Math.exp(-tau / Math.max(mu, 0.05)) + toa * mu * 0.35 * (1 - Math.exp(-tau)) : 0;
  return {
    tau,
    airC: air,
    groundC: ground,
    pressurePa: pressurePa(mt.ltst, mt.Ls),
    windSpeed: w.speed,
    windDirDeg: w.dirDeg,
    toaWm2: toa,
    surfaceWm2: surfaceFlux,
    uvIndex: clamp(surfaceFlux / 70, 0, 15),
  };
}
