/* test_ui.js — jsdom 集成测试：真实 Flask 服务 + 真实页面脚本，驱动底稿校准工作流
 * 运行前需启动服务：python3 app.py（端口 5000） */
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

(async () => {
  const dom = await JSDOM.fromURL(BASE + "/", {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, o) => fetch(new URL(u, BASE), o);
      window.confirm = () => true;
      window.alert = () => {};
      // jsdom 不加载图片：立即触发 onload 的假 Image
      window.Image = class {
        constructor() { this.naturalWidth = 2000; this.naturalHeight = 1500; }
        set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
        get src() { return this._src; }
      };
    },
  });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);

  // 等应用启动并自动建项目
  const LG = await until(() => window.LG && window.LG.state && window.LG.state.projectId && window.LG.app, "应用启动");
  const pid = window.LG.state.projectId;
  ok(pid > 0, `项目已自动创建/载入（id=${pid}）`);
  ok($("calibPanel"), "侧栏底稿面板已渲染");

  // jsdom 无 canvas：桩掉重投影，返回假位图
  window.LG.calib.rectify = (img, params) => ({
    canvas: { toDataURL: () => "data:image/png;base64,AAAA" },
    bbox: { x0: 0, y0: 0, x1: 400, y1: 300 }, k: 2,
  });

  // —— 通过 API 准备照片与版本（模拟修复师导入） ——
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const ph = await window.LG.app.api("POST", `/api/projects/${pid}/photos`, {
    name: "现场照片.png", mime: "image/png", width: 2000, height: 1500, dataBase64: png,
  });
  ok(ph.id > 0, "照片已写入 SQLite");
  const pts = [
    { id: "a", imgX: 100, imgY: 100, panelX: 50, panelY: 50, locked: false, excluded: false },
    { id: "b", imgX: 1900, imgY: 120, panelX: 950, panelY: 60, locked: false, excluded: false },
    { id: "c", imgX: 110, imgY: 1400, panelX: 55, panelY: 700, locked: false, excluded: false },
    { id: "d", imgX: 1880, imgY: 1380, panelX: 940, panelY: 690, locked: false, excluded: false },
  ];
  const ver = await window.LG.app.api("POST", `/api/projects/${pid}/calib`, {
    photo_id: ph.id, name: "方案 1", method: "affine", points: pts,
  });
  await window.LG.calibui.loadProjectData(pid);
  ok($("calibPanel").textContent.includes("现场照片.png"), "侧栏显示已导入照片");
  ok($("calibPanel").textContent.includes("方案 1"), "侧栏显示校准方案");
  ok($("calibPanel").textContent.includes("未计算"), "方案初始未计算");

  // —— 打开工作区并计算 ——
  window.LG.calibui.openWorkspace(ver.id);
  await until(() => $("calibModal").classList.contains("show"), "工作区打开");
  await until(() => $("calTbody").children.length === 4, "控制点表 4 行");
  ok($("calMethod").value === "affine", "方法为仿射");
  $("calCompute").click();
  await until(() => $("calRms").textContent.includes("RMS"), "计算完成");
  ok($("calRms").textContent.includes("4 点"), "RMS 统计基于 4 点：" + $("calRms").textContent);
  const rmsTxt = $("calTbody").textContent;
  ok(/mm/.test(rmsTxt) && /px/.test(rmsTxt), "表格含毫米/像素误差列");

  // —— 冻结 → 成为当前底稿 ——
  $("calFreeze").click();
  await until(() => $("calBadge").textContent === "已冻结", "冻结完成");
  ok(window.LG.state.doc.underlay.versionId === ver.id, "冻结后设为当前底稿版本");
  await until(() => window.LG.state.underlayBmp, "画布底稿位图已生成");
  ok(window.LG.state.doc.underlay.visible === true, "底稿可见");
  ok($("calibPanel").textContent.includes("已冻结"), "侧栏版本标记已冻结");
  // 冻结后点表输入被禁用
  await window.LG.calibui.loadProjectData(pid);
  window.LG.calibui.openWorkspace(ver.id);
  await until(() => $("calTbody").children.length === 4, "重开工作区");
  ok($("calTbody").querySelector("input[type=number]").disabled, "冻结后坐标输入禁用");
  ok($("calCompute").disabled, "冻结后计算按钮禁用");
  $("calClose").click();
  await sleep(100);

  // —— 复制方案 → 调整点集 → 比较 RMS ——
  const copyBtn = [...$("calibPanel").querySelectorAll("[data-copy]")][0];
  copyBtn.click();
  await until(() => $("calibPanel").textContent.includes("副本"), "方案已复制");
  const vs = await window.LG.app.api("GET", `/api/projects/${pid}/calib`);
  ok(vs.length === 2 && vs[1].frozen === false, "副本为草稿（未冻结）");
  ok(vs[0].params && vs[1].params && vs[0].params.rmsMm === vs[1].params.rmsMm,
    "复制前后 RMS 一致，可继续调整比较");

  // —— 画布底稿图层 ——
  window.LG.editor.render();
  const uImg = window.document.querySelector("#layer-underlay image");
  ok(uImg && uImg.getAttribute("href").startsWith("data:image"), "底稿图像已叠到画布底层");
  ok(uImg && +uImg.getAttribute("opacity") > 0, "底稿透明度生效");
  // 裁切范围
  window.LG.state.doc.underlay.crop = { x0: 0, y0: 0, x1: 200, y1: 150 };
  window.LG.editor.render();
  const clipImg = window.document.querySelector("#layer-underlay image");
  ok(clipImg.getAttribute("clip-path") === "url(#underlayClip)", "裁切范围应用 clipPath");
  const clipRect = window.document.querySelector("#underlayClip rect");
  ok(+clipRect.getAttribute("width") === 200, "裁切矩形尺寸正确");
  // 切换显隐
  window.LG.state.doc.underlay.visible = false;
  window.LG.editor.render();
  ok(!window.document.querySelector("#layer-underlay image"), "隐藏后底稿不渲染");
  window.LG.state.doc.underlay.visible = true;

  // —— 纸样预览淡印底稿 ——
  window.LG.state.doc.frame = { x: 0, y: 0, w: 600, h: 800 };
  window.LG.state.doc.underlay.printFaint = true;
  $("btnPrint").click();
  await until(() => $("printOverlay").classList.contains("show"), "纸样预览打开");
  ok($("printUnderlayWrap").style.display !== "none", "淡印选项可见");
  ok($("printUnderlay").checked, "淡印按项目设置勾选");
  ok($("printPages").innerHTML.includes("<image"), "纸样 SVG 含淡印底稿图像");
  $("printUnderlay").checked = false;
  $("printUnderlay").dispatchEvent(new window.Event("change"));
  ok(!$("printPages").innerHTML.includes("<image"), "取消勾选后不淡印");
  $("closePrint").click();

  // —— 项目恢复：照片与全部版本保留 ——
  const vs2 = await window.LG.app.api("GET", `/api/projects/${pid}/calib`);
  ok(vs2.length === 2 && vs2.every((v) => v.points.length === 4), "恢复后全部版本与控制点保留");
  const phs = await window.LG.app.api("GET", `/api/projects/${pid}/photos`);
  ok(phs.length === 1 && phs[0].size > 0, "原图二进制保留");

  // 清理测试项目
  await window.LG.app.api("DELETE", "/api/projects/" + pid);
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("集成测试异常：", e); process.exit(1); });
