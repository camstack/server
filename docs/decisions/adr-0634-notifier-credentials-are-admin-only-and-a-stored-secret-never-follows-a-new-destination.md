---
id: D634
title: Notifier credentials are admin-only, and a stored secret never follows a new destination
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/types/src/capabilities/notification-output.cap.ts
  - packages/addon-notifiers/src/secrets.ts
  - packages/addon-notifiers/src/provider.ts
  - packages/addon-notifiers/src/adapters/adapter.ts
  - packages/addon-notifiers/src/adapters/webhook.ts
  - packages/addon-notifiers/src/destinations.ts
  - packages/types/src/capabilities/storage.cap.ts
  - server/backend/src/api/trpc/device-config-secret-redaction.ts
  - packages/system/src/builtins/device-manager/device-aggregation.ts
  - packages/types/src/capabilities/device-manager.cap.ts
  - packages/types/src/capabilities/device-export.cap.ts
  - packages/types/src/capabilities/device-ops.cap.ts
  - packages/types/src/capabilities/mqtt-broker.cap.ts
  - packages/types/src/capabilities/broker.cap.ts
---

## Context

A security review (2026-09-25) was asked whether `notificationOutput.listTargets`
leaked notifier credentials. It does not — the provider replaces every
`password` field with `__redacted__` for every caller. But the same secrets
were reachable by two other doors, both because every non-admin role
(`viewer`, `operator`, `manager`) carries a `category:system` grant and both
caps were `protected`:

1. **`settingsStore.*`** is a raw door onto every addon's collections, with no
   notion of who is asking (its own header says so). A `viewer` could call
   `settingsStore.query({ collection: 'notifiers:notification-targets' })` and
   read every bot token, API key, ntfy password and webhook header of every
   user in plaintext; an `operator` could write any collection.
2. **`notificationOutput` target CRUD + `testTarget`** had no ownership check.
   An `operator` could `upsertTarget` ANY target (another user's too) keeping
   the password as `__redacted__` and changing only `serverUrl`; `mergeSecrets`
   restored the stored token, and `testTarget` delivered it to the new host.
   A kind swap on the same id did the same through a same-named key (pushover
   → gotify, both `appToken`).

Two lesser findings: the webhook `url` was a plain text field although it is
routinely the credential (a Home Assistant webhook id, a Slack-style path, a
`?token=`), and a transport error echoed the url it dialled into
`SendResult.error` and the log — the Telegram token is in the path, a Discord
webhook URL is the whole secret.

Considered and rejected:

- **Redacting `settingsStore` output.** The door does not know which
  collection holds what; a schema-driven redaction would need every addon's
  schemas at the storage layer, and a write path would stay open regardless.
- **`internal: true` on `settings-store`.** Floors unannotated methods to admin
  (D240), but leaves the tier implicit: it holds only while nobody removes the
  flag or adds an explicit `protected` to a method. An explicit `auth: 'admin'`
  per method is read at the method and pinned by the tier baseline.
- **An ownership check on the cap methods.** The owner-checked surface already
  exists — the `nc.*` bridge — and it is what the viewer's non-admin screens
  use. A second copy of that check on the cap would be two authorities.

## Decision

- Every `settings-store` method, and every `notification-output` method that
  reads, redirects, fires or mutates a target (`listTargets`,
  `discoverTargets`, `send`, `testTarget`, `upsertTarget`, `deleteTarget`,
  `setTargetEnabled`), is `auth: 'admin'`. `listTargetKinds` stays
  `protected` — descriptors carry no secret. Non-admins manage their own
  targets through the `nc.*` bridge. Addons are unaffected because their
  `ctx.api` cap calls never enter the tRPC router at all: the local provider
  link resolves them to the provider directly, and an agent forwards through
  `$hub-cap-fwd` — the tier constrains sessions and tokens, NEVER addons.
  (Only the hand-written `CORE_NAMESPACES` go through `createMeshTrpcContext`;
  this first said caps did too — review L2.)
- `mergeSecrets` restores a stored secret the editor left redacted (or
  omitted) ONLY when the kind is unchanged AND every field in the adapter's
  `destinationKeys` is unchanged. Otherwise the save is refused with
  `SecretRestoreRefusedError`, whose message names the secret FIELDS and what
  changed, never a value: "re-enter the secret when changing where this target
  sends". `destinationKeys` is a REQUIRED member of `NotifierAdapter`, so every
  new kind must answer where its secrets go.
- The webhook `url` is a `password` field: redacted on read, kept by an editor
  that leaves it untouched.
- Every error the notifiers provider returns or logs goes through `stripUrls`.

## Consequences

- An admin who edits a target's server, chat, bucket or instance must re-type
  its secret in the same save. That is the point, and the error says so.
- A non-admin client calling any of these methods gets `FORBIDDEN`. Checked on
  2026-09-25: no viewer screen, CLI command or Home Assistant component calls
  `settingsStore`; the viewer calls `notificationOutput.listTargets` only from
  the admin-only alarm screen, gated on a confirmed admin verdict.
- The tier is baked into the `@camstack/system` bundle (it inlines
  `ALL_CAPABILITY_DEFINITIONS`), so it is live only with a `@camstack/server`
  containing it. The notifiers half ships with the addon alone.
- `settingsStore` still does not scope a caller to its own namespace — an
  ADDON can still read another addon's collection. That is the migration
  already tracked in the cap's header, not solved here.

## Enforcement

- `server/backend/src/__tests__/cap-routers/notifier-credentials-admin-only.router.spec.ts`
  — pins the tier of every method, proves each role's grants reach the paths
  at the scope matcher (so the tier is the only gate), and drives the live
  router as viewer / operator / manager (refused) and admin (served).
- `scripts/check-method-tiers.ts` — the baseline records the 22 narrowed
  methods; widening any of them fails CI.
- `packages/addon-notifiers/src/__tests__/secret-restore-guard.spec.ts` — for
  EVERY registered adapter (`NOTIFIER_ADAPTERS`), every destination key
  changed with secrets redacted is refused and nothing moves; re-typed is
  accepted; a kind swap is refused on the kind alone.
- `packages/addon-notifiers/src/__tests__/send-error-redaction.spec.ts`.

## Fix round 1 (review, same day)

The review found the same secrets behind two more doors, and two weaknesses
in the guard:

- **`storage` byte methods are admin-only.** `list` / `read` / `beginDownload`
  + `readChunk` (and `resolve`, `exists`, `write`, `delete`, the upload
  session) were `protected` with the `view` flavour, so a viewer could list
  `backups` and download an archive that holds the live settings database.
  A location-class gate that lets MEDIA through was considered and rejected:
  no client reads media through this cap (viewer, admin UI, CLI and Home
  Assistant components call none of these methods — media reaches a person
  through the device-scoped caps), and a media location opened here would
  bypass device scoping, since `storage.read({ location: 'recordings' })`
  names no device. `listLocations` (already redacted) and
  `getAvailableSpace` stay open. The admin backup download route checks
  admin itself and calls the provider in-process.
- **Addon settings forms are redacted for non-admins.**
  `addonSettings.getGlobalSettings` / `getIntegrationSettings` /
  `getDeviceSettings` are `protected`, and `hydrateSchema` fills a password
  field with its STORED value (masking was removed deliberately, on the
  belief the endpoint was admin-gated — it was not). They now go through
  `redactSettingsForm` in `NON_ADMIN_CONFIG_REDACTED_METHODS`, which decides by
  the FIELD (`type: 'password'` or `secret: true`, then key name) at any depth.
  Admins still get the real value; the writers are admin-only, so a redacted
  value cannot be written back.
- **`destinationKeys` is a non-empty tuple**, and a spec over every registered
  adapter fails on an empty list or on an address-shaped field
  (`url|host|server|endpoint|instance|chat|bucket|recipient|userIds`, or
  `inputType: 'url'`) that is neither declared nor exempted with a reason.
  Discord declares its (secret) `webhookUrl`, Pushover its (secret) recipient
  `userOrGroupKey`, gotify also `verifyTls`.
- **"Unchanged" is judged on the EFFECTIVE destination** (`destinations.ts`):
  absent = schema default, a field hidden by `showWhen` routes nothing, and an
  adapter may canonicalise (`normalizeDestination` — zentik `userIds` CSV vs
  list). A no-op edit from either editor is no longer refused.
- **`TargetKind.destinationKeys` is published** by `listTargetKinds`, and the
  admin target editor asks for the secret only when a destination changed
  (falling back to "any edit" against a hub that does not publish it).
- Correction: addons are unaffected by these tiers because an addon's
  `ctx.api` cap call never enters the tRPC router — not because it "arrives
  as the mesh principal", which is true only of `CORE_NAMESPACES`.

Enforcement added: `storage-bytes-admin-only.router.spec.ts`,
`device-config-secret-redaction.spec.ts` (addon-settings block), the
fail-closed and effective-destination blocks of
`secret-restore-guard.spec.ts`, and `notification-targets.helpers.spec.ts`.

## Fix round 2

- **Array-valued secrets.** The round-1 form redactor replaced only a secret
  field's STRING value, so an `editable-array` whose rows carry a `password`
  (mqtt-broker `brokers[].password`), a `multiple` secret and a JSON object
  holding a `token` went out whole. The value is now walked element by
  element and key by key: a key is secret when its declared item field is
  (`password` / `secret: true`) or its name is, everything under a secret is
  withheld, and a non-secret URL loses its userinfo (`maskUrlCredentials`).
  Pinned against the REAL mqtt-broker schema hydrated by the real
  `hydrateSchema`.
- **Pairing secrets found by the sweep.** A `qr-code` form field is a pairing
  code (HomeKit `X-HM://` URI, and its caption spells the setup code); device
  settings forms now use the same field-aware walk as addon forms. And
  `deviceExport.getStatus` drops its `setup` block for a non-admin — it held
  the HomeKit setup URI and the Alexa Lambda ingress token (`secret: true`
  masks in the UI only).
- **`showWhen` assumption guarded.** `hidden-fields-unread.spec.ts` proves, per
  adapter using `showWhen`, that a hidden field never changes the request —
  the premise that lets `destinations.ts` treat it as absent.

## Fix round 3

- **A system COLLECTION cap has no per-device status.** The status aggregates
  asked `getProviderForDevice('device-export', id)`, which for a collection
  with no native provider returns the FIRST provider — so every viewer, for
  any device, received the first export addon's `setup` (HomeKit URI, Alexa
  ingress token). `getDeviceStatusAggregate` now answers `null` for a
  system-scoped collection cap (`device-export`, `broker`, `mqtt-broker`)
  whether named or defaulted: their answer was never about the device. System
  SINGLETONS with a real per-device status (`recording-archive`, a viewer
  badge cap) are unaffected. The transport boundary also drops `setup` from a
  `device-export` entry in both aggregate shapes (defence in depth).
- **The restore surface is admin-only.** `deviceManager.loadConfig` returned
  the raw persisted device config (camera password included) to any viewer;
  `persistConfig` and `loadRuntimeState` are its siblings. Only device
  providers call them, over `ctx.api`.
- **Publishing to another ecosystem is admin-only:** `deviceExport.exposeDevice`
  / `unexposeDevice`.
- **Sweep of `protected` reads/writes on the device and integration surfaces:**
  `deviceOps.setConfig` (rewrites connection config — the exfiltration pattern
  again) and `deviceOps.removeDevice` are admin; `mqttBroker.getBrokerConfig`
  (returns the DECRYPTED broker password) and the mqtt-broker CRUD/embedded
  controls are admin; `broker.getState` (raw entity cache — HA camera
  `access_token`) is admin. `deviceOps.getConfigEntries` / `getSettingsSchema`
  / `getRawState`, `mqttBroker.listBrokers` and `integrations.list/get/
  getByAddonId` are redacted for a non-admin (the HA provider's "display-safe"
  claim about raw attributes was false).
