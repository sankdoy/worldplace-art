// WorldPlace saved projects: the pixel art plus which pixels are marked done.
// Pure functions with no DOM access, tested by tools/test_site_engine.mjs.
//
// A project in memory:
//   { id, name, width, height, cells, done, batchSize, location, created, updated }
//   cells: Uint8Array, one game colour id (1-64) per pixel, 0 = empty
//   done:  Uint8Array, 1 = marked done, 0 = still to paint
// Saved files and browser storage hold the same thing as plain JSON, with the
// two arrays packed as base64 text.

(function (root) {
  "use strict";

  const FORMAT = "worldplace-project";
  const VERSION = 1;
  const MAX_SIDE = 2000;

  function bytesToBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Done marks are stored 8 per byte to keep saves small.
  function packBits(flags) {
    const bits = new Uint8Array(Math.ceil(flags.length / 8));
    for (let i = 0; i < flags.length; i++) if (flags[i]) bits[i >> 3] |= 1 << (i & 7);
    return bits;
  }

  function unpackBits(bits, length) {
    const flags = new Uint8Array(length);
    for (let i = 0; i < length; i++) flags[i] = (bits[i >> 3] >> (i & 7)) & 1;
    return flags;
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function createProject({ name, width, height, cells, batchSize = 500 }) {
    const now = Date.now();
    return {
      id: newId(),
      name: name || "Untitled",
      width,
      height,
      cells: Uint8Array.from(cells),
      done: new Uint8Array(width * height),
      batchSize,
      location: { latitude: "", longitude: "", note: "" },
      created: now,
      updated: now,
    };
  }

  // Totals per colour id: total[id] pixels of that colour, left[id] not done.
  function progress(project) {
    const total = new Array(65).fill(0);
    const left = new Array(65).fill(0);
    let painted = 0;
    let doneCount = 0;
    const { cells, done } = project;
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      if (id === 0) continue;
      painted++;
      total[id]++;
      if (done[i]) doneCount++;
      else left[id]++;
    }
    return { painted, done: doneCount, total, left };
  }

  function serialize(project) {
    return {
      format: FORMAT,
      version: VERSION,
      id: project.id,
      name: project.name,
      width: project.width,
      height: project.height,
      batchSize: project.batchSize,
      location: project.location,
      created: project.created,
      updated: project.updated,
      cells: bytesToBase64(project.cells),
      done: bytesToBase64(packBits(project.done)),
    };
  }

  // Checks a saved file carefully and throws a readable error if it is wrong.
  function deserialize(data) {
    if (!data || data.format !== FORMAT) throw new Error("This isn't a WorldPlace project file.");
    if (data.version > VERSION) throw new Error("This file was made by a newer version of the site. Refresh the page and try again.");
    const width = Number(data.width);
    const height = Number(data.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
      throw new Error("The project size in this file is invalid.");
    }
    let cells, bits;
    try {
      cells = base64ToBytes(String(data.cells));
      bits = base64ToBytes(String(data.done));
    } catch (error) {
      throw new Error("This project file is damaged.");
    }
    if (cells.length !== width * height || bits.length !== Math.ceil((width * height) / 8)) {
      throw new Error("This project file is damaged (wrong number of pixels).");
    }
    for (const id of cells) if (id > 64) throw new Error("This project file has an unknown colour.");
    const location = data.location || {};
    return {
      id: typeof data.id === "string" && data.id ? data.id : newId(),
      name: typeof data.name === "string" && data.name ? data.name.slice(0, 80) : "Imported project",
      width,
      height,
      cells,
      done: unpackBits(bits, width * height),
      batchSize: Math.min(5000, Math.max(1, Number(data.batchSize) || 500)),
      location: {
        latitude: String(location.latitude || "").slice(0, 40),
        longitude: String(location.longitude || "").slice(0, 40),
        note: String(location.note || "").slice(0, 500),
      },
      created: Number(data.created) || Date.now(),
      updated: Number(data.updated) || Date.now(),
    };
  }

  // Seconds as friendly text, e.g. "2 h 30 min" or "3 days 4 h".
  function formatDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
    const days = Math.floor(hours / 24);
    const dayText = days === 1 ? "1 day" : `${days} days`;
    return hours % 24 ? `${dayText} ${hours % 24} h` : dayText;
  }

  const api = { createProject, progress, serialize, deserialize, packBits, unpackBits, formatDuration };
  if (typeof module !== "undefined") module.exports = api;
  else root.WorldPlaceProjects = api;
})(typeof window !== "undefined" ? window : globalThis);
