/* test_calibration.js — 底稿校准数学核心测试：仿射/透视拟合、退化拒绝、残差、求逆 */
require("../static/js/calibration.js");
const LG = globalThis.LG;
const C = LG.calib;

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
}
function section(t) { console.log("\n== " + t + " =="); }
const pt = (u, v, X, Y, extra) =>
  Object.assign({ id: "p" + Math.random().toString(36).slice(2, 7), imgX: u, imgY: v, panelX: X, panelY: Y, locked: false, excluded: false }, extra);

section("仿射：精确 3 点还原已知变换");
{
  // 已知变换：X = 0.4u - 0.1v + 25，Y = 0.05u + 0.35v + 60
  const f = (u, v) => [0.4 * u - 0.1 * v + 25, 0.05 * u + 0.35 * v + 60];
  const pts = [[100, 200], [1500, 300], [800, 1600]].map(([u, v]) => {
    const [X, Y] = f(u, v); return pt(u, v, X, Y);
  });
  const p = C.compute(pts, "affine");
  ok(p.type === "affine", "返回仿射参数");
  const q = C.apply(p, 777, 1234);
  const [ex, ey] = f(777, 1234);
  ok(Math.abs(q.x - ex) < 1e-6 && Math.abs(q.y - ey) < 1e-6, "新点映射误差 < 1e-6 mm");
  ok(p.rmsMm < 1e-6, `RMS≈0（实际 ${p.rmsMm}）`);
  ok(p.nPts === 3, "nPts=3");
}

section("仿射：多余点最小二乘 + 排除点");
{
  const f = (u, v) => [0.5 * u + 0.02 * v + 10, -0.01 * u + 0.5 * v + 30];
  const pts = [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 8; i++) {
    const u = 100 + rnd() * 1800, v = 100 + rnd() * 1400;
    const [X, Y] = f(u, v);
    pts.push(pt(u, v, X + (rnd() - 0.5) * 0.6, Y + (rnd() - 0.5) * 0.6)); // ±0.3mm 噪声
  }
  const p1 = C.compute(pts, "affine");
  ok(p1.rmsMm > 0 && p1.rmsMm < 0.5, `8 点含噪拟合 RMS 合理（${p1.rmsMm.toFixed(3)}mm）`);
  // 加入一个异常点并排除：RMS 不应显著变差
  pts.push(pt(900, 700, 0, 0, { excluded: true }));
  const p2 = C.compute(pts, "affine");
  ok(Math.abs(p2.rmsMm - p1.rmsMm) < 1e-9, "被排除的异常点不参与拟合");
  ok(p2.nPts === 8, "排除后 nPts=8");
}

section("仿射：退化拒绝");
{
  const mk = (arr) => arr.map(([u, v, X, Y]) => pt(u, v, X, Y));
  // 仅 2 点
  let err = null;
  try { C.compute(mk([[0, 0, 0, 0], [100, 0, 50, 0]]), "affine"); } catch (e) { err = e; }
  ok(err && /至少需要 3 组/.test(err.message), "少于 3 点 → 拒绝");
  // 图像点共线
  err = null;
  try { C.compute(mk([[0, 0, 0, 0], [100, 100, 50, 10], [200, 200, 100, 20]]), "affine"); } catch (e) { err = e; }
  ok(err && /共线/.test(err.message), "图像点共线 → 拒绝");
  // 面板坐标共线
  err = null;
  try { C.compute(mk([[0, 0, 0, 0], [100, 0, 50, 50], [0, 100, 100, 100]]), "affine"); } catch (e) { err = e; }
  ok(err && /共线/.test(err.message), "面板坐标共线 → 拒绝");
  // 全部重合
  err = null;
  try { C.compute(mk([[5, 5, 0, 0], [5, 5, 10, 10], [5, 5, 20, 0]]), "affine"); } catch (e) { err = e; }
  ok(err && /退化|共线|重合/.test(err.message), "点全部重合 → 拒绝");
}

section("透视：精确 4 点还原已知单应");
{
  // 已知单应 H
  const H = [[1.1, 0.05, 30], [0.02, 0.9, 50], [0.0002, -0.0001, 1]];
  const f = (u, v) => {
    const w = H[2][0] * u + H[2][1] * v + 1;
    return [(H[0][0] * u + H[0][1] * v + H[0][2]) / w, (H[1][0] * u + H[1][1] * v + H[1][2]) / w];
  };
  const pts = [[0, 0], [2000, 100], [1900, 1500], [100, 1400]].map(([u, v]) => {
    const [X, Y] = f(u, v); return pt(u, v, X, Y);
  });
  const p = C.compute(pts, "perspective");
  ok(p.type === "perspective", "返回透视参数");
  const q = C.apply(p, 1000, 800);
  const [ex, ey] = f(1000, 800);
  ok(Math.abs(q.x - ex) < 1e-4 && Math.abs(q.y - ey) < 1e-4,
    `新点映射误差 < 1e-4 mm（实际 ${Math.hypot(q.x - ex, q.y - ey).toExponential(2)}）`);
  ok(p.rmsMm < 1e-6, `RMS≈0（实际 ${p.rmsMm}）`);
}

section("透视：6 点最小二乘 + 退化拒绝");
{
  const H = [[0.9, -0.08, 120], [0.06, 1.05, 80], [-0.00015, 0.0001, 1]];
  const f = (u, v) => {
    const w = H[2][0] * u + H[2][1] * v + 1;
    return [(H[0][0] * u + H[0][1] * v + H[0][2]) / w, (H[1][0] * u + H[1][1] * v + H[1][2]) / w];
  };
  const raw = [[50, 60], [1800, 90], [1850, 1300], [80, 1250], [900, 700], [300, 900]];
  const pts = raw.map(([u, v]) => { const [X, Y] = f(u, v); return pt(u, v, X, Y); });
  const p = C.compute(pts, "perspective");
  ok(p.rmsMm < 1e-4, `6 点透视 RMS≈0（实际 ${p.rmsMm}）`);
  // 3 点不足
  let err = null;
  try { C.compute(pts.slice(0, 3), "perspective"); } catch (e) { err = e; }
  ok(err && /至少需要 4 组/.test(err.message), "透视少于 4 点 → 拒绝");
  // 4 点共线
  err = null;
  const col = [[0, 0], [100, 100], [200, 200], [300, 300]].map(([u, v]) => pt(u, v, u, v));
  try { C.compute(col, "perspective"); } catch (e) { err = e; }
  ok(err && /共线|退化/.test(err.message), "透视点共线 → 拒绝");
}

section("求逆与残差：方向 / 像素误差 / 毫米误差");
{
  // 仿射：缩放 0.5 mm/px + 平移
  const f = (u, v) => [0.5 * u + 100, 0.5 * v + 200];
  const pts = [[0, 0], [1000, 0], [0, 800], [1000, 800]].map(([u, v]) => {
    const [X, Y] = f(u, v); return pt(u, v, X, Y);
  });
  const p = C.compute(pts, "affine");
  const inv = C.invert(p);
  const back = C.apply(inv, 350, 500);
  ok(Math.abs(back.x - 500) < 1e-6 && Math.abs(back.y - 600) < 1e-6, "逆变换 (350,500)→(500,600)");
  // 把一个点的面板坐标挪动 (+3mm X, -4mm Y)：对原始精确变换求残差应精确反映
  pts[1].panelX += 3; pts[1].panelY -= 4;
  const res = C.residuals(pts, p);
  ok(res.length === 4, "残差覆盖全部点");
  const r1 = res[1];
  ok(Math.abs(r1.mmErr - 5) < 1e-6, `毫米误差 = 5mm（实际 ${r1.mmErr}）`);
  ok(Math.abs(r1.pxErr - r1.mmErr / 0.5) < 1e-6,
    `像素误差 = 毫米误差 ÷ 0.5mm/px（${r1.pxErr.toFixed(3)} vs ${(r1.mmErr / 0.5).toFixed(3)}）`);
  ok(Math.abs(r1.angDeg - Math.atan2(r1.resY, r1.resX) * 180 / Math.PI) < 1e-9, "残差方向角一致");
  ok(Math.abs(r1.resX - 3) < 1e-6 && Math.abs(r1.resY + 4) < 1e-6, "残差分量 = (+3,-4)mm");
  // 透视逆变换往返
  const H = [[1.1, 0.05, 30], [0.02, 0.9, 50], [0.0002, -0.0001, 1]];
  const fp = (u, v) => {
    const w = H[2][0] * u + H[2][1] * v + 1;
    return [(H[0][0] * u + H[0][1] * v + H[0][2]) / w, (H[1][0] * u + H[1][1] * v + H[1][2]) / w];
  };
  const ppts = [[0, 0], [2000, 100], [1900, 1500], [100, 1400], [900, 800]].map(([u, v]) => {
    const [X, Y] = fp(u, v); return pt(u, v, X, Y);
  });
  const pp = C.compute(ppts, "perspective");
  const pinv = C.invert(pp);
  const rt = C.apply(pinv, ...(() => { const q = C.apply(pp, 640, 480); return [q.x, q.y]; })());
  ok(Math.abs(rt.x - 640) < 1e-3 && Math.abs(rt.y - 480) < 1e-3, "透视正逆往返误差 < 1e-3 px");
}

section("点集指纹：参数过期判定");
{
  const pts = [pt(0, 0, 0, 0), pt(100, 0, 50, 0), pt(0, 100, 0, 50)];
  const p = C.compute(pts, "affine");
  ok(C.hashPoints(pts, "affine") === p.ptsHash, "计算后指纹一致");
  pts[0].panelX += 1;
  ok(C.hashPoints(pts, "affine") !== p.ptsHash, "改坐标后指纹变化（需重算）");
  pts[0].panelX -= 1;
  pts.push(pt(50, 50, 25, 25, { excluded: true }));
  ok(C.hashPoints(pts, "affine") === p.ptsHash, "被排除点不影响指纹");
  ok(C.hashPoints(pts, "perspective") !== p.ptsHash, "切换方法指纹变化");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
