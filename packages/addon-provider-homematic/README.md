# Homematic Provider

Homematic / HomematicIP (CCU3 / RaspberryMatic) device-provider addon for CamStack — wraps the nodehomematic library.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-homematic` on npm.

## What it provides

- **Homematic** (`provider-homematic`): Connect to a Homematic CCU3 / RaspberryMatic hub and adopt its switches, covers, lights, locks, thermostats and sensors. Category: providers.
  - Capabilities: `device-provider`, `broker`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Homematic broker: Brokers are managed separately

**Connection**

- CCU connection: Host / IP
- Interfaces: Enable Homematic IP, Enable Homematic (BidCos-RF), Enable groups (heating groups), Enable BidCos-Wired (HM-Wired)
- Event callback: Callback host (optional — auto-inferred when blank), Callback port
- WebUI credentials: Username, Password
- Advanced: Use TLS

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## Setup

1. In CamStack: Integrations, add **Homematic**. Pick the CCU found on your network (the scan asks each host of the
   local /24 networks whether it is a CCU3 or RaspberryMatic WebUI) or type its **host / IP**. Choose the
   **interfaces** to bind, and set the **callback host** if the hub has more than one address (it must be one the
   CCU can reach, never 127.0.0.1; blank infers it). The WebUI **username and password** are optional: they unlock
   friendly names and rooms, and the password is stored in the CamStack keychain, never in an environment variable,
   a command line or a log line. **Test** asks every enabled interface and, with credentials, logs in.
2. Open the integration's discovery. The CCU appears as one **Gateway** device (online state, host, and a link to
   its WebUI); every CCU device appears as a candidate, or as one candidate per entity under the **Entities**
   filter. Ids carry the integration, so two CCUs never collide. Products are siblings of the gateway, not its
   children.
3. A CCU that is down when CamStack starts is retried with a growing delay, and again on every integration change.
4. Reboot and firmware update of the CCU are not offered: the library has no call that restarts the CCU, and its
   firmware call installs an update on a radio device by address.

Two CCUs on one hub share the default callback port (2128): give the second one another **callback port**.
An older broker-based CCU is not migrated: remove it and add the integration.
