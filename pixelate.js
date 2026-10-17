// WorldPlace pixel-art engine: maps an image onto the game's palette.
// Pure functions with no DOM access, so the same code runs in the browser and
// in the Node tests (tools/test_site_engine.mjs).

(function (root) {
  "use strict";

  // sRGB 0-255 -> OKLab, a colour space where distance matches how different
  // colours look to people, so the nearest palette colour is the right one.
  function srgbToLinear(value) {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgbToOklab(r, g, b) {
    const lr = srgbToLinear(r);
    const lg = srgbToLinear(g);
    const lb = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function hexToRgb(hex) {
    const value = parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  // Prepares the colours the player owns for fast nearest-colour lookups.
  function buildPalette(colours) {
    const rgb = colours.map((colour) => hexToRgb(colour.hex));
    return {
      colours,
      rgb,
      lab: rgb.map(([r, g, b]) => rgbToOklab(r, g, b)),
      cache: new Map(),
    };
  }

  function nearestIndex(palette, r, g, b) {
    r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
    g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
    const key = (r << 16) | (g << 8) | b;
    const cached = palette.cache.get(key);
    if (cached !== undefined) return cached;
    const [L, A, B] = rgbToOklab(r, g, b);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.lab.length; i++) {
      const p = palette.lab[i];
      const dL = L - p[0];
      const dA = A - p[1];
      const dB = B - p[2];
      const distance = dL * dL + dA * dA + dB * dB;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    if (palette.cache.size < 200000) palette.cache.set(key, best);
    return best;
  }

  // Error-diffusion kernels: [dx, dy, weight] with the divisor.
  const KERNELS = {
    "floyd-steinberg": { divisor: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
    atkinson: { divisor: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
    "jarvis-judice-ninke": {
      divisor: 48,
      taps: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
        [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
    },
    stucki: {
      divisor: 42,
      taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
        [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
    },
    burkes: { divisor: 32, taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]] },
    "sierra-lite": { divisor: 4, taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
  };

  function bayerMatrix(size) {
    let matrix = [[0]];
    while (matrix.length < size) {
      const n = matrix.length;
      const next = Array.from({ length: n * 2 }, () => new Array(n * 2));
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = matrix[y][x] * 4;
          next[y][x] = v;
          next[y][x + n] = v + 2;
          next[y + n][x] = v + 3;
          next[y + n][x + n] = v + 1;
        }
      }
      matrix = next;
    }
    const count = size * size;
    return matrix.map((row) => row.map((v) => (v + 0.5) / count - 0.5));
  }

  const ORDERED = { "bayer-2": bayerMatrix(2), "bayer-4": bayerMatrix(4), "bayer-8": bayerMatrix(8) };

  const DITHER_OPTIONS = [
    { id: "none", label: "None (flat colours)" },
    { id: "floyd-steinberg", label: "Floyd–Steinberg" },
    { id: "atkinson", label: "Atkinson (crisp, retro)" },
    { id: "jarvis-judice-ninke", label: "Jarvis–Judice–Ninke (smooth)" },
    { id: "stucki", label: "Stucki" },
    { id: "burkes", label: "Burkes" },
    { id: "sierra-lite", label: "Sierra Lite" },
    { id: "bayer-2", label: "Ordered (Bayer 2×2)" },
    { id: "bayer-4", label: "Ordered (Bayer 4×4)" },
    { id: "bayer-8", label: "Ordered (Bayer 8×8)" },
  ];

  // Brightness/contrast/saturation tweaks before matching colours.
  function adjust(rgba, { brightness = 0, contrast = 0, saturation = 0 }) {
    const out = new Float32Array(rgba.length);
    const c = (100 + contrast) / 100;
    const s = (100 + saturation) / 100;
    const b = brightness * 2.55;
    for (let i = 0; i < rgba.length; i += 4) {
      let r = rgba[i], g = rgba[i + 1], bl = rgba[i + 2];
      const grey = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = grey + (r - grey) * s;
      g = grey + (g - grey) * s;
      bl = grey + (bl - grey) * s;
      out[i] = (r - 128) * c + 128 + b;
      out[i + 1] = (g - 128) * c + 128 + b;
      out[i + 2] = (bl - 128) * c + 128 + b;
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  // Returns one palette index per pixel, or -1 for transparent (unpainted).
  function quantize(rgba, width, height, palette, options = {}) {
    const dither = options.dither || "none";
    const strength = options.strength === undefined ? 1 : options.strength;
    const alphaThreshold = options.alphaThreshold === undefined ? 128 : options.alphaThreshold;
    const work = adjust(rgba, options);
    const result = new Int16Array(width * height);
    const kernel = KERNELS[dither];
    const ordered = ORDERED[dither];

    for (let y = 0; y < height; y++) {
      // Serpentine scanning stops error-diffusion patterns streaking one way.
      const reverse = kernel && y % 2 === 1;
      for (let step = 0; step < width; step++) {
        const x = reverse ? width - 1 - step : step;
        const pixel = y * width + x;
        const i = pixel * 4;
        if (work[i + 3] < alphaThreshold) {
          result[pixel] = -1;
          continue;
        }
        let r = work[i], g = work[i + 1], b = work[i + 2];
        if (ordered) {
          const offset = ordered[y % ordered.length][x % ordered.length] * 72 * strength;
          r += offset;
          g += offset;
          b += offset;
        }
        const index = nearestIndex(palette, r, g, b);
        result[pixel] = index;
        if (kernel && strength > 0) {
          const [pr, pg, pb] = palette.rgb[index];
          const er = (r - pr) * strength;
          const eg = (g - pg) * strength;
          const eb = (b - pb) * strength;
          for (const [dx, dy, weight] of kernel.taps) {
            const nx = x + (reverse ? -dx : dx);
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny >= height) continue;
            const j = (ny * width + nx) * 4;
            if (work[j + 3] < alphaThreshold) continue;
            const f = weight / kernel.divisor;
            work[j] += er * f;
            work[j + 1] += eg * f;
            work[j + 2] += eb * f;
          }
        }
      }
    }
    return result;
  }

  // Height that keeps the picture's shape for a chosen width.
  function heightForWidth(sourceWidth, sourceHeight, width) {
    return Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
  }

  function countColours(indices, paletteSize) {
    const counts = new Array(paletteSize).fill(0);
    let painted = 0;
    for (const index of indices) {
      if (index >= 0) {
        counts[index]++;
        painted++;
      }
    }
    return { counts, painted };
  }

  // Order used for "next batch": the picture is split into 64x64 blocks (the
  // grid lines on screen), left to right then top to bottom, and each block is
  // read row by row. Batches are compact patches that are easy to find.
  function batchOrder(width, height, block = 64) {
    const order = new Int32Array(width * height);
    let n = 0;
    for (let by = 0; by < height; by += block) {
      for (let bx = 0; bx < width; bx += block) {
        for (let y = by; y < Math.min(by + block, height); y++) {
          for (let x = bx; x < Math.min(bx + block, width); x++) order[n++] = y * width + x;
        }
      }
    }
    return order;
  }

  const api = {
    buildPalette, nearestIndex, quantize, heightForWidth, countColours, rgbToOklab, hexToRgb,
    batchOrder, DITHER_OPTIONS,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.WorldPlacePixelate = api;
})(typeof window !== "undefined" ? window : globalThis);
