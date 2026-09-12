#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_api.py — Flask API 测试：照片/版本 CRUD、级联删除、冻结版本只读"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as appmod

PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

passed = failed = 0
def ok(cond, name):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + name)
    else:
        failed += 1
        print("  ✗ " + name)

def main():
    appmod.init_db()
    c = appmod.app.test_client()

    # 建项目
    pid = c.post("/api/projects", json={"name": "API 测试", "doc": {"version": 1}}).get_json()["id"]

    # 上传照片
    r = c.post(f"/api/projects/{pid}/photos",
               json={"name": "现场.png", "mime": "image/png", "width": 1, "height": 1, "dataBase64": PNG_1PX})
    phid = r.get_json()["id"]
    ok(r.status_code == 200 and phid > 0, "照片写入 SQLite")
    r = c.get(f"/api/photos/{phid}/raw")
    ok(r.status_code == 200 and r.content_type == "image/png" and len(r.data) > 0, "照片二进制可取回")
    r = c.post(f"/api/projects/{pid}/photos", json={"name": "坏", "dataBase64": "!!!"})
    ok(r.status_code == 400, "非法 base64 拒绝")

    # 建版本并写入控制点与参数
    pts = [
        {"id": "a", "imgX": 0, "imgY": 0, "panelX": 0, "panelY": 0, "locked": True, "excluded": False},
        {"id": "b", "imgX": 100, "imgY": 0, "panelX": 50, "panelY": 0, "locked": False, "excluded": False},
        {"id": "c", "imgX": 0, "imgY": 100, "panelX": 0, "panelY": 50, "locked": False, "excluded": False},
    ]
    params = {"type": "affine", "m": [0.5, 0, 0, 0, 0.5, 0], "nPts": 3, "rmsMm": 0.0, "rmsPx": 0.0, "ptsHash": "abc"}
    vid = c.post(f"/api/projects/{pid}/calib",
                 json={"photo_id": phid, "name": "方案 1", "method": "affine"}).get_json()["id"]
    r = c.put(f"/api/calib/{vid}", json={"points": pts, "params": params})
    ok(r.status_code == 200, "草稿版本可写入控制点与参数")

    # 冻结
    r = c.put(f"/api/calib/{vid}", json={"frozen": True})
    ok(r.status_code == 200, "草稿 → 冻结成功")
    vs = c.get(f"/api/projects/{pid}/calib").get_json()
    ok(vs[0]["frozen"] is True and vs[0]["params"]["m"][0] == 0.5, "冻结后参数已保存")

    # 冻结只读：任何改写都被拒绝，历史参数不被覆盖
    r = c.put(f"/api/calib/{vid}", json={"params": {"type": "affine", "m": [9, 9, 9, 9, 9, 9]}})
    ok(r.status_code == 409, "冻结后改写矩阵被拒绝(409)")
    r = c.put(f"/api/calib/{vid}", json={"points": []})
    ok(r.status_code == 409, "冻结后改写控制点被拒绝(409)")
    r = c.put(f"/api/calib/{vid}", json={"frozen": False})
    ok(r.status_code == 409, "冻结后解冻被拒绝(409)")
    r = c.put(f"/api/calib/{vid}", json={"name": "改名"})
    ok(r.status_code == 409, "冻结后改名被拒绝(409)")
    v = c.get(f"/api/projects/{pid}/calib").get_json()[0]
    ok(v["params"]["m"][0] == 0.5 and len(v["points"]) == 3 and v["frozen"] is True,
       "历史参数与控制点保持原样")

    # 复制 = 新记录，可编辑、可独立冻结
    vid2 = c.post(f"/api/projects/{pid}/calib",
                  json={"photo_id": phid, "name": "方案 1 副本", "method": "affine",
                        "points": pts, "params": params}).get_json()["id"]
    r = c.put(f"/api/calib/{vid2}", json={"points": pts[:2]})
    ok(r.status_code == 200, "副本（草稿）可正常调整")
    vs = c.get(f"/api/projects/{pid}/calib").get_json()
    ok(len(vs) == 2 and vs[1]["frozen"] is False, "副本为草稿，原版本不受影响")

    # 级联：删照片 → 版本同删；删项目 → 照片/版本同删
    c.delete(f"/api/photos/{phid}")
    ok(len(c.get(f"/api/projects/{pid}/calib").get_json()) == 0, "删照片级联删版本")
    c.post(f"/api/projects/{pid}/photos",
           json={"name": "x", "mime": "image/png", "width": 1, "height": 1, "dataBase64": PNG_1PX})
    c.delete(f"/api/projects/{pid}")
    import sqlite3
    db = sqlite3.connect(appmod.DB)
    n = db.execute("SELECT COUNT(*) FROM calib_photos WHERE project_id=?", (pid,)).fetchone()[0]
    ok(n == 0, "删项目级联删照片")

    print(f"\n结果：{passed} 通过，{failed} 失败")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
