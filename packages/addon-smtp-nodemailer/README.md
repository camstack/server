# Email (SMTP)

SMTP email provider addon for Dominevo — wraps `nodemailer` and registers a `smtp-provider` cap collection entry. Used by notifier addons.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@dominevo/addon-smtp-nodemailer` on npm.

## What it provides

- **Email (SMTP)** (`smtp-nodemailer`): Outbound SMTP relay backed by `nodemailer`, plus the `smtp-inbound` broker kind: a mailbox cameras can send alarm mail to. Every relay is an integration instance; `smtp-provider.sendEmail` + `verify` serve consumers (notifications, alerts), optionally pinned to one relay. Category: messaging.
  - Capabilities: `smtp-provider`, `integration-instances`, `broker`.

## Requirements

- Placement: hub-only.
- Runtime dependencies installed with the addon: `mailparser`, `smtp-server`.
- A Dominevo hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
