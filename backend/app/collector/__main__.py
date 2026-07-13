"""
Standalone collector process.

This is the SINGLE source of truth for probing (ICMP + SSH). It only probes and
publishes status changes to Redis — it never serves HTTP/WebSocket traffic. The
API/WS gateways subscribe to Redis and serve users, so probing is fully
decoupled from serving (and the API can scale to multiple stateless gateways).

Run:  python -m app.collector
"""
import asyncio
import logging

from app.core.logging import setup_logging

setup_logging()
logger = logging.getLogger(__name__)


async def main() -> None:
    from app.services.alerts import alert_loop
    from app.services.cache_warm import warm_cache_if_cold
    from app.services.discovery import discovery_loop
    from app.services.ping_scheduler import ping_loop
    from app.services.snmp_collector import snmp_poll_loop
    from app.services.snmp_trap_listener import snmp_trap_loop
    from app.services.ssh_collector import ssh_poll_loop
    from app.services.state_cache import close_redis
    from app.services.syslog_listener import syslog_loop

    logger.info("collector process starting (ICMP + SSH + SNMP + traps + syslog + discovery + alerts)")
    await warm_cache_if_cold()

    tasks = [
        asyncio.create_task(ping_loop()),
        asyncio.create_task(ssh_poll_loop()),
        asyncio.create_task(snmp_poll_loop()),
        asyncio.create_task(snmp_trap_loop()),
        asyncio.create_task(alert_loop()),
        asyncio.create_task(syslog_loop()),
        asyncio.create_task(discovery_loop()),
    ]
    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        pass
    finally:
        for task in tasks:
            task.cancel()
        await close_redis()
        logger.info("collector stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
