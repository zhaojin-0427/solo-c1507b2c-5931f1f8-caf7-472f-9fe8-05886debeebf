/* calibui.js — 现场底稿校准工作区：照片导入、控制点标记、并排校正对比、方案版本管理、画布底稿叠放
 * 数据由 Flask 服务写入 SQLite（calib_photos / calib_versions）；本文件负责交互。 */
(function (root) {
  const LG = (root.LG = root.LG || {});
  const NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const st = () => LG.state;
  const doc = () => LG.state.doc;
  const api = (m, u, b) => LG.app.api(m, u, b);
  const toast = (m) => LG.app.toast(m);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const C = {
    photos: [],          // 照片元数据（不含二进制）
    versions: [],        // 校准方案版本（含控制点与参数）
    activePhotoId: null, // 侧栏选中的照片（新建方案时使用）
    editing: null,       // 工作区中打开的版本
    activePt: null,      // 当前选中的控制点 id
    flip: false,         // 右视图切换为“校正前”
    viewL: { s: 1, tx: 0, ty: 0 },   // 左视图（图像 px → 屏幕）
    viewR: { s: 1, tx: 0, ty: 0 },   // 右视图（面板 mm → 屏幕）
    imgCache: {},        // photoId → Image
    imgMeta: {},         // photoId → {w,h}
    rectBmp: null,       // 工作区右视图重投影位图 {key,dataUrl,bbox}
    saveTimer: null,
    ptSeq: 1,
    spaceDown: false,
  };
  let panDrag = null, dragPt = null, dragCross = null;

  // ---------- 照片 ----------
  function loadPhotoImage(photoId) {
    if (C.imgCache[photoId]) return Promise.resolve(C.imgCache[photoId]);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        C.imgCache[photoId] = img;
        C.imgMeta[photoId] = { w: img.naturalWidth, h: img.naturalHeight };
        resolve(img);
      };
      img.onerror = reject;
      img.src = "/api/photos/" + photoId + "/raw";
    });
  }

  function importPhoto(file) {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = async () => {
        try {
          await api("POST", `/api/projects/${st().projectId}/photos`, {
            name: file.name || "现场照片",
            mime: file.type || "image/png",
            width: img.naturalWidth,
            height: img.naturalHeight,
            dataBase64: String(rd.result).split(",")[1],
          });
          C.photos = await api("GET", `/api/projects/${st().projectId}/photos`);
          C.activePhotoId = C.photos[C.photos.length - 1].id;
          renderPanel();
          toast("照片已导入，可新建校准方案");
        } catch (e) { toast("导入失败：" + e.message); }
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  }

  async function deletePhoto() {
    const ph = C.photos.find((p) => p.id === C.activePhotoId) || C.photos[0];
    if (!ph) return;
    if (!confirm(`删除照片「${ph.name}」将同时删除其全部校准版本，确定？`)) return;
    await api("DELETE", "/api/photos/" + ph.id);
    await loadProjectData(st().projectId);
    toast("照片及其校准版本已删除");
  }

  // ---------- 数据载入 ----------
  async function loadProjectData(pid) {
    C.photos = await api("GET", `/api/projects/${pid}/photos`);
    C.versions = await api("GET", `/api/projects/${pid}/calib`);
    C.imgCache = {}; C.rectBmp = null; C.editing = null;
    if (!C.photos.some((p) => p.id === C.activePhotoId))
      C.activePhotoId = C.photos.length ? C.photos[0].id : null;
    // 当前底稿引用的版本已不存在 → 清理（只动底稿，不动几何）
    const u = doc().underlay;
    if (u && u.versionId != null && !C.versions.some((v) => v.id === u.versionId && v.params)) {
      u.versionId = null;
    }
    renderPanel();
    refreshUnderlay();
  }

  // ---------- 画布底稿 ----------
  function refreshUnderlay() {
    const u = doc().underlay;
    const v = u && u.versionId != null && C.versions.find((x) => x.id === u.versionId);
    if (!v || !v.params) {
      st().underlayBmp = null;
      if (LG.editor.render) LG.editor.render();
      return;
    }
    const key = "v" + v.id + "|" + (v.params.ptsHash || "") + "|" + (v.params.rmsMm || "");
    if (st().underlayBmp && st().underlayBmp.key === key) { LG.editor.render(); return; }
    loadPhotoImage(v.photo_id).then((img) => {
      const r = LG.calib.rectify(img, v.params, 1400);
      st().underlayBmp = r ? { key, dataUrl: r.canvas.toDataURL("image/png"), bbox: r.bbox } : null;
      LG.editor.render();
    }).catch(() => { st().underlayBmp = null; LG.editor.render(); });
  }

  function setCurrent(id) {
    const u = doc().underlay;
    u.versionId = id;
    if (id != null) u.visible = true;
    LG.app.requestSave();
    refreshUnderlay();
    renderPanel();
  }

  // ---------- 侧栏面板 ----------
  function renderPanel() {
    const box = $("calibPanel");
    if (!box || !doc()) return;
    const u = doc().underlay;
    let html = "";
    // 照片
    html += `<fieldset><legend>底稿照片 / 扫描拓片</legend>`;
    if (!C.photos.length) html += `<div class="empty">尚未导入照片</div>`;
    else {
      html += `<label>照片 <select id="cpPhotoSel">` + C.photos.map((p) =>
        `<option value="${p.id}" ${p.id === C.activePhotoId ? "selected" : ""}>${esc(p.name)}（${p.width}×${p.height}）</option>`
      ).join("") + `</select></label>`;
    }
    html += `<div style="display:flex;gap:6px"><button id="cpImport" class="mini">导入照片…</button>`;
    if (C.photos.length) html += `<button id="cpDelPhoto" class="mini danger">删除照片</button>`;
    html += `</div><input type="file" id="cpFile" accept="image/*" style="display:none"></fieldset>`;
    // 画布底稿
    const opct = Math.round((u.opacity != null ? u.opacity : 0.55) * 100);
    html += `<fieldset><legend>画布底稿（叠到铅条画布底层）</legend>`;
    const frozen = C.versions.filter((v) => v.frozen && v.params);
    html += `<label>当前版本 <select id="cpCur"><option value="">无</option>` +
      frozen.map((v) => `<option value="${v.id}" ${v.id === u.versionId ? "selected" : ""}>${esc(v.name)}</option>`).join("") +
      `</select></label>`;
    html += `<label>显示底稿 <input type="checkbox" id="cpShow" ${u.visible ? "checked" : ""} ${u.versionId != null ? "" : "disabled"}></label>`;
    html += `<label>透明度 <input type="range" id="cpOpacity" min="5" max="100" value="${opct}"><span id="cpOpVal">${opct}%</span></label>`;
    const c = u.crop || {};
    html += `<div class="muted">裁切范围 mm（留空 = 整幅）</div><div class="crop-inputs">` +
      [["cpC_x0", "x0", c.x0], ["cpC_y0", "y0", c.y0], ["cpC_x1", "x1", c.x1], ["cpC_y1", "y1", c.y1]]
        .map(([id, k, val]) => `<label>${k} <input id="${id}" type="number" step="10" value="${val != null ? val : ""}"></label>`).join("") +
      `</div><div style="display:flex;gap:6px;margin-top:4px">` +
      `<button id="cpCropFrame" class="mini">裁切=外框</button><button id="cpCropClear" class="mini">整幅</button></div></fieldset>`;
    // 版本列表
    html += `<fieldset><legend>校准方案（比较均方根误差）</legend>`;
    if (!C.versions.length) html += `<div class="empty">暂无校准方案</div>`;
    C.versions.forEach((v) => {
      const stale = v.params && LG.calib.hashPoints(v.points, v.method) !== v.params.ptsHash;
      const rms = v.params
        ? `RMS ${v.params.rmsMm.toFixed(2)}mm / ${v.params.rmsPx.toFixed(1)}px · ${v.params.nPts}点`
        : "未计算";
      const badge = v.frozen ? `<span class="cal-badge frozen">已冻结</span>`
        : stale ? `<span class="cal-badge stale">参数过期</span>` : `<span class="cal-badge">草稿</span>`;
      html += `<div class="cal-ver ${v.id === u.versionId ? "current" : ""}">
        <div class="cal-ver-head"><span class="cal-ver-name">${esc(v.name)}</span>${badge}</div>
        <div class="cal-ver-meta">${v.method === "perspective" ? "透视" : "仿射"} · ${rms}${stale ? "（点集已改）" : ""}</div>
        <div class="cal-ver-ops">
          <button class="mini" data-edit="${v.id}">编辑</button>
          <button class="mini" data-copy="${v.id}">复制</button>
          ${v.frozen && v.params ? `<button class="mini" data-cur="${v.id}">设为当前</button>` : ""}
          <button class="mini danger" data-del="${v.id}">删除</button>
        </div></div>`;
    });
    html += `<button id="cpNew" class="mini">新建校准方案</button></fieldset>`;
    html += `<div class="pane-note">校准只改变底稿，不移动已有节点和铅条；项目恢复时保留原图与全部版本。</div>`;
    box.innerHTML = html;
    bindPanel(box);
  }

  function bindPanel(box) {
    const q = (sel) => box.querySelector(sel);
    const u = doc().underlay;
    const save = () => { LG.app.requestSave(); };
    if (q("#cpImport")) q("#cpImport").addEventListener("click", () => q("#cpFile").click());
    if (q("#cpFile")) q("#cpFile").addEventListener("change", (ev) => importPhoto(ev.target.files[0]));
    if (q("#cpPhotoSel")) q("#cpPhotoSel").addEventListener("change", (ev) => { C.activePhotoId = +ev.target.value; });
    if (q("#cpDelPhoto")) q("#cpDelPhoto").addEventListener("click", deletePhoto);
    if (q("#cpCur")) q("#cpCur").addEventListener("change", (ev) =>
      setCurrent(ev.target.value === "" ? null : +ev.target.value));
    if (q("#cpShow")) q("#cpShow").addEventListener("change", (ev) => {
      u.visible = ev.target.checked; save(); LG.editor.render();
    });
    if (q("#cpOpacity")) q("#cpOpacity").addEventListener("input", (ev) => {
      u.opacity = (+ev.target.value) / 100;
      q("#cpOpVal").textContent = ev.target.value + "%";
      save(); LG.editor.render();
    });
    ["cpC_x0", "cpC_y0", "cpC_x1", "cpC_y1"].forEach((id) => {
      const inp = q("#" + id);
      if (inp) inp.addEventListener("change", () => {
        const vals = ["cpC_x0", "cpC_y0", "cpC_x1", "cpC_y1"].map((i) => q("#" + i).value.trim());
        if (vals.every((s) => s === "")) { u.crop = null; }
        else {
          const n = vals.map(parseFloat);
          if (n.some((x) => !isFinite(x)) || n[2] <= n[0] || n[3] <= n[1])
            return toast("裁切范围无效（需 x1>x0、y1>y0，或全部留空）");
          u.crop = { x0: n[0], y0: n[1], x1: n[2], y1: n[3] };
        }
        save(); LG.editor.render();
      });
    });
    if (q("#cpCropFrame")) q("#cpCropFrame").addEventListener("click", () => {
      const f = doc().frame;
      if (!f) return toast("请先画外框");
      u.crop = { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h };
      save(); LG.editor.render(); renderPanel();
    });
    if (q("#cpCropClear")) q("#cpCropClear").addEventListener("click", () => {
      u.crop = null; save(); LG.editor.render(); renderPanel();
    });
    box.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => openWorkspace(+b.dataset.edit)));
    box.querySelectorAll("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => copyVersion(+b.dataset.copy)));
    box.querySelectorAll("[data-cur]").forEach((b) =>
      b.addEventListener("click", () => setCurrent(+b.dataset.cur)));
    box.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => deleteVersion(+b.dataset.del)));
    if (q("#cpNew")) q("#cpNew").addEventListener("click", newVersion);
  }

  // ---------- 版本操作 ----------
  async function newVersion() {
    if (!C.photos.length) return toast("请先导入照片或扫描拓片");
    const photoId = C.activePhotoId || C.photos[0].id;
    const r = await api("POST", `/api/projects/${st().projectId}/calib`, {
      photo_id: photoId, name: "方案 " + (C.versions.length + 1), method: "affine",
    });
    C.versions = await api("GET", `/api/projects/${st().projectId}/calib`);
    renderPanel();
    openWorkspace(r.id);
  }

  async function copyVersion(vid) {
    const v = C.versions.find((x) => x.id === vid);
    if (!v) return;
    await api("POST", `/api/projects/${st().projectId}/calib`, {
      photo_id: v.photo_id,
      name: (v.name + " 副本").slice(0, 80),
      method: v.method,
      points: v.points.map((p) => Object.assign({}, p)),
      params: v.params,
    });
    C.versions = await api("GET", `/api/projects/${st().projectId}/calib`);
    renderPanel();
    toast("已复制方案；调整点集后重新计算，可比较均方根误差");
  }

  async function deleteVersion(vid) {
    const v = C.versions.find((x) => x.id === vid);
    if (!v || !confirm(`删除校准方案「${v.name}」？`)) return;
    await api("DELETE", "/api/calib/" + vid);
    if (doc().underlay.versionId === vid) {
      doc().underlay.versionId = null;
      LG.app.requestSave();
    }
    C.versions = await api("GET", `/api/projects/${st().projectId}/calib`);
    renderPanel();
    refreshUnderlay();
  }

  function saveVersion(immediate) {
    const v = C.editing;
    if (!v) return;
    const body = { name: v.name, method: v.method, points: v.points, params: v.params, frozen: v.frozen };
    clearTimeout(C.saveTimer);
    const doSave = () =>
      api("PUT", "/api/calib/" + v.id, body).then((r) => { v.updated_at = r.updated_at; });
    if (immediate) return doSave();
    C.saveTimer = setTimeout(doSave, 600);
    return Promise.resolve();
  }

  // ---------- 工作区 ----------
  function openWorkspace(vid) {
    const v = C.versions.find((x) => x.id === vid);
    if (!v) return;
    C.editing = v;
    C.activePt = null;
    C.flip = false;
    C.rectBmp = null;
    $("calibModal").classList.add("show");
    loadPhotoImage(v.photo_id).then((img) => {
      if (C.editing !== v) return;
      $("calImg").src = img.src;
      $("calImgR").src = img.src;
      fitViewL(); fitViewR();
      renderWorkspace();
    }).catch(() => toast("照片加载失败"));
  }

  function closeWorkspace() {
    if (C.editing) saveVersion(true);
    C.editing = null;
    $("calibModal").classList.remove("show");
    api("GET", `/api/projects/${st().projectId}/calib`).then((vs) => {
      C.versions = vs;
      renderPanel();
      refreshUnderlay();
    });
  }

  function isStale(v) {
    return v.params && LG.calib.hashPoints(v.points, v.method) !== v.params.ptsHash;
  }

  function renderWorkspace() {
    const v = C.editing;
    if (!v) return;
    $("calVerName").value = v.name;
    $("calMethod").value = v.method;
    $("calMethod").disabled = v.frozen;
    $("calCompute").disabled = v.frozen;
    $("calFreeze").textContent = v.frozen ? "解冻（另建版本调整）" : "冻结参数";
    const badge = $("calBadge");
    if (v.frozen) { badge.textContent = "已冻结"; badge.className = "badge ok"; }
    else if (isStale(v)) { badge.textContent = "草稿 · 参数过期"; badge.className = "badge warn"; }
    else if (v.params) { badge.textContent = "草稿 · 已计算"; badge.className = "badge ok"; }
    else { badge.textContent = "草稿"; badge.className = "badge warn"; }
    $("calRms").textContent = v.params
      ? `RMS ${v.params.rmsMm.toFixed(2)} mm / ${v.params.rmsPx.toFixed(1)} px · ${v.params.nPts} 点`
      : "未计算";
    $("calRightTitle").textContent = C.flip
      ? "校正前（原图）"
      : "校正结果（面板 mm）· 点击为选中点填坐标";
    $("calFlip").textContent = C.flip ? "看校正后" : "看校正前";
    $("calSvgR").style.display = C.flip ? "none" : "";
    $("calInnerR2").style.display = C.flip ? "" : "none";
    renderActiveViews();
    renderTable();
    renderHint();
  }

  function renderHint() {
    const v = C.editing;
    const inc = LG.calib.included(v.points);
    const need = v.method === "perspective" ? 4 : 3;
    const incomplete = v.points.filter((p) =>
      !p.excluded && !(isFinite(p.panelX) && isFinite(p.panelY))).length;
    let t = `${v.method === "perspective" ? "透视" : "仿射"}校正至少 ${need} 组非共线点；当前 ${inc.length} 组有效`;
    if (incomplete) t += `，${incomplete} 个点未填面板坐标`;
    t += "。锁定 = 可信点不可改；排除 = 暂不参与拟合。校准只改变底稿，不移动已有节点和铅条。";
    $("calHint").textContent = t;
  }

  // ---------- 视图变换 ----------
  function applyViewL() {
    const v = C.viewL;
    const t = `translate(${v.tx}px,${v.ty}px) scale(${v.s})`;
    $("calInnerL").style.transform = t;
    $("calInnerR2").style.transform = t;
  }
  function applyViewR() {
    const v = C.viewR;
    $("calRg").setAttribute("transform", `translate(${v.tx},${v.ty}) scale(${v.s})`);
  }
  function fitViewL() {
    const meta = C.imgMeta[C.editing.photo_id];
    if (!meta) return;
    const r = $("calVpL").getBoundingClientRect();
    const s = Math.min((r.width - 30) / meta.w, (r.height - 30) / meta.h);
    C.viewL.s = Math.max(0.02, s);
    C.viewL.tx = (r.width - meta.w * C.viewL.s) / 2;
    C.viewL.ty = (r.height - meta.h * C.viewL.s) / 2;
    applyViewL();
  }
  function contentBBoxR() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const eat = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    if (C.rectBmp) { eat(C.rectBmp.bbox.x0, C.rectBmp.bbox.y0); eat(C.rectBmp.bbox.x1, C.rectBmp.bbox.y1); }
    const f = doc().frame;
    if (f) { eat(f.x, f.y); eat(f.x + f.w, f.y + f.h); }
    C.editing.points.forEach((p) => { if (isFinite(p.panelX) && isFinite(p.panelY)) eat(p.panelX, p.panelY); });
    if (x0 === Infinity) return { x0: 0, y0: 0, x1: 600, y1: 400 };
    return { x0, y0, x1, y1 };
  }
  function fitViewR() {
    if (!C.editing) return;
    const bb = contentBBoxR();
    const r = $("calVpR").getBoundingClientRect();
    const w = Math.max(1, bb.x1 - bb.x0), h = Math.max(1, bb.y1 - bb.y0);
    const s = Math.min((r.width - 40) / w, (r.height - 40) / h);
    C.viewR.s = Math.max(0.02, Math.min(60, s));
    C.viewR.tx = (r.width - w * C.viewR.s) / 2 - bb.x0 * C.viewR.s;
    C.viewR.ty = (r.height - h * C.viewR.s) / 2 - bb.y0 * C.viewR.s;
    applyViewR();
  }
  function vpPoint(vp, ev) {
    const r = vp.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function toImgL(ev) {
    const p = vpPoint($("calVpL"), ev);
    return { x: (p.x - C.viewL.tx) / C.viewL.s, y: (p.y - C.viewL.ty) / C.viewL.s };
  }
  function toMmR(ev) {
    const p = vpPoint($("calVpR"), ev);
    return { x: (p.x - C.viewR.tx) / C.viewR.s, y: (p.y - C.viewR.ty) / C.viewR.s };
  }
  function zoomView(view, vpEl, ev) {
    const p = vpPoint(vpEl, ev);
    const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const s2 = Math.max(0.02, Math.min(60, view.s * k));
    view.tx = p.x - ((p.x - view.tx) * s2) / view.s;
    view.ty = p.y - ((p.y - view.ty) * s2) / view.s;
    view.s = s2;
  }
  // 缩放/适应改变了比例，标记尺寸依赖 1/s，需重渲染
  function renderActiveViews() {
    renderViewL();
    if (C.flip) renderViewL2(); else renderViewR();
  }

  // ---------- 标记绘制 ----------
  function cpClass(p) {
    return "cp" + (p.locked ? " locked" : "") + (p.excluded ? " excluded" : "") +
      (p.id === C.activePt ? " active" : "");
  }
  function cpColor(p) {
    return p.locked ? "#2f8f4e" : p.excluded ? "#a09a8c" : "#2f6bd8";
  }
  function errColor(mmErr) {
    return mmErr <= 1 ? "#2f8f4e" : mmErr <= 3 ? "#e67e22" : "#c0392b";
  }
  function drawArrow(g, x1, y1, x2, y2, color, w, head) {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    if (L < 1e-9) {
      el("circle", { cx: x1, cy: y1, r: w * 1.4, fill: color, class: "cal-res" }, g);
      return;
    }
    const ux = dx / L, uy = dy / L, px = -uy, py = ux;
    el("line", { x1, y1, x2, y2, stroke: color, "stroke-width": w, class: "cal-res" }, g);
    el("polyline", {
      points: `${x2 - ux * head + px * head * 0.5},${y2 - uy * head + py * head * 0.5} ${x2},${y2} ${x2 - ux * head - px * head * 0.5},${y2 - uy * head - py * head * 0.5}`,
      stroke: color, "stroke-width": w, fill: "none", class: "cal-res",
    }, g);
  }
  function residualsOf() {
    const v = C.editing;
    const map = {};
    if (v && v.params)
      LG.calib.residuals(v.points, v.params).forEach((r) => { map[r.id] = r; });
    return map;
  }

  // 左视图：原图 + 控制点（可拖动）+ 图像空间残差箭头
  function renderViewL() {
    const v = C.editing;
    if (!v) return;
    const meta = C.imgMeta[v.photo_id] || { w: 0, h: 0 };
    const svg = $("calSvgL");
    svg.setAttribute("width", meta.w);
    svg.setAttribute("height", meta.h);
    svg.textContent = "";
    const s = C.viewL.s;
    const res = residualsOf();
    v.points.forEach((p, i) => {
      const g = el("g", {}, svg);
      const r = res[p.id];
      if (r && isFinite(r.backX) && !p.excluded)
        drawArrow(g, p.imgX, p.imgY, r.backX, r.backY, errColor(r.mmErr), 2.5 / s, 9 / s);
      el("circle", { cx: p.imgX, cy: p.imgY, r: 10 / s, class: cpClass(p), "stroke-width": 2 / s, "data-pt": p.id }, g)
        .addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          C.activePt = p.id;
          if (!v.frozen && !p.locked) {
            dragPt = { pt: p, moved: false };
            $("calVpL").setPointerCapture(ev.pointerId);
          }
          renderWorkspace();
        });
      const t = el("text", { x: p.imgX, y: p.imgY + 3.5 / s, class: "cp-label", "font-size": 11 / s }, g);
      t.textContent = i + 1;
    });
    applyViewL();
  }

  // 右视图的“校正前”：与左视图同步的原图（只读）
  function renderViewL2() {
    const v = C.editing;
    const meta = C.imgMeta[v.photo_id] || { w: 0, h: 0 };
    const svg = $("calSvgR2");
    svg.setAttribute("width", meta.w);
    svg.setAttribute("height", meta.h);
    svg.textContent = "";
    const s = C.viewL.s;
    v.points.forEach((p, i) => {
      el("circle", { cx: p.imgX, cy: p.imgY, r: 10 / s, class: cpClass(p), "stroke-width": 2 / s }, svg);
      const t = el("text", { x: p.imgX, y: p.imgY + 3.5 / s, class: "cp-label", "font-size": 11 / s }, svg);
      t.textContent = i + 1;
    });
    applyViewL();
  }

  // 工作区右视图的重投影位图（按当前参数）
  function ensureRectBmp() {
    const v = C.editing;
    if (!v || !v.params) { C.rectBmp = null; return; }
    const key = (v.params.ptsHash || "") + "|" + (v.params.rmsMm || "");
    if (C.rectBmp && C.rectBmp.key === key) return;
    loadPhotoImage(v.photo_id).then((img) => {
      if (!C.editing || C.editing.id !== v.id) return;
      const r = LG.calib.rectify(img, v.params, 1200);
      C.rectBmp = r ? { key, dataUrl: r.canvas.toDataURL("image/png"), bbox: r.bbox } : null;
      if (!C.flip) renderViewR();
    });
  }

  // 右视图：校正结果（面板 mm）——重投影底稿 + 网格 + 已有铅条 + 目标十字与残差箭头
  function renderViewR() {
    const v = C.editing;
    if (!v) return;
    const g = $("calRg");
    g.textContent = "";
    const s = C.viewR.s;
    const bb = contentBBoxR();
    // mm 网格
    for (let x = Math.floor(bb.x0 / 10) * 10; x <= bb.x1; x += 10)
      el("line", { x1: x, y1: bb.y0, x2: x, y2: bb.y1, class: x % 100 === 0 ? "cal-grid100" : "cal-grid", "stroke-width": (x % 100 === 0 ? 1 : 0.5) / s }, g);
    for (let y = Math.floor(bb.y0 / 10) * 10; y <= bb.y1; y += 10)
      el("line", { x1: bb.x0, y1: y, x2: bb.x1, y2: y, class: y % 100 === 0 ? "cal-grid100" : "cal-grid", "stroke-width": (y % 100 === 0 ? 1 : 0.5) / s }, g);
    // 校正底稿
    if (v.params) {
      ensureRectBmp();
      if (C.rectBmp)
        el("image", {
          href: C.rectBmp.dataUrl, x: C.rectBmp.bbox.x0, y: C.rectBmp.bbox.y0,
          width: C.rectBmp.bbox.x1 - C.rectBmp.bbox.x0, height: C.rectBmp.bbox.y1 - C.rectBmp.bbox.y0,
          opacity: 0.85, preserveAspectRatio: "none",
        }, g);
    }
    // 已有铅条与外框（只读参考：校准不移动它们）
    const d = doc();
    const nodeById = {};
    d.nodes.forEach((n) => (nodeById[n.id] = n));
    d.edges.forEach((e) => {
      const a = nodeById[e.a], b = nodeById[e.b];
      if (!a || !b) return;
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "cal-doc-edge", "stroke-width": 1.2 / s }, g);
    });
    if (d.frame)
      el("rect", { x: d.frame.x, y: d.frame.y, width: d.frame.w, height: d.frame.h, class: "cal-doc-frame", "stroke-width": 1.6 / s }, g);
    // 控制点：残差箭头（拟合→目标）+ 目标十字
    const res = residualsOf();
    v.points.forEach((p, i) => {
      if (!isFinite(p.panelX) || !isFinite(p.panelY)) return;
      const r = res[p.id];
      if (r && !p.excluded)
        drawArrow(g, r.predX, r.predY, p.panelX, p.panelY, errColor(r.mmErr), 2.5 / s, 9 / s);
      const t = 8 / s, col = cpColor(p);
      el("line", { x1: p.panelX - t, y1: p.panelY, x2: p.panelX + t, y2: p.panelY, stroke: col, "stroke-width": 2 / s, class: "cp-target" }, g);
      el("line", { x1: p.panelX, y1: p.panelY - t, x2: p.panelX, y2: p.panelY + t, stroke: col, "stroke-width": 2 / s, class: "cp-target" }, g);
      if (p.id === C.activePt)
        el("circle", { cx: p.panelX, cy: p.panelY, r: 12 / s, fill: "none", stroke: "#e67e22", "stroke-width": 2.5 / s }, g);
      const lb = el("text", { x: p.panelX + 11 / s, y: p.panelY - 9 / s, "font-size": 11 / s, fill: col, "font-weight": 700 }, g);
      lb.textContent = i + 1;
      el("circle", { cx: p.panelX, cy: p.panelY, r: 11 / s, class: "cp-hit" }, g)
        .addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          C.activePt = p.id;
          if (!v.frozen && !p.locked) {
            dragCross = { pt: p, moved: false };
            $("calVpR").setPointerCapture(ev.pointerId);
          }
          renderWorkspace();
        });
    });
    applyViewR();
  }

  // ---------- 控制点表 ----------
  const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
  function arrowChar(deg) {
    return ARROWS[((Math.round(deg / 45) % 8) + 8) % 8];
  }

  function renderTable() {
    const v = C.editing;
    const tb = $("calTbody");
    tb.textContent = "";
    const res = residualsOf();
    v.points.forEach((p, i) => {
      const r = res[p.id];
      const complete = isFinite(p.panelX) && isFinite(p.panelY);
      const tr = document.createElement("tr");
      tr.className =
        (p.id === C.activePt ? "active " : "") +
        (p.excluded ? "excluded " : "") +
        (!complete && !p.excluded ? "incomplete" : "");
      const ro = v.frozen || p.locked;
      const numInp = (val, cb) => {
        const inp = document.createElement("input");
        inp.type = "number"; inp.step = "0.5";
        inp.value = isFinite(val) ? Math.round(val * 100) / 100 : "";
        inp.disabled = ro;
        inp.addEventListener("change", () => {
          const n = parseFloat(inp.value);
          if (!isFinite(n)) { inp.value = isFinite(val) ? val : ""; return; }
          cb(n);
          pointMutated();
        });
        inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        return inp;
      };
      const td = (node) => { const c = document.createElement("td"); if (node != null) c.append(node); return c; };
      tr.append(
        td(document.createTextNode("P" + (i + 1) + (p.locked ? " 🔒" : ""))),
        td(numInp(p.imgX, (n) => { p.imgX = n; })),
        td(numInp(p.imgY, (n) => { p.imgY = n; })),
        td(numInp(p.panelX, (n) => { p.panelX = n; })),
        td(numInp(p.panelY, (n) => { p.panelY = n; })),
        td(document.createTextNode(r && !p.excluded ? `${arrowChar(r.angDeg)} ${r.angDeg.toFixed(0)}°` : "—")),
        td(document.createTextNode(r && !p.excluded ? r.pxErr.toFixed(2) + " px" : "—")),
        td(document.createTextNode(r && !p.excluded ? r.mmErr.toFixed(2) + " mm" : "—"))
      );
      // 锁定
      const lock = document.createElement("input");
      lock.type = "checkbox"; lock.checked = !!p.locked; lock.disabled = v.frozen;
      lock.title = "锁定可信点：不可拖动/删除，始终参与拟合";
      lock.addEventListener("change", () => {
        p.locked = lock.checked;
        if (p.locked) p.excluded = false;
        pointMutated();
      });
      lock.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      // 排除
      const excl = document.createElement("input");
      excl.type = "checkbox"; excl.checked = !!p.excluded; excl.disabled = v.frozen || p.locked;
      excl.title = "暂时排除异常点：不参与拟合，但保留在方案中";
      excl.addEventListener("change", () => { p.excluded = excl.checked; pointMutated(); });
      excl.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      // 删除
      const del = document.createElement("button");
      del.textContent = "✕"; del.className = "mini danger";
      del.disabled = v.frozen || p.locked;
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        v.points = v.points.filter((x) => x.id !== p.id);
        if (C.activePt === p.id) C.activePt = null;
        pointMutated();
      });
      const tdLock = document.createElement("td"); tdLock.append(lock);
      const tdExcl = document.createElement("td"); tdExcl.append(excl);
      const tdDel = document.createElement("td"); tdDel.append(del);
      tr.append(tdLock, tdExcl, tdDel);
      tr.addEventListener("click", () => { C.activePt = p.id; renderWorkspace(); });
      tb.append(tr);
    });
  }

  function pointMutated() {
    saveVersion(false);
    renderWorkspace();
  }

  // ---------- 计算 / 冻结 ----------
  function computeNow() {
    const v = C.editing;
    if (!v || v.frozen) return;
    try {
      v.params = LG.calib.compute(v.points, v.method);
    } catch (e) {
      toast(e.message);
      return;
    }
    C.rectBmp = null;
    saveVersion(true);
    renderWorkspace();
    toast(`校正完成：RMS ${v.params.rmsMm.toFixed(2)} mm / ${v.params.rmsPx.toFixed(1)} px（${v.params.nPts} 点）`);
  }

  function freezeToggle() {
    const v = C.editing;
    if (!v) return;
    if (v.frozen) {
      if (!confirm("解冻后可修改点集；建议改为「复制」方案另建版本调整。仍要解冻？")) return;
      v.frozen = false;
      saveVersion(true).then(renderPanel);
      renderWorkspace();
      return;
    }
    if (!v.params) return toast("请先计算校正");
    if (isStale(v)) return toast("点集已修改，请重新计算校正后再冻结");
    v.frozen = true;
    saveVersion(true);
    // 冻结即选定：设为当前画布底稿（只改底稿，不动节点与铅条）
    doc().underlay.versionId = v.id;
    doc().underlay.visible = true;
    LG.app.requestSave();
    refreshUnderlay();
    renderWorkspace();
    renderPanel();
    toast("已冻结变换参数并设为当前底稿；节点与铅条未变动");
  }

  // ---------- 视口交互 ----------
  function onDownL(ev) {
    if (ev.button === 1 || C.spaceDown) {
      panDrag = { view: C.viewL, apply: applyViewL, sx: ev.clientX, sy: ev.clientY, tx: C.viewL.tx, ty: C.viewL.ty };
      $("calVpL").setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const v = C.editing;
    if (!v) return;
    if (v.frozen) return toast("方案已冻结；请复制方案后调整点集");
    const p = toImgL(ev);
    const meta = C.imgMeta[v.photo_id];
    if (meta) {
      p.x = Math.max(0, Math.min(meta.w, p.x));
      p.y = Math.max(0, Math.min(meta.h, p.y));
    }
    const pt = {
      id: "cp" + Date.now().toString(36) + (C.ptSeq++).toString(36),
      imgX: Math.round(p.x * 10) / 10, imgY: Math.round(p.y * 10) / 10,
      panelX: null, panelY: null, locked: false, excluded: false,
    };
    v.points.push(pt);
    C.activePt = pt.id;
    pointMutated();
    toast(`已标记 P${v.points.length}，请在右侧校正视图点击对应面板位置，或在表中输入坐标`);
  }

  function onDownR(ev) {
    if (ev.button === 1 || C.spaceDown) {
      panDrag = C.flip
        ? { view: C.viewL, apply: applyViewL, sx: ev.clientX, sy: ev.clientY, tx: C.viewL.tx, ty: C.viewL.ty }
        : { view: C.viewR, apply: applyViewR, sx: ev.clientX, sy: ev.clientY, tx: C.viewR.tx, ty: C.viewR.ty };
      $("calVpR").setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0 || C.flip) return;
    const v = C.editing;
    if (!v) return;
    if (v.frozen) return toast("方案已冻结；请复制方案后调整点集");
    const p = toMmR(ev);
    const active = v.points.find((x) => x.id === C.activePt);
    if (!active) return toast("请先在左侧原图点击标记控制点");
    if (active.locked) return toast("该点已锁定");
    active.panelX = Math.round(p.x * 10) / 10;
    active.panelY = Math.round(p.y * 10) / 10;
    // 自动前进到下一个未填坐标的点
    const next = v.points.find((x) => !x.excluded && !(isFinite(x.panelX) && isFinite(x.panelY)));
    C.activePt = next ? next.id : active.id;
    pointMutated();
  }

  function onMove(ev) {
    if (panDrag) {
      panDrag.view.tx = panDrag.tx + (ev.clientX - panDrag.sx);
      panDrag.view.ty = panDrag.ty + (ev.clientY - panDrag.sy);
      panDrag.apply();
      return;
    }
    if (dragPt) {
      const p = toImgL(ev);
      const meta = C.imgMeta[C.editing.photo_id];
      dragPt.pt.imgX = Math.round(Math.max(0, Math.min(meta ? meta.w : p.x, p.x)) * 10) / 10;
      dragPt.pt.imgY = Math.round(Math.max(0, Math.min(meta ? meta.h : p.y, p.y)) * 10) / 10;
      dragPt.moved = true;
      renderViewL();
      return;
    }
    if (dragCross) {
      const p = toMmR(ev);
      dragCross.pt.panelX = Math.round(p.x * 10) / 10;
      dragCross.pt.panelY = Math.round(p.y * 10) / 10;
      dragCross.moved = true;
      renderViewR();
      return;
    }
  }

  function onUp() {
    if (panDrag) { panDrag = null; return; }
    if (dragPt) { const m = dragPt.moved; dragPt = null; if (m) pointMutated(); return; }
    if (dragCross) { const m = dragCross.moved; dragCross = null; if (m) pointMutated(); return; }
  }

  function onWheel(ev) {
    if (!C.editing) return;
    ev.preventDefault();
    if (ev.currentTarget === $("calVpL")) zoomView(C.viewL, $("calVpL"), ev);
    else if (C.flip) zoomView(C.viewL, $("calVpR"), ev);
    else zoomView(C.viewR, $("calVpR"), ev);
    renderActiveViews();
  }

  // ---------- 初始化 ----------
  function init() {
    $("calClose").addEventListener("click", closeWorkspace);
    $("calCompute").addEventListener("click", computeNow);
    $("calFreeze").addEventListener("click", freezeToggle);
    $("calFitL").addEventListener("click", () => { fitViewL(); renderActiveViews(); });
    $("calFitR").addEventListener("click", () => {
      if (C.flip) fitViewL(); else fitViewR();
      renderActiveViews();
    });
    $("calFlip").addEventListener("click", () => { C.flip = !C.flip; renderWorkspace(); });
    $("calVerName").addEventListener("change", () => {
      if (!C.editing) return;
      C.editing.name = $("calVerName").value.trim().slice(0, 80) || C.editing.name;
      saveVersion(true).then(renderPanel);
    });
    $("calMethod").addEventListener("change", () => {
      if (!C.editing || C.editing.frozen) return;
      C.editing.method = $("calMethod").value;
      pointMutated();
    });
    const vpL = $("calVpL"), vpR = $("calVpR");
    vpL.addEventListener("pointerdown", onDownL);
    vpR.addEventListener("pointerdown", onDownR);
    [vpL, vpR].forEach((vp) => {
      vp.addEventListener("pointermove", onMove);
      vp.addEventListener("pointerup", onUp);
      vp.addEventListener("wheel", onWheel, { passive: false });
    });
    window.addEventListener("keydown", (ev) => {
      if (!$("calibModal").classList.contains("show")) return;
      if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
      if (ev.code === "Space") { C.spaceDown = true; ev.preventDefault(); }
      if (ev.key === "Escape") closeWorkspace();
    });
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "Space") C.spaceDown = false;
    });
  }

  LG.calibui = { init, loadProjectData, renderPanel, refreshUnderlay, openWorkspace };
  document.addEventListener("DOMContentLoaded", init);
})(window);
