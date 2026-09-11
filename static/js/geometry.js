/* geometry.js — 平面直线图 → 闭合玻璃片；几何判定。单位 mm，屏幕坐标系（y 向下）。
 * 浏览器与 node 通用：挂载到 LG.g */
(function (root) {
  const LG = (root.LG = root.LG || {});
  const EPS = 1e-9;

  // ---------- 基础 ----------
  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

  function pointSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    let t = L2 < EPS ? 0 : ((px - x1) * dx + (py - y1) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return { d: Math.hypot(px - cx, py - cy), t, cx, cy };
  }

  // 线段相交（共线/平行返回 null），返回 {x,y,t,u}
  function segSegIntersect(a, b, c, d) {
    const rx = b.x - a.x, ry = b.y - a.y;
    const sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < EPS) return null;
    const qx = c.x - a.x, qy = c.y - a.y;
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
    return { x: a.x + t * rx, y: a.y + t * ry, t, u };
  }

  function segSegDist(a, b, c, d) {
    if (segSegIntersect(a, b, c, d)) return 0;
    return Math.min(
      pointSegDist(a.x, a.y, c.x, c.y, d.x, d.y).d,
      pointSegDist(b.x, b.y, c.x, c.y, d.x, d.y).d,
      pointSegDist(c.x, c.y, a.x, a.y, b.x, b.y).d,
      pointSegDist(d.x, d.y, a.x, a.y, b.x, b.y).d
    );
  }

  // 有向面积：y 向下坐标系中 >0 表示视觉顺时针
  function polyArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  function polyCentroid(pts) {
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const w = a.x * b.y - b.x * a.y;
      A += w; cx += (a.x + b.x) * w; cy += (a.y + b.y) * w;
    }
    A /= 2;
    if (Math.abs(A) < EPS) {
      let mx = 0, my = 0;
      pts.forEach((p) => { mx += p.x; my += p.y; });
      return { x: mx / pts.length, y: my / pts.length, area: 0 };
    }
    return { x: cx / (6 * A), y: cy / (6 * A), area: A };
  }

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function polyBBox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach((p) => {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    });
    return { x0, y0, x1, y1 };
  }

  // ---------- 平面图形 → 面 ----------
  // 去掉 A→B→A 型“毛刺”（悬空边在面边界上往返）
  // 约定 edgeIds[k] 是从 poly[k] 指向 poly[k+1] 的边
  function cleanupSpurs(poly, edgeIds) {
    let changed = true;
    while (changed && poly.length >= 3) {
      changed = false;
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
        if (a.nodeId != null && a.nodeId === c.nodeId && b.nodeId !== a.nodeId) {
          // 旋转使 a 在首位：poly=[a,b,c,...]，删除 b,c 与边 e(a→b)、e(b→c)
          const rp = poly.slice(i).concat(poly.slice(0, i));
          rp.splice(1, 2);
          poly.length = 0; poly.push(...rp);
          if (edgeIds && edgeIds.length === n) {
            const re = edgeIds.slice(i).concat(edgeIds.slice(0, i));
            re.splice(0, 2);
            edgeIds.length = 0; edgeIds.push(...re);
          }
          changed = true;
          break;
        }
      }
    }
    return poly;
  }

  // 半边遍历提取所有面；返回 {pieces:[{pts,edgeIds,area,cx,cy}], outer}
  function extractFaces(nodes, edges) {
    const nodeById = {};
    nodes.forEach((n) => (nodeById[n.id] = n));
    const adj = {};
    nodes.forEach((n) => (adj[n.id] = []));
    edges.forEach((e) => {
      const a = nodeById[e.a], b = nodeById[e.b];
      if (!a || !b || e.a === e.b) return;
      adj[e.a].push({ edge: e, to: e.b, ang: Math.atan2(b.y - a.y, b.x - a.x) });
      adj[e.b].push({ edge: e, to: e.a, ang: Math.atan2(a.y - b.y, a.x - b.x) });
    });
    for (const id in adj) adj[id].sort((p, q) => p.ang - q.ang);

    const visited = new Set();
    const faces = [];
    edges.forEach((e) => {
      [[e.a, e.b], [e.b, e.a]].forEach(([start, other]) => {
        if (visited.has(e.id + "|" + start)) return;
        const poly = [], eids = [];
        let from = start, to = other, cur = e, guard = 0, closed = false;
        while (guard++ < 100000) {
          visited.add(cur.id + "|" + from);
          poly.push({ x: nodeById[from].x, y: nodeById[from].y, nodeId: from });
          eids.push(cur.id);
          const list = adj[to];
          const idx = list.findIndex((x) => x.edge.id === cur.id);
          if (idx < 0) break;
          const next = list[(idx - 1 + list.length) % list.length]; // 最顺时针 → 面在左侧
          from = to; to = next.to; cur = next.edge;
          if (from === start && to === other && cur.id === e.id) { closed = true; break; }
        }
        if (!closed) return;
        cleanupSpurs(poly, eids);
        if (poly.length >= 3) {
          const c = polyCentroid(poly);
          if (Math.abs(c.area) > 0.5)
            faces.push({ pts: poly, edgeIds: eids, area: c.area, cx: c.x, cy: c.y });
        }
      });
    });
    let outerIdx = -1, maxA = 0;
    faces.forEach((f, i) => {
      const a = Math.abs(f.area);
      if (a > maxA) { maxA = a; outerIdx = i; }
    });
    return {
      pieces: faces.filter((_, i) => i !== outerIdx),
      outer: outerIdx >= 0 ? faces[outerIdx] : null,
    };
  }

  // ---------- 面片身份匹配（节点移动后保留编号/颜色/纹理） ----------
  function matchPieces(faces, existing) {
    const pairs = [];
    faces.forEach((f, fi) =>
      (existing || []).forEach((p) => {
        if (p.cx != null && p.cy != null)
          pairs.push({ fi, p, d: Math.hypot(f.cx - p.cx, f.cy - p.cy) });
      })
    );
    pairs.sort((a, b) => a.d - b.d);
    const usedF = new Set(), usedP = new Set();
    const out = faces.map((face) => ({ face, piece: null }));
    pairs.forEach(({ fi, p, d }) => {
      if (d > 80 || usedF.has(fi) || usedP.has(p.id)) return;
      usedF.add(fi); usedP.add(p.id);
      out[fi].piece = p;
    });
    return out; // [{face, piece|null}]
  }

  // ---------- 最小净宽（顶点↔非邻边、边↔非邻边） ----------
  function minWidth(pts) {
    const n = pts.length;
    let best = Infinity, bx = null, by = null;
    const seg = (i) => ({ a: pts[i], b: pts[(i + 1) % n] });
    function consider(d, x, y) { if (d < best) { best = d; bx = x; by = y; } }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (j === i || j === (i - 1 + n) % n) continue; // 跳过与顶点相邻的边
        const s = seg(j);
        const r = pointSegDist(pts[i].x, pts[i].y, s.a.x, s.a.y, s.b.x, s.b.y);
        consider(r.d, (pts[i].x + r.cx) / 2, (pts[i].y + r.cy) / 2);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const s1 = seg(i), s2 = seg(j);
        const hit = segSegIntersect(s1.a, s1.b, s2.a, s2.b);
        if (hit) { consider(0, hit.x, hit.y); continue; }
        const cands = [
          [pointSegDist(s1.a.x, s1.a.y, s2.a.x, s2.a.y, s2.b.x, s2.b.y), s1.a],
          [pointSegDist(s1.b.x, s1.b.y, s2.a.x, s2.a.y, s2.b.x, s2.b.y), s1.b],
          [pointSegDist(s2.a.x, s2.a.y, s1.a.x, s1.a.y, s1.b.x, s1.b.y), s2.a],
          [pointSegDist(s2.b.x, s2.b.y, s1.a.x, s1.a.y, s1.b.x, s1.b.y), s2.b],
        ];
        cands.forEach(([r, p]) => consider(r.d, (p.x + r.cx) / 2, (p.y + r.cy) / 2));
      }
    }
    return { d: best, x: bx, y: by };
  }

  // ---------- 内凹角（刀轮无法处理） ----------
  // 用行进方向转向角计算内角，顺/逆时针轮廓均正确
  function reflexVertices(pts, tolDeg) {
    const cw = polyArea(pts) > 0; // y 向下
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      const d1x = p1.x - p0.x, d1y = p1.y - p0.y;
      const d2x = p2.x - p1.x, d2y = p2.y - p1.y;
      const turn = Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y);
      let interior = cw ? Math.PI - turn : Math.PI + turn;
      if (interior <= 0) interior += 2 * Math.PI;
      if (interior > 2 * Math.PI) interior -= 2 * Math.PI;
      const deg = (interior * 180) / Math.PI;
      if (deg > 180 + (tolDeg || 0)) out.push({ index: i, x: p1.x, y: p1.y, deg });
    }
    return out;
  }

  // ---------- 内缩多边形（扣除铅芯 + 研磨余量后的裁切轮廓） ----------
  function insetPolygon(pts, d) {
    const area = polyArea(pts);
    const cw = area > 0;
    const n = pts.length;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      let dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      if (L < EPS) return { ok: false, poly: [] };
      dx /= L; dy /= L;
      // 指向内侧：y 向下坐标系，面积>0（视觉顺时针）时内侧在行进方向左手侧 (-dy,dx)，
      // 逆时针时内侧在右手侧 (dy,-dx)
      const nx = cw ? -dy : dy, ny = cw ? dx : -dx;
      lines.push({ nx, ny, c: nx * (a.x + nx * d) + ny * (a.y + ny * d) });
    }
    const poly = [];
    for (let i = 0; i < n; i++) {
      const l1 = lines[(i - 1 + n) % n], l2 = lines[i];
      const den = l1.nx * l2.ny - l1.ny * l2.nx;
      if (Math.abs(den) < 1e-6) {
        poly.push({ x: pts[i].x + l2.nx * d, y: pts[i].y + l2.ny * d });
      } else {
        poly.push({
          x: (l1.c * l2.ny - l2.c * l1.ny) / den,
          y: (l1.nx * l2.c - l2.nx * l1.c) / den,
        });
      }
    }
    const a2 = polyArea(poly);
    const ok = a2 * area > 0 && poly.every((p) => pointInPoly(p, pts));
    return { ok, poly, area: a2 };
  }

  LG.g = {
    EPS, dist, pointSegDist, segSegIntersect, segSegDist,
    polyArea, polyCentroid, pointInPoly, polyBBox,
    extractFaces, matchPieces, minWidth, reflexVertices, insetPolygon,
  };
})(typeof window !== "undefined" ? window : globalThis);
