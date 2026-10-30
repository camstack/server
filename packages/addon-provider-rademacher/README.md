# Rademacher Provider

Rademacher HomePilot device-provider addon for CamStack — wraps the @apocaliss92/noderademacher local-hub client (roller shutters over the cover cap).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-rademacher` on npm.

## What it provides

- **Rademacher** (`provider-rademacher`): Adopt a Rademacher HomePilot / Start2Smart hub over the local network and its roller shutters (positional cover). Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Hub: Name
- Connection: Hub host / IP, Password (optional), Poll interval (ms), API base path (optional)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## Setup

1. In CamStack: Integrations, add **Rademacher**. Pick the hub found on your network (the scan probes the local
   /24 networks for a HomePilot or Start2Smart) or type its **host / IP**. Leave the **password** blank for an
   unprotected hub; it is stored in the CamStack keychain and never put in an environment variable, a command
   line or a log line. **Test** logs in and reads the hub's model and firmware.
2. Open the integration's discovery. The hub appears as one **Gateway** device (its web page, model, firmware,
   MAC and online state); every roller shutter appears as a cover, with the integration in its id so two hubs
   never collide. Adopt the ones you want. The products are siblings of the gateway, not its children.
3. The hub has no push channel, so it is polled every **poll interval** (30 s by default). A hub that is down
   when CamStack starts is retried with a growing delay, and a hub that stops answering reads offline until it
   answers again.
4. Reboot and firmware update are not offered: the HomePilot API only reports that an update exists, it cannot
   restart the hub or start one.

An older standalone Rademacher hub device is not migrated: remove it and add the integration.
