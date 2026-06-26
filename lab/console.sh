#!/bin/sh
# Out-of-band "console" into a lab device — like the serial console on real
# gear. Goes through the Docker daemon, NOT the network, so it still works when
# the device's port/eth0 is DOWN (when SSH over eth0 is dead).
#
#   ./console.sh                 # list devices
#   ./console.sh cisco-isr-baki  # open a shell on that device
#   ./console.sh baki            # partial name also matches
name="$1"

if [ -z "$name" ]; then
  echo "Lab devices (console = docker exec, works even if the port is down):"
  docker ps --filter "label=com.docker.compose.project=netmon-lab" --format "{{.Names}}" | grep -Ev "mssql|api" | sort | sed 's/^/  /'
  echo
  echo "usage: ./console.sh <device>     e.g.  ./console.sh cisco-isr-baki"
  exit 0
fi

full=$(docker ps --filter "label=com.docker.compose.project=netmon-lab" --format "{{.Names}}" | grep -Ev "mssql|api" | grep -i "$name" | head -1)
[ -z "$full" ] && { echo "No running device matches '$name'"; exit 1; }

echo "console → $full   (type 'exit' or Ctrl-D to leave)"
exec docker exec -it "$full" sh
