"""Protocol handlers with alexapy mocked. These tests must not contact Amazon."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alexa_protocol import Session
from alexa_sequences import build_announcement, build_speak_sequence


class FakeGateway:
    def __init__(self) -> None:
        self.refresh_token = ""
        self.region = "EU"
        self.login_status = "ok"
        self.devices_payload = {
            "devices": [
                {
                    "id": "echo-1",
                    "name": "Kitchen",
                    "family": "ECHO",
                    "online": True,
                    "kind": "device",
                    "dnd": False,
                    "deviceType": "A3S5BH2HU6VAYF",
                }
            ]
        }
        self.spoken: list[dict] = []
        self.announced: list[dict] = []

    async def login_broker(
        self,
        label: str,
        refresh_token: str,
        device_app_name: str,
        domain: str,
        region: str,
        session_path: str,
    ) -> dict:
        self.refresh_token = refresh_token
        self.label = label
        self.device_app_name = device_app_name
        self.domain = domain
        self.region = region
        self.session_path = session_path
        result = {"status": self.login_status}
        if self.login_status == "failed":
            result["error"] = "login failed"
        return result

    async def devices(self) -> dict:
        return self.devices_payload

    async def speak(self, sequence: dict, customer_id: str) -> None:
        self.spoken.append({"sequence": sequence, "customerId": customer_id})

    async def announce(self, announcement: dict, customer_id: str) -> None:
        self.announced.append(announcement)

    async def session_status(self) -> dict:
        return {"loggedIn": True, "ageSec": 12, "lastSuccessAt": 100}

    def target_for(self, serial: str):
        if serial != "echo-1":
            return None
        return {"id": "echo-1", "deviceType": "A3S5BH2HU6VAYF", "customerId": "cust"}


def run(session: Session, message: dict) -> dict:
    return asyncio.run(session.handle(message))


class ProtocolTests(unittest.TestCase):
    def test_login_reads_refresh_token_from_file_not_from_json(self) -> None:
        gateway = FakeGateway()
        session = Session(gateway)
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / "refresh-token"
            token_path.write_text("super-secret-token\n", encoding="utf-8")
            session_path = Path(directory) / "session"
            session_path.write_bytes(b"")
            body = {
                "id": "1",
                "op": "login_broker",
                "label": "alexa_001",
                "refreshTokenPath": str(token_path),
                "deviceAppName": "Registered App",
                "domain": "amazon.it",
                "sessionPath": str(session_path),
                "region": "EU",
            }
            encoded = json.dumps(body)
            self.assertNotIn("super-secret-token", encoded)
            result = run(session, body)
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["status"], "ok")
        self.assertEqual(gateway.refresh_token, "super-secret-token")
        self.assertEqual(gateway.label, "alexa_001")
        self.assertEqual(gateway.device_app_name, "Registered App")
        self.assertEqual(gateway.domain, "amazon.it")

    def test_login_without_a_token_path_passes_an_empty_token(self) -> None:
        gateway = FakeGateway()
        session = Session(gateway)
        result = run(
            session,
            {"id": "1", "op": "login_broker", "label": "alexa_001", "refreshTokenPath": ""},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(gateway.refresh_token, "")

    def test_the_old_password_login_is_gone(self) -> None:
        session = Session(FakeGateway())
        for op in ("login_start", "login_otp"):
            result = run(session, {"id": "1", "op": op})
            self.assertFalse(result["ok"])
            self.assertIn("unknown op", result["error"])

    def test_devices_after_login(self) -> None:
        session = Session(FakeGateway())
        devices = run(session, {"id": "3", "op": "devices"})
        self.assertEqual(devices["result"]["devices"][0]["id"], "echo-1")
        self.assertEqual(devices["result"]["devices"][0]["family"], "ECHO")
        self.assertTrue(devices["result"]["devices"][0]["online"])

    def test_speak_and_announce_use_sequence_builders(self) -> None:
        gateway = FakeGateway()
        session = Session(gateway)
        spoken = run(
            session,
            {"id": "4", "op": "speak", "targets": ["echo-1"], "text": "Person at the door", "volume": 30},
        )
        self.assertTrue(spoken["result"]["outcomes"][0]["ok"])
        sequence = gateway.spoken[0]["sequence"]
        self.assertEqual(sequence["startNode"]["type"], "Alexa.DeviceControls.Volume")
        self.assertEqual(sequence["startNode"]["next"]["type"], "Alexa.Speak")
        self.assertEqual(
            sequence["startNode"]["next"]["operationPayload"]["textToSpeak"],
            "Person at the door",
        )
        announced = run(
            session,
            {"id": "5", "op": "announce", "targets": ["echo-1"], "text": "Hello", "volume": 30},
        )
        self.assertTrue(announced["result"]["outcomes"][0]["ok"])
        self.assertEqual(gateway.announced[0]["content"][0]["speak"]["value"], "Hello")

    def test_unknown_op_and_bad_json_shape(self) -> None:
        session = Session(FakeGateway())
        unknown = run(session, {"id": "9", "op": "nope"})
        self.assertFalse(unknown["ok"])
        self.assertIn("unknown op", unknown["error"])

    def test_session_status(self) -> None:
        session = Session(FakeGateway())
        status = run(session, {"id": "6", "op": "session_status"})
        self.assertEqual(status["result"]["ageSec"], 12)
        self.assertTrue(status["result"]["loggedIn"])

    def test_sequence_helpers_do_not_embed_markup(self) -> None:
        target = {"id": "echo-1", "deviceType": "T", "customerId": "c"}
        sequence = build_speak_sequence(target, "plain", 10, "en-GB")
        self.assertNotIn("<", json.dumps(sequence))
        announcement = build_announcement(target, "plain", "en-GB")
        self.assertEqual(announcement["content"][0]["speak"]["type"], "text")


if __name__ == "__main__":
    unittest.main()
