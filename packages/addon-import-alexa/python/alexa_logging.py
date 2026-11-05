"""Worker logging. stderr only (stdout is the protocol); the hub scrubs and forwards it.

alexapy retries a 429 or a connection error on its own and says so only through the
`backoff` library's INFO lines. Those are the one alexapy record let through: its other
records carry URLs and request arguments, so every other alexapy record stays out.
"""

from __future__ import annotations

import logging
import sys

# `backoff` formats these as "Backing off _request(...) for 1.2s (Error)": the call's
# arguments are elided, so a cookie or token cannot reach the line.
BACKOFF_PREFIXES = ("Backing off ", "Giving up ")


class AlexapyBackoffOnly(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not record.name.startswith("alexapy"):
            return record.levelno >= logging.WARNING
        return record.getMessage().startswith(BACKOFF_PREFIXES)


def configure_logging(stream=None) -> logging.Handler:
    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    handler.addFilter(AlexapyBackoffOnly())
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.WARNING)
    logging.getLogger("alexapy").setLevel(logging.INFO)
    return handler
