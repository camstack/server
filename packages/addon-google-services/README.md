# Google Services

Google Services — Google brokers (OAuth2): Calendar as calendar-source, Gmail send as smtp-provider.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-google-services` on npm.

## What it provides

- **Google** (`google-services`): Google brokers (OAuth2 accounts): Calendar as calendar-source, Gmail send as smtp-provider. Category: messaging.
  - Capabilities: `broker`, `calendar-source`, `smtp-provider`, `addon-routes`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Google brokers: Steps, Setup
- Google OAuth client: Client ID, Client secret
- Gmail send: From address, From display name (optional)
- Calendars to import: Calendars

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-google-services.md](https://github.com/camstack/server/blob/main/docs/addons/addon-google-services.md)
- [packages/addon-google-services/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-google-services/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
