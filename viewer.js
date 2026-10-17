// A canvas that shows pixel art big, with zoom (wheel, pinch, buttons), pan
// (drag, Space+drag, two fingers) and an optional "paint" mode that reports
// which cells the pointer drags over. Used by the preview and the tracker.

(function (root) {
  "use strict";

  const MAX_SCALE = 80; // screen pixels per cell at most

  function checkerPattern(ctx) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 16;
    const t = tile.getContext("2d");
    t.fillStyle = "#3a4558";
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = "#2b3444";
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    return ctx.createPattern(tile, "repeat");
  }

  class PixelViewer {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.options = options;
      this.image = document.createElement("canvas");
      this.imageCtx = this.image.getContext("2d");
      this.imageData = null;
      this.width = 0;
      this.height = 0;
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.fitted = false;
      this.showGrid = true;
      this.mode = "pan"; // "pan" or "paint"
      this.highlightRect = null; // { x, y, w, h } in cells
      this.pointers = new Map();
      this.action = null;
      this.spaceDown = false;
      this.pattern = checkerPattern(this.ctx);
      this.drawQueued = false;

      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
      canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
      canvas.addEventListener("pointerup", (e) => this.pointerUp(e));
      canvas.addEventListener("pointercancel", (e) => this.pointerUp(e));
      canvas.addEventListener("pointerleave", (e) => {
        if (e.pointerType === "mouse" && this.options.onHover) this.options.onHover(null);
      });
      canvas.addEventListener("contextmenu", (e) => e.preventDefault());
      canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
      window.addEventListener("keydown", (e) => {
        if (e.code === "Space" && !isTyping(e.target) && this.isVisible()) {
          e.preventDefault();
          this.spaceDown = true;
          this.updateCursor();
        }
      });
      window.addEventListener("keyup", (e) => {
        if (e.code === "Space") {
          this.spaceDown = false;
          this.updateCursor();
        }
      });
      this.updateCursor();
    }

    isVisible() {
      return this.canvas.offsetParent !== null;
    }

    // Starts a new picture of width x height cells. Fill .pixels, then call update().
    setSize(width, height, keepView = false) {
      const changed = width !== this.width || height !== this.height;
      this.width = width;
      this.height = height;
      this.image.width = width;
      this.image.height = height;
      this.imageData = this.imageCtx.createImageData(width, height);
      if (changed && !keepView) this.fitted = false;
    }

    get pixels() {
      return this.imageData.data;
    }

    update() {
      if (!this.imageData) return;
      this.imageCtx.putImageData(this.imageData, 0, 0);
      if (!this.fitted) this.fit();
      this.requestDraw();
    }

    setMode(mode) {
      this.mode = mode;
      this.updateCursor();
    }

    updateCursor() {
      const panning = this.mode === "pan" || this.spaceDown;
      this.canvas.style.cursor = panning ? (this.action === "pan" ? "grabbing" : "grab") : "crosshair";
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.cssWidth = w;
      this.cssHeight = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      if (!this.fitted) this.fit();
      this.draw();
    }

    fit() {
      if (!this.width || !this.cssWidth) return;
      const pad = 16;
      this.scale = Math.min(MAX_SCALE, (this.cssWidth - pad * 2) / this.width, (this.cssHeight - pad * 2) / this.height);
      this.offsetX = (this.cssWidth - this.width * this.scale) / 2;
      this.offsetY = (this.cssHeight - this.height * this.scale) / 2;
      this.fitted = true;
      this.requestDraw();
    }

    zoomAt(factor, sx, sy) {
      if (!this.width) return;
      const fitScale = Math.min((this.cssWidth || 1) / this.width, (this.cssHeight || 1) / this.height);
      const next = Math.min(MAX_SCALE, Math.max(fitScale / 4, this.scale * factor));
      this.offsetX = sx - (sx - this.offsetX) * (next / this.scale);
      this.offsetY = sy - (sy - this.offsetY) * (next / this.scale);
      this.scale = next;
      this.requestDraw();
    }

    zoomBy(factor) {
      this.zoomAt(factor, (this.cssWidth || 0) / 2, (this.cssHeight || 0) / 2);
    }

    // Centres the view on a box of cells (used to jump to the next batch).
    showCells(rect) {
      if (!this.cssWidth) return;
      const pad = 40;
      const scale = Math.min(MAX_SCALE, (this.cssWidth - pad) / rect.w, (this.cssHeight - pad) / rect.h);
      if (scale > this.scale || rect.w * this.scale > this.cssWidth || rect.h * this.scale > this.cssHeight) {
        this.scale = Math.max(Math.min(scale, Math.max(this.scale, 4)), Math.min(scale, 1));
      }
      this.offsetX = this.cssWidth / 2 - (rect.x + rect.w / 2) * this.scale;
      this.offsetY = this.cssHeight / 2 - (rect.y + rect.h / 2) * this.scale;
      this.requestDraw();
    }

    localPoint(e) {
      const box = this.canvas.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    }

    cellAt(point) {
      return {
        x: Math.floor((point.x - this.offsetX) / this.scale),
        y: Math.floor((point.y - this.offsetY) / this.scale),
      };
    }

    pointerDown(e) {
      this.canvas.setPointerCapture(e.pointerId);
      const point = this.localPoint(e);
      this.pointers.set(e.pointerId, point);
      if (this.pointers.size === 2) {
        // Second finger: stop painting and start pinch-zooming.
        this.endPaint();
        this.action = "pinch";
        this.pinch = this.pinchState();
        return;
      }
      if (this.pointers.size > 2) return;
      const wantsPan = this.mode === "pan" || this.spaceDown || e.button === 1 || e.button === 2;
      if (wantsPan) {
        this.action = "pan";
        this.last = point;
      } else if (e.button === 0) {
        this.action = "paint";
        const cell = this.cellAt(point);
        this.lastCell = cell;
        if (this.options.onPaint) this.options.onPaint(cell.x, cell.y, true);
      }
      this.updateCursor();
    }

    pinchState() {
      const [a, b] = [...this.pointers.values()];
      return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    pointerMove(e) {
      const point = this.localPoint(e);
      if (e.pointerType === "mouse" && this.options.onHover) {
        const cell = this.cellAt(point);
        this.options.onHover(cell.x >= 0 && cell.y >= 0 && cell.x < this.width && cell.y < this.height ? cell : null);
      }
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, point);
      if (this.action === "pinch" && this.pointers.size >= 2) {
        const next = this.pinchState();
        this.offsetX += next.x - this.pinch.x;
        this.offsetY += next.y - this.pinch.y;
        this.zoomAt(next.distance / this.pinch.distance, next.x, next.y);
        this.pinch = next;
      } else if (this.action === "pan") {
        this.offsetX += point.x - this.last.x;
        this.offsetY += point.y - this.last.y;
        this.last = point;
        this.requestDraw();
      } else if (this.action === "paint") {
        const cell = this.cellAt(point);
        // Visit every cell between the last position and this one, so fast
        // drags don't leave gaps.
        let { x, y } = this.lastCell;
        const dx = Math.abs(cell.x - x), dy = -Math.abs(cell.y - y);
        const sx = x < cell.x ? 1 : -1, sy = y < cell.y ? 1 : -1;
        let error = dx + dy;
        while (x !== cell.x || y !== cell.y) {
          const e2 = 2 * error;
          if (e2 >= dy) { error += dy; x += sx; }
          if (e2 <= dx) { error += dx; y += sy; }
          if (this.options.onPaint) this.options.onPaint(x, y, false);
        }
        this.lastCell = cell;
      }
    }

    pointerUp(e) {
      this.pointers.delete(e.pointerId);
      if (this.action === "paint") this.endPaint();
      if (this.pointers.size === 0) this.action = null;
      else if (this.action === "pinch" && this.pointers.size === 1) this.action = "lifted"; // ignore the last finger
      this.updateCursor();
    }

    endPaint() {
      if (this.action === "paint" && this.options.onPaintEnd) this.options.onPaintEnd();
      this.action = null;
    }

    wheel(e) {
      e.preventDefault();
      const point = this.localPoint(e);
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 33;
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018));
      this.zoomAt(factor, point.x, point.y);
    }

    requestDraw() {
      if (this.drawQueued) return;
      this.drawQueued = true;
      requestAnimationFrame(() => {
        this.drawQueued = false;
        this.draw();
      });
    }

    draw() {
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.width || !this.cssWidth) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s = this.scale;
      const x0 = this.offsetX, y0 = this.offsetY;
      const w = this.width * s, h = this.height * s;

      ctx.fillStyle = this.pattern;
      ctx.fillRect(x0, y0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.image, x0, y0, w, h);

      // Only draw lines for the part of the picture on screen.
      const cx0 = Math.max(0, Math.floor(-x0 / s));
      const cx1 = Math.min(this.width, Math.ceil((this.cssWidth - x0) / s));
      const cy0 = Math.max(0, Math.floor(-y0 / s));
      const cy1 = Math.min(this.height, Math.ceil((this.cssHeight - y0) / s));
      const top = Math.max(y0, 0), bottom = Math.min(y0 + h, this.cssHeight);
      const left = Math.max(x0, 0), right = Math.min(x0 + w, this.cssWidth);

      if (s >= 10) {
        ctx.beginPath();
        for (let cx = cx0; cx <= cx1; cx++) { ctx.moveTo(x0 + cx * s, top); ctx.lineTo(x0 + cx * s, bottom); }
        for (let cy = cy0; cy <= cy1; cy++) { ctx.moveTo(left, y0 + cy * s); ctx.lineTo(right, y0 + cy * s); }
        ctx.strokeStyle = "rgba(0,0,0,0.22)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (this.showGrid) {
        ctx.beginPath();
        for (let cx = Math.ceil(cx0 / 64) * 64; cx <= cx1; cx += 64) { ctx.moveTo(x0 + cx * s, top); ctx.lineTo(x0 + cx * s, bottom); }
        for (let cy = Math.ceil(cy0 / 64) * 64; cy <= cy1; cy += 64) { ctx.moveTo(left, y0 + cy * s); ctx.lineTo(right, y0 + cy * s); }
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,196,61,0.95)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      if (this.highlightRect) {
        const r = this.highlightRect;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 4;
        ctx.strokeRect(x0 + r.x * s - 2, y0 + r.y * s - 2, r.w * s + 4, r.h * s + 4);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + r.x * s - 2, y0 + r.y * s - 2, r.w * s + 4, r.h * s + 4);
        ctx.setLineDash([]);
      }
    }
  }

  function isTyping(target) {
    return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  }

  root.PixelViewer = PixelViewer;
})(window);
