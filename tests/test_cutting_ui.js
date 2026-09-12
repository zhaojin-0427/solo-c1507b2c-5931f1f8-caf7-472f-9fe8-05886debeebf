/* test_cutting_ui.js — jsdom 集成测试：真实页面脚本驱动下料/接头编排工作流
 * 运行前需启动服务：python3 app.py（端口 5000）
 */
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:5000";
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error("超时等待：" + what);
}

// 最小有效计算结果（模拟服务端 /api/cutting/compute）
function fakeResult() {
  return {
    members: [
      { id: "M1", num: 1, key: "e1|e2", edges: ["e1", "e2"], edgeCount: 2,
        centerLen: 400, length: 414, specId: "sp_default", mixedEdges: [],
        ends: [{ nodeId: "n1", edgeId: "e1", x: 0, y: 0, type: "butt", ext: 7, cutDeg: 0, blockFace: 6 },
               { nodeId: "n3", edgeId: "e2", x: 0, y: 400, type: "butt", ext: 7, cutDeg: 0, blockFace: 6 }],
        bends: [{ nodeId: "n2", x: 0, y: 200, deflectDeg: 0 }],
        closed: false, locked: false, cx: 0, cy: 200 },
    ],
    memberOfEdge: { e1: "M1", e2: "M1" },
    joints: {
      n2: { kind: "straight", through: ["e1", "e2"], butt: [], miter: [], pairs: [] },
    },
    terms: {},
    issues: [{ id: "cj0", type: "joint_close", severity: "warn",
      msg: "接头间距 10mm < 60mm", x: 0, y: 200, data: { nodeA: "n2", nodeB: "n3" } }],
    plans: { strategies: [
      // 锯路 3mm，用 417（含锯路），余料 1383 可留 → 总废料=3，而非 0
      { key: "ffd", name: "首次适配（新料）", newSticks: 1, wasteTotal: 3, kerfTotal: 3,
        reusableTotal: 1383,
        stickCount: 1, allPlaced: true, unplaced: [], recommended: true, consumedRemnants: [],
        sticks: [{ specId: "sp_default", length: 1800, source: "new", sourceId: null,
          memberIds: ["M1"], used: 417, cuts: 1, kerfLoss: 3, waste: 3, remnantLength: 1383 }] },
      // 余料优先：吃掉库存余料 rm900，采用后该余料必须出库
      { key: "remnant", name: "余料优先", newSticks: 0, wasteTotal: 3, kerfTotal: 3,
        reusableTotal: 480, stickCount: 1, allPlaced: true, unplaced: [],
        recommended: false, consumedRemnants: ["rm900"],
        sticks: [{ specId: "sp_default", length: 900, source: "remnant", sourceId: "rm900",
          memberIds: ["M1"], used: 417, cuts: 1, kerfLoss: 3, waste: 3, remnantLength: 480 }] },
    ] },
    specs: { sp_default: { id: "sp_default", name: "6mm 软铅", faceWidth: 6 } },
    summary: { count: 1, totalLength: 414, lockedCount: 0, lockedLength: 0,
      specs: [{ specId: "sp_default", specName: "6mm 软铅", count: 1, length: 414, lockedCount: 0, lockedLength: 0 }] },
  };
}

(async () => {
  const computeCalls = [];
  const dom = await JSDOM.fromURL(BASE + "/", {
    resources: "usable", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = () => {};
      const realFetch = globalThis.fetch.bind(globalThis);
      window.fetch = async (u, o) => {
        const url = new URL(u, BASE);
        const body = o && o.body ? JSON.parse(o.body) : null;
        if (url.pathname === "/api/cutting/compute") {
          computeCalls.push(body);
          return { ok: true, status: 200, json: async () => fakeResult(), text: async () => "" };
        }
        return realFetch(url.toString(), o);
      };
    },
  });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);
  await until(() => window.LG && window.LG.state && window.LG.state.projectId && window.LG.app, "应用启动");
  // 显式新建空项目（默认 doc 已含下料规格），避免自动载入库内旧项目
  window.prompt = () => "下料集成测试";
  await window.LG.app.newProject();
  const LG = window.LG;
  await until(() => LG.state.doc.cutting && LG.state.doc.cutting.specs.length, "新项目下料初始化");

  ok($("cutPanel"), "下料页签与面板存在");
  // 造一个最小几何：3 节点 2 边
  const doc = window.LG.state.doc;
  doc.nodes.push({ id: "n1", x: 0, y: 0 }, { id: "n2", x: 0, y: 200 }, { id: "n3", x: 0, y: 400 });
  doc.edges.push({ id: "e1", a: "n1", b: "n2", kind: "lead" },
                 { id: "e2", a: "n2", b: "n3", kind: "lead" });
  window.LG.app.onGeomChanged();

  // 载荷发往服务端且含规格/编排/节点边
  await until(() => computeCalls.some((q) => q.edges.length === 2), "触发下料计算");
  const p = computeCalls.filter((q) => q.edges.length === 2).pop();
  ok(p.nodes.length === 3 && p.edges.length === 2, "载荷含当前节点与边");
  ok(p.cutting.specs[0].stockLength === 1800 && p.cutting.slotAllowance === 4,
     "载荷含默认规格与槽口余量: " + JSON.stringify(p.cutting.specs[0]));
  ok(p.cutting.specs[0].kerf === 3 && p.cutting.specs[0].minRemnant === 150,
     "载荷含锯路损耗与最短留余");

  // 结果渲染到面板与画布
  await until(() => $("cutPanel").textContent.includes("连续铅条"), "下料面板渲染");
  ok($("cutPanel").textContent.includes("414"), "面板显示下料长度（含两端外伸 400+7+7）");
  ok(window.document.querySelector("#layer-edges [stroke]") ||
     window.document.querySelectorAll("#layer-edges line").length >= 4, "边图层已重绘");
  const dots = window.document.querySelectorAll(".cut-label-dot");
  ok(dots.length === 1, "画布出现 1 个构件编号点（实际 %d）".replace("%d", dots.length));

  // 下料问题并入检查列表/徽标
  await until(() => $("issueList").textContent.includes("接头过近"), "下料问题并入检查");
  ok($("issueBadge").textContent.includes("警"), "顶栏徽标计入下料警告: " + $("issueBadge").textContent);

  // 点构件编号 → 选中整根，同色高亮
  const pEv = (type) => new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window });
  const hit = window.document.querySelector(".cut-label-hit");
  hit.dispatchEvent(pEv("pointerdown"));
  await until(() => window.LG.state.selection && window.LG.state.selection.kind === "member", "点编号选中构件");
  const tabLead = [...window.document.querySelectorAll(".tab-btn")].find((b) => b.dataset.tab === "lead");
  ok(tabLead.classList.contains("active"), "选中构件自动切到下料页签");
  ok($("cutPanel").querySelector(".cut-member.sel"), "构件列表高亮选中行");

  // 锁定：排料载荷中该构件 key 进入 locks
  $("cutPanel").querySelector(".cut-lock").click();
  await until(() => doc.cutting.locks.includes("e1|e2"), "锁定写入 doc.cutting.locks");
  await until(() => computeCalls.length >= 2, "锁定后重新计算");
  ok(computeCalls[computeCalls.length - 1].cutting.locks.includes("e1|e2"),
     "重算载荷含锁定 key（已弯/已下料不排料）");

  // 构件编号稳定：放铅次序随载荷下发
  ok(Array.isArray(computeCalls[0].sequenceEdgeOrder), "载荷含放铅次序用于编号");

  // 节点接头编排：选 n2 → 单选“顶接” → joints 写入 → 重新计算
  window.LG.state.selection = { kind: "node", id: "n2" };
  window.LG.app.onSelectionChanged();
  await until(() => $("cutPanel").querySelector(".cut-joint"), "接头编排区出现");
  const radios = [...$("cutPanel").querySelectorAll(`input[name="jr_e2"]`)];
  ok(radios.length === 3, "每条入射边有 连续/顶接/斜接 三个选项");
  // 把两路都改成顶接
  ["e1", "e2"].forEach((eid) => {
    const rr = [...$("cutPanel").querySelectorAll(`input[name="jr_${eid}"]`)]
      .find((x) => x.value === "butt");
    rr.checked = true;
    rr.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await until(() => doc.cutting.joints.n2 && doc.cutting.joints.n2.butt.length === 2,
    "节点编排写入 doc.cutting.joints");
  ok(doc.cutting.joints.n2.butt.includes("e1") && doc.cutting.joints.n2.butt.includes("e2"),
     "两路都顶接: " + JSON.stringify(doc.cutting.joints.n2));
  await until(() => computeCalls.length >= 3, "改编排后重新计算");
  ok(computeCalls[computeCalls.length - 1].cutting.joints.n2.through.length === 0,
     "改编排即时随载荷下发");

  // 恢复默认
  $("cutResetJoint").click();
  await until(() => !doc.cutting.joints.n2, "恢复默认清除编排");

  // 规格增删改
  const before = doc.cutting.specs.length;
  $("cutAddSpec").click();
  ok(doc.cutting.specs.length === before + 1, "可新建铅条规格");
  const nameInp = $("cutPanel").querySelectorAll(".cut-spec-name")[before];
  ok(nameInp, "新规格可编辑名称");
  // 库存条长改值触发重算
  const sl = $("cutPanel").querySelectorAll(".cut-spec [data-f=stockLength]")[before];
  const callsBefore = computeCalls.length;
  sl.value = "2000";
  sl.dispatchEvent(new window.Event("change", { bubbles: true }));
  await until(() => computeCalls.length > callsBefore, "改库存条长触发重算");
  ok(computeCalls[computeCalls.length - 1].cutting.specs[before].stockLength === 2000,
     "新库存条长随载荷下发");

  // 存为方案 → 历史方案对照，方案含逐根下料卡数据
  await until(() => $("cutPanel").querySelector(".cut-saveplan"), "方案按钮出现");
  $("cutPanel").querySelector(".cut-saveplan").click();
  await until(() => doc.cutting.plans.length === 1, "方案保存进 doc（随项目入 SQLite）");
  const plan = doc.cutting.plans[0];
  ok(plan.metrics.newSticks === 1 && plan.sticks[0].remnantLength === 1383,
     "方案记录新料根数/余料: " + JSON.stringify(plan.metrics));
  ok(plan.metrics.kerfTotal === 3 && plan.metrics.wasteTotal === 3,
     "方案总废料计入锯路（21mm 情形不为 0）: " + JSON.stringify(plan.metrics));
  ok(plan.members[0].key === "e1|e2", "方案快照含构件 key（采用时按 key 锁定）");
  ok(plan.members[0].ends[0].ext === 7 && plan.members[0].ends[0].type === "butt",
     "方案快照含端头方向（顶接直切+外伸）");
  ok($("cutPanel").textContent.includes("一致"), "几何未变时历史方案标记一致");

  // 下料卡/余料标签渲染（接入打印页）
  const cardsHTML = window.LG.cutting.renderCutCardsSVG(plan);
  ok(cardsHTML.includes("下料卡 1") && cardsHTML.includes("414.0"), "逐根下料卡含构件与下料长");
  ok(cardsHTML.includes("1383 mm"), "余料标签含余料长度");
  ok(cardsHTML.includes("顶入"), "下料卡含端头方向说明");

  // 几何变化只使受影响构件失效：改结果快照（模拟构件长度变化）
  const res2 = fakeResult();
  res2.members[0].length = 500;
  window.LG.state.cutState.result = res2;
  window.LG.cutting.evaluatePlans(res2);
  ok(plan.staleness.stale && plan.staleness.changed.includes("M1"),
     "长度变化标记受影响构件: " + JSON.stringify(plan.staleness));
  ok(doc.cutting.plans.length === 1, "历史方案仍保留可对照");
  window.LG.cutting.renderPanel();
  ok($("cutPanel").textContent.includes("已变"), "面板提示方案构件已变");

  // 采用方案：方案快照内构件进入 locks（已下料），并产生余料
  // （fake 结果不回传 lock，先清掉手动锁定，验证“采用”本身写入）
  doc.cutting.locks = [];
  window.LG.cutting.adoptPlan(plan);
  ok(doc.cutting.locks.length === 1 && doc.cutting.locks[0] === "e1|e2",
     "采用后构件按 key 锁定（不允许 [null]）: " + JSON.stringify(doc.cutting.locks));
  ok(doc.cutting.remnants.some((r) => r.length === 1383 && r.specId === "sp_default"),
     "采用方案后余料 1383mm 入余料池");
  ok(plan.members[0].locked === true, "方案快照锁定状态与采用结果对齐");
  // 已锁构件不再参加下一轮排料：重算载荷 locks 保留该 key
  const callsN = computeCalls.length;
  await until(() => computeCalls.length > callsN, "采用后触发重算");
  ok(computeCalls[computeCalls.length - 1].cutting.locks.includes("e1|e2"),
     "重算载荷保持锁定，已下料构件退出排料");

  // 余料优先方案：用掉的库存余料必须出库，新余段入池
  const res3 = fakeResult();
  const remnantStrategy = res3.plans.strategies.find((s) => s.key === "remnant");
  doc.cutting.remnants = [{ id: "rm900", specId: "sp_default", length: 900 }];
  doc.cutting.locks = [];
  const plan2 = await window.LG.cutting.saveStrategy(remnantStrategy, res3, "余料优先方案");
  window.LG.cutting.adoptPlan(plan2);
  ok(!doc.cutting.remnants.some((r) => r.id === "rm900"),
     "采用余料优先方案后，用掉的 rm900 从库存移除（不可重复使用）");
  ok(doc.cutting.remnants.some((r) => r.length === 480),
     "消耗余料后剩余的 480mm 余段入池");
  ok(doc.cutting.locks.includes("e1|e2"), "余料方案构件同样按 key 锁定");

  // 幂等：同一方案再采用一次 —— 不重复入库、不重复消耗、不新增锁
  const locksN = doc.cutting.locks.length;
  const rm480before = doc.cutting.remnants.filter((r) => r.length === 480).length;
  const again = window.LG.cutting.adoptPlan(plan2);
  ok(again === false && plan2.adopted === true, "重复采用被幂等守卫拦截");
  ok(doc.cutting.locks.length === locksN, "重复采用不新增锁定（%d 条）".replace("%d", doc.cutting.locks.length));
  ok(doc.cutting.remnants.filter((r) => r.length === 480).length === rm480before,
     "重复采用不产生第二条同 id 余料（%d 条）".replace("%d", rm480before));
  const rmIds = doc.cutting.remnants.map((r) => r.id);
  ok(new Set(rmIds).size === rmIds.length, "余料池无重复 id: " + JSON.stringify(rmIds));

  // 无 key 旧方案（修复前保存）：采用后实时锁定与快照 locked 必须一致，不立即标“已变”
  const res4 = fakeResult();
  const legacyStrategy = res4.plans.strategies.find((s) => s.key === "ffd");
  doc.cutting.remnants = [];
  doc.cutting.locks = [];
  const legacyPlan = await window.LG.cutting.saveStrategy(legacyStrategy, res4, "旧方案");
  delete legacyPlan.members[0].key; // 模拟旧快照
  ok(!legacyPlan.members[0].key, "旧方案快照无 key");
  const ret = window.LG.cutting.adoptPlan(legacyPlan);
  ok(ret === true, "旧方案首次采用正常执行");
  ok(doc.cutting.locks.includes("e1|e2"), "旧方案构件由边列表派生 key 锁定");
  ok(legacyPlan.members[0].locked === true, "旧方案快照 locked 同步为 true（用同一派生 key）");
  // 实时结果构件已锁（服务端按 locks 返回）→ 对照不应报“已变”
  res4.members[0].locked = true;
  const stl = window.LG.cutting.planStaleness(legacyPlan, res4);
  ok(!stl.stale, "旧方案采用后不立即标成已变: " + JSON.stringify(stl));

  // 清理
  await window.LG.app.api("DELETE", "/api/projects/" + window.LG.state.projectId);
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("集成测试异常：", e); process.exit(1); });
