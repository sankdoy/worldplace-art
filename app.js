// WorldPlace Pixel Art: the page. Uses the engine (pixelate.js), saved
// projects (projects.js) and the zoomable canvas (viewer.js).

(function () {
  "use strict";

  const Engine = window.WorldPlacePixelate;
  const Projects = window.WorldPlaceProjects;
  const PALETTE = WORLDPLACE_PALETTE; // from palette.js
  const ROWS = WORLDPLACE_PALETTE_ROWS; // rows of similar colours, same as the game's palette bar
  const BY_ID = new Map(PALETTE.map((c) => [c.id, c]));
  const RGB = new Map(PALETTE.map((c) => [c.id, Engine.hexToRgb(c.hex)]));
  const DISPLAY_RANK = new Map(ROWS.flatMap((row) => row.ids).map((id, i) => [id, i]));
  const MAX_WIDTH = 1000;
  const MAX_BATCH = 5000;
  const RECHARGE_SECONDS = 30;

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString("en-US");
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // ---------- browser storage (never crash if it's blocked or full) ----------
  function load(key, fallback) {
    try {
      const text = localStorage.getItem(key);
      return text ? JSON.parse(text) : fallback;
    } catch (error) {
      return fallback;
    }
  }
  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }
  function forget(key) {
    try { localStorage.removeItem(key); } catch (error) { /* ignore */ }
  }

  const settings = Object.assign(
    { ownAll: false, premium: [], capacity: 30, batch: null, dither: "none", strength: 100, brightness: 0, contrast: 0, saturation: 0, width: 64 },
    load("wp.settings", {})
  );
  const saveSettings = () => store("wp.settings", settings);

  let toastTimer;
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const safeName = (name) => (name || "pixel-art").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "pixel-art";

  // Draws colour ids into a viewer. alphaFor(i) can fade pixels (0-255).
  function paintCells(viewer, cells, alphaFor) {
    const px = viewer.pixels;
    for (let i = 0; i < cells.length; i++) writeCell(px, cells, i, alphaFor);
  }
  function writeCell(px, cells, i, alphaFor) {
    const id = cells[i];
    const o = i * 4;
    if (id === 0) {
      px[o + 3] = 0;
      return;
    }
    const rgb = RGB.get(id);
    px[o] = rgb[0];
    px[o + 1] = rgb[1];
    px[o + 2] = rgb[2];
    px[o + 3] = alphaFor ? alphaFor(i) : 255;
  }

  function downloadPng(name, width, height, cells, scale) {
    const small = document.createElement("canvas");
    small.width = width;
    small.height = height;
    const ctx = small.getContext("2d");
    const data = ctx.createImageData(width, height);
    for (let i = 0; i < cells.length; i++) writeCell(data.data, cells, i);
    ctx.putImageData(data, 0, 0);
    let out = small;
    if (scale > 1) {
      out = document.createElement("canvas");
      out.width = width * scale;
      out.height = height * scale;
      const big = out.getContext("2d");
      big.imageSmoothingEnabled = false;
      big.drawImage(small, 0, 0, out.width, out.height);
    }
    out.toBlob((blob) => download(blob, `${safeName(name)}-${width}x${height}.png`), "image/png");
  }

  function legendItem(id, countText, doneFraction) {
    const colour = BY_ID.get(id);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    item.dataset.id = id;
    item.title = `${colour.name} (colour ${id}, #${colour.hex}${colour.premium ? ", premium" : ""})`;
    item.innerHTML = `<span class="chip" style="background:#${colour.hex}"></span><span class="name"></span><span class="count"></span>`;
    item.querySelector(".name").textContent = colour.name;
    item.querySelector(".count").textContent = countText;
    if (doneFraction !== undefined) {
      const bar = document.createElement("span");
      bar.className = "bar";
      bar.innerHTML = `<i style="width:${(doneFraction * 100).toFixed(1)}%"></i>`;
      item.appendChild(bar);
    }
    return item;
  }
  const byDisplayOrder = (a, b) => DISPLAY_RANK.get(a) - DISPLAY_RANK.get(b);

  // ---------- owner tools: open the site once with ?owner (or ?owner=0 to hide) ----------
  const ownerParam = new URLSearchParams(location.search).get("owner");
  if (ownerParam !== null) {
    try {
      if (ownerParam === "0") localStorage.removeItem("wp.owner");
      else localStorage.setItem("wp.owner", "1");
    } catch (error) { /* ignore */ }
  }
  const ownerMode = ownerParam === null ? load("wp.owner", 0) === 1 : ownerParam !== "0";
  document.body.classList.toggle("owner", ownerMode);

  // Copies the picture as text for the game's OWNER > IMPORT ART panel.
  async function copyForRoblox(name, width, height, cells) {
    const text = Projects.encodeForRoblox(width, height, cells);
    let painted = 0;
    for (const id of cells) if (id) painted++;
    const parts = Math.ceil(painted / 5000);
    const summary = `${fmt(painted)} pixels, ${parts} part${parts === 1 ? "" : "s"} of up to 5,000, ${fmt(text.length)} characters`;
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied (${summary}). In game: OWNER → IMPORT ART → paste.`);
    } catch (error) {
      // Clipboard blocked (some browsers): save it as a file to open and copy instead.
      download(new Blob([text], { type: "text/plain" }), `${safeName(name)}-roblox.txt`);
      toast(`Couldn't copy, so it was saved as a .txt file instead (${summary}).`);
    }
  }

  // =====================================================================
  // Views
  // =====================================================================
  function showView(name) {
    $("view-make").hidden = name !== "make";
    $("view-projects").hidden = name !== "projects";
    $("view-tracker").hidden = name !== "tracker";
    for (const tab of document.querySelectorAll(".tab")) {
      const active = tab.dataset.view === name || (name === "tracker" && tab.dataset.view === "projects");
      tab.setAttribute("aria-selected", String(active));
    }
    if (name === "projects") renderProjectList();
    if (name !== "tracker") flushSave();
    window.scrollTo(0, 0);
  }
  for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showView(tab.dataset.view));

  // =====================================================================
  // 2. Colours the player owns
  // =====================================================================
  function ownedColours() {
    return PALETTE.filter((c) => !c.premium || settings.ownAll || settings.premium.includes(c.id));
  }

  function buildColourGrid() {
    const grid = $("colourGrid");
    grid.innerHTML = "";
    for (const row of ROWS) {
      const line = document.createElement("div");
      line.className = "swatch-row";
      line.title = row.name;
      for (const id of row.ids) line.appendChild(makeSwatch(BY_ID.get(id)));
      grid.appendChild(line);
    }
  }

  function makeSwatch(colour) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "swatch" + (colour.premium ? "" : " free");
    swatch.style.background = `#${colour.hex}`;
    swatch.title = `${colour.name}${colour.premium ? " (premium)" : " (free)"}`;
    swatch.setAttribute("aria-label", swatch.title);
    swatch.dataset.id = colour.id;
    if (colour.premium) swatch.addEventListener("click", () => togglePremium(colour.id));
    return swatch;
  }

  function togglePremium(id) {
    if (settings.ownAll) {
      // Unticking one colour while "own all" is on: own all the others.
      settings.ownAll = false;
      settings.premium = PALETTE.filter((c) => c.premium && c.id !== id).map((c) => c.id);
    } else if (settings.premium.includes(id)) {
      settings.premium = settings.premium.filter((p) => p !== id);
    } else {
      settings.premium = [...settings.premium, id];
    }
    coloursChanged();
  }

  function coloursChanged() {
    saveSettings();
    updateColourUI();
    scheduleConvert(0);
  }

  function updateColourUI() {
    const owned = new Set(ownedColours().map((c) => c.id));
    for (const swatch of $("colourGrid").querySelectorAll(".swatch")) swatch.setAttribute("aria-pressed", String(owned.has(Number(swatch.dataset.id))));
    $("ownAll").checked = settings.ownAll;
    const premiumCount = owned.size - 32;
    $("colourSummary").textContent = premiumCount === 0
      ? "Using the 32 free colours."
      : `Using ${owned.size} colours: 32 free + ${premiumCount} premium.`;
  }

  $("ownAll").addEventListener("change", (e) => {
    settings.ownAll = e.target.checked;
    if (!settings.ownAll) settings.premium = [];
    coloursChanged();
  });
  $("premiumNone").addEventListener("click", () => {
    settings.ownAll = false;
    settings.premium = [];
    coloursChanged();
  });

  // =====================================================================
  // 1. Picture in (file, drag & drop, paste)
  // =====================================================================
  const make = {
    source: null, // ImageBitmap or <img>
    name: "",
    rotate: 0,
    flipH: false,
    flipV: false,
    oriented: null, // canvas with rotation/flip applied
    scaled: null, // { width, height, rgba }
    result: null, // { width, height, cells, counts, painted }
    paletteKey: "",
    palette: null,
  };

  async function openImage(file) {
    if (!file || !(file.type || "").startsWith("image/")) {
      toast("That isn't a picture file. Try a PNG or JPG.");
      return;
    }
    let image;
    try {
      image = await createImageBitmap(file);
    } catch (error) {
      image = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = URL.createObjectURL(file);
      });
    }
    if (!image || !image.width) {
      toast("Couldn't open this picture. Try saving it as PNG or JPG first.");
      return;
    }
    make.source = image;
    make.name = (file.name || "Pasted picture").replace(/\.[^.]+$/, "") || "Pasted picture";
    make.rotate = 0;
    make.flipH = make.flipV = false;
    const thumb = $("sourceThumb");
    if (thumb.src) URL.revokeObjectURL(thumb.src);
    thumb.src = URL.createObjectURL(file);
    thumb.hidden = false;
    $("dropText").innerHTML = "<b>Change picture</b>";
    $("sourceInfo").textContent = `${make.name}: ${fmt(image.width)} × ${fmt(image.height)} px`;
    $("makeEmpty").hidden = true;
    showView("make");
    makeViewer.fitted = false;
    buildOriented();
    scheduleConvert(0);
  }

  $("fileInput").addEventListener("change", (e) => {
    openImage(e.target.files[0]);
    e.target.value = "";
  });
  $("dropZone").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("fileInput").click();
    }
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    $("dropZone").classList.add("over");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) $("dropZone").classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropZone").classList.remove("over");
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) openImage(file);
  });
  document.addEventListener("paste", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    for (const item of (e.clipboardData && e.clipboardData.items) || []) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        openImage(item.getAsFile());
        return;
      }
    }
  });

  // Applies rotate/flip once at full size (capped so huge photos don't use too much memory).
  function buildOriented() {
    const src = make.source;
    const limit = 4096 / Math.max(src.width, src.height);
    const k = Math.min(1, limit);
    const dw = Math.round(src.width * k), dh = Math.round(src.height * k);
    const sideways = make.rotate % 2 === 1;
    const canvas = document.createElement("canvas");
    canvas.width = sideways ? dh : dw;
    canvas.height = sideways ? dw : dh;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(make.flipH ? -1 : 1, make.flipV ? -1 : 1);
    ctx.rotate((make.rotate * Math.PI) / 2);
    ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    make.oriented = canvas;
    make.scaled = null;
  }

  // Shrinks in halves for a clean result (one big jump looks grainy).
  function scaleTo(width) {
    let current = make.oriented;
    const height = Engine.heightForWidth(current.width, current.height, width);
    while (current.width >= width * 2 && current.height >= height * 2) {
      const half = document.createElement("canvas");
      half.width = Math.ceil(current.width / 2);
      half.height = Math.ceil(current.height / 2);
      const ctx = half.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(current, 0, 0, half.width, half.height);
      current = half;
    }
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d", { willReadFrequently: true });
    // Enlarging a small picture: keep its pixels sharp instead of blurring.
    ctx.imageSmoothingEnabled = width <= current.width;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, width, height);
    return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
  }

  // =====================================================================
  // 3 & 4. Size and look, then convert
  // =====================================================================
  const makeViewer = new PixelViewer($("makeCanvas"), { onHover: (cell) => makeHover(cell) });
  makeViewer.setMode("pan");

  let convertTimer;
  function scheduleConvert(delay = 80) {
    if (!make.source) return;
    clearTimeout(convertTimer);
    $("makeBusy").hidden = false;
    // A short wait lets sliders move smoothly and lets "Working…" appear.
    convertTimer = setTimeout(convert, Math.max(delay, 16));
  }

  function convert() {
    if (!make.source) return;
    const width = clamp(Math.round(settings.width) || 64, 1, MAX_WIDTH);
    if (!make.scaled || make.scaled.width !== width) make.scaled = scaleTo(width);
    const { height, rgba } = make.scaled;
    const owned = ownedColours();
    const key = owned.map((c) => c.id).join(",");
    if (key !== make.paletteKey) {
      make.palette = Engine.buildPalette(owned);
      make.paletteKey = key;
    }
    const indices = Engine.quantize(rgba, width, height, make.palette, {
      dither: settings.dither,
      strength: settings.strength / 100,
      brightness: settings.brightness,
      contrast: settings.contrast,
      saturation: settings.saturation,
    });
    const cells = new Uint8Array(indices.length);
    for (let i = 0; i < indices.length; i++) cells[i] = indices[i] < 0 ? 0 : owned[indices[i]].id;
    const counts = new Array(65).fill(0);
    let painted = 0;
    for (const id of cells) if (id) { counts[id]++; painted++; }
    make.result = { width, height, cells, counts, painted };

    const sizeChanged = makeViewer.width !== width || makeViewer.height !== height;
    makeViewer.setSize(width, height, !sizeChanged);
    paintCells(makeViewer, cells);
    makeViewer.update();
    $("heightOut").textContent = fmt(height);
    $("makeBusy").hidden = true;
    $("downloadPng").disabled = false;
    $("startProject").disabled = painted === 0;
    $("copyRoblox").disabled = painted === 0;
    updatePlan();
    renderMakeLegend();
  }

  function makeHover(cell) {
    // Shows what's under the mouse in the preview, like in the tracker.
    if (!cell || !make.result) return;
    const id = make.result.cells[cell.y * make.result.width + cell.x];
    $("makeCanvas").title = `Column ${cell.x + 1}, row ${cell.y + 1}: ${id ? BY_ID.get(id).name : "empty"}`;
  }

  function renderMakeLegend() {
    const legend = $("makeLegend");
    legend.innerHTML = "";
    const { counts } = make.result;
    const ids = PALETTE.map((c) => c.id).filter((id) => counts[id] > 0).sort(byDisplayOrder);
    for (const id of ids) legend.appendChild(legendItem(id, fmt(counts[id])));
    if (!ids.length) legend.innerHTML = '<p class="hint">The picture is completely transparent.</p>';
  }

  // Width box (height is calculated from the picture's shape).
  $("widthInput").value = settings.width;
  $("widthInput").addEventListener("input", (e) => {
    const value = Number(e.target.value);
    if (Number.isInteger(value) && value >= 1 && value <= MAX_WIDTH) {
      settings.width = value;
      saveSettings();
      scheduleConvert(250);
    }
  });
  $("widthInput").addEventListener("change", (e) => {
    const value = clamp(Math.round(Number(e.target.value)) || 64, 1, MAX_WIDTH);
    e.target.value = value;
    if (value !== settings.width) {
      settings.width = value;
      saveSettings();
      scheduleConvert(0);
    }
  });

  function transformChanged() {
    if (!make.source) return;
    makeViewer.fitted = false;
    buildOriented();
    scheduleConvert(0);
  }
  $("rotateBtn").addEventListener("click", () => { make.rotate = (make.rotate + 1) % 4; transformChanged(); });
  $("flipHBtn").addEventListener("click", () => { make.flipH = !make.flipH; transformChanged(); });
  $("flipVBtn").addEventListener("click", () => { make.flipV = !make.flipV; transformChanged(); });

  // Dithering and sliders.
  const ditherSelect = $("ditherSelect");
  for (const option of Engine.DITHER_OPTIONS) ditherSelect.add(new Option(option.label, option.id));
  ditherSelect.value = settings.dither;
  ditherSelect.addEventListener("change", () => {
    settings.dither = ditherSelect.value;
    saveSettings();
    updateLookUI();
    scheduleConvert(0);
  });
  const sliders = [
    ["strength", (v) => `${v}%`],
    ["brightness", (v) => (v > 0 ? `+${v}` : `${v}`)],
    ["contrast", (v) => (v > 0 ? `+${v}` : `${v}`)],
    ["saturation", (v) => (v > 0 ? `+${v}` : `${v}`)],
  ];
  for (const [name] of sliders) {
    $(`${name}Input`).addEventListener("input", (e) => {
      settings[name] = Number(e.target.value);
      saveSettings();
      updateLookUI();
      scheduleConvert(60);
    });
  }
  function updateLookUI() {
    for (const [name, label] of sliders) {
      $(`${name}Input`).value = settings[name];
      $(`${name}Out`).textContent = label(settings[name]);
    }
    $("strengthInput").disabled = settings.dither === "none";
  }
  $("resetLook").addEventListener("click", () => {
    Object.assign(settings, { dither: "none", strength: 100, brightness: 0, contrast: 0, saturation: 0 });
    ditherSelect.value = "none";
    saveSettings();
    updateLookUI();
    scheduleConvert(0);
  });

  // Preview toolbar.
  $("makeFit").addEventListener("click", () => makeViewer.fit());
  $("makeZoomIn").addEventListener("click", () => makeViewer.zoomBy(1.5));
  $("makeZoomOut").addEventListener("click", () => makeViewer.zoomBy(1 / 1.5));
  $("makeGrid").addEventListener("change", (e) => {
    makeViewer.showGrid = e.target.checked;
    makeViewer.requestDraw();
  });
  $("downloadPng").addEventListener("click", () => {
    const r = make.result;
    if (r) downloadPng(make.name, r.width, r.height, r.cells, Number($("pngScale").value));
  });

  // =====================================================================
  // 5. Painting plan (batches and charge time)
  // =====================================================================
  function batchSize() {
    if (settings.batch) return clamp(settings.batch, 1, MAX_BATCH);
    return clamp(Math.min(settings.capacity, 500), 1, MAX_BATCH); // automatic until the player picks one
  }

  function updatePlan() {
    const capacity = clamp(settings.capacity, 1, 3000);
    const batch = batchSize();
    $("capacityInput").value = capacity;
    if (document.activeElement !== $("batchInput")) $("batchInput").value = batch;
    const painted = make.result ? make.result.painted : 0;
    const batches = Math.ceil(painted / batch);
    const last = painted % batch;
    $("statPixels").textContent = make.result ? fmt(painted) : "–";
    $("statBatches").textContent = make.result ? fmt(batches) : "–";
    $("statBatchesHint").textContent = make.result
      ? `of ${fmt(batch)} pixels${batches > 1 && last ? ` (last one ${fmt(last)})` : ""}`
      : "";
    $("statTime").textContent = make.result ? Projects.formatDuration(painted * RECHARGE_SECONDS) : "–";

    const advice = [];
    advice.push(`Each batch of ${fmt(batch)} needs ${fmt(batch)} charges, which take ${Projects.formatDuration(batch * RECHARGE_SECONDS)} to refill from empty.`);
    if (batch > capacity) {
      advice.push(`<span class="warn">Your capacity is ${fmt(capacity)} charges, so you can't CONFIRM more than ${fmt(capacity)} changed pixels at once. Use a batch size of ${fmt(capacity)} or less, or get more capacity in the SHOP.</span>`);
    }
    if (batch > 2000) advice.push('<span class="warn">Batches over 2,000 can make the game lag. Smaller is safer.</span>');
    advice.push("Pixels that are already the right colour on the map cost nothing, so it may take less.");
    $("batchAdvice").innerHTML = advice.join(" ");
  }

  $("capacityInput").value = settings.capacity;
  $("capacityInput").addEventListener("input", (e) => {
    const value = Number(e.target.value);
    if (value >= 1 && value <= 3000) {
      settings.capacity = Math.round(value);
      saveSettings();
      updatePlan();
    }
  });
  $("capacityInput").addEventListener("change", () => updatePlan());
  $("batchInput").addEventListener("input", (e) => {
    const value = Number(e.target.value);
    if (value >= 1 && value <= MAX_BATCH) {
      settings.batch = Math.round(value);
      saveSettings();
      updatePlan();
    }
  });
  $("batchInput").addEventListener("change", (e) => {
    settings.batch = clamp(Math.round(Number(e.target.value)) || 500, 1, MAX_BATCH);
    saveSettings();
    e.target.value = settings.batch;
    updatePlan();
  });
  for (const button of $("batchPresets").querySelectorAll("[data-batch]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.batch;
      settings.batch = value === "cap" ? clamp(settings.capacity, 1, MAX_BATCH) : Number(value);
      saveSettings();
      $("batchInput").value = settings.batch;
      updatePlan();
    });
  }

  $("copyRoblox").addEventListener("click", () => {
    const r = make.result;
    if (r) copyForRoblox(make.name, r.width, r.height, r.cells);
  });

  $("startProject").addEventListener("click", () => {
    const r = make.result;
    if (!r) return;
    const project = Projects.createProject({ name: make.name, width: r.width, height: r.height, cells: r.cells, batchSize: batchSize() });
    if (!saveProject(project)) return;
    openProject(project.id);
    toast("Project saved. Mark pixels done as you paint them in game.");
  });

  // =====================================================================
  // Saved projects
  // =====================================================================
  const projectIndex = () => load("wp.projects", []);

  function saveProject(project) {
    project.updated = Date.now();
    const ok = store(`wp.project.${project.id}`, Projects.serialize(project));
    if (!ok) {
      $("saveStatus").innerHTML = '<span class="warn">Couldn\'t save: browser storage is full or blocked. Export a progress file now, and delete old projects.</span>';
      toast("Couldn't save in this browser. Use Export progress file to keep it.");
      return false;
    }
    const p = Projects.progress(project);
    const index = projectIndex().filter((item) => item.id !== project.id);
    index.push({ id: project.id, name: project.name, width: project.width, height: project.height, painted: p.painted, done: p.done, updated: project.updated });
    store("wp.projects", index);
    $("saveStatus").textContent = "Saved in this browser ✓";
    updateProjectCount();
    return true;
  }

  function loadProject(id) {
    const data = load(`wp.project.${id}`, null);
    if (!data) return null;
    try {
      return Projects.deserialize(data);
    } catch (error) {
      return null;
    }
  }

  function deleteProject(id) {
    forget(`wp.project.${id}`);
    store("wp.projects", projectIndex().filter((item) => item.id !== id));
    updateProjectCount();
  }

  function updateProjectCount() {
    $("projectCount").textContent = projectIndex().length;
  }

  function exportProject(project) {
    const blob = new Blob([JSON.stringify(Projects.serialize(project))], { type: "application/json" });
    download(blob, `${safeName(project.name)}.worldplace.json`);
  }

  function renderProjectList() {
    const list = $("projectList");
    list.innerHTML = "";
    const index = projectIndex().sort((a, b) => b.updated - a.updated);
    if (!index.length) {
      list.innerHTML = '<p class="hint">No projects yet. Make pixel art, then press <b>Save as project &amp; start tracking</b>.</p>';
      return;
    }
    for (const item of index) {
      const project = loadProject(item.id);
      const row = document.createElement("div");
      row.className = "project";
      const thumb = document.createElement("canvas");
      if (project) {
        thumb.width = project.width;
        thumb.height = project.height;
        const ctx = thumb.getContext("2d");
        const data = ctx.createImageData(project.width, project.height);
        for (let i = 0; i < project.cells.length; i++) writeCell(data.data, project.cells, i);
        ctx.putImageData(data, 0, 0);
      }
      const pct = item.painted ? Math.floor((item.done / item.painted) * 100) : 0;
      const info = document.createElement("div");
      info.innerHTML = `<h3></h3>
        <div class="hint">${fmt(item.width)} × ${fmt(item.height)} · ${fmt(item.done)} of ${fmt(item.painted)} done (${pct}%) · ${new Date(item.updated).toLocaleDateString()}</div>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="row">
          <button class="btn small" data-act="open">Open</button>
          <button class="btn small" data-act="export">Export</button>
          <button class="btn small danger" data-act="delete">Delete</button>
        </div>`;
      info.querySelector("h3").textContent = item.name;
      if (!project) info.querySelector(".hint").textContent = "This project couldn't be read.";
      info.querySelector('[data-act="open"]').disabled = !project;
      info.querySelector('[data-act="export"]').disabled = !project;
      info.addEventListener("click", (e) => {
        const act = e.target.dataset.act;
        if (act === "open") openProject(item.id);
        if (act === "export") exportProject(project);
        if (act === "delete" && confirm(`Delete "${item.name}"? This can't be undone (export it first if you want a backup).`)) {
          deleteProject(item.id);
          renderProjectList();
        }
      });
      row.append(thumb, info);
      list.appendChild(row);
    }
  }

  $("importInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let project;
    try {
      project = Projects.deserialize(JSON.parse(await file.text()));
    } catch (error) {
      toast(error instanceof SyntaxError ? "This isn't a WorldPlace project file." : error.message);
      return;
    }
    if (projectIndex().some((item) => item.id === project.id)) {
      const replace = confirm(`You already have "${project.name}" here. Replace it with the progress from this file?\n\nOK = replace, Cancel = keep both`);
      if (!replace) project.id = Projects.createProject({ width: 1, height: 1, cells: [0] }).id;
    }
    if (saveProject(project)) {
      toast(`Imported "${project.name}".`);
      openProject(project.id);
    }
  });

  // =====================================================================
  // Tracker: mark pixels done
  // =====================================================================
  const track = {
    project: null,
    progress: null,
    order: null,
    highlight: 0, // colour id, 0 = none
    batch: null, // { mask, count, rect }
    tool: "done",
    undo: [],
    stroke: null,
  };

  const trackViewer = new PixelViewer($("trackCanvas"), {
    onPaint: (x, y, first) => brush(x, y, first),
    onPaintEnd: () => endStroke(),
    onHover: (cell) => trackHover(cell),
  });
  trackViewer.setMode("paint");

  // How strongly each pixel shows: full colour = still to paint.
  function trackAlpha(i) {
    const { cells, done } = track.project;
    if (track.batch) return done[i] ? 40 : track.batch.mask[i] ? 255 : 70;
    if (track.highlight) return cells[i] === track.highlight ? (done[i] ? 60 : 255) : 22;
    return done[i] ? 55 : 255;
  }

  function redrawTracker() {
    paintCells(trackViewer, track.project.cells, trackAlpha);
    trackViewer.update();
  }

  function openProject(id) {
    const project = loadProject(id);
    if (!project) {
      toast("Couldn't open that project.");
      return;
    }
    track.project = project;
    track.progress = Projects.progress(project);
    track.order = Engine.batchOrder(project.width, project.height);
    track.highlight = 0;
    track.batch = null;
    track.undo = [];
    trackViewer.highlightRect = null;
    trackViewer.fitted = false;
    trackViewer.setSize(project.width, project.height);
    $("projectName").value = project.name;
    $("trackBatchSize").value = project.batchSize;
    $("locLat").value = project.location.latitude;
    $("locLon").value = project.location.longitude;
    $("locNote").value = project.location.note;
    $("saveStatus").textContent = "Saved in this browser ✓";
    showView("tracker");
    redrawTracker();
    updateTrackerPanels();
  }

  function updateTrackerPanels() {
    const { progress: p } = track;
    const pct = p.painted ? (p.done / p.painted) * 100 : 0;
    $("progressBar").style.width = `${pct}%`;
    $("progressText").textContent = `${fmt(p.done)} of ${fmt(p.painted)} done (${Math.floor(pct)}%)`;
    const left = p.painted - p.done;
    $("progressTime").textContent = left
      ? `${fmt(left)} pixels left: about ${Projects.formatDuration(left * RECHARGE_SECONDS)} of charge time.`
      : "Finished! 🎉";
    $("undoMark").disabled = track.undo.length === 0;
    $("clearHighlight").hidden = !track.highlight;
    renderTrackLegend();
    updateBatchInfo();
  }

  function renderTrackLegend() {
    const legend = $("trackLegend");
    legend.innerHTML = "";
    const { total, left } = track.progress;
    const ids = PALETTE.map((c) => c.id).filter((id) => total[id] > 0).sort(byDisplayOrder);
    for (const id of ids) {
      const item = legendItem(id, left[id] ? `${fmt(left[id])} left` : "done ✓", (total[id] - left[id]) / total[id]);
      if (id === track.highlight) item.classList.add("active");
      if (!left[id]) item.classList.add("finished");
      item.addEventListener("click", () => setHighlight(id === track.highlight ? 0 : id));
      legend.appendChild(item);
    }
  }

  function setHighlight(id) {
    track.highlight = id;
    if (track.batch) computeBatch(true);
    redrawTracker();
    updateTrackerPanels();
  }
  $("clearHighlight").addEventListener("click", () => setHighlight(0));

  function brush(x, y, first) {
    const project = track.project;
    if (first) track.stroke = [];
    if (!track.stroke) return;
    const size = Number($("brushSize").value);
    const half = Math.floor(size / 2);
    const value = track.tool === "done" ? 1 : 0;
    const onlyColour = $("brushOnlyColour").checked && track.highlight;
    const px = trackViewer.pixels;
    let changed = false;
    for (let cy = y - half; cy <= y + half; cy++) {
      if (cy < 0 || cy >= project.height) continue;
      for (let cx = x - half; cx <= x + half; cx++) {
        if (cx < 0 || cx >= project.width) continue;
        const i = cy * project.width + cx;
        const id = project.cells[i];
        if (!id || project.done[i] === value) continue;
        if (onlyColour && id !== track.highlight) continue;
        setDone(i, value);
        track.stroke.push(i);
        writeCell(px, project.cells, i, trackAlpha);
        changed = true;
      }
    }
    if (changed) {
      trackViewer.update();
      $("progressText").textContent = `${fmt(track.progress.done)} of ${fmt(track.progress.painted)} done`;
    }
  }

  function setDone(i, value) {
    const id = track.project.cells[i];
    track.project.done[i] = value;
    track.progress.done += value ? 1 : -1;
    track.progress.left[id] += value ? -1 : 1;
  }

  function endStroke() {
    const stroke = track.stroke;
    track.stroke = null;
    if (!stroke || !stroke.length) return;
    pushUndo(stroke, track.tool === "done" ? 1 : 0);
    scheduleSave();
    updateTrackerPanels();
  }

  function pushUndo(cells, value) {
    track.undo.push({ cells, value });
    if (track.undo.length > 100) track.undo.shift();
  }

  function undo() {
    const step = track.undo.pop();
    if (!step) return;
    for (const i of step.cells) setDone(i, step.value ? 0 : 1);
    redrawTracker();
    scheduleSave();
    updateTrackerPanels();
    toast(`Undid ${fmt(step.cells.length)} pixel${step.cells.length === 1 ? "" : "s"}.`);
  }
  $("undoMark").addEventListener("click", undo);
  window.addEventListener("keydown", (e) => {
    if ($("view-tracker").hidden || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    e.preventDefault();
    undo();
  });

  function trackHover(cell) {
    if (!cell) {
      $("hoverInfo").textContent = "Tap or drag over pixels to mark them done. Pinch or scroll to zoom. Hold Space (or use ✋ Move) to drag the picture around.";
      return;
    }
    const project = track.project;
    const i = cell.y * project.width + cell.x;
    const id = project.cells[i];
    const what = id ? `${BY_ID.get(id).name} · ${project.done[i] ? "done ✓" : "still to paint"}` : "empty (leave the map as it is)";
    $("hoverInfo").textContent = `Column ${cell.x + 1}, row ${cell.y + 1}: ${what}`;
  }

  // Tools and view buttons.
  for (const button of document.querySelectorAll("[data-tool]")) {
    button.addEventListener("click", () => {
      track.tool = button.dataset.tool;
      for (const other of document.querySelectorAll("[data-tool]")) other.setAttribute("aria-pressed", String(other === button));
      trackViewer.setMode(track.tool === "pan" ? "pan" : "paint");
    });
  }
  $("trackFit").addEventListener("click", () => trackViewer.fit());
  $("trackZoomIn").addEventListener("click", () => trackViewer.zoomBy(1.5));
  $("trackZoomOut").addEventListener("click", () => trackViewer.zoomBy(1 / 1.5));
  $("trackGrid").addEventListener("change", (e) => {
    trackViewer.showGrid = e.target.checked;
    trackViewer.requestDraw();
  });
  $("backToProjects").addEventListener("click", () => showView("projects"));

  // ---------- next batch ----------
  function computeBatch(keepView) {
    const project = track.project;
    const limit = clamp(project.batchSize, 1, MAX_BATCH);
    const mask = new Uint8Array(project.cells.length);
    let count = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (const i of track.order) {
      const id = project.cells[i];
      if (!id || project.done[i] || (track.highlight && id !== track.highlight)) continue;
      mask[i] = 1;
      const x = i % project.width, y = (i - x) / project.width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (++count >= limit) break;
    }
    track.batch = { mask, count, rect: count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null };
    trackViewer.highlightRect = track.batch.rect;
    if (track.batch.rect && !keepView) trackViewer.showCells(track.batch.rect);
  }

  function updateBatchInfo() {
    const batch = track.batch;
    $("batchToggle").textContent = batch ? "Hide batch" : "Show next batch";
    $("batchDone").hidden = !batch || !batch.count;
    if (!batch) {
      $("batchInfo").textContent = "";
      return;
    }
    if (!batch.count) {
      $("batchInfo").textContent = track.highlight ? `No ${BY_ID.get(track.highlight).name} pixels left to paint.` : "Nothing left to paint. Well done!";
      return;
    }
    const { cells, done } = track.project;
    const perColour = new Map();
    let left = 0;
    for (let i = 0; i < batch.mask.length; i++) {
      if (!batch.mask[i] || done[i]) continue;
      left++;
      perColour.set(cells[i], (perColour.get(cells[i]) || 0) + 1);
    }
    const r = batch.rect;
    const colours = [...perColour.entries()].sort((a, b) => b[1] - a[1]);
    const shown = colours.slice(0, 6).map(([id, n]) => `${BY_ID.get(id).name} ${fmt(n)}`).join(", ");
    $("batchInfo").textContent =
      `${fmt(left)} of ${fmt(batch.count)} pixels left in this batch (columns ${r.x + 1}–${r.x + r.w}, rows ${r.y + 1}–${r.y + r.h}). ` +
      `Colours: ${shown}${colours.length > 6 ? ` and ${colours.length - 6} more` : ""}.`;
  }

  $("batchToggle").addEventListener("click", () => {
    if (track.batch) {
      track.batch = null;
      trackViewer.highlightRect = null;
    } else {
      computeBatch(false);
    }
    redrawTracker();
    updateTrackerPanels();
  });

  $("batchDone").addEventListener("click", () => {
    const batch = track.batch;
    if (!batch) return;
    const changed = [];
    for (let i = 0; i < batch.mask.length; i++) {
      if (batch.mask[i] && !track.project.done[i]) {
        setDone(i, 1);
        changed.push(i);
      }
    }
    if (changed.length) pushUndo(changed, 1);
    computeBatch(false);
    redrawTracker();
    scheduleSave();
    updateTrackerPanels();
    toast(track.batch.count ? `Marked ${fmt(changed.length)} pixels done. Here's the next batch.` : `Marked ${fmt(changed.length)} pixels done. All finished!`);
  });

  $("trackBatchSize").addEventListener("change", (e) => {
    const value = clamp(Math.round(Number(e.target.value)) || 500, 1, MAX_BATCH);
    e.target.value = value;
    track.project.batchSize = value;
    scheduleSave();
    if (track.batch) {
      computeBatch(false);
      redrawTracker();
      updateTrackerPanels();
    }
  });

  // ---------- name, location, export ----------
  $("projectName").addEventListener("input", (e) => {
    track.project.name = e.target.value.slice(0, 80) || "Untitled";
    scheduleSave();
  });
  for (const [input, field] of [["locLat", "latitude"], ["locLon", "longitude"], ["locNote", "note"]]) {
    $(input).addEventListener("input", (e) => {
      track.project.location[field] = e.target.value;
      scheduleSave();
    });
  }
  $("exportProject").addEventListener("click", () => {
    flushSave();
    exportProject(track.project);
  });
  $("trackCopyRoblox").addEventListener("click", () => {
    const p = track.project;
    copyForRoblox(p.name, p.width, p.height, p.cells);
  });
  $("trackPng").addEventListener("click", () => {
    const p = track.project;
    downloadPng(p.name, p.width, p.height, p.cells, 8);
  });
  $("deleteProject").addEventListener("click", () => {
    const p = track.project;
    if (!confirm(`Delete "${p.name}"? This can't be undone (export it first if you want a backup).`)) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    deleteProject(p.id);
    track.project = null;
    showView("projects");
  });

  // Saves shortly after changes, and right away when leaving the page.
  let saveTimer = null;
  function scheduleSave() {
    $("saveStatus").textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (track.project) saveProject(track.project);
  }
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  // =====================================================================
  // Start up
  // =====================================================================
  buildColourGrid();
  updateColourUI();
  updateLookUI();
  updatePlan();
  updateProjectCount();
  showView("make");
})();
