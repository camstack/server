---
id: D454
title: A byte attribution is ranked by bytes, split by kind, and re-measured before it is acted on
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/system/src/kernel/socket-plane-report.ts
---

## Context

The 2026-09-11 load scaletta opened its list with a named cause: hub-main moves
353 MB/min, **193.8 MB/min of it to `pipeline-analytics`**, at ~106 KB per
response, and the culprit is `loadPrefixed` in `settings-door-view.ts` — an
entire settings scope reassembled fifteen times a second, with the synchronous
handle's implicit cache never replaced after sqlite-settings was isolated. The
fix was to be a D224-shaped mirror with a D49 expiry window.

**Every step of that is false today, and two of them were already false when
the scaletta was written.**

*The mirror exists.* `pipeline-analytics/store/settings-raw-mirror.ts` is
exactly the article the scaletta asked for: `RawGlobalStoreMirror` and
`RawDeviceBlobMirror`, single-flight, serve-and-revalidate, invalidated in
process by every writer of the rows they hold, with a declared window
(`RAW_SETTINGS_STALE_MS`) and a failed-refresh cooldown. It funnels all eight
per-device settings kinds through one read. Its own docblock argues its D224
position. Nothing needed building.

*The bytes are not settings.* Fifty-six consecutive `[mem] hub-main` windows
(09:41–10:37Z) put `hub/sqlite-settings`' responses to hub-main at **9.7–16.9
MB/min**, on 4 400–7 200 responses — a 2.2 kB mean, flat, never once above
17 MB. The whole settings plane is ~3 % of hub-main's 128–101 MB/min, and even
in the worst case where `pipeline-analytics` received all of it, it cannot be
193.8 MB. The two other candidates measured out equally small:
`deviceState.getSnapshot` answers 1.5–10 kB and `deviceState.getAllSnapshots`
907 kB — against 892 device-state calls/min.

*The flow is real, and it is somewhere else.* hub-main writes **15–376 MB/min**
to `hub/pipeline-analytics` (median ~140, ~38 % of the plane) while that peer's
message counts barely move: 1 523 responses / 4 702 events for 15 MB in one
window, 1 588 / 4 586 for 72 MB in another. Its events are bounded at ≤ 22
MB/min by the plane-wide `evt` total, so the bytes are **responses**, few and
enormous. And in three windows hub-main's total `rx` was *smaller than what it
sent to this one peer* (10:24, 10:22, 09:57) — so the bytes cannot be relayed
from a child; hub-main **originates** 30–240 MB/min of them.

*And the record that seeded the claim said so.* `2026-08-29-checkpoint-memoria-
cpu.md` §5.3 attributed this same flow to the settings plane by matched-minute
byte conservation — sqlite→hub-main 618 MB/min ≈ hub-main→analytics 610 MB/min
— and closed the D9/D18 question on it. The conservation held then. It does not
hold now, because the paging walk in `loadPrefixed` and the raw mirror landed in
between. The attribution was carried forward for thirteen days without being
re-run, and the fix it pointed at had already shipped.

Two properties of the instrument made the stale attribution survivable, and both
are defects:

1. **`socketTop` ranks peers by MESSAGES.** A peer moving few, huge frames is
   absent from the line by construction. In the measured windows the five peers
   the line named left **116 MB/min of hub-main's outbound bytes with no name on
   them at all**. (planning repo: sessions/sessions.md) already recorded this on 08-29 <!-- drift-ok: moved to the private planning repo -->
   ("`socketTop` ranks by MESSAGES so the analyzer never appears — read the
   totals, not the ranking"); reading the totals is not attribution.
2. **A peer's bytes were one per-direction total.** `socket-traffic.ts` says in
   its own docblock that `res` "is the field the message-RATE, not media
   conclusion is falsified against" — and then the report summed `req`, `res`
   and `evt` into `kB=<tx>/<rx>`, so that falsification took an hour of
   arithmetic against plane-wide totals instead of being on the line.

## Decision

**A byte attribution is ranked by bytes and split by kind, and an attribution
older than the fix it motivated is re-measured before it is acted on.**

Concretely, on the socket plane: `diffSocketPlane` produces `topBytes` beside
`top` — the same peers ranked by total bytes instead of total messages — and
`formatSocketPlane` prints `socketTopBytes=` **only when that ranking names a
peer the message ranking does not**, so the field's presence is itself the
reading: a line without it says the two rankings agree, a line with it says a
peer is moving few, heavy frames and names it. Each peer entry carries
`txkB=<req>/<res>/<evt>:rxkB=<req>/<res>/<evt>` in place of the old
`kB=<tx>/<rx>`, in the same order as the message triples beside it, so
"responses or fan-out" is read, never derived.

Both rankings stay. They answer different questions and both are open: `top`
names the peer paying for round trips (`audio-codec` at 8 469 calls/min of small
frames), `topBytes` names the peer paying for copies and GC.

## Consequences

- The `[mem]` line grows by one conditional field and each of the five peer
  entries by four numbers. The field ORDER is unchanged and `socketTop=` keeps
  its position, so every Loki prefix written since 2026-08-29 still matches
  (the constraint D446 recorded). A parser that read `kB=` out of a peer entry
  does not exist in this repo; one outside it would break.
- **This does not name the owner of the 30–240 MB/min.** It bounds it: the
  bytes are responses, they originate inside hub-main, and they go to
  `pipeline-analytics`. Naming the METHOD needs a per-action byte census on the
  channel, which `socket-traffic.ts` deliberately does not keep. That is the
  next instrument, and it should be built before another fix is proposed for
  this flow.
- Two of the plane's largest hub-main-originated payloads are now measured and
  on the record: `deviceManager.listAll` at **1.58 MB** (full projection, by
  the deliberate choice documented in `system-mirror.ts`) and
  `deviceState.getAllSnapshots` at **907 kB**. Thirty to two hundred and sixty
  of either per minute would account for the whole flow. That is a hypothesis,
  not an attribution, and it is written here as one.
- Scaletta item 1 is withdrawn. `loadPrefixed` is not the cause of 193.8 MB/min
  and needs no mirror; it already has one.

## Enforcement

`packages/system/src/kernel/__tests__/socket-plane-report.spec.ts` — four tests:
the byte ranking exists and is ordered by bytes; it names a whale the message
ranking has no room for; `socketTopBytes=` is printed only when it adds a name;
and a peer's bytes are split by kind. Disarmed by sorting `topBytes` by messages
instead: 3 of 4 red, including both ranking tests, so the tests check the
ordering and not merely the field's presence.

The re-measurement half of the rule is review-only. The guard that would catch
it does not exist: nothing in the repo can tell that a MB/min figure quoted in a
plan was measured before the change it motivated. Until a plan's numbers carry
the window they came from, the only defence is to re-run the measurement, which
costs one `logs.query` and ten minutes.
