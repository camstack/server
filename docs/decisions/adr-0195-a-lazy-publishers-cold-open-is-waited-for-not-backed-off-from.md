---
id: D195
title: A lazy publisher's cold open is waited for, not backed off from
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
---

## Context

Devices 3838/3836 (the vendored `@apocaliss92/wyze-bridge-js`) take **12.4 s** to
open, measured 2026-08-20. That time is inside the bridge:
`WyzeRfc4571Server.ts:619-631` waits for the first keyframe with a 10 s ceiling,
on top of ~2 s of DTLS handshake. It is not this repo's to shorten.

What IS this repo's is that a 12.4 s open cost far more than 12.4 s, because
every mechanism the broker applied to it was built for a source that is FAILING:

1. The `lazy:rfc4571:` branch set `error`, asked the publisher to materialize and
   RETURNED, so the re-dial rode the exponential backoff — 1, 2, 4, 8, 16 s. The
   publisher answered at ~12 and the broker did not look again until 16.
2. `kickReconnect` was fired only when the published URL had CHANGED. The bridge
   re-publishes the SAME loopback port after recreating its P2P server, so that
   camera sat out the entire remaining backoff for a source that was already up.
3. `FIRST_VIDEO_TIMEOUT_MS` (8 s) is SHORTER than the open. A connection two
   seconds from delivering was torn down — and the teardown is not cheap: the
   bridge closes its P2P server 30 s after the last client, so the next dial
   repays the whole cold open.

Wyze does not carry `DeviceFeature.BatteryOperated`, so none of
`battery-wake-on-play.ts` — built for exactly this cold-open shape — ever
touched it.

## Decision

A source being BUILT is not a source that is failing, and the broker treats the
two differently.

- **While a materialize is outstanding, the wait is polled FLAT**
  (`MATERIALIZE_POLL_MS`, 1 s) under a deadline (`MATERIALIZE_WAIT_MS`, 20 s).
  Past the deadline the materialize has not been slow, it has failed, and the
  exponential backoff is right again. The dial line names which schedule it is
  on, because a 16 s open spent in backoff and a 12 s open spent in the
  publisher are otherwise indistinguishable.
- **A re-publish is news even at an unchanged URL.** `kickReconnect` is fired on
  every publish; whether the string moved is an implementation detail of the
  publisher, and what a re-publish MEANS is "this source is serviceable now".
  It throttles itself to one kick per floor delay so a publisher in a republish
  loop cannot turn a bounded retreat into a permanent dial at the floor.
- **The first-video deadline is extended for a dial that followed a
  materialize** (`LAZY_MATERIALIZE_FIRST_VIDEO_TIMEOUT_MS`, 20 s), for
  `MATERIALIZE_RECENT_MS` (30 s) after the request. The 8 s was sized against
  Chrome's ~15 s ICE-disconnect — sound for a stream that is open and has
  stalled, and exactly wrong for a cold open: Chrome had given up either way,
  and the only thing the short deadline changed was whether the NEXT viewer paid
  for the whole open again too.

One fact drives both the dial schedule and the watchdog — `materializeRequestedAt`
— so a cold open cannot be "in progress" for one and "not happening" for the
other.

## Consequences

- **The latch must clear on the HEALTHY path, and it does.** It is cleared where
  the first video packet is observed, not only in the watchdog's stand-down
  branch: on a healthy open the watchdog is CANCELLED and that branch never
  runs, so a latch clearing only there would make 20 s the permanent stall
  budget for every camera behind a lazy publisher.
- **The 12.4 s itself is unchanged.** This removes the cost this side ADDED to
  it (up to 4 s of backoff quantisation, a full backoff after every bridge
  recreate, and an 8 s teardown that cost a second full open). Shortening the
  open needs a change inside the vendored tarball.
- `wyze-stream-server.ts:57` still closes the P2P server 30 s after the last
  client, so a stream re-dialled a minute later still pays a cold open. That is
  the bridge's policy and is **not addressed here** — recorded so it is not
  mistaken for a regression of this record.
- The unconditional kick reaches every publisher, not just wyze. It is safe by
  construction: `kickReconnect` returns unless a reconnect timer is actually
  armed and there is demand.

## Enforcement

`packages/addon-pipeline/src/stream-broker/__tests__/lazy-materialize-cold-open.spec.ts`
— a publisher that answers at 12 s is discovered before 13.5 s (it would not be
on the backoff); the flat poll gives way to the retreat past the deadline; the
first-video deadline clears 12.4 s while a materialize is recent and returns to
8 s afterwards; a kick re-dials at an unchanged URL; 50 kicks inside one floor
delay produce at most one dial. Verified by reverting all three fixes: 5 of 7
fail.
