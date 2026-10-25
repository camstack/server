---
id: D798
title: An addon reads its own settings resolved — never a keychain marker — and writing a read back changes nothing
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/addon/secret-aware-context.ts
  - packages/types/src/addon/secret-write-back.ts
  - packages/types/src/addon/secret-settings-view.ts
  - packages/types/src/addon/base-addon.ts
  - packages/types/src/interfaces/addon.ts
  - scripts/check-no-raw-secret-read.ts
---

## Context

D787 moved every secret out of the settings blobs: a blob holds
`{ "$secret": "secret://…" }` and the value lives in the keychain. `BaseAddon`
resolved markers for `this.config` and `state()`, but every other read an addon
has — `resolveGlobalStore()`, `readStoredGlobalKey()`, `this.ctx.settings.read*`
— answered the RAW blob. In one evening, after the live migration, three addons
met a marker where their secret used to be:

- **Wyze** declared no `globalSettingsSchema`, so the save path did not know
  its credentials were secret (b4906cec6).
- **ONVIF** built its config from `resolveGlobalStore()` and got an object for
  `defaultPassword` (a79a31462).
- **Reolink** read its SMTP password through `resolveGlobalStore()`, took the
  marker for "absent", minted a new password and saved it. That save was a new
  keychain version and a config change; the change restarted the SMTP intake,
  which read the marker again — ~233 rotations a minute of the password the
  cameras were provisioned with (675e83e39).

Each fix was local, and the guard added with the first one
(`check-global-schema-declared`) covers only `getGlobalSettings` overrides.
The bug class is "an addon-facing read returns a marker", and it would keep
arriving one addon at a time.

## Decision

Every read an addon makes of its own settings answers VALUES. `BaseAddon` wraps
`ctx.settings` so that `readAddonStore`, `readAddonStoreResult`,
`readAddonStoreKeyResult`, `readDeviceStore` and `readDeviceStoreBatch` resolve
the addon's own markers through `ctx.secrets` (one batched, cached,
owner-checked call per read); `resolveGlobalStore()` and
`readStoredGlobalKey()` read through that view. A marker the keychain cannot
serve stays a MARKER — "stored, unavailable" — never `''` and never absent, and
is reported through `unresolvedSecrets` and the log. Another owner's marker is
left untouched.

Writing a resolved read back changes nothing: before the save path, a value at
a position where the blob holds the addon's own marker becomes that marker when
it equals the resolved value (no `put`); a different value is stored under the
SAME ref; `''` / `null` keep. An undeclared key holding a marker joins the
secret tree for the write. Keys equal to what is stored are dropped, and a write
that changes neither blob nor keychain is not written and is not a config change
(`updateGlobalSettings` skips `onConfigChanged`, `AddonUpdated`, the restart).

An ADDON's new value over a stored secret it could not read (`unavailable`,
`forbidden`) is refused with `SecretOverwriteRefusedError` — that is the
regenerate-on-missing shape. The operator's own write still goes through, and a
`missing` ref may be minted again.

The marker-bearing blob stays reachable only through `BaseAddon`'s PRIVATE raw
view, for the three paths that need markers: the form hydrate (markers become
"set" views), `resolveConfig` (it tracks unresolved refs for its retry), and the
save path.

## Consequences

- No addon code changes were needed; the three per-addon fixes keep working.
  Reolink's `readRaw` (`resolveGlobalStore()`) now answers the value, and its
  "a marker means unavailable" branch still holds because an unavailable value
  still reads as a marker.
- Every addon-facing read with a marker costs a keychain resolve — served from
  `ctx.secrets`' cache after the first one; a read with no own marker costs a
  walk of the blob and nothing else.
- A form built by an addon from a RESOLVED read with `hydrateSchema` directly
  would carry the value. `BaseAddon`'s own forms hydrate from the raw view, and
  an override passing a resolved overlay to `super.getGlobalSettings` keeps the
  marker for every unchanged member; an addon that hydrates a secret field
  itself must do it from `getGlobalSettings` / `getDeviceSettings`.
- A first write to a store this process never read reads the store once, so a
  write-back is recognised even then.
- Markers inside arrays the schema does not declare are only recognised when
  unchanged at the same index; a changed row secret there is left to the
  declared tree (rows need an id field to be matched safely).

## Enforcement

- `scripts/check-no-raw-secret-read.ts` (CI `checks.yml`): addon code
  (`packages/addon-*/src`, `packages/system/src/builtins`) fails on reading the
  `initialize(context)` parameter's `settings` (the unwrapped, marker-bearing
  view) and on any reference to `BaseAddon`'s private raw members.
- Specs: `base-addon-resolved-reads.spec.ts` (one per read path, write-back,
  unavailable semantics), `keychain-raw-read-incidents.spec.ts` (Wyze, ONVIF and
  Reolink reproduced generically: marker in the store → plaintext on read →
  write-back is no change and no loop), `secret-write-back.spec.ts`.
