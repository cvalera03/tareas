#!/usr/bin/env python3
"""
Tareas — servidor de la app de tareas del hogar para Carlos y Zoe.

Solo usa la librería estándar de Python (3.9+): http.server + sqlite3.
Sirve la PWA de /public, expone una API JSON en /api y empuja cambios en
tiempo real a todos los dispositivos conectados mediante Server-Sent Events.

Variables de entorno:
  APP_PASSWORD   contraseña compartida (si falta se genera y guarda en data/config.json)
  PORT           puerto (8080)
  HOST           interfaz (0.0.0.0)
  DATA_DIR       carpeta de datos (./data)
  COOKIE_SECURE  "1" para marcar la cookie como Secure (detrás de HTTPS)
"""
import calendar
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
from datetime import date, timedelta
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE, "data"))
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
COOKIE_NAME = "tareas_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 400  # ~13 meses: la PWA del iPhone no pide login a menudo

os.makedirs(DATA_DIR, exist_ok=True)

PEOPLE = [("carlos", "Carlos"), ("zoe", "Zoe")]
PERSON_IDS = {p for p, _ in PEOPLE}
WHO_VALUES = PERSON_IDS | {"both"}       # quién la hizo
ASSIGNEES = PERSON_IDS | {"any"}         # a quién le toca
FREQS = {"once", "days", "weekly", "monthly"}
RECENT_DAYS = 70  # historial que viaja con el estado (semana, mes y algo más)


# ---------------------------------------------------------------- config ----

def load_config():
    path = os.path.join(DATA_DIR, "config.json")
    cfg = {}
    if os.path.exists(path):
        with open(path) as f:
            cfg = json.load(f)
    changed = False
    if "secret" not in cfg:
        cfg["secret"] = secrets.token_hex(32)
        changed = True
    if not os.environ.get("APP_PASSWORD") and "password" not in cfg:
        cfg["password"] = secrets.token_urlsafe(9)
        changed = True
    if changed:
        with open(path, "w") as f:
            json.dump(cfg, f, indent=2)
        os.chmod(path, 0o600)
    return cfg


CONFIG = load_config()
PASSWORD = os.environ.get("APP_PASSWORD") or CONFIG["password"]
SECRET = CONFIG["secret"].encode()


def make_token():
    # El token depende de la contraseña: si la cambias, se cierran todas las sesiones.
    return hmac.new(SECRET, ("session:" + PASSWORD).encode(), hashlib.sha256).hexdigest()


TOKEN = make_token()


# -------------------------------------------------------------- database ----

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  assignee TEXT NOT NULL DEFAULT 'any',   -- carlos | zoe | any (con turnos: a quién le toca)
  rotate INTEGER NOT NULL DEFAULT 0,      -- 1 = se turnan: al hacerla le toca al otro
  freq TEXT NOT NULL DEFAULT 'once',      -- once | days | weekly | monthly
  every INTEGER NOT NULL DEFAULT 1,       -- cada N días / semanas / meses
  weekdays TEXT NOT NULL DEFAULT '',      -- semanal: "2,5" (0 = lunes)
  month_day INTEGER,                      -- mensual: día del mes (31 = último día)
  due TEXT,                               -- próxima vez, YYYY-MM-DD (NULL = sin fecha)
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,      -- 0 = tarea suelta ya hecha (queda en el historial)
  effort INTEGER NOT NULL DEFAULT 2,      -- 1 ligera, 2 normal, 3 pesada (puntos para el reparto)
  created_at INTEGER,
  updated_at INTEGER
);
-- Cada vez que alguien hace una tarea. Es el historial y guarda lo necesario para deshacer.
CREATE TABLE IF NOT EXISTS completions(
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,               -- lo genera el móvil: evita duplicados al reenviar sin conexión
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  task_name TEXT NOT NULL,                -- copia: el historial sobrevive si se borra la tarea
  room_name TEXT NOT NULL DEFAULT '',
  who TEXT NOT NULL,                      -- carlos | zoe | both
  done_date TEXT NOT NULL,                -- día en que se hizo (YYYY-MM-DD)
  done_at INTEGER NOT NULL,
  prev_due TEXT,
  prev_assignee TEXT,
  next_due TEXT,
  points INTEGER NOT NULL DEFAULT 2,      -- esfuerzo de la tarea cuando se hizo
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comp_date ON completions(done_date);
CREATE INDEX IF NOT EXISTS idx_comp_task ON completions(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);
"""
SCHEMA_VERSION = 2

SEED_ROOMS = ["Cocina", "Baño", "Dormitorio", "Salón", "Toda la casa", "Recados"]
# nombre, habitación, frecuencia, cada, días de la semana (0 = lunes), día del mes, turnos, esfuerzo
TEMPLATES = [
    ("Fregar los platos", "Cocina", "days", 1, "", None, 0, 2),
    ("Sacar la basura", "Cocina", "days", 2, "", None, 1, 1),
    ("Limpiar encimera y vitro", "Cocina", "weekly", 1, "4", None, 0, 2),
    ("Limpiar el frigorífico", "Cocina", "monthly", 1, "", 1, 1, 3),
    ("Limpiar el baño", "Baño", "weekly", 1, "5", None, 1, 3),
    ("Cambiar las toallas", "Baño", "weekly", 1, "6", None, 0, 1),
    ("Cambiar las sábanas", "Dormitorio", "weekly", 2, "6", None, 1, 2),
    ("Quitar el polvo", "Salón", "weekly", 1, "5", None, 1, 2),
    ("Aspirar", "Toda la casa", "weekly", 1, "5", None, 1, 2),
    ("Fregar el suelo", "Toda la casa", "weekly", 1, "6", None, 1, 3),
    ("Poner la lavadora", "Toda la casa", "weekly", 1, "2,5", None, 0, 1),
    ("Regar las plantas", "Toda la casa", "days", 3, "", None, 0, 1),
]

DB_LOCK = threading.RLock()
DB = sqlite3.connect(os.path.join(DATA_DIR, "tareas.db"), check_same_thread=False)
DB.row_factory = sqlite3.Row
DB.execute("PRAGMA foreign_keys=ON")
DB.execute("PRAGMA journal_mode=WAL")


def init_db():
    with DB_LOCK:
        fresh = DB.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tasks'"
        ).fetchone()[0] == 0
        DB.executescript(SCHEMA)
        migrate()
        if fresh:
            # Se empieza en 0: solo las habitaciones. Las tareas sugeridas se añaden desde la app.
            for i, name in enumerate(SEED_ROOMS):
                DB.execute("INSERT INTO rooms(name, position) VALUES (?, ?)", (name, i))
        DB.commit()


def migrate():
    """Actualiza bases de datos creadas con versiones anteriores sin perder datos.
    Cada versión nueva del esquema añade aquí su paso («if v < N: ...»)."""
    v = DB.execute("PRAGMA user_version").fetchone()[0]
    if v < 2:  # v2: esfuerzo por tarea y puntos en el historial
        if "effort" not in columns("tasks"):
            DB.execute("ALTER TABLE tasks ADD COLUMN effort INTEGER NOT NULL DEFAULT 2")
        if "points" not in columns("completions"):
            DB.execute("ALTER TABLE completions ADD COLUMN points INTEGER NOT NULL DEFAULT 2")
    if v < SCHEMA_VERSION:
        DB.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)


def columns(table):
    return {r[1] for r in DB.execute("PRAGMA table_info(%s)" % table)}


def rows(sql, args=()):
    return [dict(r) for r in DB.execute(sql, args).fetchall()]


def row(sql, args=()):
    r = DB.execute(sql, args).fetchone()
    return dict(r) if r else None


# ------------------------------------------------------------- real time ----

VERSION = int(time.time() * 1000)
SUBSCRIBERS = set()
SUB_LOCK = threading.Lock()


def bump():
    """Marca un cambio y avisa a todos los dispositivos conectados."""
    global VERSION
    VERSION += 1
    msg = json.dumps({"version": VERSION})
    with SUB_LOCK:
        for q in list(SUBSCRIBERS):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


# ------------------------------------------------------------ calendario ----
# La misma lógica está en public/app.js (para trabajar sin conexión): si cambias
# una, cambia la otra.

def parse_date(v):
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise ApiError(400, "Fecha no válida")


def weekday_list(t, anchor):
    days = [int(x) for x in (t["weekdays"] or "").split(",") if x.strip().isdigit()]
    return days or [anchor.weekday()]


def occurrence_after(t, after, anchor):
    """Primera fecha del calendario de la tarea posterior a `after`.
    `anchor` fija las semanas/meses que tocan cuando se repite cada N."""
    n = max(1, t["every"] or 1)
    if t["freq"] == "weekly":
        days = weekday_list(t, anchor)
        monday = anchor - timedelta(days=anchor.weekday())
        for i in range(1, 7 * n + 8):
            d = after + timedelta(days=i)
            if ((d - monday).days // 7) % n == 0 and d.weekday() in days:
                return d
    elif t["freq"] == "monthly":
        md = t["month_day"] or anchor.day
        for k in range(0, 1200, n):
            y, m = divmod(anchor.month - 1 + k, 12)
            y += anchor.year
            d = date(y, m + 1, min(md, calendar.monthrange(y, m + 1)[1]))
            if d > after:
                return d
    elif t["freq"] == "days":
        return after + timedelta(days=n)
    return after + timedelta(days=1)


def next_due(t, done):
    """Cuándo vuelve a tocar si se hace el día `done`.
    - Cada X días: cuenta desde el día en que se hizo.
    - Semanal / mensual: siguiente día del calendario. Si se hace antes de
      tiempo, no vuelve a salir al día siguiente sino en la siguiente vez."""
    if t["freq"] == "once":
        return None
    if t["freq"] == "days":
        return done + timedelta(days=max(1, t["every"] or 1))
    due = parse_date(t["due"]) or done
    return occurrence_after(t, max(done, due), due)


def first_due(t, start):
    """Primera vez a partir de `start` (incluido)."""
    if t["freq"] == "once":
        return None
    if t["freq"] == "days":
        return start
    return occurrence_after(t, start - timedelta(days=1), start)


# ------------------------------------------------------------ domain ops ----

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def clean_str(v, maxlen=2000):
    if v is None:
        return ""
    return str(v).strip()[:maxlen]


def bool_int(v):
    return 1 if v in (True, 1, "1", "true", "on") else 0


def int_in(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _words(name):
    s = unicodedata.normalize("NFD", str(name).lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    words = re.findall(r"[a-z0-9]+", s)
    # Sin artículos: "Limpiar baño" == "Limpiar el baño".
    return [w for w in words if w not in STOPWORDS] or words


STOPWORDS = {"el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a"}


def _forms(w):
    """Formas posibles de una palabra en singular: toallas -> toalla, habitaciones -> habitacion."""
    forms = {w}
    if len(w) > 3 and w.endswith("s"):
        forms.add(w[:-1])
        if len(w) > 4 and w.endswith("es"):
            forms.add(w[:-2])
    return forms


def same_name(a, b):
    """¿Es el mismo nombre sin contar mayúsculas, tildes ni plurales?
    ("Baños" == "baño", "Cambiar las sábanas" == "cambiar la sabana")."""
    wa, wb = _words(a), _words(b)
    return len(wa) == len(wb) and all(_forms(x) & _forms(y) for x, y in zip(wa, wb))


def today():
    return date.today()


def other(person):
    return PEOPLE[1][0] if person == PEOPLE[0][0] else PEOPLE[0][0]


# -- habitaciones

def find_room(name):
    for r in rows("SELECT * FROM rooms ORDER BY position, id"):
        if same_name(r["name"], name):
            return r
    return None


def room_name(room_id):
    r = room_id and row("SELECT name FROM rooms WHERE id=?", (room_id,))
    return r["name"] if r else ""


def get_or_create_room(name):
    name = clean_str(name, 60)
    if not name:
        raise ApiError(400, "Falta el nombre")
    r = find_room(name)
    if r:
        return r["id"], r["name"], True
    pos = row("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rooms")["p"]
    rid = DB.execute("INSERT INTO rooms(name, position) VALUES (?, ?)", (name, pos)).lastrowid
    return rid, name, False


def create_room(body):
    # Si ya existe (aunque sea con otra forma de escribirlo) se reutiliza.
    rid, name, existed = get_or_create_room(body.get("name"))
    return {"id": rid, "name": name, "existed": existed}


def rename_room(rid, body):
    name = clean_str(body.get("name"), 60)
    r = row("SELECT * FROM rooms WHERE id=?", (rid,))
    if not r:
        raise ApiError(404, "Habitación no encontrada")
    if not name:
        raise ApiError(400, "Falta el nombre")
    o = find_room(name)
    if o and o["id"] != rid:
        raise ApiError(409, "Ya existe: «%s»" % o["name"])
    DB.execute("UPDATE rooms SET name=? WHERE id=?", (name, rid))
    DB.execute("UPDATE completions SET room_name=? WHERE room_name=?", (name, r["name"]))
    return {"ok": True}


def delete_room(rid):
    DB.execute("DELETE FROM rooms WHERE id=?", (rid,))  # sus tareas quedan sin habitación
    return {"ok": True}


# -- tareas

def find_task(name, room_id, exclude=None):
    for t in rows("SELECT id, name FROM tasks WHERE active=1 AND room_id IS ?", (room_id,)):
        if t["id"] != exclude and same_name(t["name"], name):
            return t
    return None


def task_fields(body):
    name = clean_str(body.get("name"), 120)
    if not name:
        raise ApiError(400, "Ponle un nombre a la tarea")
    room_id = body.get("room_id")
    if room_id in (None, "", 0, "0"):
        room_id = None
    else:
        room_id = int_in(room_id, 1, 2 ** 62, None)
        if not room_id or not row("SELECT id FROM rooms WHERE id=?", (room_id,)):
            raise ApiError(400, "Esa habitación ya no existe")
    rotate = bool_int(body.get("rotate"))
    assignee = body.get("assignee") or "any"
    if assignee not in ASSIGNEES:
        raise ApiError(400, "Responsable no válido")
    if rotate and assignee == "any":
        assignee = PEOPLE[0][0]
    freq = body.get("freq") or "once"
    if freq not in FREQS:
        raise ApiError(400, "Frecuencia no válida")
    wd = body.get("weekdays")
    wd = wd if isinstance(wd, list) else re.findall(r"\d", str(wd or ""))
    weekdays = sorted({int(x) for x in wd if str(x).isdigit() and int(x) < 7})
    due = parse_date(body.get("due"))
    t = {
        "name": name, "room_id": room_id, "assignee": assignee, "rotate": rotate, "freq": freq,
        "every": int_in(body.get("every"), 1, 365, 1),
        "weekdays": "", "month_day": None, "due": None,
        "notes": clean_str(body.get("notes"), 2000),
        "effort": int_in(body.get("effort"), 1, 3, 2),
    }
    if freq == "weekly":
        t["weekdays"] = ",".join(map(str, weekdays or [(due or today()).weekday()]))
    if freq == "monthly":
        t["month_day"] = int_in(body.get("month_day"), 1, 31, None) or (due or today()).day
    if freq != "once" and due is None:
        due = first_due(t, today())
    t["due"] = due.isoformat() if due else None
    return t


def create_task(body):
    t = task_fields(body)
    o = find_task(t["name"], t["room_id"])
    if o:
        raise ApiError(409, "Ya existe «%s»%s" % (
            o["name"], " en " + room_name(t["room_id"]) if t["room_id"] else ""))
    now = int(time.time())
    t["created_at"] = t["updated_at"] = now
    cur = DB.execute("INSERT INTO tasks(%s) VALUES (%s)" % (",".join(t), ",".join("?" * len(t))),
                     list(t.values()))
    return {"id": cur.lastrowid}


def update_task(tid, body):
    if not row("SELECT id FROM tasks WHERE id=?", (tid,)):
        raise ApiError(404, "Esta tarea ya no existe")
    t = task_fields(body)
    o = find_task(t["name"], t["room_id"], exclude=tid)
    if o:
        raise ApiError(409, "Ya existe «%s»%s" % (
            o["name"], " en " + room_name(t["room_id"]) if t["room_id"] else ""))
    t["updated_at"] = int(time.time())
    DB.execute("UPDATE tasks SET %s WHERE id=?" % ",".join(k + "=?" for k in t), list(t.values()) + [tid])
    # Al renombrar, el historial también se actualiza.
    DB.execute("UPDATE completions SET task_name=?, room_name=? WHERE task_id=?",
               (t["name"], room_name(t["room_id"]), tid))
    return {"id": tid}


def get_task(tid):
    t = row("SELECT * FROM tasks WHERE id=?", (tid,))
    if not t:
        raise ApiError(404, "Esta tarea ya no existe")
    return t


def rotated(t, who):
    if not t["rotate"]:
        return t["assignee"]
    if who in PERSON_IDS:
        return other(who)
    return other(t["assignee"]) if t["assignee"] in PERSON_IDS else PEOPLE[0][0]


def done_task(tid, body):
    t = get_task(tid)
    uid = clean_str(body.get("uid"), 64) or secrets.token_hex(8)
    if row("SELECT id FROM completions WHERE uid=?", (uid,)):
        return {"ok": True, "duplicate": True}  # reenvío de un cambio ya guardado
    who = body.get("who")
    if who not in WHO_VALUES:
        raise ApiError(400, "¿Quién la ha hecho?")
    done = parse_date(body.get("date")) or today()
    # Si los dos la marcan a la vez (o sin conexión), solo cuenta una vez.
    seen = body.get("seen_due", t["due"]) or None
    if not t["active"] or (seen != t["due"] and row(
            "SELECT id FROM completions WHERE task_id=? AND prev_due IS ?", (tid, seen))):
        return {"ok": True, "ignored": True, "message": "«%s» ya estaba hecha" % t["name"]}
    now = int(time.time())
    at = int_in(body.get("at"), now - 400 * 86400, now + 60, now)
    nd = next_due(t, done)
    if t["freq"] == "once":
        DB.execute("UPDATE tasks SET active=0, updated_at=? WHERE id=?", (now, tid))
    else:
        DB.execute("UPDATE tasks SET due=?, assignee=?, updated_at=? WHERE id=?",
                   (nd.isoformat(), rotated(t, who), now, tid))
    DB.execute(
        "INSERT INTO completions(uid, task_id, task_name, room_name, who, done_date, done_at, "
        "prev_due, prev_assignee, next_due, points, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (uid, tid, t["name"], room_name(t["room_id"]), who, done.isoformat(), at,
         t["due"], t["assignee"], nd.isoformat() if nd else None, t["effort"], now))
    return {"ok": True, "next_due": nd.isoformat() if nd else None}


def undo_completion(uid):
    """Borra una vez hecha. Si es la última de su tarea, la tarea vuelve a como estaba."""
    c = row("SELECT * FROM completions WHERE uid=?", (uid,))
    if not c:
        return {"ok": True}
    t = c["task_id"] and row("SELECT * FROM tasks WHERE id=?", (c["task_id"],))
    if t and row("SELECT MAX(id) AS m FROM completions WHERE task_id=?", (t["id"],))["m"] == c["id"]:
        if not t["active"]:
            DB.execute("UPDATE tasks SET active=1 WHERE id=?", (t["id"],))
        elif c["next_due"] and t["due"] == c["next_due"]:
            DB.execute("UPDATE tasks SET due=?, assignee=? WHERE id=?",
                       (c["prev_due"], c["prev_assignee"] or t["assignee"], t["id"]))
    DB.execute("DELETE FROM completions WHERE id=?", (c["id"],))
    return {"ok": True}


def patch_completion(uid, body):
    who = body.get("who")
    if who not in WHO_VALUES:
        raise ApiError(400, "¿Quién la ha hecho?")
    DB.execute("UPDATE completions SET who=? WHERE uid=?", (who, uid))
    return {"ok": True}


def skip_task(tid, body):
    """Saltar esta vez: pasa a la siguiente sin contar como hecha."""
    t = get_task(tid)
    if t["freq"] == "once":
        raise ApiError(400, "Las tareas sueltas no se saltan: pospónla o bórrala")
    if "seen_due" in body and (body["seen_due"] or None) != t["due"]:
        return {"ok": True, "ignored": True}
    base = max(today(), parse_date(t["due"]) or today())
    DB.execute("UPDATE tasks SET due=?, updated_at=? WHERE id=?",
               (next_due(t, base).isoformat(), int(time.time()), tid))
    return {"ok": True}


def snooze_task(tid, body):
    """Cambiar la fecha (posponer). Las sueltas pueden quedarse sin fecha."""
    t = get_task(tid)
    due = parse_date(body.get("due"))
    if due is None and t["freq"] != "once":
        raise ApiError(400, "Las tareas que se repiten necesitan fecha")
    DB.execute("UPDATE tasks SET due=?, updated_at=? WHERE id=?",
               (due.isoformat() if due else None, int(time.time()), tid))
    return {"ok": True}


def add_templates(names):
    """Crea las tareas sugeridas que se pidan (sin duplicar las que ya existan)."""
    added = 0
    turn = PEOPLE[0][0]
    for name, room, freq, every, weekdays, month_day, rotate, effort in TEMPLATES:
        if not any(same_name(name, n) for n in names):
            continue
        rid = get_or_create_room(room)[0]
        if find_task(name, rid):
            continue
        body = {"name": name, "room_id": rid, "freq": freq, "every": every, "weekdays": weekdays,
                "month_day": month_day, "rotate": rotate, "assignee": turn if rotate else "any",
                "effort": effort}
        if rotate:
            turn = other(turn)  # las de turnos empiezan repartidas
        create_task(body)
        added += 1
    return {"added": added}


def template_list():
    return [{"name": n, "room": r, "freq": f, "every": e, "weekdays": w, "month_day": md, "rotate": rot,
             "effort": ef} for n, r, f, e, w, md, rot, ef in TEMPLATES]


def full_state():
    since = (today() - timedelta(days=RECENT_DAYS)).isoformat()
    return {
        "version": VERSION,
        "today": today().isoformat(),
        "people": [{"id": p, "name": n} for p, n in PEOPLE],
        "rooms": rows("SELECT * FROM rooms ORDER BY position, name COLLATE NOCASE"),
        # Activas + sueltas ya hechas hace poco (para poder deshacerlas).
        "tasks": rows("SELECT * FROM tasks WHERE active=1 OR id IN "
                      "(SELECT task_id FROM completions WHERE done_date >= ?) "
                      "ORDER BY name COLLATE NOCASE", (since,)),
        "completions": rows("SELECT * FROM completions WHERE done_date >= ? ORDER BY id DESC", (since,)),
        "templates": template_list(),
    }


def history(q):
    """Historial completo, por páginas y opcionalmente de una persona."""
    offset = int_in((q.get("offset") or ["0"])[0], 0, 10 ** 9, 0)
    limit = 80
    who = (q.get("who") or [""])[0]
    where, args = "", []
    if who in PERSON_IDS:
        where, args = "WHERE who IN (?, 'both')", [who]
    items = rows("SELECT * FROM completions %s ORDER BY done_date DESC, done_at DESC, id DESC "
                 "LIMIT ? OFFSET ?" % where, args + [limit + 1, offset])
    return {"items": items[:limit], "more": len(items) > limit}


def export():
    d = full_state()
    d["tasks"] = rows("SELECT * FROM tasks ORDER BY id")
    d["completions"] = rows("SELECT * FROM completions ORDER BY id")
    return d


# ----------------------------------------------------------------- routes ----
# (método, patrón, función(match, body, query) -> dict, muta_datos)

def _id(m, i=1):
    return int(m.group(i))


UID = r"([A-Za-z0-9_-]{1,64})"

ROUTES = [
    ("GET", r"/api/state", lambda m, b, q: full_state(), False),
    ("GET", r"/api/export", lambda m, b, q: export(), False),
    ("GET", r"/api/history", lambda m, b, q: history(q), False),

    ("POST", r"/api/rooms", lambda m, b, q: create_room(b), True),
    ("PATCH", r"/api/rooms/(\d+)", lambda m, b, q: rename_room(_id(m), b), True),
    ("DELETE", r"/api/rooms/(\d+)", lambda m, b, q: delete_room(_id(m)), True),

    ("POST", r"/api/tasks", lambda m, b, q: create_task(b), True),
    ("PUT", r"/api/tasks/(\d+)", lambda m, b, q: update_task(_id(m), b), True),
    ("DELETE", r"/api/tasks/(\d+)",
     lambda m, b, q: DB.execute("DELETE FROM tasks WHERE id=?", (_id(m),)) and {"ok": True}, True),
    ("POST", r"/api/tasks/(\d+)/done", lambda m, b, q: done_task(_id(m), b), True),
    ("POST", r"/api/tasks/(\d+)/skip", lambda m, b, q: skip_task(_id(m), b), True),
    ("POST", r"/api/tasks/(\d+)/snooze", lambda m, b, q: snooze_task(_id(m), b), True),

    ("DELETE", r"/api/completions/" + UID, lambda m, b, q: undo_completion(m.group(1)), True),
    ("PATCH", r"/api/completions/" + UID, lambda m, b, q: patch_completion(m.group(1), b), True),

    ("POST", r"/api/templates", lambda m, b, q: add_templates(b.get("names") or []), True),
]
ROUTES = [(meth, re.compile("^" + pat + "$"), fn, mut) for meth, pat, fn, mut in ROUTES]


# ---------------------------------------------------------------- server ----

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Tareas/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1":
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers
    def send_json(self, status, data, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return False
        c = cookies.SimpleCookie()
        try:
            c.load(raw)
        except cookies.CookieError:
            return False
        return COOKIE_NAME in c and hmac.compare_digest(c[COOKIE_NAME].value, TOKEN)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            self.close_connection = True  # no se lee: la conexión no se puede reutilizar
            raise ApiError(413, "Petición demasiado grande")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON no válido")
        if not isinstance(data, dict):
            raise ApiError(400, "Se esperaba un objeto JSON")
        return data

    def cookie_header(self, value, max_age):
        secure = os.environ.get("COOKIE_SECURE") == "1" or \
            self.headers.get("X-Forwarded-Proto", "") == "https"
        return "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s" % (
            COOKIE_NAME, value, max_age, "; Secure" if secure else "")

    # -- verbs
    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        url = urlparse(self.path)
        path = url.path
        if not path.startswith("/api/"):
            if method == "GET":
                return self.serve_static(path)
            return self.send_json(405, {"error": "Método no permitido"})
        try:
            self.handle_api(method, path, parse_qs(url.query))
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except sqlite3.IntegrityError as e:
            self.send_json(409, {"error": "Conflicto de datos: %s" % e})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("ERROR %s %s: %r\n" % (method, path, e))
            self.send_json(500, {"error": "Error interno"})

    def handle_api(self, method, path, query):
        # El cuerpo se lee siempre antes de responder (aunque sea un error): si se
        # queda sin leer en la conexión, estropea la siguiente petición.
        body = self.read_body() if method in ("POST", "PUT", "PATCH", "DELETE") else {}
        if path == "/api/health":
            return self.send_json(200, {"ok": True})
        if path == "/api/login" and method == "POST":
            if hmac.compare_digest(str(body.get("password", "")).encode(), PASSWORD.encode()):
                return self.send_json(200, {"ok": True},
                                      [("Set-Cookie", self.cookie_header(TOKEN, COOKIE_MAX_AGE))])
            time.sleep(1)  # frena ataques de fuerza bruta
            raise ApiError(401, "Contraseña incorrecta")
        if path == "/api/logout" and method == "POST":
            return self.send_json(200, {"ok": True}, [("Set-Cookie", self.cookie_header("", 0))])

        if not self.authed():
            raise ApiError(401, "No autenticado")

        if path == "/api/events" and method == "GET":
            return self.stream_events()

        for meth, pat, fn, mutates in ROUTES:
            if meth != method:
                continue
            m = pat.match(path)
            if not m:
                continue
            with DB_LOCK:
                try:
                    result = fn(m, body, query)
                    if mutates:
                        DB.commit()
                except Exception:
                    DB.rollback()
                    raise
            if mutates:
                bump()
                if isinstance(result, dict):
                    result.setdefault("version", VERSION)
            if path == "/api/export":
                return self.send_json(200, result, [
                    ("Content-Disposition", 'attachment; filename="tareas-copia.json"')])
            return self.send_json(200, result)
        raise ApiError(404, "Ruta no encontrada")

    def stream_events(self):
        q = queue.Queue(maxsize=50)
        with SUB_LOCK:
            SUBSCRIBERS.add(q)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(("retry: 3000\ndata: %s\n\n" % json.dumps({"version": VERSION})).encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=20)
                    self.wfile.write(("data: %s\n\n" % msg).encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")  # mantiene viva la conexión en proxies
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with SUB_LOCK:
                SUBSCRIBERS.discard(q)

    def serve_static(self, path):
        if path == "/" or not os.path.splitext(path)[1]:
            path = "/index.html"
        full = os.path.realpath(os.path.join(PUBLIC, path.lstrip("/")))
        if not full.startswith(os.path.realpath(PUBLIC) + os.sep) or not os.path.isfile(full):
            return self.send_json(404, {"error": "No encontrado"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("json", "javascript")):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # El service worker gestiona la caché; el navegador siempre revalida.
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    init_db()
    srv = Server((HOST, PORT), Handler)
    print("Tareas escuchando en http://%s:%d" % (HOST, PORT))
    if not os.environ.get("APP_PASSWORD"):
        print("Contraseña (guardada en %s/config.json): %s" % (DATA_DIR, PASSWORD))
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
