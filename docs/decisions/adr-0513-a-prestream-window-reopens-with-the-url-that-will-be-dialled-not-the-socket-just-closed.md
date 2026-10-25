---
id: D513
title: A prestream window re-opens with the url that WILL be dialled, not the socket just closed
status: accepted
date: 2026-09-16
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/sentry-plan.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/__tests__/sentry-window-follows-consumers.spec.ts
---

> **Naming.** Since 2026-09-17 this mechanism is called **sentry**.
> The text below says `prestream` because that is what it was called when the
> decision was taken, and a record is not rewritten: `watch` and `monitor`
> were both already taken in the same module (`watchdog`, `watcher`).

## Context

The operator, watching the baby monitor (device 106): *"È cominciato con
l'immagine Waking, quando è arrivato un evento ha correttamente iniziato lo
stream. Quando la finestra è chiusa lo stream è crollato."* [It started with the Waking image, when an event arrived it correctly started the stream. When the window closed the stream collapsed.]

Measured on the hub, 2026-09-16:

| time | line |
| --- | --- |
| 18:11:35 | `prestream: filling the wake window {codec=h265 bytes=23912}` — the "Waking" picture |
| 18:12:15 | `wake signal from the camera {code=motion outcome=armed}` → `demand detected — resuming stream` |
| 18:12:19 | `video: rtp packet received` → `prestream: window closed {reason="first real packet"}` — real video |
| 18:12:30 | `wake hold lapsed — back to the prestream picture` (no visible effect; the decode session still held live intent) |
| 18:13:05 | `RTSP client disconnected {total=1}` — the detection session detaches, the last live intent goes |
| 18:13:10 | `no demand — suspending stream` · **`prestream: no fill for this camera {refusal=not-lazy camStreamId=native:main width=2304 height=1296 codec=h265}`** |
| 18:13:20 | the operator's client gives up |
| 18:13:26 | `battery sleep state committed {sleeping=true}` — the publisher republishes the lazy sentinel, sixteen seconds too late |

The first hypothesis — that the teardown released the source on the wake reason
expiring without asking whether a consumer was still attached — was **wrong**,
and the code says so plainly: `suspend()` calls `reconcilePrestreamWindow()`
under a comment that reads *"A consumer that never left is still owed a
picture"*, added on 2026-09-15 for this very device.

The repair was there. The url made it inert.

`reconcilePrestreamWindow()` asked `resolveCurrentSource()`, which asks the
publisher, which still carried `tcp://127.0.0.1:39305` — the socket the broker
had just torn down. The publisher only swaps back to `lazy:rfc4571:…` when its
sleep poll notices the camera has gone, which took sixteen seconds. In that
window the catalog is **truthful and useless**: it names a socket nobody can
dial.

`planPrestream` then refused `not-lazy`, and a pump refusal is terminal by
design. Nothing re-reconciles: `reconcilePrestreamWindow` is reached only from
`checkDemand()` and `suspend()`, and between 18:13:10 and 18:13:20 there was no
consumer edge at all.

## Decision

**The broker remembers the lazy url it has seen, and prefers it when the
prestream window is wanted.**

Not as a fallback — as the *more accurate* answer. That branch runs only when
nothing holds live intent, which is precisely the state in which the source is a
recipe to be dialled rather than a socket that is open. `planPrestream`'s own
docblock says its precondition is *"a WAIT between demand and media"*: after a
suspend that wait exists by definition, so `not-lazy` was the wrong answer to
the right question.

**The url is learned wherever it is seen** (`resolveCurrentSource`, and
`start`), not only at the dial. A battery camera nobody has asked for yet, with
a prestream consumer attached, has a recipe and no socket — learning only from
the dial would leave exactly that broker unable to describe itself, which is the
first case the spec covers.

**It is never cleared on a materialized url.** That happens on every wake, and
clearing there is the bug again. A broker genuinely reconfigured onto a mains
source keeps a stale value and it costs nothing: `prestreamEligible` (battery
AND declared signals) is the authority on whether a camera gets a prestream at
all, and the manager asks it first.

## The test was green with the bug live

`sentry-window-follows-consumers.spec.ts` already had
*"re-opens after the camera goes back to sleep, for a consumer that stayed"* —
passing, while the hub logged the refusal. Two layers of fake hid it:

- `setSourceProvider` returned the sentinel **constantly**, including after the
  suspend — the one value production does not have at the moment that matters.
- `prepare` was `vi.fn(async () => FRAME)`, so `planPrestream` never ran and no
  refusal was representable.

Both were repaired before the production change: the provider now models the
publisher's real lifecycle, `prepare` goes through the real gate, and the test
asserts the **outcome** (`plan` vs the named refusal) rather than that `prepare`
was called — asking is not feeding. With the honest fake the existing test went
red on its own, then red again when the fix was removed.

This is the third time in this repo that a fake supplied the value production
forgot to fetch. The tell is the same each time: a fake that answers the same
thing at every point in the episode, for a value whose whole significance is
that it changes.

## Consequences

- **A refusal for a fact that is not yet true is still terminal.** `not-lazy`,
  `unknown-geometry`, `unknown-codec` and a missing snapshot all end the window
  with no retry, and nothing notifies a broker when the catalog is republished.
  This decision fixes the case that bit; it does not fix the class. A hook from
  the manager's publish path into `reconcilePrestreamWindow` (which is
  idempotent) would — and would have recovered this episode at 18:13:26, six
  seconds after the operator's client had already given up. Worth doing, not
  done here, deliberately: it is wiring between two components and belongs in
  its own change with its own measurement.
- Not verified: whether `Campanello` (4263) and `Camera laundry` hit the
  same refusal. They share the wake pattern but logged no `refusal=not-lazy` in
  six hours — most likely because no prestream consumer stayed attached across a
  suspend.
