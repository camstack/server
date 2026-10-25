---
id: D557
title: A clip-source picker filters the VIEW — the persisted authority is keyed by ADDON, and one addon serves two of a hub child's sources
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/ui-library/src/composites/clips/ClipsSection.tsx
  - packages/ui-library/src/composites/clips/clip-view-state.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/types/src/interfaces/config-ui.ts
---

## Context

Slice 4 — the admin-UI clips section — was specified with one sentence about
its picker: *"the picker writes exactly one thing,
`deviceManager.setWrapperActive({ deviceId, capName:'videoclips',
wrapperAddonId, active })`"*. That is [D556](adr-0556-a-per-device-source-switch-is-the-wrapper-activation-and-the-registry-holds-only-its-projection.md)
decision 1 applied to this surface, and it is the right authority: one verb,
persisted, replayed at boot, with no second store to disagree with it.

It does not fit the rows this picker has, and the mismatch is not a detail.

**The store is keyed by ADDON.** `disabledSourceAddonIds` holds addon ids,
`setDeviceDisabledSources` takes addon ids, and `sourcesForDevice` drops a
provider by `isDeviceSourceDisabled(deviceId, capName, addonId)`. **The picker's
rows are SOURCES**, which is a finer grain: `videoclips.listSources({deviceId})`
answers one row per source, and D549 decision 11 is explicit that a hub child
has TWO — `native:reolink:onboard` (the child's own files, read with the child's
uid) and `native:reolink:hub` (the hub's event view) — measured to be different
sets, listed side by side at the operator's own request. **Both come from ONE
addon**, `addon-provider-reolink`.

So wiring a per-source tick box to `setWrapperActive` would make "hide the
hub's event view" silently mean "turn off both Reolink sources for this
camera". A switch that does something other than what its label says is worse
than no switch — [D62](adr-0062.md) exists because this repo shipped a knob
that wrote a store nobody read, twice, and this is the same failure with the
polarity reversed: a store that IS read, by a question the operator did not
ask.

`ClipSourceSchema` carries no `addonId`, so the surface cannot even resolve
which addon a row belongs to. `deviceManager.listWrappersForCap({capName})`
answers cluster-wide addon ids with no per-source mapping, and
`getBindings(deviceId)` answers ONE entry per cap by construction (D554 context
3). The information needed to write the authority correctly is not on the wire.

Three ways out were weighed:

1. **Write the authority anyway, mapping source → addon by a table in the
   widget.** Rejected: a hard-coded `native:reolink:* → provider-reolink` is a
   second authority on provider identity, living in the one package that has no
   business knowing it, and it is wrong the day a third source appears.
2. **Add `addonId` to `ClipSourceSchema` and re-key the deny set by SOURCE.**
   This is the right end state, and it is what D556 would have written had this
   surface existed. It is a `@camstack/types` + `@camstack/system` +
   `server/backend` change — a framework train — and slice 4's brief scopes the
   cap file to its `deviceConfig.ui` declaration alone. Deferred, not declined.
3. **Filter the view, persist nothing.** What shipped.

## Decision

> **Partly superseded by D555 the same day — see the section below.** The rule
> that survives is the conditional one: a persistent per-source switch requires
> a source row that names its own provider. That row now exists.

**The clips section's source picker is the capability's own `sources` view
filter and persists nothing.** `videoclips.listClips` already takes
`sources?: string[]` — documented on the cap as "the picker's selection,
forwarded" — and D549 decision 2 already says unselecting a source "hides it in
the view only". The tick boxes drive that argument and reach no store. The rule
that follows: **until a source row names its own provider, this surface offers
no persistent per-source switch at all** — not a mislabelled one, and not a
second store of its own.

Three properties are kept from the authority it does not write:

- **Unset means EVERY source.** The picker keeps a DENY list internally for the
  same reason the persisted store does (D556 decision 3): a source that
  registers later is visible with no second click.
- **A source is never hidden, only its rows.** Every source the camera has
  stays in the list with its availability and its catalog age, whatever is
  ticked.
- **Nothing is deduped.** A clip held in two storages appears twice, once per
  source, each row stamped with its own.

## Superseded in part by D555 (2026-09-20, same day)

Option 2 — the one this record calls "the right end state", deferred rather
than declined — **landed**:
[D555](adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md)
added `ClipSource.addonId` (stamped by the collection dispatcher from the
registry, so a row carries a fact rather than a provider's claim), re-keyed the
deny set to `DeviceCapBinding.disabledSourceIds`, gave `setWrapperActive` an
optional `sourceId`, and moved the per-source drop onto the ROW path where
sources are actually named. A pre-re-key addon-id entry still denies every
source that addon serves, by a read rule.

So **the DECISION below is lifted**: this surface may now offer a persistent
per-source switch, and its `onToggle` is the one function that changes —
exactly as the consequence predicted. The three properties it keeps (unset
means every source; a source is never hidden, only its rows; nothing is
deduped) are unchanged and are now also the persisted authority's properties.

Note also that the CASE this record measured is gone: Reolink collapsed its
two sources into one the same day (D555), so no addon on this fleet serves two
today. That does not restore the addon key — `listSources` answers one row per
SOURCE, so a per-row switch keyed by anything coarser can still lie about what
it did, and the grain belongs to the rows. This record's reasoning stands; only
its example moved.

One question D555 handed back to this surface — D556's contract dropped a
disabled source from `listSources`, so once the choice persisted an unticked
source had no row to un-tick — is **settled: D556 was amended the same day**
(see its "Amended 2026-09-20" section). `listSources` now answers every source
the camera has and MARKS the switched-off ones (`ClipSource.switchedOff`, a
boolean beside the availability, never a sixth member of it), a switched-off
source contributes no clips and no `catalogAsOf`, and this surface's three kept
properties are untouched. `onToggle` may be wired to
`deviceManager.setWrapperActive({ deviceId, capName:'videoclips',
wrapperAddonId: row.addonId, sourceId: row.source, active })` with nothing else
changing: the row it writes about is still there afterwards, saying it is off.

## Consequences

- The picker's selection does not survive a reload, and the section says
  nothing about persistence because there is nothing to say. An operator who
  wants a source off for a camera permanently has no control on this surface
  yet. **(Lifted by D555 — see above.)**
- Option 2 is the unblock and it is a framework train: `ClipSourceSchema` gains
  the addon that serves the row, `DeviceCapBinding.disabledSourceAddonIds`
  becomes source-keyed (or gains a sibling), and `sourcesForDevice` drops by
  source rather than by provider. When it lands, this picker's `onToggle` is
  the one function that changes, and D556's authority rule holds unmodified.
- `videoclips.listClips` is called WITHOUT `sources` while everything is
  ticked, which is the honest default and exactly today's behaviour for every
  camera on the fleet.

## Enforcement

Review only, plus one thing a test can hold: `clip-view-state.spec.ts` pins
that an unselected source's rows disappear while the source itself stays in
`answered` — so a future "fix" that hides the source row fails. Nothing guards
the absence of a persistent switch; if one is added, it must come with
`addonId` on the source row, and that is what this record is for.

## Amended 2026-09-20 (same day, third time) — the operator rejected the switch, the tab and the chrome

This record shipped a view filter, then lifted its own decision when D555 made
a persistent per-source switch expressible. The operator looked at what came
out of that and rejected three separate things in one sentence:

> *"La UI è orribile, non segue la nostra UI affatto, poi vedo 3 sorgenti
> camstack e una onboard che non sembra funzionare. Camstack dovrebbe essere
> solamente una no? Io in realtà utilizzerei la stessa tab recordings, lì
> abbiamo già tutto il necessario, una nuova sezione alla fine per le clips
> dove possiamo selezionare le source con un multiselect common, non componenti
> nuovi anonimi. Poi ovviamente la onboard deve funzionare e in realtà non è
> affatto necessario lo stato di abilitato o meno delle sources. Loro vivono lì,
> ad esempio hksv c'è se la camera è esportata su homekit, reolink la dà di suo
> così come il camstack."*
>
> [The UI is horrible, it does not follow our UI at all, then I see 3 camstack sources and an onboard one that does not seem to work. Camstack should be only one, no? I would actually use the same recordings tab, we already have everything necessary there, a new section at the end for the clips where we can select the sources with a common multiselect, not new anonymous components. Then of course the onboard one must work and actually the enabled-or-not state of the sources is not necessary at all. They live there, for example hksv is there if the camera is exported to homekit, reolink provides it by itself, and so does camstack.]

Three things, and the third is the one that reaches this record's decision.

### 1. It is not a tab. It is a section at the end of the Recording tab.

**What was built.** `videoclips.cap.ts` declared `tab:'clips', topTab:true,
order:0`, and `WELL_KNOWN_TABS` gained a `clips` entry to give that tab a label
and an icon. The device page grew a header tab of its own, beside Recording.

**Why it looked right.** The reasoning is still in `WELL_KNOWN_TABS`'s deleted
comment: *"it sits next to Recording because that is the other place an operator
looks for footage"*. Having named Recording as the neighbour, the record never
asked why it was a neighbour rather than a part.

**Why it was wrong.** Recording already carries every control about this
camera's footage — the recorder's panel, the schedule bands, and the retention
policy `pipeline-analytics` re-homes there. A second tab splits one question in
two, and the operator has to know which half a thing is under. His own words are
that the tab *"ha già tutto il necessario"* [already has everything necessary].

**What replaced it.** `tab:'recording'`, `order:100` — the same `topTab:true`
widget, last section of the tab it already belonged in. `WELL_KNOWN_TABS` lost
its `clips` entry and `WellKnownTabId` its member, because a well-known id that
nothing declares is an invitation to mint the tab again. Placement is data
(D14), so nothing in `DeviceDetail.tsx` moved — and because the admin Recordings
page renders every `location:'top-tab'` + `tab:'recording'` section behind its
camera picker (`CameraRecordingSettingsSection`), one declaration put the
section on BOTH surfaces with no second wiring. Pinned by
`packages/types/src/__tests__/clips-section-placement.spec.ts`.

### 2. The chrome is the library's, and the picker is the common multiselect.

**What was built.** Five components nothing else uses — `ClipsBrowser`,
`ClipSourceRow`, `ClipSilentSources`, `ClipTile`, `ClipPanel` — with hand-rolled
borders, hand-picked `text-emerald/amber/rose` tones, a hand-written
`<input type="checkbox">` list for the sources, and no pager.

**Why it looked right.** Each was written to make one of the four states
unmistakable, and they do. Nothing about the STATES was wrong; they are the
feature and they are unchanged.

**Why it was wrong.** *"non segue la nostra UI affatto … non componenti nuovi
anonimi."* [it does not follow our UI at all … not new anonymous components.] The repo already has every one of these shapes, tested and themed,
and a per-surface copy of a list or a tick box is how a product stops looking
like one product. The tick boxes were the worst of it: the operator asked for
*"un multiselect common"* by name.

**What replaced it.** One `ClipsSection.tsx`, composed from components that
already existed:

| what it draws | component |
| --- | --- |
| source selection | `Select` — the same control the Recordings page's camera picker uses |
| the camera's sources, with state, reason and catalog age | `DataTable` |
| sources that contributed nothing; a failed read; a served-twin mismatch | `ErrorBox` (`warning` / `danger`) |
| an empty day, a camera no provider answered for, an absent capability | `EmptyState` |
| the clip tiles and the playback panel | `Card` + `Badge` |
| more than one page of tiles | `Pagination` |
| a query still out, a mint in flight | `Skeleton` |

`ClipsBrowser`, `ClipSourceRow` and `ClipSilentSources` are deleted; `ClipTile`
and `ClipPanel` keep only the decisions that are theirs (the mint ladder, the
playback handoff) and draw them with the components above. **All five pure
modules survive untouched** — `clip-source-state.ts`, `clip-day-window.ts`,
`clip-tile-media.ts`, `clip-thumbnail-fetch.ts`, `clip-view-state.ts` — because
they are where the decisions live, and their five specs still pass unmodified.

### 3. Sources are not enabled or disabled. They EXIST.

**What was built.** D555 lifted this record's decision and the surface was on
its way to a persistent per-source switch: `ClipSource.switchedOff`, a
source-keyed deny set (`DeviceCapBinding.disabledSourceIds`), a `sourceId`
argument on `setWrapperActive`, a registry projection with a boot replay.

**Why it looked right.** The analysis was sound on its own terms: if the
operator is going to turn a source off, the store has to be keyed at the grain
he is turning off, or the switch lies about what it did. That reasoning is
correct and is not what was wrong.

**Why it was wrong.** It answered "at what grain does this switch write" without
having established that the switch should exist. The operator's reasoning is
better than the one this record and D556 were built on: *a source is there
because of a configuration that lives somewhere else.* HKSV exists if the camera
is exported to HomeKit. The Reolink source exists because Reolink is that
camera's provider. CamStack's is always there. Each of those is already an
authority, on its own surface, and none of them is a question a clips list gets
to answer. A per-source on/off here is therefore a second knob over somebody
else's decision — which is D62's failure, arrived at from a direction D62 does
not describe: not a store nobody reads, but a store that should never have been
asked.

**What replaced it.** This record's ORIGINAL decision, restored and this time
not conditional: **the picker chooses what to LOOK at and persists nothing.**
The sentence D555 lifted is reinstated and generalised: **this surface offers
no persistent per-source switch, and the reason is no longer that it cannot
express one.**

### 4. And the picker is a SELECTOR, because the cap stopped being a sum.

This record's view filter was `listClips({ sources: string[] })` — a fan-out
over everything a camera has, narrowed client-side. While the rebuild was in
flight the operator settled that differently: *"il get videoclips prendere un
provider opzionale, di default va su camstack … l'utilizzatore è uno solo."* [the get videoclips takes an optional provider, by default it goes to camstack … there is only one consumer.]
`listClips` now takes ONE `provider` — an addon id from a `listSources` row,
absent meaning the camera's bound provider — and a provider the device is not
bound to is refused by name rather than answered by another.

That reaches this surface twice, and the second is the one worth writing down:

- **A multiselect would now be a control that lies.** A multi-pick over a
  one-at-a-time argument offers a sum the hub cannot answer. The operator asked
  for *"un multiselect common"* when a sum was what the cap served; the part of
  that sentence that survives the change is **common**, and the shared
  single-choice control is `Select` — the same one the Recordings page's camera
  picker uses. Choosing the named component over the honest one would have been
  obeying the letter of a sentence about a contract that no longer exists.
- **One provider is a fleet STATE, and the section says so.** `listSources`
  derives from `deviceManager.getBindings`, and nothing on this fleet binds
  `provider-reolink` for `videoclips` yet, so a real camera answers with one
  provider. The selector is inert and carries a line saying why. An empty or
  silently single-entry control reads as a defect, and the fix would then be
  looked for in the UI rather than in the binding store — which is where it is
  (a collection cap's bindings learning to hold several providers, being built
  separately).

With the fan-out gone there is nothing left to filter client-side, so
`ClipsViewInput.selected` and `applySelection` were **deleted** from
`clip-view-state.ts` rather than left unused: a leftover that describes the
right design for a retired contract reads as verification. What they existed to
protect is unchanged and still pinned — every source the camera HAS is
described, with its availability, whichever provider was asked. Of this
record's three kept properties, that one and "nothing is deduped" stand as
written; "unset means every source" is now **"unset means the camera's bound
provider"**, which is the same instinct (absence is the fleet's current
behaviour, never a blank surface) against a contract that changed.

**What this record does NOT do** *(closed 2026-09-20 — see the last amendment
below; the passage is kept because it is the reason the removal was left half
done for a few hours)*. It does not remove the per-source deny
machinery itself (`ClipSource.switchedOff`, `DeviceCapBinding.disabledSourceIds`,
`setWrapperActive`'s `sourceId`, `ICapabilityRegistry`'s three per-source
members and the boot replay). That removal was in flight in
`server/backend/src/api/trpc/device-collection-dispatch.ts` while this was
written, and half a removal is worse than none. `setWrapperActive` itself stays
regardless: it is the pre-existing per-camera wrapper authority (D62) and only
the per-source extension was ever in question. **Open, and owned by whoever
finishes the dispatcher:** the types and system halves, plus
`videoclips-device-source-activation.spec.ts` and check 6 of
`scripts/check-device-selection-authority.ts`, which exist only to hold the
extension up.

## Enforcement (amended)

- `packages/types/src/__tests__/clips-section-placement.spec.ts` — the
  declaration is the placement, so the placement is pinned on the declaration:
  `tab:'recording'`, `topTab:true`, an order at the end, and no `clips` entry in
  `WELL_KNOWN_TABS`. Proven red by restoring any one of them.
- `packages/ui-library/src/composites/clips/__tests__/clips-section-states.test.tsx`
  — the four states ON SCREEN, in words an operator would read, each case named
  after a real camera (106 no-storage, 108 index-empty, 3628 unreachable + a
  `playable:false` row, 4263 sleeping-with-age). Proven red by dropping the
  silent block from the `listed` branch (1 of 55) and from the `empty` branch
  (2 of 55).
- `clips-section-sources.test.tsx` — the picker is one combobox with no tick
  boxes anywhere; unset asks `listClips` with no `provider`; a choice sends the
  ADDON id and never a source id; a camera with one bound provider gets an
  INERT selector that names it and a line saying why; every source keeps its
  row whichever provider is asked. Plus a SOURCE guard over the whole
  directory: no file in the clips surface may mention `setWrapperActive`,
  `switchedOff`, `DisabledSource` or `useMutation`. A render test cannot see a
  mutation the fixtures never reach, and this is the one property the operator
  asked for in words. Proven red five ways: dropping the `provider` forward,
  keying the options by source id instead of addon id, silencing the
  one-provider line, leaving the lone selector live, and adding the word
  `setWrapperActive` to the section in a comment.
- `clips-section-presence.test.tsx` (D315's four answers) and
  `clips-section-playback.test.tsx` (the `format` reaches the shared hero; the
  served twin is named) carry over unchanged but for the component's name.
  Proven red by collapsing `unknown`, by dropping `format`, and by hiding the
  mismatch line.

## Amended 2026-09-20 (fourth) — the wire half: one provider per call, and the stamp is all that survives

This record's subject was a picker that filtered a VIEW because the persisted
authority was keyed by addon rather than by source. Both halves of that premise
are gone:

- **There is no filter.** `videoclips.listClips`'s `sources?: string[]` is
  replaced by `provider: string` — ONE addon id, from a `listSources` row
  (*"l'utilizzatore è uno solo"* [there is only one consumer]). A pin the device is not bound to is refused
  by name rather than answered by another provider.

  **Corrected the same day:** this bullet first wrote it `provider?: string`,
  *"absent meaning the device's bound provider"*. Nothing implemented that, and
  on device 107 a bare call answered with both sources merged. Naming it is
  REQUIRED — the reasoning, the measurement and the enforcement are in
  [D554](adr-0554-a-per-device-wrapper-that-becomes-a-collection-stays-per-device-and-its-sources-are-fanned-out-not-picked.md)'s
  last amendment, which is the single record for this question. The provider-side half went
  too: `addon-provider-reolink`'s `sources`-filter branch could only ever say
  "not me", which the router now says first, and its test was deleted with a
  marker naming the spec that replaced it.
- **There is no per-source key**, because there is no switch (D556 closed
  fourth). A source exists for a camera because a BINDING put it there.

**What this record decided that IS still true**, and is the whole of what
survives in `finishRows`: a source row is stamped with the addon that really
serves it, from the registry, because a surface cannot otherwise resolve a row
to a provider and the alternative — a `native:reolink:* → provider-reolink`
prefix table inside the widget — is a second authority on provider identity
living in the one package with no business knowing it. That stamp is now what
the `provider` pin is quoted FROM, so it went from a display detail to part of
the call.


## Amended 2026-09-20 (last) — the half-removal is finished

The passage above left the types and system halves open *"for whoever finishes
the dispatcher"*, deliberately: two agents were removing the same machinery in
different files at the same time and half a removal is worse than none. It is
finished now, in one pass, alongside
[D560](adr-0560-a-clip-source-over-recorded-footage-is-registered-by-the-addon-that-owns-the-footage-and-the-half-that-went-remote-is-the-half-that-needs-a-degradation.md)
and separately from it in the diff, for the same reason: two changes to one
surface in one commit and nobody can tell afterwards which one broke what.

`ClipSource.switchedOff` and `setWrapperActive`'s `sourceId` are deleted, each
verified unread across the repo (the viewer submodule and the generated files
included) before it went. The registry's per-source members, the boot replay
and `DeviceCapBinding.disabledSourceIds` had already gone with the dispatcher.
`videoclips-device-source-activation.spec.ts` was deleted with the design it
pinned, and is named here rather than dropped from the Enforcement list so the
absence reads as a decision and not as a gap.

**And check 6 of `scripts/check-device-selection-authority.ts` was already
gone.** That script is three checks today, not six; this record and D556 both
still describe a longer version of it. The three that remain were each
re-proven red after the sweep — see D556's last amendment for how.

The Enforcement bullet above that pins the clips surface
(`clips-section-sources.test.tsx`'s source guard over the whole directory,
`FORBIDDEN = ['setWrapperActive', 'switchedOff', 'DisabledSource',
'useMutation']`) is UNCHANGED and now has one less way to fail: two of the four
words it forbids no longer name anything.
