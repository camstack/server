# Alexa Import

Alexa device-import provider for CamStack — imports the smart-home devices in a user's Alexa account via the unofficial alexa-remote2 cookie/token client (the inverse of the Alexa exporter).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-import-alexa` on npm.

## What it provides

- **Alexa Import** (`import-alexa`): Import smart-home devices from an Amazon Alexa account (unofficial cookie/token client; poll-based state sync). The same account can speak a notification aloud on Echo devices. Category: providers.
  - Capabilities: `device-provider`, `broker`, `device-adoption`, `addon-routes`, `notification-output`, `addon-pages-source`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Amazon Alexa account: Accounts are managed separately
- Interactive login (proxy): Login proxy host/IP (blank = auto-detect), Login proxy port

**Connection**

- Amazon Alexa account: Amazon domain (region), Cookie blob (from proxy login), Refresh token (alternative to cookie), State poll interval (ms)

## Requirements

- Placement: default placement.
- Python: Alexa Import installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-import-alexa.md](https://github.com/camstack/server/blob/main/docs/addons/addon-import-alexa.md)
- [packages/addon-import-alexa/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-import-alexa/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
