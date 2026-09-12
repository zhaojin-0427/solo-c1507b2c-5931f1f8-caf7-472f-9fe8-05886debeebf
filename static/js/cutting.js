/* cutting.js — 铅条下料与接头编排：载荷组装、服务端计算、面板/画布/打印
 * 计算在 Flask 服务端 /api/cutting/compute；规格、编排、锁定、方案随项目 doc 存 SQLite。
 */
(function (root) {
  const LG = (root.LG = root.LG || {});
  const MEMBER_COLORS = ["#3d6fb4", "#2f8f5b", "#b4643d", "#7a5aa8", "#b43d6f",
    "#3d9aa8", "#a87a3d", "#5a7a3d", "#8a3d3d", "#3d5a8a", "#6a4d8a", "#8a5a3d"];

  function d() { return LG.state.doc; }
  function api(method, url, body) { return LG.app.api(method, url, body); }

  function defaultCutting() {
    return {
      specs: [{
        id: "sp_default", name: "6mm 软铅", faceWidth: 6, heart: 1.2, hardness: "软",
        stockLength: 1800, kerf: 3, minRemnant: 150, isDefault: true,
      }],
      edgeSpecs: {},
      joints: {},
      locks: [],
      slotAllowance: 4,
      minJointGap: 60,
      remnants: [],
      plans: [],
      selectedPlanId: null,
    };
  }

  function ensure(doc) {
    if (!doc.cutting) doc.cutting = defaultCutting();
    const c = doc.cutting;
    const df = defaultCutting();
    ["edgeSpecs", "joints", "locks", "remnants", "plans"].forEach((k) => {
      if (!Array.isArray(c[k]) && !(c[k] && typeof c[k] === "object")) c[k] = df[k];
    });
    if (!Array.isArray(c.specs) || !c.specs.length) c.specs = df.specs;
    ["slotAllowance", "minJointGap"].forEach((k) => {
      if (typeof c[k] !== "number") c[k] = df[k];
    });
    if (c.selectedPlanId === undefined) c.selectedPlanId = null;
    return c;
  }

  function defaultSpecId(c) {
    const s = c.specs.find((x) => x.isDefault) || c.specs[0];
    return s ? s.id : null;
  }
  function specOf(c, eid) {
    return c.edgeSpecs[eid] || defaultSpecId(c);
  }
  function memberColor(m) {
    if (m.locked) return "#7d7d7d";
    return MEMBER_COLORS[(m.num - 1) % MEMBER_COLORS.length];
  }

  // ---------- 载荷 / 计算 ----------
  function buildPayload() {
    const doc = d();
    const c = ensure(doc);
    // 构件编号要跟随放铅次序：取自动/手动步骤中的放铅边
    const order = (doc.sequence && doc.sequence.steps || [])
      .filter((s) => s.type === "lead").map((s) => s.ref);
    return {
      nodes: doc.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      edges: doc.edges.map((e) => ({ id: e.id, a: e.a, b: e.b, kind: e.kind })),
      sequenceEdgeOrder: order,
      settings: doc.settings,
      cutting: {
        specs: c.specs,
        edgeSpecs: c.edgeSpecs,
        joints: c.joints,
        locks: c.locks,
        remnants: c.remnants,
        slotAllowance: c.slotAllowance,
        minJointGap: c.minJointGap,
      },
    };
  }

  let computeToken = 0;
  let computeTimer = null;
  function scheduleCompute() {
    clearTimeout(computeTimer);
    computeTimer = setTimeout(runCompute, 220);
  }

  async function runCompute() {
    const token = ++computeToken;
    let res = null;
    try {
      res = await api("POST", "/api/cutting/compute", buildPayload());
    } catch (e) {
      LG.state.cutState = LG.state.cutState || {};
      LG.state.cutState.error = String(e.message || e);
      return;
    }
    if (token !== computeToken) return; // 又有更新，以最后一次为准
    const st = (LG.state.cutState = LG.state.cutState || {});
    st.result = res;
    st.error = null;
    st.computedAt = Date.now();
    evaluatePlans(res);
    LG.cutting.renderPanel();
    LG.editor.render();
    if (LG.app.refreshIssues) LG.app.refreshIssues();
  }

  function result() { return (LG.state.cutState || {}).result || null; }

  // ---------- 方案失效判定（几何变化只使受影响构件失效） ----------
  function planStaleness(plan, res) {
    const curById = {};
    (res.members || []).forEach((m) => { curById[m.id] = m; });
    const snapIds = new Set((plan.members || []).map((m) => m.id));
    const curIds = new Set((res.members || []).map((m) => m.id));
    const missing = [...snapIds].filter((id) => !curIds.has(id));
    const added = [...curIds].filter((id) => !snapIds.has(id));
    const changed = [];
    (plan.members || []).forEach((m) => {
      const now = curById[m.id];
      if (!now) return;
      if (Math.abs(now.length - m.length) > 0.5 ||
          now.edges.join("|") !== (m.edges || []).join("|") ||
          now.specId !== m.specId ||
          now.locked !== m.locked)
        changed.push(m.id);
    });
    return {
      stale: missing.length + added.length + changed.length > 0,
      missing, added, changed,
      label: missing.length + added.length + changed.length,
    };
  }

  function evaluatePlans(res) {
    const c = ensure(d());
    c.plans.forEach((p) => { p.staleness = planStaleness(p, res); });
    if (c.selectedPlanId && !c.plans.some((p) => p.id === c.selectedPlanId))
      c.selectedPlanId = null;
  }

  // ---------- 保存方案 ----------
  async function saveStrategy(strategy, res, name) {
    const c = ensure(d());
    const now = Date.now();
    const plan = {
      id: "pl_" + now.toString(36) + "_" + c.plans.length,
      name: name || (strategy.name + " @ " + new Date().toLocaleString()),
      createdAt: now / 1000,
      strategy: strategy.key,
      metrics: {
        newSticks: strategy.newSticks,
        wasteTotal: strategy.wasteTotal,
        kerfTotal: strategy.kerfTotal || 0,
        reusableTotal: strategy.reusableTotal,
        stickCount: strategy.stickCount,
      },
      sticks: strategy.sticks,
      consumedRemnants: strategy.consumedRemnants || [],
      members: (res.members || []).map((m) => ({
        id: m.id, num: m.num, key: m.key, edges: m.edges, length: m.length,
        centerLen: m.centerLen, specId: m.specId, specName: (res.specs[m.specId] || {}).name,
        locked: m.locked, ends: m.ends, bends: m.bends, closed: m.closed,
        cx: m.cx, cy: m.cy,
      })),
      specs: c.specs.map((s) => ({ ...s })),
      slotAllowance: c.slotAllowance,
    };
    c.plans.push(plan);
    c.selectedPlanId = plan.id;
    LG.app.requestSave();
    LG.cutting.renderPanel();
    LG.editor.render();
    return plan;
  }

  function selectPlan(id) {
    const c = ensure(d());
    c.selectedPlanId = id || null;
    LG.app.requestSave();
    LG.cutting.renderPanel();
    LG.editor.render();
  }

  function deletePlan(id) {
    const c = ensure(d());
    c.plans = c.plans.filter((p) => p.id !== id);
    if (c.selectedPlanId === id) c.selectedPlanId = null;
    LG.app.requestSave();
    LG.cutting.renderPanel();
  }

  // 旧方案快照可能没有 key（修复前保存），由边列表兜底派生
  function memberKey(m) {
    return m.key || ((m.edges || []).slice().sort().join("|"));
  }

  // 采用方案 → 排料条上的构件标记已下料（锁定）；消耗余料出库，新余段入余料池。
  // sticks 已排除已锁构件，只对条上实际出现的构件加锁。
  function adoptPlan(plan) {
    const c = ensure(d());
    // 1) 按快照 key 锁定本次下料的构件（清掉历史脏数据 null/undefined）
    const cutKeys = new Set();
    const byId = {};
    (plan.members || []).forEach((m) => { byId[m.id] = m; });
    (plan.sticks || []).forEach((s) => s.memberIds.forEach((mid) => {
      const m = byId[mid];
      const k = m && memberKey(m);
      if (k) cutKeys.add(k);
    }));
    const lockSet = new Set(c.locks.filter((k) => k));
    cutKeys.forEach((k) => lockSet.add(k));
    c.locks = [...lockSet];
    // 2) 用掉的库存余料出库，避免下轮重复使用
    const consumed = new Set(plan.consumedRemnants || []);
    c.remnants = c.remnants.filter((r) => !consumed.has(r.id));
    // 3) 本次下料留下的余段入池
    (plan.sticks || []).forEach((s, i) => {
      if (s.remnantLength == null) return;
      c.remnants.push({
        id: "rm_" + plan.id + "_" + i,
        specId: s.specId,
        length: s.remnantLength,
        fromPlan: plan.id,
        note: (s.source === "remnant" ? "余料条余段" : "新料余段"),
      });
    });
    // 4) 快照锁定状态与采用结果对齐（历史方案仍可对照）
    (plan.members || []).forEach((m) => {
      if (cutKeys.has(m.key)) m.locked = true;
    });
    LG.app.requestSave();
    scheduleCompute();
  }

  // ---------- 接头编排 ----------
  function incidentEdges(nodeId) {
    const doc = d();
    const nb = {};
    doc.nodes.forEach((n) => (nb[n.id] = n));
    return doc.edges
      .filter((e) => e.a === nodeId || e.b === nodeId)
      .map((e) => {
        const o = nb[e.a === nodeId ? e.b : e.a];
        const n = nb[nodeId];
        return { e, ang: Math.atan2(o.y - n.y, o.x - n.x) };
      })
      .sort((a, b) => a.ang - b.ang);
  }

  function nodeRoles(nodeId) {
    const c = ensure(d());
    const ex = c.joints[nodeId];
    if (ex) return { through: ex.through || [], butt: ex.butt || [], miter: ex.miter || [] };
    return null; // 交给服务端默认
  }

  function setNodeRoles(nodeId, roles) {
    const c = ensure(d());
    c.joints[nodeId] = {
      through: roles.through.slice(0, 2),
      butt: roles.butt,
      miter: roles.miter,
    };
    LG.app.requestSave();
    scheduleCompute();
  }

  function resetNodeRoles(nodeId) {
    const c = ensure(d());
    delete c.joints[nodeId];
    LG.app.requestSave();
    scheduleCompute();
  }

  // ---------- 规格 / 锁定 ----------
  function toggleLock(member) {
    const c = ensure(d());
    const i = c.locks.indexOf(member.key);
    if (i >= 0) c.locks.splice(i, 1);
    else c.locks.push(member.key);
    LG.app.requestSave();
    scheduleCompute();
  }

  function setEdgeSpec(eid, specId) {
    const c = ensure(d());
    if (specId === defaultSpecId(c)) delete c.edgeSpecs[eid];
    else c.edgeSpecs[eid] = specId;
    LG.app.requestSave();
    scheduleCompute();
  }

  function addSpec() {
    const c = ensure(d());
    const n = c.specs.length + 1;
    c.specs.push({
      id: "sp_" + Date.now().toString(36),
      name: "规格 " + n, faceWidth: 6, heart: 1.2, hardness: "中",
      stockLength: 1800, kerf: 3, minRemnant: 150, isDefault: false,
    });
    LG.app.requestSave();
    LG.cutting.renderPanel();
  }

  function removeSpec(id) {
    const c = ensure(d());
    if (c.specs.length <= 1) return LG.app.toast("至少保留一个规格");
    c.specs = c.specs.filter((s) => s.id !== id);
    Object.keys(c.edgeSpecs).forEach((eid) => {
      if (c.edgeSpecs[eid] === id) delete c.edgeSpecs[eid];
    });
    if (!c.specs.some((s) => s.isDefault)) c.specs[0].isDefault = true;
    LG.app.requestSave();
    scheduleCompute();
  }

  // ---------- 面板渲染 ----------
  const $ = (id) => document.getElementById(id);

  function renderPanel() {
    const box = $("cutPanel");
    if (!box) return;
    const doc = d();
    const c = ensure(doc);
    const res = result();
    const sel = LG.state.selection;
    const selNode = sel && sel.kind === "node" ? sel.id : null;
    const selMember = sel && sel.kind === "member" ? sel.id : null;

    let html = "";
    // 汇总状态
    if (!res) {
      html = `<div class="empty">计算中…</div>`;
    } else {
      const s = res.summary;
      const ci = res.issues.length;
      html += `<div class="cut-summary">
        <div>连续铅条 <b>${s.count}</b> 根 · 总下料 <b>${s.totalLength.toFixed(0)}</b> mm</div>
        <div>已弯/已下料锁定 <b>${s.lockedCount}</b> 根（${s.lockedLength.toFixed(0)}mm）</div>
        ${ci ? `<div class="bad-text">下料相关问题 ${ci} 项（见“检查”页）</div>` : `<div class="ok-text">✓ 无下料问题</div>`}
      </div>`;
      html += s.specs.map((x) =>
        `<div class="muted cut-specsum">${x.specName}：${x.count} 根 / ${x.length.toFixed(0)}mm` +
        (x.lockedCount ? `（锁定 ${x.lockedCount}）` : "") + `</div>`).join("");
    }

    // 规格表
    html += `<div class="cut-section-title">铅条规格（面宽 / 铅芯 / 硬度 / 库存条）
      <button class="mini" id="cutAddSpec">＋ 新规格</button></div>`;
    html += c.specs.map((s, i) => `
      <div class="cut-spec" data-sp="${s.id}">
        <div class="cut-spec-head">
          <input class="cut-spec-name" data-f="name" value="${esc(s.name)}">
          ${s.isDefault ? '<span class="cal-badge frozen">默认</span>' :
            `<button class="mini cut-mkdef" title="设为默认">设默认</button>`}
          <button class="mini danger cut-del-spec" title="删除">删</button>
        </div>
        <div class="cut-spec-grid">
          <label>面宽<input type="number" step="0.5" min="1" data-f="faceWidth" value="${s.faceWidth}"></label>
          <label>铅芯<input type="number" step="0.1" min="0.3" data-f="heart" value="${s.heart}"></label>
          <label>硬度<input type="text" data-f="hardness" value="${esc(s.hardness)}"></label>
          <label>库存条长<input type="number" step="10" min="50" data-f="stockLength" value="${s.stockLength}"></label>
          <label>锯路损耗<input type="number" step="0.5" min="0" data-f="kerf" value="${s.kerf}"></label>
          <label>最短留余<input type="number" step="10" min="0" data-f="minRemnant" value="${s.minRemnant}"></label>
        </div>
      </div>`).join("");

    // 全局参数
    html += `<div class="cut-section-title">接头与排料参数</div>
      <div class="cut-spec-grid">
        <label>槽口余量<input type="number" step="0.5" min="0" id="cutSlot" value="${c.slotAllowance}"></label>
        <label>接头最小间距<input type="number" step="5" min="0" id="cutMinGap" value="${c.minJointGap}"></label>
      </div>`;

    // 选中节点 → 接头编排
    if (selNode) {
      const inc = incidentEdges(selNode);
      if (inc.length >= 1) {
        const live = res && res.joints[selNode];
        const roles = nodeRoles(selNode);
        const eff = roles || (live ? {
          through: live.through, butt: live.butt, miter: live.miter,
        } : { through: [], butt: inc.map((x) => x.e.id), miter: [] });
        const roleOf = (eid) =>
          eff.through.includes(eid) ? "through" : eff.miter.includes(eid) ? "miter" : "butt";
        html += `<div class="cut-section-title">节点接头编排 <button class="mini" id="cutResetJoint">恢复默认</button></div>
          <div class="pane-note">连续穿过最多选两路（同一路）；斜接路成对配斜角，落单按顶接。</div>
          <div class="cut-joint" data-node="${selNode}">
            ${inc.map((x) => {
              const deg = ((x.ang * 180) / Math.PI + 360) % 360;
              const e = x.e;
              return `<label class="cut-jrow" data-eid="${e.id}">
                <span class="cut-eid">${e.kind === "frame" ? "框边" : "铅条"} · ${deg.toFixed(0)}°</span>
                <span class="cut-jopts">
                  <label><input type="radio" name="jr_${e.id}" value="through" ${roleOf(e.id) === "through" ? "checked" : ""}>连续</label>
                  <label><input type="radio" name="jr_${e.id}" value="butt" ${roleOf(e.id) === "butt" ? "checked" : ""}>顶接</label>
                  <label><input type="radio" name="jr_${e.id}" value="miter" ${roleOf(e.id) === "miter" ? "checked" : ""}>斜接</label>
                </span>
              </label>`;
            }).join("")}
          </div>`;
      }
    }

    // 构件列表
    if (res) {
      html += `<div class="cut-section-title">连续铅条（同色编号见图）</div>`;
      // 选中单条边 → 边级规格（故意混规格时使用，会触发“规格不一致”提示）
      if (sel && sel.kind === "edge") {
        const eSpecId = c.edgeSpecs[sel.id] || defaultSpecId(c);
        const emem = res.memberOfEdge[sel.id];
        html += `<div class="cut-edge-spec">
          <span>选中单段中心线${emem ? `（属于铅条 #${res.members.find((x) => x.id === emem).num}）` : ""}：</span>
          <select id="cutEdgeSpec">
            ${c.specs.map((s) => `<option value="${s.id}" ${s.id === eSpecId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </div>`;
      }
      html += res.members.map((m) => {
        const sp = res.specs[m.specId];
        const t = (en) => en.type === "miter" ? `斜${en.cutDeg.toFixed(0)}°${en.side || ""}`
          : en.type === "through" ? "连续"
          : en.type === "dangling" ? "悬空" : "顶接";
        const ends = m.closed ? "闭合环" : m.ends.map((en) =>
          `${t(en)}+${en.ext.toFixed(1)}`).join(" / ");
        return `<div class="cut-member${selMember === m.id ? " sel" : ""}" data-mid="${m.id}">
          <span class="cut-mnum" style="background:${memberColor(m)}">${m.num}</span>
          <span class="cut-minfo">
            <b>${m.length.toFixed(0)}mm</b> <span class="muted">心 ${m.centerLen.toFixed(0)} · ${sp ? sp.name : "无规格"}${m.edgeCount > 1 ? ` · 弯 ${m.bends.filter((b) => b.deflectDeg > 5).length}` : ""}</span>
            <span class="muted cut-mends">${ends}</span>
          </span>
          <span class="cut-mops">
            ${m.specId ? `<select class="cut-mspec" title="整根规格">
              ${c.specs.map((s) => `<option value="${s.id}" ${s.id === m.specId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
            </select>` : ""}
            <button class="mini cut-lock" title="锁定=已弯制/已下料，不参与排料">${m.locked ? "🔒已锁" : "🔓锁定"}</button>
          </span>
        </div>`;
      }).join("");

      // 方案比较
      html += `<div class="cut-section-title">下料方案比较</div>`;
      const strategies = res.plans.strategies || [];
      html += strategies.map((p) => `
        <div class="cut-plan${p.recommended ? " rec" : ""}">
          <div class="cut-plan-name">${p.allPlaced ? "" : "⚠ "}${p.name}${p.recommended ? " ★推荐" : ""}</div>
          <div class="muted">新料 <b>${p.newSticks}</b> 根 · 总废料 ${p.wasteTotal.toFixed(0)}mm${p.kerfTotal ? `（含锯路 ${p.kerfTotal.toFixed(0)}）` : ""} ·
            可复用余料 ${p.reusableTotal.toFixed(0)}mm${p.allPlaced ? "" : ` · 排不下 ${p.unplaced.length} 根`}</div>
          <button class="mini cut-saveplan" data-key="${p.key}" ${p.allPlaced ? "" : "disabled"}>存为方案</button>
        </div>`).join("");

      if (c.plans.length) {
        html += `<div class="cut-section-title">历史方案对照（几何变化仅标记受影响构件）</div>`;
        html += c.plans.slice().reverse().map((p) => {
          const stl = p.staleness || { stale: false, label: 0 };
          const cur = c.selectedPlanId === p.id;
          return `<div class="cut-hist${cur ? " sel" : ""}" data-pl="${p.id}">
            <div class="cut-plan-name">${esc(p.name)} ${stl.stale ? `<span class="cal-badge stale">${stl.label} 根已变</span>` : '<span class="cal-badge frozen">一致</span>'}</div>
            <div class="muted">新料 ${p.metrics.newSticks} 根 · 废料 ${p.metrics.wasteTotal.toFixed(0)}mm ·
              余料 ${p.metrics.reusableTotal.toFixed(0)}mm</div>
            <div class="cut-hops">
              <button class="mini cut-showplan">${cur ? "✓ 对照中" : "对照"}</button>
              <button class="mini cut-adoptplan" title="锁定方案内未锁构件，余料入池">采用</button>
              <button class="mini danger cut-delplan">删</button>
            </div>
          </div>`;
        }).join("");
      }

      // 余料池
      if (c.remnants.length) {
        html += `<div class="cut-section-title">可复用余料（${c.remnants.length} 段）</div>`;
        html += c.remnants.map((r, i) => {
          const sp = c.specs.find((s) => s.id === r.specId);
          return `<div class="cut-rem" data-rm="${i}">
            <span>${sp ? esc(sp.name) : "?"} · <b>${r.length.toFixed(0)}mm</b></span>
            <button class="mini danger cut-rmdel">删</button></div>`;
        }).join("");
      }
    }

    box.innerHTML = html;
    bindPanel(c, res);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  function bindPanel(c, res) {
    const box = $("cutPanel");
    // 规格编辑
    box.querySelectorAll(".cut-spec").forEach((row) => {
      const sp = c.specs.find((s) => s.id === row.dataset.sp);
      row.querySelectorAll("input[data-f]").forEach((inp) => {
        inp.addEventListener("change", () => {
          const f = inp.dataset.f;
          if (f === "name" || f === "hardness") sp[f] = inp.value.trim() || sp[f];
          else sp[f] = Math.max(0, parseFloat(inp.value) || sp[f]);
          LG.app.requestSave();
          if (f !== "name" && f !== "hardness") scheduleCompute();
        });
      });
      const mk = row.querySelector(".cut-mkdef");
      if (mk) mk.addEventListener("click", () => {
        c.specs.forEach((s) => (s.isDefault = s.id === sp.id));
        LG.app.requestSave();
        scheduleCompute();
      });
      const dl = row.querySelector(".cut-del-spec");
      if (dl) dl.addEventListener("click", () => {
        if (confirm("删除规格 “" + sp.name + "”？使用它的边回退到默认规格。")) removeSpec(sp.id);
        else renderPanel();
      });
    });
    const addBtn = $("cutAddSpec");
    if (addBtn) addBtn.addEventListener("click", addSpec);

    const slot = $("cutSlot"), gap = $("cutMinGap");
    if (slot) slot.addEventListener("change", () => {
      c.slotAllowance = Math.max(0, parseFloat(slot.value) || c.slotAllowance);
      LG.app.requestSave(); scheduleCompute();
    });
    if (gap) gap.addEventListener("change", () => {
      c.minJointGap = Math.max(0, parseFloat(gap.value) || c.minJointGap);
      LG.app.requestSave(); scheduleCompute();
    });

    // 接头编排
    const jb = box.querySelector(".cut-joint");
    if (jb) {
      const nodeId = jb.dataset.node;
      const inc = incidentEdges(nodeId);
      jb.querySelectorAll("input[type=radio]").forEach((r) => {
        r.addEventListener("change", () => {
          const roles = { through: [], butt: [], miter: [] };
          inc.forEach((x) => {
            const v = jb.querySelector(`input[name="jr_${x.e.id}"]:checked`);
            roles[(v && v.value) || "butt"].push(x.e.id);
          });
          setNodeRoles(nodeId, roles);
        });
      });
      const rst = $("cutResetJoint");
      if (rst) rst.addEventListener("click", () => { resetNodeRoles(nodeId); });
    }

    if (!res) return;
    // 边级规格
    const es = $("cutEdgeSpec");
    if (es) es.addEventListener("change", () => setEdgeSpec(LG.state.selection.id, es.value));
    // 构件行
    box.querySelectorAll(".cut-member").forEach((row) => {
      const m = res.members.find((x) => x.id === row.dataset.mid);
      row.addEventListener("click", () => {
        LG.state.selection = { kind: "member", id: m.id };
        LG.editor.render();
        row.classList.add("sel");
        LG.editor.locate(m.cx, m.cy);
      });
      const lk = row.querySelector(".cut-lock");
      lk.addEventListener("click", (ev) => { ev.stopPropagation(); toggleLock(m); });
      const sp = row.querySelector(".cut-mspec");
      if (sp) sp.addEventListener("click", (ev) => ev.stopPropagation());
      if (sp) sp.addEventListener("change", () => {
        m.edges.forEach((eid) => setEdgeSpec(eid, sp.value));
      });
    });

    // 方案
    box.querySelectorAll(".cut-saveplan").forEach((btn) => {
      btn.addEventListener("click", () => {
        const st = res.plans.strategies.find((x) => x.key === btn.dataset.key);
        if (st) saveStrategy(st, res);
      });
    });
    box.querySelectorAll(".cut-hist").forEach((row) => {
      const plan = c.plans.find((x) => x.id === row.dataset.pl);
      row.querySelector(".cut-showplan").addEventListener("click", () => selectPlan(plan.id));
      row.querySelector(".cut-delplan").addEventListener("click", () => {
        if (confirm("删除该历史方案？")) deletePlan(plan.id);
      });
      row.querySelector(".cut-adoptplan").addEventListener("click", () => {
        if (confirm("采用方案：方案内构件标记为已下料并锁定，余料入余料池。继续？")) {
          adoptPlan(plan);
          LG.app.toast("已采用方案，构件锁定、余料入池");
        }
      });
    });
    box.querySelectorAll(".cut-rmdel").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest(".cut-rem").dataset.rm);
        c.remnants.splice(i, 1);
        LG.app.requestSave();
        renderPanel();
      });
    });
  }

  // ---------- 画布 ----------
  // 边 → 构件颜色；选中构件整根高亮
  function edgeColor(eid) {
    const res = result();
    if (!res) return null;
    const mid = res.memberOfEdge[eid];
    const m = res.members.find((x) => x.id === mid);
    if (!m) return null;
    return { color: memberColor(m), member: m };
  }

  // 节点接头小图：通过=直通线，顶接=⊥，斜接=∧；颜色随编排状态
  function nodeGlyph(nodeId) {
    const res = result();
    if (!res) return null;
    const j = res.joints[nodeId];
    if (!j) return null;
    const n = d().nodes.find((x) => x.id === nodeId);
    return { node: n, joint: j };
  }

  // ---------- 下料卡打印 ----------
  function endCutText(en) {
    if (!en) return "—";
    if (en.type === "miter") return `斜切 ${en.cutDeg.toFixed(1)}°（${en.side}侧）外伸 ${en.ext.toFixed(1)}`;
    if (en.type === "through") return "连续（不切断）";
    if (en.type === "dangling") return `悬空端 直切（外伸 ${en.ext.toFixed(1)}）`;
    return `直切，顶入 ${(en.blockFace || 0).toFixed(1)}mm 面，外伸 ${en.ext.toFixed(1)}`;
  }

  // 端头小图（viewBox 60×30，mm）：直切 = 平头矩形；斜切 = 斜头
  function endMarkSVG(en, flip) {
    const w = 26, h = 8;
    if (en && en.type === "miter") {
      const slant = 5;
      const p = flip
        ? `0,${2 + (en.side === "L" ? slant : 0)} ${w - slant},2 ${w - slant},${2 + h} 0,${2 + h + (en.side === "L" ? 0 : slant)}`
        : `${slant},2 ${w},${2 + (en.side === "L" ? 0 : slant)} ${w},${2 + h + (en.side === "L" ? slant : 0)} ${slant},${2 + h}`;
      return `<svg width="14mm" height="8mm" viewBox="0 0 ${w} ${h + 4}"><polygon points="${p}" class="cd-mark"/></svg>`;
    }
    return `<svg width="14mm" height="8mm" viewBox="0 0 ${w} ${h + 4}"><rect x="1" y="2" width="${w - 2}" height="${h}" class="cd-mark"/></svg>`;
  }

  // 逐根下料卡（一张 A4 网格多卡）+ 余料标签
  function renderCutCardsSVG(plan) {
    const c = ensure(d());
    const specsById = {};
    (plan.specs || []).forEach((s) => (specsById[s.id] = s));
    // 构件按编号
    const members = (plan.members || []).slice().sort((a, b) => a.num - b.num);
    const memberById = {};
    members.forEach((m) => (memberById[m.id] = m));

    // 排料顺序卡：按库存条分组
    const groups = (plan.sticks || []).map((s, si) => ({
      stick: s, idx: si + 1,
      members: s.memberIds.map((id) => memberById[id]).filter(Boolean),
    }));
    const locked = members.filter((m) => m.locked);

    const cards = [];
    groups.forEach((g) => {
      const sp = specsById[g.stick.specId] || {};
      const rows = g.members.map((m) => {
        const e1 = m.ends && m.ends[0], e2 = m.ends && m.ends[1];
        return `<tr>
          <td class="cd-num">${m.num}</td>
          <td>${m.length.toFixed(1)}</td>
          <td>${m.closed ? "闭合环" : endCutText(e1)}</td>
          <td>${endMarkSVG(e1, false)}</td>
          <td>${m.closed ? "—" : endCutText(e2)}</td>
          <td>${endMarkSVG(e2, true)}</td>
        </tr>`;
      }).join("");
      cards.push(`<div class="cd-card">
        <div class="cd-head"><b>下料卡 ${g.idx}</b>
          <span>${esc(sp.name || g.stick.specId)} · 条长 ${g.stick.length.toFixed(0)}mm ·
          ${g.stick.source === "remnant" ? "余料条 " + (g.stick.sourceId || "") : "新料"}</span></div>
        <table class="cd-table">
          <thead><tr><th>#</th><th>下料长 mm</th><th>A 端头方向</th><th></th><th>B 端头方向</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="cd-foot">
          用 ${g.members.length} 根 · 锯路 ${(sp.kerf || 0)}mm × ${Math.max(0, g.members.length - 1)}
          ＝ ${(g.stick.kerfLoss || 0).toFixed(0)}mm · 合计 ${g.stick.used.toFixed(0)}mm ·
          ${g.stick.remnantLength != null
            ? `<b class="ok-text">余料 ${g.stick.remnantLength.toFixed(0)}mm（贴余料标签）</b>`
            : `废料头 ${(g.stick.waste - (g.stick.kerfLoss || 0)).toFixed(0)}mm（总废料含锯路 ${g.stick.waste.toFixed(0)}mm）`}
        </div>
      </div>`);
    });

    // 已弯/已下料锁定构件清单（不再排料，仍给出长度与端头供核对）
    if (locked.length) {
      cards.push(`<div class="cd-card cd-locked">
        <div class="cd-head"><b>已弯制 / 已下料锁定（${locked.length} 根，不参与本次排料）</b></div>
        <table class="cd-table"><thead><tr><th>#</th><th>下料长 mm</th><th>规格</th><th colspan="3">端头</th></tr></thead>
        <tbody>${locked.map((m) => `<tr><td class="cd-num">${m.num}</td><td>${m.length.toFixed(1)}</td>
          <td>${esc(m.specName || "")}</td>
          <td colspan="3">${m.closed ? "闭合环" : (endCutText(m.ends[0]) + " ｜ " + endCutText(m.ends[1]))}</td></tr>`).join("")}
        </tbody></table></div>`);
    }

    // 余料标签
    const labels = (plan.sticks || []).filter((s) => s.remnantLength != null).map((s, i) => {
      const sp = specsById[s.specId] || {};
      return `<div class="rl-label">
        <div class="rl-len">${s.remnantLength.toFixed(0)} mm</div>
        <div>${esc(sp.name || s.specId)}</div>
        <div class="muted">${plan.name} · 条 ${i + 1}</div>
      </div>`;
    }).join("");

    return `<div class="cut-cards-page">
      <div class="cd-title">下料卡 · ${esc(plan.name)}
        <span class="muted">新料 ${plan.metrics.newSticks} 根 · 总废料 ${plan.metrics.wasteTotal.toFixed(0)}mm${plan.metrics.kerfTotal ? `（含锯路 ${plan.metrics.kerfTotal.toFixed(0)}mm）` : ""} · 余料 ${plan.metrics.reusableTotal.toFixed(0)}mm</span>
      </div>
      ${cards.join("")}
      ${labels ? `<div class="cd-title">余料标签（剪下贴于余段）</div><div class="rl-grid">${labels}</div>` : ""}
    </div>`;
  }

  LG.cutting = {
    ensure, defaultCutting, scheduleCompute, runCompute, result, buildPayload,
    renderPanel, memberColor, edgeColor, nodeGlyph, incidentEdges,
    saveStrategy, selectPlan, deletePlan, adoptPlan, planStaleness, evaluatePlans,
    setEdgeSpec, toggleLock, specOf, renderCutCardsSVG, endCutText,
  };
})(window);
