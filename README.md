# Tareas 🏠

App de tareas de casa para Carlos y Zoe: qué toca hoy, qué toca esta semana, quién ha hecho qué
y un reparto justo entre los dos. Se usa desde el iPhone como una app más (PWA) y los cambios se
ven al instante en los dos móviles. Es de la misma familia que [Comida](https://github.com/cvalera03/comida).

## Qué hace

| Sección | Para qué |
|---|---|
| **Hoy** | Lo atrasado, lo que toca hoy, las tareas sueltas sin fecha y lo ya hecho hoy. Un toque en el círculo = hecha por ti (con «Deshacer»). Arriba se añaden tareas sueltas tipo «llamar al fontanero». Filtro *Todas / Mías / De…* |
| **Semana** | De lunes a domingo: lo previsto (las repeticiones se proyectan) y lo hecho, con quién lo hizo. Flechas para ver otras semanas. |
| **Tareas** | Todas las tareas por habitación, con buscador y filtro. Gestión de habitaciones y tareas sugeridas. |
| **Reparto** | Puntos y tareas de cada uno en la semana o el mes, quién hace qué, turnos («le toca a…») e historial completo. |
| **Avatar (arriba en Hoy)** | Ajustes: ¿quién eres en este móvil?, habitaciones, sugerencias, historial, copia de seguridad y cerrar sesión. |

**Tareas**: cada una tiene habitación o zona, responsable (Carlos, Zoe, cualquiera o **por turnos**),
**esfuerzo** (ligera 1, normal 2, pesada 3 puntos) y frecuencia:

- **Una vez** (con fecha o «cuando se pueda»). Al hacerla pasa al historial.
- **Cada día / cada X días**: la siguiente se cuenta desde el día en que se hizo.
- **Semanal** (qué días, cada 1–4 semanas) y **mensual** (qué día o el último, cada 1–12 meses):
  siguen su calendario; si se hace antes de tiempo no vuelve a salir al día siguiente.
- Por turnos: al hacerla, le toca al otro.

Al abrir una tarea: marcarla como hecha por Carlos, Zoe o **los dos** (hoy o ayer), **posponer**
(mañana o una fecha), **saltar esta vez**, ver las últimas veces, editar o eliminar.

Detalles:

- **¿Quién eres?** La contraseña es común; la primera vez cada móvil pregunta quién eres y lo recuerda.
- **Aviso** cuando el otro termina algo mientras tienes la app abierta («Zoe ha hecho: Limpiar el baño ✓»).
- **Sin duplicados**: habitaciones y tareas se comparan sin mayúsculas, tildes, plurales ni artículos
  («Baños» = «baño», «Limpiar baño» = «Limpiar el baño»). Si ya existe se reutiliza o se avisa.
  Renombrar una habitación o tarea actualiza también el historial.
- **Se empieza en 0**: la instalación nueva solo trae las habitaciones. Las 12 tareas sugeridas
  (fregar, basura, baño, sábanas, aspirar…) se añaden desde Hoy/Tareas con un toque o todas a la vez.
- **Sin conexión**: la app abre con la última copia. Marcar como hecha, deshacer, posponer, saltar y
  cambiar quién la hizo se guardan en cola (aviso «N cambios pendientes») y se envían solos al volver
  la red, con la hora real. Si los dos marcan la misma tarea, cuenta una sola vez.

### Cómo funciona por dentro

```
 iPhone Carlos ─┐   HTTPS (Tailscale)          ZimaOS (Docker)
                ├──────────────────────▶  contenedor "tareas"  ──▶ /DATA/AppData/tareas
 iPhone Zoe  ───┘   ◀── eventos en vivo ──   Python + SQLite           tareas.db, config.json
```

- **Servidor**: `server.py`, solo librería estándar de Python (sin dependencias). API JSON + SQLite.
- **Tiempo real**: Server-Sent Events. Al volver la app al primer plano, reconecta y recarga.
- **Cliente**: PWA en HTML/CSS/JS sin frameworks ni compilación (`public/`).
- **Acceso**: contraseña compartida (`APP_PASSWORD`), sesión de ~13 meses. Si cambias la contraseña,
  se cierran todas las sesiones.
- **Base de datos**: al arrancar, el servidor actualiza sola una base de datos de una versión anterior
  sin perder datos (`PRAGMA user_version` + pasos en `migrate()`).
- **Imagen Docker**: ~18 MB, amd64 y arm64, proceso sin privilegios y healthcheck.

## Instalar en ZimaOS

1. Cada push a `main` construye y publica `ghcr.io/cvalera03/tareas:latest` (GitHub Action).
2. La primera vez: GitHub → perfil → **Packages** → `tareas` → *Package settings* →
   **Change visibility → Public** (la imagen no contiene datos ni contraseñas).
3. En ZimaOS: **App Store → «+» → Install a customized app → Import**, pega `zimaos/tareas.yml`
   cambiando antes `APP_PASSWORD`, e instala.
4. Abre `http://<ip-del-zimaos>:8421`.

### Actualizar a una versión nueva

1. `git push` y espera a que la Action termine en verde
   ([pestaña Actions](https://github.com/cvalera03/tareas/actions), ~2 minutos).
2. En el Terminal de ZimaOS (todo con `sudo`):
   ```bash
   sudo docker pull ghcr.io/cvalera03/tareas:latest && DIR=$(sudo docker inspect tareas --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}') && sudo docker compose --project-directory "$DIR" up -d
   ```
3. En los iPhone, cerrad la app (deslizar hacia arriba) y abridla de nuevo. Si aún se ve la versión
   anterior, repetidlo una vez más.

Los datos viven en `/DATA/AppData/tareas` y no se tocan al actualizar.

## Desde fuera de casa: Tailscale + HTTPS

Con la app de Tailscale en ZimaOS y en los dos iPhone ya se puede abrir
`http://<nombre-del-zimaos>:8421` desde cualquier sitio. Para HTTPS (necesario para el modo sin
conexión completo en iOS), Comida ya usa el puerto HTTPS 443, así que Tareas va en el **8443**:

```bash
sudo docker exec <contenedor-tailscale> tailscale serve --bg --https=8443 http://localhost:8421
```

URL: `https://<nombre-del-zimaos>.<tu-tailnet>.ts.net:8443`. Ver lo publicado:
`sudo docker exec <contenedor-tailscale> tailscale serve status`.

## Instalar en los iPhone

1. Abre la URL en **Safari**.
2. **Compartir → Añadir a pantalla de inicio**.
3. Abre «Tareas», entra con la contraseña y elige quién eres. En los dos móviles.

## Copias de seguridad

Todo está en `/DATA/AppData/tareas/tareas.db`:

- Incluye `/DATA/AppData/tareas` en la copia de seguridad de ZimaOS, o
- Descarga un JSON con todo desde la app: **Avatar → Descargar copia de seguridad** (`/api/export`).

Para restaurar la base de datos: para la app, sustituye `tareas.db` (borra `tareas.db-wal` y
`tareas.db-shm` si existen) y vuelve a arrancarla.

## Desarrollo en el Mac

```bash
APP_PASSWORD=prueba DATA_DIR=./data python3 server.py
```

Abre `http://localhost:8080`. Con Docker (`colima start` antes):

```bash
APP_PASSWORD=prueba DATA_PATH=./data docker compose up --build
```

(`http://localhost:8421`). Pruebas de la API de punta a punta (arrancan su propio servidor,
incluyen la migración desde la versión 1):

```bash
python3 tests/test_api.py
```

Reglas al cambiar cosas:

- Tras cambiar ficheros de `public/`, **sube `CACHE` en `public/sw.js`** (`tareas-v2`, `v3`…).
- Si cambia el esquema de la base de datos: sube `SCHEMA_VERSION`, añade el paso en `migrate()` y
  una prueba en `tests/test_api.py` que parta de una base de datos de la versión anterior.
- La lógica de fechas está en `server.py` y en `public/app.js` (para funcionar sin conexión):
  cambia las dos.
- Iconos: `python3 tools/make_icons.py`.

### API (resumen)

`GET /api/state` devuelve todo (tareas, habitaciones, historial de ~10 semanas);
`GET /api/events` es el canal en vivo; `GET /api/history?offset=&who=` el historial completo.
Escritura: `/api/tasks`, `/api/tasks/:id/{done,skip,snooze}`, `/api/completions/:uid`
(`DELETE` = deshacer, `PATCH` = cambiar quién), `/api/rooms`, `/api/templates`.

## Ideas para más adelante

- **Notificaciones push** en el iPhone con la app cerrada («Hoy tenéis 3 tareas», «Zoe ha hecho…»).
  iOS lo permite en PWAs instaladas, pero exige cifrado Web Push (VAPID), que con solo la librería
  estándar de Python es bastante trabajo.
- Subtareas o lista de pasos (limpiar baño: váter, lavabo, ducha, espejo).
- Tareas de temporada (limpiar el aire acondicionado en junio).
- Resumen semanal el domingo con el reparto y las rachas.
- Enlace con Comida: «hacer la compra» cuando la lista de la compra tenga cosas.
