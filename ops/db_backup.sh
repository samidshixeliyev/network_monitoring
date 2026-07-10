#!/bin/sh
# Scheduled PostgreSQL backup with rotation — runs inside the db-backup sidecar
# (same timescale/timescaledb image as the server, so pg_dump versions match).
#
# Env (set by docker-compose):
#   PGHOST / PGUSER / PGPASSWORD / PGDATABASE  — connection
#   BACKUP_DIR              (default /backups) — mount a HOST path here; a backup
#                                                that lives only in a container
#                                                volume dies with the volume
#   BACKUP_INTERVAL_SECONDS (default 86400)    — one backup per day
#   BACKUP_RETRY_SECONDS    (default 300)      — wait after a FAILED dump (so a
#                                                db-not-ready startup race retries
#                                                in minutes, not a full day)
#   BACKUP_KEEP             (default 14)       — dumps to retain
#
# Restore: see ops/db_restore.sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETRY="${BACKUP_RETRY_SECONDS:-300}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
echo "db-backup: every ${INTERVAL}s → ${BACKUP_DIR}, keeping last ${KEEP}"

while :; do
    ts="$(date +%Y-%m-%d_%H%M%S)"
    out="${BACKUP_DIR}/${PGDATABASE}_${ts}.dump"
    tmp="${out}.part"

    # Custom format (-Fc): compressed + selective-restore friendly (pg_restore).
    if pg_dump -Fc --no-owner -f "$tmp" "$PGDATABASE"; then
        mv "$tmp" "$out"
        echo "db-backup: OK $out ($(du -h "$out" | cut -f1))"
        next="$INTERVAL"
    else
        rm -f "$tmp"
        # A failed dump is usually a transient db-not-ready race (e.g. the whole
        # stack just restarted) — retry in minutes rather than sleeping a day.
        echo "db-backup: FAILED at ${ts} — retrying in ${RETRY}s" >&2
        next="$RETRY"
    fi

    # Rotation: keep the newest $KEEP dumps.
    ls -1t "${BACKUP_DIR}"/*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
        echo "db-backup: pruning $old"
        rm -f "$old"
    done

    sleep "$next"
done
