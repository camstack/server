# Google Home Export

Google Home Export — hub-side smart-home fulfillment (SYNC / QUERY / EXECUTE / DISCONNECT) for the non-camera fleet, served over the hub's own OAuth account link. No Google credential is stored, sent or required.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-export-google` on npm.

## What it provides

- **Google Home Export** (`export-google`): Publishes switches, dimmable lights, locks and covers to Google Home / Google Assistant. The hub answers Google's smart-home fulfillment directly (SYNC / QUERY / EXECUTE / DISCONNECT) and account-links through the hub's own OAuth server — no cloud function and no Google credential. Cameras and proactive Report State are deliberately out of scope. Category: exports.
  - Capabilities: `device-export`, `addon-routes`, `oauth-integration`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-export-google.md](https://github.com/camstack/server/blob/main/docs/addons/addon-export-google.md)
- [packages/addon-export-google/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-export-google/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
