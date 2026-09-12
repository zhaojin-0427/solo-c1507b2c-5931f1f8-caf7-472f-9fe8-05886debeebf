/* calibration.js — 现场底稿校准：仿射/透视最小二乘拟合、退化检测、残差分析、图像重投影
 * 坐标系：图像像素 (u,v) → 面板 mm (X,Y)。
 * 浏览器与 node 通用（rectify 依赖 canvas，仅浏览器可用）：挂载到 LG.calib */
(function (root) {
  const LG = (root.LG = root.LG || {});

  // ---------- n×n 线性方程组：部分主元高斯消元，奇异返回 null ----------
  function solveLinear(A, b) {
    const n = A.length;
    let scale = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(A[i][j]));
    const tol = (scale || 1) * 1e-12;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++)
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < tol) return null; // 退化：奇异
      const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // ---------- 退化检测：全部重合或共线 ----------
  function degenerate(xy) {
    // xy: [[x,y],...]，至少 2 点
    let p1 = null, p2 = null, dMax = 0;
    for (let i = 0; i < xy.length; i++)
      for (let j = i + 1; j < xy.length; j++) {
        const d = Math.hypot(xy[j][0] - xy[i][0], xy[j][1] - xy[i][1]);
        if (d > dMax) { dMax = d; p1 = xy[i]; p2 = xy[j]; }
      }
    if (dMax < 1e-9) return true; // 全部重合
    const ux = (p2[0] - p1[0]) / dMax, uy = (p2[1] - p1[1]) / dMax;
    let maxPerp = 0;
    for (const p of xy) {
      const perp = Math.abs((p[0] - p1[0]) * uy - (p[1] - p1[1]) * ux);
      if (perp > maxPerp) maxPerp = perp;
    }
    return maxPerp < dMax * 1e-6; // 共线
  }

  // 严格数值判断：isFinite(null)===true（null→0），未填坐标必须显式排除
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function finitePt(p) {
    return isNum(p.imgX) && isNum(p.imgY) && isNum(p.panelX) && isNum(p.panelY);
  }
  function included(pts) {
    return (pts || []).filter((p) => !p.excluded && finitePt(p));
  }

  // ---------- 仿射：X = a·u + b·v + tx，Y = c·u + d·v + ty（最小二乘，≥3 点） ----------
  function solveAffine(pts) {
    const n = pts.length;
    let mu = 0, mv = 0, mX = 0, mY = 0;
    pts.forEach((p) => { mu += p.imgX; mv += p.imgY; mX += p.panelX; mY += p.panelY; });
    mu /= n; mv /= n; mX /= n; mY /= n;
    // 以质心为中心建法方程（改善条件数），平移量最后回代
    let AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let bx = [0, 0, 0], by = [0, 0, 0];
    pts.forEach((p) => {
      const r = [p.imgX - mu, p.imgY - mv, 1];
      const X = p.panelX - mX, Y = p.panelY - mY;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) AtA[i][j] += r[i] * r[j];
        bx[i] += r[i] * X; by[i] += r[i] * Y;
      }
    });
    const sx = solveLinear(AtA, bx), sy = solveLinear(AtA, by);
    if (!sx || !sy) return null;
    const a = sx[0], b = sx[1], c = sy[0], d = sy[1];
    return {
      type: "affine",
      m: [a, b, mX - a * mu - b * mv + sx[2], c, d, mY - c * mu - d * mv + sy[2]],
    };
  }

  // ---------- 透视（单应）：DLT + Hartley 归一化（最小二乘，≥4 点） ----------
  function normMat(pts, get) {
    let cx = 0, cy = 0;
    pts.forEach((p) => { cx += get(p)[0]; cy += get(p)[1]; });
    cx /= pts.length; cy /= pts.length;
    let md = 0;
    pts.forEach((p) => { md += Math.hypot(get(p)[0] - cx, get(p)[1] - cy); });
    md /= pts.length;
    const s = md > 1e-12 ? Math.SQRT2 / md : 1;
    return { s, cx, cy }; // x' = s·(x - cx)
  }

  function solvePerspective(pts) {
    const Ti = normMat(pts, (p) => [p.imgX, p.imgY]);
    const Tp = normMat(pts, (p) => [p.panelX, p.panelY]);
    const n = pts.length;
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    pts.forEach((p) => {
      const u = Ti.s * (p.imgX - Ti.cx), v = Ti.s * (p.imgY - Ti.cy);
      const X = Tp.s * (p.panelX - Tp.cx), Y = Tp.s * (p.panelY - Tp.cy);
      const rows = [
        [u, v, 1, 0, 0, 0, -u * X, -v * X],
        [0, 0, 0, u, v, 1, -u * Y, -v * Y],
      ];
      const rhs = [X, Y];
      for (let k = 0; k < 2; k++) {
        const r = rows[k];
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j];
          Atb[i] += r[i] * rhs[k];
        }
      }
    });
    const x = solveLinear(AtA, Atb);
    if (!x) return null;
    // 归一化坐标下的 Ĥ
    const Hn = [[x[0], x[1], x[2]], [x[3], x[4], x[5]], [x[6], x[7], 1]];
    // 反归一化：H = T_panel⁻¹ · Ĥ · T_img
    const Timg = [[Ti.s, 0, -Ti.s * Ti.cx], [0, Ti.s, -Ti.s * Ti.cy], [0, 0, 1]];
    const TpanInv = [[1 / Tp.s, 0, Tp.cx], [0, 1 / Tp.s, Tp.cy], [0, 0, 1]];
    const H = mul3(TpanInv, mul3(Hn, Timg));
    if (Math.abs(H[2][2]) < 1e-12) return null;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) H[i][j] /= H[2][2];
    return {
      type: "perspective",
      h: [H[0][0], H[0][1], H[0][2], H[1][0], H[1][1], H[1][2], H[2][0], H[2][1]],
    };
  }

  function mul3(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
    return C;
  }

  // ---------- 应用 / 求逆 ----------
  function apply(params, u, v) {
    if (params.type === "affine") {
      const m = params.m;
      return { x: m[0] * u + m[1] * v + m[2], y: m[3] * u + m[4] * v + m[5] };
    }
    const h = params.h;
    const w = h[6] * u + h[7] * v + 1;
    if (Math.abs(w) < 1e-12) return { x: NaN, y: NaN };
    return {
      x: (h[0] * u + h[1] * v + h[2]) / w,
      y: (h[3] * u + h[4] * v + h[5]) / w,
    };
  }

  function invert(params) {
    if (params.type === "affine") {
      const m = params.m;
      const det = m[0] * m[4] - m[1] * m[3];
      if (Math.abs(det) < 1e-12) return null;
      const a = m[4] / det, b = -m[1] / det, c = -m[3] / det, d = m[0] / det;
      return {
        type: "affine",
        m: [a, b, -(a * m[2] + b * m[5]), c, d, -(c * m[2] + d * m[5])],
      };
    }
    const h = params.h;
    const H = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
    // 伴随矩阵（余子式的转置布局）
    const Adj = [
      [H[1][1] * H[2][2] - H[1][2] * H[2][1], H[0][2] * H[2][1] - H[0][1] * H[2][2], H[0][1] * H[1][2] - H[0][2] * H[1][1]],
      [H[1][2] * H[2][0] - H[1][0] * H[2][2], H[0][0] * H[2][2] - H[0][2] * H[2][0], H[0][2] * H[1][0] - H[0][0] * H[1][2]],
      [H[1][0] * H[2][1] - H[1][1] * H[2][0], H[0][1] * H[2][0] - H[0][0] * H[2][1], H[0][0] * H[1][1] - H[0][1] * H[1][0]],
    ];
    const det = H[0][0] * Adj[0][0] + H[0][1] * Adj[1][0] + H[0][2] * Adj[2][0];
    if (Math.abs(det) < 1e-12) return null;
    const inv = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) inv.push(Adj[i][j] / det);
    const w = inv[8];
    if (Math.abs(w) > 1e-12) for (let i = 0; i < 9; i++) inv[i] /= w;
    return { type: "perspective", h: inv.slice(0, 8) };
  }

  // ---------- 残差：方向 / 像素误差 / 毫米误差 ----------
  function residuals(pts, params) {
    const inv = invert(params);
    return (pts || []).filter(finitePt).map((p) => {
      const pr = apply(params, p.imgX, p.imgY);
      const resX = p.panelX - pr.x, resY = p.panelY - pr.y;
      let pxErr = NaN, backX = NaN, backY = NaN;
      if (inv) {
        const bk = apply(inv, p.panelX, p.panelY);
        backX = bk.x; backY = bk.y;
        pxErr = Math.hypot(bk.x - p.imgX, bk.y - p.imgY);
      }
      return {
        id: p.id, predX: pr.x, predY: pr.y, resX, resY,
        mmErr: Math.hypot(resX, resY),
        pxErr, backX, backY,
        angDeg: (Math.atan2(resY, resX) * 180) / Math.PI,
      };
    });
  }

  function rms(errs, key) {
    const v = (errs || []).filter((e) => isFinite(e[key]));
    if (!v.length) return NaN;
    return Math.sqrt(v.reduce((s, e) => s + e[key] * e[key], 0) / v.length);
  }

  // 点集指纹：拟合相关数据（方法 + 参与拟合点的坐标）→ 判断参数是否过期
  function hashPoints(pts, method) {
    const inc = included(pts)
      .map((p) => [p.imgX, p.imgY, p.panelX, p.panelY].map((v) => (+v).toFixed(3)).join(","))
      .sort();
    const s = (method || "") + "|" + inc.join(";");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // ---------- 计算校正：验证 → 拟合 → 统计；退化时抛错拒绝 ----------
  function compute(pts, method) {
    method = method === "perspective" ? "perspective" : "affine";
    const need = method === "perspective" ? 4 : 3;
    const mName = method === "perspective" ? "透视" : "仿射";
    // 未填写完整的点不参与拟合；有效点不足时阻止并提示补全
    const active = (pts || []).filter((p) => !p.excluded);
    const inc = active.filter(finitePt);
    if (inc.length < need) {
      const incomplete = active.length - inc.length;
      throw new Error(
        `${mName}校正至少需要 ${need} 组控制点（当前 ${inc.length} 组有效` +
          (incomplete ? `，${incomplete} 个点未填完整坐标，请补全` : "") +
          "）"
      );
    }
    if (degenerate(inc.map((p) => [p.imgX, p.imgY])))
      throw new Error("图像控制点共线或重合，点集退化，拒绝计算");
    if (degenerate(inc.map((p) => [p.panelX, p.panelY])))
      throw new Error("面板坐标共线或重合，点集退化，拒绝计算");
    const params = method === "perspective" ? solvePerspective(inc) : solveAffine(inc);
    if (!params) throw new Error("点集退化（方程组奇异），拒绝计算");
    const res = residuals(inc, params);
    params.nPts = inc.length;
    params.rmsMm = rms(res, "mmErr");
    params.rmsPx = rms(res, "pxErr");
    params.ptsHash = hashPoints(pts, method);
    return params;
  }

  // ---------- 重投影：把原图按变换校正到面板 mm 坐标（仅浏览器） ----------
  // 返回 {canvas, bbox:{x0,y0,x1,y1}}，canvas 中 1 单位 = 1mm × k
  function rectify(img, params, maxDim) {
    maxDim = maxDim || 1400;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    // 源图先限制到 2048 内，双线性采样足够
    const srcScale = Math.min(1, 2048 / Math.max(iw, ih));
    const sw = Math.max(1, Math.round(iw * srcScale));
    const sh = Math.max(1, Math.round(ih * srcScale));
    const sc = document.createElement("canvas");
    sc.width = sw; sc.height = sh;
    const sctx = sc.getContext("2d");
    sctx.drawImage(img, 0, 0, sw, sh);
    const src = sctx.getImageData(0, 0, sw, sh).data;

    // 校正后图像在面板 mm 中的包围盒（单应把矩形映为四边形，角点足够）
    const corners = [
      apply(params, 0, 0), apply(params, iw, 0),
      apply(params, iw, ih), apply(params, 0, ih),
    ];
    const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
    const bbox = {
      x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
      x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys),
    };
    const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
    if (!(bw > 0) || !(bh > 0)) return null;
    const k = Math.min(4, maxDim / Math.max(bw, bh)); // px/mm
    const ow = Math.max(1, Math.round(bw * k)), oh = Math.max(1, Math.round(bh * k));
    const oc = document.createElement("canvas");
    oc.width = ow; oc.height = oh;
    const octx = oc.getContext("2d");
    const out = octx.createImageData(ow, oh);
    const od = out.data;
    const inv = invert(params);
    if (!inv) return null;
    for (let j = 0; j < oh; j++) {
      const mmY = bbox.y0 + (j + 0.5) / k;
      for (let i = 0; i < ow; i++) {
        const mmX = bbox.x0 + (i + 0.5) / k;
        const s = apply(inv, mmX, mmY);
        const o4 = (j * ow + i) * 4;
        if (!isFinite(s.x) || !isFinite(s.y)) continue;
        const fx = s.x * srcScale, fy = s.y * srcScale;
        if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) continue;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const ax = fx - x0, ay = fy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const top = src[i00 + ch] * (1 - ax) + src[i10 + ch] * ax;
          const bot = src[i01 + ch] * (1 - ax) + src[i11 + ch] * ax;
          od[o4 + ch] = top * (1 - ay) + bot * ay;
        }
      }
    }
    octx.putImageData(out, 0, 0);
    return { canvas: oc, bbox, k };
  }

  LG.calib = {
    solveAffine, solvePerspective, compute, apply, invert,
    residuals, rms, hashPoints, included, degenerate, rectify, isNum,
  };
})(typeof window !== "undefined" ? window : globalThis);
