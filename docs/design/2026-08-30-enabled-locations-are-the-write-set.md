---
title: Enabled locations are the write set — deleting isDefault, and splitting readOnly in two
last-verified: 2026-09-07
covers:
  - packages/types/src/interfaces/storage-location.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.service.ts
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
  - packages/system/src/builtins/storage-orchestrator/location-store.ts
  - packages/system/src/builtins/storage-orchestrator/storage-pressure-manager.ts
  - packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/placement-service.ts
  - packages/addon-pipeline/src/recorder/addon/placement-planner.ts
  - packages/addon-pipeline/src/recorder/storage-evictable-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts
  - packages/addon-admin-ui/src/components/storage/location-enabled.ts
---

# Enabled locations are the write set

> **The operator's model, verbatim:** *"Abilitare N locations dovrebbe rendere
> il sistema capace di usarle tutte contemporaneamente. Disabilitarne una la
> rende read-only."* [Enabling N locations should make the system able to use all of them at the same time. Disabling one makes it read-only.] And, added as a decision while this was being written:
> *"Aggiungi anche l'eliminazione del concetto di default, non ha veramente
> senso ed è confusionario."* [Also add the removal of the concept of default; it does not really make sense and is confusing.]
>
> So: **enabled = writable, all enabled locations of a class are used at once,
> disabled = read-only-but-still-served — and `isDefault` is deleted, not
> demoted.** This document designs that.
>
> **Status, 2026-09-07 — Stages 1 (D308), 2 and 3 (D383) are shipped.** The
> default is deleted: `isDefault`, `getDefaultLocation` and
> `setDefaultLocations` are gone from the schema, the cap, the orchestrator, the
> recorder, analytics, the UI and the tests, and a CI guard refuses their
> return. `setWriteTargets` replaced the cutover verb, and every legacy flagless
> row is stamped `enabled: true` by a one-time boot migration.
>
> Two parts of this document did NOT ship and are still the plan:
>
>   - **the `hold` / `readOnly` split (§2).** `config.readOnly` is still an
>     untyped config key with its typo hazard, and it still subtracts a location
>     from the eviction domain. Nothing in the operator's spec depended on it,
>     and coupling it to the default's deletion would have doubled the blast
>     radius of one deploy.
>   - **Stage 4 (backups' second switch, §3.6) and Stage 5 (retiring the
>     transitional bare-ref rule).** Stage 4's fan-out already honours the
>     location flag as of D308; what remains is merging `policy.enabled` away.
>
> Three details of the plan below were superseded BY the implementation:
> (a) §3.1's `setWriteTargets` narrows a class to one member — the shipped verb
> takes `{locationId → enabled}` and moves only what it is given, because a
> migration must not shrink a pool the operator grew; (b) §3.2's deterministic
> first-of-type bootstrap pick is instead the EMPTIEST enabled member (the same
> headroom signal the planner uses, so the pick and the plan agree); (c) §3.1's
> `requiresWriteTarget` declaration flag was not added — the refusal reads the
> existing `OPTIONAL_WRITE_TYPES` set (`backups`), the same rule with one less
> schema surface, and §6's item 5 applies to it unchanged.

**Why he is right, measured on the live hub today (2026-08-30).** After
`recordingsLow` was repointed to `recordingsLow:ssd`, three cameras (1439,
3839, 104) are still writing to `recordingsLow:default` — the disk the running
drain (`d321f141`) is emptying. 18 placement decisions in 40 minutes carried
`divergent: true` (`locationId: recordingsLow:default`,
`authorityLocationId: recordingsLow:ssd`). D301 made the disagreement
*visible*, and deliberately does not fix it retroactively (an absent authority
stamp must never be read as a repoint — clause 3). The disagreement exists at
all because the system has **three** write authorities per class — the default
(`isDefault`), the stored per-camera assignment, and the pool (`enabled`) —
and they can point three different ways. Under the operator's model there is
exactly one: the pool. A camera writing to a location outside the pool is not
a divergence to report; it is unrepresentable.

---

## 1 · What each flag does today — with the call sites

Read this section before touching anything: the model change is mostly a
*deletion*, and you cannot delete what you have not enumerated.

### 1.1 `enabled` (`StorageLocation.enabled`, in the schema)

Declared at `packages/types/src/interfaces/storage-location.ts:78`. Optional,
and **three-valued in effect**: `true`, `false`, and *absent* — absent means
active, and the difference is load-bearing
(`storage-orchestrator.service.ts:1082`): stamping a legacy flagless row on an
unrelated edit would rewrite an implicit contract. Persisted inside the
location's config JSON under `__enabled`
(`packages/system/src/builtins/storage-orchestrator/location-store.ts:178`).

**Every place a write target is chosen, with a verdict** (repo-wide audit,
2026-08-30 — this is the "is `enabled` honoured everywhere?" question, answered
per chooser rather than by the one docblock that claims it):

| Write chooser | Site | Honours `enabled: false`? |
| --- | --- | --- |
| Recorder placement pool | `packages/addon-pipeline/src/recorder/addon/roots.ts:129` (`placementPool`) | **Yes** — `enabled !== false` is the pool filter |
| Event-media write pick | `packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts:37` (`pickWritableMediaLocation`, fed from `pipeline-analytics/index.ts:2915`) | **Yes** — `enabled && !readOnly` |
| Gallery-media writes | `store/media-store.ts:312` (`locationForOwnerKind`), used with the bare `galleryMedia` ref (`pipeline-analytics/index.ts:5156`) | **Moot** — `cardinality: 'single'`: one location, born enabled as first-of-type; there is no set to choose from |
| Backup fan-out | `backup-orchestrator.addon.ts:334` + its own policy table (`:393`) | **NO** — ignores the flag entirely; a location shown disabled still receives tonight's archive (§3.6) |
| Relocate-mover targets | `packages/addon-pipeline/src/recorder/relocate-engine.ts:223` | **NO** — refuses a `readOnly` target only; an operator can aim a drain at a disabled location |
| `storage` cap write/upload methods | orchestrator dispatch | **No, by design** — cap I/O goes wherever the caller's row/ref says; this is what lets movers and per-row reads work at all, and it must stay |

And the flag's *non*-consumers on the keep-shrinking side, each verified in
code rather than taken from the docblock:

- **Disk-pressure eviction ignores it.** `domainOf` subtracts only members the
  injected `isReadOnly` names (`storage-evictable-provider.ts:100`), and that
  predicate reads `readOnly` alone
  (`packages/addon-pipeline/src/recorder/addon/index.ts:1007`). No reader in
  the repo subtracts a *disabled* location from an eviction domain.
- **Retention-age sweeps ignore it.** The prune selects per device from the
  archive (`selectEvictionsFromArchive`, called at
  `recording-provider.ts:1138`) with no location predicate, and deletes each
  victim under its own row's `locationId` (`recording-provider.ts:632`).
- **Drains ignore it.** `relocate-engine.start` checks a *source* only for
  existence (`relocate-engine.ts:220`) — a disabled source drains fine.

So `placementPool`'s docblock claim — *"still READ, age-swept and drained —
simply never a write target"* — **holds in code, not just in the comment**,
and the operator's model is already implemented at the recorder and
event-media layers. What remains is not a from-scratch redesign: it is
(a) deleting the default, the *second* write authority layered over the pool;
(b) making the two non-honouring choosers above honour `enabled`; and
(c) settling what `readOnly` still means once `enabled` carries "not
written" — §2, where the eviction coupling turns out to be `readOnly`'s
problem alone.

### 1.2 `isDefault` (in the schema) — every reader

Declared at `storage-location.ts:62`. §3 is the removal catalog; the list of
readers is there.

### 1.3 `config.readOnly` (in **no** schema)

An untyped config key, read tolerantly in exactly two addons:

- Recorder: `roots.ts:230` (`l.config['readOnly'] === true`) → carried as
  `RecordingsLocation.readOnly` (`roots.ts:34`). Effects: excluded from write
  targets (`roots.ts:151`, `placement-service.ts:444`, `:534`, `:782`), refused
  as a relocate *target* (`relocate-engine.ts:223`), and — the sharp one —
  **subtracted from the disk-pressure eviction domain**
  (`packages/addon-pipeline/src/recorder/storage-evictable-provider.ts:100`,
  wired at `packages/addon-pipeline/src/recorder/addon/index.ts:1007`).
  Retention-age sweeps still prune it (deliberate; comment at
  `storage-evictable-provider.ts:75`).
- Post-analysis: `pipeline-analytics/index.ts:2914` → `MediaLocation.readOnly`,
  same write-exclusion role (`media-locations.ts:37`).

A typo (`readonly`, `read_only`) silently means "not read-only". Nothing else
in the repo reads it.

**The load-bearing hazard, restated.** `recordings:default` and
`recordingsLow:default` share the physical root `/recordings`. `domainOf`
subtracts read-only members from the eviction domain
(`storage-evictable-provider.ts:104`), so marking `recordingsLow:default`
read-only removes `low` footage from the evictable total of a disk under
continuous quota pressure — the sweep then takes the shortfall out of `high`.
That is why the migration runbook was corrected: *do not mark the source
read-only during a drain* (non-blocking design §5). `readOnly` cannot be the
meaning of "disabled", because a retiring disk **must keep shrinking**.

---

## 2 · The crux: one name, two states

The operator's "disabled = read-only" hides two states that today share the
one word, and the design's first obligation is to name them:

| | **standby** | **hold** |
| --- | --- | --- |
| Written by placement / media pick | no | no |
| Read / playback / export | yes | yes |
| Disk-pressure eviction | **yes — stays in the domain** | no — subtracted |
| Retention-age prune | yes | **no** |
| Relocate mover may empty it | yes (that is the drain) | no — refused both as source and target |
| Meaning | a disk being retired, or simply not in use for new writes — **must keep shrinking** | a disk that is failing, unmounted, or under forensic hold — **nothing touches the bytes** |

**Decision: `enabled: false` maps to standby.** That is already its exact
behavior today — `placementPool` excludes it, nothing else consults it — so
the mapping costs zero migration and honors "disabilitarne una la rende
read-only" without re-opening the eviction-domain trap: a standby location
stays first-class in `domainOf`, the retiring disk keeps shrinking, and the
drain runbook's correction becomes structural instead of procedural.

**Decision: `hold` becomes a real schema field** (`StorageLocation.hold`,
optional boolean, absent = not held), and **`config.readOnly` is retired**:

- The orchestrator reads `config.readOnly === true` as a legacy alias for
  `hold` and logs one warn per boot per location naming it. Consumers
  (recorder `roots.ts:230`, analytics `index.ts:2914`) switch to the schema
  field and stop reading config.
- `domainOf`'s subtraction and the mover-target refusal re-key onto `hold`.
- **One behavior delta to state plainly:** a legacy `readOnly` location stops
  being age-pruned (hold = untouched; today readOnly is still pruned). That is
  the safe direction for what `hold` means, and the *drain* use of `readOnly` —
  the only use where continued pruning mattered — is superseded by standby.
- Setting `hold` on a location that shares a physical root with a non-held
  sibling gets a **named warning** at upsert (the machinery exists:
  `getLocationDeviceKey`, `storage-orchestrator.addon.ts`). The pressure
  arithmetic on a shared root genuinely transfers to the sibling — that is
  inherent to "do not touch these bytes" on a shared disk, and it must read as
  a stated cost, not a surprise (D62's principle: state, honestly displayed).
- The relocate mover's target check widens with the split: today it refuses
  only a `readOnly` target (`relocate-engine.ts:223`). It must refuse a `hold`
  target (nothing touches those bytes, in either direction), and a **standby
  target is allowed with a log line** — deliberately: draining residue *onto*
  a big archive disk that is not in the write set is a legitimate operator
  move, and the mover takes a named target rather than making placement
  decisions (D54's shape).

The typo hazard dies with the config key: `hold` is Zod-validated at the cap
boundary like every other schema field.

---

## 3 · Deleting `isDefault` — every reader, and what each asks instead

This is the hardest part of the change. The default is consulted in five
packages plus the generated surfaces. For each reader: what it asks the
default *for* today, and its answer when there is no default.

### 3.1 The orchestrator itself

| Reader | Today | After |
| --- | --- | --- |
| `getDefaultLocation` (`storage-orchestrator.service.ts:438`) + the cap method (`packages/types/src/capabilities/storage.cap.ts:133`) + the generated hook | "the one location of type X" | **Deleted.** Cap change ⇒ `npm run codegen`. Every caller is in this table. |
| `resolveRef` bare-type branch (`storage-orchestrator.service.ts:850`) | resolve `'backups'` → the default row | See §3.5 — the one genuinely hard case. |
| `setDefaultLocations` (`:451`) | the migration cutover: atomically move `isDefault` per class, force-enabling the target (`:472`) | Replaced by **`setWriteTargets(targetsByClass)`**: one compensated commit that sets `enabled: true` on the targets and `enabled: false` on every other location of the class. Same shape, same persistence/compensation discipline, same coordinator-only reachability. The force-enable survives as "the cutover enables its target". |
| `upsertLocation` demotion loop (`:656`) | keep exactly one default per type | Deleted. |
| `deleteLocation` last-default guard (`:720`) | don't delete the only default | Replaced by a **last-location-of-a-declared-type** refusal — stronger and simpler: consumers lose their target when the *type* empties, not when a flag moves. D293's occupancy probe is untouched and still runs first-class. |
| `seedDefaults` (`:1056`, `isDefault: true`) | seed one default per declared type | Seeds `enabled: true` instead. The id slug `<type>:default` **stays** — it is only a name, idempotency across existing installs depends on it, and renaming it would churn every persisted row for cosmetics. |
| `resolveEnabled` (`:1109`, `:1113`) | first-of-type born enabled; the default force-enabled | `:1109` keeps its `!typeAlreadyHasLocation` half (first of a type is born enabled — nothing else could serve). `:1113` (default forced on) is replaced by a refusal in `upsertLocation`: **disabling the last enabled location of a write-serving class is refused**, loudly, with the class named. Which classes are "write-serving" comes from a new `StorageLocationDeclaration` flag (`requiresWriteTarget: true` on `recordings`, `recordingsLow`, `eventMedia`, and the infrastructure types `data`/`logs`/`sqlite`/`addons-data`; `false` on `backups` — zero enabled backup destinations is a legal, if sad, configuration). The declaration schema already carries per-kind constraints this way (`access`, D296 — see `storage-location-declaration.ts:94`), so this is the established pattern, not new machinery. |
| `location-store` `is_default` column (`location-store.ts:185`, `:237`) | persistence | Stop writing and stop reading it. **The column stays as dead data — no row rewrite at all.** That is the whole migration story for persisted defaults, and it is what makes an interrupted deploy safe: old code reads rows new code wrote (column absent from the upsert map ⇒ written as 0/undefined — verify the store's column handling before shipping), new code ignores rows old code wrote. Re-runnable by construction because nothing is rewritten. |

### 3.2 The recorder

| Reader | Today | After |
| --- | --- | --- |
| `resolvePlacement` tiebreak (`roots.ts:160`, `:162`) | prefer the default among writable pool members, for a camera **no plan has placed yet** (first attach before the first tick) | Deterministic pick: first writable of the preferred type, sorted by id. The 30 s planner tick then refines by headroom and the merge persists it (D302). Cost: a brand-new camera's first minutes of segments may land on a disk the tick then moves it off — one extra writer restart, bounded by the planner's hysteresis (`placement-planner.ts:81`, `DEFAULT_OFF_TARGET_PP = 15`). |
| `placementPool` middle fallback tier (`roots.ts:131` — "nothing enabled ⇒ the defaults serve") | the shout-and-write-somewhere fallback | The tier is deleted; the fallback goes straight to "**all** locations, shouting" (`roots.ts:133`, today's last tier — the warn at `placement-service.ts:391` stays). With the last-writable refusal of §3.1 this branch is reachable only through a hand-edited store, and a recorder that writes to a standby location **under loud protest** is still better than one that silently writes nowhere — the same reasoning the branch documents today. This is the one deliberate breach of "disabled is never written", and it is stated here rather than discovered. |
| `authorityLocations` (`roots.ts:91`) + the D301 stamp/repoint/divergence machinery (`placement-service.ts:424`, `:109`, `:664`) | detect a repoint of the class authority and rewrite/report against it | **Deleted, and D301 gets a superseding record.** With no default there is no class authority distinct from the pool: the operator's instruction *is* pool membership, a location leaving the pool already invalidates every assignment naming it (`placement-service.ts:444` — this predates D301 and stays), and the planner already moves those keys with `reason: 'gone'`. What D301's divergence report was *for* — "who writes where, per camera, never silent" — survives as a simpler **per-class placement census line** (one line per episode/hour: assignments per location, with the denominator, D277-style). The D301 spec (`placement-repoint.spec.ts`) is rewritten around the census; deleting its stamp machinery must not leave the merge (`writePlacementPass`, D302) behind — the merge stays, its `repointed` input becomes empty forever, and the blob's `defaultLocations` key becomes dead data the reader ignores. |
| `RecordingsLocation.isDefault` (`roots.ts:35`, mapped at `:231`) | carries the flag to the two readers above | Deleted with them. |

**Is the existing planner sufficient for "use all N at once"? Yes.**
`planPlacement` already spreads (camera, profile) assignments across the pool
weighted by headroom (`min(free − minFree floor, maxUsedGb − used)`,
`placement-service.ts:777`), already protects standing assignments with a
15 pp hysteresis band, already evacuates read-only and headroom-exhausted
members, and already hands genuine ties to the rotation (D37). Two enabled
locations of a class **already** both receive writes today. No new
distribution machinery is needed — the change deletes the two authorities
layered on top of the pool (default, and D301's stamp of it), it does not add
a third.

### 3.3 The migration coordinator

| Reader | Today | After |
| --- | --- | --- |
| `plan()` source (`storage-migration-coordinator.ts:170`) | "the source is the class default" | The source set is **derived: every enabled location of the class other than the target** (plus, for the drain census, every location holding residue). Input stays `{ class → toLocationId }`. |
| The already-default refusal (`:180`) | "target is already the default ⇒ nothing to repoint" | Becomes "**target is already the sole enabled location of the class** ⇒ nothing to cut over — use `storageMigration.drain`". Same protection, same meaning: `start` still refuses to re-run a finished cutover, and `drain` (`:551`) still exists precisely because the drain half may be unfinished after the cutover half is unrepeatable. The two-verb split survives intact. |
| `run()` `repointing` phase (`:731`) | `setDefaultLocations(targets)` | `setWriteTargets(targets)` (§3.1). The phase machine is otherwise **unchanged**: `sealing → pausing → repointing → refreshing → resuming → draining → verifying` — the pause/refresh/resume round is still required (writers re-resolve their pool only at an attach boundary; analytics' write-location cache is still lease-gated), so the cutover still costs one attach round, seconds. The phase could be renamed `retargeting`; the durable job record's phase strings are persisted, so a rename must map old values on read or keep the string. Keep the string. |
| Seal target (`:237`) | "stamp NULL rows with the current default's id" | The seal names its target explicitly (it already takes `toLocationId`); the coordinator passes the class's current *write target that holds the legacy bytes* — in practice the location being retired. The D292 gate (refuse a non-blocking `eventMedia` cutover while `countUnstamped > 0`) is **unchanged and becomes load-bearing for §3.5**. |
| `residue()` target (`:481`), `drain` targets (`:503`) | "everything outside the default is residue; drain it to the default" | Residue = everything on a location **outside the enabled write set** (and, transitionally, everything a drain input names). The drain's destination comes from the write set: one enabled member ⇒ that one; several ⇒ the drain input must name one explicitly (a drain that "spreads" residue across the set is a placement decision, and bulk movers do not make placement decisions — they take a named target, D54's shape). |

What a migration **becomes**, end to end: *enable the target (it was created
born-disabled), run the seal if `eventMedia` is included, then one coordinator
verb that disables the source(s) and enables the target under a lease'd
pause/refresh/resume round, then drain, then verify, then — separately, later,
guarded by D293 — delete the source.* The repoint-the-default step is gone
because the thing it repointed is gone. Nothing about D291's hour-row
ordering, D292's seal, or the drain/residue/movers surfaces (D295/D296)
changes.

### 3.4 Post-analysis (`eventMedia`)

| Reader | Today | After |
| --- | --- | --- |
| `resolveEventMediaWriteLocation` stickiness (`pipeline-analytics/index.ts:2918` — `currentDefaultId`) | "keep writing where the default points while it is writable" | Stickiness anchors on the **cached last pick** (the cache at `:2894` already provides it within a process); cold start picks by headroom. Cross-restart stickiness is not worth a durable record: every blob row stamps its own `locationId`, so a restart that switches disks splits nothing that reads wrong. |
| The degrade path (list failure ⇒ bare `eventMedia` ref, `locationId: null`) | "wherever eventMedia points" | Serve-stale: reuse the last known pick instead of degrading to a bare ref; a process that has *never* resolved the list refuses the write loudly (the refusal already exists for the no-writable case). This is what finally stops minting new NULL rows — D292 already fixed the retrain path; this closes the last writer. |
| `mediaRowLocation` NULL fallback (`store/media-store.ts:316` → `DEFAULT_MEDIA_LOCATION = 'eventMedia'`, `:274`) | a NULL row reads from the current default | Transitional: §3.5 keeps the bare ref readable. End state (Stage 5): after `countUnstamped` is durably zero, a NULL row is a *fault* — logged, surfaced, never silently pointed at a guess. |
| `location-aware-media-storage` `defaultLocation` dep | the location id the **boot-time base provider** owns — a wiring fact, not `isDefault` | Kept; rename the field (`baseLocation`) so nobody mistakes it for the deleted concept. Its invalidation logic is untouched. |

### 3.5 Bare type refs — the one hard residue of the default

`resolveRef('backups')` — any ref without `:` — resolves through the default
today (`storage-orchestrator.service.ts:850`). Deleting the default forces an
answer per cardinality:

- **Types with exactly one location** (all `cardinality: 'single'` types, and
  any multi type that has only its seeded row — which is every type on a
  fresh install): the bare ref resolves to **the sole row**. This covers
  `data`, `logs`, `sqlite`, `addons-data`, `galleryMedia`, and every
  infrastructure consumer that says `storage.resolve({ location: 'data' })`.
  No caller changes.
- **Multi types with several rows**: a bare ref is ambiguous and the honest
  end state is a **refusal naming the candidates**. But one population cannot
  be refused yet: `eventMedia` rows with `locationId: NULL` read through the
  bare ref, and their bytes are on the row seeded first — `eventMedia:default`
  by slug. So the **transitional rule**: a bare multi-type ref resolves to the
  row whose slug is `:default` when one exists, logged as deprecated with the
  caller's ref; refused otherwise. This is a *lexical* anchor (a name, not a
  stored flag), it exists only to keep legacy NULL rows readable, and it is
  deleted (Stage 5) once `countUnstamped` reports zero durably — the same
  counter D292's gate already trusts. Note the transitional rule is anchored
  to the slug precisely because the bytes of every pre-migration NULL row were
  written when `eventMedia:default` *was* the write target; a slug-anchored
  read cannot be repointed out from under them by any later cutover, which is
  strictly safer than today's behavior (the non-blocking design §4 documents
  NULL rows going dark at cutover).
- A CI guard (`scripts/`) greps for bare multi-type refs in new code the same
  way the access-declaration guard does
  (`scripts/check-storage-access-declarations.ts` is the template).

### 3.6 `backup-orchestrator` — the brief's assumption, corrected

**It does not read the default at all.** Verified today: destinations are
`listLocations({ type: 'backups' })`, every row, joined with its own
`backup_destination_policies` table (`backup-orchestrator.addon.ts:334`,
`:309`); archives are uploaded per destination by concrete id; no
`getDefaultLocation`, no bare `'backups'` ref on the upload path. Deleting
the default costs backups nothing.

What the audit *did* find is a live D62 shape: **two enabled switches for one
function**. A second `backups` location is created `enabled: false` by
`resolveEnabled` (born inert), but backup-orchestrator ignores
`StorageLocation.enabled` and seeds its policy `enabled: true`
(`backup-orchestrator.addon.ts:393`, `:396`) — so a location the storage
screen shows as disabled **receives tonight's archive anyway**. Two knobs, one
ignored. Under this design the location's `enabled` is THE write switch for
every class; Stage 4 makes the fan-out consult it (`isLocationEnabled`) and
deletes `policy.enabled`, leaving the policy table what it really is — label,
cron, retention. Until Stage 4 ships, the disagreement should at least be
*displayed* (the destination card naming the location flag it overrides).

### 3.7 The admin UI

Every `isDefault` surface, found today:

| Surface | Today | After |
| --- | --- | --- |
| `LocationCard.tsx:92`–`:183` | default badge + "Set default" action; delete disabled on default | The badge and the action are **deleted — nothing replaces them**. You enable and disable; that is the whole model, and that simplicity is the point. The card shows one of three states instead: **Writing** / **Read-only** (standby — held footage still plays, still prunes, still evicts) / **Hold** (untouched), plus what makes "disabled ≠ broken" legible (D62): capacity, footage range still served, and the per-location residue (`storageMigration.residue` already computes it). |
| `location-enabled.ts:34` (`isEnabledToggleLocked`) | toggle locked on the default | Deleted; the server's last-writable refusal (§3.1) is the guard, and the UI surfaces its message on the one toggle that would trip it. |
| `EditLocationModal.tsx:160`, `AddLocationWizard.tsx:73`/`:310` | carry / offer `isDefault` | Field removed from both; the wizard's checkbox becomes "Enable writes to this location now" (default off — created-born-disabled is unchanged). |
| `LocationGroup.tsx:49` | sort default first | Sort: writing → standby → hold, then by id. |
| `StorageLocationsPanel.tsx:62` | "make default" mutate | Deleted with the control. |
| `StorageSection.tsx:146` | the recordings default as "the only defensible guess" for which volume a camera's footage sits on | The guess is replaced by the *answer*: the recorder's placement assignments (`PlacementService.currentAssignments` exists at `placement-service.ts:758`; it needs a read surface on the recording cap if none exists — listed as Stage 3 work, not assumed). Note this file is in a tree other agents are editing today; coordinate before touching. |
| Generated `useStorageGetDefaultLocation` | — | Regenerated away with the cap method. |

### 3.8 Bootstrap — the three sharp cases

1. **A brand-new camera.** `place()` finds no assignment, `resolvePlacement`
   picks deterministically from the enabled pool, the next 30 s tick plans it
   by headroom and the merge persists it (D302). No default needed; the pool
   is never empty on a functioning system (see 3).
2. **A fresh install, one location per class.** `seedDefaults` creates one
   `enabled: true` row per declared type; bare refs resolve to the sole row
   (§3.5). Identical to today in every observable way.
3. **Every location of a class disabled.** Made unreachable through the API by
   the last-writable refusal (§3.1). If reached anyway (hand-edited store,
   legacy data): the recorder falls back to all locations **and shouts**
   (§3.2) — recording continues on a standby disk under protest;
   `eventMedia` **refuses the write loudly** (`media-locations.ts:33` returns
   `null` and the caller already throws with the location list —
   `pipeline-analytics/index.ts:2894`); and `listLocations` grows a per-class
   health finding (`noWriteTarget`) so the UI renders an error state, not
   silence. A recorder silently writing nowhere is the worst outcome in this
   design, and every branch above is either a write-with-shout or a
   refuse-with-shout — never a silent nothing.

---

## 4 · The day this ships — the three divergent cameras, and every stored record

**Nothing is reinterpreted on the first tick.** The trap D301 stepped around —
an absent stamp read as "repointed from nothing", discarding deliberate
assignments on the first tick after a deploy — has no analogue here because no
absent flag acquires a new meaning: `enabled` keeps its exact three-valued
semantics (absent = active, unchanged), assignments naming a location outside
the pool already invalidate today (`placement-service.ts:444`), and the
`is_default` column is simply ignored, not read as anything.

**Cameras 1439, 3839 and 104 do not need this design to ship.** The lever
exists today, which is itself evidence the model is right. Live state, read
from the hub on 2026-08-30 by the coordinating session: `recordingsLow:default`
— `enabled: true`, `isDefault: false`, `isSystem: true`, root `/recordings`;
`recordingsLow:ssd` — `enabled: true`, `isDefault: true`, root
`/media-fast/recordingsLow`.

- `recordingsLow:default` is **no longer the class default** (the 08-29
  cutover moved `isDefault` to `recordingsLow:ssd`), so its enabled toggle is
  not locked (`location-enabled.ts:34` locks only the default).
- **`isSystem: true` does not block the toggle** — checked, not assumed:
  `isSystem` refuses only *deletion* (`storage-orchestrator.service.ts:715`);
  an edit preserves the flag and otherwise passes (`:633`), and
  `resolveEnabled` forces `enabled` on only for the *default* (`:1113`), which
  this row no longer is. Disabling it is a permitted operator action today.
- The operator sets `enabled: false` on `recordingsLow:default`. At the next
  attach boundary each divergent camera's stored assignment fails the pool
  check (`placement-service.ts:444` — the location is not in
  `placementPool`'s output), resolves fresh onto `recordingsLow:ssd`, and the
  next tick's planner persists the move (`reason: 'gone'`) through the D302
  merge. No deploy, no restart.
- Eviction is untouched — `enabled` is not consulted by `domainOf` or the
  `isReadOnly` wiring (`recorder/addon/index.ts:1007`), so the draining disk
  keeps shrinking and the `d321f141` drain keeps its arithmetic.
- Falsifier, observable within the hour: the `divergent: true` decision lines
  stop; the ledger residue on `recordingsLow:default` becomes monotonically
  decreasing.

This is Stage 0, an operator action. It is not performed by this
investigation (hard limit: no `enabled` change from here).

**Stored records, exhaustively:** the `is_default` column (dead data, §3.1);
the placement blob's `defaultLocations` stamp (dead key — the D301 machinery
that read it is deleted; the merge writer stops writing it; an old blob's key
is ignored, never misread, because `detectRepoints` no longer exists);
`StorageMigrationJob.destinations` (concrete ids, unaffected); `eventMedia`
NULL rows (§3.5, the seal); backup manifests (concrete ids). Nothing else in
the settings store encodes "the default one" — verified by grep across
`packages/` and `server/` today.

---

## 5 · Reads must never narrow — the code path, not the assumption

The 2 131-segment blackout mechanism: `collectRangeSegments` builds
`rootById` from `deps.locations()` and **drops any row whose `locationId` it
cannot resolve** (`recording-provider.ts:408`, `:419`). So the guarantee is
exactly this: *a location's record must survive every state in §2*.

- `resolveRecordingsLocations` filters by **type only** (`roots.ts:224`);
  `enabled`, `readOnly`/`hold` never touch the list. A standby or hold
  location stays in `rootById` and its rows keep serving. The same per-row
  idiom covers every other read surface: scrub/seek and segment byte reads
  resolve `<root for the row's locationId>/<relative path>`
  (`recording-provider.ts:382`), export runs the same collector in
  `'absolute'` mode, the hour-ledger hydrate walks every resolved root
  (`roots.ts:488`), and media reads resolve per row (`media-store.ts:316`)
  through `resolveRef` by concrete id, which has no enabled/hold branch.
- The only narrowing event is `deleteLocation`, and that is guarded twice:
  D293's occupancy probe (unknown refuses), and §3.1's last-of-type refusal.
- **New guard, because a rule nothing checks is already broken somewhere:** a
  spec pinning that `collectRangeSegments` returns rows living on a
  `enabled: false` and on a `hold: true` location (fixture: one segment on
  each), and that `resolveRecordingsLocations` maps both. Disarm: adding a
  writability filter to either function must turn it red.

---

## 6 · What this model makes worse

Every model has a case it handles less gracefully. These are this one's:

1. **"Where does class X write?" loses its one-word answer.** Today
   `getDefaultLocation('recordings')` names one disk; tomorrow the answer is a
   set plus a per-camera plan. Support scripts and mental models that leaned
   on the default must ask the placement census instead. The census line
   (§3.2) is the mitigation, not a cure.
2. **Enabling is no longer inert.** Today an operator can enable a disk and
   nothing changes until a repoint; tomorrow *enabled means in use* — the
   planner starts placing cameras on it within a tick. An operator who
   enables a disk "to have it ready" gets writes on it. Created-born-disabled
   and the wizard wording carry the burden of making this unsurprising.
3. **A camera's timeline interleaves across disks over time.** The planner
   already does this with two enabled locations, but the default's
   gravitational pull is gone, so it happens more. Playback stitches across
   roots correctly (non-blocking design §3), but a single-disk failure now
   punches windows across *many* cameras rather than losing *whole* cameras —
   a different, arguably worse, grief profile. An operator who wants
   one-class-one-disk expresses it the only way left: one enabled location.
4. **The transitional bare-ref rule is a lexical `:default` anchor** — the
   concept sneaks back in as a slug for as long as unstamped `eventMedia`
   rows exist. If the seal counter never durably reaches zero (a writer that
   still degrades to NULL under a failure nobody has seen), the "transitional"
   rule becomes permanent and this design has quietly kept a default under
   another name. The counter is queryable; watch it.
5. **The last-writable refusal depends on a declaration flag.** A future class
   whose declarer forgets `requiresWriteTarget` can be driven to zero enabled
   locations through the API; its consumer then lives on the shout-fallback
   (§3.8). The guard script that already validates declarations should refuse
   a multi-cardinality class that names neither value.
6. **D301 is deleted days after it shipped.** Its tests, its stamp, its
   divergence report — real, fresh work discarded. The superseding record
   must say plainly that D301 was correct *for the model it lived in*, and
   that the census line keeps its reporting duty; otherwise the next session
   reads the deletion as regression.
7. **Two enabled disks of similar headroom will both be written** — which is
   the point, but it also means the hysteresis band
   (`placement-planner.ts:81`) is now load-bearing for write stability across
   the fleet, not just for rebalances. If thrash appears, the knob is there
   and the falsifier is the per-move log line rate.

---

## 7 · Staged plan — each stage ships alone to a live NVR

| Stage | What | Ships how | Falsifier / exit |
| --- | --- | --- | --- |
| **0** | Operator disables `recordingsLow:default` (§4). No code. | — | Divergence lines stop; residue on the old disk monotonically ↓ while drain `d321f141` runs. |
| **1** | **Split the states.** `hold` in `StorageLocationSchema`; orchestrator reads `config.readOnly` as legacy alias + warn; recorder/analytics consume the schema field; `domainOf` and the mover-target refusal re-key on hold; age sweep skips hold; shared-root hold warning. | types+system on the publish train; pipeline/post-analysis via `camstack deploy` (tolerant reads first, exactly like `enabled` shipped — `roots.ts:43`'s comment is the template) | Eviction-domain spec: standby in-domain, hold subtracted — reverting either turns it red. No location behavior changes on a hub with no `readOnly`/`hold` set. |
| **2** | **`setWriteTargets`** + coordinator cutover flips `enabled` (and, during this stage, `isDefault` in lockstep so nothing that still reads defaults breaks mid-train). `start`/`drain` refusal texts updated. | publish train | A staged migration on a test hub: cutover = one attach round; source ends standby; the already-cut-over refusal still fires. |
| **3** | **Delete `isDefault`.** Schema, cap (+codegen), orchestrator (§3.1), recorder (§3.2 + superseding ADR for D301, census line), analytics (§3.4), UI (§3.7), transitional bare-ref rule (§3.5), last-writable refusal + declaration flag, the reads-never-narrow spec (§5), CI grep guard for `isDefault` outside generated code. | publish train (types/system/server) + deploys for pipeline/post-analysis/admin-ui — **order per the framework rule: the train must be live before the deploys that assume the new cap surface** | `npm run typecheck` finds every reader the catalog missed; the guard greps clean; a fleet on two enabled disks balances and the census reports it; disarm: re-adding the demotion loop or the tiebreak must fail named specs. |
| **4** | **One write switch for backups** (§3.6): fan-out consults `isLocationEnabled`; `policy.enabled` merged away. | publish train | A disabled backups location receives no archive; its history still lists; the destination card shows standby, not broken. |
| **5** | **Retire the transitional bare-ref rule** once `countUnstamped` is durably zero: bare multi-type refs refuse; NULL `mediaRowLocation` becomes a logged fault. | deploy + train | `countUnstamped == 0` across a week of boots; grep guard for bare multi-type refs green. |

Stages 1 and 2 are independently valuable even if 3 never ships (1 kills the
typo'd config key and the eviction-domain trap; 2 makes the cutover
pool-native). Stage 3 is the point of the document. 4 and 5 are cleanups the
model makes possible.

---

## 8 · What could not be determined today

- **Whether the live hub has unstamped `eventMedia` rows right now.**
  `countUnstamped` was not queried (production access limited to the facts
  supplied). Stage 5's precondition, and §3.5's transitional-rule lifetime,
  hang on this number.
- **Whether any live location carries `config.readOnly` today.** Stage 1's
  one behavior delta (legacy readOnly stops age-pruning) is a no-op if none
  does.
- **The live distribution of `enabled` values** (`true`/`false`/absent per
  location) — determines how many rows the Stage 0/3 story touches in
  practice.
- **Whether anything outside this repo** (viewer app, hub.mjs operator
  scripts, exporters) calls `storage.getDefaultLocation` or bare multi-type
  refs over the wire. The viewer talks through the SDK; its tree was not
  audited for this. A wire-level deprecation warn on the method for one
  release before deletion would surface any unknown caller.
- **`location-store`'s exact behavior when a mapped column is absent from an
  upsert** (§3.1's "column stays as dead data" needs the store's row-mapping
  verified before Stage 3, not assumed — `location-store.ts:185` writes the
  column unconditionally today).
- **The admin-ui Recordings tabs are being edited by other agents today**;
  §3.7's `StorageSection.tsx` change must be re-based on their result.

## 9 · Related records

- [D291](../decisions/adr-0291-a-relocation-moves-the-durable-hour-row-or-it-has-not-happened.md) — unchanged by this design; the drain's ordering invariant.
- [D293](../decisions/adr-0293-a-location-is-deleted-only-after-it-is-verified-empty-and-unreachable-is-not-empty.md) — unchanged; §5 leans on it.
- [D301](../decisions/adr-0301-a-stored-placement-assignment-does-not-outlive-the-repoint-of-its-class.md) — superseded by Stage 3 (§3.2, §6 item 6).
- [D302](../decisions/adr-0302-a-work-scoped-placement-pass-merges-and-its-work-set-comes-from-the-archive.md) — unchanged; the merge is what makes the pool-membership moves durable.
- [Non-blocking storage migration](2026-08-29-non-blocking-storage-migration.md) — the phase machine §3.3 reshapes; its §5 named the `readOnly` trap §2 resolves.
- [SMB storage provider](2026-08-30-smb-storage-provider.md) — the `access` declaration pattern §3.1's `requiresWriteTarget` copies.
