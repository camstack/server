"""speak/announce must call alexapy the way alexapy 1.29.20 defines it.

In that release send_sequence / send_announcement are INSTANCE methods that read
`self._device`; calling them on the class with a login first (the old code) fails
with "'AlexaLogin' object has no attribute '_device'". The fake below mirrors the
real signatures, so the wrong call shape raises the same way.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alexa_gateway import AlexaPyGateway
from alexa_sequences import build_announcement, build_speak_sequence

TARGET = {"id": "G090XX", "deviceType": "A3S5BH2HU6VAYF", "customerId": "A1CUST"}


def make_fake_api(posted: list):
    class FakeAlexaAPI:
        def __init__(self, device, login):
            self._device = device
            self._login = login

        async def run_behavior(self, node_data, queue_delay: float = 1.5) -> None:
            posted.append((node_data, queue_delay))

        # Real signatures: the first positional parameter is `self`, then message/sequence.
        async def send_sequence(self, sequence, customer_id=None, queue_delay=1.5, extra=None, **kwargs):
            self._device._device_type  # raises AttributeError without a device, as the real one

        async def send_announcement(self, message, method="all", title="Announcement",
                                    customer_id=None, targets=None, queue_delay=1.5, extra=None):
            self._device._locale

    return FakeAlexaAPI


class SendTests(unittest.TestCase):
    def _gateway(self, posted):
        import types

        package = types.ModuleType("alexapy")
        package.AlexaLogin = object
        package.AlexaAPI = make_fake_api(posted)
        sys.modules["alexapy"] = package
        sys.modules["alexapy.alexalogin"] = types.ModuleType("alexapy.alexalogin")
        gateway = AlexaPyGateway()
        gateway._login = object()
        return gateway

    def tearDown(self):
        sys.modules.pop("alexapy", None)
        sys.modules.pop("alexapy.alexalogin", None)

    def test_speak_posts_the_sequence_start_node_immediately(self):
        posted: list = []
        sequence = build_speak_sequence(TARGET, "hello", 30, "it-IT")
        asyncio.run(self._gateway(posted).speak(sequence, "A1CUST"))
        self.assertEqual(posted, [(sequence["startNode"], 0)])

    def test_announce_posts_an_announcement_node_with_target_and_content(self):
        posted: list = []
        announcement = build_announcement(TARGET, "hello", "it-IT")
        asyncio.run(self._gateway(posted).announce(announcement, "A1CUST"))
        self.assertEqual(len(posted), 1)
        node, delay = posted[0]
        self.assertEqual(delay, 0)
        self.assertEqual(node["type"], "AlexaAnnouncement")
        payload = node["operationPayload"]
        self.assertEqual(payload["target"], announcement["target"])
        self.assertEqual(payload["content"], announcement["content"])
        self.assertEqual(payload["customerId"], "A1CUST")
        self.assertEqual(payload["skillId"], "amzn1.ask.1p.routines.messaging")


if __name__ == "__main__":
    unittest.main()
