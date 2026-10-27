# Email (SMTP)

SMTP email provider addon for CamStack — wraps `nodemailer` and registers a `smtp-provider` cap collection entry. Used by notifier addons.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-smtp-nodemailer` on npm.

## What it provides

- **SMTP Email (Nodemailer)** (`smtp-nodemailer`): Outbound SMTP relay backed by `nodemailer`. Exposes `smtp-provider.sendEmail` + `verify` to consumers (notifications, alerts). Category: messaging.
  - Capabilities: `smtp-provider`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
