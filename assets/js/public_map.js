// assets/js/public_map.js
const PUBLIC_MAP = (() => {
  const API_URL = "api/blocks.php";
  const PLACEHOLDER_WAIT_MS = 8000;
  const MAP_W = 1000;
  const MAP_H = 500;

  let canvasWrap, cv, ctx;
  let cvW = 0, cvH = 0;
  let blocks = {}; 
  let blockOrder = []; 
  let hoveredBlock = null;
  let rafPending = false;
  let loadingEl = null;
  let modalEl = null;

  // ── CAMERA STATE ──
  let mapScale = 1;
  let mapX = 0;
  let mapY = 0;
  let isPanning = false;
  let startPanX = 0;
  let startPanY = 0;
  let initialPinchDistance = 0;
  let initialScale = 1;

  function applyCameraTransform() {
    const camera = document.getElementById("publicMapCamera");
    if (camera) {
      const container = canvasWrap.getBoundingClientRect();
      
      const maxX = 0;
      const minX = container.width - (container.width * mapScale);
      const maxY = 0;
      const minY = container.height - (container.height * mapScale);

      mapX = Math.max(minX, Math.min(maxX, mapX));
      mapY = Math.max(minY, Math.min(maxY, mapY));

      // Apply the transform
      camera.style.transform = `translate(${mapX}px, ${mapY}px) scale(${mapScale})`;
    }
  }

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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  // ── CANVAS ────────────────────────────────────────────────
  function syncCanvasSize() {
    const containerW = canvasWrap.clientWidth;
    const containerH = canvasWrap.clientHeight;
    if (!containerW || !containerH) return;

    const displayW = containerW;
    const displayH = containerH;

    const dpr = window.devicePixelRatio || 1;
    cvW = displayW;
    cvH = displayH;

    const bw = Math.round(displayW * dpr);
    const bh = Math.round(displayH * dpr);
    
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }

    cv.style.width = `${displayW}px`;
    cv.style.height = `${displayH}px`;
    cv.style.left = `0px`;
    cv.style.top = `0px`;

    const bg = document.getElementById("cemetery_map_image");
    if (bg) {
      bg.style.width = `${displayW}px`;
      bg.style.height = `${displayH}px`;
      bg.style.left = `0px`;
      bg.style.top = `0px`;
      bg.style.objectFit = "fill"; 
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
      if (!cvW || !cvH) return;
    }

    const dpr = window.devicePixelRatio || 1;
    const scaleX = (cvW * dpr) / MAP_W;
    const scaleY = (cvH * dpr) / MAP_H;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (!blockOrder.length) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No blocks have been mapped yet.", cvW / 2, cvH / 2);
      ctx.textBaseline = "alphabetic";
      return;
    }

    for (const bid of blockOrder) {
      const b = blocks[bid];
      const pts = b.points;
      const hov = hoveredBlock === bid;

      const bounds = polyBounds(pts);
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      const rotation = b.rotation || 0;

      // ── APPLY ROTATION ──
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.translate(-cx, -cy);
      
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();

      ctx.globalAlpha = 0.8;

      ctx.fillStyle = hov ? "#bfdbfe" : "#dbeafe";
      ctx.strokeStyle = hov ? "#1d4ed8" : "#3b82f6";
      ctx.lineWidth = hov ? 3 : 2;
      ctx.fill();
      ctx.stroke();

      ctx.globalAlpha = 1.0;

      const bnds = b.bounds;
      const tcx = bnds.x + bnds.w / 2;
      const tcy = bnds.y + bnds.h / 2;

      const isMobile = canvasWrap.clientWidth < 600;
      const finalFontSize = isMobile ? 10 : 13; 

      ctx.imageSmoothingEnabled = false;

      ctx.fillStyle = "#1e3a5f";
      ctx.font = `600 ${finalFontSize}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.block_name, tcx, tcy);
      ctx.textBaseline = "alphabetic";

      ctx.imageSmoothingEnabled = true; 
      ctx.restore();
    }
  }

  // ── EVENTS ────────────────────────────────────────────────
  // THE DEFINITIVE FIX: We use the pointer event's offsetX/Y
  function getXY(e) {
    // For mouse events, offsetX/offsetY automatically accounts for CSS transforms!
    if (e.offsetX !== undefined) {
      return {
        x: e.offsetX * (MAP_W / cvW),
        y: e.offsetY * (MAP_H / cvH),
      };
    }
    
    // Fallback for touch events (which don't have offsetX)
    const r = cv.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    const screenX = s.clientX - r.left;
    const screenY = s.clientY - r.top;
    return {
      x: screenX * (MAP_W / r.width),
      y: screenY * (MAP_H / r.height),
    };
  }

  function getHitBlock(x, y) {
    return blockOrder
      .slice()
      .reverse()
      .find((id) => pointInPoly(x, y, blocks[id].points));
  }

  function initEvents() {
    let pointerStartX = 0;
    let pointerStartY = 0;
    let hasDragged = false;

    // ── MOBILE PINCH TO ZOOM & PAN ──
    cv.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.hypot(dx, dy);
        initialScale = mapScale;
        hasDragged = true; 
      } else if (e.touches.length === 1) {
        isPanning = true;
        startPanX = e.touches[0].clientX - mapX;
        startPanY = e.touches[0].clientY - mapY;
        pointerStartX = e.touches[0].clientX;
        pointerStartY = e.touches[0].clientY;
        hasDragged = false;
      }
    }, { passive: false });

    cv.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.hypot(dx, dy);
        
        mapScale = Math.max(1, Math.min(4, initialScale * (distance / initialPinchDistance)));
        applyCameraTransform();
      } else if (e.touches.length === 1 && isPanning) {
        if (e.cancelable) e.preventDefault();
        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;

        if (Math.hypot(currentX - pointerStartX, currentY - pointerStartY) > 5) {
          hasDragged = true;
        }

        mapX = currentX - startPanX;
        mapY = currentY - startPanY;
        applyCameraTransform();
      }
    }, { passive: false });

    cv.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) initialPinchDistance = 0;
      if (e.touches.length === 0) isPanning = false;
    });

    // ── DESKTOP MOUSE (PAN & CLICK) ──
    cv.addEventListener("mousedown", (e) => {
      isPanning = true;
      startPanX = e.clientX - mapX;
      startPanY = e.clientY - mapY;
      pointerStartX = e.clientX;
      pointerStartY = e.clientY;
      hasDragged = false;
      canvasWrap.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (isPanning) {
        const currentX = e.clientX;
        const currentY = e.clientY;

        if (Math.hypot(currentX - pointerStartX, currentY - pointerStartY) > 5) {
          hasDragged = true;
        }

        mapX = currentX - startPanX;
        mapY = currentY - startPanY;
        applyCameraTransform();
        return;
      }

      // Hover logic
      const { x, y } = getXY(e);
      const bid = getHitBlock(x, y) || null;
      if (bid !== hoveredBlock) {
        hoveredBlock = bid;
        canvasWrap.style.cursor = bid ? "pointer" : "grab";
        scheduleDraw();
      }
    });

    window.addEventListener("mouseup", () => {
      if (isPanning) {
        isPanning = false;
        canvasWrap.style.cursor = "default";
      }
    });

    // ── ZOOM (WHEEL) ──
    cv.addEventListener("wheel", (e) => {
      if (e.cancelable) e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      mapScale = Math.max(1, Math.min(4, mapScale * zoomFactor));
      applyCameraTransform();
    }, { passive: false });

    cv.addEventListener("mouseleave", () => {
      if (hoveredBlock) {
        hoveredBlock = null;
        canvasWrap.style.cursor = "default";
        scheduleDraw();
      }
    });

    // ── CLICK TO OPEN MODAL ──
    cv.addEventListener("click", (e) => {
      if (hasDragged) {
        hasDragged = false;
        return; 
      }

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
      <div id="publicMapCanvas" style="position:absolute;inset:0;background:#f1f5f9;touch-action:none;overflow:hidden;">
        <div id="publicMapCamera" style="position:absolute;top:0;left:0;width:100%;height:100%;transform-origin:0 0;will-change:transform;">
          <img
            id="cemetery_map_image"
            src="api/images/cemetery_map_image.png"
            onerror="this.onerror = null; this.src = 'assets/images/cemetery_map_image.png'; console.error('Failed to load dynamic logo. Using default logo.');"
            alt="Cemetery Map Image"
            style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;z-index:0;pointer-events:none;user-select:none;"
          />
          <canvas id="publicMapCvs" style="position:absolute;top:0;left:0;display:block;background:transparent;z-index:1"></canvas>
        </div>
        
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

    const closeBtn = document.getElementById("pubMapModalClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", closeImageModal);
    }

    if (modalEl) {
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) closeImageModal();
      });
    }

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

      for (const row of rows) {
        const pts = parseCoordinates(row.coordinates);
        if (!pts) continue;
        const bid = "b" + row.block_id;
        blocks[bid] = { 
          ...row, 
          points: pts, 
          bounds: polyBounds(pts),
          rotation: parseFloat(row.rotation) || 0
        };
        blockOrder.push(bid);
      }

      syncCanvasSize();
      
      // ── INITIAL ZOOM TO PREVENT SQUEEZING ON SMALL SCREENS ──
      if (window.innerWidth < 768) {
        mapScale = 1.6; 
        applyCameraTransform();
      }

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