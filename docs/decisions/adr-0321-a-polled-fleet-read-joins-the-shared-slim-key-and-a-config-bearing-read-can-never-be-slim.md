---
id: D321
title: A polled fleet read joins the SHARED slim key — and a config-bearing read can never be slim
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/ui-library/src/composites/device-export-panel.tsx
  - packages/addon-terminal/src/terminal-instances.ts
  - packages/addon-admin-ui/src/pages/system/Terminal.tsx
---

## Context

The 2026-08-31 timer-driven-collection-reads audit — written on a later branch
than this one, so its file is not yet present here — listed seven timers
driving a whole-collection read.
Three were said to resolve to `deviceManager.listAll` — a full-table
`SELECT … ORDER BY "deviceId"`, ~1 017 rows a call
(`device-row-store.ts:554`), measured that day at **5.6 s** full and **2.9 s**
slim against `/health` at 0.055 s.

The operator's direction on these three was explicit, and it is the opposite of
D320's Refresh-button remedy:

> *"Va bene il refetch continuo, ma devono essere query ottimizzate al massimo,
> cachate dove possibile."*
>
> [Continuous refetch is fine, but the queries must be optimised to the maximum, cached where possible.]

So the job was to make the QUESTION cheap, not to stop asking it. Tracing the
three found that only ONE was the defect the audit described.

**#1, `device-export-panel.tsx:278` — real, and the worst of the seven.**
`useDeviceManagerListAll({})` every **5 s**: the unprojected fleet, on a
PRIVATE query key (no other caller passes `{}` with a timer), and the full
projection costs twice — every device's `config` blob on the wire, plus a
second sequential settings-store phase server-side to produce it
(`device-queries.ts#readDeviceConfigs`). The panel renders a twelve-field row
parse; `config` and `metadata` were never in it.

**#5, `IntegrationDetail.tsx:220` — the audit's premise is FALSE.** It was
described as "deliberately non-slim per its own comment". The comment says the
opposite, and has since 791cf8f9a (2026-08-27): the page asks
`{ projection: 'slim' }` *so that* it shares one cache entry with Devices,
GlobalSearch, ScanNetworkModal and ScopePreview. The audit read
*"rather than paying its own full, non-slim fetch"* as a confession.

**#3, `Terminal.tsx:186` — mis-attributed, and slim would have DELETED it.**
`terminalSession.listLegacyCameras` does reach `listAll`, but as
`listAll({ addonId })` — the INDEXED `listByAddon` branch, Terminal's handful of
rows, never 1 017. Its real cost is the SECOND phase: the full projection
reaches `settings.readDeviceStoreBatch`, whose door implementation
(`settings-door-view.ts:100`, and D181 guarantees the door and not the sync
store on hub-main) is ONE `whereBetween` over the entire `device-manager:`
prefix of `addon-device-settings` — every device on the hub, to answer about
four — followed by a JS group-by that discards the rest. That query names no
`limit`, so `resolveRowBound` caps it at `SETTINGS_QUERY_DEFAULT_ROW_CAP` and
hands back a map in which every device past the cap carries `config: {}`. That
is D320 §6's defect; it is **still live on this branch** and is not fixed here.

And the trap: `projection: 'slim'` is the obvious optimisation for #3 and it
would have emptied the section. `listLegacyTerminalCameraCandidates` builds
every rendered field out of the device's `config` — `nodeId` (absent ⇒ skip the
row), `profileId`, `profileLabel` — and slim returns `config: {}`. A slim
answer is **shape-identical to a fleet with no legacy cameras**, and the drop
was silent: not one log line.

**What was tried and reverted.** Making `readDeviceConfigs` fan out — for a
handful of named ids, one concurrent `readDeviceStore` per device instead of
the whole-prefix batch — removes the fleet-wide scan, cannot be truncated, and
is ONE wave, so the caller still pays a single sequential store phase (D317).
It went red against `device-children-store-reads.spec.ts`, which pins
`getChildren` / `getChildrenBatch` at exactly ONE door round trip. That
invariant is a measured, shipped decision (896 children, all forked-owned, one
read each) and `getChildren` is boot-frequency: 1 024 calls in a 120 s boot
window would have become ~4 000 store requests, and queue DEPTH is what
saturated the store. The change was reverted rather than the test edited.

## Decision

**A polled fleet read in a UI joins the SHARED `{ projection: 'slim' }` key,
and polls at the fleet window.** Not a private key, not a private cadence: the
window `applyFleetQueryDefaults` registers
([D274](./adr-0274-the-fleet-list-window-is-owned-by-the-query-client.md)) is
the rate at which every consumer of that key is already willing to see a
change, and a surface polling 6× faster is asking a question nobody else thinks
needs asking that often.

**A read whose consumer reads `config` can never be slim, and it says so at the
function that reads it.** `projection: 'slim'` returns `config: {}`, which is
indistinguishable from a device with no stored settings — so narrowing such a
read does not degrade the answer, it deletes it. The refusal is documented on
the CONSUMER, not on the call site where it would rot, and the drop it would
cause is made LOUD: a row that looks like a candidate and is missing the config
field the answer is built from is reported per-row with `tags.deviceId`.

**A read that is already the shared narrow question is left alone, and the
stale note is corrected rather than the code.** Narrowing IntegrationDetail to
`{ addonId }` is wrong twice — it mints a private key, so a warm client pays an
extra fleet-shaped read instead of zero, and it drops the cross-integration
rows `parentById` and `<DeviceList>`'s container `effectiveType` resolve
against.

## Consequences

- **#1.** `{}` @ 5 s → `{ projection: 'slim' }` @ 30 s. Per-minute fetches for
  this panel: **12 → 2**, and **0** while any of the five sibling surfaces on
  the same key is mounted inside the window. Server-side the call drops from
  two sequential settings-store phases to one, and from ~1 017 `config` blobs
  to none. `sourceInfo` leaves the panel's row schema: slim does not carry it,
  and its only reader is `resolveContainerPrimary`, reached from a `container`
  row — a type no `device-export` provider declares
  (`HAP_EXPORTABLE_DEVICE_TYPES` is eight leaf types; Alexa's is
  `['camera','doorbell']`). **If a provider ever declares `container`, this read
  must stop being slim in the same commit.**
- **#3.** The projection is unchanged and now defended. The cadence moves
  10 s → 60 s, which is a CADENCE change and not a cheaper question — it is the
  only lever available from this side while the `device-manager:` prefix read
  is unbounded, and it should go back the moment that read is bounded. The
  operator's on-demand paths are untouched: the page's Refresh already refetches
  this query, and adopting a monitor refetches it directly.
- **#5.** No code change; the shape is pinned so the stale note cannot drive a
  future "fix".
- **The whole-prefix `readDeviceStoreBatch` read is the largest thing still
  owed**, and it is D320 §6's line, not this record's. Every FULL-projection
  `listAll` — including `listAll({ addonId })` about four devices — reads the
  entire fleet's `device-manager:` device-settings range, unbounded, and is
  silently cut at 2 000 rows. Bounding it fixes #3 properly and every other
  `listAll` caller with it.

### Should `listAll` itself be cheap — the verdict

**The row read is already as narrow as the contract allows.** `listFleet`
pushes `deviceIds` down as a `whereIn` and `slim` down as a column projection.
`isCamera` provably cannot be pushed down
([D311](./adr-0311-a-ui-reads-the-fleet-through-the-hook-and-the-boot-gate-waits-for-the-probe.md)):
for a hub-live device it is `getStreamSources()` presence, not the persisted
`type`, so a `where type = 'camera'` strips exactly the doorbells that carry a
camera, and `toDeviceInfo` reads `name`/`location`/`disabled` from the ROW —
they would start reporting pre-rename names. So a projected read is available
today and every polled caller should be taking it; that is what #1 now does.

**Column projection cannot make it cheap, because the rows still have to
exist.** With the store healthy at ~0.2 s a call, 2.9 s slim is not one store
tick. The remainder is hub-main materialising 1 017 rows (`decodeDeviceRow`
plus a `JSON.parse` per JSON column), building 1 017 `DeviceInfo` objects and
serialising ~430 KB.

**The only shape that removes that is the one D317 already sanctions one layer
up: the OWNER maintains the snapshot and serves reads from it.**
`DeviceRowStore` is constructible exactly once
(`device-manager.addon.ts:498`), is the sole writer of
`device-manager:devices`, and every cross-process caller reaches it in-process
over the cap channel — so a write-through row index there is the `mirror` of a
collection it already owns, not a consumer cache
([D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
permits the owner; it forbids the consumer). Its cost, stated so the next
session does not re-derive it:

- **RAM**: ~1 017 decoded rows, ~2–3 MB at the full shape. Bounded by the fleet
  an operator configures.
- **Correctness**: sound only while `DeviceRowStore` is the sole writer. Every
  mutator (`upsert`, `patch`, `setMetadata`, `delete`, `updateWhere`) must write
  through, and an out-of-band write — a restore, a migration, a
  `retired-settings-keys` purge — must invalidate it. A stale index does not
  fail loudly: it shows a pre-rename name, or drops a device, which is the
  `EditableNameRow` failure mode D311 recorded, with no upper bound on how long
  it lasts.
- **Obligation**: it becomes a declared `@durable class=mirror` with a periodic
  full refresh, and needs a guard that a new mutator cannot bypass it.

That is a real change to the device ledger with a silent failure mode, and it
is deliberately NOT taken in the same pass as three call-site fixes.

## Enforcement

Tests, each confirmed RED by reverting the line it guards:

- `packages/ui-library/src/composites/__tests__/device-export-panel-fleet-read.test.tsx`
  — asserts the CALL (`{ projection: 'slim' }`, `refetchInterval: 30_000`, no
  `staleTime`/`gcTime`), because the rendered rows are identical under the full
  projection and a row assertion would prove nothing. It also renders the REAL
  `<DeviceList>` from a slim wire payload and requires the row and its Expose
  control to survive — green BEFORE the change, which is what makes it a
  no-field-lost proof rather than a restatement — plus a counter-test that the
  row parse actually drops a row missing an identity field, so "the slim row
  renders" is a fact about slim and not about a parse that accepts anything.
- `packages/addon-terminal/src/__tests__/legacy-camera-read-shape.spec.ts` —
  pins that a slim answer is shape-identical to "no legacy cameras", and that
  every candidate row dropped for want of `nodeId` is reported with its numeric
  device id while a non-candidate row stays silent (a 1 017-device fleet must
  not produce 1 017 lines to say none of them is a Terminal monitor).
- `packages/addon-admin-ui/src/pages/system/__tests__/Terminal.spec.tsx` — the
  legacy-list cadence, on the call.
- `packages/addon-admin-ui/src/pages/__tests__/IntegrationDetail.spec.tsx` — the
  shared slim key and the absent local window. Green before the change (nothing
  changed there); armed by trial regression — `{ addonId, projection: 'slim' }`
  and a local `staleTime` each fail it.

The removal of `sourceInfo` from the export panel's row schema has **no
behavioural arm** and is recorded as a leftover deletion: the behavioural claim
it rests on ("nothing on this surface reads it") is what the slim-render test
proves.

`scripts/check-fleet-query-defaults.ts` still passes — 3 query clients, 36
`useDeviceManagerListAll` call sites with no window of their own, 2 allowlisted
raw reads. No new guard: "a polled fleet read must join the shared key" is a
judgement about which key is shared, and D320 already recorded why a vague
guard for this family is worse than none.
