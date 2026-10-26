# @camstack/addon-provider-wyze

Wyze camera device-provider addon for CamStack — wraps the @apocaliss92/wyze-bridge-js P2P/DTLS client, feeding the stream-broker via the pull-rfc4571 lazy-publish path (a structural twin of addon-provider-reolink)

## What it does

- **Wyze** (`provider-wyze`): Adopt Wyze cameras over the local P2P/DTLS protocol via Wyze-cloud discovery — H264/H265 + audio into the stream-broker, snapshot, motion and two-way audio
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `stream-params`, `connection-test`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

