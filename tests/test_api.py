#!/usr/bin/env python3
"""Pruebas de punta a punta: arranca el servidor en una carpeta temporal y
recorre la API. Uso: python3 tests/test_api.py (solo librería estándar)."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import date, timedelta
from http.cookiejar import CookieJar

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8977
BASE = "http://127.0.0.1:%d" % PORT
OK = 0


def check(cond, msg):
    global OK
    if not cond:
        raise AssertionError(msg)
    OK += 1


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def req(self, method, path, body=None, status=200):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(BASE + path, data=data, method=method,
                                   headers={"Content-Type": "application/json"} if data else {})
        try:
            with self.op.open(r, timeout=5) as res:
                code, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            code, raw = e.code, e.read()
        out = json.loads(raw or b"{}")
        check(code == status, "%s %s -> %s (esperado %s): %s" % (method, path, code, status, out))
        return out


def start(data_dir):
    env = dict(os.environ, APP_PASSWORD="prueba", DATA_DIR=data_dir, PORT=str(PORT), QUIET="1")
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/api/health", timeout=1)
            return p
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(p.stderr.read().decode())


def iso(d):
    return d.isoformat()


def test_api(tmp):
    today = date.today()
    srv = start(tmp)
    try:
        c = Client()
        c.req("GET", "/api/state", status=401)
        c.req("POST", "/api/login", {"password": "mal"}, status=401)
        c.req("POST", "/api/login", {"password": "prueba"})
        st = c.req("GET", "/api/state")
        check(len(st["rooms"]) == 6 and not st["tasks"] and not st["completions"], "se empieza en 0: solo habitaciones")
        r = c.req("POST", "/api/templates", {"names": [x["name"] for x in st["templates"]]})
        check(r["added"] == 12, "añadir todas las sugeridas")
        st = c.req("GET", "/api/state")
        check(all(t["due"] >= iso(today) for t in st["tasks"]), "las semillas empiezan hoy o después")
        check([p["id"] for p in st["people"]] == ["carlos", "zoe"], "personas")
        byname = {t["name"]: t for t in st["tasks"]}
        check(byname["Limpiar el baño"]["effort"] == 3 and byname["Sacar la basura"]["effort"] == 1, "esfuerzo semillas")

        # Habitaciones: sin duplicados (mayúsculas, tildes, plurales) y renombrar lo actualiza todo
        r = c.req("POST", "/api/rooms", {"name": "baños"})
        check(r["existed"] and r["name"] == "Baño", "habitación duplicada se reutiliza")
        terr = c.req("POST", "/api/rooms", {"name": "Terraza"})
        check(not terr["existed"], "habitación nueva")
        c.req("PATCH", "/api/rooms/%d" % terr["id"], {"name": "cocinas"}, status=409)

        # Crear tarea completa a la primera
        t = c.req("POST", "/api/tasks", {"name": "Barrer la terraza", "room_id": terr["id"], "freq": "weekly",
                                         "every": 2, "weekdays": [5], "rotate": True, "assignee": "zoe",
                                         "effort": 3, "notes": "Con la escoba grande"})
        c.req("POST", "/api/tasks", {"name": "barrer las terrazas", "room_id": terr["id"], "freq": "once"}, status=409)
        c.req("POST", "/api/tasks", {"name": "Barrer la terraza", "freq": "once"})  # otra habitación: vale
        c.req("POST", "/api/tasks", {"name": "", "freq": "once"}, status=400)
        c.req("POST", "/api/tasks", {"name": "x", "freq": "anual"}, status=400)
        st = c.req("GET", "/api/state")
        bt = [x for x in st["tasks"] if x["id"] == t["id"]][0]
        check(bt["due"] and date.fromisoformat(bt["due"]).weekday() == 5, "semanal empieza en sábado")
        check(bt["assignee"] == "zoe" and bt["rotate"] == 1 and bt["effort"] == 3, "turnos y esfuerzo guardados")

        # Hacerla: turno pasa al otro, siguiente cada 2 semanas, puntos guardados
        due = bt["due"]
        r = c.req("POST", "/api/tasks/%d/done" % t["id"], {"uid": "u1", "who": "zoe", "date": due, "seen_due": due})
        check(r["next_due"] == iso(date.fromisoformat(due) + timedelta(days=14)), "cada 2 semanas: %s" % r)
        r = c.req("POST", "/api/tasks/%d/done" % t["id"], {"uid": "u1", "who": "zoe", "date": due, "seen_due": due})
        check(r.get("duplicate"), "reenvío idempotente")
        r = c.req("POST", "/api/tasks/%d/done" % t["id"], {"uid": "u2", "who": "carlos", "seen_due": due})
        check(r.get("ignored"), "si los dos la marcan, cuenta una vez")
        st = c.req("GET", "/api/state")
        bt = [x for x in st["tasks"] if x["id"] == t["id"]][0]
        check(bt["assignee"] == "carlos", "turno rotado")
        comp = [x for x in st["completions"] if x["uid"] == "u1"][0]
        check(comp["points"] == 3 and comp["room_name"] == "Terraza", "puntos y habitación en el historial")

        # Renombrar habitación y tarea actualiza el historial
        c.req("PATCH", "/api/rooms/%d" % terr["id"], {"name": "Balcón"})
        body = dict(bt, name="Barrer el balcón", weekdays=bt["weekdays"])
        c.req("PUT", "/api/tasks/%d" % t["id"], body)
        st = c.req("GET", "/api/state")
        comp = [x for x in st["completions"] if x["uid"] == "u1"][0]
        check(comp["room_name"] == "Balcón" and comp["task_name"] == "Barrer el balcón", "historial renombrado")

        # Deshacer: vuelve la fecha y el turno
        c.req("DELETE", "/api/completions/u1")
        st = c.req("GET", "/api/state")
        bt = [x for x in st["tasks"] if x["id"] == t["id"]][0]
        check(bt["due"] == due and bt["assignee"] == "zoe", "deshacer restaura fecha y turno")

        # Cada X días: cuenta desde el día en que se hizo
        basura = byname["Sacar la basura"]
        ayer = iso(today - timedelta(days=1))
        r = c.req("POST", "/api/tasks/%d/done" % basura["id"], {"uid": "b1", "who": "both", "date": ayer})
        check(r["next_due"] == iso(today + timedelta(days=1)), "cada 2 días desde ayer = mañana")

        # Semanal hecha antes de tiempo no vuelve al día siguiente
        bano = byname["Limpiar el baño"]
        r = c.req("POST", "/api/tasks/%d/done" % bano["id"], {"uid": "w1", "who": "carlos",
                                                                "date": iso(date.fromisoformat(bano["due"]) - timedelta(days=2))})
        check(r["next_due"] == iso(date.fromisoformat(bano["due"]) + timedelta(days=7)), "semanal adelantada")

        # Mensual (último día)
        m = c.req("POST", "/api/tasks", {"name": "Pagar comunidad", "freq": "monthly", "month_day": 31, "due": "2027-01-31"})
        r = c.req("POST", "/api/tasks/%d/done" % m["id"], {"uid": "m1", "who": "zoe", "date": "2027-01-30"})
        check(r["next_due"] == "2027-02-28", "mensual último día: %s" % r)

        # Tarea suelta: al hacerla pasa al historial; deshacer la reabre
        q = c.req("POST", "/api/tasks", {"name": "Llamar al fontanero", "freq": "once"})
        c.req("POST", "/api/tasks/%d/done" % q["id"], {"uid": "q1", "who": "carlos", "seen_due": None})
        st = c.req("GET", "/api/state")
        check([x for x in st["tasks"] if x["id"] == q["id"]][0]["active"] == 0, "suelta hecha queda inactiva")
        c.req("POST", "/api/tasks", {"name": "Llamar al fontanero", "freq": "once"})  # ya no está activa: se puede repetir
        c.req("DELETE", "/api/completions/q1")
        st = c.req("GET", "/api/state")
        check([x for x in st["tasks"] if x["id"] == q["id"]][0]["active"] == 1, "deshacer reabre la suelta")

        # Posponer y saltar
        c.req("POST", "/api/tasks/%d/snooze" % q["id"], {"due": iso(today + timedelta(days=3))})
        c.req("POST", "/api/tasks/%d/snooze" % q["id"], {"due": None})
        c.req("POST", "/api/tasks/%d/snooze" % basura["id"], {"due": None}, status=400)
        c.req("POST", "/api/tasks/%d/skip" % q["id"], {}, status=400)
        platos = byname["Fregar los platos"]
        c.req("POST", "/api/tasks/%d/skip" % platos["id"], {"seen_due": platos["due"]})
        st = c.req("GET", "/api/state")
        check([x for x in st["tasks"] if x["id"] == platos["id"]][0]["due"] == iso(date.fromisoformat(platos["due"]) + timedelta(days=1)), "saltar")

        # Cambiar quién la hizo, historial por persona, sugerencias, export
        c.req("PATCH", "/api/completions/w1", {"who": "zoe"})
        h = c.req("GET", "/api/history?who=zoe")
        check({x["uid"] for x in h["items"]} >= {"w1", "b1", "m1"}, "historial de Zoe incluye «los dos»")
        c.req("DELETE", "/api/tasks/%d" % bano["id"])
        r = c.req("POST", "/api/templates", {"names": ["Limpiar el baño", "Aspirar"]})
        check(r["added"] == 1, "sugerencias sin duplicar")
        c.req("DELETE", "/api/rooms/%d" % terr["id"])
        st = c.req("GET", "/api/state")
        check([x for x in st["tasks"] if x["id"] == t["id"]][0]["room_id"] is None, "tareas sin habitación al borrarla")
        ex = c.req("GET", "/api/export")
        check(len(ex["completions"]) >= 3, "export")
        c.req("GET", "/api/nada", status=404)
        # Un POST rechazado (sin sesión) no debe estropear la siguiente petición de la conexión
        import http.client
        hc = http.client.HTTPConnection("127.0.0.1", PORT, timeout=3)
        hc.request("POST", "/api/tasks/1/done", body=b'{"who":"zoe"}', headers={"Content-Type": "application/json"})
        r1 = hc.getresponse(); r1.read()
        hc.request("GET", "/api/health")
        r2 = hc.getresponse(); r2.read()
        check(r1.status == 401 and r2.status == 200, "conexión reutilizada tras un 401: %s %s" % (r1.status, r2.status))
        # Estáticos
        for pth in ("/", "/app.js", "/sw.js", "/styles.css", "/manifest.webmanifest", "/icons/apple-touch-icon.png"):
            urllib.request.urlopen(BASE + pth, timeout=3)
        c.req("GET", "/../server.py", status=404)
    finally:
        srv.terminate()
        srv.wait()


V1_SCHEMA = """
CREATE TABLE rooms(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tasks(id INTEGER PRIMARY KEY, name TEXT NOT NULL, room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  assignee TEXT NOT NULL DEFAULT 'any', rotate INTEGER NOT NULL DEFAULT 0, freq TEXT NOT NULL DEFAULT 'once',
  every INTEGER NOT NULL DEFAULT 1, weekdays TEXT NOT NULL DEFAULT '', month_day INTEGER, due TEXT,
  notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER);
CREATE TABLE completions(id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  task_name TEXT NOT NULL, room_name TEXT NOT NULL DEFAULT '', who TEXT NOT NULL, done_date TEXT NOT NULL,
  done_at INTEGER NOT NULL, prev_due TEXT, prev_assignee TEXT, next_due TEXT, created_at INTEGER);
INSERT INTO rooms(id, name) VALUES (1, 'Cocina');
INSERT INTO tasks(id, name, room_id, freq, every, due) VALUES (1, 'Fregar', 1, 'days', 1, '2026-01-01');
INSERT INTO completions(uid, task_id, task_name, room_name, who, done_date, done_at)
  VALUES ('old', 1, 'Fregar', 'Cocina', 'zoe', '2025-12-31', 0);
PRAGMA user_version=1;
"""


def test_migration(tmp):
    """Base de datos de la versión 1 (sin esfuerzo): se actualiza sin perder nada."""
    db = sqlite3.connect(os.path.join(tmp, "tareas.db"))
    db.executescript(V1_SCHEMA)
    db.commit()
    db.close()
    srv = start(tmp)
    try:
        c = Client()
        c.req("POST", "/api/login", {"password": "prueba"})
        st = c.req("GET", "/api/state")
        check([t["name"] for t in st["tasks"]] == ["Fregar"] and st["tasks"][0]["effort"] == 2, "migración: tareas")
        check(len(st["rooms"]) == 1, "migración: no vuelve a sembrar")
        h = c.req("GET", "/api/history")
        check(h["items"][0]["uid"] == "old" and h["items"][0]["points"] == 2, "migración: historial")
    finally:
        srv.terminate()
        srv.wait()
    v = sqlite3.connect(os.path.join(tmp, "tareas.db")).execute("PRAGMA user_version").fetchone()[0]
    check(v == 2, "migración: versión 2")


if __name__ == "__main__":
    for fn in (test_api, test_migration):
        d = tempfile.mkdtemp()
        try:
            fn(d)
            print("ok", fn.__name__)
        finally:
            shutil.rmtree(d, ignore_errors=True)
    print("%d comprobaciones correctas" % OK)
