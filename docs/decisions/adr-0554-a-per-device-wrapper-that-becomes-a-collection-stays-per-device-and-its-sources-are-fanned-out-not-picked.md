---
id: D554
title: A per-device wrapper that becomes a COLLECTION stays per-device — its sources are fanned out, never picked, and a source that cannot answer says so in its own row
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/cap-router-predicates.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
  - server/backend/src/api/trpc/cap-router-runtime.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts
  - scripts/check-device-scoped-wrapper-mounts.ts
---

## Context

[D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
decision 2 settled WHAT slice 6 does: `videoclips` becomes `mode: 'collection'`
over a device's providers, `listClips` fans out and merges, `getClipPlayback`
dispatches by the id's provider prefix, no dedup, no best-source pick. It did
not settle HOW that reaches the router, and three things found while wiring it
were not knowable from reading:

1. **`resolveCapMount` checks `mode: 'collection'` BEFORE the device-wrapper
   rule [D552](adr-0552-a-device-scoped-wrapper-mount-dispatches-only-the-methods-that-name-a-device.md)
   added.** So the one-line change "make `videoclips` a collection" silently
   moves it off the per-device mount onto the GLOBAL collection mount: every
   registered provider fanned for every caller, `resolveCollectionForDevice`
   never consulted, and the per-method rule (`methodMountKindFor`, which only
   applies to `device-scoped`) gone with it. The commit that implements D549
   decision 2 would have undone D552 in the same breath.
2. **`getProviderForDevice` on a collection cap returns the FIRST registered
   provider** (`capability-registry.ts`: `resolveForDevice` answers `null` for
   any non-singleton mode, and the collection branch takes
   `state.providers.values().next()`). So even keeping the `device-scoped`
   mount, the existing dispatcher `requireDeviceScoped` would have served every
   camera from whichever addon booted first — the D62 single-answer shape
   again, and invisible because it still looks like a per-device call.
3. **`getBindings(deviceId)` cannot express two providers of ONE cap.** Its
   store is `deviceBindings[deviceId][capName] = { wrapperAddonId }` — a single
   value — and `resolveBindingsForDevice` pushes at most one entry per
   `capName` (`seenCaps`). D12's rule (per-device aggregation walks
   `getBindings`, never the global cap list) asks the right question; the
   answer that store can give is "which ONE", which is the swap D549 rejected.
   Also measured: nothing mirrors `setWrapperActive` into the registry at all —
   `registry.setDeviceOverride` has exactly two callers, both the admin
   `capabilities` router — so the persisted activation reaches the resolver
   through no path today. That is a separate defect, recorded here and not
   fixed in this slice.

## Decision

1. **The per-device mount wins over the collection mount.** `resolveCapMount`
   checks `scope: 'device'` + `kind: 'wrapper'` BEFORE `mode: 'collection'`. A
   cap's cardinality says how many sources ONE DEVICE has; it never says the
   cap left the device. Derived, not a per-cap hint, for D552's reason: the
   next device-scoped wrapper that grows a second provider must not be born
   broken.
2. **A device-scoped COLLECTION is dispatched by its own resolver**
   (`device-collection-dispatch.ts` `requireDeviceCollection`), selected in
   `getLocalProvider`'s `case 'device-scoped'` by the cap's mode. The sources of
   a device are `CapabilityRegistry.resolveCollectionForDevice` — the enabled,
   system-active providers narrowed by the per-device collection FILTER
   (`setDeviceCollectionFilter`) — plus the device's native provider first when
   it has one. Array-output methods fan across them and concatenate; scalar
   methods route by the source inside the id.
3. **The per-device authority for a collection cap is the collection FILTER,
   not the wrapper override.** `setWrapperActive`'s store holds one addon per
   `(device, cap)` and cannot hold two; reusing it would mean the first source
   hides the rest, which is exactly the staging the operator rejected. The
   filter is a VIEW narrowing — absent means "every source this camera has",
   which is the honest default for a surface whose whole point is that nothing
   is hidden. Wiring the picker to it (and deciding what it persists) is slice
   4's work; slice 6 makes the filter the thing the router reads.
   Alternatives rejected: (a) a second single-valued store beside the first —
   two authorities for one question, the defect this repo keeps paying for;
   (b) gating each source on `getBindings` — a settings-door round trip
   (measured 5.24 s for one device on the live hub, 2026-08-30) on the listing
   path, for an answer that cannot name more than one provider anyway.
4. **A source that cannot answer produces a ROW, not an absence.** The fan-out
   calls every source independently: a rejection removes that source's rows and
   nothing else, and is logged with `tags: { deviceId, addonId }`. For the
   source listing itself (`listSources`, the convention a device-collection cap
   declares) the failure BECOMES a row — `availability: { state: 'unreachable',
   reason: <the refusal, verbatim> }` — under the ADDON's id, because a
   provider that threw could not name its own sources. An empty list from a
   camera nobody could reach reads as "this camera has no recordings", and that
   misreading is what the whole external-videoclips line exists to end.
5. **A scalar call routes by the source named INSIDE the id, and an unclaimed
   id is refused.** The dispatcher asks each source which ids it owns
   (`listSources`) and matches the longest `source` that prefixes a top-level
   string field of the input; nothing claimed means `BAD_REQUEST` naming the id
   and listing the sources — never the first provider's answer, which is how a
   fabricated `addonId` once came back with another addon's data (D552
   consequences). A source that could not name its ids is not excluded on that
   basis (a read that fails destroys nothing, D49): it is used only when it is
   the single such source, and that is logged.
6. **One source is not a merge.** A device with exactly one source gets its
   provider's array verbatim, in the provider's own order, and its scalar calls
   go straight through with no `listSources` probe. Not an optimisation: it is
   the guarantee that every camera on the fleet — all of which have exactly one
   `videoclips` provider until slice 2 lands — answers exactly as it did
   before, including the order of two clips that share a `startMs`.
7. **The merge is newest-first by `(startMs, endMs, id)` and structural.** Rows
   that declare a `timeRange` are ordered; rows that do not (a source listing)
   keep provider order. No dedup and no best-source pick, per D549 decision 11:
   a clip in two storages is two rows, each naming its source.
8. **The collection `addonId` SELECTOR follows the mount, not the mode.** One
   shared predicate, `emitsCollectionSelector` (`cap-router-predicates.ts`),
   now answers "does this cap's router carry `addonId`" for both
   `generate-cap-routers.ts` and `generate-cap-mounts.ts`. A device-scoped
   collection must not advertise a routing key the runtime builder never reads
   — the type/runtime disagreement D552 removed from the mounts file would
   otherwise come straight back through the routers file.

## Consequences

- `videoclips` is the first `scope: 'device'` + `mode: 'collection'` cap. The
  registry already had the per-device collection half (`resolveCollectionForDevice`,
  `setDeviceCollectionFilter`); it had no caller until now.
- A cap method with no `deviceId` on a device-scoped collection resolves the
  cap's system provider through the GLOBAL collection mount
  (`systemMountKindFor`), which is the right destination and an odd pairing.
  `videoclips` has no such method and this slice adds none; a cap that grows
  one should state what it means first.
- `aggregateCollectionCall` / `addonPinOf` (the `ctx.api` → `onUnownedCall`
  path) now key off the effective MOUNT rather than `mode`, so a device-scoped
  collection is never fanned globally there. Without that the two paths would
  answer one camera with another camera's sources — the precise disagreement
  `aggregateCollectionCall` was written to end (2026-07-30, `notification-output`).
- The child UDS dispatcher's collection graceful-skip now covers
  `videoclips.listClips` / `listSources` (generated `COLLECTION_ARRAY_METHODS`):
  a provider bundling an older `@camstack/types` without `listSources` answers
  `[]` across that boundary instead of erroring the caller. In-process the
  dispatcher handles the same case itself (decision 5's fallback).
- **Not decided here, and it should be decided before slice 2 ships a second
  provider:** with no filter set, EVERY registered `videoclips` provider is a
  source of EVERY camera. Today that is one provider and the question does not
  arise. When the Reolink provider registers, a Hikvision camera will ask it
  for its sources and get `[]` — cheap and honest, but it is the provider's own
  device knowledge doing the gating, not the operator's. The alternative is to
  make slice 4's picker write a filter for every camera up front, which is a
  store nobody has asked for yet.
- **Also not decided here:** no per-source TIMEOUT. `Promise.allSettled`
  isolates a source that FAILS, not one that hangs — a slow source still delays
  the whole answer. A bound needs a number nobody has measured on this path;
  slice 2's provider owns its own I/O deadlines, and if a fan-out-level bound
  is ever needed it must arrive with the measurement, not with a round number.
- `setWrapperActive` still reaches no resolver (Context 3). The binding UI
  writes a store the router does not read — for collection caps it is now the
  wrong shape as well as unread. Slice 4 must close it or say why not.

## Amendment, 2026-09-20 — a device's SOURCES are its BINDINGS, and the list is asked of ONE provider

The first live run answered `videoclips.listSources({deviceId: 107})` with FOUR
rows, three of them `analytics`:

| source | addonId |
| --- | --- |
| `analytics` | `native` |
| `analytics` | `pipeline-analytics` |
| `analytics` | `pipeline-analytics@agent-a` |
| `native:reolink:onboard` | `provider-reolink` |

One addon reached the dispatcher three ways: as the device's NATIVE provider
(asked separately, D556 decision 5), as the hub-local registration, and as the
same addon on the agent node under the `<addonId>@<nodeId>` key;
`capabilities.getCapability` listed a fourth on the Mac node.
`listClips` was triplicating every row underneath them, which nobody had looked
at. In a picker that is three tick-boxes for one thing — D62's "a switch that
does something other than its label" with the polarity reversed — and D556's
per-source deny key cannot express it either, because all three rows carry the
same source and the key IS the source.

**The cause is that decision 1 enumerated REGISTRATIONS.** The framework already
answers "which providers does this device have": the device's BINDINGS
(`deviceManager.getBindings`), which every per-camera switch and every D12
aggregate decides on and which `setWrapperActive` (D62) is the authority over.
A binding is one per `(device, cap, provider)`, so three rows for one provider
stop being REPRESENTABLE — there is nothing to de-duplicate after the fact, and
the list means what the operator says it means: *"una source esiste perché una
configurazione altrove ce l'ha messa"* [a source exists because a configuration elsewhere put it there]. `sourcesForDevice` now reads the
bindings; the registration walk survives for exactly one caller, the failure
path, because a bindings read that fails must not empty a camera (D49) — an
empty source list reads as "this camera has no recordings", which is the defect
this line of work exists to end.

**And the fan-out is not what the surface wants.** Operator, 2026-09-20: *"il
get videoclips prendere un provider opzionale, di default va su camstack"* [the get videoclips takes an optional provider, by default it goes to camstack],
*"l'utilizzatore è uno solo"* [there is only one consumer]. `listClips`'s `sources?: string[]` view filter is
replaced by `provider?: string` — one addon id, from a `listSources` row, absent
meaning the device's bound provider (CamStack on every camera today, because
that is what `getBindings` answers with). A pin the device is not bound to is
refused BY NAME, never served by another provider (D552's
`rejectUnresolvedAddonPin` rule). The provider-side half of the old filter went
with it: a filter in `addon-provider-reolink` could only ever say "not me",
which the router now says first and by name.

**And there is no enable/disable.** *"tutti i providers funzionano sempre, non
serve disattivarli/attivarli"* [all providers always work, there is no need to deactivate/activate them]. The per-source deny set, `ClipSource.switchedOff`
and the listing's `includeSwitchedOff` are gone from the dispatcher, with
`withoutCatalogAge` and the "every source is switched off" branch. `setWrapperActive`
itself stays — it is the pre-existing authority that decides whether a wrapper
wraps a camera at all, and it is exactly what makes a binding-derived list
correct.

**What of decision 1's own machinery survives.** `getBindings` step 0 answers
SEVERAL providers per collection cap, so `fanOut`, `mergeRows` and the
`claimsOf`/`ownerOf` scalar probe are live again on any camera with more than
one bound provider — which, once `provider-reolink` registers `videoclips`, is
every Reolink camera. Only the deny-set half of decision 1 is dead, and it is
deleted rather than left inert.

### The binding set — closed the same day

`getBindings` answered ONE entry per `capName`, and for `videoclips` it was
`pipeline-analytics` on every camera, because `setWrapperActive`'s collection
branch wrote `disabledSourceIds` and never `wrapperAddonId`. **Nothing bound
`provider-reolink` for `videoclips` anywhere on the fleet** — under the
deny-set design its source was reachable only because the dispatcher ignored
the bindings. Binding-derivation alone would therefore have made it vanish
fleet-wide. That is now closed, and the shape it closed into answers the two
questions it raised:

**What "bound" means for a collection cap: a DERIVED set, never an operator
action.** *"Tutti i providers funzionano sempre, non serve
disattivarli/attivarli … loro vivono lì."* [All providers always work, there is no need to deactivate/activate them … they live there.] A source exists for a camera
because a configuration elsewhere put it there — CamStack always, Reolink
because it is that camera's provider, HKSV because the camera is exported —
and none of those is a tick box. So `getBindings` gained **step 0**: every
provider addon of every collection capability that applies to the device's
type, one entry each, persisted nowhere. Steps 1–4 answer one entry per cap
and are skipped for these; a persisted `wrapperAddonId` is a singleton's answer
and means nothing here. What a provider does with a device it does not serve is
the PROVIDER's answer — `addon-provider-reolink` lists no sources for a
Hikvision camera — so the binding says only who may be ASKED.

**Identity is the addon, not the registration.** `addonIdentityOf` strips the
`@<nodeId>` an agent-side registration carries, and the device's native
registration folds into the same set. That is where the three `analytics` rows
actually die: not in a de-duplicator over the answer, but in a set that cannot
hold the same addon twice.

**Migration: none, and that is the argument for deriving it.** A fleet sweep
would write ~300 rows to say what the registry already knows and go stale the
moment an addon is deployed to a new camera. A bind-on-registration rule writes
the same store at boot, ordered by addon boot order, and re-creates the exact
window where a provider is registered and unbound at once. Deriving has no
window, no back-fill and no staleness: the answer is computed from the
registrations on every read.

**And the verb that wrote the unread store is refused.** `setWrapperActive`
throws for a collection cap by name, `DeviceCapBinding` is back to its single
`wrapperAddonId` field, the registry's `deviceDisabledSources` map and its
three methods are gone, and the boot replay with them.
`scripts/check-device-selection-authority.ts` was rewritten around the
invariant rather than the instance: **every `DeviceCapBinding` field the
activation verb writes must be a field the binding enumeration reads**, which
makes "a store nobody reads" unrepresentable rather than merely absent today
(proven: adding an unrelated new field to both the type and the verb fails the
guard).

## Enforcement

- `videoclips-two-provider-dispatch.spec.ts` § "the device SOURCES are its
  bindings" reproduces the live shape against the REAL registry and the REAL
  router — the native registration plus a hub-local plus an `@agent-a`
  one, all answering `analytics`, plus Reolink: the listing holds one row, the
  row names the bound registration, `listClips` lists the clip once, a scalar
  call reaches the BOUND registration rather than whichever registered first,
  binding Reolink instead makes it the source, a bindings read that FAILS keeps
  the registrations rather than emptying the camera, and a binding naming a
  provider nobody registered is a named drop. Proven red by ignoring the
  bindings: 7 of 7 fail.
- Same file, § "listClips is asked of ONE provider": a named provider answers
  alone, an unnamed call gets the bound one, and a provider the device is not
  bound to is refused by name. Proven red before the `provider` pin: 2 of 3
  fail.
- DELETED with the design they pinned: `videoclips-device-source-activation.spec.ts`
  (15 cases, all per-source enable/disable) and checks 5 and 6 of
  `scripts/check-device-selection-authority.ts` (the dispatcher's
  `getDeviceDisabledSources` read and the listing's `includeSwitchedOff`). The
  guard's checks 1–4 stay: `setWrapperActive` is still the persisted authority
  and the door D556 closed stays closed.
- `scripts/check-device-scoped-wrapper-mounts.ts` gains check 4: a
  device-scoped wrapper whose mode is `collection` must be dispatched by
  `requireDeviceCollection` in `cap-router-runtime.ts`. Proven red by swapping
  it back to `requireDeviceScoped`.
- `packages/types/src/__tests__/device-scoped-wrapper-mount.spec.ts`: a
  device-scoped wrapper that is a collection resolves `device-scoped`, and
  `videoclips` is that cap. Proven red by restoring the old derivation order —
  which also fails the guard above.
- `server/backend/src/__tests__/cap-routers/videoclips-two-provider-dispatch.spec.ts`
  (D552's spec, extended): both sources answer one camera; a twin clip appears
  twice with two sources; the merge is newest-first across sources; a
  one-source camera is verbatim; a throwing source leaves the others listed and
  is named in `listSources` as `unreachable` with its reason; `getClipPlayback`
  reaches the source named in the id and refuses an id nobody claims. Proven
  red by removing the `requireDeviceCollection` branch (10 of 15 fail).
- `packages/addon-pipeline/src/recorder/addon/__tests__/videoclips-provider.spec.ts`
  (**moved** from `packages/addon-post-analysis/src/pipeline-analytics/__tests__/`
  on 2026-09-20 with the provider it pins — the source is registered by the
  addon that owns the footage now,
  [D560](adr-0560-a-clip-source-over-recorded-footage-is-registered-by-the-addon-that-owns-the-footage-and-the-half-that-went-remote-is-the-half-that-needs-a-degradation.md);
  the file is byte-identical apart from the appended events-unreachable block,
  which is the proof the computation did not move with it): the analytics
  provider names exactly one source and it is the prefix its clip ids carry —
  so the dispatch key and the id mint cannot drift apart. Its `addonId` is now
  `recorder`; the SOURCE id stays `analytics`, because that is the clip-id
  namespace `getClipPlayback` routes on and stored ids carry it.


## Amended 2026-09-20 (last) — the `analytics` source's binding names a different addon

Nothing about this record's decisions changes; one value in its worked example
does. The `analytics` clip source is registered by `recorder` rather than
`pipeline-analytics` ([D560](adr-0560-a-clip-source-over-recorded-footage-is-registered-by-the-addon-that-owns-the-footage-and-the-half-that-went-remote-is-the-half-that-needs-a-degradation.md)),
so step 0's derived entry for a camera reads
`{ capName: 'videoclips', kind: 'wrapped', providerAddonId: 'recorder' }` where
it read `'pipeline-analytics'`.

That is the whole persisted delta, and **it is the argument for deriving the
set** made concrete: the binding is computed from the registrations on every
read, so an addon handing a capability to another addon costs no migration, no
back-fill and no window in which a camera is registered and unbound at once. A
persisted binding store would have needed a fleet sweep of ~300 rows to say
what the registry already knew.

The three-rows-for-one-addon defect this amendment section exists to describe is
unaffected: `recorder` is `placement: 'any-node'` exactly as
`pipeline-analytics` was, so it still reaches the registry as a hub-local
registration and as `recorder@<nodeId>` per agent, and `addonIdentityOf` still
collapses them to one.

## Amended 2026-09-20 (later) — naming the provider is REQUIRED; there was never a default to have

The amendment above wrote `listClips`'s `provider` as optional, *"absent meaning
the device's bound provider (CamStack on every camera today, because that is
what `getBindings` answers with)"*, and the cap's docblock repeated it. **No
code ever implemented it.** `device-collection-dispatch.ts` has one narrowing
step, `pinnedProvider`, and an absent pin narrows nothing: the call falls
through to the fan-out.

Measured on the live hub, device 107 (bound to `recorder` AND
`provider-reolink`), `limit: 3`:

| call | rows |
| --- | --- |
| no `provider` | **6** — 3 `analytics` + 3 `native:reolink:onboard`, merged newest-first |
| `provider: recorder` | 3, all `analytics` |
| `provider: provider-reolink` | 3, all `native:reolink:onboard` |

So absence bought the UNION the same docblock says this method is not, and
`limit` meant `limit × sources`. D569 § 3 had already measured half of this from
the viewer and read the Reolink rows at the top of the merge as "the default
resolved to Reolink"; it is worse than that — there is no resolution at all.

**The suite was green the whole time, and it never asked the question.** The
case named *"names none and gets the device's bound provider — CamStack on this
fleet"* bound the camera to ONE provider, where decision 6 ("one source is not a
merge") gives the same answer whatever the rule is. Eleven lines above, in the
same file, *"another camera, in the SAME build, still sees every source it has"*
asserted the union from a bare call. Two tests, one file, opposite contracts,
both passing.

### Decision

**`provider` is REQUIRED on `listClips`, in the cap's input schema.**

1. **There is nothing to default TO.** This record's own amendment made the
   binding set of a collection cap DERIVED and PLURAL (step 0: every provider
   addon of every collection cap that applies to the device's type). "The bound
   one" is not a value that exists. The only thing that could name one is a
   per-device single-valued authority — which is exactly what decision 3
   rejected, and what `setWrapperActive` now throws for by name.
2. **Refusing beats naming CamStack.** Resolving absence to the recorder would
   privilege one addon by id inside a dispatcher that is cap-generic and a
   surface whose premise is that sources are peers, would need a new framework
   field with exactly one user, and would be wrong on the first camera with no
   recorder binding — where it must fall through to the ambiguity again.
3. **Refusing beats documenting the union.** The union is deterministic (the
   merge is a total order on `(startMs, endMs, id)`), so "nondeterministic" is
   not the objection. `limit` is: a caller asking for 3 measured 6, and there
   is no honest trim — the rows were already paid for. And D569 decision 4 had
   already settled the surface: *"Never a concatenation, never a merge, never a
   dedup."*
4. **The refusal lives in the SCHEMA, not in a dispatcher branch.** A runtime
   rule is what produced this defect: it is invisible to types, to the SDK and
   to every caller until the day a camera has two sources. `z.string().min(1)`
   makes an omission a build error at every call site in the repo, which is how
   the drift is found before the fleet finds it.
5. **The default belongs to the SURFACE**, which holds the `listSources` rows
   and can SAY which one it picked (D569 § 1–3 already says so for the viewer).
   `ClipsSection` and `EventDetailPanel` now take the first source the camera
   lists, show it selected, and ask nothing at all when the camera lists none.

### What this cost, and it is worth naming

`videoclips.listClips` can no longer reach the dispatcher's fan-out or its
newest-first merge. `listSources` still fans out — it is the method whose whole
job is to enumerate — and its rows carry no `timeRange`, so the merge's SORT has
no caller on this fleet. It stays, with its spec, because it is decision 7's
rule for the NEXT device-scoped collection cap, and a rule nothing checks has
already been broken somewhere. Its tests moved off `listClips` onto
`requireDeviceCollection` directly, where the behaviour actually lives.

### Enforcement

- `videoclips-two-provider-dispatch.spec.ts` § "listClips is asked of ONE
  provider": a bare call on a TWO-provider camera is refused; a bare call never
  answers with rows from more than one source; a ONE-provider camera refuses too
  (the rule is not "required when ambiguous"). Proven red by reverting
  `provider` to `.optional()`: the two-provider call resolves with BOTH
  `analytics` and `native:reolink:onboard` — the live shape of 592, in a test.
- `clips-section-sources.test.tsx` § "a provider is always NAMED": every
  `listClips` argument the admin section builds carries a string `provider`; it
  defaults to the first listed source and the CONTROL shows that same value; a
  camera listing no source is asked nothing. The old case it replaces asserted
  `not.toHaveProperty('provider')`.
- `clips-section-band.test.tsx`: the query does NOT fire while `listSources` is
  still out — there is no provider to name yet.
- `event-detail-preview-miss.spec.tsx` § "the clip link names the provider it is
  asking": the Events panel's clip link sends a provider from the camera's own
  source list, and asks nothing when there is none. Before this, its `clips[0]`
  on 592 could be a 28-second SD-card file shown under an analytics event.
- Fixtures in four ui-library specs gained `addonId` on their `listSources`
  rows. The dispatcher STAMPS that field on every row it serves (decision 8 /
  D557), so a fixture without one was a row production cannot produce.
