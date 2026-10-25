---
id: D675
title: A settings read that cannot ask the store REFUSES — never `{}` — and the store never answers for env-owned auth
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/system/src/kernel/config-manager.ts
  - packages/system/src/kernel/settings-read-error.ts
  - packages/system/src/kernel/system-settings-policy.ts
  - packages/system/src/kernel/system-settings-mirror.ts
  - server/backend/src/core/addon/settings-door-wiring.ts
  - packages/system/src/kernel/settings-door-view.ts
  - server/backend/src/api/core/addon-settings.router.ts
  - server/backend/src/api/core/capability-preference-writes.ts
  - packages/system/src/builtins/device-manager/device-source-activation.ts
---

## Context

D231 (2026-08-24) isolated `sqlite-settings`. From then on hub-main is handed
the async `settings-store` door and never a synchronous `ISettingsStore`, and
D231 wrote down, as an accepted consequence, that `ConfigManager.get()` /
`getAddonConfig()` "fall back to yaml / `{}`" and that "operator
capability-preference writes still land". Both halves were true and together
they were the defect: the writes landed and nothing ever read them back.

What that cost, measured on the live hub on 2026-09-29:

- `addonSettingsRaw.getGlobal` answered `{}` for every addon — device-manager,
  pipeline-orchestrator, notifications, recorder — although the rows were
  exactly where the reader looked (`settingsStore.get` on
  `addon-settings/device-manager.deviceBindings` returned the 1.6 KB map). The
  router's docblock explained the `{}` as "two different physical stores";
  that diagnosis was wrong — one store, no backend — and it sent a session
  hunting for a key mismatch.
- virtual-doorbell's durable authority read that router. Every read was
  `unreadable`, so camera 101's persisted `wrapperAddonId: null` (the
  operator's explicit OFF) was never honoured: the verdict was `unknown` and a
  press RANG. 502 `durableAuthority=unreadable` WARN lines in 72 h. The
  durable read had never worked in production.
- Capability preferences (`capabilities.singleton|singletonNode|collection.*`)
  were written through the door and never restored after a reboot;
  `capabilities.getPreference` reported `null` — "unset".
- The System → Authentication "Token Expiry" Save landed in `system-settings`
  and the form re-read YAML/defaults.

D294 and D651 had already fixed the settings VIEW (per-call backend, a
three-way `readAddonStoreResult`). The synchronous readers were left out, and
the routers kept calling them. A test could not see it: the router spec used a
Map-backed fake ConfigService that round-tripped writes, and the doorbell spec's
durable fake answered a populated store by default — the value production never
fetched (CLAUDE.md, "a fake supplied the value production forgot").

Rejected: **merging the store layer back into `getSection` at highest
priority**, the obvious fix. `system-settings` also holds `auth.jwtSecret`,
`auth.adminUsername` and `auth.adminPassword` (written by `local-auth` and older
builds). The live container supplies all three from env. Env won only because
the store was skipped; a store merged on top would let a stale DB copy replace
the JWT secret (every token invalid) and the admin password.

Rejected: **keeping `addonSettingsRaw.getGlobal` as the doorbell's durable
read once fixed.** It would pull device-manager's whole addon row set through
hub-main on every reconcile to read one key, and it is a shadow read of another
addon's layout.

## Decision

A synchronous settings reader that has no store it can ask REFUSES with
`SettingsReadUnavailableError` (`door-only`, `not-wired`, `preload-pending`,
`preload-failed`, `read-failed`); it never answers `{}` or a default as if the
store had been asked. Every caller is handled explicitly: it reads through the
async three-way path (`ConfigManager.readAddonGlobalStrict` /
`readAddonDeviceStrict`, the settings view's `getSection` over the door), reads
a value the kernel loaded ONCE at boot into memory (capability preferences and
`auth.tokenExpiry` — one read when the door is wired, replayed onto the registry
when it settles, no polling), or turns the refusal into an honest answer
(`getPreference` → `state: 'unknown'`, the sign path → the default lifetime with
a WARN).

And for a bootstrap-owned section (`mode`, `server`, `auth`, `hub`, `agent`,
`tls`, `bootstrap`) the store answers ONLY the allow-listed keys
(`STORE_READABLE_BOOTSTRAP_KEYS` = `auth.tokenExpiry`), whichever backend is
wired. Env + config.yaml own the rest.

A consumer that needs another addon's PERSISTED state asks the owner through a
cap method, three-way — for wrapper activations,
`deviceManager.getWrapperActivation({ deviceId, capName })` →
`value | missing | failed` — never `addonSettingsRaw`. It reads ONE row (the
activation map), never the owner's whole store, and grades absence by level:
no map at all (a store answering from an empty or unready snapshot, D44) is
`failed`; only a map that was read and holds nothing for the pair is `missing`.

## Consequences

- `addonSettingsRaw` keeps only `getGlobal` / `getDeviceOverrides`, both over
  the door; a failed read is `SERVICE_UNAVAILABLE`. `updateGlobal` /
  `updateDevice` / `replaceGlobal` are deleted: no callers, they threw on every
  isolated engine, and they bypassed the schema gate. Write addon settings
  through the `addonSettings` cap.
- `ConfigManager.getAddonConfig` / `getAddonDevice` / `getSection` throw
  without a sync store; `getProviderConfig` / `getDeviceConfig` (and their
  setters) had no callers and are deleted. `get()` throws
  in door mode for any key that is neither bootstrap-owned nor preloaded. Only
  boot-time readers that run before the door exists (`eventBus.*`,
  `moleculer.logLevel`, `cluster.secret`) still see "bootstrap + defaults", and
  the `features` getter answers its defaults deliberately (nothing writes
  `features.*`).
- `ctx.addonConfig` for an in-process addon is `{}` — as it already was for a
  forked one; nothing in production read it.
- `system-config`'s form now fails rather than showing the default token
  lifetime when the `auth` section cannot be read; `local-auth` fails its init
  (and is retried by the health monitor) rather than start without the env
  secret.
- A preference whose boot read failed is UNKNOWN until the next boot — by
  design (D3: one read, no retry). A write in this process is still reported,
  but only once it LANDED: `ConfigManager.set` now awaits the door and rejects
  on failure (it was fire-and-forget), and the capability routers await it.
- **Amended 2026-09-29: a preference is PERSISTED before it is switched live.**
  With `set` now rejecting, the old order — switch the registry, then persist —
  reported an error for a switch that was already in effect and silently
  reverted at the next boot. Every preference write (`setActiveSingleton`,
  `clearSingletonNodeOverride`, `setCollectionEnabledProviders`,
  `addons.setCapabilityProviderEnabled`)
  now goes through `server/backend/src/api/core/capability-preference-writes.ts`:
  a switch the registry would refuse persists nothing, a failed write changes
  nothing live, and writes to one capability are serialised so two toggles
  planned against the same live set cannot each persist half of it.
  `setCollectionEnabledProviders` — the admin UI's bulk save — persisted
  NOTHING before this; its picks reverted at every boot (D62's defect).
- **Amended 2026-09-29: `getPreference`'s `state: 'unknown'` never reached a
  client.** It lived in `server/backend/src/api/capabilities.router.ts` <!-- drift-ok -->
  (`getPreference` / `setPreference` / `resetPreference`), a router nothing
  mounts — `trpc.router.ts` mounts `api/core/capabilities.router.ts`, which has
  no `getPreference`. That file and its spec were deleted. The honest "unknown"
  for a preference whose boot read failed is still owed to whichever surface
  first reports a persisted preference.
- A bootstrap section read through the door never FETCHES a refused row: the
  `auth` credential rows are filtered by name before the value read, so they
  never enter hub-main's memory.
- **The first deploy re-applies preferences ignored since 2026-08-24.** Every
  `capabilities.*` row written since D231 — singleton choices AND collection
  disabled-lists — was written and never read back; the first boot with D675
  restores them all. Check the boot line `capability preferences loaded from
  the settings store` (`meta.singletonsApplied`,
  `meta.collectionProvidersDisabled`, `meta.keyCount`) and confirm each entry
  is still what the operator wants. A failed read logs `capability preferences
  could not be read at boot` at error instead.
- Infra capabilities (settings-store, storage, …) are chosen before the door
  exists; their persisted preference is still not applied at boot. The replay
  skips them (restart required).
- Behaviour change on the live hub: camera 101's virtual doorbell goes from
  "rings (unknown)" to **silent**, matching its persisted `wrapperAddonId: null`.
- `system-settings` still HOLDS plaintext credential rows. They come from older
  builds and from the sync-store `setSection` path, which writes the MERGED
  section (env credentials included) back to the store; `local-auth` itself
  never generates a secret there, because the hub `AuthService` has already
  filled config.yaml. They are no longer readable as auth, nor fetched; whether
  they should exist at all is a separate security follow-up.

## Enforcement

- `packages/system/src/kernel/__tests__/config-manager-door-only.spec.ts` — a
  real SQLite engine behind the real dispatcher, rows written by the production
  writer: every sync reader refuses in door-only and unwired modes; the strict
  reads answer rows / `{}` / throw; a preference saved in one ConfigManager is
  what the next one reports after its boot read, and the registry replays it.
- `packages/system/src/kernel/__tests__/system-settings-auth-guard.spec.ts` —
  stored `jwtSecret` / `adminUsername` / `adminPassword` / `server.port` never
  override env, through the door and through a sync store; `tokenExpiry` does.
  With NO env the allow-list alone keeps them out, and the refused rows are
  never fetched through the door.
- `server/backend/src/__tests__/addon-settings-router.spec.ts` — the router over
  a real ConfigService (the Map-backed fake is gone).
- `server/backend/src/__tests__/settings-door-wiring.spec.ts` — the registry's
  door wiring replays the stored preference onto a provider that registered
  before the boot read.
- `packages/system/src/builtins/device-manager/__tests__/wrapper-activation-read.spec.ts`
  (one-row read with no range scan; store-level absence is `failed`) and the
  doorbell specs (whose durable fake is now the cap's three-way answer;
  `addonSettingsRaw` is absent from their api on purpose).
- `server/backend/src/__tests__/capability-preference-write-order.spec.ts`
  (2026-09-29) — a real `CapabilityRegistry` through every write path: a store
  whose write fails leaves the registry untouched, a write that lands saw the
  OLD live state, a refused switch writes nothing, and two concurrent toggles
  persist both.
- Each was disarmed by hand (the fix reverted) and went red.
