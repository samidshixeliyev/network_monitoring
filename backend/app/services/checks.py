"""Multi-condition service checks (beyond ICMP): TCP connect + HTTP GET.

Used to catch "the device pings but the service is dead". Pure stdlib (asyncio
for TCP, urllib in a thread for HTTP) — no extra dependencies.
"""
import asyncio
import urllib.request


async def tcp_check(host: str, port: int, timeout: float = 3.0) -> tuple[bool, str]:
    """True if a TCP connection to host:port succeeds within timeout."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True, f"TCP {port} open"
    except (asyncio.TimeoutError, OSError) as exc:
        return False, f"TCP {port}: {type(exc).__name__}"


def _http_get(url: str, expect: int, timeout: float) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "netmon-check/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            code = r.status
        ok = code == expect
        return ok, f"HTTP {code} (expect {expect})"
    except urllib.error.HTTPError as exc:
        return exc.code == expect, f"HTTP {exc.code} (expect {expect})"
    except Exception as exc:  # noqa: BLE001
        return False, f"HTTP: {type(exc).__name__}"


async def http_check(url: str, expect: int = 200, timeout: float = 5.0) -> tuple[bool, str]:
    """True if GET url returns the expected status code."""
    return await asyncio.get_running_loop().run_in_executor(
        None, _http_get, url, expect, timeout
    )
