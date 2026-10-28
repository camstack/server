---
id: D948
title: "A detection notification can ask 'was this right?': the button marks the track for retraining, records who was ASKED, and a channel with no buttons gets links that confirm before they claim"
status: accepted
date: 2026-10-27
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/detection-verdict-buttons.ts
  - packages/addon-post-analysis/src/notification-center/detection-verdict-ledger.ts
  - packages/addon-post-analysis/src/notification-center/action-token.ts
  - packages/addon-post-analysis/src/notification-center/action-plane.ts
  - packages/addon-post-analysis/src/notification-center/granted-actions.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

## Context

The operator asked (#243) for Correct / Wrong buttons on a detection
notification that feed the retrain flow the way marking a track in the Library
does. Buttons are authorised by their token alone and a tap identifies nobody
([D47](adr-0047.md)); the grant says what a button may do ([D133](adr-0133.md)).

Three choices were not forced by that:

1. **What "the same mark" is.** The Library writes `markForTrain` through
   `pipelineAnalytics.setTrackFlags` (`none` to `staging`, D81). A Wrong answer
   is also training material, so both answers write that same mark; the
   verdict itself (and the class the operator named) is not a column on the
   track and a cap change for it was not warranted.
2. **Who.** The tapper is unknown by design. The person the notification was
   addressed to is frozen on the token at mint, exactly as a snooze freezes its
   owner.
3. **Channels without buttons.** A kind that declares `actions: 0` (mail,
   Pushover, Gotify, WhatsApp, Discord) drops buttons whole. A URL placed in the
   body is opened by link previews and mail scanners, and a single-use token
   claimed by a GET would be spent before the human reads the message.

## Decision

- **A rule opts in.** `NcRule.askVerdict` (optional, absent = off). Only the
  admin rule editor authors it; the viewer editor is co-designed and unchanged.
- **A grant kind, `detection-verdict`**, freezes the track, the verdict, an
  optional suggested class, the rule, and `userId` (the addressee). TTL 24 h:
  the blast radius is one more retraining mark on a track the recipient was
  shown, bounded by the per-camera staging budget.
- **The mark is applied first and is the authority.** A deliberate refusal of
  the retrain lifecycle (`trained`, `budget`, `unknown-track`) comes back as a
  named reason on the tap page and writes NO ledger row: an answer that changed
  nothing is not recorded as applied. The token is spent either way (D47).
- **The ledger** (`detection-verdicts`, one row per track, latest answer wins)
  records verdict, suggested class, `userId`, rule, device and time. It carries
  the device and is removed with the camera.
- **Channels.** A kind with room for 3 buttons gets Correct and Wrong; room for
  4 or more adds up to two "Wrong: it is X" buttons. A kind with `actions: 0`
  gets the same choices as bare links in the body. Those grants are `viaLink`:
  a GET renders a confirm page and never claims, only the confirming POST does.
- **The Verdict buttons come first** among a delivery's buttons, so a channel
  that keeps three never drops the question the operator opted into.

## Consequences

- Nothing about who TAPPED is recorded and nothing pretends to be. A forwarded
  notification can mark one more track for its addressee's retraining, once.
- The class an operator names is stored for the retrain page to read; the
  annotation flow does not consume it yet.
- The viewer rule editor needs the same toggle (`askVerdict`) and, if it lists
  a notification's buttons, the three `button.verdict.*` labels.

## Amendment 2026-10-28 — a verdict on a gone track

A still-object track is discarded about 30 s after it is notified, so an
`unknown-track` answer lost the example although the recording still covers the
instant. The grant now freezes `eventAtMs` (the notification's own instant). On
`unknown-track` the tap falls back to `pipelineAnalytics.addRetrainFrameFromRecording`
into the "Notification verdicts" collection (found by name, created on first
need) and writes the ledger row as for a live track. A refused recording
(`still-unavailable`, `still-busy`, other) is logged with the device tag, named
to the tapper, and writes no ledger row. Follow-up, not built: the notification's
stored still as a second fallback (needs `ctx.peerBytes`, D613).
