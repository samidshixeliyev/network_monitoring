"""Permission catalogue + default role→permission mapping.

Permissions are the authoritative gate enforced on the backend (see
`require_permission` in app/api/deps.py). Roles are just named bundles of
permissions; the frontend only hides controls based on the same set.
"""

# ── Permission names ─────────────────────────────────────────────────────────
VIEW = "view"                 # see devices / map / status
SSH = "ssh"                   # open an SSH / web-shell session to a device
ACK = "ack"                   # acknowledge an active alarm
MUTE = "mute"                 # mute / set maintenance on a device
EDIT_DEVICE = "edit_device"   # create / update / delete devices
EDIT_CONFIG = "edit_config"   # change monitoring config (e.g. simulate status)
MANAGE_USERS = "manage_users"  # manage users/roles, view the audit trail

ALL_PERMISSIONS = [VIEW, SSH, ACK, MUTE, EDIT_DEVICE, EDIT_CONFIG, MANAGE_USERS]

# ── Default roles → permissions ──────────────────────────────────────────────
# "user" is kept as a viewer alias for backward compatibility with existing data.
DEFAULT_ROLE_PERMISSIONS: dict[str, list[str]] = {
    "viewer": [VIEW],
    "user": [VIEW],
    "operator": [VIEW, SSH, ACK, MUTE],
    "engineer": [VIEW, SSH, ACK, MUTE, EDIT_DEVICE, EDIT_CONFIG],
    "manager": ALL_PERMISSIONS,
}
