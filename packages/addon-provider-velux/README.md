# Velux Provider

Velux KLF-200 device-provider addon for CamStack. The gateway's windows, roller shutters, blinds and
awnings become `cover` devices (positional, no tilt), and a roof window's built-in rain sensor becomes a
`flood` sensor. State is pushed by the gateway, not polled.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-velux` on npm.

## What it provides

- **Velux** (`provider-velux`): Adopt a Velux KLF-200 gateway over the local network and its windows / roller shutters (positional cover). Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Gateway: Name
- Connection: Gateway host / IP, Password

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## Pairing the gateway

1. **Free a connection slot first.** The KLF-200 accepts only a few simultaneous API sessions (see below). If
   Home Assistant's VELUX integration is connected to the same gateway, that is fine for one session each, but
   if anything else (a phone app session, ioBroker, a second hub) is also connected, close it before adding the
   gateway here.
2. In CamStack: Integrations, add **Velux**. Pick the gateway found on your network (a KLF-200 announces itself
   as `VELUX_KLF_…`) or type its **host / IP**, then enter the gateway **password**. **Test** checks the login
   and closes its session at once.
3. The password is the **WiFi / web password printed on the back of the unit**, not the WiFi network password of
   your router. It is stored in the CamStack keychain; it is never put in an environment variable, a command
   line or a log line.
4. Open the integration's discovery. The KLF-200 appears as one **Gateway** device (reboot, firmware, link to its
   web page); every window, shutter, blind and awning appears as a cover. A window with a rain sensor appears as
   one container holding the cover and the rain sensor. Adopt the ones you want. Firmware update is not offered:
   the gateway API cannot do it.

You do **not** have to disable Home Assistant's integration: one session from each of two clients fits inside the
gateway's limit. Do disable it (or reload it) if the gateway starts refusing logins, and see the limit below.

## The connection limit

The KLF-200 API specification (v3.18) allows **two simultaneous API sessions** over its TLS socket on port
**51200**; a third login is refused until one closes. Separately the gateway **closes a session that is idle for
15 minutes**.

What this addon does about it:

- It opens **exactly one** socket per gateway and never a second one (not for commands, not for the rain
  readings). Command, notification and rain traffic share that one session.
- It sends a state request every **10 minutes** so the idle timer never fires.
- It enables the gateway's *house status monitor*, so every change (also one made with a remote control) is
  **pushed**; there is no polling loop.
- When a session ends (the gateway reset it, the network dropped, the password was changed) the reason is logged
  at warning level with the gateway device id, the covers show offline, and a **fresh** session is opened with
  exponential backoff: 2 s, 4 s, 8 s ... capped at 5 minutes. A refused password waits the full 5 minutes
  before the next try, so a wrong password does not hammer the unit.

So with Home Assistant connected (1 session) and CamStack (1 session) the gateway is full. A third client
(for example a phone app on the same network, or a second CamStack hub) will be refused.

## Certificate

The gateway presents the same self-signed certificate on every unit, and that shared certificate **expired on
2026-07-12**. The `klf-200-api` library (8.x) accepts only that exact case: the connection is accepted when the
sole defect is "certificate has expired" **and** the peer's fingerprint equals the pinned VELUX one. Any other
certificate, expired or not, is rejected. There is no `rejectUnauthorized: false` in this addon.

## Cover mapping

| KLF-200 actuator | CamStack | Notes |
| --- | --- | --- |
| window opener | `cover` (class `window`) | position 0 = closed, 100 = open |
| roller shutter, swinging shutter, dual shutter | `cover` (`shutter`) | a dual shutter is one cover here |
| awning, horizontal awning | `cover` (`awning`) | |
| venetian / external venetian / louvre blind, curtain track | `cover` (`blind`) | no tilt |
| garage / rolling door opener | `cover` (`garage`) | |
| gate opener | `cover` (`gate`) | |
| window opener with rain sensor | extra `flood` sensor ("<name> rain") | role: leak sensor |
| lights, locks, switches, heating | not exposed | |

The wire position runs 0x0000 .. 0xC800 where **0 is fully open**, for every actuator type; CamStack's cover is
0 = closed .. 100 = open, so `open% = round(100 * (1 - raw / 0xC800))`. A raw value above 0xC800 is a protocol
marker (target, current, ignore), reported as an unknown position and shown as `stopped`, never `closed`.
`stop` is sent as the stop marker 0xD200.

A cover is identified by the actuator's **serial number**, not by its node id (a node id is only an index that
the gateway can reuse after a node is removed). A node that reports no serial falls back to its node id.

## Rain

A window with the integrated rain sensor reports rain as an **opening limitation** (a minimum of 89 % or more).
The gateway does not push limitation changes, so the addon re-reads it every 5 minutes and each time the window
stops moving. An unreadable value keeps the previous level.

## Known limits

- Tilt is not supported (the KLF-200 has no tilt in its cover model).
- Scenes, groups and the gateway reboot button are not exposed.
- A dual roller shutter is exposed as one cover (it is two entities in Home Assistant).
- The vendor library still prints a few lines to `console` itself (a login error text, an expired-certificate
  warning). Those messages never contain the password.
