// assets/js/public_map.js
const PUBLIC_MAP = (() => {
  const API_URL = "api/public_map.php";
  
  let canvasWrap, cv, ctx;
  let cvW = 0, cvH = 0;
  let blocks = {};
  let blockOrder = [];
  let hoveredBlock = null;

  // ── GEOMETRY HELPERS ──
  function ensurePolygon(b) {
    if (!b.coordinates || b.coordinates.length < 3) return [];
    return typeof b.coordinates === "string" ? JSON.parse(b.coordinates) : b.coordinates;
  }
  function polyBounds(pts) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  function pointInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }
  function polyCentroid(pts) {
    const b = polyBounds(pts);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  // ── CANVAS SIZE ──
  function syncCanvasSize() {
    if (!canvasWrap) return;
    const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cvW = w; cvH = h;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh;
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ── DRAW ──
  function draw() {
    if (!cvW || !cvH) syncCanvasSize();
    ctx.clearRect(0, 0, cvW, cvH);

    // 1. Calculate the global bounding box of ALL blocks to fit them to the screen
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasBlocks = false;

    blockOrder.forEach((bid) => {
      const pts = ensurePolygon(blocks[bid]);
      if (pts.length < 3) return;
      hasBlocks = true;
      pts.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
    });

    if (!hasBlocks) return;

    // 2. Determine scale and offset
    const pad = 40; // 40px padding around the map
    const mapW = Math.max(1, maxX - minX);
    const mapH = Math.max(1, maxY - minY);
    
    // Scale so the map fits inside the canvas while maintaining aspect ratio
    let scale = Math.min((cvW - pad * 2) / mapW, (cvH - pad * 2) / mapH);
    scale = Math.min(scale, 1.5); // Don't zoom in too much if the map is tiny
    
    // Center the map
    const offsetX = (cvW - (mapW * scale)) / 2 - (minX * scale);
    const offsetY = (cvH - (mapH * scale)) / 2 - (minY * scale);

    // 3. Draw the blocks using the scale and offset
    blockOrder.forEach((bid) => {
      const b = blocks[bid];
      const pts = ensurePolygon(b);
      if (pts.length < 3) return;
      
      const hov = hoveredBlock === bid;

      ctx.beginPath();
      pts.forEach((p, i) => {
        const px = p.x * scale + offsetX;
        const py = p.y * scale + offsetY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();

      // ── SMART COLORS (Public View) ──
      let fill = "#dbeafe"; // default blue
      let stroke = "#3b82f6";
      
      if (b.total > 0) {
        if (b.occupied === 0) {
          fill = "#dbeafe"; stroke = "#3b82f6"; // Empty (Blue)
        } else if (b.occupied === b.total) {
          fill = "#fee2e2"; stroke = "#ef4444"; // Full (Red)
        } else {
          fill = "#fef9c3"; stroke = "#eab308"; // Partial (Yellow)
        }
      }

      if (hov) { fill = "#bfdbfe"; stroke = "#1d4ed8"; }

      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = hov ? 3 : 2;
      ctx.fill();
      ctx.stroke();

      // Labels
      const bnds = polyBounds(pts);
      const cx = (bnds.x + bnds.w / 2) * scale + offsetX;
      const cy = (bnds.y + bnds.h / 2) * scale + offsetY;
      const roomy = (bnds.h * scale) >= 56;

      ctx.fillStyle = "#1e3a5f";
      ctx.font = "600 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(b.block_name, cx, roomy ? cy - 6 : cy + 4);

      if (roomy) {
        ctx.fillStyle = "#475569";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText(`${b.occupied} occ \u00b7 ${b.vacant} avail`, cx, cy + 16);
      }
    });

    // Store transform for click hit-testing
    cv._mapScale = scale;
    cv._mapOffsetX = offsetX;
    cv._mapOffsetY = offsetY;
  }

  // ── EVENTS ──
  function initEvents() {
    const getXY = (e) => {
      const r = cv.getBoundingClientRect();
      const s = e.touches ? e.touches[0] : e;
      return { x: s.clientX - r.left, y: s.clientY - r.top };
    };

    const getHitBlock = (x, y) => {
      if (!cv._mapScale) return null;
      // Convert click coords back to raw map coords
      const mx = (x - cv._mapOffsetX) / cv._mapScale;
      const my = (y - cv._mapOffsetY) / cv._mapScale;

      return blockOrder.slice().reverse().find((id) => pointInPoly(mx, my, ensurePolygon(blocks[id])));
    };

    cv.addEventListener("mousemove", (e) => {
      const { x, y } = getXY(e);
      const bid = getHitBlock(x, y);
      
      if (bid !== hoveredBlock) {
        hoveredBlock = bid;
        canvasWrap.style.cursor = bid ? "pointer" : "default";
        draw();
      }
    });

    cv.addEventListener("mouseleave", () => {
      hoveredBlock = null;
      canvasWrap.style.cursor = "default";
      draw();
    });

    cv.addEventListener("click", (e) => {
      const { x, y } = getXY(e);
      const bid = getHitBlock(x, y);
      
      if (bid) {
        const b = blocks[bid];
        openImageModal(b);
      }
    });
  }

  // ── MODAL LOGIC ──
  function openImageModal(b) {
    const modal = document.getElementById("pubMapImageModal");
    if (!modal) return;

    document.getElementById("pubMapModalTitle").textContent = b.block_name;
    document.getElementById("pubMapModalMeta").textContent = `${b.occupied} occupied · ${b.vacant} available · ${b.total} total`;

    const imgEl = document.getElementById("pubMapModalImg");
    const noImgEl = document.getElementById("pubMapModalNoImg");

    if (b.image_link && b.image_link.trim() !== "") {
      imgEl.src = b.image_link;
      imgEl.style.display = "block";
      noImgEl.style.display = "none";
      
      imgEl.onerror = () => {
        imgEl.style.display = "none";
        noImgEl.textContent = "Image could not be loaded.";
        noImgEl.style.display = "block";
      };
    } else {
      imgEl.style.display = "none";
      imgEl.removeAttribute("src");
      noImgEl.textContent = "No photo has been uploaded for this block.";
      noImgEl.style.display = "block";
    }

    modal.style.display = "flex";
  }

  function closeImageModal() {
    const modal = document.getElementById("pubMapImageModal");
    if (modal) modal.style.display = "none";
  }

  // ── INIT & INJECT ──
  document.addEventListener("DOMContentLoaded", () => {
    const placeholderText = Array.from(document.querySelectorAll('h3, p')).find(el => el.textContent.includes("Cemetery map feature under development"));
    
    if (!placeholderText) return; 
    
    const mapCard = placeholderText.closest('.mapCanvasCard');
    if (!mapCard) return;

    mapCard.innerHTML = `
      <div id="publicMapCanvas" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #f1f5f9;">
        <canvas id="publicMapCvs" style="position: absolute; top: 0; left: 0; display: block;"></canvas>
        <div id="publicMapLoading" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 14px; z-index: 10;">Loading map...</div>
      </div>

      <!-- Image Modal -->
      <div id="pubMapImageModal" style="display: none; position: absolute; inset: 0; z-index: 50; background: rgba(15,23,42,0.8); align-items: center; justify-content: center; padding: 20px;">
        <div style="background: #fff; border-radius: 12px; max-width: 800px; width: 100%; max-height: 90%; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
          
          <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 16px 20px; border-bottom: 1px solid #e2e8f0;">
            <div>
              <h3 id="pubMapModalTitle" style="margin: 0; font-size: 18px; color: #0f172a;">Block</h3>
              <p id="pubMapModalMeta" style="margin: 4px 0 0 0; font-size: 13px; color: #64748b;"></p>
            </div>
            <button id="pubMapModalClose" style="background: none; border: none; font-size: 28px; line-height: 1; cursor: pointer; color: #64748b; padding: 0 4px; margin-top: -4px;">&times;</button>
          </div>

          <div style="padding: 20px; overflow: auto; text-align: center; display: flex; align-items: center; justify-content: center; min-height: 200px;">
            <img id="pubMapModalImg" src="" style="width: 100%; max-width: 100%; max-height: 65vh; object-fit: contain; border-radius: 8px; display: none; background: #f8fafc;" referrerpolicy="no-referrer">
            <p id="pubMapModalNoImg" style="color: #64748b; font-size: 14px; display: none;">No photo uploaded.</p>
          </div>

        </div>
      </div>
    `;

    mapCard.style.position = "relative";
    mapCard.style.height = "500px";
    mapCard.style.padding = "0";
    mapCard.style.overflow = "hidden";

    canvasWrap = document.getElementById("publicMapCanvas");
    cv = document.getElementById("publicMapCvs");
    ctx = cv.getContext("2d");

    document.getElementById("pubMapModalClose").addEventListener("click", closeImageModal);
    document.getElementById("pubMapImageModal").addEventListener("click", (e) => {
      if (e.target.id === "pubMapImageModal") closeImageModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeImageModal();
    });

    fetch(API_URL)
      .then((r) => r.json())
      .then((res) => {
        if (res.success === false) throw new Error(res.message);

        res.data.forEach((b) => {
          const bid = "b" + b.block_id;
          blocks[bid] = b;
          blockOrder.push(bid);
        });

        syncCanvasSize();
        draw();
        initEvents();
        window.addEventListener("resize", () => { syncCanvasSize(); draw(); });
        document.getElementById("publicMapLoading").style.display = "none";
      })
      .catch((err) => {
        console.error("Failed to load map:", err);
        const el = document.getElementById("publicMapLoading");
        if (el) el.textContent = "Could not load map data.";
      });
  });
})();