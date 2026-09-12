/* main.js — 应用状态、重算管线、侧面板（检查/片属性/次序/设置）、项目管理、纸样预览 */
(function (root) {
  const LG = (root.LG = root.LG || {});

  const PALETTE = ["#e8a0a0", "#a0c4e8", "#a8e0a8", "#e8d39a", "#c9aee0", "#e8b98a", "#9ad6d0", "#e0a8c0"];

  function defaultDoc() {
    return {
      version: 1,
      settings: {
        leadFaceWidth: 6,     // 铅条面宽 mm
        heartWidth: 1.2,      // 铅芯宽 mm
        channelDepth: 5,      // 槽深 mm
        grindAllowance: 1.5,  // 研磨余量 mm（总量）
        minGlassWidth: 25,    // 过窄玻璃阈值 mm
        minCutSize: 8,        // 扣除铅芯后最小净尺寸 mm
        reflexTol: 2,         // 内凹角容差 °
        pageWidth: 210, pageHeight: 297, pageMargin: 10, overlap: 15,
      },
      frame: null,
      bars: [],
      nodes: [],
      edges: [],
      pieces: [],
      sequence: { startCorner: "tl", steps: [], custom: false },
      // 现场底稿：当前叠放的校准版本与显示状态（几何不受影响）
      underlay: { versionId: null, visible: true, opacity: 0.55, crop: null, printFaint: false },
      // 铅条下料与接头编排（规格/编排/锁定/余料/历史方案随项目入库；计算在服务端）
      cutting: LG.cutting ? LG.cutting.defaultCutting() : null,
    };
  }

  LG.state = {
    projectId: null,
    projectName: "",
    doc: defaultDoc(),
    facePieces: [],
    issues: [],
    selection: null,
    tool: "select",
    view: { s: 3, tx: 100, ty: 60 },
    snapInd: null,
    flashAt: null,
    stepHighlight: [],
    underlayBmp: null,   // 当前底稿的重投影位图 {key,dataUrl,bbox}
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);
  const st = () => LG.state;
  const doc = () => LG.state.doc;

  // ---------- 重算管线 ----------
  let rafPending = false;
  function recompute() {
    const d = doc();
    const faces = LG.g.extractFaces(d.nodes, d.edges);
    const matched = LG.g.matchPieces(faces.pieces, d.pieces);
    // 未匹配上的旧片 → 丢弃；新面 → 新建片
    const usedIds = new Set();
    let maxNum = d.pieces.reduce((m, p) => Math.max(m, p.num || 0), 0);
    matched.forEach((m) => {
      if (!m.piece) {
        m.piece = {
          id: LG.editor.uid("p"),
          num: ++maxNum,
          color: PALETTE[(maxNum - 1) % PALETTE.length],
          grain: 0,
        };
      }
      m.piece.cx = m.face.cx;
      m.piece.cy = m.face.cy;
      usedIds.add(m.piece.id);
    });
    d.pieces = d.pieces.filter((p) => usedIds.has(p.id));
    // 新片入册
    matched.forEach((m) => {
      if (!d.pieces.includes(m.piece)) d.pieces.push(m.piece);
    });
    // 按质心排序显示（编号本身保留）
    st().facePieces = matched;
    const geomIssues = LG.checks.run(d, matched);
    st().issues = mergeIssues(geomIssues, cuttingIssues());
    renderSidePanels();
    LG.editor.render();
    LG.cutting.scheduleCompute();
    scheduleSave();
  }

  // 下料问题（服务端计算）与几何检查合并；结果未到时先只显示几何问题
  function cuttingIssues() {
    const res = LG.cutting ? LG.cutting.result() : null;
    if (!res || !st().projectId) return [];
    return res.issues.map((i) => ({ ...i }));
  }

  // 服务端异步返回后刷新问题列表/徽标，不触发几何重算
  function refreshIssues() {
    st().issues = mergeIssues(
      LG.checks.run(doc(), st().facePieces),
      cuttingIssues()
    );
    renderIssues();
    updateCounts();
  }

  function mergeIssues(a, b) {
    // id 前缀不同（i* / cj*），直接拼接
    return (a || []).concat(b || []);
  }

  function onGeomChanged() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      recompute();
    });
  }

  // ---------- 保存 ----------
  let saveTimer = null;
  function scheduleSave() {
    st().dirty = true;
    setSaveStatus("未保存…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1200);
  }
  async function saveNow() {
    if (!st().projectId) return;
    setSaveStatus("保存中…");
    try {
      await api("PUT", "/api/projects/" + st().projectId, { doc: doc(), name: st().projectName });
      st().dirty = false;
      setSaveStatus("已保存 " + new Date().toLocaleTimeString());
    } catch (e) {
      setSaveStatus("保存失败");
    }
  }
  function setSaveStatus(t) { $("saveStatus").textContent = t; }

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  // ---------- 工具 ----------
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function setTool(tool) {
    LG.editor.cancelDraft();
    st().tool = tool;
    document.querySelectorAll("#toolbar button[data-tool]").forEach((b) =>
      b.classList.toggle("active", b.dataset.tool === tool)
    );
    $("canvas").style.cursor =
      { select: "default", lead: "crosshair", bar: "crosshair", frame: "crosshair", split: "cell", piece: "pointer", pan: "grab" }[tool] || "default";
    const hints = {
      select: "选择/拖动节点（Delete 删除，双击边拆分）",
      frame: "拖出面板外框矩形",
      bar: "拖出支撑条（Shift 水平/垂直）",
      lead: "逐点铺设铅条中心线，双击或回车结束，Esc 取消",
      split: "点击铅条/外框边，在该处插入节点拆分",
      piece: "点击玻璃片，编辑编号/颜色/纹理方向",
    };
    $("toolHint").textContent = hints[tool] || "";
  }

  // ---------- 侧面板 ----------
  function renderSidePanels() {
    renderIssues();
    renderPiecePanel();
    renderSeqPanel();
    if (LG.cutting) LG.cutting.renderPanel();
    if (LG.calibui) LG.calibui.renderPanel();
    updateCounts();
  }

  function updateCounts() {
    $("pieceCount").textContent = `玻璃片 ${st().facePieces.length} · 节点 ${doc().nodes.length} · 铅条 ${doc().edges.length}`;
    const errs = st().issues.filter((i) => i.severity === "error").length;
    const warns = st().issues.length - errs;
    $("issueBadge").textContent = st().issues.length ? `${errs} 错 / ${warns} 警` : "无问题";
    $("issueBadge").className = "badge " + (errs ? "bad" : warns ? "warn" : "ok");
  }

  const ISSUE_TYPE_NAME = {
    dangling: "悬空端点", crossing: "交叉缺节点", narrow: "过窄玻璃",
    reflex: "内凹角", undersize: "净尺寸不足",
    joint_close: "接头过近", overlength: "铅条超长", spec_mismatch: "规格不一致",
    miter_unpaired: "斜接落单", miter_sharp: "斜接过锐", no_through: "无连续路",
    spec_missing: "缺规格", closed_loop: "闭合环",
  };

  function renderIssues() {
    const box = $("issueList");
    box.textContent = "";
    if (!st().issues.length) {
      box.innerHTML = `<div class="empty">✓ 未发现问题</div>`;
      return;
    }
    st().issues.forEach((iss) => {
      const div = document.createElement("div");
      div.className = "issue-item " + iss.severity;
      div.innerHTML = `<b>[${ISSUE_TYPE_NAME[iss.type] || iss.type}]</b> ${iss.msg}`;
      div.addEventListener("click", () => {
        selectIssue(iss.id);
      });
      if (iss.type === "crossing") {
        const btn = document.createElement("button");
        btn.textContent = "修复";
        btn.className = "mini";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          fixCrossing(iss);
        });
        div.appendChild(btn);
      }
      div.dataset.iid = iss.id;
      box.appendChild(div);
    });
  }

  function selectIssue(iid) {
    const iss = st().issues.find((i) => i.id === iid);
    if (!iss) return;
    document.querySelectorAll(".issue-item").forEach((d) =>
      d.classList.toggle("active", d.dataset.iid === iid)
    );
    showTab("issues");
    LG.editor.locate(iss.x, iss.y);
  }

  function fixCrossing(iss) {
    const { edgeA, edgeB, x, y } = iss.data;
    const n1 = LG.editor.splitEdge(edgeA, x, y);
    if (edgeB) {
      const n2 = LG.editor.splitEdge(edgeB, x, y);
      if (n1 && n2 && n1 !== n2) LG.editor.mergeNodes(n1, n2);
    } else if (n1) {
      // 边穿过已有节点：拆分后把新节点并入该节点
      const near = doc().nodes.find((n) => n.id !== n1 && Math.hypot(n.x - x, n.y - y) < 0.1);
      if (near) LG.editor.mergeNodes(near.id, n1);
    }
    toast("已在交叉处加节点");
    onGeomChanged();
  }

  // ---------- 片属性 ----------
  function renderPiecePanel() {
    const sel = st().selection;
    const box = $("piecePanel");
    if (!sel || sel.kind !== "piece") {
      const list = st().facePieces
        .map((fp) => fp.piece)
        .sort((a, b) => a.num - b.num)
        .map((p) => `<span class="chip" data-pid="${p.id}" style="border-color:${p.color}">${p.num}</span>`)
        .join("");
      box.innerHTML = `<div class="empty">用“片属性”工具点击玻璃片，或从下面选择：</div><div class="chips">${list || "暂无玻璃片"}</div>`;
      box.querySelectorAll(".chip").forEach((c) =>
        c.addEventListener("click", () => {
          st().selection = { kind: "piece", id: c.dataset.pid };
          onSelectionChanged();
          const fp = st().facePieces.find((x) => x.piece.id === c.dataset.pid);
          if (fp) LG.editor.locate(fp.face.cx, fp.face.cy);
        })
      );
      return;
    }
    const fp = st().facePieces.find((x) => x.piece && x.piece.id === sel.id);
    if (!fp) { box.innerHTML = `<div class="empty">该片已不存在</div>`; return; }
    const p = fp.piece;
    const area = Math.abs(fp.face.area) / 100; // cm²
    box.innerHTML = `
      <label>编号 <input id="ppNum" type="number" min="1" value="${p.num}"></label>
      <label>颜色 <input id="ppColor" type="color" value="${p.color}"></label>
      <label>纹理方向 <input id="ppGrain" type="number" step="5" value="${p.grain || 0}"> °（0=水平）</label>
      <div class="muted">面积约 ${area.toFixed(1)} cm² · 质心 (${fp.face.cx.toFixed(0)}, ${fp.face.cy.toFixed(0)}) mm</div>`;
    $("ppNum").addEventListener("change", () => { p.num = Math.max(1, parseInt($("ppNum").value) || p.num); onGeomChanged(); });
    $("ppColor").addEventListener("input", () => { p.color = $("ppColor").value; onGeomChanged(); });
    $("ppGrain").addEventListener("change", () => { p.grain = ((parseFloat($("ppGrain").value) || 0) % 180 + 180) % 180; onGeomChanged(); });
  }

  function onSelectionChanged() {
    renderPiecePanel();
    if (LG.cutting) LG.cutting.renderPanel();
    LG.editor.render();
    const sel = st().selection;
    if (sel && sel.kind === "piece") showTab("piece");
    if (sel && (sel.kind === "member" || sel.kind === "node")) showTab("lead");
  }

  // ---------- 次序 ----------
  function ensureSequence() {
    const d = doc();
    if (!d.sequence.custom || !d.sequence.steps.length) {
      d.sequence.steps = LG.seq.generate(d, st().facePieces, d.sequence.startCorner);
      d.sequence.custom = false;
    } else {
      // 手动次序：几何可能已变化，调和步骤使其覆盖当前全部铅条/玻璃片
      LG.seq.reconcile(d, st().facePieces);
    }
    return d.sequence.steps;
  }

  function seqViolations() {
    return LG.seq.validate(doc(), st().facePieces, doc().sequence.steps || []);
  }

  function stepLabel(s) {
    const d = doc();
    if (s.type === "lead") {
      const e = d.edges.find((x) => x.id === s.ref);
      if (!e) return "放铅（已失效）";
      const a = d.nodes.find((n) => n.id === e.a), b = d.nodes.find((n) => n.id === e.b);
      const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
      const res = LG.cutting ? LG.cutting.result() : null;
      const mid = res && res.memberOfEdge ? res.memberOfEdge[e.id] : null;
      const m = mid && res.members.find((x) => x.id === mid);
      const tag = m ? `#${m.num}（下料 ${m.length.toFixed(0)}mm${m.locked ? "·已锁" : ""}）` : "";
      return `放铅条 ${e.kind === "frame" ? "（外框边）" : ""} ${len.toFixed(0)}mm ${tag}`;
    }
    if (s.type === "piece") {
      const p = d.pieces.find((x) => x.id === s.ref);
      return `嵌玻璃 片 ${p ? p.num : "?"}`;
    }
    const n = d.nodes.find((x) => x.id === s.ref);
    return `焊点 (${n ? n.x.toFixed(0) + "," + n.y.toFixed(0) : "?"})`;
  }

  function renderSeqPanel() {
    const d = doc();
    $("seqCorner").value = d.sequence.startCorner;
    const steps = ensureSequence();
    const violations = seqViolations();
    const badSteps = new Set(violations.map((v) => v.stepIndex));
    const box = $("seqList");
    box.textContent = "";
    $("seqStatus").innerHTML = violations.length
      ? `<span class="bad-text">⚠ ${violations.length} 处次序问题</span>`
      : `<span class="ok-text">✓ 次序可行（${steps.length} 步）</span>`;
    steps.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "seq-step" + (badSteps.has(i) ? " bad" : "");
      const icon = { lead: "▭", piece: "◧", solder: "⚡" }[s.type];
      row.innerHTML = `<span class="seq-idx">${i + 1}</span><span class="seq-icon">${icon}</span><span class="seq-label">${stepLabel(s)}</span>`;
      const up = document.createElement("button");
      up.textContent = "↑"; up.className = "mini";
      up.disabled = i === 0;
      up.addEventListener("click", (ev) => { ev.stopPropagation(); moveStep(i, -1); });
      const dn = document.createElement("button");
      dn.textContent = "↓"; dn.className = "mini";
      dn.disabled = i === steps.length - 1;
      dn.addEventListener("click", (ev) => { ev.stopPropagation(); moveStep(i, 1); });
      row.appendChild(up); row.appendChild(dn);
      row.addEventListener("click", () => {
        st().stepHighlight = [s];
        LG.editor.render();
        locateStepTarget(s);
      });
      box.appendChild(row);
    });
    // 违规明细
    const vb = $("seqViolations");
    vb.innerHTML = violations
      .map((v) => {
        let extra = "";
        if (v.type === "sealed") {
          const p = doc().pieces.find((x) => x.id === v.pieceId);
          extra = `（被挡：片 ${p ? p.num : "?"}）`;
        }
        return `<div class="vio" data-vstep="${v.stepIndex != null ? v.stepIndex : ""}" data-vio='${JSON.stringify({ t: v.type, e: v.edgeId || "", p: v.pieceId || "", n: v.nodeId || "" })}'>⚠ ${v.msg}${extra}</div>`;
      })
      .join("");
    vb.querySelectorAll(".vio").forEach((dEl) =>
      dEl.addEventListener("click", () => {
        const meta = JSON.parse(dEl.dataset.vio);
        const idx = dEl.dataset.vstep === "" ? -1 : parseInt(dEl.dataset.vstep);
        let target = null;
        if (idx >= 0) target = doc().sequence.steps[idx];
        else if (meta.e) target = { type: "lead", ref: meta.e };
        else if (meta.p) target = { type: "piece", ref: meta.p };
        else if (meta.n) target = { type: "solder", ref: meta.n };
        if (target) {
          st().stepHighlight = [target];
          LG.editor.render();
          locateStepTarget(target);
        }
      })
    );
  }

  function locateStepTarget(s) {
    const d2 = doc();
    if (s.type === "lead") {
      const e = d2.edges.find((x) => x.id === s.ref);
      const a = e && d2.nodes.find((n) => n.id === e.a), b = e && d2.nodes.find((n) => n.id === e.b);
      if (a && b) LG.editor.locate((a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (s.type === "piece") {
      const fp = st().facePieces.find((x) => x.piece && x.piece.id === s.ref);
      if (fp) LG.editor.locate(fp.face.cx, fp.face.cy);
    } else {
      const n = d2.nodes.find((x) => x.id === s.ref);
      if (n) LG.editor.locate(n.x, n.y);
    }
  }

  function moveStep(i, dir) {
    const steps = doc().sequence.steps;
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    doc().sequence.custom = true;
    renderSeqPanel();
    scheduleSave();
  }

  // ---------- 设置 ----------
  function bindSettings() {
    const S = () => doc().settings;
    const fields = [
      ["setFaceWidth", "leadFaceWidth"], ["setHeart", "heartWidth"],
      ["setChannel", "channelDepth"], ["setGrind", "grindAllowance"],
      ["setMinWidth", "minGlassWidth"], ["setMinCut", "minCutSize"],
      ["setPageW", "pageWidth"], ["setPageH", "pageHeight"],
      ["setPageMargin", "pageMargin"], ["setOverlap", "overlap"],
    ];
    fields.forEach(([id, key]) => {
      $(id).value = S()[key];
      $(id).addEventListener("change", () => {
        S()[key] = parseFloat($(id).value) || S()[key];
        onGeomChanged();
      });
    });
    // 外框尺寸
    const f = doc().frame;
    $("frameW").value = f ? f.w : "";
    $("frameH").value = f ? f.h : "";
    $("applyFrameSize").addEventListener("click", () => {
      const d = doc();
      if (!d.frame) return toast("请先用“外框”工具画出外框");
      const nw = parseFloat($("frameW").value), nh = parseFloat($("frameH").value);
      if (!(nw > 20 && nh > 20)) return toast("尺寸无效");
      const sx = nw / d.frame.w, sy = nh / d.frame.h;
      d.nodes.forEach((n) => {
        n.x = d.frame.x + (n.x - d.frame.x) * sx;
        n.y = d.frame.y + (n.y - d.frame.y) * sy;
      });
      d.bars.forEach((b) => {
        b.x1 = d.frame.x + (b.x1 - d.frame.x) * sx; b.x2 = d.frame.x + (b.x2 - d.frame.x) * sx;
        b.y1 = d.frame.y + (b.y1 - d.frame.y) * sy; b.y2 = d.frame.y + (b.y2 - d.frame.y) * sy;
      });
      d.frame.w = nw; d.frame.h = nh;
      onGeomChanged();
      LG.editor.fitView();
      toast("已按比例缩放全部几何");
    });
  }

  // ---------- 页签 ----------
  function showTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  }

  // ---------- 项目 ----------
  async function openProjectList() {
    const list = await api("GET", "/api/projects");
    const box = $("projList");
    box.innerHTML = list.length
      ? list
          .map(
            (p) => `<div class="proj-item" data-pid="${p.id}">
              <span class="proj-name">${p.name}</span>
              <span class="muted">${new Date(p.updated_at * 1000).toLocaleString()}</span>
              <button class="mini" data-open="${p.id}">打开</button>
              <button class="mini danger" data-del="${p.id}">删除</button>
            </div>`
          )
          .join("")
      : `<div class="empty">暂无项目</div>`;
    box.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => loadProject(parseInt(b.dataset.open)))
    );
    box.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("确定删除该项目？")) return;
        await api("DELETE", "/api/projects/" + b.dataset.del);
        openProjectList();
      })
    );
    $("projModal").classList.add("show");
  }

  async function loadProject(pid) {
    const p = await api("GET", "/api/projects/" + pid);
    st().projectId = p.id;
    st().projectName = p.name;
    st().doc = p.doc || defaultDoc();
    const df = defaultDoc();
    st().doc.settings = Object.assign(df.settings, st().doc.settings || {});
    ["nodes", "edges", "pieces", "bars"].forEach((k) => {
      if (!Array.isArray(st().doc[k])) st().doc[k] = [];
    });
    if (!st().doc.frame) st().doc.frame = null;
    st().doc.sequence = st().doc.sequence || { startCorner: "tl", steps: [], custom: false };
    st().doc.underlay = Object.assign(df.underlay, st().doc.underlay || {});
    st().doc.cutting = LG.cutting.ensure(st().doc);
    st().cutState = null;
    st().selection = null;
    st().underlayBmp = null;
    $("projName").value = p.name;
    $("projModal").classList.remove("show");
    bindSettings();
    recompute();
    LG.editor.fitView();
    setSaveStatus("已加载");
    // 恢复底稿照片与全部校准版本
    if (LG.calibui) LG.calibui.loadProjectData(p.id);
  }

  async function newProject() {
    const name = prompt("项目名称：", "新面板 " + new Date().toLocaleDateString());
    if (name === null) return;
    const r = await api("POST", "/api/projects", { name, doc: defaultDoc() });
    await loadProject(r.id);
  }

  async function loadSample() {
    const d = defaultDoc();
    // 600×800 面板 + 一根支撑条 + 网格铅条
    d.settings.leadFaceWidth = 6;
    const W = 600, H = 800;
    d.frame = { x: 0, y: 0, w: W, h: H };
    const N = {};
    const nid = (k, x, y) => { N[k] = { id: "sn_" + k, x, y }; d.nodes.push(N[k]); };
    nid("tl", 0, 0); nid("tr", W, 0); nid("br", W, H); nid("bl", 0, H);
    nid("t1", 200, 0); nid("t2", 400, 0);
    nid("b1", 200, H); nid("b2", 400, H);
    nid("l1", 0, 260); nid("l2", 0, 530);
    nid("r1", W, 260); nid("r2", W, 530);
    nid("c1", 200, 260); nid("c2", 400, 260); nid("c3", 200, 530); nid("c4", 400, 530);
    const E = (a, b, kind) => d.edges.push({ id: "se_" + a + "_" + b, a: N[a].id, b: N[b].id, kind: kind || "lead" });
    E("tl", "t1", "frame"); E("t1", "t2", "frame"); E("t2", "tr", "frame");
    E("tr", "r1", "frame"); E("r1", "r2", "frame"); E("r2", "br", "frame");
    E("br", "b2", "frame"); E("b2", "b1", "frame"); E("b1", "bl", "frame");
    E("bl", "l2", "frame"); E("l2", "l1", "frame"); E("l1", "tl", "frame");
    E("t1", "c1"); E("c1", "c3"); E("c3", "b1");
    E("t2", "c2"); E("c2", "c4"); E("c4", "b2");
    E("l1", "c1"); E("c1", "c2"); E("c2", "r1");
    E("l2", "c3"); E("c3", "c4"); E("c4", "r2");
    d.bars.push({ id: "sb1", x1: 0, y1: 400, x2: W, y2: 400 });
    const name = "示例面板 " + new Date().toLocaleTimeString();
    const r = await api("POST", "/api/projects", { name, doc: d });
    await loadProject(r.id);
    toast("已载入示例面板");
  }

  // ---------- 纸样预览 ----------
  function openPrint() {
    const d = doc();
    if (!d.frame) return toast("请先画外框");
    const layout = LG.print.computePages(d);
    // 淡印当前底稿：有可用底稿时才显示选项
    const u = d.underlay || {};
    const canU = u.versionId != null && st().underlayBmp;
    $("printUnderlayWrap").style.display = canU ? "" : "none";
    $("printUnderlay").checked = !!(canU && u.printFaint);
    // 下料卡：有选定（对照中）的历史方案时可附
    const c = LG.cutting.ensure(d);
    const cardPlan = c.plans.find((p) => p.id === c.selectedPlanId);
    $("printCardsWrap").style.display = cardPlan ? "" : "none";
    $("printCards").checked = !!cardPlan;
    const renderPages = () => {
      const showU = canU && $("printUnderlay").checked;
      const underlay = showU
        ? { dataUrl: st().underlayBmp.dataUrl, bbox: st().underlayBmp.bbox, opacity: 0.15 }
        : null;
      const box = $("printPages");
      box.innerHTML = "";
      layout.pages.forEach((pg) => {
        const div = document.createElement("div");
        div.className = "print-page";
        div.style.width = layout.pageW + "mm";
        div.style.height = layout.pageH + "mm";
        div.style.padding = layout.margin + "mm";
        div.innerHTML = LG.print.renderPageSVG(d, st().facePieces, pg, layout, underlay);
        box.appendChild(div);
      });
      if ($("printCards").checked && cardPlan) {
        const cards = document.createElement("div");
        cards.className = "print-cards";
        cards.innerHTML = LG.cutting.renderCutCardsSVG(cardPlan);
        box.appendChild(cards);
      }
    };
    $("printUnderlay").onchange = (ev) => {
      doc().underlay.printFaint = ev.target.checked;
      scheduleSave();
      renderPages();
    };
    $("printCards").onchange = renderPages;
    renderPages();
    // 动态 @page
    let stEl = $("printPageStyle");
    if (!stEl) {
      stEl = document.createElement("style");
      stEl.id = "printPageStyle";
      document.head.appendChild(stEl);
    }
    stEl.textContent = `@page{size:${layout.pageW}mm ${layout.pageH}mm;margin:0}`;
    $("printInfo").textContent =
      `面板 ${d.frame.w}×${d.frame.h}mm · ${layout.cols}×${layout.rows} 共 ${layout.pages.length} 页 · ` +
      `纸张 ${layout.pageW}×${layout.pageH}mm · 重叠 ${layout.overlap}mm · 打印请选 100% 缩放`;
    $("printOverlay").classList.add("show");
  }

  // ---------- 启动 ----------
  async function boot() {
    LG.editor.init($("canvas"));
    // 工具栏
    document.querySelectorAll("#toolbar button[data-tool]").forEach((b) =>
      b.addEventListener("click", () => setTool(b.dataset.tool))
    );
    $("zoomIn").addEventListener("click", () => { st().view.s = Math.min(40, st().view.s * 1.25); LG.editor.render(); });
    $("zoomOut").addEventListener("click", () => { st().view.s = Math.max(0.2, st().view.s / 1.25); LG.editor.render(); });
    $("zoomFit").addEventListener("click", () => LG.editor.fitView());
    // 页签
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.addEventListener("click", () => showTab(b.dataset.tab))
    );
    // 顶栏
    $("btnProjects").addEventListener("click", openProjectList);
    $("btnNew").addEventListener("click", newProject);
    $("btnSample").addEventListener("click", loadSample);
    $("btnSave").addEventListener("click", saveNow);
    $("btnPrint").addEventListener("click", openPrint);
    $("projName").addEventListener("change", () => {
      st().projectName = $("projName").value;
      scheduleSave();
    });
    $("closeProj").addEventListener("click", () => $("projModal").classList.remove("show"));
    // 次序面板
    $("seqCorner").addEventListener("change", () => {
      doc().sequence.startCorner = $("seqCorner").value;
      doc().sequence.custom = false;
      renderSeqPanel();
      scheduleSave();
    });
    $("seqRegen").addEventListener("click", () => {
      doc().sequence.custom = false;
      doc().sequence.steps = [];
      renderSeqPanel();
      scheduleSave();
      toast("已重新生成次序");
    });
    // 打印
    $("closePrint").addEventListener("click", () => $("printOverlay").classList.remove("show"));
    $("doPrint").addEventListener("click", () => window.print());

    setTool("select");
    bindSettings();

    // 打开最近项目，否则新建
    const list = await api("GET", "/api/projects");
    if (list.length) await loadProject(list[0].id);
    else {
      const r = await api("POST", "/api/projects", { name: "我的第一个面板", doc: defaultDoc() });
      await loadProject(r.id);
    }
  }

  LG.app = {
    onGeomChanged, onSelectionChanged, toast, setTool, selectIssue,
    fitView: () => LG.editor.fitView(),
    api, requestSave: scheduleSave, refreshIssues,
    loadProject, newProject,
  };

  document.addEventListener("DOMContentLoaded", boot);
})(window);
