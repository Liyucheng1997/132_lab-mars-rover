# 火星车工程仿真 · Mars Rover Engineering Simulator

A browser-based engineering simulator of a NASA Perseverance-class rover at
Jezero Crater, built on [Three.js](https://threejs.org) with no build step.
Version 2 replaces the v1 "game" models with physically based ones: real Mars
time and ephemerides, true-scale georeferenced terrain, rocker-bogie
kinematics, Bekker–Wong terramechanics, arm inverse kinematics, a dust-
scattering atmosphere, and an AutoNav stack with global and local planners.
The physics and world models are covered by an automated test suite.

## 运行 / Running

```bash
python scripts/serve.py 8124      # static server with caching disabled
# open http://localhost:8124
```

The page loads Three.js 0.160 from unpkg through an import map, so it needs an
HTTP server (not `file://`) and network access on first load. Any static
server works; `scripts/serve.py` only adds `Cache-Control: no-store` so edits
to ES modules show up immediately.

```bash
npm test                          # node --test, no dependencies
```

URL parameters: `?utc=2021-02-18T20:43:49Z` starts at a specific instant
(default: now, moved to the next 09:30 LMST if it is night at Jezero);
`?warp=200` sets the initial time warp.

## 操作 / Controls

| Key | Action |
| --- | --- |
| `W` `S` | Drive forward / reverse (4.2 cm/s × time warp) |
| `A` `D` | Ackermann arc; held alone = turn in place |
| `Q` `E` | Turn in place left / right |
| `Space` | All stop |
| Click terrain / minimap | Set a goal; the A* strategic route is planned immediately |
| `G` / `X` | Engage/disengage AutoNav / clear the goal |
| `P` | Coring sequence (arm IK → preload → core → retract → stow → seal) |
| `C` | Mastcam-Z 360° panorama sequence (mosaic of 12 rendered frames) |
| `M`, `I` `J` `K` `L` | Stow/deploy mast; tilt/pan the remote-sensing mast |
| `1`–`6` | Chase · free orbit · NavCam · front HazCam · Mastcam-Z · rear HazCam |
| `+` `-` / wheel | Mastcam-Z zoom, 26–110 mm |
| `[` `]` | Time warp ×1 … ×5000 |
| `T` | Skip to 09:00 LMST on the next sol |
| `L` | Light-time mode: commands from "Earth" execute after the real one-way light time |
| `B` / `V` | Clear a fault-protection stop / toggle planner-arc display |
| `N` `R` `H` `F1` | Map mode · reset camera · HUD · help |

## 模型 / What is modelled

### Time and sky geometry — `src/physics/marsTime.js`, `ephemeris.js`
* **Mars24** (Allison & McEwen 2000): MSD, MST/LMST/LTST, Ls, equation of time,
  solar declination, mission sol numbering from the landing epoch, Mars Year.
  Reproduces the paper's worked example to 2×10⁻⁴°.
* An **independent** solar-system chain (JPL Keplerian elements → IAU 2009
  Mars pole and prime-meridian rotation → local ENU) gives the Sun, Earth,
  Phobos, Deimos and relay orbiters. Its Sun direction agrees with Mars24 to
  < 0.3°, which the tests check across 2021–2025.
* The landing instant (2021-02-18 20:43:49 UTC SCET) comes out at 15:53 LMST,
  Ls 5.6°, matching the published values.

### Terrain — `src/world/`
* **Far field:** the bundled MOLA MEGDR crop at true scale over ±60 km with
  planetary curvature (the horizon from mast height is about 3.7 km away).
  The Jezero rim and western delta stand on the horizon where they really are.
  The site's elevation decodes to −2571 m; the published value is −2569 m.
* **Near field:** 1 km × 1 km at 0.5 m post spacing, synthesised in a Web
  Worker from layers:
  * the MOLA macro surface;
  * fBm undulation;
  * a crater population with N(>D) ∝ D⁻², Pike simple-crater morphometry and
    per-crater degradation from fresh to sand-filled;
  * transverse aeolian ridges in sand patches;
  * terraced bedrock outcrops.
  A material map (bedrock / sand / albedo / ejecta) drives rendering, rock
  abundance and the soil the wheels drive on, so all three always agree.
* Chunked LOD (four levels, crack-free skirts) and a custom PBR terrain
  shader: unit blending, slope-exposed bedrock, two-scale anti-tiling detail
  normals, and wheel tracks with grouser imprints.
* **Rocks:** Golombek & Rapp (1997) abundance model F_k(D) = k·e^(−q(k)D).
  Rocks are generated per chunk from a seed, with abundance raised on fresh
  ejecta and outcrops. They are drawn from 10 procedural shape families with
  dust on their top faces, and each rock is also a physical ellipsoid that
  the wheels climb.

### Atmosphere — `src/world/sky.js`, `src/physics/environment.js`
* The sky uses single-scattering plus approximate multiple scattering from
  dust, with wavelength-dependent albedo and Henyey–Greenstein asymmetry.
  The butterscotch daytime sky and the **blue sunset aureole** both come out
  of the same equations. Scene sunlight, skylight and fog are computed on the
  CPU from the same model.
* The night sky has a star field rotating about the Martian pole, plus Earth,
  Phobos and Deimos at their computed positions, drawn with phase lighting.
* The MEDA-like environment model covers air and ground temperature,
  pressure (CO₂ cycle and tides), wind, dust optical depth τ (dust season and
  regional events) and surface irradiance.

### Vehicle — `src/rover/`, `src/physics/`
* **Geometry:** the warm electronics box and deck, RSM mast (Mastcam-Z
  24.2 cm baseline, NavCams, SuperCam aperture, MEDA booms) on deploy, azimuth
  and elevation joints, a 5-DOF arm with a turret (coring drill, PIXL,
  SHERLOC/WATSON, GDRTT), the bit carousel, MMRTG with heat-rejection panels,
  a gimballed hexagonal HGA that tracks Earth, a UHF helix and front/rear
  HazCams. Dust builds up on the rover as sols pass.
* **Wheels:** 52.5 cm machined drums with 48 curved grousers, six curved
  titanium flexure spokes and hub motors.
* **Rocker-bogie** (`rockerBogie.js`): a planar rim-contact solve per side
  and the differential coupling (pitch = mean rocker angle), with the
  differential bar and links animated to match. Static wheel loads and
  lateral load transfer give a stability margin.
* **Terramechanics** (`terramechanics.js`): Bekker pressure–sinkage,
  slip-sinkage, compaction resistance and Janosi–Hanamoto shear. Per-wheel
  loads and soils give a vehicle slip from a bisection solve. Tuning:
  regolith ≈ 20 % slip at 20°; loose sand immobilises the rover past ~15°.
* **Mobility FSW** (`vehicle.js`): Ackermann arcs about the mid-wheel axle,
  turn-in-place, slew-limited steering actuators and wheel odometry vs. VO.
  Fault protection stops the rover on excess tilt, slip, immobilisation or a
  low stability margin.
* **Arm** (`armKinematics.js`): closed-form IK puts the drill normal to the
  surface. Joints slew at a realistic rate.
* **Power** (`power.js`): MMRTG decay since launch, a 2×43 Ah battery and a
  per-subsystem load table that includes heaters driven by air temperature.

### Navigation & operations — `src/nav/`, `src/ops/`
* **Strategic:** A* over an "orbital" cost map built from slope, roughness
  and sand. As with HiRISE planning, rocks below map resolution are not in
  it. The path is string-pulled.
* **Tactical (ENav-style):** at each 0.5 m step the planner scores 13
  curvature arcs against a rover-footprint model (rock height above the
  35 cm threshold, tilt, roughness, sand) and follows a pure-pursuit carrot
  on the route. It turns in place when the heading error is large, and backs
  up and replans after repeated blockage.
* **Telecom:** DTE needs Earth above the local horizon, a DSN complex
  (Goldstone / Madrid / Canberra) with Mars above its horizon, and no solar
  conjunction. UHF relay passes of MRO, Odyssey (sun-synchronous), TGO and
  MAVEN are predicted from their orbits. A data buffer fills from activities
  and drains over whichever link is up. In light-time mode, commands are
  delayed by the real one-way light time.

## 结构 / Layout

```
src/
  main.js                orchestration: boot, time-warp clock, fixed-step physics, sequences, HUD
  core/                  constants (vehicle spec, site, DSN, orbiters), math, noise
  physics/               marsTime, ephemeris, rockerBogie, terramechanics, armKinematics,
                         environment, power      ← pure modules, unit-tested in Node
  world/                 geo (georef + DEM), terrainGen (+ worker), terrain (LOD), rocks/rockGen,
                         sky, tracks, particles, textures, terrainMaterial, demLoader
  rover/                 rover (geometry + articulation), vehicle (mobility), roverMaterials
  nav/                   globalPlanner (A*), autonav (ENav)
  ops/                   telecom
  cameras.js controls.js ui.js
tests/                   physics.test.js, world.test.js (node --test)
data/                    MOLA MEGDR Jezero crop (RG16 PNG + georef JSON), MOLA global map
scripts/                 convert_dem.py, make_global_map.py, serve.py
```

## 备注 / Notes and limitations

* Speeds are true to the hardware (4.2 cm/s), so use the time warp. Physics
  runs on a fixed 0.1 s step; above ~50 sub-steps per frame the step grows.
* Dimensions not published by NASA (suspension link geometry, wheel width,
  component placement) are estimated from scaled imagery and marked `est` in
  `src/core/constants.js`.
* Moon and orbiter positions use real periods and geometry but
  representative phases, so they are not ephemeris-accurate.
* Terrain within 1 km is synthesised. Real HiRISE DTMs (1 m) could replace
  the synthetic near field through the same `generateNearField` interface.

## 数据来源 / Data credits

* MOLA MEGDR elevation: NASA / JPL / GSFC — MGS MOLA Science Team (PDS
  Geosciences Node). Regenerate with `scripts/convert_dem.py` (see its
  docstring for the HTTP range request).
* References: Allison & McEwen (2000) *Planet. Space Sci.* 48; Archinal et al.
  (2011) IAU WGCCRE report; Standish, *Keplerian Elements for Approximate
  Positions of the Major Planets*; Golombek & Rapp (1997) *JGR* 102; Pike
  (1977); Bekker (1969); Wong, *Theory of Ground Vehicles*; Mars 2020 press kit.
