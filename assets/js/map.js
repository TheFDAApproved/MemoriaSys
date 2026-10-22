/* ==========================================================================
   MEMORIA - CEMETERY MAP ENGINE (map.js)
   ========================================================================== 
   This file handles the 2D canvas rendering, editing, reshaping, 
   and grave management for the admin map.
   ========================================================================== */

const MAP = (() => {
  // ── CONSTANTS ────────────────────────────────────────────────────────────
  const CELL = 22; // The grid size for snapping
  const API_BLOCKS = "api/blocks.php"; // Endpoint for fetching/saving blocks

  // ── STATE VARIABLES ──────────────────────────────────────────────────────
  let mapEditMode = false;         // Are we currently in "Edit Layout" mode?
  let hasUnsavedChanges = false;   // Tracks if changes were made while editing
  let reshapeMode = false;         // Are we currently in "Reshape Block" mode?
  let reshapeBid = null;           // The ID of the block being reshaped
  let reshapeHistory = [];         // Undo stack for reshaping
  let drawPoints = [];             // The line being drawn in reshape mode
  let pendingSplit = null;         // The preview of the split shape
  let mousePos = { x: 0, y: 0 };   // Current mouse position on canvas
  let cvW = 0, cvH = 0;            // Canvas width and height
  let curBlock = null;             // Currently selected block
  let hoveredBlock = null;         // Block currently under the mouse
  let pendingNavHref = null;       // URL to navigate to if user saves/discards
  let blocks = {};                 // Dictionary of all loaded blocks
  let blockOrder = [];             // Array to maintain z-index / order of blocks

  // Drag / Resize state objects
  let blockDrag = { active: false, bid: null, startX: 0, startY: 0, dx: 0, dy: 0, origPts: null };
  let resizeDrag = { active: false, bid: null, startX: 0, startY: 0, origX: 0, origY: 0, origW: 0, origH: 0, origPts: null, isCustom: false };
  let drag = { active: false, sx: 0, sy: 0, ex: 0, ey: 0 };

  const $ = (id) => document.getElementById(id);
  let canvasWrap, cv, ctx;

  // ── GEOMETRY HELPERS ─────────────────────────────────────────────────────
  function uid() {
    return Math.random().toString(36).slice(2, 8);
  }

  function snap(v) {
    return Math.round(v / CELL) * CELL;
  }

  function rectToPoints(x, y, w, h) {
    return [
      { x, y }, 
      { x: x + w, y }, 
      { x: x + w, y: y + h }, 
      { x, y: y + h }
    ];
  }

  function ensurePolygon(b) {
    if (!b.coordinates || b.coordinates.length < 3) {
      b.coordinates = rectToPoints(b.x, b.y, b.w, b.h);
    }
    return b.coordinates;
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
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function projectOntoSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { point: { ...a }, t: 0 };
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return { point: { x: snap(a.x + t * dx), y: snap(a.y + t * dy) }, t };
  }

  function closestEdge(pts, px, py) {
    let best = null, bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const d = distToSegment({ x: px, y: py }, a, b);
      if (d < bestDist) {
        bestDist = d;
        const proj = projectOntoSegment({ x: px, y: py }, a, b);
        best = { edgeIndex: i, point: proj.point, dist: d };
      }
    }
    return best;
  }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    return Math.abs(a) / 2;
  }

  function polyCentroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      a += f;
      cx += (pts[j].x + pts[i].x) * f;
      cy += (pts[j].y + pts[i].y) * f;
    }
    if (Math.abs(a) < 1e-6) {
      const b = polyBounds(pts);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    return { x: cx / (3 * a), y: cy / (3 * a) };
  }

  function computeLabelAnchor(pts) {
    const c = polyCentroid(pts);
    if (pointInPoly(c.x, c.y, pts)) return c;
    const b = polyBounds(pts);
    const STEPS = 9;
    let best = null, bestClear = -1;
    for (let iy = 1; iy < STEPS; iy++) {
      for (let ix = 1; ix < STEPS; ix++) {
        const p = { x: b.x + (b.w * ix) / STEPS, y: b.y + (b.h * iy) / STEPS };
        if (!pointInPoly(p.x, p.y, pts)) continue;
        let clear = Infinity;
        for (let i = 0; i < pts.length; i++) {
          clear = Math.min(clear, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
        }
        if (clear > bestClear) { bestClear = clear; best = p; }
      }
    }
    return best || c;
  }

  const labelAnchors = new WeakMap();
  function labelAnchor(pts) {
    let at = labelAnchors.get(pts);
    if (!at) { 
      at = computeLabelAnchor(pts); 
      labelAnchors.set(pts, at); 
    }
    return at;
  }

  function scalePolyTo(pts, rx, ry, rw, rh) {
    const b = polyBounds(pts);
    const sx = b.w === 0 ? 1 : rw / b.w;
    const sy = b.h === 0 ? 1 : rh / b.h;
    return pts.map((p) => ({ x: rx + (p.x - b.x) * sx, y: ry + (p.y - b.y) * sy }));
  }

  function isCustomShape(b) { return b.custom === true; }

  function syncBounds(b) {
    const bn = polyBounds(ensurePolygon(b));
    b.x = bn.x; b.y = bn.y; b.w = bn.w; b.h = bn.h;
  }

  function blockStats(b) {
    const total = b.total_graves || (b.rows * b.cols);
    const occ   = b.occupied_count || 0;
    const vac   = b.vacant_count || 0;
    const res   = Math.max(0, total - occ - vac);
    return { total, occ, res, avail: vac };
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeImageUrl(u) {
    u = (u || "").trim();
    if (!u) return null;
    if (/^(https?:|data:|blob:|\/)/i.test(u)) return u;
    return "https://" + u;
  }

  function formatDate(d) {
    if (!d) return "--";
    const date = new Date(d);
    if (isNaN(date.getTime())) return d; 
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── CANVAS MANAGEMENT ────────────────────────────────────────────────────
  function syncCanvasSize() {
    const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cvW = w; cvH = h;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh;
      cv.style.width = `${w}px`; 
      cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }
  }

  let rafPending = false;
  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { 
      rafPending = false; 
      draw(); 
    });
  }

  // ── API & DATA PERSISTENCE ───────────────────────────────────────────────
  function saveOneBlock(bid) {
    const b = blocks[bid];
    const payload = {
      block_name: b.block_name,
      block_type: b.block_type,
      image_link: b.image_link,
      coordinates: JSON.stringify(b.coordinates),
      shape: b.shape,
      custom: b.custom ? 1 : 0,
      remarks: b.remarks || null,
    };

    const isNew = !b.block_id;
    const url = isNew ? API_BLOCKS : `${API_BLOCKS}/${b.block_id}`;
    const method = isNew ? "POST" : "PUT";

    if (isNew) {
      payload.rows = b.rows;
      payload.cols = b.cols;
    }

    return fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
  }

  function persistSave() {
    Promise.all(blockOrder.map(saveOneBlock))
      .then((results) => {
        const failed = results.find((r) => r && r.success === false);
        if (failed) {
          console.error("Save errors:", results);
          setHint("Save failed: " + (failed.message || "unknown error"));
          return;
        }
        flashSaved();
        persistLoad();
      })
      .catch((err) => {
        console.error("Save failed:", err);
        setHint("Save failed — check your connection.");
      });
  }

  function persistLoad() {
    fetch(API_BLOCKS)
      .then((r) => r.json())
      .then((res) => {
        if (res.success === false) {
          throw new Error(res.message || "Load failed");
        }

        const rows = Array.isArray(res.data) ? res.data : (res.data.blocks || []);

        blocks = {};
        blockOrder = [];

        let stagedIndex = 0;
        
        rows.forEach((row) => {
          let pts = null;

          if (row.coordinates) {
            try {
              pts = typeof row.coordinates === "string" 
                ? JSON.parse(row.coordinates) 
                : row.coordinates;
            } catch { 
              pts = null; 
            }
          }

          let placedOnGrid = false;
          if (!Array.isArray(pts) || pts.length < 3) {
            const side = 4 * CELL;
            const perRow = 5;
            const px = 40 + (stagedIndex % perRow) * (side + 20);
            const py = 40 + Math.floor(stagedIndex / perRow) * (side + 20);
            pts = rectToPoints(px, py, side, side);
            placedOnGrid = true;
            stagedIndex++;
          }

          const bid = "b" + row.block_id;
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);

          blocks[bid] = {
            block_id: parseInt(row.block_id, 10),
            block_name: row.block_name,
            block_type: row.block_type,
            image_link: row.image_link || null,
            coordinates: pts,
            rows: parseInt(row.rows, 10) || 0,
            cols: parseInt(row.cols, 10) || 0,
            shape: row.shape || "rectangle",
            custom: row.custom == 1,
            remarks: row.remarks || null,
            needsPlacement: placedOnGrid,

            total_graves:   parseInt(row.total_graves, 10) || 0,
            vacant_count:   parseInt(row.vacant, 10) || 0,
            occupied_count: parseInt(row.occupied, 10) || 0,

            x: Math.min(...xs), 
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs), 
            h: Math.max(...ys) - Math.min(...ys),
          };
          
          syncBounds(blocks[bid]);
          blockOrder.push(bid);
        });

        $("mapLoading").style.display = "none";
        syncCanvasSize();
        draw();
        updateStatus();

        const needsPlacement = Object.values(blocks).some((b) => b.needsPlacement);
        if (needsPlacement) {
          setHint('Some blocks need placement — click "Edit Layout" to drag them into position.');
        } else {
          setHint('Click "Add Block" to create one, or "Edit Layout" to rearrange existing blocks.');
        }
      })
      .catch((err) => {
        console.error("Load failed:", err);
        const el = $("mapLoading");
        if (el) el.textContent = "Failed to load map.";
        setHint("Could not load blocks from server.");
      });
  }

  function flashSaved() {
    setHint("Map saved successfully!");
    setTimeout(() => setHint(""), 3000);
  }

  // ── CANVAS RENDER ENGINE ─────────────────────────────────────────────────
  function draw() {
    if (!cvW || !cvH) syncCanvasSize();
    ctx.clearRect(0, 0, cvW, cvH);

    const interacting = blockDrag.active || resizeDrag.active;
    ctx.imageSmoothingQuality = interacting ? "low" : "high";

    if (!blockOrder.length) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText('No blocks yet. Click "Add Block" to get started.', cvW / 2, cvH / 2);
      return;
    }

    blockOrder.forEach((bid) => {
      const b = blocks[bid];
      const pts = ensurePolygon(b);
      const hov = hoveredBlock === bid;
      const isResh = reshapeMode && reshapeBid === bid;
      const isDrag = blockDrag.active && blockDrag.bid === bid;
      const isResize = resizeDrag.active && resizeDrag.bid === bid;
      const { total, occ } = blockStats(b);
      const bounds = polyBounds(pts);

      ctx.globalAlpha = reshapeMode && !isResh ? 0.25 : isDrag || isResize ? 0.75 : 1;

      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();

      // Determine colors based on occupancy
      let fill = "#dbeafe", stroke = "#3b82f6";
      
      if (b.needsPlacement) {
        fill = "#fef3c7"; stroke = "#f59e0b";
      } else if (total > 0) {
        if (occ === 0) { 
          fill = "#dbeafe"; stroke = "#3b82f6"; 
        } else if (occ === total) { 
          fill = "#fee2e2"; stroke = "#ef4444"; 
        } else { 
          fill = "#fef9c3"; stroke = "#eab308"; 
        }
      }

      // Override colors for active states
      if (isResh) { fill = "#fef9c3"; stroke = "#f59e0b"; }
      if (isDrag || isResize) { fill = "#ede9fe"; stroke = "#8b5cf6"; }
      if (hov && !isDrag && !isResize) stroke = "#1d4ed8";

      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = isResh || hov || isDrag || isResize ? 2 : 1;
      ctx.fill();
      ctx.stroke();

      // Draw Resize Handle (bottom-right corner)
      if (mapEditMode && hov && !reshapeMode && !blockDrag.active) {
        const hx = bounds.x + bounds.w;
        const hy = bounds.y + bounds.h;
        
        ctx.beginPath();
        ctx.arc(hx, hy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#3b82f6"; 
        ctx.strokeStyle = "#fff"; 
        ctx.lineWidth = 2;
        ctx.fill(); 
        ctx.stroke();
      }

      const label = labelAnchor(pts);
      const roomy = bounds.h >= 56;

      // Draw Text Labels
      ctx.fillStyle = "#1e3a5f";
      ctx.font = "500 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(b.block_name, label.x, roomy ? label.y - 14 : label.y + 4);

      if (roomy) {
        ctx.fillStyle = "#475569";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText(`${b.rows}\u00d7${b.cols}`, label.x, label.y + 2);
        ctx.fillText(`${occ} occ \u00b7 ${total - occ} avail`, label.x, label.y + 16);
      }

      if (!reshapeMode && !isDrag && !isResize && roomy) {
        const footY = bounds.y + bounds.h - 8;
        const hintY = pointInPoly(label.x, footY, pts) ? footY : label.y + 30;
        
        ctx.fillStyle = mapEditMode ? "#3b82f6" : "#2563eb";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText(mapEditMode ? "click to reshape \u00b7 drag to move" : "click to view", label.x, hintY);
      }

      if (isResh && pendingSplit) {
        drawSplitPreview();
      }

      // Draw Reshape mode markers and lines
      if (isResh && !pendingSplit) {
        pts.forEach((p, i) => {
          const next = pts[(i + 1) % pts.length];
          ctx.beginPath(); 
          ctx.arc((p.x + next.x) / 2, (p.y + next.y) / 2, 3, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(99,102,241,0.5)"; 
          ctx.fill();
        });
        
        pts.forEach((p) => {
          ctx.beginPath(); 
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#6366f1"; 
          ctx.strokeStyle = "#fff"; 
          ctx.lineWidth = 2;
          ctx.fill(); 
          ctx.stroke();
        });

        if (drawPoints.length > 0) {
          ctx.beginPath();
          ctx.moveTo(drawPoints[0].x, drawPoints[0].y);
          drawPoints.forEach((p, i) => { if (i > 0) ctx.lineTo(p.x, p.y); });
          
          const edge = closestEdge(pts, mousePos.x, mousePos.y);
          if (edge && edge.dist < 20) {
            ctx.lineTo(edge.point.x, edge.point.y);
          } else {
            ctx.lineTo(mousePos.x, mousePos.y);
          }

          ctx.strokeStyle = "#22c55e"; 
          ctx.lineWidth = 2; 
          ctx.setLineDash([5, 3]); 
          ctx.stroke(); 
          ctx.setLineDash([]);
          
          drawPoints.forEach((p) => {
            ctx.beginPath(); 
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = "#22c55e"; 
            ctx.strokeStyle = "#fff"; 
            ctx.lineWidth = 2;
            ctx.fill(); 
            ctx.stroke();
          });
        } else {
          const edge = closestEdge(pts, mousePos.x, mousePos.y);
          if (edge && edge.dist < 20) {
            ctx.beginPath(); 
            ctx.arc(edge.point.x, edge.point.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = "#22c55e"; 
            ctx.strokeStyle = "#fff"; 
            ctx.lineWidth = 2;
            ctx.fill(); 
            ctx.stroke();
          }
        }
      }

      // Draw Drag Guideline
      if (isDrag) {
        const gx = snap(blockDrag.dx) - blockDrag.dx;
        const gy = snap(blockDrag.dy) - blockDrag.dy;
        if (gx || gy) {
          ctx.beginPath();
          pts.forEach((p, i) =>
            i === 0 ? ctx.moveTo(p.x + gx, p.y + gy) : ctx.lineTo(p.x + gx, p.y + gy)
          );
          ctx.closePath();
          ctx.strokeStyle = "#8b5cf6"; 
          ctx.lineWidth = 1; 
          ctx.setLineDash([4, 4]); 
          ctx.stroke(); 
          ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1;
    });
  }

  function drawSplitPreview() {
    const keep = pendingSplit.keep === "a" ? pendingSplit.a : pendingSplit.b;
    const drop = pendingSplit.keep === "a" ? pendingSplit.b : pendingSplit.a;
    
    const trace = (poly) => {
      ctx.beginPath();
      poly.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
    };
    
    trace(drop);
    ctx.fillStyle = "rgba(148,163,184,0.35)"; 
    ctx.fill();
    ctx.strokeStyle = "#94a3b8"; 
    ctx.lineWidth = 1.5; 
    ctx.setLineDash([5, 4]); 
    ctx.stroke(); 
    ctx.setLineDash([]);
    
    trace(keep);
    ctx.fillStyle = "rgba(34,197,94,0.28)"; 
    ctx.fill();
    ctx.strokeStyle = "#16a34a"; 
    ctx.lineWidth = 2.5; 
    ctx.stroke();
    
    ctx.font = "600 11px Inter, sans-serif"; 
    ctx.textAlign = "center";
    
    const kc = polyCentroid(keep); 
    ctx.fillStyle = "#15803d"; 
    ctx.fillText("KEEP", kc.x, kc.y - 20);
    
    const dc = polyCentroid(drop); 
    ctx.fillStyle = "#64748b"; 
    ctx.fillText("REMOVE", dc.x, dc.y - 20);
  }

  function hitBlock(mx, my) { 
    return blockOrder.slice().reverse().find((bid) => pointInPoly(mx, my, ensurePolygon(blocks[bid]))); 
  }

  function getXY(e) {
    const r = cv.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    return { x: s.clientX - r.left, y: s.clientY - r.top };
  }

  // ── RESHAPE MODE LOGIC ───────────────────────────────────────────────────
  function handleDrawClick(mx, my) {
    const pts = ensurePolygon(blocks[reshapeBid]);
    const edge = closestEdge(pts, mx, my);
    const onEdge = edge && edge.dist < 24;

    if (drawPoints.length === 0) {
      if (!onEdge) return;
      drawPoints = [{ x: snap(edge.point.x), y: snap(edge.point.y), edgeIndex: edge.edgeIndex, onEdge: true }];
      setHint("Add waypoints, then click another edge to close the line.");
      updateReshapeToolbar(); 
      draw(); 
      return;
    }

    if (onEdge) {
      const startPt = drawPoints[0];
      const endPoint = { x: snap(edge.point.x), y: snap(edge.point.y) };
      
      if (dist(endPoint, startPt) < 10 && drawPoints.length < 2) return;
      
      const split = splitPolygon(pts, startPt, { ...endPoint, edgeIndex: edge.edgeIndex }, drawPoints.slice(1));
      drawPoints = [];
      
      if (!split) {
        setHint("That line didn't divide the block — try again.");
        updateReshapeToolbar(); 
        draw(); 
        return;
      }
      
      pendingSplit = { a: split.a, b: split.b, keep: polyArea(split.a) >= polyArea(split.b) ? "a" : "b" };
      updateReshapeToolbar();
      setHint("Click a half to pick it, then \"Keep this side\" to confirm \u00b7 Esc to redraw.");
      draw(); 
      return;
    }

    drawPoints.push({ x: snap(mx), y: snap(my), onEdge: false });
    updateReshapeToolbar(); 
    draw();
  }

  function splitPolygon(pts, start, end, mid) {
    let idx1 = start.edgeIndex, idx2 = end.edgeIndex;
    let pt1 = { x: start.x, y: start.y }, pt2 = { x: end.x, y: end.y };
    const midPoints = mid.map((p) => ({ x: p.x, y: p.y }));

    pt1.x = snap(pt1.x); pt1.y = snap(pt1.y);
    pt2.x = snap(pt2.x); pt2.y = snap(pt2.y);
    
    for (let i = 0; i < midPoints.length; i++) {
      midPoints[i].x = snap(midPoints[i].x); 
      midPoints[i].y = snap(midPoints[i].y);
    }

    if (idx1 === idx2) {
      if (dist(pts[idx1], pt1) > dist(pts[idx1], pt2)) {
        [pt1, pt2] = [pt2, pt1]; 
        midPoints.reverse();
      }
    } else if (idx2 < idx1) {
      [idx1, idx2] = [idx2, idx1]; 
      [pt1, pt2] = [pt2, pt1]; 
      midPoints.reverse();
    }

    const workPts = [...pts];
    workPts.splice(idx2 + 1, 0, { ...pt2 });
    workPts.splice(idx1 + 1, 0, { ...pt1 });

    const i1 = idx1 + 1, i2 = idx2 + 2;
    const chain = (from, to) => {
      const out = [];
      for (let i = from; ; i = (i + 1) % workPts.length) {
        out.push(workPts[i]);
        if (i === to) break;
      }
      return out;
    };

    const a = [pt1, ...chain(i1, i2).slice(1, -1), pt2, ...midPoints.slice().reverse()];
    const b = [pt1, ...midPoints, pt2, ...chain(i2, i1).slice(1, -1)];
    
    if (a.length < 3 || b.length < 3) return null;
    return { a, b };
  }

  function pickSplitSide(mx, my) {
    const inA = pointInPoly(mx, my, pendingSplit.a);
    const inB = pointInPoly(mx, my, pendingSplit.b);
    
    if (inA && !inB) {
      pendingSplit.keep = "a";
    } else if (inB && !inA) {
      pendingSplit.keep = "b";
    } else {
      pendingSplit.keep = pendingSplit.keep === "a" ? "b" : "a";
    }
    draw();
  }

  function swapSplitSide() {
    if (!pendingSplit) return;
    pendingSplit.keep = pendingSplit.keep === "a" ? "b" : "a";
    draw();
  }

  function keepSplitSide() {
    if (!pendingSplit) return;
    const blk = blocks[reshapeBid];
    
    reshapeHistory.push({ 
      coordinates: blk.coordinates.map((p) => ({ ...p })), 
      shape: blk.shape, 
      custom: !!blk.custom 
    });
    
    blk.coordinates = pendingSplit.keep === "a" ? pendingSplit.a : pendingSplit.b;
    blk.shape = "polygon";
    blk.custom = true;
    syncBounds(blk);
    pendingSplit = null;
    
    hasUnsavedChanges = true;
    
    // ── Update the button to Save Changes ──
    $("btnSaveMap").textContent = "Save Changes";
    $("btnSaveMap").style.background = "#22c55e";
    $("btnSaveMap").style.color = "#ffffff";
    $("btnSaveMap").style.border = "none";
    
    updateReshapeToolbar();
    setHint(RESHAPE_HINT);
    draw();
  }

  function cancelSplit() {
    if (!pendingSplit) return;
    pendingSplit = null;
    updateReshapeToolbar(); 
    setHint(RESHAPE_HINT); 
    draw();
  }

  function undoReshape() {
    if (!reshapeHistory.length) return;
    const prev = reshapeHistory.pop();
    const blk = blocks[reshapeBid];
    
    blk.coordinates = prev.coordinates;
    blk.shape = prev.shape;
    blk.custom = prev.custom;
    syncBounds(blk);
    
    drawPoints = []; 
    pendingSplit = null;
    updateReshapeToolbar(); 
    setHint(RESHAPE_HINT); 
    draw();
  }

  // ── EVENT LISTENERS ──────────────────────────────────────────────────────
  function initCanvasEvents() {
    const handleMove = (e) => {
      if (blockDrag.active || resizeDrag.active || (reshapeMode && drawPoints.length > 0)) {
        if (e.cancelable) e.preventDefault();
      }
      
      const { x, y } = getXY(e);
      mousePos = { x, y };

      if (blockDrag.active) {
        blockDrag.dx = x - blockDrag.startX; 
        blockDrag.dy = y - blockDrag.startY;
        const blk = blocks[blockDrag.bid];
        
        blk.coordinates = blockDrag.origPts.map((p) => ({ x: p.x + blockDrag.dx, y: p.y + blockDrag.dy }));
        syncBounds(blk); 
        scheduleDraw(); 
        return;
      }

      if (resizeDrag.active) {
        const dx = snap(x - resizeDrag.startX), dy = snap(y - resizeDrag.startY);
        const newW = Math.max(CELL * 2, resizeDrag.origW + dx), newH = Math.max(CELL * 2, resizeDrag.origH + dy);
        const blk = blocks[resizeDrag.bid];
        
        if (resizeDrag.isCustom) {
          blk.coordinates = scalePolyTo(resizeDrag.origPts, resizeDrag.origX, resizeDrag.origY, newW, newH);
        } else {
          blk.coordinates = rectToPoints(resizeDrag.origX, resizeDrag.origY, newW, newH);
        }
        
        syncBounds(blk); 
        scheduleDraw(); 
        return;
      }

      if (reshapeMode) { 
        scheduleDraw(); 
        return; 
      }

      const bid = hitBlock(x, y);
      if (bid !== hoveredBlock) { 
        hoveredBlock = bid; 
        scheduleDraw(); 
      }
      
      if (bid && mapEditMode && !reshapeMode) {
        const b = blocks[bid];
        const bounds = polyBounds(ensurePolygon(b));
        const isHandle = Math.sqrt((x - (bounds.x + bounds.w)) ** 2 + (y - (bounds.y + bounds.h)) ** 2) < 10;
        canvasWrap.style.cursor = isHandle ? "nwse-resize" : "grab";
      } else {
        canvasWrap.style.cursor = bid ? (mapEditMode ? "grab" : "pointer") : "default";
      }
    };

    const handleDown = (e) => {
      if (e.target !== cv) return;
      const { x, y } = getXY(e);
      
      if (reshapeMode) {
        if (!reshapeBid) return;
        if (pendingSplit) pickSplitSide(x, y); 
        else handleDrawClick(x, y);
        return;
      }

      if (mapEditMode) {
        for (let i = blockOrder.length - 1; i >= 0; i--) {
          const bid = blockOrder[i], b = blocks[bid];
          if (b.needsPlacement) continue;
          
          const bounds = polyBounds(ensurePolygon(b));
          if (Math.sqrt((x - (bounds.x + bounds.w)) ** 2 + (y - (bounds.y + bounds.h)) ** 2) < 12) {
            resizeDrag = { active: true, bid, startX: x, startY: y, origX: bounds.x, origY: bounds.y, origW: bounds.w, origH: bounds.h, origPts: ensurePolygon(b).map(p => ({...p})), isCustom: isCustomShape(b) };
            return;
          }
        }

        const bid = hitBlock(x, y);
        if (!bid) return;

        blockDrag = { active: true, bid, startX: x, startY: y, dx: 0, dy: 0, origPts: ensurePolygon(blocks[bid]).map((p) => ({ ...p })) };
        canvasWrap.style.cursor = "grabbing";
        setHint("Dragging block \u2014 release to drop.");
        draw(); 
        return;
      }

      const bid = hitBlock(x, y);
      if (bid) openBlockSelectModal(bid);
    };

    const handleUp = (e) => {
      if (resizeDrag.active) {
        resizeDrag.active = false;
        canvasWrap.style.cursor = "grab";
        setHint("Click a block to change its shape, or drag it to move it.");
        
        hasUnsavedChanges = true;
        $("btnSaveMap").textContent = "Save Changes";
        $("btnSaveMap").style.background = "#22c55e"; // Turn green
        $("btnSaveMap").style.color = "#ffffff";
        $("btnSaveMap").style.border = "none";
        
        draw(); 
        return;
      }

      if (blockDrag.active) {
        const bid = blockDrag.bid, blk = blocks[bid];
        const isClick = Math.hypot(blockDrag.dx, blockDrag.dy) < 5;
        
        if (isClick) {
          blk.coordinates = blockDrag.origPts;
        } else {
          const dx = snap(blockDrag.dx), dy = snap(blockDrag.dy);
          blk.coordinates = blockDrag.origPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          
          hasUnsavedChanges = true;
          $("btnSaveMap").textContent = "Save Changes";
          $("btnSaveMap").style.background = "#22c55e"; // Turn green
          $("btnSaveMap").style.color = "#ffffff";
          $("btnSaveMap").style.border = "none";
        }
        
        syncBounds(blk);
        blockDrag.active = false;
        canvasWrap.style.cursor = "grab";
        setHint("Click a block to change its shape, or drag it to move it.");
        draw();
        if (isClick) openBlockLayoutModal(bid);
        return;
      }
    };

    cv.addEventListener("mousemove", handleMove);
    cv.addEventListener("mouseleave", () => {
      if (blockDrag.active || resizeDrag.active || reshapeMode) return;
      if (hoveredBlock) { 
        hoveredBlock = null; 
        scheduleDraw(); 
      }
    });
    
    window.addEventListener("mousemove", (e) => { 
      if (blockDrag.active || resizeDrag.active) handleMove(e); 
    });
    
    window.addEventListener("mousedown", handleDown);
    cv.addEventListener("mouseup", handleUp);
    cv.addEventListener("touchmove", handleMove, { passive: false });
    cv.addEventListener("touchstart", handleDown, { passive: false });
    cv.addEventListener("touchend", handleUp);
    
    cv.addEventListener("dblclick", (e) => {
      if (!reshapeMode || pendingSplit || drawPoints.length < 2) return;
      const { x, y } = getXY(e);
      if (closestEdge(ensurePolygon(blocks[reshapeBid]), x, y).dist < 30) {
        handleDrawClick(x, y);
      }
    });
    
    window.addEventListener("mouseup", (e) => { 
      if (blockDrag.active || resizeDrag.active) handleUp(e); 
    });

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => { syncCanvasSize(); scheduleDraw(); }).observe(canvasWrap);
    } else {
      window.addEventListener("resize", () => { syncCanvasSize(); scheduleDraw(); });
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && reshapeMode) {
        if (pendingSplit) {
          cancelSplit();
        } else { 
          drawPoints = []; 
          updateReshapeToolbar(); 
          draw(); 
        }
      }
    });
  }

  // ── UI BUTTONS ───────────────────────────────────────────────────────────
  function initButtons() {
    $("btnEditMap").addEventListener("click", enterEditMap);
    
    $("btnSaveMap").addEventListener("click", () => { 
      if (hasUnsavedChanges) { 
        persistSave(); 
        exitEditMap(); 
      } else { 
        exitEditMap(); 
      }
    });
    
    $("btnAddBlock").addEventListener("click", openAddBlockModal);
    
    $("modalOverlay").addEventListener("click", function (e) {
      if (e.target === this) closeModal();
    });
  }

  function enterEditMap() {
    mapEditMode = true;
    hasUnsavedChanges = false;
    
    $("btnEditMap").style.display = "none";
    
    // Change button to Cancel Edit (gray)
    $("btnSaveMap").textContent = "Cancel Edit";
    $("btnSaveMap").style.background = "#f1f5f9";
    $("btnSaveMap").style.color = "#475569";
    $("btnSaveMap").style.border = "1px solid #cbd5e1";
    $("btnSaveMap").style.display = "";

    $("btnAddBlock").style.display = "none";
    
    setHint("Click a block to change its shape, drag to move, or grab the corner dot to resize.");
    draw();
  }
  
  function exitEditMap() {
    if (reshapeMode) _clearReshape();
    blockDrag.active = false; 
    resizeDrag.active = false;
    mapEditMode = false; 
    hoveredBlock = null;
    
    canvasWrap.style.cursor = "default";
    $("btnEditMap").style.display = "";
    $("btnSaveMap").style.display = "none";
    
    // Reset button back to Save Layout (green)
    $("btnSaveMap").textContent = "Save Layout";
    $("btnSaveMap").style.background = "#22c55e";
    $("btnSaveMap").style.color = "#ffffff";
    $("btnSaveMap").style.border = "none";

    $("btnAddBlock").style.display = "";
    setHint("");
    draw();
  }
  
  function setHint(t) { 
    if ($("mapHint")) $("mapHint").textContent = t; 
  }

  // ── RESHAPE TOOLBAR STATE ────────────────────────────────────────────────
  const RESHAPE_HINT = "DRAW LINE: click an edge, add waypoints, then click another edge to divide the block.";

  function enterReshapeMode(bid) {
    reshapeMode = true; 
    reshapeBid = bid; 
    reshapeHistory = [];
    drawPoints = []; 
    pendingSplit = null;
    
    $("btnAddBlock").style.display = "none";
    $("btnSaveMap").style.display = "none"; 
    
    updateReshapeToolbar();
    canvasWrap.style.cursor = "crosshair";
    closeModal(); 
    setHint(RESHAPE_HINT); 
    draw();
  }
  
  function exitReshapeMode() {
    _clearReshape();
    if (mapEditMode) $("btnSaveMap").style.display = "";
    canvasWrap.style.cursor = "default";
    setHint("Click a block to change its shape, drag to move, or grab the corner dot to resize.");
    draw();
  }
  
  function updateReshapeToolbar() {
    const choosing = reshapeMode && !!pendingSplit;
    const show = (id, on) => { if ($(id)) $(id).style.display = on ? "" : "none"; };
    
    show("btnKeepSide", choosing);
    show("btnSwapSide", choosing);
    show("btnDoneReshape", reshapeMode && !choosing);
    show("btnUndoReshape", reshapeMode && !choosing && reshapeHistory.length > 0);
  }
  
  function _clearReshape() {
    reshapeMode = false; 
    reshapeBid = null;
    reshapeHistory = []; 
    drawPoints = []; 
    pendingSplit = null;
    // DO NOT show btnAddBlock here, let exitEditMap handle it.
    updateReshapeToolbar();
  }

  // ── MODAL SYSTEM ─────────────────────────────────────────────────────────
  const BLOCK_TYPES = ["Niche", "Bone Chamber", "Lawn/Grounds", "Unmapped Area", "Private", "Mausoleum", "Mass Grave", "Cluster", "Block"];

  function nameTaken(name, exceptBid) { 
    return blockOrder.some((bid) => bid !== exceptBid && blocks[bid].block_name === name); 
  }
  
  function setFieldError(id, msg) { 
    const el = $(id); 
    if (!el) return; 
    el.textContent = msg || ""; 
    el.style.display = msg ? "block" : "none"; 
  }
  
  function validatedName(inputId, errId, exceptBid) {
    const name = $(inputId).value.trim();
    if (!name) { 
      setFieldError(errId, "Give the block a name."); 
      $(inputId).focus(); 
      return null; 
    }
    if (nameTaken(name, exceptBid)) { 
      setFieldError(errId, `A block named "${name}" already exists.`); 
      $(inputId).focus(); 
      return null; 
    }
    setFieldError(errId, ""); 
    return name;
  }
  
  function wireNameField(inputId, errId) { 
    const el = $(inputId); 
    if (el) el.addEventListener("input", () => setFieldError(errId, "")); 
  }
  
  function nextBlockPosition(bw, bh) {
    const step = CELL * 2, perRow = 6, i = blockOrder.length;
    return { bx: snap(60 + (i % perRow) * step), by: snap(60 + Math.floor(i / perRow) * step) };
  }

  function openAddBlockModal() {
    $("modalTitle").textContent = "Add New Block";
    $("modalBody").innerHTML = `
      <label>Block Name</label>
      <input type="text" id="fBn" placeholder="e.g. Block A">
      <p id="fBnErr" class="modalNote" style="display:none;color:#ef4444;margin-top:4px"></p>
      
      <label style="margin-top:10px">Block Type</label>
      <select id="fBt">
        ${BLOCK_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}
      </select>
      
      <label style="margin-top:10px">Image URL</label>
      <input type="text" id="fBImg" placeholder="https://example.com/image.jpg (optional)">
      
      <label style="margin-top:10px">Rows / Cols (grave grid)</label>
      <div class="modalRowPair" style="margin-top:6px">
        <div><label>Rows</label><input type="number" id="fBr" min="0" max="30" value="4"></div>
        <div><label>Cols</label><input type="number" id="fBc" min="0" max="30" value="4"></div>
      </div>
      <p style="font-size:11px;color:#94a3b8;margin-top:4px">Set both to 0 for a block with no grave grid.</p>`;

    $("modalConfirm").textContent = "Save"; 
    $("modalConfirm").className = "btnPrimary"; 
    $("modalConfirm").style.display = "";
    
    $("modalConfirm").onclick = () => {
      const name = validatedName("fBn", "fBnErr"); 
      if (!name) return;
      
      const rows = Math.max(0, parseInt($("fBr").value, 10) || 0), cols = Math.max(0, parseInt($("fBc").value, 10) || 0);
      const blockType = $("fBt").value, imageUrl = normalizeImageUrl($("fBImg").value);
      
      const bw = cols * CELL || CELL * 4, bh = rows * CELL || CELL * 4;
      const { bx, by } = nextBlockPosition(bw, bh);
      const points = rectToPoints(bx, by, bw, bh);
      
      const bid = uid();
      blocks[bid] = { 
        block_id: null, block_name: name, block_type: blockType, image_link: imageUrl, 
        coordinates: points, rows, cols, shape: "rectangle", custom: false, remarks: null, 
        x: bx, y: by, w: bw, h: bh, total_graves: rows * cols, vacant_count: rows * cols, occupied_count: 0 
      };
      
      blockOrder.push(bid);
      persistSave(); 
      closeModal();
      
      requestAnimationFrame(() => requestAnimationFrame(() => { 
        syncCanvasSize(); 
        draw(); 
        updateStatus(); 
        setHint('Block added! Use "Edit Layout" to move or edit it.'); 
      }));
    };
    
    $("modalCancel").textContent = "Cancel"; 
    $("modalCancel").onclick = closeModal;
    showModal(); 
    setTimeout(() => $("fBn") && $("fBn").focus(), 60); 
    wireNameField("fBn", "fBnErr");
  }

  function openBlockSelectModal(bid) {
    curBlock = bid; 
    const b = blocks[bid];
    $("modalTitle").textContent = b.block_name;
    
    $("modalBody").innerHTML = `
      <p style="font-size:12px;color:#94a3b8;margin-top:-4px;margin-bottom:14px">What would you like to do?</p>
      <button class="reshapeModalBtn" style="background:#eff6ff;color:#3b82f6;border-color:#bfdbfe;margin-bottom:8px" onclick="MAP.closeModal();MAP.openBlockDetailsModal('${bid}')">&#128065; View Block</button>
      <button class="reshapeModalBtn" style="background:#f0fdf4;color:#16a34a;border-color:#bbf7d0;margin-bottom:0" onclick="MAP.closeModal();MAP.openBlockEditModal('${bid}')">&#9998; Edit Block</button>`;
      
    $("modalConfirm").style.display = "none"; 
    $("modalCancel").textContent = "Close"; 
    $("modalCancel").onclick = closeModal; 
    showModal();
  }

  function openBlockDetailsModal(bid) {
    const b = blocks[bid];
    const { occ, res, avail, total } = blockStats(b);
    const imgId = `blockImgPreview_${bid}`;
    
    const imgHtml = b.image_link
      ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px;margin-bottom:12px;text-align:center">
           <img id="${imgId}" src="${escHtml(b.image_link)}" alt="${escHtml(b.block_name)}" referrerpolicy="no-referrer" style="display:block;max-width:100%;max-height:60vh;width:auto;height:auto;margin:0 auto;border-radius:4px" onerror="this.style.display='none';document.getElementById('${imgId}Err').style.display='block';">
         </div>
         <div id="${imgId}Err" class="viewInfoBox" style="display:none;text-align:center;color:#94a3b8;margin-bottom:12px">Image failed to load.</div>`
      : `<div class="viewInfoBox" style="text-align:center;color:#94a3b8;margin-bottom:12px">No image uploaded.</div>`;

    $("modalTitle").textContent = `${b.block_name} — Block Details`;
    
    $("modalBody").innerHTML = `
      ${imgHtml}
      <div class="viewInfoBox">
        <p><strong>${escHtml(b.block_name)}</strong></p>
        <p>${escHtml(b.block_type || "Block")} &middot; ${b.rows}\u00d7${b.cols}</p>
      </div>
      
      <div class="modalRowPair" style="margin-top:10px">
        <div class="viewInfoBox" style="text-align:center">
          <p style="font-size:11px;color:#94a3b8;margin:0">Vacant</p>
          <p style="font-size:18px;font-weight:700;color:#0f172a;margin:2px 0 0">${avail}</p>
        </div>
        <div class="viewInfoBox" style="text-align:center">
          <p style="font-size:11px;color:#94a3b8;margin:0">Occupied</p>
          <p style="font-size:18px;font-weight:700;color:#166534;margin:2px 0 0">${occ}</p>
        </div>
      </div>
      
      <div class="modalRowPair" style="margin-top:10px">
        <div class="viewInfoBox" style="text-align:center">
          <p style="font-size:11px;color:#94a3b8;margin:0">Reserved</p>
          <p style="font-size:16px;font-weight:600;color:#1e40af;margin:2px 0 0">${res}</p>
        </div>
        <div class="viewInfoBox" style="text-align:center;background:#f8fafc">
          <p style="font-size:11px;color:#94a3b8;margin:0">Capacity</p>
          <p style="font-size:18px;font-weight:700;color:#0f172a;margin:2px 0 0">${total}</p>
        </div>
      </div>
      
      <div id="gravesContainer" class="grave-grid-container">
        <div class="grave-grid-header"><span>Graves Information</span></div>
        <div style="text-align:center; color:#94a3b8; font-size:12px; padding:10px;">Loading graves...</div>
      </div>`;

    $("modalConfirm").style.display = "none"; 
    $("modalCancel").textContent = "Close"; 
    $("modalCancel").onclick = closeModal; 
    showModal();

    fetch(`${API_BLOCKS}/${b.block_id}`)
      .then(res => res.json())
      .then(res => {
        if (!res.success || !res.data || !res.data.graves) {
          throw new Error("Failed to load graves");
        }
        
        const graves = res.data.graves, container = $("gravesContainer");
        
        if (graves.length === 0) { 
          container.innerHTML = `
            <div class="grave-grid-header"><span>Graves Information</span></div>
            <div style="text-align:center; color:#94a3b8; font-size:12px; padding:10px;">No graves created for this block yet.</div>`; 
          return; 
        }

        let gridHtml = `
          <div class="grave-grid-header" style="display:flex; justify-content:space-between; align-items:center;">
            <span>Graves Information <span style="font-size:11px; font-weight:400; color:#64748b">(${graves.length} total)</span></span>
            
            <div style="position:relative; width:260px; display:flex; align-items:center;">
              <i class="fas fa-search" style="position:absolute; left:10px; color:#64748b; font-size:12px;"></i>
              <input type="text" id="graveSearchInput" placeholder="Search..." oninput="MAP.toggleClearBtn(this.value); MAP.filterGraves(this.value)" style="width:100%; padding: 6px 28px 6px 30px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; outline: none; font-family: inherit; transition: border-color 0.2s;" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#cbd5e1'">
              <i class="fas fa-times" id="clearSearchBtn" onclick="MAP.clearSearch()" style="display:none; position:absolute; right:10px; color:#64748b; font-size:12px; cursor:pointer;" title="Clear search"></i>
            </div>
          </div>
          <div class="grave-grid" id="graveGridContainer">`;

        graves.forEach(g => {
          const occ = g.occupants && g.occupants.length > 0 ? g.occupants[0] : null;
          const occName = occ ? occ.deceased_name : null;
          
          const dob = occ ? formatDate(occ.deceased_date_of_birth) : "--";
          const dod = occ ? formatDate(occ.deceased_date_of_death) : "--";
          const buried = occ ? formatDate(occ.date_buried) : "--";
          const expiry = occ ? formatDate(occ.lease_expiration_date) : "--";
          
          const statusClass = g.status.toLowerCase();
          const searchData = `${g.grave_code} ${occName || ''} ${g.remarks || ''}`.toLowerCase();
          
          const isEditable = (g.status === 'Vacant' || g.status === 'Other' || (g.status === 'Occupied' && !occName));
          
          let statusColor = 'background-color: #dcfce7; color: #166534; border: 1px solid #86efac;';
          if (g.status === 'Occupied') {
            statusColor = 'background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;';
          } else if (g.status === 'Other') {
            statusColor = 'background-color: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;';
          }
          
          gridHtml += `
            <div class="grave-card" data-search="${escHtml(searchData)}" id="grave-card-${g.grave_id}">
              
              <div class="grave-card-header" style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px dashed #cbd5e1; padding-bottom:6px; margin-bottom:2px;">
                <div>
                  <div class="grave-code">${escHtml(g.grave_code)}</div>
                  <div class="grave-meta">Row ${g.row_num} &middot; Col ${g.col_num}</div>
                </div>
                
                <div style="text-align:right;">
                  ${isEditable ? `
                    <div style="display:flex; align-items:center; gap:6px;">
                      
                      <span id="badge-${g.grave_id}" class="grave-status ${statusClass}" style="${statusColor}">${escHtml(g.status)}</span>
                      
                      <div id="edit-wrap-${g.grave_id}" style="display:none; position:relative; align-items:center; ${statusColor} border-radius:4px; padding:2px 6px;">
                        <select id="select-${g.grave_id}" onchange="MAP.updateDraftStatus(${g.grave_id}, this.value)" style="background: transparent; border: none; outline: none; cursor: pointer; appearance: none; -webkit-appearance: none; font-weight: 700; text-transform: uppercase; font-size: 10px; color: inherit; padding-right: 14px; width: 65px; text-align: center;">
                          <option value="Vacant" ${g.status === 'Vacant' ? 'selected' : ''}>Vacant</option>
                          <option value="Occupied" ${g.status === 'Occupied' ? 'selected' : ''}>Occupied</option>
                          <option value="Other" ${g.status === 'Other' ? 'selected' : ''}>Other</option>
                        </select>
                        <i class="fas fa-chevron-down" style="position: absolute; right: 4px; pointer-events: none; font-size: 8px; color: inherit; opacity: 0.7;"></i>
                      </div>
                      
                      <button id="btn-edit-${g.grave_id}" onclick="MAP.enableGraveEdit(${g.grave_id})" class="btn" style="background:#eff6ff; color:#3b82f6; border:1px solid #bfdbfe; padding:2px 6px; border-radius:4px; cursor:pointer; font-size:10px;" title="Edit"><i class="fas fa-pen"></i></button>
                      <button id="btn-save-${g.grave_id}" onclick="MAP.saveGraveEdits(${g.grave_id})" class="btn" style="display:none; background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; padding:2px 6px; border-radius:4px; cursor:pointer; font-size:10px;" title="Save"><i class="fas fa-save"></i></button>
                    
                    </div>
                  ` : `
                    <span class="grave-status ${statusClass}" style="${statusColor}">${escHtml(g.status)}</span>
                  `}
                </div>
              </div>
              
              <div style="font-size:12px; color:#0f172a; font-weight:600; margin-top:4px;">
                ${occName ? `👤 ${escHtml(occName)}` : `<span style="color:#94a3b8; font-weight:400;">Vacant</span>`}
              </div>
              
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; font-size:10px; color:#64748b; margin-top:6px;">
                <div><span style="font-weight:600;">DOB:</span> ${dob}</div>
                <div><span style="font-weight:600;">DOD:</span> ${dod}</div>
                <div><span style="font-weight:600;">Buried:</span> ${buried}</div>
                <div><span style="font-weight:600;">Expiry:</span> ${expiry}</div>
              </div>
              
              <div style="margin-top:8px;">
                <div id="remarks-view-${g.grave_id}" style="font-size:11px; color:#475569; font-style:italic;">${escHtml(g.remarks || 'No remarks')}</div>
                <input type="text" id="remarks-input-${g.grave_id}" style="display:none; width:100%; font-size:11px; padding:4px 6px; border:1px solid #e2e8f0; border-radius:4px; outline:none; font-family:inherit;" value="${escHtml(g.remarks || '')}">
              </div>
              
            </div>`;
        });
        
        gridHtml += `</div>`; 
        container.innerHTML = gridHtml;
      })
      .catch(err => {
        console.error("Grave load error:", err);
        $("gravesContainer").innerHTML = `<div class="grave-grid-header">Graves Information</div><div style="color:#ef4444; font-size:12px; padding:10px; text-align:center;">Failed to load graves.</div>`;
      });
  }

  // ── GRAVE EDIT HELPERS ───────────────────────────────────────────────────
  const graveDrafts = {};
  
  function updateDraftStatus(id, val) {
    if (!graveDrafts[id]) graveDrafts[id] = {};
    graveDrafts[id].status = val;
    
    const wrapper = document.getElementById(`edit-wrap-${id}`);
    if (wrapper) {
      if (val === 'Vacant') {
        wrapper.style.cssText = "display:inline-flex; position:relative; align-items:center; background-color: #dcfce7; color: #166534; border: 1px solid #86efac; border-radius:4px; padding:2px 6px;";
      } else if (val === 'Occupied') {
        wrapper.style.cssText = "display:inline-flex; position:relative; align-items:center; background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; border-radius:4px; padding:2px 6px;";
      } else {
        wrapper.style.cssText = "display:inline-flex; position:relative; align-items:center; background-color: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; border-radius:4px; padding:2px 6px;";
      }
    }
  }

  function enableGraveEdit(id) {
    const badge = document.getElementById(`badge-${id}`), editWrap = document.getElementById(`edit-wrap-${id}`);
    const btnEdit = document.getElementById(`btn-edit-${id}`), btnSave = document.getElementById(`btn-save-${id}`);
    const viewRemarks = document.getElementById(`remarks-view-${id}`), inputRemarks = document.getElementById(`remarks-input-${id}`);

    if (badge) badge.style.display = 'none';
    if (editWrap) editWrap.style.display = 'inline-flex';
    if (btnEdit) btnEdit.style.display = 'none';
    if (btnSave) btnSave.style.display = 'inline-block';
    if (viewRemarks) viewRemarks.style.display = 'none';
    if (inputRemarks) { 
      inputRemarks.style.display = 'block'; 
      inputRemarks.focus(); 
    }
  }

  function saveGraveEdits(id) {
    const select = document.getElementById(`select-${id}`), inputRemarks = document.getElementById(`remarks-input-${id}`);
    const btnSave = document.getElementById(`btn-save-${id}`);
    
    const newStatus = select ? select.value : null, newRemarks = inputRemarks ? inputRemarks.value.trim() : "";
    const finalStatus = (graveDrafts[id] && graveDrafts[id].status) ? graveDrafts[id].status : newStatus;

    btnSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; 
    btnSave.disabled = true;
    
    fetch(`api/graves.php/${id}`, {
      method: 'PUT', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: finalStatus, remarks: newRemarks })
    })
    .then(r => r.json())
    .then(res => {
      if (res.success === false) {
        alert("Failed to save: " + (res.message || "Unknown error"));
        btnSave.innerHTML = '<i class="fas fa-save"></i>'; 
        btnSave.disabled = false;
      } else {
        const badge = document.getElementById(`badge-${id}`), editWrap = document.getElementById(`edit-wrap-${id}`);
        const btnEdit = document.getElementById(`btn-edit-${id}`), viewRemarks = document.getElementById(`remarks-view-${id}`);
        
        if (badge) {
          badge.textContent = finalStatus; 
          badge.className = `grave-status ${finalStatus.toLowerCase()}`;
          
          let colorStr = 'background-color: #dcfce7; color: #166534; border: 1px solid #86efac;';
          if (finalStatus === 'Occupied') {
            colorStr = 'background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;';
          } else if (finalStatus === 'Other') {
            colorStr = 'background-color: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;';
          }
          badge.style.cssText = colorStr; 
          badge.style.display = 'inline-block';
        }
        
        if (editWrap) editWrap.style.display = 'none';
        if (btnEdit) btnEdit.style.display = 'inline-block';
        if (viewRemarks) { 
          viewRemarks.textContent = newRemarks || 'No remarks'; 
          viewRemarks.style.display = 'block'; 
        }
        if (inputRemarks) inputRemarks.style.display = 'none';
        
        btnSave.style.display = 'none'; 
        btnSave.innerHTML = '<i class="fas fa-save"></i>'; 
        btnSave.disabled = false;
      }
    })
    .catch(err => { 
      alert("Connection error while saving."); 
      btnSave.innerHTML = '<i class="fas fa-save"></i>'; 
      btnSave.disabled = false; 
    });
  }

  function toggleClearBtn(val) { 
    const btn = document.getElementById("clearSearchBtn"); 
    if (btn) btn.style.display = val.length > 0 ? 'block' : 'none'; 
  }
  
  function clearSearch() { 
    const input = document.getElementById("graveSearchInput"); 
    if (input) { 
      input.value = ""; 
      toggleClearBtn(""); 
      filterGraves(""); 
      input.focus(); 
    } 
  }
  
  function filterGraves(query) {
    const term = query.toLowerCase().trim(), cards = document.querySelectorAll('.grave-card');
    cards.forEach(card => {
      const searchData = card.getAttribute('data-search') || "";
      if (searchData.includes(term)) {
        card.style.display = 'flex'; 
      } else {
        card.style.display = 'none';
      }
    });
  }

  // ── EDIT BLOCK MODAL ─────────────────────────────────────────────────────
  function openBlockEditModal(bid) {
    curBlock = bid; 
    const b = blocks[bid], hasGraves = (b.total_graves || 0) > 0;
    
    $("modalTitle").textContent = `Edit block — ${b.block_name}`;
    
    $("modalBody").innerHTML = `
      <label>Block Name</label>
      <input type="text" id="fEn" value="${escHtml(b.block_name)}">
      <p id="fEnErr" class="modalNote" style="display:none;color:#ef4444;margin-top:4px"></p>
      
      ${hasGraves ? `
        <p class="modalNote" style="color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:6px 8px;margin-top:6px;font-size:11px;line-height:1.4">
          &#9888; This block has ${b.total_graves} grave(s). Renaming will also rewrite every grave code's prefix.
        </p>
      ` : ""}
      
      <label style="margin-top:10px">Block Type</label>
      <select id="fEt">
        ${BLOCK_TYPES.map((t) => `<option value="${t}" ${b.block_type === t ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      
      <label style="margin-top:10px">Image URL</label>
      <input type="text" id="fEImg" value="${escHtml(b.image_link || "")}" placeholder="https://example.com/image.jpg (optional)">
      
      <label style="margin-top:10px">Rows / Cols (changing these adjusts the grave grid)</label>
      <div class="modalRowPair" style="margin-top:6px">
        <div><label>Rows</label><input type="number" id="fEr" min="0" max="30" value="${b.rows}"></div>
        <div><label>Cols</label><input type="number" id="fEc" min="0" max="30" value="${b.cols}"></div>
      </div>
      
      <hr class="modalDivider">
      <button class="warnBtn" style="margin-top:10px;background:#fff;color:#ef4444;border-color:#fca5a5" onclick="MAP.deleteBlock('${bid}')">Delete block</button>`;

    $("modalConfirm").textContent = "Save changes"; 
    $("modalConfirm").className = "btnPrimary"; 
    $("modalConfirm").style.display = "";
    
    $("modalConfirm").onclick = () => {
      const name = validatedName("fEn", "fEnErr", bid); 
      if (!name) return;
      
      if (hasGraves && name !== b.block_name) {
        if (!window.confirm(`"${b.block_name}" has ${b.total_graves} grave record(s).\n\nRenaming will update every grave code to start with "${name}-" so reports stay consistent.\n\nContinue?`)) return;
      }
      
      const blk = blocks[bid];
      const payload = { 
        block_name: name, 
        block_type: $("fEt").value, 
        image_link: normalizeImageUrl($("fEImg").value), 
        rows: Math.max(0, parseInt($("fEr").value, 10) || 0), 
        cols: Math.max(0, parseInt($("fEc").value, 10) || 0) 
      };

      fetch(`${API_BLOCKS}/${blk.block_id}`, { 
        method: "PUT", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify(payload) 
      })
      .then((r) => r.json())
      .then((res) => {
        if (res.success === false) { 
          setHint("Save failed: " + (res.message || "unknown error")); 
          return; 
        }
        
        blk.block_name = name; 
        blk.block_type = payload.block_type; 
        blk.image_link = payload.image_link; 
        blk.rows = payload.rows; 
        blk.cols = payload.cols;
        
        if (res.data) { 
          blk.total_graves = res.data.total_graves; 
          blk.vacant_count = res.data.vacant; 
          blk.occupied_count = res.data.occupied; 
        }
        
        flashSaved(); 
        closeModal(); 
        draw(); 
        updateStatus();
      })
      .catch((err) => { 
        console.error("Save failed:", err); 
        setHint("Save failed — check your connection."); 
      });
    };
    
    $("modalCancel").textContent = "Cancel"; 
    $("modalCancel").onclick = closeModal; 
    showModal();
    setTimeout(() => $("fEn") && $("fEn").focus(), 60); 
    wireNameField("fEn", "fEnErr");
  }

  function openBlockLayoutModal(bid) {
    curBlock = bid; 
    const b = blocks[bid];
    
    $("modalTitle").textContent = `Edit layout — ${b.block_name}`;
    
    $("modalBody").innerHTML = `
      <hr class="modalDivider" style="border-top:none; margin-top:0;">
      <button class="reshapeModalBtn" style="margin-top:0" onclick="MAP.enterReshapeMode('${bid}')">&#9998; Reshape block (draw a line)</button>
      <p class="modalNote" style="margin-top:10px">Reshaping draws a line across the block and lets you keep either side. Drag the block on the canvas to move it.</p>`;
      
    $("modalConfirm").textContent = "Save changes"; 
    $("modalConfirm").className = "btnPrimary"; 
    $("modalConfirm").style.display = "none";
    
    $("modalCancel").textContent = "Close"; 
    $("modalCancel").onclick = closeModal; 
    showModal();
  }

  // ── DELETE BLOCK ─────────────────────────────────────────────────────────
  function deleteBlock(bid) {
    const b = blocks[bid];
    if (!b.block_id) {
      blockOrder = blockOrder.filter((id) => id !== bid); 
      delete blocks[bid];
      if (curBlock === bid) curBlock = null; 
      if (reshapeBid === bid) _clearReshape();
      closeModal(); 
      draw(); 
      updateStatus(); 
      return;
    }
    
    if ((b.total_graves || 0) > 0) {
      if (!window.confirm(`Delete "${b.block_name}"?\n\nThis block contains ${b.total_graves} grave record(s). Deleting the block will also soft-delete all of its graves. Existing interment records that reference those graves will keep working, but the graves will no longer appear in any list.\n\nContinue?`)) return;
    }
    
    fetch(`${API_BLOCKS}/${b.block_id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((res) => {
        if (res.success === false) { 
          setHint("Delete failed: " + (res.message || "unknown error")); 
          return; 
        }
        
        blockOrder = blockOrder.filter((id) => id !== bid); 
        delete blocks[bid];
        if (curBlock === bid) curBlock = null; 
        if (reshapeBid === bid) _clearReshape();
        
        closeModal(); 
        draw(); 
        updateStatus(); 
        setHint("Block deleted.");
      })
      .catch((err) => { 
        console.error("Delete failed:", err); 
        setHint("Delete failed — check your connection."); 
      });
  }

  // ── GLOBAL MODAL OVERLAY ─────────────────────────────────────────────────
  function showModal() { 
    $("modalOverlay").classList.add("open"); 
  }
  
  function closeModal() {
    if (!$("modalOverlay")) return;
    $("modalOverlay").classList.remove("open"); 
    $("modalConfirm").style.display = "";
    $("modalCancel").textContent = "Cancel"; 
    $("modalCancel").onclick = closeModal; 
    pendingNavHref = null;
  }

  function openUnsavedChangesModal(href) {
    pendingNavHref = href; 
    $("modalTitle").textContent = "Unsaved changes";
    
    $("modalBody").innerHTML = `
      <p style="font-size:13px;color:#475569;margin-top:4px;line-height:1.5">You're still editing the layout. Save your changes before leaving this page, or they'll be lost.</p>
      <p class="modalNote" style="margin-top:14px"><a href="#" id="discardLeaveLink">Discard changes and leave anyway</a></p>`;
      
    $("modalConfirm").textContent = "Save & leave"; 
    $("modalConfirm").className = "btnPrimary"; 
    $("modalConfirm").style.display = "";
    
    $("modalConfirm").onclick = () => {
      const dest = pendingNavHref; 
      persistSave(); 
      exitEditMap(); 
      pendingNavHref = null; 
      closeModal(); 
      if (dest) window.location.href = dest;
    };
    
    $("modalCancel").textContent = "Stay here"; 
    $("modalCancel").onclick = closeModal; 
    showModal();
    
    $("discardLeaveLink").onclick = (e) => {
      e.preventDefault(); 
      const dest = pendingNavHref; 
      exitEditMap(); 
      pendingNavHref = null; 
      closeModal(); 
      if (dest) window.location.href = dest;
    };
  }

  function initNavGuard() {
    document.addEventListener("click", (e) => {
      if (!mapEditMode) return;
      const link = e.target.closest("a[href]"); 
      if (!link) return;
      
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      
      e.preventDefault(); 
      openUnsavedChangesModal(href);
    });
    
    window.addEventListener("beforeunload", (e) => { 
      if (mapEditMode) { 
        e.preventDefault(); 
        e.returnValue = ""; 
      } 
    });
  }

  // ── STATUS BAR ───────────────────────────────────────────────────────────
  function updateStatus() {
    let total = 0, occ = 0, res = 0;
    blockOrder.forEach((bid) => {
      const s = blockStats(blocks[bid]); 
      total += s.total; 
      occ += s.occ; 
      res += s.res;
    });
    
    $("mapStatus").textContent = `${blockOrder.length} block(s) · Total: ${total} · Occupied: ${occ} · Reserved: ${res} · Available: ${total - occ - res}`;
  }

  // ── INITIALIZATION ───────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    canvasWrap = $("mapCanvas"); 
    cv = $("mapCvs"); 
    ctx = cv.getContext("2d");
    
    syncCanvasSize(); 
    initButtons(); 
    initCanvasEvents(); 
    initNavGuard(); 
    persistLoad();
  });

  // Expose public methods to the global MAP object (for HTML onclick handlers)
  return {
    enterEditMap, 
    exitEditMap, 
    openAddBlockModal, 
    enterReshapeMode, 
    exitReshapeMode, 
    keepSplitSide, 
    swapSplitSide,
    cancelSplit, 
    undoReshape, 
    openBlockDetailsModal, 
    openBlockEditModal, 
    openBlockLayoutModal,
    deleteBlock, 
    closeModal, 
    filterGraves, 
    toggleClearBtn, 
    clearSearch, 
    updateDraftStatus, 
    enableGraveEdit, 
    saveGraveEdits
  };
})();