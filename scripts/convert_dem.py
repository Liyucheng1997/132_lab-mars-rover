#!/usr/bin/env python3
"""Convert a MOLA MEGDR band (raw 16-bit big-endian) into a web heightmap.

Input  : a raw byte slice of a MEGDR .img tile (rows x 11520, MSB int16, metres)
Output : data/jezero_dem.png  (RG16 = real elevation, 16-bit precision)
         data/jezero_dem.json (metadata read by src/dem.js)

The crop is centred on Jezero Crater (18.38 N, 77.58 E) in tile megt44n000hb
(44 N -> 0 N, 0 -> 90 E, 128 px/deg). See README for the exact download range.
"""
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
BAND = os.path.join(HERE, "..", "scratch_band.bin")  # default; overridden below

# --- geometry of the downloaded band ---
TILE_SAMPLES = 11520        # full tile width (90 deg * 128)
PPD = 128                   # pixels per degree
TILE_MAX_LAT = 44.0
ROW_START = 2959            # first row of the band within the tile
BAND_ROWS = 640
COL_START = 9610            # Jezero lon window start (col)
COL_W = 640

# Gameplay vertical relief (metres) the full height span maps to in-sim.
# Real Jezero relief over this 5-deg window is ~2-3 km; compressed here so the
# rover sandbox is drivable, exactly as the procedural Jezero is scaled down.
GAMEPLAY_RELIEF_M = 90.0


def main(band_path):
    raw = np.fromfile(band_path, dtype=">i2")          # big-endian int16
    assert raw.size == BAND_ROWS * TILE_SAMPLES, f"unexpected size {raw.size}"
    band = raw.reshape(BAND_ROWS, TILE_SAMPLES)
    crop = band[:, COL_START:COL_START + COL_W].astype(np.float32)  # metres

    true_min = float(crop.min())
    true_max = float(crop.max())
    norm = (crop - true_min) / max(1e-6, (true_max - true_min))     # 0..1

    # Encode 0..1 as 16-bit across R (high) + G (low); B unused, A=255
    q = np.clip(np.round(norm * 65535), 0, 65535).astype(np.uint16)
    hi = (q >> 8).astype(np.uint8)
    lo = (q & 0xFF).astype(np.uint8)
    rgba = np.zeros((crop.shape[0], crop.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = hi
    rgba[..., 1] = lo
    rgba[..., 3] = 255

    os.makedirs(DATA, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(os.path.join(DATA, "jezero_dem.png"))

    center_lat = TILE_MAX_LAT - (ROW_START + BAND_ROWS / 2) / PPD
    center_lon = (COL_START + COL_W / 2) / PPD
    meta = {
        "image": "jezero_dem.png",
        "encoding": "rg16",
        "range": GAMEPLAY_RELIEF_M,
        "vScale": 1.0,
        "label": "MOLA MEGDR (Jezero)",
        "source": "NASA PDS MGS-M-MOLA-5-MEGDR-L3-V1 meg128 / tile megt44n000hb",
        "trueMinElevM": round(true_min, 1),
        "trueMaxElevM": round(true_max, 1),
        "metersPerPixel": 463.0,
        "centerLatDeg": round(center_lat, 3),
        "centerLonDeg": round(center_lon, 3),
        "widthPx": int(crop.shape[1]),
        "heightPx": int(crop.shape[0]),
    }
    with open(os.path.join(DATA, "jezero_dem.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Wrote data/jezero_dem.png ({crop.shape[1]}x{crop.shape[0]})")
    print(f"  real elevation: {true_min:.0f} .. {true_max:.0f} m "
          f"(span {true_max-true_min:.0f} m)")
    print(f"  centre: {center_lat:.2f} N, {center_lon:.2f} E")


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else BAND
    main(path)
