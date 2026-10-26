# @camstack/addon-export-google

Google Home export — hub-side smart-home fulfillment (SYNC / QUERY / EXECUTE / DISCONNECT) for the non-camera fleet, served over the hub's own OAuth account link. No Google credential is stored, sent or required.

## What it does

- **Google Home export** (`export-google`): Publishes switches, dimmable lights, locks and covers to Google Home / Google Assistant. The hub answers Google's smart-home fulfillment directly (SYNC / QUERY / EXECUTE / DISCONNECT) and account-links through the hub's own OAuth server — no cloud function and no Google credential. Cameras and proactive Report State are deliberately out of scope.
  - Node placement: `hub-only`.
  - Capabilities: `device-export`, `addon-routes`, `oauth-integration`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

