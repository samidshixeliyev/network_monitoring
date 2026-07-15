#!/bin/bash
# Bütün sistemi qaldırır: app + monitorinq botları (docker) + real vJunos VM (QEMU).
# WSL Ubuntu daxilində işlət:   bash start-all.sh
set -e
REPO="/mnt/c/Users/samid.sixaliyev/Desktop/workspace/network_monitoring"

echo "==> 1/2  App + network botları (docker compose --profile lab)"
cd "$REPO"
docker compose --profile lab up -d        # ilk dəfə / kod dəyişəndə sonuna --build əlavə et

echo "==> 2/2  Real vJunos VM (QEMU) + forwarderlər"
sudo /opt/vjunos/run.sh                    # docker qalxandan SONRA (172.30.0.1 bridge lazımdır)

echo
echo "==> Hazırdır. Konteynerlər:"
docker ps --format '  {{.Names}}\t{{.Status}}' | sort
echo
echo "  Lokal:  http://localhost:5173      (API: http://localhost:8000)"
echo "  LAN:    http://172.22.111.11:5273"
echo "  vJunos VM ~3-5 dəq boot olur; SSH: ssh -p 2222 root@127.0.0.1 (parol Juniper123)"
