"""Permission catalogue + default role→permission mapping.

Permissions are the authoritative gate enforced on the backend (see
`require_permission` in app/api/deps.py). Roles are just named bundles of
permissions; the frontend only hides controls based on the same set. Custom
roles can be created from any permission combination in the admin panel.
"""

# ── Permission names ─────────────────────────────────────────────────────────
# NOTE: alarm acknowledgement is deliberately NOT a permission — any
# authenticated user can ack (ops decision, 2026-07-03).
VIEW = "view"                 # see devices / map / status
SNMP = "snmp"                 # see SNMP telemetry/history + on-demand snmp poll
SSH = "ssh"                   # open an SSH / web-shell session to a device
MUTE = "mute"                 # mute / set maintenance on a device (admin-level)
EDIT_DEVICE = "edit_device"   # create / update / delete devices
EDIT_CONFIG = "edit_config"   # change monitoring config (e.g. simulate status)
MANAGE_USERS = "manage_users"  # manage users/roles, view the audit trail

ALL_PERMISSIONS = [VIEW, SNMP, SSH, MUTE, EDIT_DEVICE, EDIT_CONFIG, MANAGE_USERS]

# Built-in roles: protected from deletion; "manager" also from permission edits.
BUILTIN_ROLES = {"viewer", "user", "operator", "engineer", "manager"}

# ── Default roles → permissions ──────────────────────────────────────────────
# viewer  → status only; operator → + SNMP telemetry / device info + ack;
# engineer → + SSH access and device editing; manager → everything.
# "user" is kept as a viewer alias for backward compatibility with existing data.
# NOTE: the seed only GRANTS (never revokes), so removing a permission here does
# not strip it from an existing database — use the admin panel for that.
DEFAULT_ROLE_PERMISSIONS: dict[str, list[str]] = {
    "viewer": [VIEW],
    "user": [VIEW],
    "operator": [VIEW, SNMP],
    "engineer": [VIEW, SNMP, SSH, EDIT_DEVICE, EDIT_CONFIG],
    "manager": ALL_PERMISSIONS,
}
