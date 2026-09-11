/* print.js — 按实际尺寸分页的纸样预览
 * LG.print.computePages(doc) → {pages, cols, rows, usableW, usableH, ...}
 * LG.print.renderPageSVG(doc, facePieces, page) → SVG 字符串（viewBox 单位 = mm，打印 100% 即实际尺寸） */
(function (root) {
  const LG = (root.LG = root.LG || {});

  function computePages(doc) {
    const S = doc.settings;
    const f = doc.frame || { x: 0, y: 0, w: 0, h: 0 };
    const pageW = S.pageWidth, pageH = S.pageHeight, m = S.pageMargin;
    const usableW = pageW - 2 * m, usableH = pageH - 2 * m;
    const ov = Math.min(S.overlap, usableW / 2, usableH / 2);
    const stepX = usableW - ov, stepY = usableH - ov;
    const cols = f.w <= usableW ? 1 : Math.max(1, Math.ceil((f.w - usableW) / stepX) + 1);
    const rows = f.h <= usableH ? 1 : Math.max(1, Math.ceil((f.h - usableH) / stepY) + 1);
    const pages = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        pages.push({
          row: r, col: c, index: r * cols + c,
          ox: f.x + c * stepX, oy: f.y + r * stepY, w: usableW, h: usableH,
        });
    return { pages, cols, rows, usableW, usableH, pageW, pageH, margin: m, overlap: ov };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function ptsAttr(pts) {
    return pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  }

  // 纹理箭头：沿 grain 角度穿过质心
  function grainArrow(cx, cy, deg, len) {
    const a = ((deg || 0) * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const x1 = cx - (dx * len) / 2, y1 = cy - (dy * len) / 2;
    const x2 = cx + (dx * len) / 2, y2 = cy + (dy * len) / 2;
    const hl = Math.min(4, len / 6); // 箭头翼长
    const px = -dy, py = dx;
    return (
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" class="grain"/>` +
      `<polyline points="${(x2 - dx * hl + px * hl * 0.6).toFixed(2)},${(y2 - dy * hl + py * hl * 0.6).toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)} ${(x2 - dx * hl - px * hl * 0.6).toFixed(2)},${(y2 - dy * hl - py * hl * 0.6).toFixed(2)}" class="grain"/>`
    );
  }

  function regCross(x, y, s) {
    return `<line x1="${x - s}" y1="${y}" x2="${x + s}" y2="${y}" class="reg"/><line x1="${x}" y1="${y - s}" x2="${x}" y2="${y + s}" class="reg"/>`;
  }

  function renderPageSVG(doc, facePieces, page, layout) {
    const g = LG.g;
    const S = doc.settings;
    const dCut = S.heartWidth / 2 + S.grindAllowance / 2;
    const { ox, oy, w, h } = page;
    const f = doc.frame || { x: 0, y: 0, w: 0, h: 0 };
    const isLastCol = page.col === layout.cols - 1;
    const isLastRow = page.row === layout.rows - 1;
    // 非重叠“核心区”：片号/纹理只画在核心区，避免跨页重复
    const core = {
      x0: ox + (page.col > 0 ? layout.overlap / 2 : 0),
      y0: oy + (page.row > 0 ? layout.overlap / 2 : 0),
      x1: ox + w - (isLastCol ? 0 : layout.overlap / 2),
      y1: oy + h - (isLastRow ? 0 : layout.overlap / 2),
    };
    const inCore = (x, y) => x >= core.x0 && x <= core.x1 && y >= core.y0 && y <= core.y1;

    let out = [];
    // 面板外框（粗）与裁切余量参考
    out.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" class="frame-outline"/>`);

    // 铅条中心线（浅灰虚线，仅参考）
    const nodeById = {};
    doc.nodes.forEach((n) => (nodeById[n.id] = n));
    doc.edges.forEach((e) => {
      const a = nodeById[e.a], b = nodeById[e.b];
      if (!a || !b) return;
      out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="centerline"/>`);
    });

    // 玻璃片：切割轮廓（中心线内缩 铅芯/2+研磨余量/2）+ 片号 + 纹理箭头
    (facePieces || []).forEach((fp) => {
      if (!fp.piece) return;
      const face = fp.face;
      const bb = g.polyBBox(face.pts);
      if (bb.x1 < ox || bb.x0 > ox + w || bb.y1 < oy || bb.y0 > oy + h) return; // 不在本页
      const inset = g.insetPolygon(face.pts, dCut);
      const cut = inset.ok ? inset.poly : face.pts;
      out.push(`<polygon points="${ptsAttr(cut)}" class="cut" style="fill:${esc(fp.piece.color)}"/>`);
      if (inCore(face.cx, face.cy)) {
        const fs = Math.max(5, Math.min(12, (bb.x1 - bb.x0) / 4, (bb.y1 - bb.y0) / 4));
        out.push(`<text x="${face.cx.toFixed(2)}" y="${face.cy.toFixed(2)}" class="pnum" style="font-size:${fs.toFixed(1)}">${fp.piece.num}</text>`);
        const gl = Math.max(14, Math.min(40, (bb.x1 - bb.x0) * 0.55, (bb.y1 - bb.y0) * 0.55));
        out.push(grainArrow(face.cx, face.cy, fp.piece.grain, gl));
      }
    });

    // 拼接线（本页裁切边）+ 重叠区 + 对位十字
    out.push(`<rect x="${ox}" y="${oy}" width="${w}" height="${h}" class="trim"/>`);
    if (!isLastCol)
      out.push(`<rect x="${ox + w - layout.overlap}" y="${oy}" width="${layout.overlap}" height="${h}" class="overlap"/>`);
    if (!isLastRow)
      out.push(`<rect x="${ox}" y="${oy + h - layout.overlap}" width="${w}" height="${layout.overlap}" class="overlap"/>`);
    const cs = 5;
    [[ox, oy], [ox + w, oy], [ox, oy + h], [ox + w, oy + h]].forEach(([x, y]) => out.push(regCross(x, y, cs)));

    // 页标签与拼接提示
    const total = layout.cols * layout.rows;
    const label = `第 ${page.index + 1}/${total} 页 · 行${page.row + 1}列${page.col + 1}` +
      (isLastCol ? "" : " · 右接→") + (isLastRow ? "" : " · 下接↓");
    out.push(`<text x="${ox + 3}" y="${oy + 6}" class="plabel">${esc(label)}</text>`);

    // 50mm 校准框（左下角空白处）
    const cbx = ox + 4, cby = oy + h - 54;
    out.push(`<rect x="${cbx}" y="${cby}" width="50" height="50" class="calib"/>` +
      `<text x="${cbx}" y="${cby - 2}" class="calib-label">50mm 校准框</text>`);

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${ox} ${oy} ${w} ${h}">` +
      out.join("") +
      `</svg>`
    );
  }

  LG.print = { computePages, renderPageSVG };
})(typeof window !== "undefined" ? window : globalThis);
