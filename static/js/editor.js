/* editor.js — SVG 画布：外框/支撑条/铅条中心线绘制、吸附、拆分、节点拖动、缩放平移 */
(function (root) {
  const LG = (root.LG = root.LG || {});
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  let svg, vp, layers;
  let drag = null;        // 节点拖动 {nodeId, moved}
  let panDrag = null;     // 平移 {sx, sy, tx, ty}
  let frameDrag = null;   // 画外框 {x0, y0}
  let barDrag = null;     // 画支撑条 {x0, y0, shift}
  let leadDraft = null;   // 铅条折线 {pts:[{x,y}], cursor:{x,y}}
  let spaceDown = false;
  let flashTimer = null;

  const st = () => LG.state;
  const doc = () => LG.state.doc;

  // ---------- 坐标 ----------
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    const v = st().view;
    return { x: (ev.clientX - r.left - v.tx) / v.s, y: (ev.clientY - r.top - v.ty) / v.s };
  }
  function applyView() {
    const v = st().view;
    vp.setAttribute("transform", `translate(${v.tx},${v.ty}) scale(${v.s})`);
  }

  // ---------- 吸附 ----------
  function snap(x, y, opts) {
    opts = opts || {};
    const v = st().view;
    const tol = 8 / v.s;
    const d = doc();
    let best = null;
    // 节点
    for (const n of d.nodes) {
      if (opts.excludeNode && n.id === opts.excludeNode) continue;
      const dd = Math.hypot(n.x - x, n.y - y);
      if (dd < tol && (!best || dd < best.d)) best = { kind: "node", id: n.id, x: n.x, y: n.y, d: dd };
    }
    if (best) return best;
    // 边（铅条/外框）
    const nodeById = {};
    d.nodes.forEach((n) => (nodeById[n.id] = n));
    for (const e of d.edges) {
      if (opts.excludeEdges && opts.excludeEdges.has(e.id)) continue;
      const a = nodeById[e.a], b = nodeById[e.b];
      if (!a || !b) continue;
      const r = LG.g.pointSegDist(x, y, a.x, a.y, b.x, b.y);
      if (r.d < tol && r.t > 0.001 && r.t < 0.999 && (!best || r.d < best.d))
        best = { kind: "edge", id: e.id, x: r.cx, y: r.cy, t: r.t, d: r.d };
    }
    if (best) return best;
    // 支撑条
    for (const b of d.bars) {
      const r = LG.g.pointSegDist(x, y, b.x1, b.y1, b.x2, b.y2);
      if (r.d < tol && (!best || r.d < best.d))
        best = { kind: "bar", id: b.id, x: r.cx, y: r.cy, d: r.d };
    }
    if (best) return best;
    // 1mm 网格兜底
    return { kind: "grid", x: Math.round(x), y: Math.round(y), d: 0 };
  }

  // ---------- 图元操作 ----------
  let uidC = 1;
  function uid(p) { return p + Date.now().toString(36) + (uidC++).toString(36); }

  function addNode(x, y) {
    const n = { id: uid("n"), x, y };
    doc().nodes.push(n);
    return n;
  }

  function splitEdge(edgeId, x, y) {
    const d = doc();
    const e = d.edges.find((z) => z.id === edgeId);
    if (!e) return null;
    const nodeById = {};
    d.nodes.forEach((n) => (nodeById[n.id] = n));
    const a = nodeById[e.a], b = nodeById[e.b];
    const r = LG.g.pointSegDist(x, y, a.x, a.y, b.x, b.y);
    if (r.t < 0.02) return e.a;
    if (r.t > 0.98) return e.b;
    const n = addNode(r.cx, r.cy);
    const kind = e.kind;
    d.edges.splice(d.edges.indexOf(e), 1);
    d.edges.push({ id: uid("e"), a: e.a, b: n.id, kind });
    d.edges.push({ id: uid("e"), a: n.id, b: e.b, kind });
    return n.id;
  }

  function mergeNodes(keepId, dropId) {
    if (keepId === dropId) return;
    const d = doc();
    d.edges.forEach((e) => {
      if (e.a === dropId) e.a = keepId;
      if (e.b === dropId) e.b = keepId;
    });
    // 去掉自环与重复边
    const seen = new Set();
    d.edges = d.edges.filter((e) => {
      if (e.a === e.b) return false;
      const k = [e.a, e.b].sort().join("|");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    d.nodes = d.nodes.filter((n) => n.id !== dropId);
  }

  function addEdge(a, b, kind) {
    if (a === b) return null;
    const d = doc();
    const dup = d.edges.find(
      (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a)
    );
    if (dup) return dup.id;
    const e = { id: uid("e"), a, b, kind: kind || "lead" };
    d.edges.push(e);
    return e.id;
  }

  // 把一个吸附结果解析成节点 id（边上则拆分）
  function resolveSnap(sn) {
    if (sn.kind === "node") return sn.id;
    if (sn.kind === "edge") return splitEdge(sn.id, sn.x, sn.y);
    return addNode(sn.x, sn.y).id;
  }

  function setFrame(x, y, w, h) {
    const d = doc();
    d.frame = { x, y, w, h };
    const tl = addNode(x, y), tr = addNode(x + w, y);
    const br = addNode(x + w, y + h), bl = addNode(x, y + h);
    d.frameNodeIds = [tl.id, tr.id, br.id, bl.id];
    d.edges.push(
      { id: uid("e"), a: tl.id, b: tr.id, kind: "frame" },
      { id: uid("e"), a: tr.id, b: br.id, kind: "frame" },
      { id: uid("e"), a: br.id, b: bl.id, kind: "frame" },
      { id: uid("e"), a: bl.id, b: tl.id, kind: "frame" }
    );
  }

  function deleteSelection() {
    const d = doc(), sel = st().selection;
    if (!sel) return;
    if (sel.kind === "node") {
      const n = d.nodes.find((z) => z.id === sel.id);
      if (!n) return;
      const isFrameNode = d.edges.some(
        (e) => e.kind === "frame" && (e.a === sel.id || e.b === sel.id)
      );
      if (isFrameNode) return LG.app.toast("外框节点不可删除（可在设置中调整外框尺寸）");
      d.edges = d.edges.filter((e) => e.a !== sel.id && e.b !== sel.id);
      d.nodes = d.nodes.filter((z) => z.id !== sel.id);
    } else if (sel.kind === "edge") {
      const e = d.edges.find((z) => z.id === sel.id);
      if (!e) return;
      if (e.kind === "frame") return LG.app.toast("外框边不可删除");
      d.edges = d.edges.filter((z) => z.id !== sel.id);
    } else if (sel.kind === "bar") {
      d.bars = d.bars.filter((z) => z.id !== sel.id);
    }
    st().selection = null;
    LG.app.onGeomChanged();
  }

  // ---------- 渲染 ----------
  function render() {
    const d = doc(), v = st().view;
    if (!svg) return;
    applyView();
    ["grid", "pieces", "bars", "edges", "nodes", "overlay"].forEach((k) => {
      layers[k].textContent = "";
    });
    renderGrid();
    renderPieces();
    renderBars();
    renderEdges();
    renderNodes();
    renderOverlay();
  }

  function renderGrid() {
    const d = doc(), v = st().view;
    const r = svg.getBoundingClientRect();
    const x0 = -v.tx / v.s, y0 = -v.ty / v.s;
    const x1 = x0 + r.width / v.s, y1 = y0 + r.height / v.s;
    const step = 10;
    const g = layers.grid;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step)
      el("line", { x1: x, y1: y0, x2: x, y2: y1, class: x % 100 === 0 ? "grid100" : "grid10" }, g);
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step)
      el("line", { x1: x0, y1: y, x2: x1, y2: y, class: y % 100 === 0 ? "grid100" : "grid10" }, g);
    if (d.frame) {
      el("rect", {
        x: d.frame.x, y: d.frame.y, width: d.frame.w, height: d.frame.h,
        class: "panel-bg",
      }, g);
    }
  }

  function renderPieces() {
    const g = layers.pieces, v = st().view;
    (st().facePieces || []).forEach((fp) => {
      if (!fp.piece) return;
      const pts = fp.face.pts.map((p) => `${p.x},${p.y}`).join(" ");
      const sel = st().selection;
      const poly = el("polygon", {
        points: pts,
        class: "piece" + (sel && sel.kind === "piece" && sel.id === fp.piece.id ? " sel" : ""),
        style: `fill:${fp.piece.color}`,
      }, g);
      poly.addEventListener("pointerdown", (ev) => {
        if (st().tool === "piece" || st().tool === "select") {
          ev.stopPropagation();
          st().selection = { kind: "piece", id: fp.piece.id };
          LG.app.onSelectionChanged();
        }
      });
      // 片号
      el("text", { x: fp.face.cx, y: fp.face.cy, class: "piece-num", "font-size": 12 / v.s }, g)
        .textContent = fp.piece.num;
      // 纹理方向
      const a = ((fp.piece.grain || 0) * Math.PI) / 180;
      const L = 7 / v.s + 4;
      const dx = Math.cos(a) * L, dy = Math.sin(a) * L;
      el("line", {
        x1: fp.face.cx - dx, y1: fp.face.cy - dy,
        x2: fp.face.cx + dx, y2: fp.face.cy + dy, class: "piece-grain",
      }, g);
    });
  }

  function renderBars() {
    const g = layers.bars;
    const sel = st().selection;
    doc().bars.forEach((b) => {
      const hit = el("line", { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, class: "hit" }, g);
      hit.addEventListener("pointerdown", (ev) => {
        if (st().tool !== "select") return;
        ev.stopPropagation();
        st().selection = { kind: "bar", id: b.id };
        LG.app.onSelectionChanged();
      });
      el("line", {
        x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
        class: "bar" + (sel && sel.kind === "bar" && sel.id === b.id ? " sel" : ""),
      }, g);
    });
  }

  function renderEdges() {
    const g = layers.edges;
    const d = doc(), v = st().view;
    const nodeById = {};
    d.nodes.forEach((n) => (nodeById[n.id] = n));
    const sel = st().selection;
    const faceW = d.settings.leadFaceWidth;
    d.edges.forEach((e) => {
      const a = nodeById[e.a], b = nodeById[e.b];
      if (!a || !b) return;
      const hit = el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "hit" }, g);
      hit.addEventListener("pointerdown", (ev) => {
        if (st().tool === "select") {
          ev.stopPropagation();
          st().selection = { kind: "edge", id: e.id };
          LG.app.onSelectionChanged();
        } else if (st().tool === "split") {
          ev.stopPropagation();
          const p = toWorld(ev);
          splitEdge(e.id, p.x, p.y);
          LG.app.onGeomChanged();
        }
      });
      hit.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        const p = toWorld(ev);
        splitEdge(e.id, p.x, p.y);
        LG.app.onGeomChanged();
      });
      const cls = e.kind === "frame" ? "edge-frame" : "edge-lead";
      const isSel = sel && sel.kind === "edge" && sel.id === e.id;
      // 面宽带（按实际面宽）
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "edge-band " + cls + (isSel ? " sel" : ""), "stroke-width": faceW }, g);
      // 中心线
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "edge-core " + cls + (isSel ? " sel" : "") }, g);
    });
  }

  function renderNodes() {
    const g = layers.nodes, v = st().view;
    const sel = st().selection;
    const deg = {};
    doc().edges.forEach((e) => {
      deg[e.a] = (deg[e.a] || 0) + 1;
      deg[e.b] = (deg[e.b] || 0) + 1;
    });
    doc().nodes.forEach((n) => {
      const isSel = sel && sel.kind === "node" && sel.id === n.id;
      const c = el("circle", {
        cx: n.x, cy: n.y, r: (deg[n.id] === 1 ? 5 : 4) / v.s,
        class: "node" + (isSel ? " sel" : "") + (deg[n.id] === 1 ? " dangling" : ""),
      }, g);
      c.addEventListener("pointerdown", (ev) => {
        if (st().tool !== "select") return;
        ev.stopPropagation();
        st().selection = { kind: "node", id: n.id };
        LG.app.onSelectionChanged();
        drag = { nodeId: n.id, moved: false };
        svg.setPointerCapture(ev.pointerId);
      });
    });
  }

  function renderOverlay() {
    const g = layers.overlay, v = st().view;
    // 铅条草稿
    if (leadDraft) {
      const pts = leadDraft.pts.concat(leadDraft.cursor ? [leadDraft.cursor] : []);
      if (pts.length >= 2)
        el("polyline", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), class: "draft" }, g);
      pts.forEach((p) => el("circle", { cx: p.x, cy: p.y, r: 3 / v.s, class: "draft-pt" }, g));
    }
    if (frameDrag) {
      const x = Math.min(frameDrag.x0, frameDrag.x1), y = Math.min(frameDrag.y0, frameDrag.y1);
      el("rect", {
        x, y, width: Math.abs(frameDrag.x1 - frameDrag.x0), height: Math.abs(frameDrag.y1 - frameDrag.y0),
        class: "draft-rect",
      }, g);
    }
    if (barDrag) {
      el("line", { x1: barDrag.x0, y1: barDrag.y0, x2: barDrag.x1, y2: barDrag.y1, class: "draft" }, g);
    }
    // 吸附指示
    if (st().snapInd)
      el("circle", { cx: st().snapInd.x, cy: st().snapInd.y, r: 6 / v.s, class: "snap-ind" }, g);
    // 问题标记
    (st().issues || []).forEach((iss) => {
      const c = el("circle", { cx: iss.x, cy: iss.y, r: 7 / v.s, class: "issue " + iss.severity }, g);
      const t = el("text", { x: iss.x, y: iss.y + 3 / v.s, class: "issue-t", "font-size": 9 / v.s }, g);
      t.textContent = "!";
      c.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        LG.app.selectIssue(iss.id);
      });
    });
    // 定位闪烁
    if (st().flashAt) {
      el("circle", { cx: st().flashAt.x, cy: st().flashAt.y, r: 14 / v.s, class: "flash" }, g);
    }
    // 次序高亮
    (st().stepHighlight || []).forEach((h) => {
      if (h.type === "lead") {
        const e = doc().edges.find((z) => z.id === h.ref);
        if (!e) return;
        const na = doc().nodes.find((n) => n.id === e.a), nb = doc().nodes.find((n) => n.id === e.b);
        if (na && nb) el("line", { x1: na.x, y1: na.y, x2: nb.x, y2: nb.y, class: "step-hl" }, g);
      } else if (h.type === "piece") {
        const fp = (st().facePieces || []).find((x) => x.piece && x.piece.id === h.ref);
        if (fp) el("polygon", { points: fp.face.pts.map((p) => `${p.x},${p.y}`).join(" "), class: "step-hl-poly" }, g);
      } else if (h.type === "solder") {
        const n = doc().nodes.find((z) => z.id === h.ref);
        if (n) el("circle", { cx: n.x, cy: n.y, r: 8 / v.s, class: "step-hl-node" }, g);
      }
    });
  }

  // ---------- 鼠标交互 ----------
  function onPointerDown(ev) {
    const p = toWorld(ev);
    const tool = st().tool;
    if (ev.button === 1 || spaceDown || tool === "pan") {
      panDrag = { sx: ev.clientX, sy: ev.clientY, tx: st().view.tx, ty: st().view.ty };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    if (ev.button !== 0) return;
    if (tool === "frame") {
      if (doc().frame) return LG.app.toast("外框已存在，可在“设置”中调整尺寸");
      frameDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      svg.setPointerCapture(ev.pointerId);
    } else if (tool === "bar") {
      barDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      svg.setPointerCapture(ev.pointerId);
    } else if (tool === "lead") {
      const sn = snap(p.x, p.y);
      if (!leadDraft) leadDraft = { pts: [], cursor: null };
      leadDraft.pts.push({ x: sn.x, y: sn.y, snap: sn });
      render();
    } else if (tool === "split") {
      const sn = snap(p.x, p.y);
      if (sn.kind === "edge") {
        splitEdge(sn.id, sn.x, sn.y);
        LG.app.onGeomChanged();
      } else LG.app.toast("请点击一条铅条或外框边进行拆分");
    } else if (tool === "select") {
      // 空白处：取消选择
      st().selection = null;
      LG.app.onSelectionChanged();
    }
  }

  function onPointerMove(ev) {
    const p = toWorld(ev);
    if (panDrag) {
      st().view.tx = panDrag.tx + (ev.clientX - panDrag.sx);
      st().view.ty = panDrag.ty + (ev.clientY - panDrag.sy);
      render();
      return;
    }
    if (drag) {
      const n = doc().nodes.find((z) => z.id === drag.nodeId);
      if (!n) { drag = null; return; }
      const incident = new Set(
        doc().edges.filter((e) => e.a === n.id || e.b === n.id).map((e) => e.id)
      );
      const sn = snap(p.x, p.y, { excludeNode: n.id, excludeEdges: incident });
      n.x = sn.x; n.y = sn.y;
      drag.moved = true;
      drag.snap = sn;
      st().snapInd = sn.kind !== "grid" ? sn : null;
      LG.app.onGeomChanged({ drag: true });
      return;
    }
    if (frameDrag) {
      frameDrag.x1 = p.x; frameDrag.y1 = p.y;
      render();
      return;
    }
    if (barDrag) {
      let x1 = p.x, y1 = p.y;
      if (ev.shiftKey) {
        if (Math.abs(x1 - barDrag.x0) > Math.abs(y1 - barDrag.y0)) y1 = barDrag.y0;
        else x1 = barDrag.x0;
      }
      const sn = snap(x1, y1);
      barDrag.x1 = sn.x; barDrag.y1 = sn.y;
      st().snapInd = sn.kind !== "grid" ? sn : null;
      render();
      return;
    }
    if (st().tool === "lead") {
      const sn = snap(p.x, p.y);
      if (leadDraft) leadDraft.cursor = { x: sn.x, y: sn.y };
      st().snapInd = sn.kind !== "grid" ? sn : null;
      render();
      return;
    }
    st().snapInd = null;
  }

  function onPointerUp(ev) {
    if (panDrag) { panDrag = null; return; }
    if (drag) {
      const sn = drag.snap;
      const nid = drag.nodeId;
      drag = null;
      st().snapInd = null;
      if (sn && sn.kind === "node") mergeNodes(sn.id, nid);
      else if (sn && sn.kind === "edge") {
        const newId = splitEdge(sn.id, sn.x, sn.y);
        if (newId && newId !== nid) mergeNodes(newId, nid);
      }
      LG.app.onGeomChanged();
      return;
    }
    if (frameDrag) {
      const { x0, y0, x1, y1 } = frameDrag;
      frameDrag = null;
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (w > 20 && h > 20) {
        setFrame(Math.min(x0, x1), Math.min(y0, y1), w, h);
        LG.app.onGeomChanged();
        LG.app.fitView();
      } else LG.app.toast("外框太小，已取消");
      return;
    }
    if (barDrag) {
      const { x0, y0, x1, y1 } = barDrag;
      barDrag = null;
      st().snapInd = null;
      if (Math.hypot(x1 - x0, y1 - y0) > 5) {
        doc().bars.push({ id: uid("b"), x1: x0, y1: y0, x2: x1, y2: y1 });
        LG.app.onGeomChanged();
      }
      render();
      return;
    }
  }

  function finishLead() {
    if (!leadDraft) return;
    const pts = leadDraft.pts;
    leadDraft = null;
    if (pts.length >= 2) {
      let prev = resolveSnap(pts[0].snap);
      for (let i = 1; i < pts.length; i++) {
        const cur = resolveSnap(pts[i].snap);
        addEdge(prev, cur, "lead");
        prev = cur;
      }
      LG.app.onGeomChanged();
    } else render();
  }

  function cancelDraft() {
    if (leadDraft) { leadDraft = null; render(); return true; }
    return false;
  }

  function onDblClick(ev) {
    if (st().tool === "lead") { ev.preventDefault(); finishLead(); }
  }

  function onWheel(ev) {
    ev.preventDefault();
    const v = st().view;
    const r = svg.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const s2 = Math.max(0.2, Math.min(40, v.s * k));
    v.tx = mx - ((mx - v.tx) * s2) / v.s;
    v.ty = my - ((my - v.ty) * s2) / v.s;
    v.s = s2;
    render();
  }

  function onKeyDown(ev) {
    if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
    if (ev.code === "Space") { spaceDown = true; ev.preventDefault(); return; }
    if (ev.key === "Escape") { if (!cancelDraft()) { st().selection = null; LG.app.onSelectionChanged(); } }
    if (ev.key === "Enter") finishLead();
    if (ev.key === "Delete" || ev.key === "Backspace") deleteSelection();
    const map = { v: "select", l: "lead", b: "bar", s: "split", p: "piece", f: "frame" };
    if (map[ev.key]) LG.app.setTool(map[ev.key]);
  }
  function onKeyUp(ev) {
    if (ev.code === "Space") spaceDown = false;
  }

  // ---------- 视图 ----------
  function fitView() {
    const d = doc();
    const r = svg.getBoundingClientRect();
    let bb;
    if (d.frame) bb = { x0: d.frame.x, y0: d.frame.y, x1: d.frame.x + d.frame.w, y1: d.frame.y + d.frame.h };
    else if (d.nodes.length) {
      const b = LG.g.polyBBox(d.nodes);
      bb = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    } else {
      st().view = { s: 3, tx: r.width / 2, ty: r.height / 2 };
      render();
      return;
    }
    const pad = 40;
    const w = Math.max(1, bb.x1 - bb.x0), h = Math.max(1, bb.y1 - bb.y0);
    const s = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h);
    st().view.s = Math.max(0.2, s);
    st().view.tx = (r.width - w * st().view.s) / 2 - bb.x0 * st().view.s;
    st().view.ty = (r.height - h * st().view.s) / 2 - bb.y0 * st().view.s;
    render();
  }

  function locate(x, y) {
    const r = svg.getBoundingClientRect();
    const v = st().view;
    if (v.s < 2) v.s = 2;
    v.tx = r.width / 2 - x * v.s;
    v.ty = r.height / 2 - y * v.s;
    st().flashAt = { x, y };
    render();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { st().flashAt = null; render(); }, 2200);
  }

  LG.editor = {
    init(svgEl) {
      svg = svgEl;
      vp = el("g", {}, svg);
      layers = {};
      ["grid", "pieces", "bars", "edges", "nodes", "overlay"].forEach((k) => {
        layers[k] = el("g", { id: "layer-" + k }, vp);
      });
      svg.addEventListener("pointerdown", onPointerDown);
      svg.addEventListener("pointermove", onPointerMove);
      svg.addEventListener("pointerup", onPointerUp);
      svg.addEventListener("dblclick", onDblClick);
      svg.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("resize", () => render());
    },
    render, fitView, locate, finishLead, cancelDraft,
    splitEdge, mergeNodes, addNode, addEdge, setFrame, uid,
    get leadDraft() { return leadDraft; },
  };
})(window);
