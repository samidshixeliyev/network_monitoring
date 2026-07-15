#!/bin/bash
# Hər şeyi dayandırır: docker konteynerləri + vJunos VM + forwarderlər.
# WSL Ubuntu daxilində işlət:   bash stop-all.sh
REPO="/mnt/c/Users/samid.sixaliyev/Desktop/workspace/network_monitoring"

echo "==> vJunos VM + forwarderləri dayandırıram"
sudo pkill -f "name vjunos-router" 2>/dev/null && echo "  VM dayandı" || echo "  VM onsuz da işləmirdi"
sudo pkill -f "bind=172.30.0.1"    2>/dev/null || true

echo "==> Docker konteynerlərini dayandırıram"
cd "$REPO"
docker compose --profile lab down          # 'down' bütün profilləri söndürür

echo "==> Hazırdır."
