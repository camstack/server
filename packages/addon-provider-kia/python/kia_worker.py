#!/usr/bin/env python3
"""Long-lived Kia worker: one process per Kia account, line-delimited JSON on stdin/stdout.

Runs the MIT `hyundai-kia-connect-api` library (the one Home Assistant's kia_uvo integration
uses). The protocol and the session logic are in `kia_protocol.py`; this file wires the real
library into it. Logs go to stderr so stdout stays a protocol; the credentials are never
logged or echoed, and an unexpected failure is answered by its class name only (a library
message may carry a URL or a token).
"""
from __future__ import annotations

import json
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))

from kia_protocol import ACTION_TIMEOUT_S, Session, WorkerError  # noqa: E402

REGION_IDS = {"europe": 1, "europe-cci": 9}
BRAND_IDS = {"kia": 1, "hyundai": 2, "genesis": 3}


class KiaLibrary:
    """The adapter `Session` drives: it maps the library's failures onto typed codes."""

    def __init__(self, credentials: Dict[str, str]) -> None:
        from hyundai_kia_connect_api import VehicleManager

        self._manager = VehicleManager(
            region=REGION_IDS[credentials["region"]],
            brand=BRAND_IDS[credentials["brand"]],
            username=credentials["username"],
            password=credentials["password"],
            pin=credentials["pin"],
        )

    @staticmethod
    def _fail(err: Exception) -> WorkerError:
        """One typed code per kind of failure; never the library's own message."""
        from hyundai_kia_connect_api import exceptions as kia

        if isinstance(err, WorkerError):
            return err
        if isinstance(err, kia.AuthenticationOTPRequired):
            return WorkerError("otp-required", "Kia asks for a one-time code, which this integration cannot enter")
        if isinstance(err, kia.AuthenticationError):
            return WorkerError("auth", "Kia refused the account, the password or the PIN")
        if isinstance(err, kia.RateLimitingError):
            return WorkerError("rate-limited", "Kia says the daily request allowance is spent")
        if isinstance(err, kia.UnsupportedControlError):
            return WorkerError("unsupported", "this car does not support that command")
        if isinstance(err, (kia.RequestTimeoutError, kia.ServiceTemporaryUnavailable)):
            return WorkerError("unreachable", "the Kia cloud did not answer")
        try:
            import requests

            if isinstance(err, requests.exceptions.RequestException):
                return WorkerError("unreachable", "the Kia cloud could not be reached")
        except ImportError:  # pragma: no cover - requests is a dependency of the library
            pass
        return WorkerError("api", type(err).__name__)

    def login(self) -> List[Any]:
        try:
            result = self._manager.login()
        except Exception as err:  # noqa: BLE001 - mapped to a typed code
            raise self._fail(err) from None
        if result is True:
            return list(self._manager.vehicles.values())
        if result is False:
            raise WorkerError("auth", "Kia refused the account, the password or the PIN")
        raise WorkerError("otp-required", "Kia asks for a one-time code, which this integration cannot enter")

    def read_cached(self) -> None:
        try:
            self._manager.check_and_refresh_token()
            self._manager.update_all_vehicles_with_cached_state()
        except Exception as err:  # noqa: BLE001
            raise self._fail(err) from None

    def force_refresh(self, vehicle_id: str) -> None:
        try:
            self._manager.check_and_refresh_token()
            self._manager.force_refresh_vehicle_state(vehicle_id)
            self._manager.update_vehicle_with_cached_state(vehicle_id)
        except Exception as err:  # noqa: BLE001
            raise self._fail(err) from None

    def act(self, vehicle_id: str, command: str, options: Dict[str, Any]) -> str:
        """Send one command; wait a short, bounded time for the car's answer; read the car once."""
        from hyundai_kia_connect_api import ClimateRequestOptions
        from hyundai_kia_connect_api.const import ORDER_STATUS

        manager = self._manager
        try:
            manager.check_and_refresh_token()
            if command == "lock":
                action_id = manager.lock(vehicle_id)
            elif command == "unlock":
                action_id = manager.unlock(vehicle_id)
            elif command == "climate-start":
                action_id = manager.start_climate(
                    vehicle_id,
                    ClimateRequestOptions(
                        set_temp=options["temperature"],
                        duration=options["durationMinutes"],
                        climate=True,
                        defrost=False,
                        heating=0,
                    ),
                )
            else:
                action_id = manager.stop_climate(vehicle_id)
            outcome = "unknown"
            if isinstance(action_id, str) and action_id != "":
                try:
                    status = manager.check_action_status(
                        vehicle_id, action_id, synchronous=True, timeout=ACTION_TIMEOUT_S
                    )
                    outcome = status.value.lower() if isinstance(status, ORDER_STATUS) else "unknown"
                except Exception:  # noqa: BLE001 - some regions have no action record; the read below tells
                    outcome = "unknown"
            if outcome in ("failed", "timeout"):
                raise WorkerError(
                    "rejected" if outcome == "failed" else "vehicle-unreachable",
                    "the car refused the command" if outcome == "failed" else "the car did not answer",
                )
            manager.update_vehicle_with_cached_state(vehicle_id)
            return outcome
        except Exception as err:  # noqa: BLE001
            raise self._fail(err) from None

    def stop(self) -> None:
        return None


class Emitter:
    """Every line to stdout goes through one lock, so answers never interleave."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def __call__(self, line: Dict[str, Any]) -> None:
        with self._lock:
            sys.stdout.write(json.dumps(line) + "\n")
            sys.stdout.flush()


def answer(session: Session, emit: Emitter, message: Dict[str, Any]) -> None:
    request_id = str(message.get("id", ""))
    try:
        emit({"id": request_id, "ok": True, "result": session.handle(message)})
    except WorkerError as err:
        emit({"id": request_id, "ok": False, "code": err.code, "error": str(err)})
    except Exception as err:  # noqa: BLE001 - one bad request must not kill the account's worker
        emit({"id": request_id, "ok": False, "code": "api", "error": type(err).__name__})


def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    emit = Emitter()
    session = Session(KiaLibrary)
    # One request at a time: the library shares one token and one HTTP session, and every call
    # spends the account's daily allowance, so nothing here is worth running concurrently.
    requests_pool = ThreadPoolExecutor(max_workers=1)
    for raw in sys.stdin:
        text = raw.strip()
        if text == "":
            continue
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            emit({"id": "", "ok": False, "code": "bad-request", "error": "not JSON"})
            continue
        if not isinstance(message, dict):
            emit({"id": "", "ok": False, "code": "bad-request", "error": "not an object"})
            continue
        requests_pool.submit(answer, session, emit, message)
    try:
        session.handle({"op": "close"})
    finally:
        requests_pool.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
