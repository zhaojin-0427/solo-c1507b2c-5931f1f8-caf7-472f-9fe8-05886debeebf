/* test_geometry.js — 几何/检查/次序核心逻辑的 node 测试 */
require("../static/js/geometry.js");
require("../static/js/checks.js");
require("../static/js/sequence.js");
require("../static/js/print.js");
const LG = globalThis.LG;

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}
function section(t) { console.log("\n== " + t + " =="); }

// 构造 2×2 网格面板：外框 600×800，一横一竖两条铅条
function gridDoc() {
  const doc = {
    settings: { leadFaceWidth: 6, heartWidth: 1.2, channelDepth: 5, grindAllowance: 1.5,
      minGlassWidth: 25, minCutSize: 8, reflexTol: 5,
      pageWidth: 210, pageHeight: 297, pageMargin: 10, overlap: 15 },
    frame: { x: 0, y: 0, w: 600, h: 800 },
    bars: [], nodes: [], edges: [], pieces: [],
    sequence: { startCorner: "tl", steps: [], custom: false },
  };
  const N = {};
  const nid = (k, x, y) => { N[k] = { id: k, x, y }; doc.nodes.push(N[k]); };
  nid("tl", 0, 0); nid("tm", 300, 0); nid("tr", 600, 0);
  nid("ml", 0, 400); nid("c", 300, 400); nid("mr", 600, 400);
  nid("bl", 0, 800); nid("bm", 300, 800); nid("br", 600, 800);
  const E = (a, b, kind) => doc.edges.push({ id: "e_" + a + "_" + b, a, b, kind: kind || "lead" });
  E("tl", "tm", "frame"); E("tm", "tr", "frame"); E("tr", "mr", "frame");
  E("mr", "br", "frame"); E("br", "bm", "frame"); E("bm", "bl", "frame");
  E("bl", "ml", "frame"); E("ml", "tl", "frame");
  E("tm", "c"); E("c", "bm"); E("ml", "c"); E("c", "mr");
  return doc;
}

section("extractFaces：2×2 网格");
{
  const doc = gridDoc();
  const { pieces, outer } = LG.g.extractFaces(doc.nodes, doc.edges);
  ok(pieces.length === 4, `应得 4 个闭合片（实际 ${pieces.length}）`);
  ok(outer && Math.abs(Math.abs(outer.area) - 600 * 800) < 1, "外部面面积=面板外框面积");
  const areas = pieces.map((p) => Math.abs(p.area)).sort((a, b) => a - b);
  ok(Math.abs(areas[0] - 300 * 400) < 1, `每片面积 120000mm²（实际 ${areas[0].toFixed(0)}）`);
}

section("matchPieces：节点移动后保留片身份");
{
  const doc = gridDoc();
  const f1 = LG.g.extractFaces(doc.nodes, doc.edges);
  const existing = f1.pieces.map((f, i) => ({ id: "p" + i, num: i + 1, color: "#abc", grain: 0, cx: f.cx, cy: f.cy }));
  // 移动中心节点
  doc.nodes.find((n) => n.id === "c").x = 350;
  const f2 = LG.g.extractFaces(doc.nodes, doc.edges);
  const matched = LG.g.matchPieces(f2.pieces, existing);
  ok(matched.every((m) => m.piece), "4 片全部匹配回原有身份");
  const nums = matched.map((m) => m.piece.num).sort();
  ok(nums.join() === "1,2,3,4", "编号集合不变: " + nums.join());
}

section("minWidth / reflexVertices / insetPolygon");
{
  const rect = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 0, y: 30 }];
  const mw = LG.g.minWidth(rect);
  ok(Math.abs(mw.d - 30) < 1e-6, `100×30 矩形净宽=30（实际 ${mw.d}）`);

  const concave = [ // 带内凹角的多边形（顺时针，y 向下）
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    { x: 50, y: 50 }, { x: 0, y: 100 },
  ];
  const reflex = LG.g.reflexVertices(concave, 0);
  ok(reflex.length === 1 && Math.abs(reflex[0].deg - 270) < 1e-6,
    `内凹角 270°（实际 ${reflex.length ? reflex[0].deg : "无"}）`);

  const ins = LG.g.insetPolygon(rect, 5);
  ok(ins.ok && Math.abs(LG.g.minWidth(ins.poly).d - 20) < 1e-6, "内缩 5mm 后净宽 20");
  const tiny = LG.g.insetPolygon(rect, 20);
  ok(!tiny.ok, "内缩 20mm 超过半宽 → 判定无效");
}

section("轮廓方向一致性：顺时针 vs 逆时针");
{
  const cwRect = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 0, y: 30 }];
  const ccwRect = [{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 0 }];
  const insCW = LG.g.insetPolygon(cwRect, 5);
  const insCCW = LG.g.insetPolygon(ccwRect, 5);
  ok(insCW.ok && insCCW.ok, "两种方向都可内缩（不再误报无有效裁切区域）");
  ok(Math.abs(LG.g.minWidth(insCCW.poly).d - 20) < 1e-6,
    `CCW 内缩净宽也是 20（实际 ${insCCW.ok ? LG.g.minWidth(insCCW.poly).d : "N/A"}）`);
  // 内缩顶点应一致（集合相同）
  const key = (p) => p.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).sort().join(";");
  ok(key(insCW.poly) === key(insCCW.poly), "两种方向内缩顶点集合相同");
  // 逆时针凹多边形的内凹角
  const ccwConcave = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 50 }, { x: 100, y: 100 }, { x: 100, y: 0 }];
  const r2 = LG.g.reflexVertices(ccwConcave, 0);
  ok(r2.length === 1 && Math.abs(r2[0].deg - 270) < 1e-6, `CCW 凹多边形内凹角 270°（实际 ${r2.length ? r2[0].deg : "无"}）`);
  // 逆时针凸三角形：内角都 < 180，不应误报
  const ccwTri = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 0 }];
  ok(LG.g.reflexVertices(ccwTri, 0).length === 0, "CCW 凸三角形无误报内凹角");
  // 逆时针矩形净尺寸检查不应误报
  const docCCW = {
    settings: { heartWidth: 1.2, grindAllowance: 1.5, minGlassWidth: 25, minCutSize: 8, reflexTol: 5 },
    nodes: ccwRect.map((p, i) => ({ id: "v" + i, x: p.x, y: p.y })),
    edges: [0, 1, 2, 3].map((i) => ({ id: "e" + i, a: "v" + i, b: "v" + ((i + 1) % 4), kind: "frame" })),
  };
  const fpCCW = LG.g.extractFaces(docCCW.nodes, docCCW.edges).pieces
    .map((face) => ({ face, piece: { id: "p", num: 1 } }));
  const issCCW = LG.checks.run(docCCW, fpCCW);
  ok(!issCCW.some((i) => i.type === "undersize"), "CCW 矩形片不误报净尺寸不足");
}

section("checks：五类问题");
{
  const doc = gridDoc();
  // 悬空端点：加一根孤立铅条
  doc.nodes.push({ id: "d1", x: 100, y: 100 }, { id: "d2", x: 150, y: 100 });
  doc.edges.push({ id: "e_d", a: "d1", b: "d2", kind: "lead" });
  // 交叉缺节点：斜线 (100,300)→(500,480) 穿过横线 c-mr 与竖线 tm-c（均非端点）
  doc.nodes.push({ id: "x1", x: 100, y: 300 }, { id: "x2", x: 500, y: 480 });
  doc.edges.push({ id: "e_x", a: "x1", b: "x2", kind: "lead" });
  const faces = LG.g.extractFaces(doc.nodes, doc.edges);
  const fp = faces.pieces.map((face) => ({ face, piece: { id: "p", num: 1 } }));
  const issues = LG.checks.run(doc, fp);
  const types = issues.map((i) => i.type);
  ok(types.filter((t) => t === "dangling").length >= 4, `悬空端点 ≥4（实际 ${types.filter((t) => t === "dangling").length}）`);
  const crossings = issues.filter((i) => i.type === "crossing");
  ok(crossings.length >= 2, `检出交叉缺节点 ≥2（实际 ${crossings.length}）`);
  // 斜线与 y=400 交于 x≈322.2，与 x=300 交于 y=390
  ok(crossings.some((i) => Math.abs(i.x - 322.2) < 1 && Math.abs(i.y - 400) < 1), "交叉点1 ≈ (322,400)");
  ok(crossings.some((i) => Math.abs(i.x - 300) < 1 && Math.abs(i.y - 390) < 1), "交叉点2 ≈ (300,390)");
  // 边穿过非端点节点：加一条经过中心节点 c(300,400) 但不连接的线
  doc.nodes.push({ id: "y1", x: 100, y: 200 }, { id: "y2", x: 500, y: 600 });
  doc.edges.push({ id: "e_y", a: "y1", b: "y2", kind: "lead" });
  const issues2 = LG.checks.run(doc, LG.g.extractFaces(doc.nodes, doc.edges).pieces.map((face) => ({ face, piece: { id: "p", num: 1 } })));
  ok(issues2.some((i) => i.type === "crossing" && Math.abs(i.x - 300) < 0.1 && Math.abs(i.y - 400) < 0.1),
    "检出边穿过节点 c 但未连接");
}
{
  // 过窄玻璃：在左边框与竖铅条之间连一条距横线 10mm 的平行线 → 闭合出 10mm 窄片
  const doc = gridDoc();
  doc.nodes.push({ id: "n1", x: 0, y: 390 }, { id: "n2", x: 300, y: 390 });
  const ei = doc.edges.findIndex((e) => e.id === "e_ml_tl");
  doc.edges.splice(ei, 1);
  doc.edges.push({ id: "e_ml_n1", a: "ml", b: "n1", kind: "frame" });
  doc.edges.push({ id: "e_n1_tl", a: "n1", b: "tl", kind: "frame" });
  const ej = doc.edges.findIndex((e) => e.id === "e_tm_c");
  doc.edges.splice(ej, 1);
  doc.edges.push({ id: "e_tm_n2", a: "tm", b: "n2", kind: "lead" });
  doc.edges.push({ id: "e_n2_c", a: "n2", b: "c", kind: "lead" });
  doc.edges.push({ id: "e_n1_n2", a: "n1", b: "n2", kind: "lead" });
  const faces = LG.g.extractFaces(doc.nodes, doc.edges);
  const fp = faces.pieces.map((face) => ({ face, piece: { id: "p", num: 1 } }));
  const issues = LG.checks.run(doc, fp);
  ok(issues.some((i) => i.type === "narrow"), "检出过窄玻璃（10mm 窄片）");
  ok(!issues.some((i) => i.type === "dangling"), "窄片闭合后无悬空端点");
}
{
  // 内凹角 + 扣除铅芯后不足
  const doc = gridDoc();
  doc.nodes.length = 0; doc.edges.length = 0;
  const pts = [[0, 0], [200, 0], [200, 200], [100, 100], [0, 200]];
  pts.forEach(([x, y], i) => doc.nodes.push({ id: "v" + i, x, y }));
  for (let i = 0; i < 5; i++)
    doc.edges.push({ id: "e" + i, a: "v" + i, b: "v" + ((i + 1) % 5), kind: "frame" });
  const faces = LG.g.extractFaces(doc.nodes, doc.edges);
  const fp = faces.pieces.map((face) => ({ face, piece: { id: "p", num: 1 } }));
  const issues = LG.checks.run(doc, fp);
  ok(issues.some((i) => i.type === "reflex"), "检出内凹角");
}
{
  // 扣除铅芯后尺寸不足：6mm 宽长条，内缩 (1.2+1.5)/2≈1.35 后净宽 3.3 < 8
  const doc = gridDoc();
  doc.nodes.length = 0; doc.edges.length = 0;
  const pts = [[0, 0], [300, 0], [300, 6], [0, 6]];
  pts.forEach(([x, y], i) => doc.nodes.push({ id: "v" + i, x, y }));
  for (let i = 0; i < 4; i++)
    doc.edges.push({ id: "e" + i, a: "v" + i, b: "v" + ((i + 1) % 4), kind: "frame" });
  const faces = LG.g.extractFaces(doc.nodes, doc.edges);
  const fp = faces.pieces.map((face) => ({ face, piece: { id: "p", num: 1 } }));
  const issues = LG.checks.run(doc, fp);
  ok(issues.some((i) => i.type === "undersize"), "检出扣除铅芯后尺寸不足");
  ok(issues.some((i) => i.type === "narrow"), "同一窄条也触发过窄");
}

section("sequence：自动生成无违规；手动封片被指出");
{
  const doc = gridDoc();
  const faces = LG.g.extractFaces(doc.nodes, doc.edges);
  const fp = faces.pieces.map((face, i) => ({ face, piece: { id: "p" + i, num: i + 1 } }));
  ["tl", "tr", "br", "bl"].forEach((corner) => {
    const steps = LG.seq.generate(doc, fp, corner);
    const v = LG.seq.validate(doc, fp, steps);
    const nLead = steps.filter((s) => s.type === "lead").length;
    const nPiece = steps.filter((s) => s.type === "piece").length;
    const nSolder = steps.filter((s) => s.type === "solder").length;
    ok(v.length === 0, `从${corner}角生成：无违规（${v.map((x) => x.type).join()}）`);
    ok(nLead === doc.edges.length && nPiece === 4 && nSolder === doc.nodes.length,
      `  步骤覆盖：${nLead}铅/${nPiece}片/${nSolder}焊（应 ${doc.edges.length}/4/${doc.nodes.length}）`);
  });
  // 手动封片：把片 p0 的所有边界铅条移到最前，再嵌 p0
  const steps = LG.seq.generate(doc, fp, "tl");
  const boundary = new Set(fp[0].face.edgeIds);
  const leadSteps = steps.filter((s) => s.type === "lead" && boundary.has(s.ref));
  const pieceStep = steps.find((s) => s.type === "piece" && s.ref === "p0");
  const broken = [...leadSteps, pieceStep, ...steps.filter((s) => !leadSteps.includes(s) && s !== pieceStep)];
  const v2 = LG.seq.validate(doc, fp, broken);
  ok(v2.some((x) => x.type === "sealed" && x.pieceId === "p0"), "封片违规被检出并指向 p0");
  const sealed = v2.find((x) => x.type === "sealed");
  ok(sealed && sealed.edgeId, "违规指出了封口的铅条: " + (sealed && sealed.edgeId));
}

section("sequence：几何变化后调和手动次序");
{
  const doc = gridDoc();
  const buildFP = () =>
    LG.g.extractFaces(doc.nodes, doc.edges).pieces.map((face, i) => {
      // 模拟主程序的片身份保持：按质心匹配回旧片
      return { face, piece: null };
    });
  // 初始：生成并转手动
  let fp = buildFP();
  doc.pieces = fp.map((m, i) => ({ id: "p" + i, num: i + 1, color: "#abc", grain: 0, cx: m.face.cx, cy: m.face.cy }));
  fp = LG.g.matchPieces(LG.g.extractFaces(doc.nodes, doc.edges).pieces, doc.pieces);
  doc.sequence = { startCorner: "tl", steps: LG.seq.generate(doc, fp, "tl"), custom: true };

  // 几何变化1：拆分一根铅条（模拟 splitEdge）→ 旧边删除，两条新边产生
  const victim = doc.edges.find((e) => e.id === "e_tm_c");
  doc.edges.splice(doc.edges.indexOf(victim), 1);
  doc.nodes.push({ id: "mid1", x: 300, y: 200 });
  doc.edges.push({ id: "e_tm_mid1", a: "tm", b: "mid1", kind: "lead" });
  doc.edges.push({ id: "e_mid1_c", a: "mid1", b: "c", kind: "lead" });
  fp = LG.g.matchPieces(LG.g.extractFaces(doc.nodes, doc.edges).pieces, doc.pieces);

  // 调和前：旧步骤引用已删除的 e_tm_c，且新边无步骤 → validate 应报 missing
  const vBefore = LG.seq.validate(doc, fp, doc.sequence.steps);
  ok(vBefore.some((x) => x.type === "missing"), "调和前检出缺项（missing）");

  // 调和
  LG.seq.reconcile(doc, fp);
  const steps2 = doc.sequence.steps;
  const leadRefs = new Set(steps2.filter((s) => s.type === "lead").map((s) => s.ref));
  ok(!leadRefs.has("e_tm_c"), "已删除边的放铅步骤被移除");
  ok(leadRefs.has("e_tm_mid1") && leadRefs.has("e_mid1_c"), "两条新边都补了放铅步骤");
  ok(doc.edges.every((e) => leadRefs.has(e.id)), "次序覆盖当前全部铅条");
  const solderRefs = new Set(steps2.filter((s) => s.type === "solder").map((s) => s.ref));
  ok(solderRefs.has("mid1"), "新节点补了焊点步骤");
  const vAfter = LG.seq.validate(doc, fp, steps2);
  ok(!vAfter.some((x) => x.type === "missing"), "调和后无缺项");
  ok(vAfter.length === 0, `调和后无其他违规（实际 ${vAfter.map((x) => x.type).join()}）`);

  // 几何变化2：删除一根铅条（e_ml_c 及其孤立节点不动）→ 对应步骤应被清理
  const victim2 = doc.edges.find((e) => e.id === "e_ml_c");
  doc.edges.splice(doc.edges.indexOf(victim2), 1);
  fp = LG.g.matchPieces(LG.g.extractFaces(doc.nodes, doc.edges).pieces, doc.pieces);
  LG.seq.reconcile(doc, fp);
  const leadRefs2 = new Set(doc.sequence.steps.filter((s) => s.type === "lead").map((s) => s.ref));
  ok(!leadRefs2.has("e_ml_c"), "被删铅条的步骤被清理");
  ok(doc.edges.every((e) => leadRefs2.has(e.id)), "删除后仍覆盖全部铅条");
}

section("print：分页计算");
{
  const doc = gridDoc(); // 600×800，A4 可用 190×277，重叠 15 → 步进 175×262
  const lay = LG.print.computePages(doc);
  // cols = ceil((600-190)/175)+1 = ceil(2.34)+1 = 4? (600-190)/175=2.343→3+1=4
  // rows = ceil((800-277)/262)+1 = ceil(1.996)+1 = 3
  ok(lay.cols === 4 && lay.rows === 3, `600×800 → ${lay.cols}×${lay.rows} 页（预期 4×3）`);
  ok(lay.pages.length === 12, "共 12 页");
  const svg = LG.print.renderPageSVG(doc, [], lay.pages[0], lay);
  ok(svg.includes('width="190mm"') && svg.includes("viewBox=\"0 0 190 277\""), "首页 SVG 尺寸与 viewBox 正确");
  ok(svg.includes("拼接") === false && svg.includes("第 1/12 页"), "页标签含页码");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
