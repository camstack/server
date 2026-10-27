# @camstack/addon-smtp-nodemailer

SMTP email provider addon for CamStack — wraps `nodemailer` and registers a `smtp-provider` cap collection entry. Used by notifier addons.

## What it does

- **Email (SMTP)** (`smtp-nodemailer`): Outbound SMTP relay backed by `nodemailer`. Exposes `smtp-provider.sendEmail` + `verify` to consumers (notifications, alerts).
  - Node placement: `hub-only`.
  - Capabilities: `smtp-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

