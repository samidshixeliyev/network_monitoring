"""Audit-gap features: packet loss counts, syslog store, auto-discovery,
SNMPv3 credentials, hourly continuous aggregate.

* ping_history.sent/received — per-check packet counts so partial loss
  (degraded links) is a first-class metric, not just up/down.
* syslog_history — hypertable for the UDP syslog receiver (30-day retention;
  logs are bulkier than ping samples).
* discovered_devices — pending inventory from the ICMP discovery sweep.
* devices.snmp_v3_* — USM credentials for SNMPv3 (v2c community stays).
* ping_history_hourly — Timescale continuous aggregate so trends survive the
  90-day raw retention (created outside the migration transaction; Timescale
  refuses continuous-aggregate DDL inside one).

Revision ID: 0006_audit_gaps
Revises: 0005_snmp
Create Date: 2026-07-07
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_audit_gaps"
down_revision: str | None = "0005_snmp"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_timescale() -> bool:
    return bool(
        op.get_bind()
        .execute(sa.text("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"))
        .scalar()
    )


def upgrade() -> None:
    # ── Packet loss counts ────────────────────────────────────────────────────
    op.add_column("ping_history", sa.Column("sent", sa.Integer(), nullable=True))
    op.add_column("ping_history", sa.Column("received", sa.Integer(), nullable=True))

    # ── SNMPv3 (USM) credentials ─────────────────────────────────────────────
    op.add_column("devices", sa.Column("snmp_v3_user", sa.Unicode(length=100), nullable=True))
    op.add_column(
        "devices",
        sa.Column("snmp_v3_auth_proto", sa.String(length=10), nullable=False, server_default="sha"),
    )
    op.add_column("devices", sa.Column("snmp_v3_auth_key", sa.Unicode(length=255), nullable=True))
    op.add_column(
        "devices",
        sa.Column("snmp_v3_priv_proto", sa.String(length=10), nullable=False, server_default="aes"),
    )
    op.add_column("devices", sa.Column("snmp_v3_priv_key", sa.Unicode(length=255), nullable=True))

    # ── Syslog store ─────────────────────────────────────────────────────────
    op.create_table(
        "syslog_history",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("host", sa.String(length=45), nullable=False),
        sa.Column("device_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("facility", sa.SmallInteger(), nullable=True),
        sa.Column("severity", sa.SmallInteger(), nullable=False),
        sa.Column("app_name", sa.Unicode(length=100), nullable=True),
        sa.Column("message", sa.UnicodeText(), nullable=False),
        sa.PrimaryKeyConstraint("ts", "id", name="pk_syslog_history"),
    )
    op.create_index("ix_syslog_history_host", "syslog_history", ["host", "ts"])
    op.create_index("ix_syslog_history_device_id", "syslog_history", ["device_id", "ts"])
    op.create_index("ix_syslog_history_severity", "syslog_history", ["severity", "ts"])

    # ── Discovery pending list ───────────────────────────────────────────────
    op.create_table(
        "discovered_devices",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("ip_address", sa.String(length=45), nullable=False),
        sa.Column("hostname", sa.Unicode(length=255), nullable=True),
        sa.Column("rtt_ms", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=10), nullable=False, server_default="new"),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ip_address", name="uq_discovered_devices_ip"),
    )

    # ── Timescale-only pieces (no-ops on plain Postgres) ─────────────────────
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
                PERFORM create_hypertable('syslog_history', 'ts', if_not_exists => TRUE);
                PERFORM add_retention_policy('syslog_history', INTERVAL '30 days', if_not_exists => TRUE);
            END IF;
        END
        $$;
        """
    )

    # Continuous aggregate: hourly latency/uptime/loss per device, kept beyond
    # the 90-day raw retention for long-term SLA/trend reporting.
    if _has_timescale():
        with op.get_context().autocommit_block():
            op.execute(
                """
                CREATE MATERIALIZED VIEW IF NOT EXISTS ping_history_hourly
                WITH (timescaledb.continuous) AS
                SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket,
                       device_id,
                       avg(rtt_ms) FILTER (WHERE success)  AS avg_rtt_ms,
                       count(*)                            AS samples,
                       count(*) FILTER (WHERE success)     AS up_samples,
                       sum(sent)                           AS sent,
                       sum(received)                       AS received
                FROM ping_history
                GROUP BY bucket, device_id
                WITH NO DATA;
                """
            )
            op.execute(
                """
                SELECT add_continuous_aggregate_policy('ping_history_hourly',
                    start_offset      => INTERVAL '3 hours',
                    end_offset        => INTERVAL '1 hour',
                    schedule_interval => INTERVAL '30 minutes',
                    if_not_exists     => TRUE);
                """
            )


def downgrade() -> None:
    if _has_timescale():
        with op.get_context().autocommit_block():
            op.execute("DROP MATERIALIZED VIEW IF EXISTS ping_history_hourly CASCADE;")
    op.drop_table("discovered_devices")
    op.drop_index("ix_syslog_history_severity", table_name="syslog_history")
    op.drop_index("ix_syslog_history_device_id", table_name="syslog_history")
    op.drop_index("ix_syslog_history_host", table_name="syslog_history")
    op.drop_table("syslog_history")
    op.drop_column("devices", "snmp_v3_priv_key")
    op.drop_column("devices", "snmp_v3_priv_proto")
    op.drop_column("devices", "snmp_v3_auth_key")
    op.drop_column("devices", "snmp_v3_auth_proto")
    op.drop_column("devices", "snmp_v3_user")
    op.drop_column("ping_history", "received")
    op.drop_column("ping_history", "sent")
