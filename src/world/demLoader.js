import { DemGrid, decodeRG16, syntheticJezero } from "./geo.js";

// Load the bundled MOLA MEGDR crop (RG16 PNG + JSON sidecar) into a DemGrid.
// Falls back to an analytic Jezero if the data files are unavailable.
export async function loadJezeroDem(base = "./data/") {
  try {
    const meta = await (await fetch(base + "jezero_dem.json")).json();
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("DEM image failed to load"));
      im.src = base + meta.image;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const elev = decodeRG16(rgba, w, h, meta.trueMinElevM, meta.trueMaxElevM);
    const gridMeta = { ...meta, widthPx: w, heightPx: h };
    return { dem: new DemGrid(elev, gridMeta), elev, meta: gridMeta, real: true };
  } catch (e) {
    console.warn("MOLA DEM unavailable, using synthetic Jezero:", e.message);
    const dem = syntheticJezero();
    return { dem, elev: dem.elev, meta: dem.meta, real: false };
  }
}
