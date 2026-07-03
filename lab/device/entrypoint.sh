#!/bin/sh
# Set the root password from the env (so the monitor's SSH collector and you can
# log in), make sure host keys exist, start snmpd (SNMP telemetry), then run
# sshd in the foreground.
set -e

: "${DEVICE_ROOT_PASSWORD:=Lab_Dev1ce!}"
echo "root:${DEVICE_ROOT_PASSWORD}" | chpasswd

[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A

# SNMP agent in the background (community: public, see snmpd.conf in the image).
/usr/sbin/snmpd -Lo -c /etc/snmp/snmpd.conf &

exec /usr/sbin/sshd -D -e
