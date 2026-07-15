# Real Juniper (vJunos-router) in the lab

The four `netmon.role=device` containers in the main compose are lightweight
Alpine stand-ins — great for ICMP/SSH up-down tests, but SSH into them is an
instant plain shell. This adds a **real Junos VM** so the web terminal behaves
like real gear: login → `admin@vjunos-baki>` CLI → `configure`, `commit`, etc.

It runs as the **`junos` profile** service `vjunos-baki` (172.30.0.21) in the
root `docker-compose.yml`. The VM boots from a **vrnetlab image** you build once
from the free vJunos-router qcow2.

Requirements already met on this host: `/dev/kvm` (nested virt), Docker, 28 CPU /
15 GB RAM. Missing: `git`, `make`, and the Junos image (below).

---

## One-time setup

### 1. Tooling (WSL, needs sudo — run these yourself)
```bash
sudo apt-get update && sudo apt-get install -y git make
```

### 2. Download the free vJunos-router image
Juniper gives vJunos-router away for labs (free account, no license):
- https://support.juniper.net/support/downloads/?p=vjunos-router
- Grab the `.qcow2`, e.g. `vJunos-router-23.4R1.10.qcow2`.

### 3. Build the vrnetlab container image
```bash
cd ~ && git clone https://github.com/hellt/vrnetlab.git
cp /path/to/vJunos-router-23.4R1.10.qcow2 ~/vrnetlab/vjunosrouter/
cd ~/vrnetlab/vjunosrouter && make          # builds vrnetlab/juniper_vjunosrouter:<version>
docker images | grep vjunosrouter           # note the exact <version> tag
```

If the tag isn't `23.4R1.10`, point the compose service at it (repo root):
```bash
echo "VJUNOS_IMAGE=vrnetlab/juniper_vjunosrouter:<your-version>" >> .env
```

---

## Run it

```bash
# from the repo root — the app/lab must be up first so netmon_netlab exists
docker compose --profile lab up -d                 # (if not already running)
docker compose --profile junos up -d               # boots the Junos VM

# the VM takes ~3-5 min to boot; watch it become reachable:
docker logs -f vjunos-baki                          # wait for "Startup complete"
```

Once SSH answers on 172.30.0.21, register the device and enable SNMP:

```bash
# 1) register the device row (ssh admin/admin@123, snmp public)
docker compose exec api python seed_junos_device.py

# 2) enable SNMP on the box — open the WEB TERMINAL to vjunos-baki in the UI and:
#      configure
#      set snmp community public authorization read-only
#      set snmp community public clients 172.30.0.0/24
#      commit and-quit
#    (the exact lines are in lab/vjunos/junos.set.cfg)
```

That SNMP step is itself the proof it's real Junos — you're committing config on
an actual box. After the commit, the collector's SNMP status for 172.30.0.21
turns **ok** within a poll cycle (~30 s).

---

## Verify

- **Web terminal** → `vjunos-baki`: you should land on `admin@vjunos-baki>` (real
  Junos CLI). `show version`, `show interfaces terse`, `configure` all work.
- **SNMP**: device card shows `snmp_status: ok` and Junos facts.
- **SSH facts**: hostname/uptime come from the Junos CLI fallback in
  `ssh_collector.py`; richer telemetry is via SNMP.

## Tear down
```bash
docker compose --profile junos down        # stops just the Junos VM
```

## Notes
- Default creds are vrnetlab's `admin` / `admin@123`. Change them in the built
  image's config and update `seed_junos_device.py` to match.
- Want more than one Junos node? Copy the `vjunos-baki` service, give it a new
  name + IP (172.30.0.22, …) and a matching device row.
- vrnetlab NATs 22/161/830 from the container's netlab IP to the VM, so no extra
  wiring is needed — the collector treats 172.30.0.21 like any other device.
