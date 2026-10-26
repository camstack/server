# @camstack/addon-notifiers

System notifiers addon for CamStack — a `notification-output` collection provider hosting per-kind notifier adapters (ntfy, pushover, gotify, telegram, discord, webhook, zentik).

## What it does

- **Notifiers** (`notifiers`): Push-notification delivery targets (ntfy, Pushover, Gotify, Telegram, Discord, generic webhook, Zentik). One canonical notification is degraded per target's declared capabilities.
  - Node placement: `hub-only`, runner group `notifiers`.
  - Capabilities: `notification-output`, `addon-routes`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

