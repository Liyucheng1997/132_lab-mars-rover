#!/usr/bin/env python3
"""Turn the MOLA global elevation file (meg004, 1440x720 MSB int16) into a
colour shaded-relief map for the in-sim global Mars minimap.

Output: data/mars_global.png   (1440x720 RGB, equirectangular, lon 0..360 E)
        data/mars_global.json  (geo metadata for placing the landing marker)
"""
import json
import os
import sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
W, H = 1440, 720


def main(band_path):
    elev = np.fromfile(band_path, dtype=">i2").reshape(H, W).astype(np.float32)

    # Hypsometric tint (low = blue-grey basins, high = pale orange highlands)
    lo, hi = np.percentile(elev, 1), np.percentile(elev, 99)
    t = np.clip((elev - lo) / max(1e-6, hi - lo), 0, 1)
    stops = np.array([
        [60, 35, 30], [120, 55, 38], [165, 82, 50],
        [200, 120, 80], [225, 170, 130], [240, 215, 195],
    ], dtype=np.float32)
    pos = np.linspace(0, 1, len(stops))
    rgb = np.empty((H, W, 3), np.float32)
    for c in range(3):
        rgb[..., c] = np.interp(t, pos, stops[:, c])

    # Hillshade from a NW sun
    gy, gx = np.gradient(elev)
    slope = np.arctan(np.hypot(gx, gy) / 30.0)
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(315), np.radians(45)
    shade = (np.sin(alt) * np.cos(slope) +
             np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    shade = np.clip(0.55 + 0.55 * shade, 0.25, 1.25)
    rgb *= shade[..., None]

    img = np.clip(rgb, 0, 255).astype(np.uint8)
    os.makedirs(DATA, exist_ok=True)
    Image.fromarray(img, "RGB").save(os.path.join(DATA, "mars_global.png"))

    meta = {
        "image": "mars_global.png",
        "width": W, "height": H,
        "lonMinDeg": 0.0, "lonMaxDeg": 360.0,   # column 0 = 0 E, increasing east
        "latMaxDeg": 90.0, "latMinDeg": -90.0,  # row 0 = 90 N
        "landingLatDeg": 18.38, "landingLonDeg": 77.58,  # Jezero / Perseverance
        "source": "NASA PDS MGS-M-MOLA-5-MEGDR meg004 (4 px/deg global)",
    }
    with open(os.path.join(DATA, "mars_global.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote data/mars_global.png ({W}x{H}), elev {elev.min():.0f}..{elev.max():.0f} m")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "mars_global.bin"))
