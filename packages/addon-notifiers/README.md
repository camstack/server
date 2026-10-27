# Notifiers

System notifiers addon for CamStack — a `notification-output` collection provider hosting per-kind notifier adapters (ntfy, pushover, gotify, telegram, discord, webhook, zentik).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-notifiers` on npm.

## What it provides

- **Notifiers** (`notifiers`): Push-notification delivery targets (ntfy, Pushover, Gotify, Telegram, Discord, generic webhook, Zentik). One canonical notification is degraded per target's declared capabilities. Category: messaging.
  - Capabilities: `notification-output`, `addon-routes`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Connection: Server URL, Application Token, Client/Admin Token (optional)
- Defaults: Default priority, Default content type
- WhatsApp / Green API: Experimental — read before enabling, API host, Custom API URL, Media URL (optional), Instance ID (idInstance), API Token (apiTokenInstance), Chat ID / phone number, I understand the ban risk and accept the WhatsApp Terms-of-Service violation

## Requirements

- Placement: hub-only (runner group `notifiers`).
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/notifications.md](https://github.com/camstack/server/blob/main/docs/architecture/notifications.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
