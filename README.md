# Network Device Monitoring System

Real-time network device monitoring with RBAC, live WebSocket status updates, and event logging.

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.12, FastAPI (async), SQLAlchemy 2.0, asyncpg |
| Database | PostgreSQL 16 |
| Realtime | WebSockets (FastAPI native) |
| ICMP | icmplib `async_multiping` — batched, no subprocesses |
| Auth | JWT + passlib[bcrypt] |
| Frontend | React 18, TypeScript, Vite, TanStack Query |
| Container | Docker + docker-compose |

---

## Quick Start

### 1. Clone and configure
```bash
git clone <repo>
cd network_monitoring
cp .env.example .env
# Edit .env — change SECRET_KEY, POSTGRES_PASSWORD, DEFAULT_MANAGER_PASSWORD
```

### 2. Build and start
```bash
docker compose up -d --build
```

### 3. Run migrations and seed
```bash
docker compose exec api alembic upgrade head
docker compose exec api python seed.py
```

### 4. Open
| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API docs (Swagger) | http://localhost:8000/docs |
| API docs (Redoc) | http://localhost:8000/redoc |

Default login: `admin@example.com` / `changeme` (set via `.env` before seeding).

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

### Running without Docker

```bash
# Backend
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# Copy .env.example to .env, set DATABASE_URL to point at localhost
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

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
        ├── api/                 # axios clients (auth, devices, events)
        ├── components/          # StatusBadge, DeviceForm, Pagination …
        ├── hooks/               # useDevices, useWebSocket, useAuth
        ├── pages/               # Login, Dashboard, EventLog
        └── types/               # TypeScript interfaces mirroring backend schemas
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | asyncpg connection string |
| `SECRET_KEY` | — | JWT signing key — **change before deploy** |
| `ALGORITHM` | `HS256` | JWT algorithm |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Token TTL |
| `PING_INTERVAL_SECONDS` | `30` | Ping loop cadence |
| `FLAP_THRESHOLD` | `3` | Consecutive failures to flip OFFLINE |
| `DEFAULT_MANAGER_EMAIL` | `admin@example.com` | Seed manager email |
| `DEFAULT_MANAGER_PASSWORD` | `changeme` | Seed manager password |

---

## RBAC

| Role | Permissions |
|---|---|
| `manager` | Add, edit, delete devices; manage users; view all |
| `user` | Read-only: view device status, event log |

Enforced on the **backend** via a `require_role("manager")` FastAPI dependency injected into write endpoints. The frontend hides controls based on role, but the backend is the authoritative gate.

---

## WebSocket Contract

Connect to `ws://localhost:8000/ws/status` (authenticated via `?token=<jwt>`).

On any device status change the server pushes:
```json
{ "device_id": "uuid", "status": "online|offline", "last_checked_at": "ISO8601" }
```

---

## Phase 2 (deferred)
- Map visualization (lat/lon columns exist in DB schema but are unused)
- SSH / Telnet / Serial remote access
- Ping history charts
- Alert/notification rules
