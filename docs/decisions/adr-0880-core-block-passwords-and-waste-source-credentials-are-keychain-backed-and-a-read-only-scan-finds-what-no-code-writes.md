---
id: D880
title: Core-block passwords and waste-source credentials are keychain-backed, one copy each, and a read-only scan finds the raw ones no code writes
status: accepted
date: 2026-10-18
supersedes:
applies-to:
  - packages/system/src/builtins/core-blocks/block-settings-store.ts
  - packages/system/src/builtins/core-blocks/block-package.ts
  - packages/addon-waste-collections/src/waste-secrets.ts
  - packages/addon-waste-collections/src/waste-types.ts
  - scripts/hub/migrate-raw-secrets.ts
  - scripts/hub/scan-raw-secrets.ts
---

## Context

The D879 storage census (2026-10-18) found three credentials the guard could not see
because nothing in the code names them:

1. **Core-block settings.** A user script declares `type: 'password'` in its exported
   `settingsSchema`, but `BlockSettingsStore` had no secret tree at all, so every such field
   was plaintext - and stored TWICE: the blob `core-blocks:settings` (`values` JSON) and the
   mirror rows `addon-settings` `core-block-<id>.<field>` that a running script reads through
   `ctx.settings.readAddonStore()`. The admin form also received the raw value back.
2. **Waste sources.** `sources[].argsJson` is a free JSON string of provider kwargs; the
   service catalog has `password`, `api_key`, `token`, `authorization` arguments. A string
   cannot declare a secret, so it was raw by construction (latent: today's one source has none).
3. **Orphans.** A legacy `addon-settings` row of a provider that moved to integrations
   (`provider-dreame.brokers`) still held a plaintext password after the migration, and
   no code reads or writes it, so a static guard is blind to it by design.

## Decision

- **A block's password field is keychain-backed, by the schema TYPE.** The block's
  `settingsSchema` gives the secret tree (the D870 path every addon uses). Owner is the block's
  addon id (`core-block-<id>`), scope `global`: `secret://core-block-<id>/global/<field>`. The
  generated wrapper (`block-package.ts`) embeds the schema and returns it from
  `globalSettingsSchema()`, so the running block's `BaseAddon` resolves markers and
  `ctx.settings.readAddonStore()` answers the VALUE. core-blocks writes for the block through
  `ctx.secrets.forOwner` and `transformSecretWrite`: a marker that is not its own ref is
  never stored (it classifies as "keep"), a REDACTED or "set" view keeps the stored value, a
  locked keychain or a missing door refuses the whole save (no plaintext fallback).
  `getBlockSettings` hydrates from the marker-bearing rows, so the form shows "set" and never
  the value.
- **ONE copy: the `addon-settings` rows are the authority.** The script's runtime contract
  (`ctx.settings.readAddonStore()`) and the one-store rule (D870) fix it. The
  `core-blocks:settings` blob is **legacy**: nothing writes it, `delete` removes it, and
  `migrateRawSecrets` is its only reader. (This is the reverse of "drop the mirror": the mirror
  IS the store; the blob was the redundant copy.) A block delete now also removes its rows and
  its keychain values - it used to leave the mirror rows behind.
- **A waste source's credentials are typed `args`, keychain-backed.** The row is
  `{ id, label, module, args, enabled }`, `args` a record of string / number / boolean (a marker
  when the keychain could not serve it). The credential keys are NAMED in `waste-secrets.ts`
  (`password`, `api_key`, `token`, `authorization`, `pin`, `account_pin`; matched case-insensitively) because the generated catalog carries the
  Python parameter names and no secret flag; `secretStatePaths` is `sources[id].args.<key>`,
  and the service form renders them as `password` fields. A spec walks the whole catalog and
  fails when a credential-looking argument is in neither the secret list nor the reviewed
  non-secret list (`key`, `mapkey`: public lookup ids; `email`, `username`, `phone`, `uuid`, `device_id`, `account_number`: identifiers or PII that do not authenticate on their own - the reason is recorded next to each), so a new service cannot add
  one unseen. `listSources` returns the redaction token, never `args`; an update that sends the
  token keeps the stored value. A source whose credential the keychain cannot serve is not
  fetched (it says why), never fetched without it. A row that still carries `argsJson` is legacy:
  that JSON is its truth until migrated.
- **Owner-run verified migrations, dry run first, counts only**, through the existing
  `scripts/hub/migrate-raw-secrets.ts` (now four owners):
  - `coreBlocks.migrateRawSecrets` - per block: gather (rows win, a key only the blob holds is
    carried over), put, READ BACK and compare, write the marker, and only then delete the legacy
    blob; a block that fails stays exactly as it was. A blob of a block that no longer exists is
    removed. Report adds `redundantCopies`.
  - waste-collections `migrateSources` (through `addons.custom`) - rewrite each legacy row as
    typed `args` (credentials go through the normal save path), re-read, compare; on any
    difference the legacy rows are written back. The verification re-reads through the addon's
    own `ctx.secrets`, which caches what it just put: it proves the stored row resolves, not that
    the keychain's disk kept it - the same limit D878 has.
- **The live shape scan** `scripts/hub/scan-raw-secrets.ts --server <host>` is a step of the
  records adoption dry run. It lists every table (`storageAdmin.listTables`), pages each through
  `settingsStore.query` (read routes only, ordered by id, with a pause), and reports SHAPES: table,
  row id, field path - for each credential-named field holding a non-empty string that is not a
  marker (also inside JSON text columns and `{ key|name, value }` pairs, which is how an
  `addon-settings` row names its field). It sees rows no code writes. A table over `--max-rows`
  (default 20000) or unreadable is listed as NOT checked. It never prints or logs a value: a
  spec runs it against a fake hub full of canaries and asserts none reaches the text or JSON
  output, including on the failing-table path. Exit 1 when anything is found.

### Records adoption dry run (add to the records plan notes)

Before a collection is adopted into `ctx.records` (D879 phases 2-4), and again after its
migration: `npx tsx scripts/hub/scan-raw-secrets.ts --server <host>` must show no finding for that
collection, and every orphan it does show (the `provider-dreame.brokers`-class rows) is deleted by
the operator first. The static guard proves the code is clean; this proves the data is.

### Review round (security)

A malformed legacy `argsJson` throws a fixed message (never the JSON parser's, which quotes the text) and is
migrated per row (a bad row is counted failed and left as it was). The waste rollback is wrapped, writes
`args: null` so the save path deletes the refs the migration created, and reports failed regardless. A
block migration flags a credential-named value its schema does not declare (unverified, never copied, legacy
blob kept) and drops a legacy marker that is not the block's own ref. The scan prints the kind of a
`{ key|name, value }` pair, never the sibling's text.

## Consequences

- A copy of the database or a backup no longer carries a block's passwords (the legacy blob
  disappears once the migration ran); until then both stay raw, exactly as before.
- A block's secret field edited from the form needs the keychain unlocked; a block whose
  keychain is locked at boot reads the marker (stored, unavailable), never an empty password.
- The wrapper embeds the schema at materialise time; the supervisor already redeploys a block when
  its record changes, and a schema change is a record change.
- The `core-blocks:settings` declaration stays until every hub ran the migration (it is the
  migration's input); then it goes with the script.
- Orphan rows are only REPORTED by the scan; deleting them is the operator's act, by hand.

## Enforcement

Specs, each disarmed (the secret tree dropped, the read-back removed, the wrapper schema removed,
the redaction removed, the scan made to print a value) and failing:
`block-settings-keychain.spec.ts`, `block-package.spec.ts`, `block-supervisor.spec.ts`,
`waste-credentials.spec.ts`, `migrate-raw-secrets.spec.ts`, `scan-raw-secrets.spec.ts`.
`scripts/check-no-raw-secrets-in-collections.ts` stays green (the census had no row for either
owner: they were missed, not parked).
