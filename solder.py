#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""solder.py — 双面焊接排程：热量仿真、风险定位与候选重排（纯计算，无 Flask/DB 依赖）

输入 payload（由浏览器按当前项目文档组装）：
  nodes: [{id,x,y}]
  edges: [{id,a,b,kind}]
  sequence: [{type,ref}]                     # 放铅/嵌片次序，决定节点就位时刻与铅条覆盖
  joints: {nodeId:{through,butt,miter}}      # 下料接头编排结果（用于步骤指纹）
  solder:
    specHeat: {specId:{power,dwell,coolTau,radius}}  # 按铅条规格：功率档/停留s/冷却时间常数s/影响半径mm
    nodeSpec: {nodeId: specId}               # 节点 → 规格（浏览器按相连边解析）
    nodes: {nodeId:{side,lockFront,lockBack}}        # 焊面设置（front/back/both）与已完成锁定
    params: {flipTime,travelSpeed,leadTime,pieceTime,heatLimit}
    steps: [{key,type:"solder",node,side,fp} | {key,type:"flip"}]
  replay: {steps(含 x,y 快照),specHeat,nodeSpec,params} | None   # 历史版本回放

热量模型：每次焊接在停留结束时注入 Q=功率×停留 的热量，随后按 exp(-t/冷却常数) 衰减；
邻近节点按 (1-距离/半径) 线性衰减分享热量。风险：
  cool   冷却不足（同一焊点余热超阈）  hot  局部连续加热（邻近余热超阈）
  side   当前面不可达（需先翻面）      missed 漏焊（需求的焊面未排入）
  lead   相连铅条未在放铅次序中就位
几何/接头编排变化只让指纹（位置+相连边+接头角色）变化的步骤过期（stale）。
"""
import math

SIDE_FRONT = "front"
SIDE_BACK = "back"
OTHER = {SIDE_FRONT: SIDE_BACK, SIDE_BACK: SIDE_FRONT}
SIDE_NAME = {SIDE_FRONT: "正", SIDE_BACK: "背"}

DEFAULT_PARAMS = {"flipTime": 15.0, "travelSpeed": 60.0, "leadTime": 12.0,
                  "pieceTime": 10.0, "heatLimit": 0.35}
DEFAULT_HEAT = {"power": 3.0, "dwell": 2.5, "coolTau": 20.0, "radius": 60.0}

PARAM_CLAMP = {"flipTime": (0.0, 600.0), "travelSpeed": (1.0, 500.0),
               "leadTime": (0.0, 120.0), "pieceTime": (0.0, 120.0),
               "heatLimit": (0.05, 1.0)}
HEAT_CLAMP = {"power": (0.5, 9.0), "dwell": (0.5, 60.0),
              "coolTau": (1.0, 600.0), "radius": (0.0, 500.0)}


def _num(v, default=0.0):
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _r1(v):
    return round(float(v) + 0.0, 1)


def _r2(v):
    return round(float(v) + 0.0, 2)


def _norm_params(d, base=None):
    src = dict(base or DEFAULT_PARAMS)
    for k, v in (d or {}).items():
        if k in src:
            src[k] = _num(v, src[k])
    return {k: _clamp(src[k], *PARAM_CLAMP[k]) for k in src}


def _norm_heat(d):
    src = dict(DEFAULT_HEAT)
    for k, v in (d or {}).items():
        if k in src:
            src[k] = _num(v, src[k])
    return {k: _clamp(src[k], *HEAT_CLAMP[k]) for k in src}


# ---------- 步骤指纹：节点位置 + 相连边集合 + 接头角色 ----------
def _fp_of(nodes, inc, joints, nid):
    n = nodes[nid]
    j = joints.get(nid) or {}
    thr = set(j.get("through") or [])
    mit = set(j.get("miter") or [])
    but = set(j.get("butt") or [])
    roles = "".join(
        "t" if e in thr else "m" if e in mit else "b" if e in but else "-"
        for e in sorted(inc[nid]))
    return "%.1f,%.1f|%s|%s" % (n["x"], n["y"], ",".join(sorted(inc[nid])), roles)


# ---------- 候选排序策略 ----------
def _pair_sort_key(ctx):
    nodes = ctx["nodes"]

    def key(p):
        nid = p[0]
        n = nodes[nid]
        return (ctx["rank_of"](nid), n["y"], n["x"])
    return key


def _split_sides(pairs):
    fronts = [p for p in pairs if p[1] == SIDE_FRONT]
    backs = [p for p in pairs if p[1] == SIDE_BACK]
    return fronts, backs


def _order_ready(ctx, pairs):
    """按铅条就位顺序（同面集中，翻面最少）"""
    sk = _pair_sort_key(ctx)
    fronts, backs = _split_sides(pairs)
    return sorted(fronts, key=sk) + sorted(backs, key=sk)


def _order_near(ctx, pairs):
    """就近原则（空走最少）：同面块内最近邻"""
    nodes = ctx["nodes"]
    sk = _pair_sort_key(ctx)

    def nn(block):
        rest = list(block)
        out = []
        cur = None
        while rest:
            if cur is None:
                nxt = min(rest, key=sk)
            else:
                cx, cy = nodes[cur]["x"], nodes[cur]["y"]
                nxt = min(rest, key=lambda p: (
                    math.hypot(nodes[p[0]]["x"] - cx, nodes[p[0]]["y"] - cy), sk(p)))
            out.append(nxt)
            rest.remove(nxt)
            cur = nxt[0]
        return out

    fronts, backs = _split_sides(pairs)
    return nn(fronts) + nn(backs)


def _order_cool(ctx, pairs):
    """散热优先：贪心选择当前位置余热最低的焊点（同面块内）"""
    nodes = ctx["nodes"]
    params = ctx["params"]
    heat_of = ctx["heat_of"]
    sk = _pair_sort_key(ctx)
    fronts, backs = _split_sides(pairs)
    tcur = [ctx["tLead"]]
    pos = [None]
    inj = []  # (t, x, y, Q, tau, R)

    def block(block_pairs):
        rest = list(block_pairs)
        out = []
        while rest:
            best = None
            for p in rest:
                nid = p[0]
                n = nodes[nid]
                heat = heat_of(nid)
                dist = 0.0 if pos[0] is None else math.hypot(
                    n["x"] - pos[0][0], n["y"] - pos[0][1])
                start = tcur[0] + dist / params["travelSpeed"]
                res = 0.0
                for (ti, xi, yi, qi, taui, ri) in inj:
                    d = math.hypot(n["x"] - xi, n["y"] - yi)
                    if d < ri:
                        res += qi * (1 - d / ri) * math.exp(-(start - ti) / taui)
                cand = (round(res, 9), round(dist, 3), sk(p))
                if best is None or cand < best[0]:
                    best = (cand, p, start, heat, (n["x"], n["y"]))
            _, p, start, heat, xy = best
            rest.remove(p)
            q = heat["power"] * heat["dwell"]
            inj.append((start + heat["dwell"], xy[0], xy[1], q,
                        heat["coolTau"], heat["radius"]))
            tcur[0] = start + heat["dwell"]
            pos[0] = xy
            out.append(p)
        return out

    return block(fronts) + block(backs)


def _mk_steps(ctx, ordered, pfx):
    fp = ctx["fp"]
    return [{"key": "%s%d" % (pfx, i), "type": "solder",
             "node": nid, "side": side, "fp": fp.get(nid, "")}
            for i, (nid, side) in enumerate(ordered)]


def _merge_locked(locked, new_steps):
    """锁定步骤保持原位（原索引），其余按新顺序填充空位"""
    total = len(locked) + len(new_steps)
    result = [None] * total
    used = [False] * total
    for idx, st in locked:
        i = min(idx, total - 1)
        while used[i]:
            i = (i + 1) % total
        result[i] = st
        used[i] = True
    k = 0
    for i in range(total):
        if result[i] is None:
            result[i] = new_steps[k]
            k += 1
    return result


def _insert_flips(steps, pfx):
    """按当前面可达性补翻面步骤（从正面开始）"""
    out = []
    side = SIDE_FRONT
    c = [0]
    for st in steps:
        if st["type"] == "solder" and st["side"] != side:
            c[0] += 1
            out.append({"key": "%sf%d" % (pfx, c[0]), "type": "flip"})
            side = OTHER[side]
        out.append(st)
    return out


def _dedupe_keys(steps, keep=()):
    """保证排程内 key 唯一；keep 中的 key（锁定步骤）原样保留"""
    seen = set(keep)
    for st in steps:
        k = st["key"]
        if k in seen:
            i = 2
            while "%s_%d" % (k, i) in seen:
                i += 1
            k = "%s_%d" % (k, i)
            st["key"] = k
        seen.add(k)
    return steps


def _generate(ctx, locked, pairs, order_fn, pfx):
    locked_pairs = {(st["node"], st["side"]) for _, st in locked}
    rest = [p for p in pairs if p not in locked_pairs]
    ordered = order_fn(ctx, rest)
    merged = _merge_locked(locked, _mk_steps(ctx, ordered, pfx))
    steps = _insert_flips(merged, pfx)
    return _dedupe_keys(steps, keep=[st["key"] for _, st in locked])


# ---------- 仿真 ----------
def simulate(steps, ctx, positions=None, with_missed=True):
    """沿排程推进时间：铅条就位 → 逐步焊接/翻面，注热并衰减，标记风险。
    positions: 回放时步骤自带坐标快照 {nodeId:(x,y)}；None 用当前几何。"""
    nodes = ctx["nodes"]
    inc = ctx["inc"]
    placed = ctx["placed"]
    fp = ctx["fp"]
    params = ctx["params"]
    heat_of = ctx["heat_of"]
    t = ctx["tLead"]
    side = SIDE_FRONT
    pos = None
    injections = []  # (t, nid, Q, tau, R, x, y)
    events = []
    sim = {}
    issues = []
    covered = set()
    travel_dist = 0.0
    flips = 0
    seq = [0]

    def add_issue(typ, sev, msg, x, y, tt, nid=None, key=None, data=None):
        issues.append({"id": "sj%d" % seq[0], "type": typ, "severity": sev,
                       "msg": msg, "x": _r2(x), "y": _r2(y), "t": _r2(tt),
                       "nodeId": nid, "stepKey": key, "data": data or {}})
        seq[0] += 1

    for st in steps:
        key = st.get("key")
        if st.get("type") == "flip":
            side = OTHER[side]
            flips += 1
            sim[key] = {"type": "flip", "start": _r2(t),
                        "end": _r2(t + params["flipTime"]), "sideAfter": side}
            t += params["flipTime"]
            continue
        nid = st.get("node")
        sside = st.get("side")
        if positions is not None:
            p = positions.get(nid)
            if p is None:
                continue
            nx, ny = p
        else:
            n = nodes.get(nid)
            if not n:
                continue
            nx, ny = n["x"], n["y"]
        heat = heat_of(nid)
        q = heat["power"] * heat["dwell"]
        dist = 0.0 if pos is None else math.hypot(nx - pos[0], ny - pos[1])
        travel_dist += dist
        start = t + dist / params["travelSpeed"]
        end = start + heat["dwell"]
        flags = []
        # 焊接只能排在相连铅条就位之后：相连边须都在放铅次序中
        missing_edges = [e for e in inc.get(nid, []) if e not in placed]
        if missing_edges:
            flags.append("lead")
            add_issue("lead", "error",
                      "相连铅条有 %d 根未在放铅次序中就位，不能排焊" % len(missing_edges),
                      nx, ny, start, nid, key, {"edges": missing_edges})
        if sside != side:
            flags.append("side")
            add_issue("side", "error",
                      "当前在%s面，该焊点要到%s面：需先插入翻面"
                      % (SIDE_NAME[side], SIDE_NAME[sside]), nx, ny, start, nid, key)
        # 余热：同一焊点（冷却不足）与邻近焊点（局部连续加热）分开判定
        own = 0.0
        nb = 0.0
        for (ti, ni, qi, taui, ri, xi, yi) in injections:
            if ti > start:
                continue
            decay = math.exp(-(start - ti) / taui)
            if ni == nid:
                own += qi * decay
            else:
                d = math.hypot(nx - xi, ny - yi)
                if d < ri:
                    nb += qi * (1 - d / ri) * decay
        lim = params["heatLimit"] * q
        if own > lim + 1e-9:
            flags.append("cool")
            add_issue("cool", "warn",
                      "同一焊点余热 %.1f 未散尽（冷却不足）" % own, nx, ny, start, nid, key)
        if nb > lim + 1e-9:
            flags.append("hot")
            add_issue("hot", "warn",
                      "邻近焊点余热 %.1f 仍在影响（局部连续加热）" % nb, nx, ny, start, nid, key)
        # 步骤指纹：节点不存在（回放历史）或指纹不符 → 过期
        stale = bool(st.get("fp")) and (nid not in fp or st["fp"] != fp[nid])
        # 不可达/铅条未就位的步骤物理上无法焊接：不注热，但时间照计
        if "lead" not in flags and "side" not in flags:
            injections.append((end, nid, q, heat["coolTau"], heat["radius"], nx, ny))
            events.append({"t": _r2(end), "node": nid, "x": _r2(nx), "y": _r2(ny),
                           "Q": _r2(q), "tau": _r2(heat["coolTau"]),
                           "radius": _r2(heat["radius"]), "key": key})
        covered.add((nid, sside))
        sim[key] = {"type": "solder", "node": nid, "side": sside,
                    "start": _r2(start), "end": _r2(end), "travel": _r2(dist),
                    "flags": flags, "stale": stale}
        pos = (nx, ny)
        t = end

    if with_missed:
        for p in ctx["required"]:
            if (p["node"], p["side"]) not in covered:
                n = nodes.get(p["node"])
                if not n:
                    continue
                add_issue("missed", "error",
                          "漏焊：%s面焊点未排入排程" % SIDE_NAME[p["side"]],
                          n["x"], n["y"], t, p["node"], None, {"side": p["side"]})

    # 峰值热量：每次注热后各节点的瞬时热量（含邻域叠加）
    peaks = {}
    if positions is None:
        cand_nodes = [(nid, nodes[nid]["x"], nodes[nid]["y"])
                      for nid in nodes if len(inc[nid]) >= 2]
    else:
        cand_nodes = [(nid, p[0], p[1]) for nid, p in positions.items()]
    for nid, nx, ny in cand_nodes:
        best = 0.0
        for k, (ti, ni, qi, taui, ri, xi, yi) in enumerate(injections):
            d = math.hypot(nx - xi, ny - yi)
            if d >= ri:
                continue
            h = qi * (1 - d / ri)
            for (tj, nj, qj, tauj, rj, xj, yj) in injections[:k]:
                dj = math.hypot(nx - xj, ny - yj)
                if dj < rj:
                    h += qj * (1 - dj / rj) * math.exp(-(ti - tj) / tauj)
            if h > best:
                best = h
        if best > 0:
            peaks[nid] = _r2(best)
    peak_heat = max(peaks.values()) if peaks else 0.0

    metrics = {"peakHeat": _r2(peak_heat), "flips": flips,
               "travel": _r1(travel_dist), "totalTime": _r1(t),
               "solderTime": _r1(t - ctx["tLead"]), "tLead": _r1(ctx["tLead"])}
    return {"sim": sim, "events": events, "issues": issues,
            "metrics": metrics, "peaks": peaks}


# ---------- 主入口 ----------
def compute(payload):
    nodes = {}
    for n in payload.get("nodes") or []:
        if isinstance(n, dict) and n.get("id") is not None:
            nodes[n["id"]] = {"id": n["id"], "x": _num(n.get("x")), "y": _num(n.get("y"))}
    edges = []
    for e in payload.get("edges") or []:
        if isinstance(e, dict) and e.get("a") in nodes and e.get("b") in nodes \
                and e.get("id") is not None:
            edges.append({"id": e["id"], "a": e["a"], "b": e["b"]})
    edge_by_id = {e["id"]: e for e in edges}
    inc = {nid: [] for nid in nodes}
    for e in edges:
        inc[e["a"]].append(e["id"])
        inc[e["b"]].append(e["id"])

    joints = payload.get("joints") or {}
    fp = {nid: _fp_of(nodes, inc, joints, nid) for nid in nodes}

    s_in = payload.get("solder") or {}
    params = _norm_params(s_in.get("params"))
    spec_heat = {sid: _norm_heat(h)
                 for sid, h in (s_in.get("specHeat") or {}).items() if isinstance(h, dict)}
    node_spec = {k: v for k, v in (s_in.get("nodeSpec") or {}).items() if k in nodes}
    node_cfg = {}
    for nid, c in (s_in.get("nodes") or {}).items():
        if nid not in nodes or not isinstance(c, dict):
            continue
        side = c.get("side") if c.get("side") in (SIDE_FRONT, SIDE_BACK, "both") else "both"
        node_cfg[nid] = {"side": side,
                         "lockFront": bool(c.get("lockFront")),
                         "lockBack": bool(c.get("lockBack"))}

    def heat_of(nid, sh=None, ns=None):
        sh = spec_heat if sh is None else sh
        ns = node_spec if ns is None else ns
        h = sh.get(ns.get(nid))
        return h if h else dict(DEFAULT_HEAT)

    # ---- 放铅/嵌片阶段：节点就位时刻与铅条覆盖 ----
    seq = [s for s in (payload.get("sequence") or []) if isinstance(s, dict)]
    placed = set()
    ready_at = {}
    lead_rank = {}
    lead_sim = []
    t = 0.0
    for i, st in enumerate(seq):
        typ = st.get("type")
        ref = st.get("ref")
        dur = params["leadTime"] if typ == "lead" else \
            params["pieceTime"] if typ == "piece" else 0.0
        start = t
        t += dur
        if typ == "lead" and ref in edge_by_id:
            placed.add(ref)
            e = edge_by_id[ref]
            for nid in (e["a"], e["b"]):
                ready_at[nid] = t
                lead_rank[nid] = i
        lead_sim.append({"type": typ, "ref": ref, "start": _r2(start), "end": _r2(t)})
    t_lead = t

    def rank_of(nid):
        return lead_rank.get(nid, 10 ** 9)

    # ---- 需求焊点（度数≥2 的节点按焊面设置展开）与展示编号 ----
    req_nodes = [nid for nid in nodes if len(inc[nid]) >= 2]
    req_nodes.sort(key=lambda nid: (rank_of(nid), nodes[nid]["y"], nodes[nid]["x"]))
    tags = {nid: "J%d" % (i + 1) for i, nid in enumerate(req_nodes)}

    required = []
    for nid in req_nodes:
        cfg = node_cfg.get(nid) or {"side": "both"}
        if cfg["side"] in (SIDE_FRONT, "both"):
            required.append({"node": nid, "side": SIDE_FRONT})
        if cfg["side"] in (SIDE_BACK, "both"):
            required.append({"node": nid, "side": SIDE_BACK})
    req_set = {(p["node"], p["side"]) for p in required}

    locked_pairs = set()
    for nid, c in node_cfg.items():
        if c["lockFront"] and (nid, SIDE_FRONT) in req_set:
            locked_pairs.add((nid, SIDE_FRONT))
        if c["lockBack"] and (nid, SIDE_BACK) in req_set:
            locked_pairs.add((nid, SIDE_BACK))

    ctx = {"nodes": nodes, "inc": inc, "placed": placed, "fp": fp,
           "params": params, "required": required, "req_set": req_set,
           "tLead": t_lead, "heat_of": heat_of, "rank_of": rank_of}

    # ---- 调和当前排程：丢弃失效/重复步骤（不自动补漏，漏焊显式标记） ----
    key_seq = [0]

    def new_key():
        key_seq[0] += 1
        return "k%d" % key_seq[0]

    steps_in = [s for s in (s_in.get("steps") or []) if isinstance(s, dict)]
    clean = []
    covered = set()
    changed = False
    seen_keys = set()
    for st in steps_in:
        typ = st.get("type")
        key = st.get("key")
        if not key or key in seen_keys:
            changed = True
            key = new_key()
        if typ == "flip":
            seen_keys.add(key)
            clean.append({"key": key, "type": "flip"})
        elif typ == "solder":
            nid = st.get("node")
            side = st.get("side")
            pair = (nid, side)
            if nid in nodes and side in (SIDE_FRONT, SIDE_BACK) \
                    and pair in req_set and pair not in covered:
                covered.add(pair)
                seen_keys.add(key)
                clean.append({"key": key, "type": "solder", "node": nid,
                              "side": side, "fp": st.get("fp") or ""})
            else:
                changed = True
        else:
            changed = True
    if len(clean) != len(steps_in):
        changed = True
    # 首次（空排程）自动生成：按就位顺序 + 自动翻面
    if not clean and required:
        clean = _generate(ctx, [], [(p["node"], p["side"]) for p in required],
                          _order_ready, "g")
        changed = True

    sched = simulate(clean, ctx)

    # ---- 候选重排：锁定步骤保持原位，其余按策略重排后补翻面 ----
    locked_steps = [(i, st) for i, st in enumerate(clean)
                    if st["type"] == "solder"
                    and (st["node"], st["side"]) in locked_pairs]
    all_pairs = [(p["node"], p["side"]) for p in required]
    candidates = []
    for ckey, cname, fn in (("ready", "按就位顺序（翻面最少）", _order_ready),
                            ("near", "就近原则（空走最少）", _order_near),
                            ("cool", "散热优先（避开热区）", _order_cool)):
        csteps = _generate(ctx, locked_steps, all_pairs, fn, "c_" + ckey)
        csim = simulate(csteps, ctx)
        candidates.append({
            "key": ckey, "name": cname, "steps": csteps,
            "sim": csim["sim"], "events": csim["events"],
            "issues": csim["issues"], "peaks": csim["peaks"],
            "metrics": csim["metrics"], "issueCount": len(csim["issues"]),
        })

    # ---- 历史版本回放：按快照坐标与参数仿真，指纹对当前几何标过期 ----
    replay_res = None
    rp = payload.get("replay")
    if isinstance(rp, dict) and isinstance(rp.get("steps"), list):
        r_params = _norm_params(rp.get("params"), base=params)
        r_spec_heat = {sid: _norm_heat(h)
                       for sid, h in (rp.get("specHeat") or {}).items() if isinstance(h, dict)}
        r_node_spec = dict(rp.get("nodeSpec") or {})

        def r_heat_of(nid):
            h = r_spec_heat.get(r_node_spec.get(nid))
            return h if h else heat_of(nid)

        rsteps = []
        positions = {}
        rk = [0]
        for st in rp["steps"]:
            if not isinstance(st, dict):
                continue
            rk[0] += 1
            key = st.get("key") or ("r%d" % rk[0])
            if st.get("type") == "flip":
                rsteps.append({"key": key, "type": "flip"})
            elif st.get("type") == "solder" and st.get("node") is not None:
                nid = st["node"]
                sx, sy = st.get("x"), st.get("y")
                if sx is None or sy is None:
                    if nid in nodes:
                        sx, sy = nodes[nid]["x"], nodes[nid]["y"]
                    else:
                        continue
                px, py = _num(sx), _num(sy)
                positions.setdefault(nid, (px, py))
                rsteps.append({"key": key, "type": "solder", "node": nid,
                               "side": st.get("side") if st.get("side") in (SIDE_FRONT, SIDE_BACK)
                               else SIDE_FRONT,
                               "fp": st.get("fp") or ""})
        r_ctx = dict(ctx)
        r_ctx["params"] = r_params
        r_ctx["heat_of"] = r_heat_of
        rsim = simulate(rsteps, r_ctx, positions=positions)
        replay_res = {"steps": rsteps, "sim": rsim["sim"], "events": rsim["events"],
                      "issues": rsim["issues"], "metrics": rsim["metrics"],
                      "peaks": rsim["peaks"],
                      "points": [{"node": nid, "x": _r2(p[0]), "y": _r2(p[1])}
                                 for nid, p in positions.items()]}

    return {
        "tags": tags,
        "fp": fp,
        "required": required,
        "lockedPairs": sorted([list(p) for p in locked_pairs]),
        "schedule": {
            "steps": clean, "changed": changed,
            "sim": sched["sim"], "events": sched["events"],
            "issues": sched["issues"], "metrics": sched["metrics"],
            "peaks": sched["peaks"],
            "tLead": _r1(t_lead), "leadSim": lead_sim,
        },
        "candidates": candidates,
        "replay": replay_res,
    }
