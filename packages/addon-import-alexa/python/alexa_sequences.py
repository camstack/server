"""Speak and announce payloads, the shape alexapy forwards to Amazon.

Built here so the protocol tests can see them without importing alexapy
and without contacting Amazon.
"""

from __future__ import annotations

from typing import TypedDict


class EchoTarget(TypedDict):
    id: str
    deviceType: str
    customerId: str


def _speak_node(target: EchoTarget, text: str, locale: str) -> dict:
    return {
        "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
        "type": "Alexa.Speak",
        "operationPayload": {
            "deviceType": target["deviceType"],
            "deviceSerialNumber": target["id"],
            "locale": locale,
            "customerId": target["customerId"],
            "textToSpeak": text,
        },
    }


def build_speak_sequence(target: EchoTarget, text: str, locale: str) -> dict:
    """Speech at the Echo's current volume. Speak honours Do Not Disturb on the device."""
    speak = _speak_node(target, text, locale)
    return {
        "@type": "com.amazon.alexa.behaviors.model.Sequence",
        "startNode": speak,
    }


def build_announcement(target: EchoTarget, text: str, locale: str) -> dict:
    """Chime plus speech. The caller skips a device that is in Do Not Disturb."""
    return {
        "customerId": target["customerId"],
        "expireAfter": "PT5S",
        "content": [
            {
                "locale": locale,
                "display": {"title": "CamStack", "body": text},
                "speak": {"type": "text", "value": text},
            }
        ],
        "target": {
            "customerId": target["customerId"],
            "devices": [
                {"deviceSerialNumber": target["id"], "deviceTypeId": target["deviceType"]}
            ],
        },
    }


def build_volume_node(target: EchoTarget, level: int, locale: str) -> dict:
    """The behaviour node that sets an Echo's volume. `level` is a whole percent, 0 to 100."""
    return {
        "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
        "type": "Alexa.DeviceControls.Volume",
        "operationPayload": {
            "deviceType": target["deviceType"],
            "deviceSerialNumber": target["id"],
            "locale": locale,
            "customerId": target["customerId"],
            "value": level,
        },
    }
