// Histogram worker: counts R, G, B and luminance for a small RGBA buffer, off the main thread.
self.onmessage = e => {
  const d = new Uint8ClampedArray(e.data.buf);
  const bins = new Uint32Array(1024);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    bins[r]++;
    bins[256 + g]++;
    bins[512 + b]++;
    bins[768 + Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b))]++;
  }
  self.postMessage({ id: e.data.id, bins: bins.buffer, pixels: d.length / 4 }, [bins.buffer]);
};
