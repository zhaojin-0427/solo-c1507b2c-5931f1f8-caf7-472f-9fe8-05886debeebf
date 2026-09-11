#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""彩色玻璃铅条分格校样工具 — 本机 Flask + SQLite 后端"""
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
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
