// Digital Elevation Model loader.
// Loads a heightmap image (a real NASA HiRISE/CTX/MOLA DEM exported to PNG) and
// exposes a bilinear sampler in normalised [0,1] coordinates.
//
// Supported encodings (set in the sidecar JSON):
//   "gray"  — 8-bit luminance in the R channel (simple, ~0.4 m steps)
//   "rg16"  — 16-bit height packed as R = high byte, G = low byte (precise)
//
// If the DEM cannot be fetched the caller falls back to procedural terrain.
export async function loadDEM(imageUrl, meta = {}) {
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("DEM image failed to load: " + imageUrl));
    im.src = imageUrl;
  });

  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  const encoding = meta.encoding || "gray";
  const rawAt = (px, py) => {
    px = px < 0 ? 0 : px >= w ? w - 1 : px;
    py = py < 0 ? 0 : py >= h ? h - 1 : py;
    const i = (py * w + px) * 4;
    if (encoding === "rg16") return (data[i] * 256 + data[i + 1]) / 65535;
    return data[i] / 255;
  };

  return {
    width: w,
    height: h,
    range: meta.range,         // elevation span in metres (max - min)
    vScale: meta.vScale || 1,  // vertical exaggeration
    label: meta.label || "Real DEM",
    // bilinear sample, v flipped so image-north maps to +Z
    sample(u, v) {
      const fx = u * (w - 1);
      const fy = (1 - v) * (h - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const a = rawAt(x0, y0), b = rawAt(x0 + 1, y0);
      const c = rawAt(x0, y0 + 1), d = rawAt(x0 + 1, y0 + 1);
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    },
  };
}

// Try to load the bundled Jezero DEM (data/jezero_dem.png + .json).
// Returns a sampler object or null if the data isn't present.
export async function tryLoadJezeroDEM(base = "./data/") {
  try {
    const metaRes = await fetch(base + "jezero_dem.json");
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    return await loadDEM(base + (meta.image || "jezero_dem.png"), meta);
  } catch (e) {
    console.warn("DEM not loaded, using procedural terrain:", e.message);
    return null;
  }
}
