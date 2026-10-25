---
id: D870
title: One store per kind of setting for every process, and per-camera state is a key of the camera
status: accepted
date: 2026-10-17
supersedes: D865 (the parts that called one store "standard" without making it one)
applies-to:
  - packages/system/src/kernel/device-settings-store.ts
  - packages/system/src/kernel/addon-settings-store.ts
  - packages/system/src/kernel/sections-store.ts
  - packages/system/src/kernel/settings-door-view.ts
  - packages/system/src/kernel/moleculer/runner-device-settings.ts
  - packages/system/src/kernel/moleculer/runner-addon-settings.ts
  - packages/system/src/builtins/sqlite-storage/storage-admin-provider.ts
  - packages/addon-pipeline/src/stream-broker/broker-device-state.ts
  - packages/addon-post-analysis/src/notification-center/device-mute-store.ts
  - packages/addon-pipeline/src/stream-broker/rtsp-token-recovery.ts
---

> **Retired 2026-10-22.** The device-store migration has run on both operator
> hubs and the legacy blob tables are dropped, so its one-shot code is deleted:
> `scripts/hub/migrate-device-store.ts` and `device-store-migration.ts`, the <!-- drift-ok: deleted 2026-10-22 -->
> boot guard `assertLegacyBlobsMigrated` (`legacy-blob-guard.ts`) and the D877
> update pre-flight that ran it, and `storageAdmin.dropCollection`. The rule
> below (one store per kind of setting) stands.

## Context

[D865](adr-0865-a-deleted-device-is-a-recorded-fact-settings-are-cleared-centrally-and-device-data-is-removed-by-a-hook-driven-by-tombstones.md)
called `addon-device-settings` the standard home of per-device settings, but a
setting still lived in TWO places depending on who asked. Hub-main's view
(`settings-door-view.ts`) read rows `<addonId>:<deviceId>.<field>` of
`addon-device-settings`; a forked runner's view (`addon-context-factory.ts`) read a
blob per device in its own table `<addonId>:addon-devices`. Addon-level settings had
the same split: hub-main rows `<addonId>.<field>` of `addon-settings`, a runner's
`<addonId>:addon-settings` / `root` blob, and sections in `system-settings` versus a
runner-only `sections` table.

On 2026-10-17 a migration wrote the hub-main store while the recorder (a runner)
read its blobs: every camera read as unconfigured and **all recordings stopped for
about 35 minutes**. The runner's read also answered `{}` when the store did not
answer (a D49 violation) and its write swallowed the error; hub-main's
`writeDeviceStore` was a `deleteWhere` followed by N separate `set`s, so a reader (or a
crash) could see a device with half its settings.

Tried and rejected: a refusal list of retired collection names in the engine and a
guard that the retired names never reappear. Removing the declarations and using the
standard API leaves nothing to refuse; a list of names is a second place to forget.

## Decision

**Every process reads and writes each kind of setting through ONE module over ONE
table; the view a forked runner offers is the same code as hub-main's, over its
settings-store client.**

| kind | table | row | module |
| --- | --- | --- | --- |
| per-device | `addon-device-settings` | `<addonId>:<deviceId>.<field>` -> `{ addonId, deviceId, key, value }` | `kernel/device-settings-store.ts` |
| addon-level | `addon-settings` | `<addonId>.<field>` -> `{ addonId, key, value }` (hub-main's layout) | `kernel/addon-settings-store.ts` |
| sections | `system-settings` | `<section>.<key>` | `kernel/sections-store.ts` |

Everything else is a CUSTOM collection of an addon with a special job.

The modules hold the rules that were learned the hard way: a read is three-way
(present / absent / unreadable) and a failed read is **never** `{}`; a write is ONE
`transact` (upserts and removals together; a field set to `undefined` is removed);
a merge never reads, so two writers touching different fields cannot overwrite each
other; errors propagate. `device-settings-store.ts` is the only module that names
`addon-device-settings`. A read of a table nobody wrote answers absent and **does not
create it** (`count`/`get` on an undeclared scoped name used to run `CREATE TABLE`).

**Per-camera state that lived in a side collection is a key of the camera.** Moved and
their declarations removed (no fallback in code):

| was | now (key of the camera's settings) |
| --- | --- |
| `stream-broker:probe-snapshots` | `stream-broker:<id>.probeSnapshots` = `{ camStreamId: snapshot }` |
| `stream-broker:profile-map` | `stream-broker:<id>.brokerProfile` = `{ map, auto }` |
| `stream-broker:rtsp-tokens` | `stream-broker:<id>.rtspTokens` = JSON text of `{ camStreamId: token }`, a **secret**: declared in `secretStatePaths`, so the row holds a keychain marker (scope `device/<id>`, D787); a locked keychain refuses the write |
| `notification-center:device-mutes` | `pipeline-analytics:<id>.notificationMuted` = `{ mutedAt }` (the notification centre runs inside pipeline-analytics; it stays the authority of the switch, D62) |
| `recorder:recording-configs`, `pipeline-orchestrator:device-features` (empty legacy of D865) | declarations removed |

`secretStatePaths` therefore also names hidden credentials in the per-device store.

The central delete (D865) is `clearDeviceSettings(door, deviceId)` for every addon,
in one statement. What the keys do not cover is removed by `device-removal-hook`
implementers: **stream-broker** (streams, slot assignments, its override entry) and
**pipeline-analytics** for the notification centre's device rows (`device-alerts`,
`liveness`, `system-state`, `snoozes` and their suppressed rows, `occupancy`,
`track-groups`, `artifacts`). `readDeviceStoreBatch` and `listDeviceStoreIds` are
required on every settings view; every caller's fallback is deleted.

## The migration (one-shot, operator-run, never by an agent)

`scripts/hub/migrate-device-store.ts` (logic in `device-store-migration.ts`) — `--server` <!-- drift-ok: deleted 2026-10-22 -->
is REQUIRED, input travels on stdin (never argv), output is counts and keys.

**Truth per addon: the source the RUNNING build read.** A forked addon read its BLOB; a
hub-main builtin reads the hub rows. The hub-main set is DERIVED from `addons.list` with the
rule the addon reference is generated from (a `@camstack/system` builtin without
`execution.isolate`; `--hub-main-addons` can only ADD), never hard-coded: `local-network`,
`local-auth`, `alert-center`, `backup-orchestrator`, `core-blocks`, `calendars`… all read the
hub rows, which are live truth for them (never "hub-only"), and the verify covers them on
both sides. A hub
row with a different value is REPLACED (listed by key); a hub row with no counterpart on
the truth side was never in effect (e.g. `pipeline-analytics:101.zoneMembershipMinOverlap`)
and would go live, so `--copy --apply` REFUSES until the operator passes
`--hub-only delete|keep`. The stale D865 rows of `recorder` / `pipeline-orchestrator` are
ordinary instances of this rule; the legacy `recorder:recording-configs` and
`pipeline-orchestrator:device-features` rows are only REPORTED (the running builds did not
read them). Keys of `RETIRED_SETTINGS_KEYS` are never copied.

**The exact order.** On EACH node the copy is APPLIED before the new build starts there: a
forked addon of the new build REFUSES to start while its blobs are unmigrated (the boot guard),
so a new build started first only fails its addons until `--copy --apply` ran. Do the dev hub
(.50) completely, then the production hub, then the agents. For each hub:

1. OLD build, addons RUNNING: `--snapshot`. It uses old-build routes only (`settingsStore`
   `query`/`get` by name for the raw blobs and hub rows, the addons' own live answers incl.
   every RTSP entry) and aborts on ANY read error — a stopped addon must never produce a
   snapshot.
2. Stop the addons on that hub AND on its agents (nothing may write a blob from now on).
3. Install the new closure on the hub (hub-main starts; its forked addons refuse, by design).
4. `--copy` (dry run, read it), then `--copy --apply [--hub-only delete|keep]`: the WHOLE plan
   (every addon, conflicts, hub-only rows) is computed and validated before the first write,
   and refused up front; then chunks of at most 500 records, idempotent on rerun, each addon
   re-read through the SAME module path and compared. Tokens go through
   `keychainAdmin.importSecret`; idempotent (a keychain already holding the identical value
   only has its row rewritten), a failure is reported per camera with its reason, and a camera
   whose token row already exists is reported, not skipped silently. Blobs are kept.
5. Start the addons on the hub. **Boot guard:** a forked addon whose per-addon blobs hold
   settings the copy would migrate (numeric device ids with a non-empty record, non-retired root
   keys) while the standard store holds none of its own logs an ERROR and REFUSES to start
   (`legacy-blob-guard.ts`) — never a silent run on "absent"; rows the copy skips anyway do not
   refuse it.
6. Install the new closure on each agent and start it (the copy already applied).
7. `--verify`: "before" is the hash of the raw old blobs/hub rows per the truth rule and the
   addons' own answers; "after" is the standard rows read through the addons' modules plus
   the same answers. ANY error on either side fails (ERR never equals ERR). The live reads
   that prove each addon's EFFECTIVE configuration (`LIVE_READ_COVERAGE`): `recorder` →
   `recordingArchive.getDeviceConfig`, `pipeline-orchestrator` → `zones.listZones`,
   `stream-broker` → `streamBroker.getDeviceSettingsContribution` (+ profile slots + every RTSP
   entry), `pipeline-analytics` → `notificationRules.listDeviceMutes`, `device-manager` and every
   contributor to the settings aggregate (`motion-wasm`, `audio-analyzer`, `detection-pipeline`,
   the exports, `homeassistant-export`, `snapshot`, `camera-grid`) →
   `deviceManager.getDeviceSettingsAggregate`. An addon with device settings and no entry (e.g.
   `local-network`) is printed at snapshot time as NOT COVERED: its stored fields are compared,
   its behaviour is not proven.
8. `--delta` (legacy rows an OLD build wrote after the copy: must be empty).
9. 48 h soak, `--verify` again.
10. `--drop` (dry run), then `--drop --apply` (needs a verify 48 h newer than the copy):
   `storageAdmin.dropCollection({ collection, expectRows })`. The ENGINE refuses anything but
   `<owner>:(addon-settings|addon-devices|sections)`, the six retired collections by name and
   tables of owners that are not installed (refusing when it cannot read the installed list),
   a table an addon declared since boot, and a wrong row count. `--orphan-owners` names the
   gone owners (`advanced-notifier`, `addon-pipeline`). `storageAdmin.listTables` is read-only.

The hub-main addon set is derived from `addons.list`, saved with the snapshot, and every later
step refuses to run when it differs; every run aborts when a builtin the checkout declares
hub-main is missing from it (a builtin that failed to load must not silently become "forked");
`--allow-missing-builtin <id>` is for one a server knowingly lacks, `--allow-hub-main-change` for a
builtin the new build adds between the snapshot and a later step (printed as a warning).

Rollback before step 10: reinstall the previous closure; the blobs are intact. After step 10
there is no way back but a backup. **Do not delete orphan secrets in System → Secrets until
`--verify` passes**: until the drop, the usage check also reads the old blobs, so a secret
only an old blob points at shows as in use.

**Locked or missing keychain at broker start.** The broker is NOT refused: every camera's
streams and recording run. A camera whose tokens exist but cannot be read gets NO restream URL
(no temporary EXTERNAL token is minted — it would die when the real one is restored) and no token
write. The broker's own consumers (recording, decode, snapshots, grid, WebRTC and egress) still
ride the restream through an EPHEMERAL internal alias token that is registered beside the external
one, never listed, never persisted, never returned by a consumer URL API (`getEntry`,
`getAllEntries`, `getEntriesForDevice`) and answered only to loopback / local-network peers (RFC 1918, link-local, ULA and CGNAT/Tailscale
`100.64.0.0/10`; under a Docker bridge with the userland proxy every peer appears as `172.17.0.1`, so
the filter then cannot tell a LAN peer from a public one - run the hub with host networking or a
source-address-preserving mode)
(`getInternalEntry` is what in-process lookups use); recovery adds the external entry with the
stored token and leaves brokers and the alias untouched;
the alert says its RTSP restream URLs are unavailable, consumers such as Home Assistant or an
NVR get errors, until the keychain is readable; an ERROR log tagged `{ deviceId }` too. The check
repeats on a keychain change and every 30 s; once the value resolves ONLY that camera's
restreamers are registered with its stored tokens (no broker teardown, no recording gap) and the
alert clears. A secret that is MISSING (deleted, or the keychain restored without it) needs TWO
consistent `missing` reads (D49), then the camera is released: fresh tokens are minted and
PERSISTED at once, the alert says new URLs were issued (update NVR/HA), and the re-check stops
for that camera (`rtsp-token-recovery.ts`, the manager's restream gate).

**Hub restarting under a booting runner.** `classifyStoreError` retries only explicit signals
(socket error codes, tRPC unavailable codes, Moleculer errors marked `retryable` or typed
`REQUEST_TIMEOUT`/`SERVICE_NOT_FOUND`/`SERVICE_NOT_AVAILABLE`, and the exact phrases our transport
raises, e.g. `UDS request timed out after Nms`) for about
100 s; `settings store not wired` and any unknown error fail fast.

**Marked for removal once every hub ran `--drop`:** the script, `storageAdmin.dropCollection`,
`keychainAdmin.importSecret` (restricted to `secret://stream-broker/device/<id>/rtspTokens`,
refuses to overwrite) and the boot guard. (`storageAdmin.listTables` may stay.)

## Release checklist (the reviewer's .50 test plan)

On the dev hub .50 before any other node:

1. **Capture** with the OLD build running: recorder configs, broker contributions and profile
   slots, every RTSP URL, device mutes, zones, detection / pipeline-analytics per-device
   settings, HAP / Alexa globals (`--snapshot` takes these; keep the RTSP URLs list).
2. Stop the addons (hub and agents), install the new closure, `--copy` (read the dry run),
   `--copy --apply`, start the addons.
3. Within 2 minutes the recorder writes per `deviceId`; every old RTSP URL still plays; the
   mutes hold; `--verify` answers are equal.
4. Repeat the cut-over with the keychain LOCKED: every stream and the recording keep running,
   the held cameras have NO restream URL and a token alert (exact text above), no token changes;
   once unlocked only those cameras' restreamers are registered with the stored tokens (no broker
   restart, no recording gap), the alert clears and the old URLs play again.
5. Restart the hub with an agent up: the agent's runners come up (the settings read rides
   out the restart).
6. `--delta` is empty.
7. `--drop` as a DRY RUN only on .50.

## Consequences

- A new per-device or addon setting goes through `ctx.settings` and nowhere else; a
  collection keyed by a device id that is configuration or a mirror is refused by
  `scripts/check-device-settings-standard.ts` (now also `cameraId` and `<deviceId>/`
  keys). Its OPEN allowlist entries are gone.
- A runner's `getSection` now reads the `system-settings` rows of the section (policy
  filtered, like hub-main). The config.yaml-owned part of a bootstrap section still lives
  in the hub process alone.
- `ISettingsStore.getAddonDevice/setAddonDevice/clearAddonDevice`,
  `SqliteSettingsBackend`'s device methods, the `__device-state` read fallback,
  `addon-devices` as a canonical collection and `retire-root-keys` are deleted.
  `<addon>:addon-devices` stays READABLE by name until the drop so the script can copy it.
- The capability is `storage-admin` (a new internal capability on the SQLite engine),
  not an addition to `settings-store`: the door's method set is kept identical to the
  engine contract, and these two are maintenance, not data access.

## Enforcement

- `packages/system/src/kernel/__tests__/device-settings-contract.ts` run by
  `device-settings-contract.spec.ts` on REAL SQLite against hub-main's view AND a runner's
  view bound to the same file: absent vs unreadable, concurrent merges on different
  fields both land, list, batch, clear, central delete visible from both, a write in one
  view read from the other, addon settings and sections the same way. Disarms: a runner
  pointed at another collection turns the cross-view checks red; a `transact` split into
  separate statements turns "crash between delete and write" red.
- `scripts/__tests__/migrate-device-store.spec.ts` against a fake hub; skipping the <!-- drift-ok: deleted 2026-10-22 -->
  read-back turns "a write that did not land is caught" red.
- `packages/types/src/addon/__tests__/device-secret-state-paths.spec.ts` (a token is never
  stored as plaintext; a locked keychain refuses), `storage-admin.spec.ts` (a read never
  creates a table; drop refusals).
- `legacy-blob-guard.spec.ts` and the runner-context spec: blobs with an empty standard store
  refuse to start; `settings-read-retry.spec.ts`: a hub restart under a booting runner is
  ridden out, a hub that stays away fails the start after a bounded wait.
- `rtsp-persisted-state.spec.ts` / `rtsp-token-recovery.spec.ts`: a locked keychain blocks only the
  held camera's token writes (alert + tagged log), recovers without a restart, and a MISSING
  secret releases the camera with a re-pair alert.
- `migrate-device-store.spec.ts` validates EVERY input the script sends against the real cap
  schemas (an explicit `null` for an optional-input route is rejected).
- The migration spec's fake follows the REAL endpoints (an old build has no `storageAdmin`;
  a forked addon's running build reads its blob and never falls back): a snapshot with a
  stopped addon fails, `ERR` is never equal to `ERR`, the blob beats a stale hub row.

