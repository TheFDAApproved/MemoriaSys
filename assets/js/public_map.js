// assets/js/public_map.js
const PUBLIC_MAP = (() => {
  const API_URL = "api/blocks.php";
  const PADDING = 40;
  const MAX_SCALE = 1.5; // cap zoom-in for tiny maps
  const PLACEHOLDER_WAIT_MS = 8000;

  let canvasWrap, cv, ctx;
  let cvW = 0,
    cvH = 0;
  let blocks = {}; // bid → block row (+ points, bounds)
  let blockOrder = []; // bid[] in draw order
  let hoveredBlock = null;
  let rafPending = false;
  let loadingEl = null;
  let modalEl = null;

  // ── GEOMETRY ──────────────────────────────────────────────
  function parseCoordinates(c) {
    if (!c) return null;
    if (Array.isArray(c)) return c.length >= 3 ? c : null;
    try {
      const pts = JSON.parse(c);
      return Array.isArray(pts) && pts.length >= 3 ? pts : null;
    } catch {
      return null;
    }
  }

  function polyBounds(pts) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function pointInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x,
        yi = pts[i].y;
      const xj = pts[j].x,
        yj = pts[j].y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  // ── CANVAS ────────────────────────────────────────────────
  function syncCanvasSize() {
    if (!canvasWrap || !cv) return;
    const w = canvasWrap.clientWidth;
    const h = canvasWrap.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    cvW = w;
    cvH = h;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      draw();
    });
  }

  // ── DRAW ──────────────────────────────────────────────────
  function draw() {
    if (!ctx) return;
    if (!cvW || !cvH) {
      syncCanvasSize();
      if (!cvW || !cvH) return; // wait for a real size
    }
    ctx.clearRect(0, 0, cvW, cvH);

    if (!blockOrder.length) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No blocks have been mapped yet.", cvW / 2, cvH / 2);
      ctx.textBaseline = "alphabetic";
      return;
    }

    // Fit-to-screen: global bounds of all valid blocks
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const bid of blockOrder) {
      const pts = blocks[bid].points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    const mapW = Math.max(1, maxX - minX);
    const mapH = Math.max(1, maxY - minY);
    let scale = Math.min(
      (cvW - PADDING * 2) / mapW,
      (cvH - PADDING * 2) / mapH,
    );
    scale = Math.min(scale, MAX_SCALE);
    const offsetX = (cvW - mapW * scale) / 2 - minX * scale;
    const offsetY = (cvH - mapH * scale) / 2 - minY * scale;

    for (const bid of blockOrder) {
      const b = blocks[bid];
      const pts = b.points;
      const hov = hoveredBlock === bid;

      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const px = pts[i].x * scale + offsetX;
        const py = pts[i].y * scale + offsetY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      ctx.fillStyle = hov ? "#bfdbfe" : "#dbeafe";
      ctx.strokeStyle = hov ? "#1d4ed8" : "#3b82f6";
      ctx.lineWidth = hov ? 3 : 2;
      ctx.fill();
      ctx.stroke();

      // Label
      const bnds = b.bounds;
      const cx = (bnds.x + bnds.w / 2) * scale + offsetX;
      const cy = (bnds.y + bnds.h / 2) * scale + offsetY;

      ctx.fillStyle = "#1e3a5f";
      ctx.font = "600 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.block_name, cx, cy);
      ctx.textBaseline = "alphabetic";
    }

    // Store transform for hit-testing
    cv._mapScale = scale;
    cv._mapOffsetX = offsetX;
    cv._mapOffsetY = offsetY;
  }

  // ── EVENTS ────────────────────────────────────────────────
  function getXY(e) {
    const r = cv.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    return { x: s.clientX - r.left, y: s.clientY - r.top };
  }

  function getHitBlock(x, y) {
    if (!cv._mapScale) return null;
    const mx = (x - cv._mapOffsetX) / cv._mapScale;
    const my = (y - cv._mapOffsetY) / cv._mapScale;
    return blockOrder
      .slice()
      .reverse()
      .find((id) => pointInPoly(mx, my, blocks[id].points));
  }

  function initEvents() {
    cv.addEventListener("mousemove", (e) => {
      const { x, y } = getXY(e);
      const bid = getHitBlock(x, y) || null;
      if (bid !== hoveredBlock) {
        hoveredBlock = bid;
        canvasWrap.style.cursor = bid ? "pointer" : "default";
        scheduleDraw();
      }
    });

    cv.addEventListener("mouseleave", () => {
      if (hoveredBlock) {
        hoveredBlock = null;
        canvasWrap.style.cursor = "default";
        scheduleDraw();
      }
    });

    cv.addEventListener("click", (e) => {
      const { x, y } = getXY(e);
      const bid = getHitBlock(x, y);
      if (bid) openImageModal(blocks[bid]);
    });
  }

  // ── MODAL ─────────────────────────────────────────────────
  function openImageModal(b) {
    if (!modalEl) return;
    const titleEl = document.getElementById("pubMapModalTitle");
    const imgEl = document.getElementById("pubMapModalImg");
    const noImgEl = document.getElementById("pubMapModalNoImg");
    if (!titleEl || !imgEl || !noImgEl) return;

    titleEl.textContent = b.block_name || "Block";

    const url = (b.image_link || "").trim();
    if (url) {
      imgEl.src = url;
      imgEl.style.display = "block";
      noImgEl.style.display = "none";
      imgEl.onerror = () => {
        imgEl.style.display = "none";
        imgEl.removeAttribute("src");
        noImgEl.textContent = "Image could not be loaded.";
        noImgEl.style.display = "block";
      };
    } else {
      imgEl.style.display = "none";
      imgEl.removeAttribute("src");
      noImgEl.textContent = "No photo has been uploaded for this block.";
      noImgEl.style.display = "block";
    }

    modalEl.style.display = "flex";
  }

  function closeImageModal() {
    if (!modalEl) return;
    modalEl.style.display = "none";
  }

  // ── LOADING ───────────────────────────────────────────────
  function setLoadingHTML(html) {
    if (!loadingEl) return;
    loadingEl.innerHTML = html;
    loadingEl.style.display = "flex";
  }

  function showLoading() {
    setLoadingHTML(`
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
        <div style="width:32px;height:32px;border:3px solid #cbd5e1;border-top-color:#3b82f6;border-radius:50%;animation:pubMapSpin 0.8s linear infinite"></div>
        <div style="color:#64748b;font-size:13px">Loading map…</div>
      </div>
    `);
  }

  function showError(msg) {
    setLoadingHTML(
      `<div style="text-align:center;padding:20px;color:#ef4444;font-size:13px">${msg}</div>`,
    );
  }

  function hideLoading() {
    if (loadingEl) loadingEl.style.display = "none";
  }

  function injectStyle() {
    if (document.getElementById("pubMapStyle")) return;
    const s = document.createElement("style");
    s.id = "pubMapStyle";
    s.textContent = `@keyframes pubMapSpin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(s);
  }

  // ── PLACEHOLDER WAIT ──────────────────────────────────────
  // Polls for the "Loading..." placeholder instead of a fixed
  // blind delay so we still hook in if the parent renders late.
  function waitForPlaceholder(maxWaitMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const el = Array.from(document.querySelectorAll("h3, p")).find((e) =>
          e.textContent.includes("Loading..."),
        );
        if (el) return resolve(el);
        if (Date.now() - start > maxWaitMs) return resolve(null);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // ── INIT ──────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", async () => {
    injectStyle();

    const placeholder = await waitForPlaceholder(PLACEHOLDER_WAIT_MS);
    if (!placeholder) return;

    const mapCard = placeholder.closest(".mapCanvasCard");
    if (!mapCard) return;

    mapCard.style.position = "relative";
    mapCard.style.height = "500px";
    mapCard.style.padding = "0";
    mapCard.style.overflow = "hidden";
    mapCard.innerHTML = `
      <div id="publicMapCanvas" style="position:absolute;inset:0;background:#f1f5f9">
        <canvas id="publicMapCvs" style="position:absolute;top:0;left:0;display:block"></canvas>
        <div id="publicMapLoading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#f1f5f9;z-index:10"></div>
      </div>

      <div id="pubMapImageModal" style="display:none;position:absolute;inset:0;z-index:50;background:rgba(15,23,42,0.8);align-items:center;justify-content:center;padding:20px">
        <div style="background:#fff;border-radius:12px;max-width:800px;width:100%;max-height:90%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:16px 20px;border-bottom:1px solid #e2e8f0">
            <h3 id="pubMapModalTitle" style="margin:0;font-size:18px;color:#0f172a">Block</h3>
            <button id="pubMapModalClose" style="background:none;border:none;font-size:28px;line-height:1;cursor:pointer;color:#64748b;padding:0 4px;margin-top:-4px">&times;</button>
          </div>
          <div style="padding:20px;overflow:auto;text-align:center;display:flex;align-items:center;justify-content:center;min-height:200px">
            <img id="pubMapModalImg" src="" style="width:100%;max-width:100%;max-height:65vh;object-fit:contain;border-radius:8px;display:none;background:#f8fafc" referrerpolicy="no-referrer">
            <p id="pubMapModalNoImg" style="color:#64748b;font-size:14px;display:none">No photo uploaded.</p>
          </div>
        </div>
      </div>
    `;

    canvasWrap = document.getElementById("publicMapCanvas");
    cv = document.getElementById("publicMapCvs");
    ctx = cv.getContext("2d");
    loadingEl = document.getElementById("publicMapLoading");
    modalEl = document.getElementById("pubMapImageModal");

    document
      .getElementById("pubMapModalClose")
      .addEventListener("click", closeImageModal);
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) closeImageModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeImageModal();
    });

    syncCanvasSize();
    showLoading();

    try {
      const res = await fetch(API_URL).then((r) => r.json());
      if (res.success === false) throw new Error(res.message || "Load failed");

      const rows = Array.isArray(res.data)
        ? res.data
        : (res.data && res.data.blocks) || [];

      // Pre-parse each block once. Skip blocks without a usable polygon.
      for (const row of rows) {
        const pts = parseCoordinates(row.coordinates);
        if (!pts) continue;
        const bid = "b" + row.block_id;
        blocks[bid] = { ...row, points: pts, bounds: polyBounds(pts) };
        blockOrder.push(bid);
      }

      // Draw first (canvas is behind the loading overlay), then reveal.
      syncCanvasSize();
      draw();
      hideLoading();
      initEvents();

      const redraw = () => {
        syncCanvasSize();
        scheduleDraw();
      };
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(redraw).observe(canvasWrap);
      } else {
        window.addEventListener("resize", redraw);
      }
    } catch (err) {
      console.error("Failed to load public map:", err);
      showError("Could not load map data.");
    }
  });
})();
