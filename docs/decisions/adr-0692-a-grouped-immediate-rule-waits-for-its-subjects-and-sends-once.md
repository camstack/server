---
id: D692
title: A grouped immediate rule waits for its subjects and sends once — one message, a mosaic of every subject
status: accepted
date: 2026-10-01
supersedes: D143
applies-to:
  - packages/types/src/notification/rule-kinds.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/grouping-guard.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-window-buffer.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-delivery.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-close-pass.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-payload.ts
  - packages/addon-post-analysis/src/notification-center/grouped/grouped-mosaic.ts
  - scripts/check-nc-one-shot.ts
---

## Context

Two mechanisms tried to make a notification about a person say WHO it was, and both ran into
the same wall: a notifier is one-shot ([D686](adr-0686-a-notifier-is-one-shot.md)).

- **[D142](adr-0142.md)'s delivery half (`waitForEnhancement`)** offered two timings.
  - ON: wait until the track CLOSED and send once, with the name. That is late, and it takes
    on track-close semantics: a `crossing` can no longer match.
  - OFF: send at once, without the name, then send a SECOND "…now recognised" message.

  Since D686 that second message is a second notification on every backend. The operator
  experiences it as a duplicate, not as an upgrade.
- **[D143](adr-0143.md)'s group revisions** sent the first subject at once and then a
  REPLACEMENT per growth, coalesced by a push `tag`. Only HA Companion honours a tag. On Zentik,
  Pushover, ntfy and Telegram every revision arrived as a new message.

The operator asked for one mode (2026-09-30): "immediate, with a grouping time". The first
matching event opens a window. During the window the system collects PROMOTIONS (a face
becomes an identity, a vehicle gets its plate, a better best shot) and OTHER matching
subjects. When the window closes, ONE message goes out with the most specific details and a
mosaic of one picture per subject.

Measured on the live hub on 2026-10-01 (read-only), there are 18 rules:

- one inert `waitForEnhancement: false` on a `system-event` rule;
- no `groupIdleSec`;
- no rule with a recognition scope.

Removing the old paths changes nothing that is live today.

## Decision

An `immediate` DETECTION rule that carries `groupingSec` works as follows:

- **One window.** It opens ONE window per `(rule, camera)` at its first matching or
  CANDIDATE subject. A candidate is a subject that passes everything except the recognition
  conditions and is not yet final.
- **Collection.** The window collects promotions and other matching subjects.
- **Close.** It closes at `openedAt + groupingSec`, or EARLIER once every member is final, but
  never before `NC_GROUPING_MIN_SEC` (5 s). This is operator decision 1, 2026-10-01: subjects
  arriving together share one message.
- **The message.** It then sends ONE message per target: a sentence naming the members that
  match the rule, and a mosaic with one tile per member, at most 6.
  - An identity-scoped rule names and tiles ONLY the members that satisfy its recognition
    conditions (operator decision 2, 2026-10-01).
  - A member not recognised inside the window is dropped with a named reason.
  - A window left empty sends nothing, and says so in the log.
- **No push `tag`.** No notification row carries a push `tag` any more.
- **Removed.** `waitForEnhancement`, the `:enhanced` follow-up and the D143 revisions are
  removed. Track-end delivery stays, because it already carries the name.
- **Stored rules.** Stored rules are projected on READ, never refused and never written
  back.

**Operator rulings, 2026-10-01 and 2026-10-02: a snoozed rule at close.** A window whose
notification a snooze covers at close writes NO outbox row. Each covered target's drop is
logged with `tags: { deviceId }`, the rule id, WHICH snooze, and
`reason: 'rule-snoozed-at-close'` (spec §3.5 as written).

- "Snoozed at close" means ANY snooze that would suppress this rule's INSTANT notification:
  a rule, camera or global snooze, or a class snooze that covers every member class.
- It is judged with the SAME function the instant path's send gate uses, per target, at
  close time. A summary snooze still counts the suppression in its digest.
- A target no snooze covers still gets its row.
- A per-camera mute set during the window also writes no row.

**Settled readings of the spec.** They were decided while planning and are binding with this
record:

- **Judged subject.** At close, a member is judged on its latest subject that passed the
  relaxed evaluation, with every later recognition overlaid. The message FREEZES the member's
  first match: its instant, zones and event.
- **Drop reasons.** The named drop reasons are `recognition-not-final`,
  `recognised-out-of-scope`, `already-notified` and `fused-into-notified`, plus
  `failed-condition:<id>` for anything else.
- **Serialization.** Everything that closes a window runs on the NC's serialized evaluation
  chain. A closing window reserves its members before its first await.
- **Replay.** The crash replay is timed on the events' own clock and kept apart from live
  windows. A replayed event older than the watermark minus the scan overlap (60 s) never opens
  a window. Inside the overlap it may open one, because an event can be evaluated after a
  watermark write that already passed its timestamp; the notified-set hydration refuses
  whatever was already sent.
- **Exactly-once after a crash** rests on the notified-tracks set, which is re-hydrated from
  the outbox BEFORE the replay. The dedup id (`dedupRef` = the window key, built by
  `outbox-key.ts`, D694) is the second line of defence.
- **Retraction.** A recognition the recogniser retracts (D665) demotes the member: a message
  never names an identity that was taken back.
- **Tester isolation.** The tester's synthetic event never shares a window with live
  subjects.
- **The floor is checked on the tick too (C3).** Passing the 5 s floor is not an input, so the
  early-close check also runs on the 2 s drain tick. A window whose members are all final from
  the start (a dog) closes between 5 and 7 s.
- **Only a live track's label reaches a window (C6).** The label hook fires for a track still
  held in RAM. A closed track is final, and its close carries its label.
- **A group of one is a plain row (C7).** The dispatcher sends a one-member window exactly as a
  plain immediate notification: one still and the plain sentence. Only the footage anchor is the
  window's `openedAt`.
- **Additive payload fields (C8).** Beyond spec §6.1 the row carries:
  - `version: 2`;
  - a per-member `matchedOn` and the member's own event (`eventId`, `eventDeviceId`,
    `eventAt`, D694);
  - `payload.cooldowns`, the per-class rollback list;
  - `closeReason: 'test'` for the tester.
- **Reconcile scan bound (C9 / L-10).** The replay reads at most `RECONCILE_SCAN_LIMIT` events
  from `watermark − 60 s`. On a very busy hub, a window's first event can fall outside the
  scan, and the window re-opens from its first SCANNED event. This is accepted.
- **Early promotions (C15).** A promotion that reaches the NC before its track's first event
  is kept and applied at admission: at most 1 024 entries, with a TTL equal to the longest
  window (60 s).
- **`minLabelConfidence` (C16).** Only a CLOSED member carries a label confidence, so only a
  closed member can satisfy this condition.
- **No track (C17).** An object event without a `trackId` takes the plain immediate path. A
  sampled INFO line says so (D391).
- **Rule edited mid-track (C18 / L-8).** The notified set learns plain-path fires only at boot.
  A rule edited from plain to grouped while a track is live may therefore notify that track
  once more.
- **Two first-face records (fresh review L-T5-2).** The tracker's linker keeps its own first
  face. That is a face in the detection frame, and it decides fusion. The outlook reads the
  RECOGNISER's first face instead, the first detail face past the quality gate, because the
  face-settle cap is about a recognition verdict and only that face can produce one.
- **Identity matching.** D142's other half stands unchanged: an identity is matched by
  gallery ID, not by name.

**Operator ruling, 2026-10-02: a judged member stays judged while it is unrecognised.** A
member dropped at close because the identity-scoped rule did not see the identity it asks
for (never recognised, or recognised as someone else) does NOT re-open a window of that rule
while its track is still unrecognised for it.

- The rule keeps a per-rule judged set for the track's life. It is bounded by a 30 min TTL
  and a size cap, and it is RAM-only.
- Only a later FULL match (the track gains the identity the rule asks for) opens a fresh
  window, and the rule fires once for it.
- The first suppressed re-open per (rule, track) is logged with `tags: { deviceId }`;
  repeats are not logged.

## Consequences

- **The spec's §11 test 1 has an arithmetic slip, corrected here.** The scenario is:
  - Person A appears at 0 s and is recognised at 11 s;
  - a stranger appears at 2 s and shows a face at 3 s;
  - the stranger's face cap therefore ends at 3 + 20 = 23 s.

  With `groupingSec: 20` that cap falls after the deadline, so the window closes at 20 s with
  `closeReason: deadline`. With `groupingSec: 30` it closes at 23 s with `all-final`. The specs
  use the 30 s example.
- **Cameras that announce no detail steps.** A runner announces `detailSteps: []` for a camera
  with no detail steps, and every member there is final at once. A runner OLDER than that
  announces nothing, and its members stay `unknown`, which counts as pending (D49). The cost is
  latency, only while versions are mixed: on such a camera every grouped window waits its full
  `groupingSec`, an animal included.
- **The judged set is RAM-only (C10, provisional).** A respawn forgets it, which costs at most
  one more window per track.
- **What a respawn keeps (T10, review fix round 1).**
  - The persisted watermark never passes a window whose message is not written yet: an open
    window, and a window whose close is in flight (already out of the buffer, its row not
    yet enqueued). It holds at the window's opening or at its earliest member event,
    whichever is older, so a window re-opened by a late recognition holds it at the judged
    event the member is frozen on. A crash therefore replays every such window's events; a
    window the shutdown close did not finish is recovered the same way.
    Two bounds apply. A window re-opened by a late recognition can hold the watermark for as
    long as the judged-track TTL (30 minutes), while the boot scan reaches back only the
    reconcile window (15 minutes) and pages at most 2 000 events. A hold older than the scan
    floor is therefore replayed only from what the scan still reaches, and the replay then
    relies on the stored object-event row of the member carrying its recognition. A scan
    that returns its full page logs a WARN with the count and the limit, because a full page
    drops the OLDEST events, which are the held windows'.
  - The watermark is written off the evaluation path, so an event stamped before a write
    can be evaluated after it. The replay therefore lets an event inside the scan overlap
    (`watermark − 60 s`) open a window, and refuses only older ones. That slack is sound only
    while it covers the longest grouping window, which a spec pins (`RECONCILE_OVERLAP_MS`
    against `NC_GROUPING_MAX_SEC`). The slack relies on the notified-set hydration behind
    it: when the hydration's read failed, the overlap is 0 and the replay runs on the strict
    watermark. Each replay logs one INFO line with the number of refused events, the
    overlap it applied and whether the hydration was read, and one per camera that refused
    any.
  - The notified set is re-hydrated, inside the `outbox` back-fill phase, from ONE read of
    the last 24 hours of rows (the read the cooldown reseed shares), retried up to three
    times inside that phase. Each grouped row's members (and the ids each member's survivor
    absorbed in the window), each plain object-event row's track, never a tester row. A row
    of the last 30 minutes is stamped with its own time. EVERY older survivor of the 24 hour
    read is carried too, stamped at boot, for 30 minutes: a track still in view had its TTL
    slid by every refusal, and the respawn keeps that. The track store is NOT asked whether
    such a track has closed: its recent-tracks read is clamped (1 000 rows) and lists closed
    tracks only, so a filter on it would filter nothing. A track id is never reused, so a
    track that did close costs one entry for 30 minutes. If the row read fails, a WARN
    says so and the replay is guarded by the dedup id alone; the cooldown reseed then
    starts cold, with its own WARN.
  - A v2 member carries `absorbedIds`, at most 16 (the latest fusions). A replayed event
    under an absorbed id is refused even when the alias store cannot resolve it. A member
    that absorbed more than 16 ids is logged at close with the ids left out; one of those
    can still be notified a second time after a crash. A row written before the field
    existed reads as having none.
  - The recent-rows read is bounded (10 000 rows, newest first). A read that hits the bound
    is a WARN: the oldest rows were not read.
  - The cooldown reseed rebuilds one key per member class of a grouped row, as the close
    stamped them.
- **The notified set follows the track (review T9a M-1).** An entry ends with its track's close;
  the 30-minute TTL is only the backstop for a close that never arrives. Every refusal on a
  notified or judged track slides that entry's TTL, so a person in view for an hour is
  notified once, as on the plain path.
- **Interim, until the named task lands** (never deploy between T9a and T12):
  - A window whose every target is snoozed at close writes no row and judges nobody, so the
    next event of its track opens a new window, and that repeats every `groupingSec` for as
    long as the track is in view and the snooze lasts. This is by operator ruling.
  - A rule edited from grouped to plain mid-window still sends the window grouped: the close
    reads the window's rule as it stands, but its grouped intent was admitted.
  - ~~A grouped row's confirm rollback (`cooldowns` on the payload) is read in T13.~~ Resolved
    by T13: a rejection hands back every `cooldowns` key, each only while its fire is the latest.
  - Until T11, a class snooze on the primary's class silences a mixed row at send (the send
    gate judges only `payload.subject.className`), although the close said it was not covered.
  - ~~**Never deploy between T12 and T13** (review T11+T12 M-2)~~ **Resolved by T13** and its
    fix round 1: see "The AI and the confirm gate on a grouped row" below.
  - **T17 => T19 before ship** (review T17 M-1): stored `waitForEnhancement` / `groupIdleSec`
    rules are inert until T19's projection lands. A stored `waitForEnhancement: true` rule no
    longer fires at track close (the deferred exception is gone) and `groupIdleSec` does
    nothing. Never ship T17 without T19.
- **The AI and the confirm gate on a grouped row** (spec §6.2 item 9; T13, review T13).
  - **What is judged.** The per-member stills the mosaic was composed from, resolved ONCE per
    delivery and shared by the mosaic, the gate and the analyst: the crop judged is the crop
    shipped (D52). The close freezes no `analysisTiles` on a grouped row: a second read of the
    members' owners picked a different picture (`keyFrameSmall`, else any file) and, where it
    found nothing, fell back to the shipped composite. `analysisTiles` stays the linked set's
    field (ADR 0632) alone.
  - **A composite is never judged** (D154), not even as a fallback. A grouped row with no
    landed tile asks the gate ONCE with NO image, so the gate's own
    no-image policy decides (it fails open by default), and logs
    `grouped confirm: no raw tile landed — the composite is never judged` (INFO, `deviceId`,
    rule, window key); a rule with `media: none` sought no tile and logs DEBUG
    `grouped confirm: the rule ships no picture` instead. The analyst is not called, and its skip line says
    `reason: 'grouped-no-raw-tile'`. When exactly one still landed, that still is what ships,
    and judging it is judging what ships.
  - **Crop judged = crop shipped, also when the composition fails (FR2, review T13-fr1 M-A).**
    A composition that throws ships the FIRST subject's still alone, so the judged set is that
    one still: a confirmation on tile 2 can no longer ship tile 1. When the renderer drops
    unreadable tiles, the judged set is only the tiles it composed
    (`MosaicRenderResult.composedSourceIds`). A tile is never judged with less than
    `min(1 s, budget / 4)` of the pass budget left (untried instead), and a suppressed verdict
    names a real rejection as its reason when one exists, a no-answer only when it is all
    there is.
  - **The verdict.** CONFIRMED if ANY tile is (the first ends the pass). SUPPRESSED only if
    every tile answered no, or gave no answer that the row's `onTimeout: 'suppress'` turns
    into a no. A tile that fails open (a fail-open verdict, a throw, or a tile the budget
    never reached under the default policy) is not a rejection: the message goes out with a
    `failed-open` verdict that carries the counts. The verdict's `tiles`
    (`confirmed`, `rejected`, `noAnswer`, `unjudged`, `untried`) rides the row, the
    suppressed line and the delivered line (`confirmTiles`).
  - **One budget for the pass, not one per tile.** ONE `confirm.timeoutMs` bounds the whole
    pass: each tile gets what is left of it as its own timeout, and no tile starts once it is
    spent (WARN `grouped confirm: the pass budget is spent — tiles left unjudged`). The
    outbox drains serially, so six tiles at a full timeout each would have held every row
    behind this one, and its clips could fall out of the ring. `latencyMs` / `confirmMs` is
    the whole pass. The bound covers model time: a tile's downscale and the gate's
    per-device queue sit outside it, as they do for a plain row.
    - Why not ONE vision call with every tile: the gate's contract is one question, one
      `{confirmed, count, reason}` answer, and an operator-authored `confirm.prompt` written
      for one picture. A per-image answer would need a second JSON schema, a second prompt
      and a second parser, and `expect` would have no single meaning over several images.
      The budget keeps the contract and bounds the cost.
  - **Each tile is asked about ITS member's class** (`group.members[i].className`), so the
    dog tile of a person + dog message is asked about a dog, not a person.
  - **`confirm.expect` is judged PER TILE**, against that tile's class and count. A tile is
    cut around one subject, so it usually shows one: a threshold above one (`> 1`, `>= 2`)
    rarely holds on any tile, and such a rule effectively suppresses its grouped messages.
    The same holds for an authored `confirm.prompt`: it is asked of each tile. A grouped rule
    should keep the default question.
  - **The gate's counters count judgements (tiles), not messages** (`confirm-gate.ts`
    header). The per-message outcome is the line's `confirm` with its tile counts.
  - **The narration** gets one frame per landed tile and a grouped contract: N stills, one
    per subject, same camera, with the classes in tile order. Its default question is "What is
    in these pictures?" (the singular one for a plain row; the language clause is separate, so
    EN and IT stay in step).
  - **The gate runs for a grouped rule that ships no picture** (`media: none`), with no
    image, exactly as it does for a plain text-only row: the policy decides what "no picture"
    means.
  - **The rollback** hands back every `payload.cooldowns` key, each only while its fire is
    the latest.
- **The alarm exemption (D697) is logged at the close AND at the send** (review T9a L-3): one
  INFO line `snooze does not apply — alarm rules are never silenced` per target at each
  gate, because each asks `snoozeVerdict` on its own.

- **Latency** is bounded by `groupingSec` + the 2 s drain tick + the 3 s still wait + the
  footage. Most windows close earlier, on `all-final`.
  - A face-capable camera with a person who never turns round waits the full window.
  - A vehicle on a plate camera waits for track close or the deadline, because a plate has no
    "unreadable" verdict.
  - A camera that announces no detail steps leaves every member's outlook unknown, so even an
    animal waits the full window.
- **The window record and the shutdown close.**
  - `notification-center:track-groups` holds one row per grouped WINDOW. It is written at open
    (`sealed:false`) and sealed at close with `outcome`, `closeReason`, each member's fate and
    `waitedMs`. Both writes are best-effort and off the chain; the seal waits for its own
    open write. The D143 burst writer shares the table until its removal.
  - `stop()` closes every open window with `shutdown` on the evaluation chain and waits at most
    2 s. Past the bound it logs one WARN naming the windows and their cameras and goes on: the
    restart replay recovers them.
  - **Boot sweep (review T17 L-5).** At `start()`, before the intake opens and before the replay,
    every row still `sealed:false` is sealed with `closeReason: 'orphaned-at-start'` (nothing
    else changes; no outcome, no members). Every open row at boot is an orphan: a clean stop
    sealed the live windows, and the replay re-opens a window by key, its open write
    overwriting the sealed orphan. This cleans a D143 burst row left open at deploy and a window
    whose process crashed. A failed read or write is a WARN and the boot continues; one INFO
    line carries the count and a `byDevice` map.
- **Late fusion.** A late L2 fusion after the message left leaves two tiles for one subject.
  This is accepted, because D683 prefers extra ids to mix-ups, and it is measured by a log
  line.
- **Replay side effects.** The replay of a held watermark span re-runs `onTrigger` actions
  for at most `groupingSec` (≤ 60 s) of events. This is the existing overlap behaviour.
- **Clip ring.** A grouped rule with a gif or clip asks the clip ring for `groupingSec` more
  seconds, capped at 60.
- **Ship order and older clients.**
  - Ship order: `@camstack/types` and the server closure first, then the addon and the admin
    UI, then the viewer.
  - An older viewer shows a grouped rule as plain Immediate. Saving from it keeps
    `groupingSec`, because `updateRule` merges.
  - The retired clear keys (`waitForEnhancement`, `groupIdleSec`) stay accepted for one
    release after the viewer pin stops sending them.
- **Projected rules.** Any later save of a projected rule persists the projected
  `groupingSec`.

## Enforcement

- `scripts/check-nc-one-shot.ts` (CI) fails on a `tag:` in the dispatcher, and on
  `:enhanced` or `groupIdleSec` outside the retired-key and migration modules.
- `grouping-guard.ts` refuses `groupingSec` on any rule that cannot group, on BOTH save routes.
  A wiring spec covers both routes on the real addon.
  A consequence for older editors: they omit `groupingSec`, so the stored value survives their
  save, and they cannot move a grouped rule's delivery away from `immediate` without clearing it.
  The refusal says so: turn grouping off in an editor that shows it (clear `groupingSec`).
- `grouped-window-buffer.spec.ts`, `grouped-immediate*.spec.ts` and `grouped-mosaic.spec.ts`
  pin the window, the close pass, the restart and the message. Each has a disarm proof.
- The viewer-mirror guard's `aheadOfViewer` allowance (and the `retiredInViewer` one, added with the schema removal) expire on their
  own when the viewer pin is bumped.
