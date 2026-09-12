#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""彩色玻璃铅条分格校样工具 — 本机 Flask + SQLite 后端"""
import base64
import json
import os
import sqlite3
import time

from flask import Flask, g, jsonify, render_template, request

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "leadlight.db")

app = Flask(__name__)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB)
    db.execute(
        """CREATE TABLE IF NOT EXISTS projects(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            doc TEXT NOT NULL DEFAULT '',
            created_at REAL,
            updated_at REAL)"""
    )
    # 现场底稿校准：照片/扫描拓片（二进制存本机 SQLite）
    db.execute(
        """CREATE TABLE IF NOT EXISTS calib_photos(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            mime TEXT NOT NULL DEFAULT 'image/png',
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            data BLOB NOT NULL,
            created_at REAL)"""
    )
    # 校准方案版本：控制点 + 冻结的变换参数；重新校准另建版本
    db.execute(
        """CREATE TABLE IF NOT EXISTS calib_versions(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            photo_id INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            method TEXT NOT NULL DEFAULT 'affine',
            points TEXT NOT NULL DEFAULT '[]',
            params TEXT,
            frozen INTEGER NOT NULL DEFAULT 0,
            created_at REAL,
            updated_at REAL)"""
    )
    db.commit()
    db.close()


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/projects")
def list_projects():
    rows = (
        get_db()
        .execute("SELECT id,name,created_at,updated_at FROM projects ORDER BY updated_at DESC")
        .fetchall()
    )
    return jsonify([dict(r) for r in rows])


@app.post("/api/projects")
def create_project():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "未命名项目").strip()[:80] or "未命名项目"
    doc = data.get("doc")
    now = time.time()
    db = get_db()
    cur = db.execute(
        "INSERT INTO projects(name,doc,created_at,updated_at) VALUES(?,?,?,?)",
        (name, json.dumps(doc, ensure_ascii=False) if doc else "", now, now),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name})


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    r = get_db().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not r:
        return jsonify({"error": "not found"}), 404
    return jsonify(
        {
            "id": r["id"],
            "name": r["name"],
            "doc": json.loads(r["doc"]) if r["doc"] else None,
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }
    )


@app.put("/api/projects/<int:pid>")
def save_project(pid):
    data = request.get_json(force=True) or {}
    db = get_db()
    if not db.execute("SELECT id FROM projects WHERE id=?", (pid,)).fetchone():
        return jsonify({"error": "not found"}), 404
    now = time.time()
    if "name" in data:
        db.execute(
            "UPDATE projects SET name=?, updated_at=? WHERE id=?",
            ((data["name"] or "未命名项目").strip()[:80] or "未命名项目", now, pid),
        )
    if "doc" in data:
        db.execute(
            "UPDATE projects SET doc=?, updated_at=? WHERE id=?",
            (json.dumps(data["doc"], ensure_ascii=False), now, pid),
        )
    db.commit()
    return jsonify({"ok": True, "updated_at": now})


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    db = get_db()
    db.execute("DELETE FROM calib_versions WHERE project_id=?", (pid,))
    db.execute("DELETE FROM calib_photos WHERE project_id=?", (pid,))
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# ---------- 现场底稿校准 ----------
@app.get("/api/projects/<int:pid>/photos")
def list_photos(pid):
    rows = (
        get_db()
        .execute(
            "SELECT id,project_id,name,mime,width,height,created_at,length(data) AS size "
            "FROM calib_photos WHERE project_id=? ORDER BY id",
            (pid,),
        )
        .fetchall()
    )
    return jsonify([dict(r) for r in rows])


@app.post("/api/projects/<int:pid>/photos")
def upload_photo(pid):
    data = request.get_json(force=True) or {}
    try:
        raw = base64.b64decode(data.get("dataBase64") or "")
    except Exception:
        return jsonify({"error": "bad base64"}), 400
    if not raw:
        return jsonify({"error": "empty image"}), 400
    if len(raw) > 40 * 1024 * 1024:
        return jsonify({"error": "image too large"}), 413
    name = (data.get("name") or "现场照片").strip()[:80] or "现场照片"
    mime = (data.get("mime") or "image/png")[:60]
    now = time.time()
    db = get_db()
    cur = db.execute(
        "INSERT INTO calib_photos(project_id,name,mime,width,height,data,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (pid, name, mime, int(data.get("width") or 0), int(data.get("height") or 0), raw, now),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name})


@app.get("/api/photos/<int:phid>/raw")
def photo_raw(phid):
    r = get_db().execute("SELECT mime,data FROM calib_photos WHERE id=?", (phid,)).fetchone()
    if not r:
        return jsonify({"error": "not found"}), 404
    return app.response_class(r["data"], mimetype=r["mime"])


@app.delete("/api/photos/<int:phid>")
def delete_photo(phid):
    db = get_db()
    db.execute("DELETE FROM calib_versions WHERE photo_id=?", (phid,))
    db.execute("DELETE FROM calib_photos WHERE id=?", (phid,))
    db.commit()
    return jsonify({"ok": True})


def _version_row(r):
    d = dict(r)
    d["points"] = json.loads(d["points"]) if d["points"] else []
    d["params"] = json.loads(d["params"]) if d["params"] else None
    d["frozen"] = bool(d["frozen"])
    return d


@app.get("/api/projects/<int:pid>/calib")
def list_calib(pid):
    rows = (
        get_db()
        .execute("SELECT * FROM calib_versions WHERE project_id=? ORDER BY id", (pid,))
        .fetchall()
    )
    return jsonify([_version_row(r) for r in rows])


@app.post("/api/projects/<int:pid>/calib")
def create_calib(pid):
    data = request.get_json(force=True) or {}
    db = get_db()
    photo = db.execute(
        "SELECT id FROM calib_photos WHERE id=? AND project_id=?",
        (data.get("photo_id"), pid),
    ).fetchone()
    if not photo:
        return jsonify({"error": "photo not found"}), 404
    method = data.get("method") if data.get("method") in ("affine", "perspective") else "affine"
    name = (data.get("name") or "校准方案").strip()[:80] or "校准方案"
    now = time.time()
    cur = db.execute(
        "INSERT INTO calib_versions(project_id,photo_id,name,method,points,params,frozen,"
        "created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)",
        (
            pid,
            photo["id"],
            name,
            method,
            json.dumps(data["points"], ensure_ascii=False) if data.get("points") else "[]",
            json.dumps(data["params"], ensure_ascii=False) if data.get("params") else None,
            now,
            now,
        ),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name})


@app.put("/api/calib/<int:vid>")
def update_calib(vid):
    data = request.get_json(force=True) or {}
    db = get_db()
    if not db.execute("SELECT id FROM calib_versions WHERE id=?", (vid,)).fetchone():
        return jsonify({"error": "not found"}), 404
    now = time.time()
    if "name" in data:
        db.execute(
            "UPDATE calib_versions SET name=?, updated_at=? WHERE id=?",
            ((data["name"] or "校准方案").strip()[:80] or "校准方案", now, vid),
        )
    if data.get("method") in ("affine", "perspective"):
        db.execute(
            "UPDATE calib_versions SET method=?, updated_at=? WHERE id=?",
            (data["method"], now, vid),
        )
    if "points" in data:
        db.execute(
            "UPDATE calib_versions SET points=?, updated_at=? WHERE id=?",
            (json.dumps(data["points"], ensure_ascii=False), now, vid),
        )
    if "params" in data:
        db.execute(
            "UPDATE calib_versions SET params=?, updated_at=? WHERE id=?",
            (json.dumps(data["params"], ensure_ascii=False) if data["params"] else None, now, vid),
        )
    if "frozen" in data:
        db.execute(
            "UPDATE calib_versions SET frozen=?, updated_at=? WHERE id=?",
            (1 if data["frozen"] else 0, now, vid),
        )
    db.commit()
    return jsonify({"ok": True, "updated_at": now})


@app.delete("/api/calib/<int:vid>")
def delete_calib(vid):
    db = get_db()
    db.execute("DELETE FROM calib_versions WHERE id=?", (vid,))
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
