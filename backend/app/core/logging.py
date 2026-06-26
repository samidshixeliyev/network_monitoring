import logging
import sys


def setup_logging() -> None:
    logging.basicConfig(
        stream=sys.stdout,
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    # asyncssh logs every command/channel at INFO — too chatty for the SSH
    # collector polling on an interval. Keep only warnings/errors.
    logging.getLogger("asyncssh").setLevel(logging.WARNING)
