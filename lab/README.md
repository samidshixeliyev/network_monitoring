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

### Or toggle just the interface (port up/down)

To test like a real config change — shut the device's port instead of killing
the whole container — each device has a `port` helper (needs the `NET_ADMIN`
cap, already set in compose):

```bash
docker exec cisco-isr-baki port down     # eth0 DOWN → online→unknown→offline
docker exec cisco-isr-baki port up        # eth0 UP   → back online
docker exec cisco-isr-baki port flap 30   # DOWN 30s, then auto-UP
docker exec cisco-isr-baki port status    # show interface state
```

You can also run these from inside an SSH session (`ssh root@localhost -p 2211`),
but note `port down` cuts your own SSH (it runs over eth0) — use `port flap`
there so it auto-restores, or run `up`/`down` from the host as above.

| Container | IP | SSH (host) | Role | Critical |
|---|---|---|---|---|
| `cisco-isr-baki`       | 172.30.0.11 | `localhost:2211` | Cisco ISR 4331 (router)      | ✔ |
| `juniper-mx-ganja`     | 172.30.0.12 | `localhost:2212` | Juniper MX204 (router)       |   |
| `cisco-cat-sumqayit`   | 172.30.0.13 | `localhost:2213` | Cisco Catalyst 9300 (switch) |   |
| `juniper-srx-lankaran` | 172.30.0.14 | `localhost:2214` | Juniper SRX340 (firewall)    | ✔ |

## SSH — connect to a device & telemetry

The device containers run `sshd` (Alpine + openssh, built from `device/`). Two uses:

**1. Log in manually** (from WSL or Windows):

```bash
ssh root@localhost -p 2211        # cisco-isr-baki   (password: Lab_Dev1ce!)
# or, from inside the lab network / always works:
docker exec -it cisco-isr-baki sh
```

> It's a Linux shell, not a real router CLI. For real `show` commands swap the
> image for Nokia SR Linux / Arista cEOS / FRR (see the section below).

**Console access (out-of-band — survives the port going down).** SSH runs over
`eth0`, so `port down` kills your SSH. To get in regardless — like a serial
console on real gear — use the Docker daemon path instead of the network:

```bash
./console.sh cisco-isr-baki          # convenience helper (partial name ok)
# or directly:
docker exec -it cisco-isr-baki sh
```

This works even with `eth0` DOWN, so you can `port up` from the console to bring
the interface back.

**2. The monitor collects facts over SSH.** With `SSH_ENABLED=true` (set in the
compose `api`), a background collector logs into every `ssh_enabled` device every
`SSH_POLL_INTERVAL_SECONDS` and stores **hostname, uptime, interfaces, kernel**.
In the UI open a device → **SSH telemetriya** panel, or hit **⟳ SSH ilə indi
yoxla** for an on-demand pull (`POST /api/devices/{id}/ssh-check`). The 4 lab
devices are seeded with `root` / `Lab_Dev1ce!` automatically.

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
