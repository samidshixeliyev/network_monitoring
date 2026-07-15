# "vJunos" lab stand-in with a Junos-like CLI. Same Alpine + sshd + snmpd base as
# the plain device, but root's login shell is the jcli emulator, so SSH (and the
# web terminal) land on an operational `user@host>` prompt where `show version`,
# `configure`, `set`, `commit` work — instead of a bare Linux shell. It is an
# emulator, not real Junos (that needs the vJunos image — see ../vjunos/README.md).
FROM alpine:3.20

RUN apk add --no-cache openssh iproute2 net-snmp net-snmp-tools python3 \
    && ssh-keygen -A \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PrintMotd.*/PrintMotd no/' /etc/ssh/sshd_config \
    && : > /etc/motd \
    && printf 'rocommunity public\nsysLocation Azerbaijan lab\nsysContact netmon\ntrap2sink collector:1620 public\nauthtrapenable 1\nlinkUpDownNotifications yes\n' > /etc/snmp/snmpd.conf

COPY jcli.py /usr/local/bin/jcli
COPY entrypoint.sh /entrypoint.sh
# Strip CRs (files may be Windows-authored), make executable, and point root's
# login shell at the Junos CLI emulator.
RUN sed -i 's/\r$//' /usr/local/bin/jcli /entrypoint.sh \
    && chmod +x /usr/local/bin/jcli /entrypoint.sh \
    && sed -i 's#^\(root:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*\):.*#\1:/usr/local/bin/jcli#' /etc/passwd

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
