#!/bin/sh
# Set root's password, ensure host keys, record boot time (for `show system
# uptime`), start snmpd, then run sshd in the foreground. SSH logins get the
# jcli Junos-CLI emulator (root's login shell); `docker exec ... sh` still works.
set -e

: "${DEVICE_ROOT_PASSWORD:=Lab_Dev1ce!}"
echo "root:${DEVICE_ROOT_PASSWORD}" | chpasswd

[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A

mkdir -p /var/lib/jcli
date +%s > /var/run/jcli.boot

# SNMP agent (community: public) so the monitor's SNMP collector stays green.
/usr/sbin/snmpd -Lo -c /etc/snmp/snmpd.conf &

exec /usr/sbin/sshd -D -e
