import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import selectinload

from app.core.permissions import SSH
from app.core.security import decode_token
from app.db.session import AsyncSessionLocal
from app.models import Device, Role, User
from app.services.audit import record_audit_safe
from app.services.ws_manager import ws_manager

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)


@router.websocket("/ws/status")
async def ws_status(websocket: WebSocket, token: str = Query(...)) -> None:
    try:
        decode_token(token)
    except ValueError:
        await websocket.close(code=4001)
        return

    await ws_manager.connect(websocket)
    try:
        while True:
            # Server-push only; we just keep the connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket)


async def _auth_ssh(token: str) -> User | None:
    """Decode the WS token and load the user; only users with the `ssh`
    permission may open a device shell (regular viewers cannot)."""
    try:
        payload = decode_token(token)
    except ValueError:
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    async with AsyncSessionLocal() as session:
        user = await session.get(
            User,
            uuid.UUID(str(sub)),
            options=[selectinload(User.role).selectinload(Role.permissions)],
        )
        if user is None or not user.is_active or user.role is None:
            return None
        if SSH not in {p.name for p in user.role.permissions}:
            return None
    return user


@router.websocket("/ws/devices/{device_id}/shell")
async def ws_device_shell(
    websocket: WebSocket,
    device_id: uuid.UUID,
    token: str = Query(...),
    cols: int = Query(80),
    rows: int = Query(24),
) -> None:
    """Bridge a browser terminal (xterm.js) to an interactive SSH shell on the
    device. Client→server messages are JSON {type:'data'|'resize', ...};
    server→client frames are raw terminal text written straight to xterm.

    Requires the `ssh` permission (2FA hardening comes later)."""
    user = await _auth_ssh(token)
    if user is None:
        await websocket.close(code=4003)
        return

    async with AsyncSessionLocal() as session:
        device = await session.get(Device, device_id)

    if device is None:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    # Audit the session open (who connected to which device).
    await record_audit_safe(
        user, "ssh.open", target_type="device", target_id=str(device_id),
        detail=str(device.ip_address),
    )

    if not device.ssh_enabled or not device.ssh_username:
        await websocket.send_text("\r\n\x1b[31mSSH is not configured for this device.\x1b[0m\r\n")
        await websocket.close()
        return

    import asyncssh

    host = str(device.ip_address)
    port = device.ssh_port or 22
    username = device.ssh_username
    password = device.ssh_password or ""

    # Per-session password: the browser sends {type:'auth', password} as its very
    # first frame. It's typed by the operator for THIS connection only and is
    # never persisted — so a device can be reached over the web terminal without
    # its SSH password living in the database. When the field is left blank we
    # fall back to a stored password (if any), keeping older devices working.
    try:
        first_raw = await asyncio.wait_for(websocket.receive_text(), timeout=180)
        first = json.loads(first_raw)
        if isinstance(first, dict) and first.get("type") == "auth" and first.get("password"):
            password = first["password"]
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
        pass

    await websocket.send_text(
        f"\x1b[36mConnecting to {username}@{host}:{port} …\x1b[0m\r\n"
    )

    try:
        conn = await asyncssh.connect(
            host, port=port, username=username, password=password,
            known_hosts=None, connect_timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        await websocket.send_text(f"\r\n\x1b[31mSSH connection failed: {exc}\x1b[0m\r\n")
        await websocket.close()
        return

    try:
        async with conn:
            proc = await conn.create_process(
                term_type="xterm-256color",
                term_size=(cols, rows),
                encoding="utf-8",
                errors="replace",
            )

            async def ws_to_ssh() -> None:
                while True:
                    raw = await websocket.receive_text()
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        proc.stdin.write(raw)
                        continue
                    if msg.get("type") == "data":
                        proc.stdin.write(msg.get("data", ""))
                    elif msg.get("type") == "resize":
                        try:
                            proc.change_terminal_size(int(msg["cols"]), int(msg["rows"]))
                        except Exception:  # noqa: BLE001
                            pass

            async def ssh_to_ws() -> None:
                while not proc.stdout.at_eof():
                    data = await proc.stdout.read(65536)
                    if not data:
                        break
                    await websocket.send_text(data)

            t_in = asyncio.create_task(ws_to_ssh())
            t_out = asyncio.create_task(ssh_to_ws())
            done, pending = await asyncio.wait(
                {t_in, t_out}, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()
            # Retrieve results so a WebSocketDisconnect/EOF isn't logged as an
            # "exception was never retrieved" warning.
            for t in done:
                try:
                    t.result()
                except (WebSocketDisconnect, Exception):  # noqa: BLE001
                    pass
            await asyncio.gather(*pending, return_exceptions=True)
            proc.close()
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.info("shell bridge error for %s: %s", device_id, exc)
        try:
            await websocket.send_text(f"\r\n\x1b[31mSession error: {exc}\x1b[0m\r\n")
        except Exception:  # noqa: BLE001
            pass
    finally:
        await record_audit_safe(
            user, "ssh.close", target_type="device", target_id=str(device_id),
        )
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
