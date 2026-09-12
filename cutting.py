#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cutting.py — 铅条下料与接头编排（纯计算，无 Flask/DB 依赖，便于单测）

输入 payload（由浏览器按当前项目文档组装）：
  nodes: [{id,x,y}]
  edges: [{id,a,b,kind}]            # kind: lead / frame
  sequenceEdgeOrder: [edgeId]       # 放铅次序，用于构件编号稳定
  settings: {leadFaceWidth,...}     # 老项目无规格时的兜底面宽
  cutting:
    specs: [{id,name,faceWidth,heart,hardness,stockLength,kerf,minRemnant,isDefault}]
    edgeSpecs: {edgeId: specId}
    joints: {nodeId: {through:[eid,eid], butt:[eid...], miter:[eid...]}}
    locks: [chainKey]               # chainKey = 构件所含边 id 排序后 "|" 连接
    remnants: [{id,specId,length}]  # 可复用余料池
    slotAllowance: 槽口余量 mm
    minJointGap: 接头最小间距 mm

输出 members（连续铅条/构件）、节点接头编排 terms、问题 issues、三种排料策略 plans。
单位均为 mm；屏幕坐标系（y 向下），角度计算与坐标方向无关。
"""
import math

TURN_THRU = "through"
TURN_BUTT = "butt"
TURN_MITER = "miter"
TURN_DANGLING = "dangling"


def _vsub(p, q):
    return p["x"] - q["x"], p["y"] - q["y"]


def _vlen(vx, vy):
    return math.hypot(vx, vy)


def _angle_between(v1, v2):
    """两向量夹角 0..π"""
    l1, l2 = _vlen(*v1), _vlen(*v2)
    if l1 < 1e-9 or l2 < 1e-9:
        return 0.0
    c = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
    return math.acos(max(-1.0, min(1.0, c)))


def _num(v, default=0.0):
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _r2(v):
    return round(float(v) + 0.0, 2)


def compute(payload):
    nodes = {}
    for n in payload.get("nodes") or []:
        nid = n.get("id")
        if nid is not None:
            nodes[nid] = {"id": nid, "x": _num(n.get("x")), "y": _num(n.get("y"))}

    edges = []
    edge_by_id = {}
    for e in payload.get("edges") or []:
        if e.get("a") in nodes and e.get("b") in nodes and e.get("id") is not None:
            rec = {
                "id": e["id"], "a": e["a"], "b": e["b"],
                "kind": e.get("kind") or "lead",
            }
            edges.append(rec)
            edge_by_id[rec["id"]] = rec

    inc = {nid: [] for nid in nodes}
    for e in edges:
        inc[e["a"]].append(e["id"])
        inc[e["b"]].append(e["id"])

    settings = payload.get("settings") or {}
    glob_face = _num(settings.get("leadFaceWidth"), 6.0)

    cut = payload.get("cutting") or {}
    spec_list = cut.get("specs") or []
    specs = {}
    for s in spec_list:
        if s.get("id"):
            specs[s["id"]] = {
                "id": s["id"],
                "name": s.get("name") or "未命名规格",
                "faceWidth": max(0.1, _num(s.get("faceWidth"), glob_face)),
                "heart": max(0.0, _num(s.get("heart"), 1.2)),
                "hardness": s.get("hardness") or "中",
                "stockLength": max(1.0, _num(s.get("stockLength"), 1800.0)),
                "kerf": max(0.0, _num(s.get("kerf"), 3.0)),
                "minRemnant": max(0.0, _num(s.get("minRemnant"), 150.0)),
            }
    default_spec = None
    for s in spec_list:
        if s.get("isDefault") and s.get("id") in specs:
            default_spec = s["id"]
            break
    if default_spec is None and spec_list:
        default_spec = spec_list[0].get("id")

    edge_specs = cut.get("edgeSpecs") or {}

    def spec_of(eid):
        sid = edge_specs.get(eid)
        return sid if sid in specs else default_spec

    def face_of(eid):
        sid = spec_of(eid)
        return specs[sid]["faceWidth"] if sid else glob_face

    slot = max(0.0, _num(cut.get("slotAllowance"), 4.0))
    min_gap = max(0.0, _num(cut.get("minJointGap"), 60.0))
    locks = set(cut.get("locks") or [])
    explicit = cut.get("joints") or {}

    issues = []
    seq = [0]

    def add_issue(typ, sev, msg, x, y, data=None):
        issues.append({
            "id": "cj%d" % seq[0], "type": typ, "severity": sev, "msg": msg,
            "x": _r2(x), "y": _r2(y), "data": data or {},
        })
        seq[0] += 1

    def away(nid, eid):
        """边 eid 在节点 nid 处背离节点的单位向量"""
        e = edge_by_id[eid]
        p, q = nodes[nid], nodes[e["b"] if e["a"] == nid else e["a"]]
        vx, vy = _vsub(q, p)
        l = _vlen(vx, vy)
        if l < 1e-9:
            return 0.0, 0.0
        return vx / l, vy / l

    def node_pt(nid):
        return nodes[nid]["x"], nodes[nid]["y"]

    # ---------- 逐节点解析接头编排 ----------
    # terms[eid-at-nid] 存在 role[nodeId][edgeId]；through_link[nodeId] = 连续对
    role = {nid: {} for nid in nodes}
    through_link = {}
    joint_info = {}

    for nid, eids in inc.items():
        deg = len(eids)
        x, y = node_pt(nid)
        if deg == 0:
            continue
        if deg == 1:
            role[nid][eids[0]] = TURN_DANGLING
            joint_info[nid] = {"kind": "end", "through": [], "butt": [],
                               "miter": [], "pairs": []}
            continue

        ex = explicit.get(nid) or {}
        thru, butt, miter = [], [], []
        if ex:
            ex_through = [x for x in (ex.get("through") or []) if x in eids]
            ex_miter = [x for x in (ex.get("miter") or []) if x in eids]
            ex_butt = [x for x in (ex.get("butt") or []) if x in eids]
            # 显式编排以 through 为优先，其余按 miter/butt 名单；未列出的默认顶接
            thru = ex_through[:2]
            for eid in eids:
                if eid in thru:
                    continue
                if eid in ex_miter:
                    miter.append(eid)
                elif eid in ex_butt:
                    butt.append(eid)
                else:
                    butt.append(eid)
        elif deg == 2:
            kinds = {edge_by_id[eids[0]]["kind"], edge_by_id[eids[1]]["kind"]}
            if kinds == {"frame"}:
                miter = eids[:]          # 外框转角默认 45° 斜接
            else:
                thru = eids[:]           # 普通二通节点默认一路连续
        else:
            # 三通/四通：取最接近直线（夹角最接近 π）的一对连续穿过，其余顶接
            best, best_score = None, None
            for i in range(deg):
                for j in range(i + 1, deg):
                    a_ang = _angle_between(away(nid, eids[i]), away(nid, eids[j]))
                    score = abs(a_ang - math.pi)
                    if best_score is None or score < best_score:
                        best_score, best = score, (eids[i], eids[j])
            thru = list(best)
            butt = [e for e in eids if e not in thru]

        # 斜接配对：按背离方向圆周角排序，贪心配对夹角最小的相邻两路；落单者退化为顶接
        pairs = []
        if miter:
            # 按背离方向圆周角排序，贪心配对夹角最小的相邻两路；落单者退化为顶接
            def ang(e):
                vx, vy = away(nid, e)
                return math.atan2(vy, vx)

            order = sorted(miter, key=ang)
            gaps = []
            for k, e in enumerate(order):
                e2 = order[(k + 1) % len(order)]
                a1 = math.atan2(away(nid, e)[1], away(nid, e)[0])
                a2 = math.atan2(away(nid, e2)[1], away(nid, e2)[0])
                gap = (a2 - a1) % (2 * math.pi)
                gaps.append((gap, k))
            paired = set()
            for _, k in sorted(gaps):
                a, b = order[k], order[(k + 1) % len(order)]
                if a in paired or b in paired:
                    continue
                paired.add(a)
                paired.add(b)
                pairs.append([a, b])
            for e in miter:
                if e not in paired:
                    butt.append(e)
                    add_issue("miter_unpaired", "warn",
                              "斜接路数为奇数，一路无法成对，已按顶接处理", x, y,
                              {"nodeId": nid, "edgeId": e})
            miter = [e for e in miter if e in paired]

        if len(thru) == 2:
            through_link[nid] = (thru[0], thru[1])
            for e in thru:
                role[nid][e] = TURN_THRU
        elif deg >= 3:
            add_issue("no_through", "warn",
                      "该节点没有任何一路连续穿过（全部顶接/斜接），请确认接头编排",
                      x, y, {"nodeId": nid})
        for e in butt:
            role[nid][e] = TURN_BUTT
        for a, b in pairs:
            role[nid][a] = TURN_MITER
            role[nid][b] = TURN_MITER

        kind = "end"
        if deg >= 3:
            kind = "tee" if thru else "butt_all"
        elif deg == 2:
            kind = "corner" if pairs else ("straight" if thru else "butt_all")
        joint_info[nid] = {
            "kind": kind, "through": thru, "butt": butt,
            "miter": miter, "pairs": pairs,
        }

    # 端头几何：沿中心线外伸量 ext、端切角 cutDeg（相对直切的偏角）、斜接侧切向
    term = {}  # (nid,eid) -> dict

    def put_term(nid, eid, **kw):
        term[(nid, eid)] = dict(kw)

    for nid, info in joint_info.items():
        x, y = node_pt(nid)
        for eid in info["through"]:
            put_term(nid, eid, type=TURN_THRU, ext=0.0, cutDeg=0.0)
        if info["kind"] == "end":
            eid = inc[nid][0]
            put_term(nid, eid, type=TURN_DANGLING, ext=0.0, cutDeg=0.0)
        # 顶接外伸 = 被顶住铅条面宽/2 + 槽口余量；无连续路时取节点最宽面
        if info["butt"]:
            block_edges = info["through"] or inc[nid]
            block_face = max(face_of(e) for e in block_edges)
            for eid in info["butt"]:
                put_term(nid, eid, type=TURN_BUTT,
                         ext=_r2(block_face / 2 + slot), cutDeg=0.0,
                         blockFace=_r2(block_face))
        # 斜接：外伸 = 面宽/2 / sin(α/2)，端切偏角 = 90° − α/2
        for a, b in info["pairs"]:
            va, vb = away(nid, a), away(nid, b)
            alpha = _angle_between(va, vb)
            alpha_eff = max(alpha, math.radians(1))
            for eid, v in ((a, va), (b, vb)):
                ext = face_of(eid) / 2 / math.sin(alpha_eff / 2)
                cut_deg = 90 - math.degrees(alpha_eff) / 2
                bx, by = va[0] + vb[0], va[1] + vb[1]
                bl = _vlen(bx, by) or 1.0
                bis = (bx / bl, by / bl)               # 夹角平分线（背离节点）
                lx, ly = -v[1], v[0]                   # 行进方向左手侧（屏幕坐标）
                side = "L" if (bis[0] * lx + bis[1] * ly) > 0 else "R"
                put_term(nid, eid, type=TURN_MITER,
                         ext=_r2(ext), cutDeg=_r2(cut_deg),
                         angleDeg=_r2(math.degrees(alpha)), side=side,
                         pair=[a, b])
            if alpha < math.radians(20):
                add_issue("miter_sharp", "warn",
                          "斜接夹角仅 %.0f°，端头外伸量很大（%.0fmm），建议改用顶接"
                          % (math.degrees(alpha),
                             face_of(a) / 2 / math.sin(alpha_eff / 2)),
                          x, y, {"nodeId": nid})

    def thru_partner(nid, eid):
        pair = through_link.get(nid)
        if not pair:
            return None
        return pair[1] if pair[0] == eid else (pair[0] if pair[1] == eid else None)

    # ---------- 沿连续对串联构件（一根连续铅条） ----------
    def edge_len(eid):
        e = edge_by_id[eid]
        return _vlen(*_vsub(nodes[e["a"]], nodes[e["b"]]))

    def other_end(eid, nid):
        e = edge_by_id[eid]
        return e["b"] if e["a"] == nid else e["a"]

    def build(start_eid, start_nid):
        order, path = [], [start_nid]
        bends = []
        eid, nid = start_eid, start_nid
        closed = False
        guard = 0
        while guard < 100000:
            guard += 1
            order.append(eid)
            nxt = other_end(eid, nid)
            path.append(nxt)
            pe = thru_partner(nxt, eid)
            if pe is None:
                break
            if pe in order:
                closed = True
                break
            # 弯折角：进入方向与离开方向的偏转角（0=直通，90=直角弯）
            pa, pn, pq = nodes[nid], nodes[nxt], nodes[other_end(pe, nxt)]
            v_in = _vsub(pn, pa)
            v_out = _vsub(pq, pn)
            bends.append({
                "nodeId": nxt, "x": _r2(pn["x"]), "y": _r2(pn["y"]),
                "deflectDeg": _r2(math.degrees(_angle_between(v_in, v_out))),
            })
            eid, nid = pe, nxt
        return order, path, bends, closed

    visited = set()
    chains = []
    # 开口链：从端头边（至少一端非连续）起沿
    for e in edges:
        eid = e["id"]
        if eid in visited:
            continue
        start_n = None
        for nid in (e["a"], e["b"]):
            if role[nid].get(eid) != TURN_THRU:
                start_n = nid
                break
        if start_n is None:
            continue
        order, path, bends, closed = build(eid, start_n)
        visited.update(order)
        chains.append((order, path, bends, closed))
    # 闭合环
    for e in edges:
        if e["id"] in visited:
            continue
        order, path, bends, closed = build(e["id"], e["a"])
        visited.update(order)
        chains.append((order, path, bends, True))

    seq_pos = {eid: i for i, eid in enumerate(payload.get("sequenceEdgeOrder") or [])}
    edge_pos = {e["id"]: i for i, e in enumerate(edges)}

    def chain_rank(ch):
        order, path = ch[0], ch[1]
        poss = [seq_pos[e] for e in order if e in seq_pos]
        if poss:
            return (0, min(poss))
        ys = [nodes[nid]["y"] for nid in path]
        xs = [nodes[nid]["x"] for nid in path]
        return (1, min(ys), min(xs), min(edge_pos[e] for e in order))

    chains.sort(key=chain_rank)

    members = []
    for num, (order, path, bends, closed) in enumerate(chains, 1):
        center = sum(edge_len(e) for e in order)
        ends = []
        if not closed:
            for nid, eid in ((path[0], order[0]), (path[-1], order[-1])):
                t = term.get((nid, eid)) or {"type": TURN_BUTT, "ext": 0.0, "cutDeg": 0.0}
                ends.append({
                    "nodeId": nid, "edgeId": eid,
                    "x": _r2(nodes[nid]["x"]), "y": _r2(nodes[nid]["y"]),
                    **t,
                })
        length = center + sum(_num(e.get("ext")) for e in ends)
        spec_ids = [spec_of(e) for e in order]
        spec_id = default_spec
        if spec_ids:
            spec_id = max(set(spec_ids), key=spec_ids.count)
        mixed = sorted({e for e, s in zip(order, spec_ids) if s != spec_id})
        key = "|".join(sorted(order))
        ys = [nodes[nid]["y"] for nid in path]
        xs = [nodes[nid]["x"] for nid in path]
        mx, my = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        members.append({
            "id": "M%d" % num, "num": num, "key": key,
            "edges": order, "edgeCount": len(order),
            "centerLen": _r2(center), "length": _r2(length),
            "specId": spec_id, "mixedEdges": mixed,
            "ends": ends, "bends": bends, "closed": closed,
            "locked": key in locks,
            "cx": _r2(mx), "cy": _r2(my),
        })

    member_by_id = {m["id"]: m for m in members}
    member_of_edge = {}
    for m in members:
        for eid in m["edges"]:
            member_of_edge[eid] = m["id"]

    # ---------- 接头/构件问题定位 ----------
    # 接头过近：两个非悬空接头节点中心距 < 阈值（只报最近邻，去重）
    joint_nodes = [nid for nid in nodes if len(inc[nid]) >= 2]
    emitted_pairs = set()
    for nid in joint_nodes:
        best, bd = None, None
        x1, y1 = node_pt(nid)
        for o in joint_nodes:
            if o == nid:
                continue
            x2, y2 = node_pt(o)
            d = _vlen(x2 - x1, y2 - y1)
            if d < min_gap and (bd is None or d < bd):
                best, bd = o, d
        if best and (nid, best) not in emitted_pairs:
            emitted_pairs.add((nid, best))
            emitted_pairs.add((best, nid))
            add_issue("joint_close", "warn",
                      "接头间距 %.0fmm < 最小间距 %.0fmm，焊/接操作空间不足"
                      % (bd, min_gap), (x1 + nodes[best]["x"]) / 2,
                      (y1 + nodes[best]["y"]) / 2,
                      {"nodeA": nid, "nodeB": best, "dist": _r2(bd)})

    for m in members:
        spec = specs.get(m["specId"]) if m["specId"] else None
        if m["specId"] is None:
            em = m["edges"][0]
            e = edge_by_id[em]
            add_issue("spec_missing", "error",
                      "铅条 #%d 未指定规格，无法排料" % m["num"],
                      m["cx"], m["cy"], {"memberId": m["id"]})
        else:
            if m["length"] > spec["stockLength"] + 1e-6:
                add_issue("overlength", "error",
                          "铅条 #%d 下料长度 %.0fmm 超过 %s 库存条长 %.0fmm，需接管或换规格"
                          % (m["num"], m["length"], spec["name"], spec["stockLength"]),
                          m["cx"], m["cy"],
                          {"memberId": m["id"], "length": m["length"],
                           "stockLength": spec["stockLength"]})
        if m["mixedEdges"]:
            names = []
            for eid in m["mixedEdges"][:3]:
                sid = spec_of(eid)
                names.append(specs[sid]["name"] if sid else "无规格")
            e0 = edge_by_id[m["mixedEdges"][0]]
            add_issue("spec_mismatch", "warn",
                      "铅条 #%d 内规格不一致（含 %s），连续穿过段必须同规格"
                      % (m["num"], "、".join(names)),
                      m["cx"], m["cy"],
                      {"memberId": m["id"], "edges": m["mixedEdges"]})
        if m["closed"]:
            add_issue("closed_loop", "warn",
                      "铅条 #%d 为闭合环，需在一处断开后再弯制/排料" % m["num"],
                      m["cx"], m["cy"], {"memberId": m["id"]})

    # ---------- 排料（一维下料） ----------
    remnants = []
    for r in cut.get("remnants") or []:
        if r.get("id") and r.get("specId") in specs and _num(r.get("length")) > 0:
            remnants.append({"id": r["id"], "specId": r["specId"],
                             "length": _num(r.get("length"))})

    def pack(spec_id, mids, use_remnants, mode):
        """mode: ffd / bfd。返回 sticks, unplaced"""
        spec = specs[spec_id]
        L, kerf, minr = spec["stockLength"], spec["kerf"], spec["minRemnant"]
        sticks = []
        if use_remnants:
            for r in remnants:
                if r["specId"] == spec_id:
                    sticks.append({"specId": spec_id, "length": _r2(r["length"]),
                                   "source": "remnant", "sourceId": r["id"],
                                   "memberIds": [], "used": 0.0})
        unplaced = []

        def fits(st, ml):
            n = len(st["memberIds"])
            return st["used"] + (kerf if n else 0.0) + ml <= st["length"] + 1e-6

        for mid in sorted(mids, key=lambda x: -member_by_id[x]["length"]):
            ml = member_by_id[mid]["length"]
            if ml > L + 1e-6 and not any(fits(st, ml) for st in sticks):
                # 库存新料也放不下；余料条更短，直接判超尺
                unplaced.append(mid)
                continue
            targets = [st for st in sticks if fits(st, ml)]
            if mode == "bfd":
                # 最紧适配（剩余空间最小）；等紧时优先消耗余料条
                targets.sort(key=lambda st: (
                    st["length"] - (st["used"] + (kerf if st["memberIds"] else 0.0) + ml)
                    + (0 if st["source"] == "remnant" else 1e-9),
                    0 if st["source"] == "remnant" else 1))
            if targets:
                st = targets[0]
            else:
                st = {"specId": spec_id, "length": _r2(L), "source": "new",
                      "sourceId": None, "memberIds": [], "used": 0.0}
                sticks.append(st)
            if not fits(st, ml):  # 超尺保护
                if st in sticks and not st["memberIds"] and st["source"] == "new":
                    sticks.remove(st)
                unplaced.append(mid)
                continue
            if st["memberIds"]:
                st["used"] += kerf
            st["used"] += ml
            st["memberIds"].append(mid)

        out = []
        for st in sticks:
            if not st["memberIds"]:
                continue  # 未动用的余料条保持库存
            leftover = st["length"] - st["used"]
            reusable = leftover >= minr - 1e-6
            cuts = len(st["memberIds"]) - 1
            kerf_loss = kerf * cuts  # 锯路是实打实的材料损耗
            out.append({
                "specId": spec_id,
                "length": st["length"], "source": st["source"],
                "sourceId": st["sourceId"],
                "memberIds": st["memberIds"],
                "used": _r2(st["used"]),
                "cuts": cuts,
                "kerfLoss": _r2(kerf_loss),
                # 总废料 = 锯路 + 不足最短留余的料头；够长的余段计可复用余料
                "waste": _r2(kerf_loss + (0.0 if reusable else leftover)),
                "remnantLength": _r2(leftover) if reusable else None,
            })
        return out, unplaced

    unlocked = [m["id"] for m in members if not m["locked"] and m["specId"]]
    by_spec = {}
    for mid in unlocked:
        by_spec.setdefault(member_by_id[mid]["specId"], []).append(mid)

    strategies = []
    for key, name, use_r, mode in (
        ("ffd", "首次适配（新料）", False, "ffd"),
        ("bfd", "最佳适配（新料）", False, "bfd"),
        ("remnant", "余料优先", True, "bfd"),
    ):
        all_sticks, all_unplaced = [], []
        for sid in by_spec:
            stk, unp = pack(sid, by_spec[sid], use_r, mode)
            all_sticks.extend(stk)
            all_unplaced.extend(unp)
        # 无规格的构件一律无法排
        all_unplaced.extend(m["id"] for m in members if m["specId"] is None and not m["locked"])
        new_sticks = sum(1 for s in all_sticks if s["source"] == "new")
        waste_total = sum(s["waste"] for s in all_sticks)
        kerf_total = sum(s["kerfLoss"] for s in all_sticks)
        reusable_total = sum(s["remnantLength"] or 0 for s in all_sticks)
        consumed = [s["sourceId"] for s in all_sticks
                    if s["source"] == "remnant" and s["sourceId"]]
        strategies.append({
            "key": key, "name": name,
            "newSticks": new_sticks,
            "wasteTotal": _r2(waste_total),
            "kerfTotal": _r2(kerf_total),
            "reusableTotal": _r2(reusable_total),
            "consumedRemnants": consumed,
            "stickCount": len(all_sticks),
            "allPlaced": len(all_unplaced) == 0,
            "unplaced": all_unplaced,
            "sticks": all_sticks,
        })

    def rank(pl):
        return (0 if pl["allPlaced"] else 1, pl["newSticks"],
                pl["wasteTotal"], -pl["reusableTotal"])

    strategies.sort(key=rank)
    if strategies and strategies[0]["allPlaced"]:
        strategies[0]["recommended"] = True

    spec_summary = []
    for sid, s in specs.items():
        ms = [m for m in members if m["specId"] == sid]
        spec_summary.append({
            "specId": sid, "specName": s["name"],
            "count": len(ms),
            "length": _r2(sum(m["length"] for m in ms)),
            "lockedCount": sum(1 for m in ms if m["locked"]),
            "lockedLength": _r2(sum(m["length"] for m in ms if m["locked"])),
        })

    return {
        "members": members,
        "memberOfEdge": member_of_edge,
        "joints": joint_info,
        "terms": {
            "%s|%s" % (nid, eid): t for (nid, eid), t in term.items()
        },
        "issues": issues,
        "plans": {"strategies": strategies},
        "specs": {sid: specs[sid] for sid in specs},
        "summary": {
            "count": len(members),
            "totalLength": _r2(sum(m["length"] for m in members)),
            "lockedCount": sum(1 for m in members if m["locked"]),
            "lockedLength": _r2(sum(m["length"] for m in members if m["locked"])),
            "specs": spec_summary,
        },
    }
