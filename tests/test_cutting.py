#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_cutting.py — 下料/接头编排计算与 /api/cutting/compute 端点测试"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as appmod
import cutting as C

passed = failed = 0
def ok(cond, name):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + name)
    else:
        failed += 1
        print("  ✗ " + name)

SPEC = {"id": "s1", "name": "6mm 软铅", "faceWidth": 6, "heart": 1.2,
        "hardness": "软", "stockLength": 1800, "kerf": 3, "minRemnant": 150,
        "isDefault": True}
SPEC_W = {"id": "s2", "name": "10mm 硬铅", "faceWidth": 10, "heart": 1.8,
          "hardness": "硬", "stockLength": 2000, "kerf": 3, "minRemnant": 200}

# 2×2 网格 + 外框（同 main.js 示例）
def cross_payload(joints=None, specs=None, locks=None, remnants=None,
                  min_gap=60, slot=4, edges_extra=None, seq=None):
    def N(k, x, y): return {"id": k, "x": x, "y": y}
    nodes = [
        N("tl", 0, 0), N("t1", 200, 0), N("t2", 400, 0), N("tr", 600, 0),
        N("l1", 0, 260), N("c1", 200, 260), N("c2", 400, 260), N("r1", 600, 260),
        N("l2", 0, 530), N("c3", 200, 530), N("c4", 400, 530), N("r2", 600, 530),
        N("bl", 0, 800), N("b1", 200, 800), N("b2", 400, 800), N("br", 600, 800),
    ]
    E = []
    def e(a, b, kind="lead"): E.append({"id": "e_%s_%s" % (a, b), "a": a, "b": b, "kind": kind})
    e("tl", "t1", "frame"); e("t1", "t2", "frame"); e("t2", "tr", "frame")
    e("tr", "r1", "frame"); e("r1", "r2", "frame"); e("r2", "br", "frame")
    e("br", "b2", "frame"); e("b2", "b1", "frame"); e("b1", "bl", "frame")
    e("bl", "l2", "frame"); e("l2", "l1", "frame"); e("l1", "tl", "frame")
    e("t1", "c1"); e("c1", "c3"); e("c3", "b1")
    e("t2", "c2"); e("c2", "c4"); e("c4", "b2")
    e("l1", "c1"); e("c1", "c2"); e("c2", "r1")
    e("l2", "c3"); e("c3", "c4"); e("c4", "r2")
    if edges_extra:
        E.extend(edges_extra)
    return {
        "nodes": nodes, "edges": E,
        "sequenceEdgeOrder": seq or [x["id"] for x in E],
        "settings": {"leadFaceWidth": 6},
        "cutting": {
            "specs": specs or [SPEC],
            "joints": joints or {},
            "edgeSpecs": {},
            "locks": locks or [],
            "remnants": remnants or [],
            "slotAllowance": slot, "minJointGap": min_gap,
        },
    }

def find_member(r, *edge_ids):
    s = set(edge_ids)
    for m in r["members"]:
        if s.issubset(set(m["edges"])):
            return m
    return None

# ---------- 默认接头 ----------
print("\n== 默认接头编排 ==")
r = C.compute(cross_payload())
# 4 个外框转角：每处 2 条 frame 边 → 斜接 → 4 根外框构件
frame_edge_ids = {e["id"] for e in cross_payload()["edges"]
                  if e["kind"] == "frame"}
frame_members = [m for m in r["members"]
                 if set(m["edges"]).issubset(frame_edge_ids)]
ok(len(frame_members) == 4, "外框默认 4 根斜接转角构件（实际 %d）" % len(frame_members))
corner = frame_members[0]
ok(all(en["type"] == "miter" and abs(en["cutDeg"] - 45.0) < 0.01
       for en in corner["ends"]), "外框转角两端 45° 斜切")
ok(abs(corner["ends"][0]["ext"] - 6 / 2 / 0.70710678) < 0.01,
   "斜接外伸 = 面宽/2/sin45 ≈ 4.24mm（实际 %.2f）" % corner["ends"][0]["ext"])
ok(abs(corner["length"] - (corner["centerLen"] + 2 * corner["ends"][0]["ext"])) < 0.01,
   "下料长度 = 中心线长 + 两端外伸")

# 内部十字默认：最直对穿、其余顶接
m_vert = find_member(r, "e_c1_c3")  # c1-c2-c3-c4 处三通
j = r["joints"]
ok(j["c1"]["through"] == ["e_t1_c1", "e_c1_c3"] or
   set(j["c1"]["through"]) == {"e_t1_c1", "e_c1_c3"},
   "三通 c1 默认竖路连续穿过: %s" % j["c1"]["through"])
ok(set(j["c1"]["butt"]) == {"e_l1_c1", "e_c1_c2"},
   "三通 c1 其余两路顶接: %s" % j["c1"]["butt"])
m_butt = find_member(r, "e_l1_c1")
ok(abs(m_butt["ends"][0]["ext"] - 7.0) < 0.01 or abs(m_butt["ends"][1]["ext"] - 7.0) < 0.01,
   "顶接外伸 = 被顶面宽/2 + 槽口余量 = 7mm")

# 直通二通节点弯折角
m_v = find_member(r, "e_t1_c1", "e_c1_c3", "e_c3_b1")
ok(m_v is not None and len(m_v["edges"]) == 3, "竖路三段串成一根连续铅条")
ok(all(abs(b["deflectDeg"]) < 0.01 for b in m_v["bends"]),
   "直通节点弯折角 0°（实际 %s）" % [b["deflectDeg"] for b in m_v["bends"]])

# ---------- 显式斜接 ----------
print("\n== 显式接头编排 ==")
r2 = C.compute(cross_payload(joints={
    "c1": {"through": [], "miter": ["e_l1_c1", "e_c1_c2"], "butt": ["e_t1_c1", "e_c1_c3"]}}))
jc = r2["joints"]["c1"]
ok({tuple(sorted(p)) for p in jc["pairs"]} == {tuple(sorted(("e_l1_c1", "e_c1_c2")))},
   "斜接对按编排生成")
term = r2["terms"]["c1|e_l1_c1"]
ok(term["type"] == "miter" and abs(term["angleDeg"] - 180.0) < 0.01,
   "共线反向斜接 α=180°（退化为直切）")
ok(any(i["type"] == "no_through" for i in r2["issues"]),
   "全顶/斜接节点报“无连续路”警告")

# 奇数斜接落单 → 退化顶接
r3 = C.compute(cross_payload(joints={
    "c1": {"through": [], "miter": ["e_l1_c1", "e_c1_c2", "e_t1_c1"]}}))
ok(any(i["type"] == "miter_unpaired" for i in r3["issues"]), "奇数路斜接报落单警告")
ok(len(r3["joints"]["c1"]["miter"]) == 2, "落单一路退出斜接（miter=%d）" %
   len(r3["joints"]["c1"]["miter"]))

# 90° 转角斜接（外框）切向 L/R 相反
sides = {corner["ends"][0]["side"], corner["ends"][1]["side"]}
ok(sides == {"L", "R"}, "同一根框条两端斜切方向相反: %s" % sides)

# ---------- 问题定位 ----------
print("\n== 问题定位 ==")
# 悬空端头
p = cross_payload()
p["nodes"].append({"id": "d", "x": 300, "y": 400})
p["edges"].append({"id": "e_d", "a": "d", "b": "c3"})
r4 = C.compute(p)
m_d = find_member(r4, "e_d")
ok(m_d is not None and any(en["type"] == "dangling" for en in m_d["ends"]),
   "悬空端标记 dangling")

# 接头过近（t1→c1 距离 260mm）
p = cross_payload(min_gap=300)
r5 = C.compute(p)
jc_issues = [i for i in r5["issues"] if i["type"] == "joint_close"]
ok(jc_issues, "接头间距 <300mm 报警")
# 对最近邻去重：每对只报一次
pair_keys = sorted(tuple(sorted([i["data"]["nodeA"], i["data"]["nodeB"]])) for i in jc_issues)
ok(len(pair_keys) == len(set(pair_keys)), "接头过近问题每对只报一次")

# 超尺
p = cross_payload(specs=[dict(SPEC, stockLength=500)])
r6 = C.compute(p)
long_m = next(m for m in r6["members"] if m["length"] > 500)
i6 = next(i for i in r6["issues"] if i["type"] == "overlength")
ok(i6["data"]["memberId"] == long_m["id"], "超长构件定位到具体铅条 %s" % i6["data"])

# 规格不一致：把连续构件中的一条边换成另一规格
p = cross_payload(specs=[SPEC, SPEC_W])
p["cutting"]["edgeSpecs"] = {"e_c1_c3": "s2"}
r7 = C.compute(p)
mm = next(i for i in r7["issues"] if i["type"] == "spec_mismatch")
ok("e_c1_c3" in mm["data"]["edges"], "连续构件内规格不一致定位到边")
mixed = find_member(r7, "e_t1_c1", "e_c1_c3")
ok(mixed["mixedEdges"] == ["e_c1_c3"], "mixedEdges 记录异类边")

# ---------- 锁定与排料 ----------
print("\n== 锁定与排料 ==")
key = "|".join(sorted(["e_t1_c1", "e_c1_c3", "e_c3_b1"]))
r8 = C.compute(cross_payload(locks=[key]))
locked = [m for m in r8["members"] if m["locked"]]
ok(len(locked) == 1 and set(locked[0]["edges"]) == set(key.split("|")),
   "按 chainKey 锁定整根连续铅条")
for pl in r8["plans"]["strategies"]:
    ok(all(mid not in [m["id"] for m in locked] for s in pl["sticks"] for mid in s["memberIds"]),
       "方案 %s 不含已锁定构件" % pl["key"])

# 新料根数 / 总废料 / 可复用余料都给出且方案完整
pl = r8["plans"]["strategies"][0]
ok(pl["allPlaced"] and pl["unplaced"] == [], "推荐方案排下全部未锁定构件")
ok(all("waste" in s and "remnantLength" in s for s in pl["sticks"]),
   "每根库存条给出废料与可复用余料长度")
tot = sum(s["waste"] + (s["remnantLength"] or 0) for s in pl["sticks"])
used_len = sum(m["length"] for m in r8["members"] if not m["locked"])
kerfs = sum(C._num(SPEC["kerf"]) * (len(s["memberIds"]) - 1) for s in pl["sticks"])
ok(abs(tot - (pl["newSticks"] * 1800 - used_len - kerfs)) < 0.5,
   "废料+余料+锯路+用料 = 新料总长")

# 余料优先策略先消耗余料条
r9 = C.compute(cross_payload(remnants=[
    {"id": "rm1", "specId": "s1", "length": 900},
]))
rp = next(p for p in r9["plans"]["strategies"] if p["key"] == "remnant")
ok(any(s["source"] == "remnant" and s["sourceId"] == "rm1" for s in rp["sticks"]),
   "余料优先方案排入库存余料条")
ok("rm1" in rp["consumedRemnants"], "consumedRemnants 记录已消耗余料")
# 未用的余料不出现
ok(all(s["memberIds"] for s in rp["sticks"]), "未动用余料条不产生空条记录")

# 超尺构件无法排入 → unplaced
p = cross_payload(specs=[dict(SPEC, stockLength=200)])
r10 = C.compute(p)
pl10 = r10["plans"]["strategies"][0]
ok(not pl10["allPlaced"] and pl10["unplaced"], "超尺构件进 unplaced 而非静默丢弃")
ok(not pl10.get("recommended"), "存在排不下构件时该方案不作推荐")

# 构件编号稳定：按放铅次序首次出现排序
nums = {tuple(m["edges"]): m["num"] for m in C.compute(cross_payload())["members"]}
rev = cross_payload(seq=list(reversed(
    [e["id"] for e in cross_payload()["edges"]])))
nums_rev = {tuple(m["edges"]): m["num"] for m in C.compute(rev)["members"]}
ok(nums != nums_rev, "编号随放铅次序稳定排列")

# ---------- 汇总 ----------
print("\n== 规格汇总 ==")
sm = {x["specId"]: x for x in r8["summary"]["specs"]}
ok(sm["s1"]["count"] == len(r8["members"]) and sm["s1"]["lockedCount"] == 1,
   "按规格汇总根数与锁定数: %s" % sm["s1"])

# ---------- API 端点 ----------
print("\n== /api/cutting/compute ==")
appmod.init_db()
c = appmod.app.test_client()
resp = c.post("/api/cutting/compute", json=cross_payload())
ok(resp.status_code == 200 and resp.get_json()["members"], "端点 200 返回构件")
resp = c.post("/api/cutting/compute", data="not json", content_type="application/json")
ok(resp.status_code == 200 and resp.get_json()["members"] == [],
   "无法解析的 body 按空载荷处理（200 空结果），不抛异常")
resp = c.post("/api/cutting/compute", json={"nodes": "bad"})
ok(resp.status_code == 400, "结构错误返回 400")

print(f"\n结果：{passed} 通过，{failed} 失败")
sys.exit(1 if failed else 0)
