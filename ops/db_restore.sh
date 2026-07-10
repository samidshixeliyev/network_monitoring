#!/bin/sh
# Restore a dump produced by ops/db_backup.sh into the running db container.
#
#   ./ops/db_restore.sh backups/network_2026-07-07_020000.dump
#
# Stops the API first so nothing writes during the restore, drops + recreates
# the database, restores, and restarts the API (which re-runs migrations —
# a no-op on a complete dump).
set -eu

DUMP="${1:?usage: db_restore.sh <path/to/dump>}"
DB="${PGDATABASE:-network}"
USER="${PGUSER:-postgres}"

[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

echo "Stopping API…"
docker compose stop api

echo "Recreating database ${DB}…"
docker compose exec -T db psql -U "$USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE);" \
    -c "CREATE DATABASE ${DB};"

echo "Restoring ${DUMP}…"
docker compose exec -T db pg_restore -U "$USER" -d "$DB" --no-owner < "$DUMP"

echo "Starting API…"
docker compose start api
echo "Done."
