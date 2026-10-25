---
title: Alexa live view away from home (R6) — what a remote session needs from the WebRTC path
date: 2026-10-08
status: design only — NOT implemented
applies-to:
  - packages/addon-export-alexa/src/handlers/rtc-session.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/session.ts
---

# R6 — remote live view in the Alexa app

## The problem

Every Alexa live view so far ran on an Echo on the hub's own LAN. The Alexa
phone app on mobile data, an Echo in another house, and Amazon's certification
reviewers are all REMOTE, and none of them has been shown to work. The public
docs warn that viewing away from home "may not start"; the runbook lists it as
risk #4 and a go/no-go gate (§I.5).

The session today (`rtc-session.ts`) answers Echo's offer with
`relayOnly: false`, `disableTurn: true`, `disableIpv6: true`, `nonTrickle: true`:
host and server-reflexive IPv4 candidates only, all of them in the answer
(Alexa does not trickle), within Amazon's 6 s budget.

## Why that is not enough off the LAN

Amazon's RTC media path is the peer that has to reach us. Off the LAN it sees
only our srflx candidate, the home router's public address and a port werift
chose. Whether a packet from Amazon to that address reaches werift depends on
the router's NAT behaviour:

- **Endpoint-independent mapping and filtering** (full cone): works, because
  the binding werift's STUN request opened accepts Amazon's checks.
- **Address- or port-dependent filtering** (most home routers, all CGNAT):
  Amazon's checks arrive from an address werift never sent to and are dropped,
  ICE never nominates a pair, DTLS never starts, the Echo or app shows black and
  sends `SessionDisconnected` (~28 s). werift does send its own checks to
  Amazon's candidates, which opens the pinhole; whether that happens before
  Amazon gives up is timing, which is why the result is "sometimes".

TURN was disabled for Alexa on purpose: gathering blocked on the allocation and
cost the 6 s budget, and a relay pair spent ICE-check time on a path Amazon did
not need on the LAN.

## What a fix needs, in order of preference

1. **Measure first.** Log the nominated pair class (`host` / `srflx` / `relay`)
   and the ICE / DTLS timeline for every Alexa session, with the remote
   candidates' types, and run the runbook's remote test from the phone on mobile
   data. The broker's pair-class logging already exists for browsers; Alexa
   sessions need the same line with `consumerKind: alexa`.
2. **A reachable host candidate.** A hub with a public IPv4 (the VPS demo hub of
   runbook §H, or a UDP port-forward of a FIXED werift port range plus that
   public address advertised as an additional host candidate,
   `iceAdditionalHostAddresses`) makes the path direct and independent of NAT
   filtering. This is the cheapest correct fix and should be offered as an
   operator setting ("Public address for Alexa media" + port range), validated
   by a reachability self-test.
3. **TURN as a candidate, not a default.** Re-enable TURN only for a session
   whose offer came through Amazon's REMOTE path (no way to know from the offer
   today — decide by the operator setting above being absent), and pre-allocate
   the relay at hub start so the answer does not wait on the allocation. The
   werift relay media-forward path is not proven (`CAMSTACK_FORCE_RELAY_REMOTE`
   is still off for browsers, see `trpc.router.ts`); it must be proven for
   browsers first.
4. **Not**: forcing `relayOnly` (it removed the LAN path that works), or trickle
   (Alexa does not support it).

## Acceptance

From the Alexa app on mobile data and from an Echo on another network: live
view starts within the budget and plays at least 60 s, five times out of five,
with the nominated pair class logged. The same test is certification step 13.

## Effort

Unknown until step 1 has run: S if a public host candidate is enough (setting +
self-test), L if TURN has to carry Alexa media.
