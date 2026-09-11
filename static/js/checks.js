/* checks.js — 五项校样检查：悬空端点 / 交叉缺节点 / 过窄玻璃 / 内凹角 / 扣除铅芯后尺寸不足
 * LG.checks.run(doc, facePieces) → issues[]
 * issue: {id, type, severity, msg, x, y, data}  (x,y 用于图上定位) */
(function (root) {
  const LG = (root.LG = root.LG || {});
  const g = () => LG.g;

  let seq = 0;

  function run(doc, facePieces) {
    const g = LG.g;
    const S = doc.settings;
    const issues = [];
    const nodeById = {};
    doc.nodes.forEach((n) => (nodeById[n.id] = n));

    // 1) 悬空端点：度数 ≤1 的节点（铅条端头没有落到框/条/其他铅条上）
    const deg = {};
    doc.edges.forEach((e) => {
      deg[e.a] = (deg[e.a] || 0) + 1;
      deg[e.b] = (deg[e.b] || 0) + 1;
    });
    doc.nodes.forEach((n) => {
      const d = deg[n.id] || 0;
      if (d === 0)
        issues.push({ id: "i" + seq++, type: "dangling", severity: "warn",
          msg: `孤立节点（未连接任何铅条）`, x: n.x, y: n.y, data: { nodeId: n.id } });
      else if (d === 1)
        issues.push({ id: "i" + seq++, type: "dangling", severity: "error",
          msg: `悬空端点：铅条端头未与任何边连接`, x: n.x, y: n.y, data: { nodeId: n.id } });
    });

    // 2) 交叉处缺少节点：两条边在非端点处相交；或边穿过非自身端点的节点
    const E = doc.edges;
    for (let i = 0; i < E.length; i++) {
      for (let j = i + 1; j < E.length; j++) {
        const e1 = E[i], e2 = E[j];
        if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
        const a = nodeById[e1.a], b = nodeById[e1.b], c = nodeById[e2.a], d = nodeById[e2.b];
        if (!a || !b || !c || !d) continue;
        const hit = g.segSegIntersect(a, b, c, d);
        if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6 && hit.u > 1e-6 && hit.u < 1 - 1e-6) {
          issues.push({ id: "i" + seq++, type: "crossing", severity: "error",
            msg: `交叉处缺少节点（可点击“修复”自动加节点拆分）`, x: hit.x, y: hit.y,
            data: { edgeA: e1.id, edgeB: e2.id, x: hit.x, y: hit.y } });
        }
      }
      // 边穿过非端点节点（铅条从节点上碾过却没接上）
      const e = E[i];
      const a = nodeById[e.a], b = nodeById[e.b];
      if (!a || !b) continue;
      doc.nodes.forEach((n) => {
        if (n.id === e.a || n.id === e.b) return;
        const r = g.pointSegDist(n.x, n.y, a.x, a.y, b.x, b.y);
        if (r.d < 0.05 && r.t > 1e-4 && r.t < 1 - 1e-4) {
          issues.push({ id: "i" + seq++, type: "crossing", severity: "error",
            msg: `铅条穿过节点但未连接（可点击“修复”在此拆分）`, x: n.x, y: n.y,
            data: { edgeA: e.id, edgeB: null, x: n.x, y: n.y } });
        }
      });
    }

    // 3~5) 逐玻璃片检查
    const dCut = S.heartWidth / 2 + S.grindAllowance / 2; // 中心线 → 裁切线的内缩量
    (facePieces || []).forEach((fp) => {
      const f = fp.face, label = fp.piece ? `片 ${fp.piece.num}` : "未命名片";

      // 3) 过窄玻璃
      const mw = g.minWidth(f.pts);
      if (mw.d < S.minGlassWidth)
        issues.push({ id: "i" + seq++, type: "narrow", severity: "warn",
          msg: `${label} 局部净宽 ${mw.d.toFixed(1)}mm < ${S.minGlassWidth}mm，玻璃过窄`,
          x: mw.x != null ? mw.x : f.cx, y: mw.y != null ? mw.y : f.cy,
          data: { pieceId: fp.piece && fp.piece.id } });

      // 4) 刀轮无法处理的内凹角
      g.reflexVertices(f.pts, S.reflexTol).forEach((r) =>
        issues.push({ id: "i" + seq++, type: "reflex", severity: "error",
          msg: `${label} 存在内凹角 ${r.deg.toFixed(0)}°，刀轮无法直接切割`,
          x: r.x, y: r.y, data: { pieceId: fp.piece && fp.piece.id } }));

      // 5) 扣除铅芯 + 研磨余量后尺寸不足
      const inset = g.insetPolygon(f.pts, dCut);
      if (!inset.ok) {
        issues.push({ id: "i" + seq++, type: "undersize", severity: "error",
          msg: `${label} 扣除铅芯与研磨余量后无有效裁切区域（片体过小）`,
          x: f.cx, y: f.cy, data: { pieceId: fp.piece && fp.piece.id } });
      } else {
        const mw2 = g.minWidth(inset.poly);
        if (mw2.d < S.minCutSize)
          issues.push({ id: "i" + seq++, type: "undersize", severity: "error",
            msg: `${label} 扣除铅芯后净尺寸 ${mw2.d.toFixed(1)}mm < ${S.minCutSize}mm`,
            x: mw2.x != null ? mw2.x : f.cx, y: mw2.y != null ? mw2.y : f.cy,
            data: { pieceId: fp.piece && fp.piece.id } });
      }
    });

    return issues;
  }

  LG.checks = { run };
})(typeof window !== "undefined" ? window : globalThis);
