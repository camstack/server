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
