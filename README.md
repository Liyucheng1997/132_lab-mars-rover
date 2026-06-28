# 火星车仿真 · Mars Rover Simulator (Three.js)

A browser-based simulation of a NASA Perseverance-class Mars rover, built with
[Three.js](https://threejs.org). It reproduces the rover hardware, terrain
following, onboard cameras, autonomous navigation/path-planning, and the
Earth–Mars deep-space communication chain.

![views](docs/preview.png)

## 运行 / Running

The project is pure static files using an ES-module **import map** (Three.js is
loaded from a CDN), so it needs to be served over HTTP — opening `index.html`
directly via `file://` will not work.

```bash
# from the project root
python -m http.server 8124
# then open http://localhost:8124
```

Any static server works (`npx serve`, VS Code "Live Server", etc.). An internet
connection is required the first time so the browser can fetch Three.js from
unpkg.

## 操作 / Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Drive & steer (Ackermann + point-turn) |
| `Click` on terrain | Set a navigation waypoint |
| `G` | Engage / disengage **AutoNav** (drives to the waypoint, avoiding hazards) |
| `P` | **Drill** & cache a core sample (rover must be stopped) |
| `C` | Capture a **360° MastCam-Z panorama** |
| `1`–`5` | Camera views: Chase · Orbit · NavCam · HazCam · MastCam-Z |
| `M` | Deploy / stow the remote sensing mast |
| `R` | Recenter the chase camera |
| `H` | Toggle the HUD |

Press **`2`** for the **free orbit** camera: **drag** to rotate, **scroll** to
zoom. (A short click still drops a waypoint; only a drag moves the camera, so the
two no longer conflict.)

## 真实还原的内容 / What is modelled on the real mission

**Rover (`src/rover.js`)** — Perseverance layout: 6-wheel **rocker-bogie**
suspension with terrain-following compliance, steerable corner wheels (rear
wheels counter-steer for tighter turns), grousered wheels, the Warm Electronics
Box chassis with gold thermal trim, the **Remote Sensing Mast** with Mastcam-Z /
SuperCam apertures, a stowable **robotic arm** with turret, the **MMRTG** power
source with cooling fins, **High-Gain (X-band)** and **UHF relay** antennas, and
a stowed **Ingenuity** helicopter.

**Terrain (`src/mars.js`)** — a Jezero-Crater-inspired surface: raised crater
rim, central bowl, an ancient river **delta** (Perseverance's actual science
target), aeolian ripples, scattered rocks, elevation/slope-based regolith
colouring, and a butterscotch dust sky. The height field is analytic, so the
rover queries the exact surface it is driving on.

**Planning (`src/planning.js`)** — an AutoNav-style local planner: it casts a
fan of candidate steering **arcs**, scores each by terrain hazard (slope +
roughness + **boulder proximity** + out-of-bounds), and follows the safest arc
that makes progress to the goal — the same idea as the flight software's
GESTALT/ENav. Blocked paths trigger a back-up-and-replan. Candidate arcs are
drawn live (green = safe, red = hazard, blue = chosen).

**Obstacles & collision (`src/mars.js`)** — large boulders are registered as
physical obstacles in a spatial hash. The driving model pushes the rover out of
any rock it contacts (no more clipping through them) and bleeds off momentum on
impact, while the planner gives boulders a body-width berth.

**Mission tasks (`src/main.js`)** —
- **Sample caching** (`P`): the robotic arm deploys and drills; after the coring
  sequence a borehole is left in the regolith and a sealed sample tube is added
  to the cache (mirroring Perseverance's 38-tube sample-return campaign).
- **360° panorama** (`C`): a render-to-texture mosaic — the MastCam-Z camera is
  swept through 12 azimuths, each frame read back and stitched into a panoramic
  strip, exactly how the real mosaics are assembled from individual frames.

**Cameras (`src/cameras.js`)** — chase, free orbit, and three onboard cameras
mounted at their real locations with representative fields of view (NavCam 45°,
wide HazCam 105°, telephoto MastCam-Z 18°).

**Communications (`src/comms.js`)** — computes the real Earth–Mars geometry from
simplified heliocentric orbits to derive the **one-way light time** (≈3–22 min)
and round-trip delay, rotates through the **Deep Space Network** stations
(Goldstone / Madrid / Canberra), models UHF relay via orbiters (MRO, Odyssey,
MAVEN, TGO), and streams delayed telemetry into the comms log. Commands you
issue are acknowledged with the current light-time delay.

The HUD also runs a **Mars Sol clock** (a sol = 24h 39m 35s) with Local Mean
Solar Time, plus speed, heading, slope, odometer, and power/battery readouts,
and a top-down **navigation minimap** with hazard shading.

## 结构 / Project layout

```
index.html        # HUD markup + import map
styles.css        # HUD / mission-control styling
src/
  main.js         # orchestrator: scene, lighting, driving model, HUD, loop
  mars.js         # analytic Mars terrain + rocks + sky
  rover.js        # Perseverance-class rover model + rocker-bogie suspension
  cameras.js      # chase / orbit / onboard camera rig
  controls.js     # keyboard + pointer input
  planning.js     # AutoNav arc-voting hazard-avoidance planner
  comms.js        # Earth–Mars light-time + DSN telemetry
  ui.js           # minimap + HUD helpers
  noise.js        # Perlin/fBm terrain noise
  dem.js          # real MOLA DEM loader + bilinear sampler
data/
  jezero_dem.png  # real NASA MOLA elevation (Jezero), RG16-encoded
  jezero_dem.json # DEM metadata
scripts/
  convert_dem.py  # MOLA MEGDR → heightmap converter
```

## 备注 / Notes

- Driving speed is sped up for interactivity (~2.4 m/s sim vs. Perseverance's
  real ~0.042 m/s).
- The vertical relief of the real DEM is compressed (~90 m across the height
  span) so the 600 m sandbox is drivable — the same scaling logic the procedural
  Jezero already used. The true elevation range (−4435 … 756 m) is recorded in
  `data/jezero_dem.json`.

## 真实火星 DEM 数据 / Real Mars elevation data

The terrain is driven by **real NASA MOLA elevation data** for Jezero Crater,
bundled in `data/`:

- `data/jezero_dem.png` — a 640×640 heightmap (16-bit elevation packed into the
  R+G channels), centred on **18.38 °N, 77.58 °E** (Perseverance's landing site).
- `data/jezero_dem.json` — metadata (encoding, elevation range, pixel scale,
  source product) read by `src/dem.js`.

It is cropped from the **Mars Global Surveyor MOLA MEGDR** product
(`meg128`, 128 px/° ≈ 463 m/px), tile `megt44n000hb`, hosted by NASA PDS at
Washington University St. Louis. `src/dem.js` loads it, bilinearly samples it,
and `MarsTerrain` builds the mesh from it. If the files are absent the sim falls
back to the procedural Jezero automatically.

### Regenerating from source

```bash
# 1. download just the Jezero latitude band (~14 MB) via an HTTP range request
BASE=https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt44n000hb.img
curl -r $((2959*23040))-$((3599*23040-1)) "$BASE" -o band.bin

# 2. crop + encode to data/jezero_dem.png + .json  (needs numpy + Pillow)
python scripts/convert_dem.py band.bin
```

To target a **different site** (e.g. Gale Crater for Curiosity), change the
tile, `ROW_START`, and `COL_START` in `scripts/convert_dem.py` to the desired
latitude/longitude window and re-run.

> Data credit: NASA / JPL / GSFC — MGS MOLA Science Team (MEGDR, CC-attribution
> via the Jaanga Mars project).
