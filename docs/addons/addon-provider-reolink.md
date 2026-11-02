---
title: addon-provider-reolink — package notes
covers:
  - packages/addon-provider-reolink/**
---

# addon-provider-reolink — package notes

Moved verbatim from `packages/addon-provider-reolink/AGENTS.md` on 2026-10-09 so that root +
package `AGENTS.md` stay inside the 32 KiB Codex reads. That file keeps
the intro and the skill pointers and links here; edit the notes HERE.

## Battery cameras: the model

A battery camera is asleep most of the time. **Logging in wakes it.** Not
`wakeUp()` — the login itself, because the transport is UDP and the camera answers
by waking. Any gate that runs *after* `ensureApi()` gates nothing.

So the question at every call site is not "is this read expensive?" but **"who is
waiting for this answer?"** — and that is only knowable at the layer where the
intent arrives. Only the snapshot wrapper sees `force`. A sensor notification
whose rule allowed it is one such intent (D998): one forced snapshot per
sleeping linked camera, bounded to 15 s, at most once a minute.

## The pieces, and why each exists

| Piece | Why |
| --- | --- |
| `canProactivelyWake` / `markWakeIssued` | rate limit a PROACTIVE wake — "how often", never "may I" |
| `BatteryHourlyRefresh` (`battery-hourly-refresh.ts`) | once per window every fact + the snapshot is refreshed: at an awake moment, else one wake at the window's end (D847); stamp `battery.lastFullRefreshAt`, window `batteryRefreshMinutes` |
| `decideSnapshotCameraAccess` (`snapshot-wake-gate.ts`) | the snapshot CONTRACT gate, *before* `ensureApi`: asleep + no `force` ⇒ refuse. A rate limiter used to stand here and let anything past the cooldown wake the camera (D503) |
| `commitSleepState(next, source)` | the **single** writer of the sleep slice |
| `WAKE_HYSTERESIS_MS` 30s / `SLEEP_HYSTERESIS_MS` 5s | asymmetric on purpose: waking is expensive, sleeping is cheap to believe |
| `resolveCapOptions` / `persistCapOptions` (`deviceCache.capOptionsSnapshot`) | a device-details page visit must read cache, not dial |
| `sleepGatedRefresh` | a refresh that declines rather than wakes |
| `capWarmers` / `warmCapSlicesOnWake` / `warmSnapshotOnWake` | gating reads without warming leaves every state `null` |
| `reconcileChildSleepState` (in `reolink-hub-session.ts`) | under an NVR the NVR already knows — no camera poll, no mail server |
| the attribution log in `ensureApi` | prints the caller stack whenever a sleeping battery cam logs in; this is how the last wake was found |

## The camera mailbox (battery cameras report motion by mail)

A standalone battery camera mails its motion to the hub, so it is not woken to be asked. The
mailbox is NOT served by this addon any more ([D999](../decisions/adr-0999-inbound-camera-alarms-ride-existing-planes-smtp-is-a-broker-kind-http-is-the-addon-data-plane.md)):
it is a `broker` of kind `smtp-inbound` owned by `smtp-nodemailer`, one record = one listener.
`email-push-bridge.ts` is this addon's side.

- **First need creates it.** `ensureMailbox` lists `smtp-inbound` brokers and, when none exists,
  adopts the id `smtp-inbound-default`; "id in use" re-reads the list. It runs when a standalone
  camera is eligible or on Auto-configure, never at a bare boot. This addon never deletes the mailbox.
- **Recipients.** `sync` subscribes the `cam-<stableId>` local-parts of the eligible cameras under
  the subscriber id `provider-reolink` (a re-subscribe replaces this addon's set). A removed camera
  re-syncs through the `device-removal-hook` provider. A recipient claimed by another subscriber is
  logged, not thrown.
- **Messages.** A `broker.message` is parsed (`SmtpInboundMessageSchema`), classified with nodelink's
  `classifyEmailPushMessage` and mapped by `mapInferredTypeToSimpleEvents` into
  `handleSimpleEvent({ source: 'email' })`, stamped with the message's `receivedAt`.
- **Lost events (D8).** Events are telemetry. Each message carries a monotonic `seq`; a gap, a
  `broker.status-changed` to `connected`, and every subscribe read the mailbox ring
  (`getState('since:<seq>')`, last 200 messages / 15 minutes) and replay what was missed, once, in order.
  A `lastSeq` lower than the stored one means the mailbox restarted: the baseline resets to 0.
- **Auto-configure** reads `getBrokerConfig`: the camera-facing host is the `internal` role of the
  `local-network` palette (D729), never ranked here. With no internal address it refuses and the error
  names System → Network.
- **Migration** `provider-reolink/2026-11-02-email-push-to-mailbox` (D987, a procedure, idempotent)
  creates the default mailbox from `emailPushPort`, `emailPushDomain`, `emailPushRequireAuth`,
  `emailPushAuthUsername` and the keychain password, so no camera is reconfigured. A password that
  cannot be resolved fails the run (never read as empty), as does an unavailable mail addon; the next
  boot retries. The legacy keys and `secretStatePaths` stay one release.
- **Container contract (D717).** Port 2525 moves process (hub-main to `smtp-nodemailer`), not
  container; nothing in the Unraid template, the Proxmox script or the Compose example changes.

## The HaCfg webhook (battery cameras that support it)

A battery camera that supports Baichuan HaCfg (cmd 806/807) can POST its wake/sleep push over plain
HTTP. It is a plane of this addon's HTTP data plane ([D999](../decisions/adr-0999-inbound-camera-alarms-ride-existing-planes-smtp-is-a-broker-kind-http-is-the-addon-data-plane.md)),
not a private listener: `webhook-plane.ts` is served with `ctx.dataPlane.serve({ prefix: 'webhook',
access: 'public' })` (the firmware cannot sign in, so the handler is the gate).

- **URL.** `http://<internal-host>:<lan-http-port>/addon/provider-reolink/webhook/<stableId>`. The host
  is the `internal` role of the `local-network` palette (D729) and the port is the plain-HTTP origin
  the hub lists for it (`resolveWebhookEndpoint`). With no internal address, or with LAN HTTP off,
  Auto-configure refuses with the reason; it never falls back to HTTPS (the firmware refuses a
  self-signed certificate).
- **Handler.** POST or PUT, JSON body of at most 64 KiB. nodelink's `parseBaichuanWebhookBody` and
  `mapBaichuanWebhookToSimpleEvents` feed `handleSimpleEvent({ source: 'baichuanWebhook' })`. An
  unknown or ineligible `stableId` is a 404 with a log line (tagged `deviceId` when the camera is known),
  an oversized body 413, an unparsable one 400.
- **Re-pointing after the upgrade.** The old URL was `:9081/webhook/<id>`. Each battery camera is moved
  on its first Baichuan contact after the upgrade, only if its own `getHaCfg` shows the webhook armed at
  another URL (an e-mail camera is never switched). Progress is `webhookUrlGeneration` in the device
  store; a failure leaves it unwritten and the next contact retries.
- **:9081 compatibility window.** For one release a receive-only listener on :9081
  (`legacy-webhook-intake.ts`) feeds the same handler, so a camera that sleeps through the upgrade
  loses no alarm. Each camera's first hit logs `legacy webhook port used — camera will be re-pointed`.
  Remove it after 2026-12-15 (a spec fails from that date while the file exists); then :9081 leaves
  the container-contract mirrors (D717).
- **Settings.** `baichuanWebhookEnabled`, `baichuanWebhookPort` and `baichuanWebhookBindHost` no longer
  exist; the migration `provider-reolink/2026-11-02-drop-webhook-intake-settings` (a plan, `deleteKeys`)
  removes the persisted keys.

## Standalone vs under an NVR

An NVR or Home Hub is its **own integration** (D985), never a device. The addon is
`instanceMode: multiple`, `mode: account`: the default integration keeps the
standalone cameras, and each NVR integration carries `host` / `port` / `username`
and a keychain-backed `password` (`hub-connection.ts`). One session per
integration (`reolink-hub-session.ts`, owned by `reolink-hub-manager.ts` and
reconciled from `ctx.api.integrations`) owns the one Baichuan socket, its backoff,
the 60 s channel reconcile and the simpleEvent routing. A camera adopted from it
is a TOP-LEVEL camera stamped with the `integrationId` and a `channel`; it reaches
the session through `reolinkHubSessions` (a synchronous registry read) and
attaches itself on activation, so routing never depends on a registry scan.

A connected NVR reports sleeping and motion for every adopted child. So for
NVR-adopted cameras: take the state from the NVR, do not poll the camera, and do
not require an SMTP path. A failed summary read keeps the last list and flags
nobody offline.

- **Adoption** is a `device-adoption` provider over the session's channels.
- **Discovery** offers each NVR / Home Hub as a `setupIntegration` candidate whose
  `stableId` is `reolinkHubStableId` (uid, else host), so `originStableId` hides it
  once the integration exists.
- **Migration** (`reolink-hub-migration.ts`, run from `onRestoreDevices`): an old
  Hub device becomes an integration named after it, its secret moved through the
  keychain; its children keep their deviceIds, are re-stamped and un-parented, and
  the Hub is tombstoned only when the DB shows no child under it. A hub with a
  locked or empty password is left untouched. Idempotent: the integration records
  `migratedFromHubDeviceId`.
- The relay port is the connection's `rtspPort` (default 554), never the Baichuan
  `port`; a migrated hub carries its `rtspPort` if it had one, else 554.
- Changes to an integration's connection settings apply at the next reconcile (the
  60 s pass or an integration lifecycle event); there is no settings-changed event.
- A hub integration's form (the create wizard, and the edit page of a migrated or
  hub-born instance) is the connection only — host, port, rtspPort, username,
  password, plus the hub debug section — through `integrationSettingsSchema`. The
  default integration keeps the full global schema (clips). An
  instance that cannot be read falls back to the full schema.

## Passive contact, and where a standalone camera gets none

`battery.lastContactAt` is stamped ONLY by evidence that cost nothing: an
inbound Baichuan push (`handleSimpleEvent` → `markPassiveContact`) or a poll the
camera answered while awake (`updateBatteryCache`). A hub child is refreshed by
the hub. A STANDALONE battery camera pushes only when it wakes, so a quiet night
used to freeze every fact it owns: device 106 showed 80 % until it died, then
11 % (2026-10-13), because the hourly timer did nothing while the camera slept.
`probeSleepStatus` cannot separate asleep from gone: both time out. Do not "fix"
this with a longer presence budget. D847 is the fix (it supersedes D355's
contact-expiry wake): once per window (`batteryRefreshMinutes`, default 60) the
camera is refreshed in full — at an awake moment if one arrives, else by ONE wake
at the window's end — and `lastFullRefreshAt` says when. A wake that fails is
what `unreachable` now means. The census spec registers this as the one
sanctioned self-initiated wake — do not add a second one, and keep the cooldown
gate before `ensureApi()`.

A battery push may carry ONLY the percent (`BatteryInfo` is all-optional and
nodelink dispatches on any one field). `mapBatteryInfo` keeps the previous
`charging` when the push says nothing about power (`reportsPowerSource`) — the
same rule `percentage` applies. Feeding such a push to `deriveChargingSource`
answers `'none'`, which is a claim, not an absence.

## When you change any of this

- **The scheduled refresh is the only place a clock may wake a battery camera.**
  The tick itself (`runBatteryUpdate`) never connects; the decision
  (`decideBatteryRefresh`) is pure and says when. Do not add a second timer, and
  do not read `getSleepStatus` to decide: it self-fulfils after a wake.
- **`SliceHandle.value` is undefined until `refresh()`.** A gate that reads
  `handle.value` without awaiting `handle.refresh()` never fires in production. A
  test fake that pre-seeds `value` will keep the suite green while it does. Remove
  your fix and confirm the test fails.
- **Verify the deployed version, not the bundle hash.** A framework fix in
  `@camstack/server/system` is not live until a `@camstack/server` carrying it is
  installed ([D16](../../docs/decisions/adr-0016.md)).
- Providers are trampolines over `runtimeState`. No `private cachedX` fields, no
  cold-start fallbacks persisted into the config blob. See
  `docs/architecture/device-model.md`.
- **Every `deviceCache.*Snapshot` write stamps `snapshotFetchedAt` for the keys
  it wrote** (`stampSnapshotFreshness`, D346) — a writer that skips it makes its
  group report "age unknown" forever. Raw inspection of camera-vs-belief:
  `debugRawRead` (`raw-read.ts`), an admin `addons.custom` action whose catalog
  is the allow-list — never add a slice whose reply can echo credentials, and
  never route it through `runDeviceAction` (that mount cannot enforce admin).
  CustomActions join at `initialize()`, not `onInitialize()` — the base hook's
  `ProviderRegistration[]` type is load-bearing for eleven sibling providers.

## Clip stills: two traps the queue's own rules do not cover

- **A camera that TIMES OUT earns no backoff.** `ClipThumbQueue` arms its
  host-keyed backoff only on a camera REFUSAL — `rejected` *and*
  `responseCode = 400` — and that is right: a decode failure is ours and must
  not stop minting for a whole hub. But 618 answers CoverPreview by not
  answering: three cold mints measured 30 041 / 30 017 / 30 020 ms, each
  `camera-refused` / `final`, with the backoff never arming. Anything that
  loops over rows must therefore stop itself — a prefetch pass stops at the
  first refusal and the scheduler holds that device quiet for a doubling
  number of INTERVALS (D577). Do not "fix" this by widening
  `isCameraRefusal`; the lane's rule is about the lane.
- **A bound on ROWS is not a bound on work, and cannot backfill.** 592 records
  ~400 clips a day, so a pass that looked at its newest twenty always found
  them warm (an operator opens the live edge) and minted nothing — 25.3 % of
  1 188 rows had a still after a day of half-hourly refreshes. Budget MINTS and
  scan the whole catalog newest-first behind them.
