# Network Device Monitoring System

Real-time network device monitoring on an **offline map of Azerbaijan**, with RBAC,
live WebSocket status updates, and event logging. Devices are placed by their
geographic coordinates and their status (online / offline / unknown) updates live.

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.12, FastAPI (async), SQLAlchemy 2.0, asyncpg |
| Database | PostgreSQL + TimescaleDB (single container — relational data + time-series ping history) |
| Cache / bus | Redis (current-state snapshot cache + pub/sub between collector and gateways) |
| Realtime | WebSockets (FastAPI native) |
| ICMP | icmplib `async_multiping` — batched, no subprocesses |
| Auth | JWT + passlib[bcrypt] |
| Frontend | React 18, TypeScript, Vite, TanStack Query |
| Map | Leaflet + react-leaflet — **fully offline** (bundled GeoJSON outline; optional self-hosted OSM raster tiles) |
| Container | Docker + docker-compose |

---

## Prerequisites

- **Docker + docker-compose** — the simplest path. The stack ships its own
  PostgreSQL+TimescaleDB and Redis containers, so nothing external is needed.
- For local (non-Docker) runs: a reachable **PostgreSQL** with the **TimescaleDB**
  extension available, plus Python 3.12 and Node 18+.

> **Recommended:** run the whole stack with Docker (`docker compose up`); it
> brings up Postgres+Timescale, Redis, and the API together. The monitoring lab
> in `lab/` additionally spins up pingable "network device" containers.

## Quick Start (Docker — recommended)

```bash
docker compose up -d --build     # db (Postgres+Timescale) + redis + api + frontend
# API → http://localhost:8000   Frontend → http://localhost:5173
```

## Quick Start (local backend)

### 1. Configure
```bash
cp .env.example .env
# Edit .env — set POSTGRES_* (host, port, db, user, password), REDIS_URL,
# SECRET_KEY and DEFAULT_MANAGER_PASSWORD.
```

### 2. Backend
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python create_db.py             # create the database if it doesn't exist
alembic upgrade head            # create tables in Postgres
python seed.py                  # roles + default manager account
uvicorn app.main:app --reload   # http://localhost:8000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

### 4. Open
| Service | URL |
|---|---|
| Frontend (map) | http://localhost:5173 |
| API docs (Swagger) | http://localhost:8000/docs |
| API docs (Redoc) | http://localhost:8000/redoc |

Default login: `admin@example.com` / `changeme` (set via `.env` before seeding).

---

## Offline Map of Azerbaijan

The map works **with no internet access** — no online tile providers are used.

- **Default basemap:** a bundled vector outline of Azerbaijan
  (`frontend/src/assets/azerbaijan.json`, GeoJSON). District/country borders are
  drawn client-side; devices are placed as colored status dots by their
  `latitude`/`longitude`.
- **Adding a device:** click **+ Add Device** → click a point on the map (or pick
  *Konumsuz əlavə et* to add without a location), then fine-tune the lat/lon in
  the form. Coordinates are also editable by hand at any time.
- **Live status:** dots recolor in real time via WebSocket
  (green = online, red = offline, grey = unknown).

### Offline OSM basemap (z0–z9)

The map uses **self-hosted OpenStreetMap raster tiles**, pre-downloaded for the
Azerbaijan bounding box (zoom 0–9) and served locally — **fully offline**, no
internet tile providers at runtime. Download once on an internet-connected
machine, then ship `backend/tiles/` to the air-gapped server.

```bash
cd backend
python scripts/download_osm_tiles.py            # → backend/tiles/osm/{z}/{x}/{y}.png
# options:
#   MAX_ZOOM=9 python scripts/download_osm_tiles.py
#   python scripts/download_osm_tiles.py --bbox 44.5,38.0,50.6,42.0
#   TILE_SERVER=https://your-tileserver python scripts/download_osm_tiles.py
```

The API auto-serves `backend/tiles/` at `/tiles/...` (see `app/main.py`), and the
frontend loads `/tiles/osm/{z}/{x}/{y}.png` by default (no env needed). The
bundled GeoJSON outline overlays the imagery as a thin border.

> OSM's tile usage policy forbids bulk downloading from the public server — the
> one-time ~100-tile bbox prefetch is fine, but for larger areas/zooms point
> `TILE_SERVER` at your own or a licensed tile server. Tiles are gitignored
> (`backend/tiles/`) since they're generated binary assets.
>
> Override the URL/zoom with `VITE_TILES_URL` / `VITE_TILES_MAX_ZOOM` if needed.

---

## Status detection — staggered probing + state machine

Each enabled device is probed on its **own schedule**, spread across the interval
(**staggered** — not all at once) so probe traffic is smooth instead of bursting.

Every check sends **`PING_COUNT` ICMP packets** (default 3 — long paths can drop
some); the device is **alive if at least one replies**. The status is a 3-state
machine driven by consecutive fully-failed checks:

```
any reply              → ONLINE   (green)
1 failed check         → UNKNOWN  (yellow)   ← warning, no alarm yet
FLAP_THRESHOLD failures→ OFFLINE  (red)      ← alarm + event logged
```

With the defaults (`PING_COUNT=3`, `FLAP_THRESHOLD=2`): first all-3-fail check →
yellow, second consecutive all-3-fail check → red. Detection is intentionally
**not instant** — this avoids false alarms from a single dropped packet.

Two probe methods (`PING_METHOD`):
- **`system`** (default) — the OS `ping` command. **Works on Windows without admin.**
- **`icmplib`** — raw ICMP, faster/batched, but needs admin / `CAP_NET_RAW`.

**For real monitoring:** set `SIMULATION_MODE=false` and add your **real device IPs**
(gateway, switches, servers…). Pull a cable / power off a device and within
`interval × threshold` seconds it turns red on the map.

### Real devices in Docker

For **real, pingable devices** (instead of fake TEST-NET bots), see
[`lab/`](lab/README.md) — a self-contained Docker lab with 4 device containers
(Cisco/Juniper-named), MSSQL, and the backend on one network. `docker stop`
a container to watch it go UNKNOWN → OFFLINE live. Swap in real NOS images
(Nokia SR Linux / Arista cEOS / FRR, or Cisco XRd / Juniper cRPD, or
`containerlab` for licensed vMX/CSR images).

### Simulation / demo (no real hardware)

Set `SIMULATION_MODE=true` to disable probing and drive status by hand — handy for
demos. The 8 bot devices use TEST-NET IPs (`192.0.2.11–18`, not real), so under real
ping they would read offline; in simulation you control them:

```bash
python seed_test_devices.py        # 8 bot devices across AZ cities (3 marked critical)
```

Toggle up/down from the **device drawer** ("▲ Up et / ▼ Down et"), or by id:

```bash
curl -X POST http://localhost:8000/api/devices/<id>/simulate \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"status":"offline"}'
```

## Alerts & critical devices

When a device goes **down**, an audible alert sounds + a toast appears; every up/down
is logged in the **Events** page.

- **Normal device** → standard two-tone alert; toast auto-closes after 10s.
- **Critical device** (`is_critical`, set via the form checkbox) → **distinct urgent
  siren**, a **pulsing red "KRİTİK" toast that stays until acknowledged**, floated to
  the top, and a **pulsing ⚠ ring on the map marker** — for fast reaction.

---

## CAP_NET_RAW Requirement

`icmplib` uses raw ICMP sockets. Raw socket creation requires the `CAP_NET_RAW` Linux capability.

**The `api` container is granted `CAP_NET_RAW` via `cap_add` in `docker-compose.yml`.  
The process runs as a non-root user (`appuser`, UID 1000) — root is not required.**

### Deploying outside Docker (bare-metal / VM)

Grant the capability to the Python interpreter instead of running as root:
```bash
sudo setcap cap_net_raw+ep $(which python3)
```
Or use the systemd service file approach with `AmbientCapabilities=CAP_NET_RAW`.

---

## Development

Hot reload is enabled out of the box:
- **API**: `uvicorn --reload` + volume mount `./backend:/app`
- **Frontend**: Vite HMR + volume mount `./frontend:/app`

The local run shown in **Quick Start** above is the recommended dev setup.

---

## Project Structure

```
network_monitoring/
├── docker-compose.yml
├── .env.example
├── README.md
│
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── seed.py                  # seeds roles + default manager account
│   ├── alembic/
│   │   ├── env.py
│   │   ├── script.py.mako
│   │   └── versions/
│   └── app/
│       ├── main.py              # FastAPI app + lifespan (starts ping scheduler)
│       ├── api/
│       │   ├── deps.py          # get_current_user, require_role
│       │   └── routes/
│       │       ├── auth.py      # POST /auth/login
│       │       ├── devices.py   # CRUD /devices
│       │       ├── events.py    # GET /events (paginated)
│       │       └── ws.py        # WS /ws/status
│       ├── core/
│       │   ├── config.py        # pydantic-settings
│       │   ├── security.py      # JWT encode/decode, bcrypt
│       │   └── logging.py       # structured logging setup
│       ├── db/
│       │   └── session.py       # async engine + session factory
│       ├── models/              # SQLAlchemy ORM (Role, User, Device, EventLog)
│       ├── schemas/             # Pydantic v2 request/response models
│       └── services/
│           ├── ping_scheduler.py # asyncio background task — batched ICMP
│           └── ws_manager.py    # WebSocket connection registry + broadcast
│
└── frontend/
    ├── Dockerfile
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── assets/
        │   └── azerbaijan.json  # bundled GeoJSON outline (offline basemap)
        ├── api/                 # axios clients (auth, devices, events)
        ├── components/          # AzerbaijanMap, DeviceForm, DeviceDrawer, NetworkGraph …
        ├── hooks/               # useWebSocket, useAuth
        ├── pages/               # Login, Dashboard, EventLog
        └── types/               # TypeScript interfaces mirroring backend schemas
```

> Offline OSM tiles live in `backend/tiles/osm/{z}/{x}/{y}.png` and are served at
> `/tiles/...` (see the prefetch script above). The directory is gitignored.

---

## Environment Variables

**Backend** (`.env`):

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | `localhost` | Postgres/TimescaleDB host |
| `POSTGRES_PORT` | `5432` | Postgres port |
| `POSTGRES_DB` | `network` | Database name (auto-created by `create_db.py`) |
| `POSTGRES_USER` | `postgres` | DB user |
| `POSTGRES_PASSWORD` | `changeme` | DB password |
| `DATABASE_URL` | — | Optional full override; ignores the `POSTGRES_*` parts |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis (snapshot cache + pub/sub bus) |
| `SECRET_KEY` | — | JWT signing key — **change before deploy** |
| `ALGORITHM` | `HS256` | JWT algorithm |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Token TTL |
| `PING_INTERVAL_SECONDS` | `30` | Slow cadence for stable/healthy devices |
| `PING_FAST_INTERVAL_SECONDS` | `5` | Fast cadence for recently-flapping / non-online devices |
| `PING_VOLATILE_WINDOW_SECONDS` | `120` | How long a device stays on the fast cadence after a change |
| `FLAP_THRESHOLD` | `2` | Consecutive failures to flip OFFLINE |
| `EMBEDDED_COLLECTOR` | `true` | Run probe loops in the API process. Set `false` when a separate `collector` service runs them |
| `DEFAULT_MANAGER_EMAIL` | `admin@example.com` | Seed manager email |
| `DEFAULT_MANAGER_PASSWORD` | `changeme` | Seed manager password |

**Frontend** (`frontend/.env.local`, optional):

| Variable | Default | Description |
|---|---|---|
| `VITE_TILES_URL` | `/tiles/osm/{z}/{x}/{y}.png` | XYZ template for the offline basemap tiles |
| `VITE_TILES_MAX_ZOOM` | `9` | Highest zoom level the prefetched tiles cover |

---

## RBAC

Access is **permission-based**. Roles are named bundles of permissions
(`permissions` + `role_permissions` tables); the backend is the authoritative
gate via a `require_permission(...)` FastAPI dependency, and the frontend only
hides controls based on the same permission set returned at login.

**Permissions:** `view`, `ssh`, `ack`, `mute`, `edit_device`, `edit_config`, `manage_users`

| Role | Permissions |
|---|---|
| `viewer` / `user` | `view` |
| `operator` | `view`, `ssh`, `ack`, `mute` |
| `engineer` | `view`, `ssh`, `ack`, `mute`, `edit_device`, `edit_config` |
| `manager` | all of the above + `manage_users` |

- **SSH / web-shell is gated by the `ssh` permission** — regular viewers cannot
  open a device shell (enforced on the WebSocket endpoint, not just the UI).
- **Audit trail:** user actions (SSH open/close, device create/update/delete,
  simulate, ssh-check) are written to `audit_logs` and exposed at
  `GET /api/audit` (requires `manage_users`).

---

## WebSocket Contract

Connect to `ws://localhost:8000/ws/status` (authenticated via `?token=<jwt>`).

On any device status change the server pushes:
```json
{ "device_id": "uuid", "status": "online|offline", "last_checked_at": "ISO8601" }
```

---

## Done
- ✅ Offline Azerbaijan map with live, geo-placed device status
- ✅ PostgreSQL + TimescaleDB backend (asyncpg)
- ✅ Redis current-state cache + pub/sub (dashboard snapshot served from Redis)
- ✅ Coalesced WebSocket batches + Leaflet marker clustering (smooth at scale)
- ✅ Permission-based RBAC + audit trail (SSH gated by `ssh` permission)
- ✅ Offline self-hosted OSM basemap (z0–z9), no internet at runtime
- ✅ SSH telemetry + browser web terminal
- ✅ Separate collector process (single source) + adaptive probe scheduling
- ✅ Self-monitoring heartbeat (`GET /api/monitor/heartbeat`)

## Roadmap (in progress)
- Ping/latency history (TimescaleDB) + trend charts
- Alert rules + escalation (Telegram/email), dependencies, maintenance windows, SLA reports
- Multi-condition checks (TCP/HTTP), dashboard search/filter/group-by-region
