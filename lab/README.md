# Docker Monitoring Lab — real, pingable devices

This spins up a self-contained environment so you can test the monitor against
**real devices that actually respond to ping** (instead of the fake TEST-NET
bots), and watch the live `online → unknown → offline` state machine when you
stop/start a container.

## Why everything is in Docker

On **Windows / macOS Docker Desktop the host cannot ping container IPs** (the
bridge network isn't routable from the host). So the prober (the `api`) must run
**on the same Docker network** as the devices. That's what this compose does.
(The frontend can stay on the host — it only talks to the API's published port.)

## Prerequisites

- **Docker Desktop** (not currently installed on this machine — install from
  https://www.docker.com/products/docker-desktop/ and enable the WSL2 backend).

## Run

```bash
cd lab
docker compose up -d --build        # builds api image, pulls mssql + alpine
```

On first start the `api` container automatically: creates the `network` DB →
runs migrations → seeds the manager account → seeds the 4 lab devices.

Then start the frontend on the host as usual:

```bash
cd ../frontend
npm run dev                          # http://localhost:5173
```

Login `admin@example.com` / `changeme`. The map shows 4 devices, all **online**.

## Test the live state machine

```bash
docker stop cisco-isr-baki           # power off the Baku router (critical)
```

Within ~15s (the lab interval) it goes **yellow (unknown)**, then on the next
failed check **red (offline)** → critical siren + KRİTİK toast.

```bash
docker start cisco-isr-baki          # back online (green)
```

| Container | IP | Role | Critical |
|---|---|---|---|
| `cisco-isr-baki`       | 172.30.0.11 | Cisco ISR 4331 (router)      | ✔ |
| `juniper-mx-ganja`     | 172.30.0.12 | Juniper MX204 (router)       |   |
| `cisco-cat-sumqayit`   | 172.30.0.13 | Cisco Catalyst 9300 (switch) |   |
| `juniper-srx-lankaran` | 172.30.0.14 | Juniper SRX340 (firewall)    | ✔ |

## Using REAL Cisco / Juniper / other NOS images

The 4 devices above are lightweight Alpine stand-ins (guaranteed to reply to
ICMP). To run actual network operating systems, swap the `image:` per service:

**Free, container-native (recommended):**
- Nokia SR Linux — `ghcr.io/nokia/srlinux` (public, free)
- Arista cEOS — `ceos:4.x` (free with registration)
- FRRouting — `frrouting/frr:latest` (fully open source)
- VyOS — community image

**Licensed Cisco / Juniper:**
- Cisco **XRd** (IOS XR, container-native) and Juniper **cRPD** / **cSRX** run in
  Docker directly — but need a vendor account and a license.
- VM-only images (Cisco IOSv/CSR/Nexus, Juniper vMX/vSRX) are run as
  QEMU-in-Docker via **[containerlab](https://containerlab.dev)** + `vrnetlab`.
  containerlab is the standard tool for multi-vendor topologies; point this
  monitor at the management IPs it assigns.

Whatever the image, the only requirement for monitoring is that the container
**replies to ICMP on a reachable IP** — then add it via the app (or seed it in
`backend/seed_lab_devices.py`).

## Notes

- This lab uses its **own MSSQL container** (isolated from your local SQLEXPRESS
  dev DB) so it is fully reproducible. Data lives in the container.
- `PING_METHOD=icmplib` here (works in the Linux container via the `NET_RAW`
  capability granted in the image) — no admin needed.
- Tear down: `docker compose down` (add `-v` to also drop the MSSQL data).
```
