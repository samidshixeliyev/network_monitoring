#!/bin/bash
nohup setsid sleep 86400 >/dev/null 2>&1 &
for i in $(seq 1 40); do
  code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:8000/api/devices 2>/dev/null)
  if [ "$code" = "403" ] || [ "$code" = "401" ]; then break; fi
  sleep 3
done
echo "api:$code"
