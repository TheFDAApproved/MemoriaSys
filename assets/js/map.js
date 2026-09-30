const MAP = (() => {
  // ── CONSTANTS ────────────────────────────────────────────
  const CELL = 22;
  const API_BLOCKS = "api/blocks.php";

  // ── STATE ────────────────────────────────────────────────
  let mapEditMode = false;
  let resizeMode = false;
  let reshapeMode = false;
  let reshapeBid = null;
  let reshapeHistory = [];
  let drawPoints = [];
  let pendingSplit = null;
  let mousePos = { x: 0, y: 0 };
  let cvW = 0, cvH = 0;
  let resizingBid = null;
  let curBlock = null;
  let hoveredBlock = null;
  let pendingNavHref = null;
  let drag = { active: false, sx: 0, sy: 0, ex: 0, ey: 0 };
  let blocks = {};
  let blockOrder = [];

  let blockDrag = {
    active: false, bid: null, startX: 0, startY: 0, dx: 0, dy: 0, origPts: null,
  };

  const $ = (id) => document.getElementById(id);
  let canvasWrap, cv, ctx;

  // ── GEOMETRY ─────────────────────────────────────────────
  function uid() {
    return Math.random().toString(36).slice(2, 8);
  }
  function snap(v) {
    return Math.round(v / CELL) * CELL;
  }
  function rectToPoints(x, y, w, h) {
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  function ensurePolygon(b) {
    if (!b.coordinates_canvas || b.coordinates_canvas.length < 3)
      b.coordinates_canvas = rectToPoints(b.x, b.y, b.w, b.h);
    return b.coordinates_canvas;
  }
  function circlePoints(cx, cy, r, sides = 48) {
    const pts = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
    return pts;
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
    if (!at) { at = computeLabelAnchor(pts); labelAnchors.set(pts, at); }
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
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function normalizeImageUrl(u) {
    u = (u || "").trim();
    if (!u) return null;
    if (/^(https?:|data:|blob:|\/)/i.test(u)) return u;
    return "https://" + u;
  }

  // ── CANVAS SIZE ──────────────────────────────────────────
  function syncCanvasSize() {
    const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cvW = w; cvH = h;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw; cv.height = bh;
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }
  }

  // ── PERSISTENCE ──────────────────────────────────────────
  function saveOneBlock(bid) {
    const b = blocks[bid];
    const payload = {
      block_name: b.block_name,
      block_type: b.block_type,
      image_link: b.image_link,
      coordinates_canvas: JSON.stringify(b.coordinates_canvas),
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
        if (res.success === false) throw new Error(res.message || "Load failed");

        const rows = Array.isArray(res.data) ? res.data : (res.data.blocks || []);

        blocks = {};
        blockOrder = [];

        let stagedIndex = 0;
        rows.forEach((row) => {
          let pts = null;

          if (row.coordinates_canvas) {
            try {
              pts = typeof row.coordinates_canvas === "string"
                ? JSON.parse(row.coordinates_canvas)
                : row.coordinates_canvas;
            } catch { pts = null; }
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
            coordinates_canvas: pts,
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

  // ── DRAW ─────────────────────────────────────────────────
  function draw() {
    if (!cvW || !cvH) syncCanvasSize();
    ctx.clearRect(0, 0, cvW, cvH);

    const interacting = drag.active || blockDrag.active;
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
      const isRes = resizingBid === bid;
      const isResh = reshapeMode && reshapeBid === bid;
      const isDrag = blockDrag.active && blockDrag.bid === bid;
      const { occ, res, avail } = blockStats(b);
      const bounds = polyBounds(pts);

      ctx.globalAlpha =
        reshapeMode && !isResh ? 0.25 : isRes ? 0.4 : isDrag ? 0.75 : 1;

      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();

      ctx.fillStyle = isResh ? "#fef9c3" : isDrag ? "#ede9fe" : (b.needsPlacement ? "#fef3c7" : "#dbeafe");
      ctx.strokeStyle = isResh ? "#f59e0b"
        : isRes ? "#ef4444"
        : isDrag ? "#8b5cf6"
        : hov ? "#1d4ed8"
        : (b.needsPlacement ? "#f59e0b" : "#3b82f6");
      ctx.lineWidth = isResh || hov || isRes || isDrag ? 2 : 1;
      ctx.fill();
      ctx.stroke();

      const label = labelAnchor(pts);
      const roomy = bounds.h >= 56;

      ctx.fillStyle = "#1e3a5f";
      ctx.font = "500 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(b.block_name, label.x, roomy ? label.y - 14 : label.y + 4);

      if (roomy) {
        ctx.fillStyle = "#2563eb";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText(`${b.rows}\u00d7${b.cols}`, label.x, label.y + 2);
        ctx.fillText(`${occ} occ \u00b7 ${res} res \u00b7 ${avail} avail`, label.x, label.y + 16);
      }

      if (!reshapeMode && !isDrag && roomy) {
        const footY = bounds.y + bounds.h - 8;
        const hintY = pointInPoly(label.x, footY, pts) ? footY : label.y + 30;
        ctx.fillStyle = isRes ? "#ef4444" : mapEditMode ? "#3b82f6" : "#2563eb";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText(
          isRes ? "drag to resize\u2026"
            : mapEditMode ? "click to reshape \u00b7 drag to move"
            : "click to view",
          label.x, hintY
        );
      }

      if (isResh && pendingSplit) drawSplitPreview();

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
          ctx.fill(); ctx.stroke();
        });

        if (drawPoints.length > 0) {
          ctx.beginPath();
          ctx.moveTo(drawPoints[0].x, drawPoints[0].y);
          drawPoints.forEach((p, i) => { if (i > 0) ctx.lineTo(p.x, p.y); });
          ctx.lineTo(mousePos.x, mousePos.y);
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
            ctx.fill(); ctx.stroke();
          });
        }
      }

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

    if (drag.active) {
      const x = Math.min(drag.sx, drag.ex), y = Math.min(drag.sy, drag.ey);
      const w = Math.max(Math.abs(drag.ex - drag.sx), CELL * 2);
      const h = Math.max(Math.abs(drag.ey - drag.sy), CELL * 2);
      ctx.fillStyle = "rgba(59,130,246,0.10)";
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#1e3a5f";
      ctx.font = "11px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        `${Math.max(1, Math.round(h / CELL))} rows \u00d7 ${Math.max(1, Math.round(w / CELL))} cols`,
        x + w / 2, y + h / 2
      );
    }
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
    ctx.fillText("KEEP", kc.x, kc.y);
    const dc = polyCentroid(drop);
    ctx.fillStyle = "#64748b";
    ctx.fillText("REMOVE", dc.x, dc.y);
  }

  function hitBlock(mx, my) {
    return blockOrder.slice().reverse().find((bid) => pointInPoly(mx, my, ensurePolygon(blocks[bid])));
  }
  function getXY(e) {
    const r = cv.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    return { x: s.clientX - r.left, y: s.clientY - r.top };
  }

  // ── RESHAPE ──────────────────────────────────────────────
  function handleDrawClick(mx, my) {
    const pts = ensurePolygon(blocks[reshapeBid]);
    const edge = closestEdge(pts, mx, my);
    const onEdge = edge && edge.dist < 24;

    if (drawPoints.length === 0) {
      if (!onEdge) return;
      drawPoints = [{ ...edge.point, edgeIndex: edge.edgeIndex, onEdge: true }];
      setHint("Add waypoints, then click another edge to close the line.");
      draw();
      return;
    }

    if (onEdge) {
      const startPt = drawPoints[0];
      if (dist(edge.point, startPt) < 10 && drawPoints.length < 2) return;
      const split = splitPolygon(
        pts, startPt,
        { ...edge.point, edgeIndex: edge.edgeIndex },
        drawPoints.slice(1)
      );
      drawPoints = [];
      if (!split) {
        setHint("That line didn't divide the block — try again.");
        draw();
        return;
      }
      pendingSplit = {
        a: split.a, b: split.b,
        keep: polyArea(split.a) >= polyArea(split.b) ? "a" : "b",
      };
      updateReshapeToolbar();
      setHint("Click a half to pick it, then \"Keep this side\" to confirm \u00b7 Esc to redraw.");
      draw();
      return;
    }

    drawPoints.push({ x: snap(mx), y: snap(my), onEdge: false });
    draw();
  }

  function splitPolygon(pts, start, end, mid) {
    let idx1 = start.edgeIndex, idx2 = end.edgeIndex;
    let pt1 = { x: start.x, y: start.y }, pt2 = { x: end.x, y: end.y };
    const midPoints = mid.map((p) => ({ x: p.x, y: p.y }));

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
    if (inA && !inB) pendingSplit.keep = "a";
    else if (inB && !inA) pendingSplit.keep = "b";
    else pendingSplit.keep = pendingSplit.keep === "a" ? "b" : "a";
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
      coordinates_canvas: blk.coordinates_canvas.map((p) => ({ ...p })),
      shape: blk.shape, custom: !!blk.custom,
    });
    blk.coordinates_canvas = pendingSplit.keep === "a" ? pendingSplit.a : pendingSplit.b;
    blk.shape = "polygon";
    blk.custom = true;
    syncBounds(blk);
    pendingSplit = null;
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

  // ── EVENTS ───────────────────────────────────────────────
  function initCanvasEvents() {
    const handleMove = (e) => {
      if (drag.active || blockDrag.active || (reshapeMode && drawPoints.length > 0)) {
        if (e.cancelable) e.preventDefault();
      }
      const { x, y } = getXY(e);
      mousePos = { x, y };

      if (blockDrag.active) {
        blockDrag.dx = x - blockDrag.startX;
        blockDrag.dy = y - blockDrag.startY;
        blocks[blockDrag.bid].coordinates_canvas = blockDrag.origPts.map((p) => ({
          x: p.x + blockDrag.dx, y: p.y + blockDrag.dy,
        }));
        scheduleDraw();
        return;
      }
      if (drag.active) { drag.ex = x; drag.ey = y; scheduleDraw(); return; }
      if (reshapeMode) { scheduleDraw(); return; }

      const bid = hitBlock(x, y);
      if (bid !== hoveredBlock) { hoveredBlock = bid; scheduleDraw(); }
      canvasWrap.style.cursor = bid
        ? (mapEditMode ? "grab" : "pointer")
        : (resizeMode ? "crosshair" : "default");
    };

    const handleDown = (e) => {
      const { x, y } = getXY(e);
      if (reshapeMode) {
        if (!reshapeBid) return;
        if (pendingSplit) pickSplitSide(x, y);
        else handleDrawClick(x, y);
        return;
      }
      if (resizeMode) { drag = { active: true, sx: x, sy: y, ex: x, ey: y }; return; }

      const bid = hitBlock(x, y);
      if (!bid) return;

      if (mapEditMode) {
        blockDrag = {
          active: true, bid, startX: x, startY: y, dx: 0, dy: 0,
          origPts: ensurePolygon(blocks[bid]).map((p) => ({ ...p })),
        };
        canvasWrap.style.cursor = "grabbing";
        setHint("Dragging block \u2014 release to drop.");
        draw();
        return;
      }
      openBlockSelectModal(bid);
    };

    const handleUp = (e) => {
      if (blockDrag.active) {
        const bid = blockDrag.bid;
        const blk = blocks[bid];
        const isClick = Math.hypot(blockDrag.dx, blockDrag.dy) < 5;
        if (isClick) {
          blk.coordinates_canvas = blockDrag.origPts;
        } else {
          const dx = snap(blockDrag.dx), dy = snap(blockDrag.dy);
          blk.coordinates_canvas = blockDrag.origPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        }
        syncBounds(blk);
        blockDrag = { active: false, bid: null, startX: 0, startY: 0, dx: 0, dy: 0, origPts: null };
        canvasWrap.style.cursor = "default";
        setHint("Click a block to change its shape, or drag it to move it.");
        draw();
        if (isClick) openBlockLayoutModal(bid);
        return;
      }
      if (!drag.active) return;
      if (e.type !== "touchend" && e.clientX) {
        const pos = getXY(e); drag.ex = pos.x; drag.ey = pos.y;
      }
      const rx = snap(Math.min(drag.sx, drag.ex));
      const ry = snap(Math.min(drag.sy, drag.ey));
      const rw = Math.max(snap(Math.abs(drag.ex - drag.sx)), CELL * 2);
      const rh = Math.max(snap(Math.abs(drag.ey - drag.sy)), CELL * 2);
      drag.active = false;
      if (resizeMode && resizingBid) finishResize(rx, ry, rw, rh);
      else draw();
    };

    cv.addEventListener("mousemove", handleMove);
    cv.addEventListener("mouseleave", () => {
      if (drag.active || blockDrag.active || reshapeMode) return;
      if (hoveredBlock) { hoveredBlock = null; scheduleDraw(); }
    });
    window.addEventListener("mousemove", (e) => {
      if (drag.active || blockDrag.active) handleMove(e);
    });
    cv.addEventListener("mousedown", handleDown);
    cv.addEventListener("mouseup", handleUp);
    cv.addEventListener("touchmove", handleMove, { passive: false });
    cv.addEventListener("touchstart", handleDown, { passive: false });
    cv.addEventListener("touchend", handleUp);
    cv.addEventListener("dblclick", (e) => {
      if (!reshapeMode || pendingSplit || drawPoints.length < 2) return;
      const { x, y } = getXY(e);
      const pts = ensurePolygon(blocks[reshapeBid]);
      const edge = closestEdge(pts, x, y);
      if (edge && edge.dist < 30) handleDrawClick(x, y);
    });
    window.addEventListener("mouseup", (e) => {
      if (drag.active || blockDrag.active) handleUp(e);
    });

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => { syncCanvasSize(); scheduleDraw(); }).observe(canvasWrap);
    } else {
      window.addEventListener("resize", () => { syncCanvasSize(); scheduleDraw(); });
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && reshapeMode) {
        if (pendingSplit) cancelSplit();
        else { drawPoints = []; draw(); }
      }
    });
  }

  // ── BUTTONS ──────────────────────────────────────────────
  function initButtons() {
    $("btnEditMap").addEventListener("click", enterEditMap);
    $("btnSaveMap").addEventListener("click", () => { persistSave(); exitEditMap(); });
    $("btnAddBlock").addEventListener("click", openAddBlockModal);
    $("btnCancelAdd").addEventListener("click", cancelResize);
    $("modalOverlay").addEventListener("click", function (e) {
      if (e.target === this) closeModal();
    });
  }

  function enterEditMap() {
    mapEditMode = true;
    $("btnEditMap").style.display = "none";
    $("btnSaveMap").style.display = "";
    setHint("Click a block to change its shape, or drag it to move it.");
    draw();
  }
  function exitEditMap() {
    if (reshapeMode) _clearReshape();
    blockDrag = { active: false, bid: null, startX: 0, startY: 0, dx: 0, dy: 0, origPts: null };
    mapEditMode = false; resizeMode = false; resizingBid = null; hoveredBlock = null;
    canvasWrap.style.cursor = "default";
    $("btnEditMap").style.display = "";
    $("btnSaveMap").style.display = "none";
    $("btnAddBlock").style.display = "";
    $("btnCancelAdd").style.display = "none";
    setHint("");
    draw();
  }
  function cancelResize() {
    resizeMode = false; resizingBid = null; drag.active = false;
    canvasWrap.style.cursor = "default";
    $("btnAddBlock").style.display = "";
    $("btnCancelAdd").style.display = "none";
    setHint('Click "Add Block" to create one, or "Edit Layout" to change existing blocks.');
    draw();
  }
  function setHint(t) {
    if ($("mapHint")) $("mapHint").textContent = t;
  }

  // ── RESHAPE MODE ─────────────────────────────────────────
  const RESHAPE_HINT = "DRAW LINE: click an edge, add waypoints, then click another edge to divide the block.";

  function enterReshapeMode(bid) {
    reshapeMode = true; reshapeBid = bid; reshapeHistory = [];
    drawPoints = []; pendingSplit = null;
    resizeMode = false; resizingBid = null; drag.active = false;
    $("btnAddBlock").style.display = "none";
    $("btnCancelAdd").style.display = "none";
    updateReshapeToolbar();
    canvasWrap.style.cursor = "crosshair";
    closeModal();
    setHint(RESHAPE_HINT);
    draw();
  }
  function exitReshapeMode() {
    _clearReshape();
    $("btnAddBlock").style.display = "";
    canvasWrap.style.cursor = "default";
    setHint('Click "Add Block" to create one, or "Edit Layout" to change existing blocks.');
    draw();
  }
  function updateReshapeToolbar() {
    const choosing = reshapeMode && !!pendingSplit;
    const show = (id, on) => { if ($(id)) $(id).style.display = on ? "" : "none"; };
    show("btnKeepSide", choosing);
    show("btnSwapSide", choosing);
    show("btnDoneReshape", reshapeMode && !choosing);
    show("btnUndoReshape", reshapeMode && !choosing);
  }
  function undoReshape() {
    if (!reshapeHistory.length) return;
    const prev = reshapeHistory.pop();
    const blk = blocks[reshapeBid];
    blk.coordinates_canvas = prev.coordinates_canvas;
    blk.shape = prev.shape;
    blk.custom = prev.custom;
    syncBounds(blk);
    drawPoints = []; pendingSplit = null;
    updateReshapeToolbar();
    setHint(RESHAPE_HINT);
    draw();
  }
  function _clearReshape() {
    reshapeMode = false; reshapeBid = null;
    reshapeHistory = []; drawPoints = []; pendingSplit = null;
    $("btnAddBlock").style.display = "";
    updateReshapeToolbar();
  }

  // ── MODALS ───────────────────────────────────────────────
  const BLOCK_TYPES = ["Niche", "Bone Chamber", "Unmapped Area", "Private", "Mausoleum", "Mass Grave", "Cluster", "Block"];

  function nameTaken(name, exceptBid) {
    return blockOrder.some((bid) => bid !== exceptBid && blocks[bid].block_name === name);
  }
  function setFieldError(id, msg) {
    const el = $(id); if (!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }
  function validatedName(inputId, errId, exceptBid) {
    const name = $(inputId).value.trim();
    if (!name) { setFieldError(errId, "Give the block a name."); $(inputId).focus(); return null; }
    if (nameTaken(name, exceptBid)) {
      setFieldError(errId, `A block named "${name}" already exists.`);
      $(inputId).focus(); return null;
    }
    setFieldError(errId, "");
    return name;
  }
  function wireNameField(inputId, errId) {
    const el = $(inputId);
    if (el) el.addEventListener("input", () => setFieldError(errId, ""));
  }

  const SHAPE_NOTES = {
    rectangle: "A standard rectangular block sized to what you drew.",
    square: "Forced to equal sides, using the smaller of the drawn dimensions.",
    circle: "Drawn as a circular block inscribed in the area you selected.",
    polygon: "Starts as a rectangle, then opens Draw Line so you can divide it.",
  };

  function nextBlockPosition(bw, bh) {
    const step = CELL * 2, perRow = 6;
    const i = blockOrder.length;
    const bx = snap(60 + (i % perRow) * step);
    const by = snap(60 + Math.floor(i / perRow) * step);
    return { bx, by };
  }

  function openAddBlockModal() {
    if (reshapeMode || resizeMode) return;
    $("modalTitle").textContent = "Add New Block";
    $("modalBody").innerHTML = `
      <label>Block Name</label>
      <input type="text" id="fBn" placeholder="e.g. Block A">
      <p id="fBnErr" class="modalNote" style="display:none;color:#ef4444;margin-top:4px"></p>
      <label style="margin-top:10px">Block Type</label>
      <select id="fBt">
        ${BLOCK_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <label style="margin-top:10px">Map Shape</label>
      <select id="fBShape">
        <option value="rectangle">Rectangle</option>
        <option value="square">Square</option>
        <option value="circle">Circle</option>
        <option value="polygon">Polygon (Custom)</option>
      </select>
      <p id="fBShapeNote" style="font-size:11px;color:#94a3b8;margin-top:4px"></p>
      <label style="margin-top:10px">Image URL</label>
      <input type="text" id="fBImg" placeholder="https://example.com/image.jpg (optional)">
      <label style="margin-top:10px">Rows / Cols (grave grid)</label>
      <div class="modalRowPair" style="margin-top:6px">
        <div><label>Rows</label><input type="number" id="fBr" min="0" max="30" value="4"></div>
        <div><label>Cols</label><input type="number" id="fBc" min="0" max="30" value="4"></div>
      </div>
      <p style="font-size:11px;color:#94a3b8;margin-top:4px">
        Set both to 0 for a block with no grave grid.
      </p>`;

    $("modalConfirm").textContent = "Save";
    $("modalConfirm").className = "btnPrimary";
    $("modalConfirm").style.display = "";
    $("modalConfirm").onclick = () => {
      const name = validatedName("fBn", "fBnErr");
      if (!name) return;
      const shape = $("fBShape").value;
      const rowsRaw = $("fBr").value.trim();
      const colsRaw = $("fBc").value.trim();
      const rows = Math.max(0, parseInt(rowsRaw, 10) || 0);
      const cols = Math.max(0, parseInt(colsRaw, 10) || 0);
      const blockType = $("fBt").value;
      const imageUrl = normalizeImageUrl($("fBImg").value);

      const bw = cols * CELL || CELL * 4;
      const bh = rows * CELL || CELL * 4;
      const { bx, by } = nextBlockPosition(bw, bh);

      let points;
      if (shape === "square") {
        const side = Math.min(bw, bh);
        points = rectToPoints(bx, by, side, side);
      } else if (shape === "circle") {
        points = circlePoints(bx + bw / 2, by + bh / 2, Math.min(bw, bh) / 2);
      } else {
        points = rectToPoints(bx, by, bw, bh);
      }

      const bid = uid();
      blocks[bid] = {
        block_id: null,
        block_name: name,
        block_type: blockType,
        image_link: imageUrl,
        coordinates_canvas: points,
        rows, cols, shape, custom: false, remarks: null,
        x: bx, y: by, w: bw, h: bh,
        total_graves: rows * cols,
        vacant_count: rows * cols,
        occupied_count: 0,
      };
      blockOrder.push(bid);
      persistSave();
      closeModal();

      requestAnimationFrame(() => requestAnimationFrame(() => {
        syncCanvasSize(); draw(); updateStatus();
        if (shape === "polygon") enterReshapeMode(bid);
        else setHint('Block added! Use "Edit Layout" to move or edit it.');
      }));
    };
    $("modalCancel").textContent = "Cancel";
    $("modalCancel").onclick = closeModal;
    showModal();
    setTimeout(() => $("fBn") && $("fBn").focus(), 60);
    wireNameField("fBn", "fBnErr");

    const updateShapeNote = () => {
      $("fBShapeNote").textContent = SHAPE_NOTES[$("fBShape").value] || "";
    };
    $("fBShape").addEventListener("change", updateShapeNote);
    updateShapeNote();
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
           <img id="${imgId}" src="${escHtml(b.image_link)}" alt="${escHtml(b.block_name)}" referrerpolicy="no-referrer"
             style="display:block;max-width:100%;max-height:60vh;width:auto;height:auto;margin:0 auto;border-radius:4px"
             onerror="this.style.display='none';document.getElementById('${imgId}Err').style.display='block';">
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
      </div>`;
    $("modalConfirm").style.display = "none";
    $("modalCancel").textContent = "Close";
    $("modalCancel").onclick = closeModal;
    showModal();
  }

  function openBlockEditModal(bid) {
    curBlock = bid;
    const b = blocks[bid];
    const hasGraves = (b.total_graves || 0) > 0;

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
        const ok = window.confirm(
          `"${b.block_name}" has ${b.total_graves} grave record(s).\n\n` +
          `Renaming will update every grave code to start with "${name}-" so reports stay consistent.\n\n` +
          `Continue?`
        );
        if (!ok) return;
      }

      const blk = blocks[bid];
      blk.block_name = name;
      blk.cols = Math.max(0, parseInt($("fEc").value, 10) || 0);
      blk.rows = Math.max(0, parseInt($("fEr").value, 10) || 0);
      blk.block_type = $("fEt").value;
      blk.image_link = normalizeImageUrl($("fEImg").value);

      saveOneBlock(bid)
        .then((res) => {
          if (res && res.success === false) {
            setHint("Save failed: " + (res.message || "unknown error"));
            return;
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
    const curShape = b.shape || "rectangle";
    $("modalTitle").textContent = `Edit layout — ${b.block_name}`;
    $("modalBody").innerHTML = `
      <label>Map Shape</label>
      <select id="fLShape">
        <option value="rectangle" ${curShape === "rectangle" ? "selected" : ""}>Rectangle</option>
        <option value="square" ${curShape === "square" ? "selected" : ""}>Square</option>
        <option value="circle" ${curShape === "circle" ? "selected" : ""}>Circle</option>
        <option value="polygon" ${curShape === "polygon" ? "selected" : ""}>Polygon (Custom)</option>
      </select>
      <p id="fLShapeNote" style="font-size:11px;color:#94a3b8;margin-top:4px"></p>
      <hr class="modalDivider">
      <button class="reshapeModalBtn" style="margin-top:10px" onclick="MAP.enterReshapeMode('${bid}')">&#9998; Reshape block (draw a line)</button>
      <button class="warnBtn" onclick="MAP.activateResize('${bid}')">Resize block on canvas</button>`;

    $("modalConfirm").textContent = "Save changes";
    $("modalConfirm").className = "btnPrimary";
    $("modalConfirm").style.display = "";
    $("modalConfirm").onclick = () => {
      const newShape = $("fLShape").value;
      const blk = blocks[bid];
      const shapeChanged = newShape !== curShape;
      blk.shape = newShape;
      if (shapeChanged && newShape !== "polygon") {
        blk.custom = false;
        if (newShape === "square") {
          const side = Math.min(blk.w, blk.h);
          blk.coordinates_canvas = rectToPoints(blk.x, blk.y, side, side);
        } else if (newShape === "circle") {
          blk.coordinates_canvas = circlePoints(blk.x + blk.w / 2, blk.y + blk.h / 2, Math.min(blk.w, blk.h) / 2);
        } else {
          blk.coordinates_canvas = rectToPoints(blk.x, blk.y, blk.w, blk.h);
        }
        syncBounds(blk);
      }
      closeModal(); draw(); updateStatus();
      if (shapeChanged && newShape === "polygon") enterReshapeMode(bid);
    };
    $("modalCancel").textContent = "Cancel";
    $("modalCancel").onclick = closeModal;
    showModal();
    const updateShapeNote = () => {
      $("fLShapeNote").textContent = SHAPE_NOTES[$("fLShape").value] || "";
    };
    $("fLShape").addEventListener("change", updateShapeNote);
    updateShapeNote();
  }

  function activateResize(bid) {
    closeModal();
    resizingBid = bid; resizeMode = true; hoveredBlock = null;
    canvasWrap.style.cursor = "crosshair";
    $("btnAddBlock").style.display = "none";
    $("btnCancelAdd").style.display = "";
    $("btnCancelAdd").textContent = "Cancel resize";
    setHint(`Drag to set the new size of "${blocks[bid].block_name}".`);
    draw();
  }

  function finishResize(rx, ry, rw, rh) {
    const bid = resizingBid;
    const blk = blocks[bid];
    blk.x = rx; blk.y = ry; blk.w = rw; blk.h = rh;
    const shape = blk.shape || "rectangle";
    if (isCustomShape(blk)) {
      blk.coordinates_canvas = scalePolyTo(blk.coordinates_canvas, rx, ry, rw, rh);
    } else if (shape === "square") {
      const side = Math.min(rw, rh);
      blk.coordinates_canvas = rectToPoints(rx, ry, side, side);
    } else if (shape === "circle") {
      blk.coordinates_canvas = circlePoints(rx + rw / 2, ry + rh / 2, Math.min(rw, rh) / 2);
    } else {
      blk.coordinates_canvas = rectToPoints(rx, ry, rw, rh);
    }
    syncBounds(blk);
    resizeMode = false; resizingBid = null;
    canvasWrap.style.cursor = "default";
    $("btnAddBlock").style.display = "";
    $("btnCancelAdd").style.display = "none";
    setHint('Click "Add Block" to create one, or "Edit Layout" to change existing blocks.');
    draw(); updateStatus();
  }

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
      const ok = window.confirm(
        `Delete "${b.block_name}"?\n\n` +
        `This block contains ${b.total_graves} grave record(s). ` +
        `Deleting the block will also soft-delete all of its graves. ` +
        `Existing interment records that reference those graves will keep working, ` +
        `but the graves will no longer appear in any list.\n\n` +
        `Continue?`
      );
      if (!ok) return;
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

  // ── MODAL ────────────────────────────────────────────────
  function showModal() { $("modalOverlay").classList.add("open"); }
  function closeModal() {
    if (!$("modalOverlay")) return;
    $("modalOverlay").classList.remove("open");
    $("modalConfirm").style.display = "";
    $("modalCancel").textContent = "Cancel";
    $("modalCancel").onclick = closeModal;
    pendingNavHref = null;
  }

  // ── NAV GUARD ────────────────────────────────────────────
  function openUnsavedChangesModal(href) {
    pendingNavHref = href;
    $("modalTitle").textContent = "Unsaved changes";
    $("modalBody").innerHTML = `
      <p style="font-size:13px;color:#475569;margin-top:4px;line-height:1.5">
        You're still editing the layout. Save your changes before leaving this page, or they'll be lost.
      </p>
      <p class="modalNote" style="margin-top:14px">
        <a href="#" id="discardLeaveLink">Discard changes and leave anyway</a>
      </p>`;
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
      if (mapEditMode) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  // ── STATUS ───────────────────────────────────────────────
  function updateStatus() {
    let total = 0, occ = 0, res = 0;
    blockOrder.forEach((bid) => {
      const s = blockStats(blocks[bid]);
      total += s.total; occ += s.occ; res += s.res;
    });
    $("mapStatus").textContent =
      `${blockOrder.length} block(s) · Total: ${total} · Occupied: ${occ} · Reserved: ${res} · Available: ${total - occ - res}`;
  }

  // ── INIT ─────────────────────────────────────────────────
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

  return {
    enterEditMap, exitEditMap, openAddBlockModal, cancelResize,
    enterReshapeMode, exitReshapeMode, keepSplitSide, swapSplitSide,
    cancelSplit, undoReshape, activateResize,
    openBlockDetailsModal, openBlockEditModal, openBlockLayoutModal,
    deleteBlock, closeModal,
  };
})();