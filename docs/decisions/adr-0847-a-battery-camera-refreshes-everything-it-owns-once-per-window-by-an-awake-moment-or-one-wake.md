---
id: D847
title: A battery camera refreshes everything it owns once per window — at an awake moment, or by one wake at the window's end
status: accepted
date: 2026-10-13
supersedes: D355
applies-to:
  - packages/addon-provider-reolink/src/battery-hourly-refresh.ts
  - packages/addon-provider-reolink/src/battery-snapshot-refresh.ts
  - packages/addon-provider-reolink/src/battery-refresh-settings.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
---

## Context

2026-10-13, device 106 ("Baby monitor", standalone battery Reolink): CamStack
reported 80 % until the camera died, then 11 %. Nothing in the provider read the
battery on a schedule while the camera slept. The only timer that existed
(`runBatteryUpdate`, hourly) returned at its first line when the sleep mirror
said asleep — by contract ("NEVER wake for this cycle", D173) — so every fact the
provider owns (level, charging, link, device info, state panels, the cached
snapshot) moved only as a side effect of a firmware push or of somebody else's
wake. A quiet night froze all of them, and `lastUpdated` hid it: any one-field
push re-stamped it. D355 had added one wake per presence budget (6 h) to keep
presence honest, but only as a contact stamp, not as a freshness guarantee.

Rejected: lowering the sleep gate on the old hourly timer (it would wake the
camera every hour even when it had been awake ten minutes earlier — the
self-fulfilling check the old comment warned about); a longer or shorter
presence budget (it moves the false fault, still never asks).

## Decision

The provider that owns a battery camera guarantees, per window (per-device
setting `batteryRefreshMinutes`, default 60, 15–240, 0 = off), exactly one full
refresh of every fact it owns and of the cached snapshot. Windows are clock
slices staggered per device. A camera found awake while a refresh is owed
(any wake transition, or the 60 s in-memory check seeing the mirror awake) is
refreshed at that moment and not woken again that window; a camera that stays
asleep is woken ONCE in the last minutes of the window (through
`wakeIfSleeping`, behind the shared proactive-wake cooldown), refreshed, and left
to go back to sleep. The stamp is `battery.lastFullRefreshAt`, persisted in the
runtime-state slice. A refresh that did not complete is not stamped; it is retried
at the next opportunity, at most twice per window and never within ten minutes of
the previous attempt. One refresh runs at a time; a second request joins it.

## Consequences

- This is the ONE sanctioned self-initiated wake of a battery camera, replacing
  D355's contact-expiry wake (removed). Cost: at most one wake per window per
  camera — 24 a day at the default — and a camera that never answers costs two a
  window. The window's maximum (4 h) stays inside the 6 h presence budget, so the
  refresh itself keeps a standalone camera from reading `unreachable`.
- Refreshes are not evenly spaced: an awake moment early in one window and the
  deadline wake late in the next can sit minutes apart. The guarantee is one per
  window, not a minimum gap.
- The wake is real battery. An operator who wants none sets the window to 0 and
  accepts a level that ages until the camera wakes by itself.
- `snapshot.getSnapshot({ force })` is used for the snapshot step. It is the
  operator signal by contract; here it is the provider's own scheduled demand, on
  a camera it just confirmed up.
- A hub child is refreshed the same way, through the NVR's session.

## Enforcement

`battery-hourly-refresh.spec.ts` drives the real 60 s timer on a fake clock
(found awake, one wake per sleeping window, awake twice, in-flight join, bounded
retries, off); `battery-autonomous-wake-census.spec.ts` pins that this is the only
wired scheduled wake and that its cooldown gate precedes the login. Removing the
"already refreshed in this window" guard fails three of them.
