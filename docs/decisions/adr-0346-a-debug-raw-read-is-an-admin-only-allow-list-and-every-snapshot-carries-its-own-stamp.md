---
id: D346
title: A debug raw read is an admin-only allow-list of reads, and every snapshot group carries its own freshness stamp
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/raw-read.ts
  - packages/addon-provider-reolink/src/snapshot-freshness.ts
  - packages/addon-provider-reolink/src/debug-actions.ts
---

## Context

The OSD incident (see the two 2026-09-04 session entries) cost hours for one
structural reason: when CamStack's settings form and the camera disagreed
("channel-name overlay ON" vs the camera's OFF), there was **no way to see the
camera's own answer**. Every `deviceCache.*Snapshot` group is a projection —
`osdSnapshot` keeps 7 fields of the lib's `OsdConfig` and discards the rest at
read time — so the only recourse was turning on Baichuan tracing and reading
raw socket logs by hand. And the cache carried **one `probedAt` for 24 snapshot
groups**: an operator could not tell whether `encSnapshot` was read a minute
ago or frozen at adoption three months earlier. Only `osdSnapshot` had its own
`fetchedAt`, added by that day's fix.

Alternatives actually on the table:

- **A device custom action** (the `refresh-settings` / `refresh-sessions`
  shape). Rejected on auth: `deviceManager.runDeviceAction` is mounted
  `protected` and its dispatcher (`BaseDevice.runDeviceAction` →
  `dispatchDeviceAction`) never evaluates the per-action `auth` field — a raw
  camera payload would have been reachable by any authenticated viewer. The
  addon `customAction` path (`addons.custom` → `dispatchCustomAction` →
  `ensureCustomActionAuth`) is the one operator surface that enforces
  `auth: 'admin'` server-side AND validates output against the catalog.
- **Redacting secrets out of raw payloads by key blocklist** (strip
  `password`, `token`, …). Rejected: a blocklist is wrong the first time a
  firmware spells a credential field differently. The guarantee has to come
  from what CAN be asked, not from what is filtered out of an answer.
- **Embedding `fetchedAt` inside each snapshot object** (the `osdSnapshot`
  shape, times 24). Rejected for the general case: it touches every group's
  schema, scatters the stamp across four persist sites in four spellings
  (`fetchedAt`, `lastReadAt`, per-cap `fetchedAt`, nothing), and gives readers
  no single place to ask "how old is each group?".

## Decision

Two rules.

**A raw-read debug surface is an allow-list of reads, admin-only.** The input
names a slice from a closed enum; each slice maps to a vetted lib `get*` call
in `RAW_READ_CATALOG`. The catalog IS the security boundary: a command that
echoes auth material (Reolink's `getEmail` returns the camera's SMTP
credentials) is simply not in it — stripping is done by allow-list, never by
blocklist. The surface writes nothing (not even the cache), is dispatched as
an addon `customAction` with `auth: 'admin'` because that is the only mount
that enforces per-action auth, and its sleep gate runs BEFORE any login — a
sleeping battery camera refuses loudly (info, tagged `deviceId`) and still
reports the believed state, because on a UDP battery cam the login is the
wake (D173-family). Every answer carries both sides: the unprojected library
response and the persisted projection with its freshness, so a disagreement
is visible in one call.

**Every snapshot group carries its own freshness stamp, written where the
group is written.** `deviceCache.snapshotFetchedAt` maps each group's field
name to the wall-clock ms of its last successful camera read; every persist
site stamps exactly the keys it wrote (`stampSnapshotFreshness`), so a failed
probe keeps its old stamp and its staleness stays visible. This is D224
generalised — a device fact carries its own window. A group with no stamp is
of UNKNOWN age and must never render as fresh; an absent group is NEVER READ
and must never look like read-and-empty (the D315/D337 tri-state). The ages
are operator-readable per fact (the "Snapshot freshness" settings panel and
the raw-read `believed.age`).

### Amendment, 2026-09-05 — the `battery` slice

Adding the `battery` slice (to settle whether the hub CGI's `adapterStatus`
is a real signal or a constant — it was readable exactly once per hub
process, via `ReolinkHub.batteryShapeLogged`) broke two assumptions the
original fifteen slices shared. Both are now explicit in the catalog rather
than implied:

- **Not every belief lives in `deviceCache`.** There is no battery snapshot
  field; what CamStack believes about charge is the `battery` capability's
  runtime state — the same value `battery.getStatus` serves. A catalog entry
  therefore names a `BelievedSource` (a discriminated union: `deviceCache`
  with a `snapshotKey`, or `capRuntimeState`), and no fake cache key was
  invented to keep a `keyof ReolinkDeviceCache` type happy. Its age comes
  from the slice's `lastUpdated`, and the `empty` seed (`0`) resolves to
  `never`, not to "measured at the epoch" — on a battery reading the
  difference between unknown and 0% is an alarm (D315).
- **One slice can be two firmware reads.** "What is the charge state?" is
  answered by `getBatteryInfo(channel)` on a standalone camera and by the
  hub-level `getAllChannelsBatteryInfo()` — a channel-keyed CGI, projected
  to the requested channel — on a hub child. The entry picks the call from
  a `RawReadInvokeContext`, so the slice stays per-camera and the fifteen
  single-call entries keep their signature. The answer is returned as the
  firmware gave it, under a `readVia` naming the path: the two vocabularies
  do not overlap (`voltage`/`lowPower` one side, `channelsReported` and the
  channel-status row the other), and normalising them into a shared shape
  would invent the fields one side does not send. A field the firmware
  omitted is ABSENT, never defaulted — the difference between "not sent"
  and "read as none" is the whole evidentiary value of the slice.
- **The sleep gate protects the camera's radio, not the process.** The hub
  read is answered on the hub's own mains-powered socket and never
  addresses the sleeping channel, so a hub CHILD is served while asleep
  (`servedByParentHub` + `hubChild`) — refusing would hide the only battery
  value that still moves while a hub child sleeps. A STANDALONE camera keeps
  the gate: its own login IS the wake, so it is readable awake and refuses
  (loudly, with the believed state) asleep. The flag is optional on purpose,
  so a future entry that forgets it inherits the conservative behaviour.
- A channel the hub did not report is a REFUSAL naming the channels it did
  report, never an empty payload that reads as "no battery"; and the hub's
  channel-status row is emitted without its Reolink P2P `uid` (stated as
  `uidRedacted`, so a dropped field and an absent one stay distinguishable).

## Consequences

- Extending the raw-read surface means adding a catalog entry — and vouching
  that the command's reply carries no auth material. There is no generic
  "run this Baichuan command" escape hatch, on purpose.
- The email/SMTP config is not raw-readable. Its projection
  (`emailConfigSnapshot`) remains the only view, by design.
- Four persist sites carry the stamp call; a new snapshot writer must call
  `stampSnapshotFreshness` or its group reports "age unknown" forever — which
  is the honest failure mode, not a broken one.
- The pre-map stamps (`osdSnapshot.fetchedAt`, `emailConfigSnapshot.
  lastReadAt`, per-cap `capOptionsSnapshot[*].fetchedAt`) stay authoritative
  as fallbacks so caches written before the map still report real ages.
- `ReolinkProviderAddon` composes its customActions at the `initialize()`
  seam because `BaseDeviceProvider.onInitialize` is typed
  `ProviderRegistration[]` and eleven sibling providers push onto it —
  widening that signature would have been a framework change for a type-only
  gain.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/raw-read-debug.spec.ts` proves
the catalog resolves through `get*` calls only (a recording proxy throws on
anything else), that the credential-echoing reads are not slices, that a
sleeping cam never reaches `getApi` for any camera-addressed slice (swept
over the whole enum, so a new slice cannot quietly claim the hub exemption),
that the hub-answered `battery` slice IS served on a sleeping hub child and
still refused on a sleeping standalone, that a hub child issues
`getAllChannelsBatteryInfo` and a standalone issues `getBatteryInfo` (asserted
on the recording proxy's ACCESS log, so a path that reads the wrong call
fails), that a field the firmware omitted stays absent, that an unreported
channel refuses with the channels it did report, that the channel `uid` never
reaches the payload, and that `debugRawRead` declares `auth: 'admin'`. `snapshot-freshness.spec.ts` pins the tri-state (an
unstamped group is `unknown`, never fresh) and structurally pins all four
stamp sites. RED-proven: removing the sleep gate, the bulk stamp, or the
unknown-state arm each fails the suite.
