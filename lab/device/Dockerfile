# Lightweight "network device" stand-in: Alpine that replies to ICMP AND runs an
# SSH server, so the monitor can both ping it and pull facts over SSH, and you
# can `ssh root@...` into it manually. (Not a real NOS CLI — a Linux shell; swap
# for SR Linux / cEOS / FRR if you want real `show` commands — see ../README.md.)
FROM alpine:3.20

# openssh = sshd; iproute2 = real `ip` so `ip -o -4 addr show` works for the
# interface facts the collector parses; net-snmp = snmpd so the SNMP collector
# can poll sysinfo/CPU/mem/interface counters like on real gear.
RUN apk add --no-cache openssh iproute2 net-snmp \
    && ssh-keygen -A \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && printf 'rocommunity public\nsysLocation Azerbaijan lab\nsysContact netmon\n' > /etc/snmp/snmpd.conf \
    && printf '\n  *** LAB NETWORK DEVICE (Alpine stand-in) ***\n  Monitored by network_monitoring. Not a real NOS.\n  Test:  port down | port up | port flap 30   (toggle eth0 to drive alerts)\n\n' > /etc/motd

COPY entrypoint.sh /entrypoint.sh
COPY port /usr/local/bin/port
# Strip any CR (files may be authored on Windows) so the shebangs work.
RUN sed -i 's/\r$//' /entrypoint.sh /usr/local/bin/port \
    && chmod +x /entrypoint.sh /usr/local/bin/port

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
