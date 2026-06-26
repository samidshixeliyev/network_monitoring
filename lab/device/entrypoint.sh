#!/bin/sh
# Set the root password from the env (so the monitor's SSH collector and you can
# log in), make sure host keys exist, then run sshd in the foreground.
set -e

: "${DEVICE_ROOT_PASSWORD:=Lab_Dev1ce!}"
echo "root:${DEVICE_ROOT_PASSWORD}" | chpasswd

[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A

exec /usr/sbin/sshd -D -e
