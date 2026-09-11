/* sequence.js — 放铅 / 嵌片 / 焊点次序的自动生成与手动换序校验
 * LG.seq.generate(doc, facePieces, startCorner) → steps[]
 * LG.seq.validate(doc, facePieces, steps) → violations[]
 * step: {type:'lead'|'piece'|'solder', ref: edgeId|pieceId|nodeId} */
(function (root) {
  const LG = (root.LG = root.LG || {});

  function cornerPoint(doc, corner) {
    const f = doc.frame || { x: 0, y: 0, w: 100, h: 100 };
    return {
      tl: { x: f.x, y: f.y },
      tr: { x: f.x + f.w, y: f.y },
      br: { x: f.x + f.w, y: f.y + f.h },
      bl: { x: f.x, y: f.y + f.h },
    }[corner || "tl"];
  }

  function edgeMid(doc, edgeId) {
    const e = doc.edges.find((x) => x.id === edgeId);
    if (!e) return null;
    const a = doc.nodes.find((n) => n.id === e.a);
    const b = doc.nodes.find((n) => n.id === e.b);
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, edge: e };
  }

  // 片邻接：共享边的两片互为邻居
  function buildAdjacency(facePieces) {
    const edgeFaces = {};
    facePieces.forEach((fp, i) => {
      new Set(fp.face.edgeIds).forEach((id) => {
        (edgeFaces[id] = edgeFaces[id] || []).push(i);
      });
    });
    const adj = facePieces.map(() => []);
    Object.entries(edgeFaces).forEach(([eid, idxs]) => {
      if (idxs.length === 2) {
        adj[idxs[0]].push({ other: idxs[1], edgeId: eid });
        adj[idxs[1]].push({ other: idxs[0], edgeId: eid });
      }
    });
    return adj;
  }

  // BFS 次序：从离所选边角最近的片开始
  function pieceOrder(doc, facePieces, corner) {
    const c = cornerPoint(doc, corner);
    const adj = buildAdjacency(facePieces);
    const n = facePieces.length;
    const orderIdx = new Array(n).fill(-1);
    const order = [];
    // 可能不连通（多个分离区域），逐连通分量处理
    for (let s = 0; s < n; s++) {
      if (orderIdx[s] >= 0) continue;
      // 在未排序片中找离角最近的作为种子
      let seed = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (orderIdx[i] >= 0) continue;
        const d = Math.hypot(facePieces[i].face.cx - c.x, facePieces[i].face.cy - c.y);
        if (d < best) { best = d; seed = i; }
      }
      const q = [seed];
      orderIdx[seed] = order.length;
      order.push(seed);
      while (q.length) {
        const cur = q.shift();
        // 邻居按离角距离排序，保证稳定推进
        const ns = adj[cur]
          .filter((x) => orderIdx[x.other] < 0)
          .sort((a, b) => {
            const da = Math.hypot(facePieces[a.other].face.cx - c.x, facePieces[a.other].face.cy - c.y);
            const db = Math.hypot(facePieces[b.other].face.cx - c.x, facePieces[b.other].face.cy - c.y);
            return da - db;
          });
        ns.forEach((x) => {
          if (orderIdx[x.other] < 0) {
            orderIdx[x.other] = order.length;
            order.push(x.other);
            q.push(x.other);
          }
        });
      }
    }
    return { order, orderIdx, adj };
  }

  /* 自动生成：每片处理时留下一根“出口铅条”不装（留给后续片或收尾阶段），
   * 保证嵌片时总有一个敞开的边可以滑入玻璃；收尾阶段再装剩余铅条；
   * 节点上所有铅条就位后立即排焊点。 */
  function generate(doc, facePieces, corner) {
    const g = LG.g;
    const c = cornerPoint(doc, corner);
    const { order, orderIdx, adj } = pieceOrder(doc, facePieces, corner);
    const steps = [];
    const placed = new Set();
    const soldered = new Set();

    const nodeById = {};
    doc.nodes.forEach((n) => (nodeById[n.id] = n));
    const nodeEdges = {};
    doc.edges.forEach((e) => {
      (nodeEdges[e.a] = nodeEdges[e.a] || []).push(e.id);
      (nodeEdges[e.b] = nodeEdges[e.b] || []).push(e.id);
    });

    function trySolder(nodeIds) {
      nodeIds.forEach((nid) => {
        if (soldered.has(nid)) return;
        const all = (nodeEdges[nid] || []).every((eid) => placed.has(eid));
        if (all && (nodeEdges[nid] || []).length >= 2) {
          soldered.add(nid);
          steps.push({ type: "solder", ref: nid });
        }
      });
    }

    function placeLead(eid) {
      if (placed.has(eid)) return;
      placed.add(eid);
      steps.push({ type: "lead", ref: eid });
      const e = doc.edges.find((x) => x.id === eid);
      if (e) trySolder([e.a, e.b]);
    }

    order.forEach((fi, i) => {
      const fp = facePieces[fi];
      const boundary = [...new Set(fp.face.edgeIds)];
      const unplaced = boundary.filter((e) => !placed.has(e));
      // 出口铅条：与 BFS 次序更晚的邻片共享的边优先；否则取离角最远的未装边
      let exit = null;
      const later = adj[fi]
        .filter((x) => orderIdx[x.other] > i && !placed.has(x.edgeId))
        .sort((a, b) => orderIdx[b.other] - orderIdx[a.other]);
      if (later.length) exit = later[0].edgeId;
      else if (unplaced.length) {
        exit = unplaced
          .slice()
          .sort((p, q) => {
            const mp = edgeMid(doc, p), mq = edgeMid(doc, q);
            const dp = mp ? Math.hypot(mp.x - c.x, mp.y - c.y) : 0;
            const dq = mq ? Math.hypot(mq.x - c.x, mq.y - c.y) : 0;
            return dq - dp;
          })[0];
      }
      unplaced
        .filter((e) => e !== exit)
        .sort((p, q) => {
          const mp = edgeMid(doc, p), mq = edgeMid(doc, q);
          const dp = mp ? Math.hypot(mp.x - c.x, mp.y - c.y) : 0;
          const dq = mq ? Math.hypot(mq.x - c.x, mq.y - c.y) : 0;
          return dp - dq;
        })
        .forEach(placeLead);
      steps.push({ type: "piece", ref: fp.piece.id });
      // 嵌片后再检查该片边界节点是否可焊
      trySolder(boundary.flatMap((eid) => {
        const e = doc.edges.find((x) => x.id === eid);
        return e ? [e.a, e.b] : [];
      }));
    });

    // 收尾：剩余未装铅条（各片的出口边），按离角距离排序
    doc.edges
      .filter((e) => !placed.has(e.id))
      .sort((p, q) => {
        const mp = edgeMid(doc, p.id), mq = edgeMid(doc, q.id);
        const dp = mp ? Math.hypot(mp.x - c.x, mp.y - c.y) : 0;
        const dq = mq ? Math.hypot(mq.x - c.x, mq.y - c.y) : 0;
        return dp - dq;
      })
      .forEach((e) => placeLead(e.id));

    return steps;
  }

  /* 校验手动次序：
   * - sealed：某根铅条装好后，某片未装玻璃的所有边界铅条都已就位 → 玻璃被封死
   * - noSupport：嵌片时该片四周没有任何已装铅条可依托
   * - earlySolder：焊点排在它涉及的铅条装好之前
   * - missing：当前铅条/玻璃片在次序中缺少对应步骤 */
  function validate(doc, facePieces, steps) {
    const placed = new Set();
    const inserted = new Set();
    const violations = [];
    const boundaryOf = {};
    facePieces.forEach((fp) => {
      if (fp.piece) boundaryOf[fp.piece.id] = [...new Set(fp.face.edgeIds)];
    });
    const pieceNum = (pid) => {
      const fp = facePieces.find((x) => x.piece && x.piece.id === pid);
      return fp && fp.piece ? fp.piece.num : "?";
    };
    const nodeEdges = {};
    doc.edges.forEach((e) => {
      (nodeEdges[e.a] = nodeEdges[e.a] || []).push(e.id);
      (nodeEdges[e.b] = nodeEdges[e.b] || []).push(e.id);
    });

    const coveredLead = new Set(), coveredPiece = new Set();
    steps.forEach((st, idx) => {
      if (st.type === "lead") {
        coveredLead.add(st.ref);
        placed.add(st.ref);
        Object.entries(boundaryOf).forEach(([pid, edges]) => {
          if (inserted.has(pid)) return;
          if (edges.length && edges.every((e) => placed.has(e))) {
            violations.push({
              type: "sealed", stepIndex: idx, pieceId: pid, edgeId: st.ref,
              msg: `第 ${idx + 1} 步装上的铅条会把待装的片 ${pieceNum(pid)} 四周封死`,
            });
          }
        });
      } else if (st.type === "piece") {
        coveredPiece.add(st.ref);
        const edges = boundaryOf[st.ref] || [];
        if (!edges.some((e) => placed.has(e))) {
          violations.push({
            type: "noSupport", stepIndex: idx, pieceId: st.ref,
            msg: `第 ${idx + 1} 步嵌片 ${pieceNum(st.ref)} 时，四周没有已装铅条可依托`,
          });
        }
        inserted.add(st.ref);
      } else if (st.type === "solder") {
        const need = nodeEdges[st.ref] || [];
        const missing = need.filter((e) => !placed.has(e));
        if (missing.length) {
          violations.push({
            type: "earlySolder", stepIndex: idx, nodeId: st.ref,
            msg: `第 ${idx + 1} 步焊点早于其 ${missing.length} 根相连铅条`,
          });
        }
      }
    });

    // 覆盖检查：次序必须覆盖当前全部铅条与玻璃片
    doc.edges.forEach((e) => {
      if (!coveredLead.has(e.id))
        violations.push({ type: "missing", edgeId: e.id,
          msg: `铅条（${e.kind === "frame" ? "外框边" : "内部"}）缺少放铅步骤` });
    });
    (facePieces || []).forEach((fp) => {
      if (fp.piece && !coveredPiece.has(fp.piece.id))
        violations.push({ type: "missing", pieceId: fp.piece.id,
          msg: `片 ${pieceNum(fp.piece.id)} 缺少嵌片步骤` });
    });
    return violations;
  }

  /* 几何变化后调和已保存的手动次序：
   * 1) 删除引用已不存在的边/片/节点的步骤并去重
   * 2) 新铅条补放铅步骤：插到相邻最早嵌片步骤之前（无相邻片则附末尾）
   * 3) 新玻璃片补嵌片步骤：插到其边界最后一根放铅步骤之前（保留敞口边）
   * 4) 新节点补焊点步骤：插到相连铅条全部就位之后 */
  function reconcile(doc, facePieces) {
    const seq = doc.sequence;
    const steps = Array.isArray(seq.steps) ? seq.steps : [];
    const edgeIds = new Set(doc.edges.map((e) => e.id));
    const pieceIds = new Set(doc.pieces.map((p) => p.id));
    const nodeIds = new Set(doc.nodes.map((n) => n.id));

    const seen = new Set();
    const kept = [];
    steps.forEach((s) => {
      const okRef =
        (s.type === "lead" && edgeIds.has(s.ref)) ||
        (s.type === "piece" && pieceIds.has(s.ref)) ||
        (s.type === "solder" && nodeIds.has(s.ref));
      const k = s.type + "|" + s.ref;
      if (okRef && !seen.has(k)) { seen.add(k); kept.push(s); }
    });

    const boundaryOf = {};
    (facePieces || []).forEach((fp) => {
      if (fp.piece) boundaryOf[fp.piece.id] = [...new Set(fp.face.edgeIds)];
    });
    const edgePieces = {};
    Object.entries(boundaryOf).forEach(([pid, eids]) =>
      eids.forEach((e) => (edgePieces[e] = edgePieces[e] || []).push(pid))
    );

    // 补放铅步骤
    const haveLead = new Set(kept.filter((s) => s.type === "lead").map((s) => s.ref));
    doc.edges.forEach((e) => {
      if (haveLead.has(e.id)) return;
      const pids = edgePieces[e.id] || [];
      let idx = -1;
      for (let i = 0; i < kept.length; i++) {
        if (kept[i].type === "piece" && pids.indexOf(kept[i].ref) >= 0) { idx = i; break; }
      }
      const step = { type: "lead", ref: e.id };
      if (idx >= 0) kept.splice(idx, 0, step); else kept.push(step);
    });

    // 补嵌片步骤
    const havePiece = new Set(kept.filter((s) => s.type === "piece").map((s) => s.ref));
    doc.pieces.forEach((p) => {
      if (havePiece.has(p.id)) return;
      const b = boundaryOf[p.id] || [];
      let lastLead = -1;
      kept.forEach((s, i) => {
        if (s.type === "lead" && b.indexOf(s.ref) >= 0) lastLead = i;
      });
      const step = { type: "piece", ref: p.id };
      if (lastLead >= 0) kept.splice(lastLead, 0, step); else kept.push(step);
    });

    // 补焊点步骤
    const haveSolder = new Set(kept.filter((s) => s.type === "solder").map((s) => s.ref));
    const nodeEdges = {};
    doc.edges.forEach((e) => {
      (nodeEdges[e.a] = nodeEdges[e.a] || []).push(e.id);
      (nodeEdges[e.b] = nodeEdges[e.b] || []).push(e.id);
    });
    doc.nodes.forEach((n) => {
      const inc = nodeEdges[n.id] || [];
      if (inc.length < 2 || haveSolder.has(n.id)) return;
      let lastLead = -1;
      kept.forEach((s, i) => {
        if (s.type === "lead" && inc.indexOf(s.ref) >= 0) lastLead = i;
      });
      const step = { type: "solder", ref: n.id };
      if (lastLead >= 0) kept.splice(lastLead + 1, 0, step); else kept.push(step);
    });

    seq.steps = kept;
    return kept;
  }

  LG.seq = { generate, validate, reconcile, pieceOrder, cornerPoint };
})(typeof window !== "undefined" ? window : globalThis);
