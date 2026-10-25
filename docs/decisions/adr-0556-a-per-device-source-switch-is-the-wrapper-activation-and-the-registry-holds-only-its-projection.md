---
id: D556
title: A per-device SOURCE switch is the wrapper activation — the registry holds only its projection, and "unset" means every source
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-source-activation.ts
  - packages/system/src/builtins/device-manager/device-meta-types.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
  - packages/system/src/kernel/capability-registry.ts
  - packages/types/src/interfaces/kernel-abstractions.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - server/backend/src/api/core/capabilities.router.ts
  - scripts/check-device-selection-authority.ts
---

## Context

[D554](adr-0554-a-per-device-wrapper-that-becomes-a-collection-stays-per-device-and-its-sources-are-fanned-out-not-picked.md)
landed the `videoclips` collection dispatch and recorded two things as open:
`setWrapperActive` "still reaches no resolver", and the per-device collection
filter — the thing the dispatcher reads — "existed with no caller". Slice 4
(the admin-UI picker where an operator chooses which clip sources a camera
shows) was about to be built on one of them. Both claims were re-measured here
before anything was built on either, and they are not both true.

**What survived verification.** `registry.setDeviceOverride` does have exactly
two callers, both the admin `capabilities` router. `getProviderForDevice`
consults `nativeProviders`, then `deviceOverrides` (singleton) or
`state.providers.values().next()` (collection) — it never opens the persisted
store. So the persisted activation reaches the PROVIDER resolver through no
path. `getBindings(deviceId)` cannot express two providers of one cap
(`deviceBindings[dev][cap] = { wrapperAddonId }`, one value; `seenCaps`, one
entry per cap). Confirmed.

**What did not.** "`setWrapperActive` reaches no resolver" is too strong.
Its store is read by `getBindings`, and `getBindings` is what the
pipeline-orchestrator's `isCapActiveForDevice`, the camera-switch group (D62)
and the settings/status aggregators (D12) decide on. It was never a store
nobody read — it is the authority for every per-camera function switch this
repo has. What it never reached is the CAPABILITY resolver.

So the real shape is not "one live mechanism and one dead one". It is one
control cut in half:

| | written by | persisted | read by a resolver |
| --- | --- | --- | --- |
| wrapper activation (`setWrapperActive`) | the operator, over tRPC | yes (`deviceBindings`) | no |
| collection filter (`setDeviceCollectionFilter`) | the admin router only | **no** (in-memory Map) | yes (`resolveCollectionForDevice`) |

Wiring slice 4's picker to the first would have saved a choice nothing acts on.
Wiring it to the second would have saved a choice that reverts, silently, at the
next hub restart. Both are the D62 defect — a knob that writes a store nobody
reads — and D62 exists because this repo shipped it twice.

## Decision

1. **The persisted wrapper activation is the ONE authority for which providers
   answer for a device; the registry holds only its in-memory projection.**
   That is D62's rule applied unchanged: a per-camera function switch stores
   nothing of its own, it reads and writes the authority that already owned the
   function, and the authority here already exists and is already named
   (`deviceManager.setWrapperActive`, `CameraSwitch.authority`). The alternative
   — promote the registry filter to the authority and persist it — would have
   created a second store for a question `deviceBindings` already answers for
   every singleton cap, and left an operator with two switches to disagree with
   each other.
2. **The collection filter ceases to exist.** The registry's per-device ALLOW
   list (`setDeviceCollectionFilter` / `clearDeviceCollectionFilter` /
   `deviceCollectionFilters`) is deleted, along with the two tRPC endpoints that
   were its only writers. In its place is `deviceDisabledSources`: the same
   lookup on the resolution path, but a DENY set, writable only by
   `device-source-activation.ts`, and never by a router. The operator has one
   verb, and the registry has no surface that can disagree with it.
3. **"Unset" means EVERY source, and it is expressed as a deny list, not as an
   absent allow list.** The persisted record for a collection cap carries
   `disabledSourceAddonIds` — the addons the operator switched OFF. Three
   reasons, in order of weight: (a) it is exactly today's behaviour, so a fleet
   that never opens the picker does not move, and D554 decision 6's "one source
   answers exactly as it did before" survives; (b) a provider that registers
   LATER — Reolink, when slice 2 lands — is a source of a camera the operator
   has already touched, with no second write; an allow list snapshots the
   providers that happened to exist at toggle time and hides every future one;
   (c) it is the direct generalisation of what this store already meant —
   `{ wrapperAddonId: null }` has been the explicit "operator disabled" marker
   since D62, and a cap with several sources needs a set of those, not a new
   idea. "Unset = none" was considered and rejected: it would make the picker's
   first release blank every camera's clip list until an operator walked a
   thousand cameras, and D554's own framing of this surface is that nothing is
   hidden.
4. **The projection is replayed at boot, and that is not an optimisation.** The
   registry's set is in-memory and an EMPTY one means "every source", so a hub
   restart with no replay switches every source the operator turned off back ON
   — an off switch that reports on, which is the D62 failure verbatim. The
   device-manager's `onInitialize` calls `restoreDeviceSourceActivations` over
   the persisted store before any camera can be asked for its clips. The replay
   is order-independent: the projection is device+cap keyed DATA, not a provider
   reference, so `setDeviceDisabledSources` deliberately validates neither the
   capability nor the addon ids. A persisted operator decision is a fact about
   the fleet, and making it wait for whichever addon boots first is how it would
   be lost.
5. **The device's NATIVE source obeys the same switch.** `sourcesForDevice`
   prepends the native provider, which is not in `state.providers` and therefore
   cannot be dropped by `resolveCollectionForDevice`. It is asked separately,
   against the same authority (`isDeviceSourceDisabled`). Without this the
   picker would carry exactly one row the operator cannot switch off, and it is
   the camera's own recordings — the source this whole line of work is about.
6. **A collection cap's row does not fabricate a `wrapperAddonId`.** A source
   toggle leaves that field exactly as it found it, and `getBindings` step 1
   skips a row that has none. A cap with several sources has no "which one" for
   `getBindings` to answer (D554 context 3); writing the first surviving source
   there would have turned "hide one source" into "rebind the cap", and writing
   `null` would have turned it into a cap-wide off switch.

## Consequences

- `setWrapperActive` moved out of `device-aggregation.ts` into
  `device-source-activation.ts`, with a narrower named dependency bag
  (`WrapperActivationDeps`: the settings door, the event bus, the registry, the
  addon-store write lock). `AggregationDeps` carried the device ledger and the
  remote-native cache the verb never reads, and that is what made "activate,
  then list" untestable without standing up the whole addon. The D62 write-lock
  discipline, the `{wrapperAddonId: null}` marker and the out-of-lock event emit
  are unchanged, and `addon-store-write-race.spec.ts` still pins all three.
- `DeviceBindingsStore`'s row is now a named type, `DeviceCapBinding`, and
  `wrapperAddonId` is OPTIONAL. Backward compatible in both directions: every
  row the live hub holds has the field, and a row that grows only
  `disabledSourceAddonIds` is skipped by `getBindings` step 1 rather than read
  as a binding.
- `ICapabilityRegistry` grew three members (`setDeviceDisabledSources`,
  `getDeviceDisabledSources`, `isDeviceSourceDisabled`). The device-manager sees
  the registry through that interface, so the mirror could not live behind the
  concrete class.
- Slice 4's picker has exactly one thing to call, and it is a cap method that
  already exists on a router the UI already speaks:
  `deviceManager.setWrapperActive({ deviceId, capName: 'videoclips',
  wrapperAddonId, active })`. It persists nothing of its own (D62). **D555
  added `sourceId` to that call** — see the refinement below.
- **Not fixed here:** `setDeviceOverride` — the per-device SINGLETON pin — is
  still an in-memory map whose only writers are the two admin routers, so an
  operator's singleton pin still reverts on restart. It is a different question
  (which ONE provider, not which of several sources), it has no operator surface
  under construction, and folding it in would have meant a second persisted
  shape decided on no evidence. It is named here so the next session does not
  have to re-measure it.
- **Not decided here:** what the picker SHOWS for a camera whose only source is
  disabled. The dispatcher already answers `PRECONDITION_FAILED` for a device
  with zero sources, which reads as "not registered" rather than "you turned
  them all off". Slice 4 owns that message.

## Refined by D555 (2026-09-20, same day)

Decision 3's deny set is keyed by ADDON id, and that was right for every
provider that existed when this was written: each served exactly one of a
device's sources. `addon-provider-reolink` serves TWO on a hub child
(`native:reolink:onboard` and `native:reolink:hub`, D549 11), so an
addon-keyed tick box would have turned both off while saying it turned one
off — [D557](adr-0557-a-clip-source-picker-filters-the-view-because-the-persisted-authority-is-keyed-by-addon-not-by-source.md)
measured that and refused to ship it.
[D555](adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md)
re-keys the set by SOURCE (`DeviceCapBinding.disabledSourceIds`), adds
`ClipSource.addonId` so a row can be resolved to who serves it, and gives
`setWrapperActive` an optional `sourceId`.

**Everything decided above still holds**, unchanged: it is still a DENY set
(decision 3), still mirrored on write and replayed at boot (decision 4), the
native source still obeys the same switch and is still asked separately
(decision 5), and a collection row still fabricates no `wrapperAddonId`
(decision 6). An entry persisted under this record's ADDON key keeps its
meaning — it denies every source that addon serves for that device — by a READ
rule, so nothing in the store is rewritten.

## Amended 2026-09-20 (same day) — a switched-off source keeps its ROW

**What this record decided, and what it got wrong.** Decision 3 made the
operator's choice persist as a DENY set, and the resolution path enforced it by
dropping the denied provider out of the device's collection
(`resolveCollectionForDevice`, and `sourcesForDevice` for the native). That
drop reached `listSources` too, so a source the operator switched off vanished
from the list of the camera's sources.

**Why it looked right.** A disabled source genuinely cannot contribute rows, so
removing it from the SET of sources is the smallest possible enforcement: one
filter, at the one place that decides who answers, with no second predicate to
drift. It was also measured against the only consumer that existed —
`listClips`'s fan-out — where "dropped from the set" and "contributed nothing"
are literally the same answer. And the surface that would care had not been
built: [D557](adr-0557-a-clip-source-picker-filters-the-view-because-the-persisted-authority-is-keyed-by-addon-not-by-source.md)
shipped its picker as a client-side view filter, forgotten on reload, so nothing
ever asked this store what to draw.

**Why the row must survive anyway.** The moment the choice persists, the source
list is the control the choice is undone FROM. Dropping the row makes the switch
one-way: unticked, then gone, with nothing left to tick. That is the exact
misreading D554 decision 4 was written to end — *a source that cannot answer
produces a ROW, not an absence* — and D557's own kept property says the same
thing from the UI side (*a source is never hidden, only its rows*). This record
carved one case out of that rule without noticing it was the same rule, and
[D555](adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md)
made the hole plain by collapsing Reolink to ONE source: on a Reolink camera the
switch is now "the camera's own recordings, or only CamStack's", and switching
the camera's recordings off deleted the whole picker. D62's rule is the other
half of it — an off switch is REPORTED off, and disabled must never look like
broken; a missing row says neither.

**So, amended:**

1. **`listSources` answers every source the device HAS, and MARKS the ones the
   operator switched off** (`ClipSource.switchedOff`, stamped by the collection
   dispatcher exactly as `addonId` is — a provider never sets it and never
   learns the operator's choice). Decision 3's deny set is unchanged; what it
   takes from a source is its CLIPS, not its row.
2. **`switchedOff` is a boolean BESIDE the availability, not a member of it.**
   `ClipSourceAvailability.state` models what a source CAN do — asleep,
   unreachable, no card, an index that disagrees with its own calendar — and a
   switched-off source could answer perfectly well; the operator decided it
   should not. Folding a choice into a capability vocabulary is how `disabled`
   and `broken` stop being distinguishable (D62). The code says the same thing
   independently: `STATE_COPY: Record<ClipSource['availability']['state'],
   StateCopy>` in `ui-library` is exhaustive over that enum, so a sixth member
   is a breaking change to every consumer that reads it, for a fact that is not
   about the source at all.
3. **A switched-off source is called for the LISTING and for nothing else.**
   `sourcesForDevice` returns every source with `switchedOff` on it; the
   dispatcher hands the serving set (the unmarked ones) to `listClips` and to
   scalar routing, and the whole set only to `listSources`. It is called there
   because only a provider can NAME its own sources — the same reason
   `unreachableSourceRow` falls back to the addon's id when a provider throws.
   No new store, and nothing caches a source's label to avoid the call.
4. **A switched-off row carries no `catalogAsOf`.** The field means "when this
   source's catalog was last CONFIRMED", and nothing confirms a catalog this
   source is not allowed to serve. A frozen age that can only grow draws a
   stalling source rather than an off switch. `state` and `reason` are left
   exactly as the provider gave them: what the source can do is a different
   question from whether it may, and both are worth seeing on a row the
   operator is deciding about.
5. **A camera whose every source is switched off answers `listClips` with an
   empty list**, not `PRECONDITION_FAILED`. This record left that open ("what
   the picker SHOWS for a camera whose only source is disabled … reads as 'not
   registered' rather than 'you turned them all off'"); with the rows now
   saying which it is, the honest clip answer is none. A camera with NO source
   at all is still refused by name. A scalar call in that state is a
   `BAD_REQUEST` that says every source is switched off.

**Still true, unchanged:** the persisted activation is the one authority and the
registry holds its projection (decision 1); there is one verb and no second
store (decision 2); unset means every source (decision 3); the projection is
replayed at boot (decision 4); the native source obeys the same switch and is
asked about separately (decision 5); a collection row fabricates no
`wrapperAddonId` (decision 6); and the D555 re-key by SOURCE, with the read rule
that keeps a pre-re-key ADDON entry meaning every source that addon serves.

**Not decided here.** (a) A row denied by an ADDON-grained entry — a pre-re-key
entry, or the cap-wide verb (`sourceId` omitted) — is marked like any other, but
un-ticking it per SOURCE does not clear it: `nextDisabledSources` would have to
expand the addon entry into the addon's OTHER source ids, and nothing at write
time can enumerate them without becoming a second authority on provider
identity (D557's rejected option 1). Such an entry is undone by the same
cap-wide verb that wrote it. Nothing writes an addon key any more and the picker
always names a source, so this is reachable only through the API. (b) A
switched-off source's clip ids are still CLAIMED on the scalar path when the
denial is source-grained, so `getClipPlayback` on an id the operator can no
longer see still plays. That is today's behaviour for a source-keyed entry and
it is unchanged; whether a hidden source stays playable by id is a question for
whoever builds the share/export surface.

## Enforcement

- `scripts/check-device-selection-authority.ts` (wired into
  `.github/workflows/ci.yml`). Four literal checks: every per-device selection
  mutator on `CapabilityRegistry` is called from `device-source-activation.ts`;
  its backing map is read by a resolver in the registry; the removed allow-list
  names never come back anywhere in `packages/`, `server/` or `scripts/`; and
  the verb mirrors on BOTH paths (the write and the boot replay) while the addon
  calls the replay. Proven red three ways: deleting the mirror from the write
  path, deleting the `restoreDeviceSourceActivations` call from the addon, and
  re-declaring `setDeviceCollectionFilter` on the core capabilities router.
- The per-source activation spec — **deleted with the machinery it proved, once
  sources stopped being enable-able at all.** It was the end-to-end proof, and
  deliberately not a unit test of the setter: the
  REAL `setWrapperActive`, the REAL `CapabilityRegistry`, the REAL `videoclips`
  router built by `buildRuntimeCapRouters`. Six cases: deactivate then list (the
  source is gone, no restart); reactivate (it is back); an untouched camera is
  unchanged; a provider registered AFTER the toggle is a source (decision 3);
  the native source obeys the switch (decision 5); the choice survives a
  registry rebuild through the replay (decision 4). Proven red by removing the
  mirror (5 of 6 fail, the control passes), by removing the deny filter from
  `resolveCollectionForDevice` (4 of 6), and by admitting the native
  unconditionally (1 of 6 — the one that is about it).
- `videoclips-two-provider-dispatch.spec.ts` (D554's) now narrows its camera
  through `setDeviceDisabledSources`, so the dispatch spec and the authority
  spec cannot drift apart.

**Amended (2026-09-20).** `scripts/check-device-selection-authority.ts` gains
check 6: the dispatcher's listing path must resolve the collection with
`includeSwitchedOff`, or the switch is one-way again — checks 1–5 all stay green
through that deletion, because the mutator, the mirror, the replay and the row
read are untouched by it. Proven red by removing the argument. Its `methodBody`
helper was also fixed to find a GENERIC method: check 2's
`resolveCollectionForDevice` arm had never matched
(`resolveCollectionForDevice<T = unknown>(`) and the check had been passing on
`isDeviceSourceDisabled` alone since it was written.

The six specs above now read as: the source's CLIPS leave the listing and its
ROW stays, marked. Each still proves what it was written to prove — the verb
reaches the resolver with no restart (1), it is reversible (2), it is per-camera
(3), unset means every source including one that registers later (4), the native
obeys it (5), and it survives a rebuild through the replay (6) — and each now
also pins that the control the operator would use to undo it is still on screen.
Three more join them: the one-source round trip at the grain the picker writes
(`sourceId` off, row present and marked, clips empty, `sourceId` on, clips
back), a switched-off row carrying no `catalogAsOf`, and a camera with every
source off answering an empty clip list rather than "not registered". Proven red
three ways: dropping switched-off sources from the listing (6 of 15), stamping
`switchedOff: false` (8 of 15), and keeping the catalog age (1 of 15 — the one
that is about it).

## Amended 2026-09-20 (same day, second time) — the switch this record is about should not exist

This record answered a question with real care, and the question was the wrong
one. It asked *where does a per-device clip-source switch persist*, established
that `setWrapperActive` was the one authority that already owned the function,
refused to invent a second store, and kept every D62 discipline while doing it.
D555 then re-keyed the set by source and D556 was amended so that a switched-off
source still gets a row to be switched back ON from. All of that analysis is
sound, and none of it establishes that the switch belongs on this surface.

The operator settled it:

> *"in realtà non è affatto necessario lo stato di abilitato o meno delle
> sources. Loro vivono lì, ad esempio hksv c'è se la camera è esportata su
> homekit, reolink la dà di suo così come il camstack."*
>
> [actually the enabled-or-not state of the sources is not necessary at all. They live there, for example hksv is there if the camera is exported to homekit, reolink provides it by itself, and so does camstack.]

**A clip source is not switched on — it EXISTS**, because of a configuration
that lives on some other surface. HKSV is a source if the camera is exported to
HomeKit; that decision belongs to the HomeKit export. The Reolink source is a
source because Reolink is the camera's provider; that decision belongs to the
device's provider binding. CamStack's is always there. Each of those is already
an authority. A per-source on/off in a clips list is therefore a second knob
over a decision somebody else already owns — which is D62's rule reached from a
direction D62 does not spell out. D62 forbids a knob that writes a store nobody
reads; this is a knob that writes a store it had no business asking. The verb
was honest, the projection was mirrored, the replay was durable, and the whole
apparatus answered a question the operator never asked.

**So the SURFACE is settled and the machinery is not.**
[D557](adr-0557-a-clip-source-picker-filters-the-view-because-the-persisted-authority-is-keyed-by-addon-not-by-source.md)'s
amendment of the same day restores its original shape unconditionally: the
clips section's source picker is the capability's own `sources` view filter, it
persists nothing, and it offers no per-source switch — no longer because it
cannot express one, but because there is nothing for it to decide. Nothing in
the admin UI now calls `setWrapperActive` with a `sourceId`, and a directory
guard in `clips-section-sources.test.tsx` keeps it that way.

**What is untouched, and deliberately.**

1. **`setWrapperActive` itself stays.** It is the pre-existing per-camera
   wrapper authority (D62) — whether a wrapper wraps a camera at all — with
   callers well outside clips: `getBindings`, `isCapActiveForDevice`, the
   camera-switch group, the settings and status aggregators. Only the
   per-source EXTENSION added on 2026-09-20 was ever in question.
2. **The per-source extension is still in the tree**, and this amendment does
   not remove it: `ClipSource.switchedOff`, `DeviceCapBinding.disabledSourceIds`
   and its legacy sibling, `setWrapperActive`'s optional `sourceId`,
   `ICapabilityRegistry`'s `setDeviceDisabledSources` /
   `getDeviceDisabledSources` / `isDeviceSourceDisabled`, the registry map and
   the `restoreDeviceSourceActivations` boot replay. Its hinge is
   `server/backend/src/api/trpc/device-collection-dispatch.ts` — the file that
   stamps `switchedOff`, resolves the collection `includeSwitchedOff` and reads
   the deny set — and that file was being rewritten by another agent while this
   was written. A removal that lands in every file but the one that reads them
   is worse than no removal at all.

**Open, for whoever finishes the dispatcher.** By the end of this work the
dispatcher had stopped reading any of it — no `isDeviceSourceDisabled`, no
`getDeviceDisabledSources`, no `switchedOff` stamp — and
`videoclips-device-source-activation.spec.ts` had been deleted with it. What is
left is ORPHANED rather than live: `ClipSource.switchedOff`,
`DeviceCapBinding.disabledSourceIds` and its legacy sibling,
`setWrapperActive`'s `sourceId`, `ICapabilityRegistry`'s three per-source
members with their map and boot replay, and check 6 of
`scripts/check-device-selection-authority.ts` (the `includeSwitchedOff`
argument, which now has nothing to check). Nothing outside
`device-source-activation.ts` reads any of them. Checks 1–5 of that script are
about `setWrapperActive`'s singleton half and stay. **A leftover that describes
the right design is worse than nothing** — this one describes a design that was
retired the day it landed, so it should be deleted in one pass by whoever owns
the dispatcher, not left to read as verification.

**Still true, unchanged:** everything this record decided about the SINGLETON
wrapper activation — one verb, one authority, no second store, the
`{wrapperAddonId: null}` marker, the write lock and the out-of-lock emit. That
half was never in question and is what D62 is actually about.

## Closed 2026-09-20 (fourth) — the dispatcher half, by the session that owned it

The item the amendment above left open is done. In
`server/backend/src/api/trpc/device-collection-dispatch.ts`: the per-source deny
read, `ClipSource.switchedOff`, `withoutCatalogAge`, the listing's
`includeSwitchedOff` and the "every source is switched off" branch are gone, and
`finishRows` is now only the addon stamp (D557). The two things that existed to
hold the extension up went with them —
`videoclips-device-source-activation.spec.ts` (15 cases, all per-source
enable/disable) is deleted, and checks 5 and 6 of
`scripts/check-device-selection-authority.ts` are replaced by a note where they
stood, because a green guard over a design nobody kept is worse than no guard.
Checks 1–4 pass unchanged.

What replaced the deny set is not "nothing": a device's sources are its
BINDINGS, and for a COLLECTION capability that set is DERIVED from who provides
the cap — `getBindings` step 0, persisted nowhere (D554 amended). So this
record's subject does not move to a different store; it stops existing.
`setWrapperActive` REFUSES a collection capability by name, `DeviceCapBinding`
is back to its single `wrapperAddonId`, the registry's `deviceDisabledSources`
map and its three methods are deleted, and the boot replay with them — there is
no in-memory projection left for a restart to lose.

The guard was rewritten around the INVARIANT this record was always about, not
around one instance of it: every `DeviceCapBinding` field the activation verb
writes must be a field the binding enumeration reads. `disabledSourceIds`
failed that from the day it was written, and nothing said so because the guard
was checking that the specific machinery existed rather than that the two ends
were attached. Proven: adding any new field to both the type and the verb, and
not to the enumeration, fails.

**Still true, and now the whole of it:** the SINGLETON wrapper activation —
one verb, one authority, no second store, the `{wrapperAddonId: null}` marker,
the write lock and the out-of-lock emit.


## Amended 2026-09-20 (last) — the orphans are gone, and the guard is three checks

The section above left five things ORPHANED and named the shape they were:
*"a leftover that describes the right design is worse than nothing"*. Two of
them had already been removed with the dispatcher; the last two, plus the
guard check, went in one pass with [D560](adr-0560-a-clip-source-over-recorded-footage-is-registered-by-the-addon-that-owns-the-footage-and-the-half-that-went-remote-is-the-half-that-needs-a-degradation.md)'s
registration move, and each was verified unread across the whole repo — the
viewer submodule and the generated files included — before it was deleted:

| leftover | state when it was swept | what happened |
| --- | --- | --- |
| `ICapabilityRegistry`'s three per-source members, the map, the boot replay | already deleted with the dispatcher | nothing to do |
| `DeviceCapBinding.disabledSourceIds` and its legacy sibling | already deleted; only prose and the guard's removed-names list mentioned them | nothing to do |
| `ClipSource.switchedOff` | orphan — one declaration in `videoclips.cap.ts`, no reader anywhere (the `switchedOff` hits elsewhere are `CameraStatus`'s, a different field and a live one, D62) | **deleted** |
| `setWrapperActive`'s optional `sourceId` | orphan — declared on the cap input and on the addon method, dropped on the floor by `WrapperActivationInput`; no caller in `addon-admin-ui`, `ui-library`, the viewer or the generated routers ever passed it | **deleted**, and the method's docblock rewritten to say a COLLECTION cap is refused rather than deny-listed |
| check 6 of `scripts/check-device-selection-authority.ts` | already deleted — the script is three checks, not six; this record's "checks 1–5 stay" and D554's "checks 1–4 stay" both describe a longer version of it that no longer exists | nothing to do |

**The guard still bites after the removal**, which is the thing worth proving
when a check goes: removing a check is exactly when the remaining ones quietly
stop covering the gap. Check 1 (the verb writes only fields the enumeration
reads) re-proven red by adding a field to `DeviceCapBinding` and to the verb
and not to the enumeration. Check 2 (a collection cap is refused) re-proven red
twice — by removing the `mode === 'collection'` consultation, and by removing
the `throw`. Check 3 (the removed names stay removed) **did not bite on the first
attempt**, and that is the warning made real: re-declaring
`disabledSourceIds?: readonly string[]` on `DeviceCapBinding` passed, because
the literal it matched was `<name>\s*[(<:=]` and an OPTIONAL property puts a
`?` between the two. An optional field is exactly how every one of these came
back. The pattern now allows it (`<name>\??\s*[(<:=]`) and the same
re-declaration is red.

`setWrapperActive` itself is untouched and stays. It is the pre-existing
per-camera wrapper authority (D62), and it is exactly what makes a
binding-derived source list correct.
