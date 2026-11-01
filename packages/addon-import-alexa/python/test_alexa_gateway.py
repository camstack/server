"""The gateway signs in as a broker's account, with alexapy replaced by a fake module.

These tests must not contact Amazon. They check what the gateway hands to alexapy
(the broker's token, the registered app name, where the cookie jar lives) and what
it does when Amazon refuses.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alexa_gateway import AlexaPyGateway, bare_domain, normalize_device, session_output


def install_fake_alexapy(
    exchange_ok: bool = True, stored_cookies: dict | None = None, file_readback: bool = True
):
    """Put a fake `alexapy` (and `alexapy.alexalogin`) in sys.modules; return the call log."""
    calls: dict = {"exchange_app_names": [], "logins": [], "saved": 0}
    module = types.ModuleType("alexapy.alexalogin")
    module.APP_NAME = "Alexa Media Player"

    class FakeLogin:
        def __init__(self, url, email, password, outputpath, debug=False, oauth=None, **_):
            calls["url"] = url
            calls["email"] = email
            calls["password"] = password
            calls["oauth"] = dict(oauth or {})
            calls["jar_path"] = outputpath(".storage/alexa_media.x.pickle")
            self.status = {"login_successful": True}
            self.refresh_token = (oauth or {}).get("refresh_token")
            self._session = types.SimpleNamespace(cookie_jar=[])

        async def exchange_token_for_cookies(self):
            calls["exchange_app_names"].append(module.APP_NAME)
            calls["exchanged_token"] = self.refresh_token
            if exchange_ok:
                self._session.cookie_jar.append(types.SimpleNamespace(key="session-id", value="1"))
            return exchange_ok

        async def save_cookiefile(self):
            calls["saved"] += 1
            Path(calls["jar_path"]).write_bytes(b"jar")

        async def load_cookie(self):
            if stored_cookies:
                return stored_cookies
            return {"session-id": "1"} if (exchange_ok and file_readback) else {}

        async def login(self, cookies=None, data=None):
            calls["logins"].append(cookies)

    package = types.ModuleType("alexapy")
    package.AlexaLogin = FakeLogin
    package.AlexaAPI = object
    package.alexalogin = module
    sys.modules["alexapy"] = package
    sys.modules["alexapy.alexalogin"] = module
    return calls, module


def remove_fake_alexapy() -> None:
    sys.modules.pop("alexapy", None)
    sys.modules.pop("alexapy.alexalogin", None)


def run(coro):
    return asyncio.run(coro)


async def _accept_without_cookies(self):
    return True


class GatewayTests(unittest.TestCase):
    def tearDown(self) -> None:
        remove_fake_alexapy()

    def test_exchanges_the_brokers_token_under_its_registered_name_and_restores_the_default(self) -> None:
        calls, module = install_fake_alexapy()
        with tempfile.TemporaryDirectory() as directory:
            session_path = str(Path(directory) / "session")
            result = run(
                AlexaPyGateway().login_broker(
                    "alexa_001", "broker-refresh-token", "Registered App", "amazon.it", "EU", session_path
                )
            )
            self.assertEqual(result, {"status": "ok"})
            self.assertEqual(Path(session_path).read_bytes(), b"jar")
        self.assertEqual(calls["exchanged_token"], "broker-refresh-token")
        self.assertEqual(calls["exchange_app_names"], ["Registered App"])
        self.assertEqual(module.APP_NAME, "Alexa Media Player")
        self.assertEqual(calls["url"], "amazon.it")
        self.assertEqual(calls["password"], "")
        self.assertEqual(calls["email"], "alexa_001")
        self.assertNotIn("@", calls["email"])
        self.assertEqual(len(calls["logins"]), 1)

    def test_an_account_two_brokers_share_is_still_two_labels(self) -> None:
        first, _ = install_fake_alexapy()
        with tempfile.TemporaryDirectory() as directory:
            run(AlexaPyGateway().login_broker("alexa_001", "t1", "", "amazon.it", "EU", str(Path(directory) / "s1")))
            second, _ = install_fake_alexapy()
            run(AlexaPyGateway().login_broker("alexa_002", "t2", "", "amazon.com", "NA", str(Path(directory) / "s2")))
        self.assertEqual(first["email"], "alexa_001")
        self.assertEqual(second["email"], "alexa_002")
        self.assertEqual(second["exchanged_token"], "t2")

    def test_a_token_amazon_refuses_is_a_named_failure_and_never_logs_in(self) -> None:
        calls, module = install_fake_alexapy(exchange_ok=False)
        with tempfile.TemporaryDirectory() as directory:
            result = run(
                AlexaPyGateway().login_broker("alexa_001", "bad", "X", "amazon.com", "NA", str(Path(directory) / "s"))
            )
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("bad", result["error"])
        self.assertEqual(calls["logins"], [])
        self.assertEqual(module.APP_NAME, "Alexa Media Player")

    def test_cookies_from_the_exchange_are_used_when_the_file_reads_back_empty(self) -> None:
        calls, _ = install_fake_alexapy(file_readback=False)
        with tempfile.TemporaryDirectory() as directory:
            result = run(
                AlexaPyGateway().login_broker("alexa_002", "t", "", "amazon.com", "NA", str(Path(directory) / "s"))
            )
        self.assertEqual(result, {"status": "ok"})
        self.assertEqual(calls["logins"], [{"session-id": "1"}])

    def test_an_exchange_that_yields_no_cookies_names_its_step(self) -> None:
        calls, _ = install_fake_alexapy(file_readback=False)
        sys.modules["alexapy"].AlexaLogin.exchange_token_for_cookies = _accept_without_cookies
        with tempfile.TemporaryDirectory() as directory:
            result = run(
                AlexaPyGateway().login_broker("alexa_002", "t", "", "amazon.com", "NA", str(Path(directory) / "s"))
            )
        self.assertEqual(result["status"], "failed")
        self.assertIn("cookies", result["error"])
        self.assertIn("exchange was accepted", result["error"])
        self.assertEqual(calls["logins"], [])

    def test_with_no_token_only_the_stored_jar_is_tried(self) -> None:
        calls, _ = install_fake_alexapy(stored_cookies={"session-id": "1"})
        with tempfile.TemporaryDirectory() as directory:
            result = run(
                AlexaPyGateway().login_broker("alexa_001", "", "", "amazon.it", "EU", str(Path(directory) / "s"))
            )
        self.assertEqual(result, {"status": "ok"})
        self.assertEqual(calls["exchange_app_names"], [])

    def test_helpers(self) -> None:
        self.assertEqual(bare_domain("https://alexa.amazon.co.uk/"), "amazon.co.uk")
        self.assertEqual(bare_domain("www.amazon.de"), "amazon.de")
        self.assertEqual(bare_domain(""), "amazon.com")
        output = session_output("/tmp/x/session")
        self.assertEqual(output(".storage/alexa_media.a.pickle"), "/tmp/x/session")
        self.assertEqual(output("alexa_media.a.pickle"), "/tmp/x/alexa_media.a.pickle")

    def test_a_room_is_passed_on_only_when_amazon_names_one(self) -> None:
        with_room = normalize_device({"serialNumber": "s", "accountName": "Kitchen", "roomName": "Living room"})
        without = normalize_device({"serialNumber": "s", "accountName": "Kitchen"})
        self.assertEqual(with_room["room"], "Living room")
        self.assertNotIn("room", without)


if __name__ == "__main__":
    unittest.main()
