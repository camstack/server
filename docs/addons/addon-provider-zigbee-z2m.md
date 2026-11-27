---
title: addon-provider-zigbee-z2m — package notes
covers:
  - packages/addon-provider-zigbee-z2m/**
---

# addon-provider-zigbee-z2m — package notes

Connects to an EXISTING Zigbee2MQTT server and lets CamStack see and operate its devices. It is
independent of `provider-mqtt-ha`: it does not read the MQTT broker, migrates nothing from it and
does not look for duplicates (an operator removes devices an earlier import left behind).

## Connection

One integration instance per server: `host`, `port` (default 8080), `tls` and an optional `token`
(the frontend `auth_token`, a `password` field kept in the keychain, never logged: it rides in the
socket URL's query string and logs name only `host:port`). The transport is the frontend WebSocket
`ws[s]://host:port/api`; every frame is `{ topic, payload }` and is Zod-parsed at the boundary.

- A dropped socket reconnects with a doubling, capped backoff. A close with code 4401 means the
  token was refused: the instance reports `auth-rejected` and does not retry until it is edited.
- Connection state reaches the operator through the standard session alert
  (`IntegrationSessionReporter`) and through each device's `device-status`.
- A table or state frame that does not parse changes nothing (D49).

## Devices

One CamStack device per Zigbee device, keyed by `ieee_address`; the `friendly_name` is the label and
can change: a command goes to `<friendly_name>/set` resolved at the moment of the call. The Gateway
(the server itself) is adopted as a sibling, never as the parent.

The mapping is by standard expose name and unit, never by model:

| Exposes | Device type | Caps |
| --- | --- | --- |
| `climate` | Climate | `climate-control` |
| `light` | Light | `switch`, `brightness`, `color` (colour temperature) |
| `cover` | Cover | `cover` |
| `lock` | Lock | `lock-control` |
| `switch` | Switch | `switch` |
| readings, binary alarms | Sensor | temperature, humidity, pressure, ambient light, air quality, contact, motion, flood, smoke, vibration, tamper |
| `action` enum | EventEmitter | `event-emitter` |

Power, energy, voltage and current fold into `power-meter`; CO2, VOC, PM2.5, PM10 and AQI into
`air-quality-sensor`; `battery` is the `battery` cap. A device with several readings is one device.
Diagnostic and config exposes (link quality, …) feed nothing, and `fan` is not mapped yet.
State is pushed by the server; nothing is polled (D224). The first state a device sends after the
socket opens is the server's replay, so its `action` is never read as a button press.

The role of an adopted device comes from its primary function when that function names one.
