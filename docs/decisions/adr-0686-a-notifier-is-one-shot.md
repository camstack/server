---
id: D686
title: A notifier is one-shot — footage the ring lost is waited for, bounded, and rides the one message
status: accepted
date: 2026-09-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/recorded-clip.ts
covers:
  - packages/addon-post-analysis/src/notification-center/recorded-gif.ts
  - packages/addon-post-analysis/src/notification-center/footage-source.ts
  - packages/addon-provider-homeassistant/src/ha-notification-output.ts
---

Amends [D682](adr-0682-a-pick-ups-footage-is-cut-around-the-pick-up.md) (its
"two steps" consequence).

## Context

Camera 101, rule "Consegna pacco (front door)", 2026-09-30 15:28: the parcel
pick-up reached the operator's phone as **two Zentik messages** — the still at
15:28:38.9, then the recorded gif at 15:28:40 — for ONE rule, ONE event and ONE
outbox row. D682 had the dispatcher send the alert first and the recorded
footage as a second `send()` with the same `tag`, on the stated assumption that
"a phone collapses the two by tag". The Zentik adapter never reads `tag`
(Pushover, ntfy, Telegram and Discord have no equivalent either), so the
collapse never happened on the one target this hub uses.

Mapping the tag to Zentik's `collapseId` was considered and rejected. The tag
was per RULE by default, so a pick-up would have replaced its own delivery
notification, and every alert of a rule the one before it. On the one backend
that did honour it (HA Companion `data.tag`), that replace was already live.

Operator decision (2026-09-30): remove message updates for now. Notifiers are
one-shot. If the recordings must supply the attachment, the notification is sent
once, complete. And no replacing a picture after the fact.

## Decision

**One outbox row produces exactly one message per target, and nothing ever
updates or replaces it.**

- **Footage the ring has lost is cut before the send and rides the same
  message.** When `footageSourceFor` answers `recordings`, the dispatcher
  awaits the recorded cut, plus the gif derived from it (D682). The wait is
  bounded by `NC_RECORDED_FOOTAGE_WAIT_MS = 30 s` and the attachments join the
  still in the row's single send.
  - A cut that is refused, throws, or is not ready in time costs the footage and
    never the notification. The notification ships with the still, and the line
    `recorded footage: none — …` names the reason (`not-recorded`,
    `not-covered`, `cut-failed`, `timed-out`, `threw`, `gif-derive-failed`),
    tagged `deviceId`.
  - Success says `recorded footage attached` with `waitedMs`.
- **The bound is shared with the recorder.** It is passed down as
  `NcRecordedClipRequest.deadlineMs`. No render is queued once the deadline has
  passed. A render still queued or running at the deadline is **cancelled**
  (`recordingExport.cancelExport`: unqueued, or its ffmpeg killed) and then
  deleted (`timed-out`). The export engine also refuses to render a row that
  is already `deleted`, `expired` or `failed`, and discards a finished render
  whose row was deleted while it ran. (The first cut of this record said the
  delete alone abandoned the render. It did not: `deleteExport` never
  cancelled, so a queued id was rendered for nobody and its file kept for
  15 min. The engine has two lanes, `EXPORT_MAX_CONCURRENT`, not one.) The
  120 s `NC_RECORDED_CLIP_TIMEOUT_MS` is gone, because its only caller always
  brings a deadline. A derive is not started after the deadline.
- **The wait is bounded in aggregate, not only per row** (fix round 1).
  - **One cut and one gif derive per moment.** A single cut is shared by every
    target row of a record and by that row's retries
    (`recorded-cut-memo.ts`, keyed on device, record and window; held
    10 min, at most 16).
  - **A breaker for a busy recorder.** A cut that times out opens a breaker.
    For `NC_RECORDER_BUSY_MS` (60 s), recorded rows ship still-only at once,
    with the named line `recorded footage: none — the recorder is busy`
    (`reason: recorder-busy`, tagged `deviceId`), instead of each waiting out
    the bound again behind the same wedged recorder.
  - **A row that JOINS a cut still in flight** (re-review):
    - It consults the breaker.
    - It waits only what the cut has left: `deadlineMs + 2 s − now`.
    - If that is already spent, it is `timed-out` at once.
    - Each row gets its own **copy** of the shared bytes.
    - Held cuts are evicted on the notification centre's drain tick, not only
      when the next row happens to use the memo.
    - The export engine claims a row for rendering with ONE conditional,
      serialized patch (`patchExportUnless`). A delete that lands between
      its read and its claim can therefore no longer be overwritten back to
      `rendering`.
  - **Why both are needed.** Without them, a rule with N targets cost N × 30 s,
    and a row that waited more than about 16 s fell out of the ring into the
    recordings path itself, so one stall cascaded.
- **Only a grouped row carries a `tag`.** The per-rule default is removed, so
  HA Companion no longer swaps the previous alert of a rule for the next one. A
  D143 group revision remains the one opt-in replace (`groupIdleSec`, per rule;
  unused on this hub today). It is named here so nobody takes it for an
  oversight.

**Why 30 s.** The 2026-09-30 cut measured 1 s for the export and 262 ms for the
derive, so the bound is almost never reached. When it is reached, the render is
queued behind something that holds the recorder for minutes (a timelapse).

- **Why not longer:** the outbox drains rows one at a time. The bound is
  therefore also the worst-case delay for every row queued behind this one. A
  live ring cut already blocks the drain for its 6 s post-roll plus the render.
- **Why not shorter:** a moment that reaches this path is already older than the
  ring (at least 20 s; a pick-up at least 5 min), so seconds cost the operator
  nothing. A bound under about 10 s would drop the gif whenever the recorder is
  merely busy.

## Consequences

- A pick-up now arrives as one message with still and gif, about 1.5 s later
  than the still-only alert used to. The detached follow-up is deleted:
  `startRecordedFootage`, `settleRecordedFootage`, the in-flight set and the
  `recorded-clip-follow-up` vocabulary.
- **Head-of-line cost:** while a recorded cut is pending, the rows queued behind
  it wait, for up to 30 s in the worst case. That happens once per wedge: the
  breaker skips the wait for the next 60 s, and the rows of one moment share
  their cut. If it ever bites, the fix is a concurrent drain, not a second send.
- **Single-attachment targets lose the recorded gif.** Telegram, ntfy and
  WhatsApp keep only the first attachment, which is the still. Before this
  record, a recorded row's gif reached them as the second message. Now the
  gif is dropped and named `dropped` on the delivery line. A ring-cut row
  already lost its gif on those targets before this change.
- **The webhook's `tag` was, for an ungrouped row, the rule id.** It is now
  `null`, and the payload carries no other rule identifier. An external
  consumer that routed on it must change.
- An ungrouped notification carries no `tag`. The webhook payload's `tag`
  becomes `null` for such rows, and HA notifications of one rule stack instead
  of replacing each other.
- The `<trackId>:enhanced` follow-up (D142, `waitForEnhancement` OFF) is not a
  replace. It is a second, separate message saying a name the first could not.
  It still exists, and on this hub no rule declares a recognition scope, so it
  never fires. Whether it should survive "one-shot" is left to the operator.

## Enforcement

- `recorded-footage-one-shot.spec.ts` covers the dispatcher:
  - An old moment produces ONE send carrying the video.
  - A 300 s pick-up produces ONE send carrying the recorded gif.
  - A dated pick-up that asks for gif and video gets both in one send.
  - The recorder is handed `deadlineMs = now + 30 s`.
  - A cut that never answers yields one still-only send and the `timed-out`
    line.
  - Refusals, a throw and a failed derive each yield one send and a named line.
  - Disarmed and seen red:
    - With the inline cut removed, 12 tests fail.
    - With the hard bound removed, the timeout test hangs and fails.
    - With the deadline not handed down, the deadline test fails.
- `recorded-clip.spec.ts` covers the recorder side:
  - A render still running at the caller's deadline returns `timed-out` and
    deletes its export.
  - A deadline spent by the availability read queues no render.
  - Each test is red with its own check removed.
- `recorded-footage-shared-cut.spec.ts` covers the aggregate bound:
  - Two targets of one record share one cut and one derive.
  - A retry reuses the cut.
  - After a timeout, the next recorded row ships at once with
    `recorder-busy`.
  - The breaker closes after 60 s.
  - Each test is red with the memo, the breaker check, the breaker opening or
    the shared derive removed.
- `recorded-cut-memo.spec.ts` covers the memo's age and count bounds.
- `export-abandoned-never-renders.spec.ts` runs the REAL provider and engine
  (addon-pipeline):
  - A queued export that is cancelled and deleted never reaches ffmpeg.
  - A queued export that is only deleted never reaches ffmpeg either.
  - A running export that is cancelled is killed and its file removed.
  - A render finished after its delete is not published `ready`.
  - A cancel that finalises after the delete leaves the row `deleted`.
  - Each test is red with its guard removed.
  - `recorded-clip.spec.ts` asserts cancel-then-delete, and is red without
    the cancel.
- `dispatcher.spec.ts` checks that an ungrouped notification has no `tag`. It
  was red before the change.
- `track-grouping.spec.ts` checks that group revisions share one tag.

**Amended 2026-10-01 ([D692](adr-0692-a-grouped-immediate-rule-waits-for-its-subjects-and-sends-once.md)):** the bullet "Only a grouped row carries a `tag`" and the
consequence about the `<trackId>:enhanced` follow-up are void. No row carries a `tag` any
more, and the follow-up no longer exists. A grouped rule sends one message after its window.
