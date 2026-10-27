# Alexa Smart Home export

Alexa Smart Home Skill export — hub-side OAuth provider + directive handler. The companion AWS Lambda forwards Alexa directives to this addon's /addon/export-alexa/directive endpoint.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-export-alexa` on npm.

## What it provides

- **Alexa Smart Home export** (`export-alexa`): Hub-side OAuth provider + Smart Home directive handler. Pairs with a user-owned AWS Lambda that forwards Alexa directives to this addon. Skeleton: AcceptGrant + Discovery implemented; CameraStream / RTC / Doorbell push in next dispatch. Category: exports.
  - Capabilities: `device-export`, `addon-routes`, `oauth-integration`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-export-alexa.md](https://github.com/camstack/server/blob/main/docs/addons/addon-export-alexa.md)
- [packages/addon-export-alexa/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-export-alexa/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
