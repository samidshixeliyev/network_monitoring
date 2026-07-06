#!/bin/bash
# Topology (parent_id) smoke test against the lab API.
set -u
API=http://localhost:8000/api

TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"changeme"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $TOKEN"

# Map lab IPs → device ids
declare -A ID
while IFS=$'\t' read -r ip id; do ID[$ip]=$id; done < <(
  curl -s $API/devices -H "$AUTH" \
  | python3 -c 'import sys,json
for d in json.load(sys.stdin):
    print(d["ip_address"] + "\t" + d["id"])')

# NOTE: seeded IPs don't follow the container names — see seed_lab_devices.py.
BAKI=${ID[172.30.0.11]}      # Cisco ISR 4331      (Bakı, kritik)
GANJA=${ID[172.30.0.12]}     # Juniper MX204       (Gəncə)
SUMQAYIT=${ID[172.30.0.13]}  # Cisco Catalyst 9300 (Sumqayıt)
LANKARAN=${ID[172.30.0.14]}  # Juniper SRX340      (Lənkəran)

check() { # name expected_code actual_code detail
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected $2 got $3 — $4"; fi
}

patch_parent() { # device_id  parent_uuid|null  → http code (body in /tmp/topo_body)
  local pj
  if [ "$2" = null ]; then pj=null; else pj="\"$2\""; fi
  curl -s -o /tmp/topo_body -w '%{http_code}' -X PATCH $API/devices/$1 \
    -H "$AUTH" -H 'Content-Type: application/json' -d '{"parent_id":'"$pj"'}'
}

# 1. Valid parents: Gəncə → Bakı, Lənkəran → Sumqayıt
c=$(patch_parent $GANJA $BAKI);        check "ganja->baki"        200 "$c" "$(cat /tmp/topo_body)"
c=$(patch_parent $LANKARAN $SUMQAYIT); check "lankaran->sumqayit" 200 "$c" "$(cat /tmp/topo_body)"

# 2. Self-parent rejected
c=$(patch_parent $BAKI $BAKI);         check "self-parent"        422 "$c" "$(cat /tmp/topo_body)"

# 3. Cycle rejected (Bakı → Gəncə while Gəncə → Bakı)
c=$(patch_parent $BAKI $GANJA);        check "cycle"              422 "$c" "$(cat /tmp/topo_body)"

# 4. Nonexistent parent rejected
c=$(patch_parent $GANJA 00000000-0000-0000-0000-000000000000)
check "missing-parent" 422 "$c" "$(cat /tmp/topo_body)"

# 5. Clearing a parent works
c=$(patch_parent $LANKARAN null);      check "clear-parent"       200 "$c" "$(cat /tmp/topo_body)"
c=$(patch_parent $LANKARAN $SUMQAYIT); check "re-set-parent"      200 "$c" "$(cat /tmp/topo_body)"

# Final state
echo "--- parents now:"
curl -s $API/devices -H "$AUTH" | python3 -c 'import sys,json
ds=json.load(sys.stdin); by={d["id"]:d["vendor_name"] for d in ds}
for d in ds:
    print(d["vendor_name"].ljust(22), "parent=" + by.get(d["parent_id"], "—"))'
