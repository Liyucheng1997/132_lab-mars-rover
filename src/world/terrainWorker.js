// Web Worker: synthesises the near-field terrain off the main thread.
// Receives the decoded MOLA grid, returns transferable height/material arrays.
import { DemGrid } from "./geo.js";
import { generateNearField } from "./terrainGen.js";

self.onmessage = (e) => {
  const { elev, meta, opts } = e.data;
  const dem = new DemGrid(elev, meta);
  let last = 0;
  const result = generateNearField(
    (x, z) => dem.localHeight(x, z),
    opts,
    (p) => {
      if (p - last > 0.02 || p === 1) { last = p; self.postMessage({ type: "progress", p }); }
    }
  );
  self.postMessage({ type: "done", result }, [result.heights.buffer, result.mat.buffer]);
};
