---
title: addon-export-alexa — package notes
covers:
  - packages/addon-export-alexa/**
---

# addon-export-alexa — package notes

Moved verbatim from `packages/addon-export-alexa/AGENTS.md` on 2026-10-09 so that root +
package `AGENTS.md` stay inside the 32 KiB Codex reads. That file keeps
the intro and the skill pointers and links here; edit the notes HERE.

## The link has TWO halves, and they fail in opposite directions

Almost every confusing thing about this addon comes from not separating them.

| | **Hub-side session** | **Amazon push grant** |
| --- | --- | --- |
| What it is | the token Amazon presents to US | the LWA token WE present to Amazon |
| Stored in | `oauth_sessions` (hub, `local-auth`) | refresh token: the skill Lambda's DynamoDB table. Hub: `AlexaSettings.tokens` = broker URL + per-link credential + 1h access token |
| Created by | `oauthExchangeCode` at consent | AcceptGrant **in the Lambda** → `POST /oauth/broker-link` (legacy Lambda: `/oauth/lwa-tokens`) |
| Used for | `/directive` — live view, voice control, discovery | `LwaEventGateway` — motion, doorbell, battery, Add/DeleteReport |
| Expiry | **none.** `refreshTokenTtlSec: 'never'` | access token 1h, renewed **through the broker** on a 60s scan |
| How it breaks | only by revocation | renewal fails and nothing visibly breaks |

## The hub holds NO Amazon client secret (D753)

The skill's LWA "Send Alexa Events" client secret used to be committed in
`public-skill.ts` — in a PUBLIC npm package. It now lives only in the skill's
Lambda (SSM Parameter Store SecureString, D761), which exchanges AcceptGrant codes, keeps each
user's refresh token in DynamoDB and hands the hub short-lived access tokens
against a per-link credential (`lambda-template/broker.js`,
`src/broker-client.ts`). Rules that follow:

- **Never put a client secret in this package**, not even "the public one".
  `scripts/check-no-client-secrets.ts` fails CI on the shape.
- The hub renews only through the broker. A grant with a `refreshToken` and no
  `brokerCredential` is LEGACY: it is migrated (`/broker/migrate`) as soon as a
  verified directive carries `x-camstack-broker`, then the refresh token is
  deleted. The hub cannot renew it on its own.
- Ship order is **Lambda first, hub second**. A new hub behind an old Lambda
  links but cannot renew — events stop after ~1h.
- A custom-skill operator runs the same `lambda-template` with their own
  secrets; there are no LWA fields in the hub settings any more (a stored
  `lwaClientSecret` is scrubbed on boot).

Consequences worth stating out loud:

- **Revocation is the ONLY severance for half 1.** Nothing times out. And it bites
  immediately, not in an hour: `oauthRefresh` *and* `oauthVerifyAccessToken` both
  re-read the session row, and both of Alexa's hub-side entry points call the
  latter before doing any work.
- **Revoking the session does not touch half 2.** The LWA grant is Amazon's and
  survives; without clearing it the Event Gateway keeps pushing motion and
  doorbell events at the unlinked account until Amazon happens to answer 403.
  That is why "Unlink Amazon account" does both — it also deletes the link at the
  broker (`/broker/revoke`) so the refresh token dies there — and why revoking
  from Admin → System → Identity → Linked Sessions alone is *not* an unlink.
- **Nothing here knows which AMAZON account is linked.** Alexa hands our own
  token back; we never call `api.amazon.com/user/profile`. `LinkedAccount.userId`
  and the `oauth_sessions` row both carry the CAMSTACK user who consented. Two
  Amazon accounts linked by the same operator are indistinguishable — hence an
  all-or-nothing unlink rather than a per-account one.
- **Scopes are frozen at consent.** `oauth2-routes.ts` reads
  `descriptor.requestedScopes` once, bakes them into the code, and `oauthRefresh`
  re-mints from the token's own claims — never from the descriptor, never from
  `oauth_sessions.scopes` (that column is written once and read only for display).
  Widening `requestedScopes` therefore changes **future links only**; an existing
  link keeps its original set forever. Re-linking is the only way to apply it.

## Operator procedures — everything account- or token-related

All of these live on this addon's own settings page unless stated. None of them
needs the Alexa skills list, which matters because the skill is distributed as a
**beta**: it is not in the public catalogue, so the usual "Disable skill →
re-enable → re-link" route may not be reachable.

The page follows the exporter pattern (D784, `src/settings-schema.ts`):
**Connection** (skill, region, skill id when custom, external address),
**Features** (the three switches), **Account link** (status + Unlink),
**Troubleshooting** (collapsed: Re-sync, Remove ids, Rotate broker credential)
and, for a custom skill only, **Custom-skill security** (collapsed: the ingress
token). Every button is an `addon-action-button`, so its result or its error
shows under it; an action with nothing to do throws a sentence saying why.

| I want to… | Where | What it does / breaks |
| --- | --- | --- |
| See who is linked and whether push works | Account link → **Status** | Derived on every read from `linkedAccounts` + `tokens`. Shows the grant's remaining life and last renewal. Breaks nothing. |
| Change the Amazon account, or force a fresh link | Account link → **Unlink now** (`unlinkAlexaAccounts`), then re-link from the Alexa app | Revokes every active `export-alexa` session **and** discards the stored push grant. Live view, voice and proactive events stop immediately. Needs an Amazon-side re-link to restore. Also the way a widened scope set takes effect. |
| Apply new permissions to an existing link | same as above | Nothing else works — scopes are frozen at consent. |
| Inspect the raw session rows | Admin → System → Identity → **Linked Sessions** | Read-only view of `integrationId`, user, scopes, created / last used / revoked. `lastUsedAt` advances only on refresh (hourly at best), so a *stale* stamp is not evidence of a dead link. Revoking here severs half 1 but leaves half 2 — prefer the addon button. |
| Rotate the ingress token (custom skill) | Custom-skill security → **Regenerate token** | New shared secret. **Breaks the Lambda** until `HUB_INGRESS_TOKEN` is updated there — but only when "Require ingress token" is on. Does not touch the account link. Not offered, and never enforced, in public mode: the shared public Lambda sends one `HUB_INGRESS_TOKEN` for every hub (`effectiveAlexaSettings`). |
| Refresh the Amazon push grant | nothing to press | Automatic: 60s scan asks the skill broker 5 min before expiry, plus a one-shot retry on any 401. A grant reported EXPIRED means renewal has been failing; LEGACY means it is waiting to migrate to the broker. A broker 401/410 drops the link (re-link needed). |
| Replace the broker credential (e.g. a settings backup leaked) | Troubleshooting → **Rotate credential** (`rotateBrokerCredential`) | New per-link credential at the broker; the old one dies immediately. Re-linking also issues a fresh one. |
| Re-send the device list, and clear devices you stopped exposing | Troubleshooting → **Re-sync now** (`resyncDiscovery` → `SyncEngine.resync`) | Forced `AddOrUpdateReport` of every exposed device per linked account, then a `DeleteReport` for every device still in `exportedEndpoints` but no longer in `exposed` (an unexpose whose delete failed — `removeDevice` keeps those ids). An id is forgotten only when every account accepted the delete. Nothing an exposed device fails to build is deleted (D49/D767). Needs a linked account with a push grant. Safe to repeat. |
| Remove a ghost device this hub no longer tracks | Troubleshooting → **Remove ids…** (`removeAlexaEndpoints`) | Asks for the ids in a dialog (`prompt` on the button; never a saved field), sends a `DeleteReport` per linked account and fails unless every account accepted it; only then are the ids dropped from `exportedEndpoints`. Destructive: Alexa routines using those endpoints lose them. |
| Re-point the hub's public URL | Connection → **External address** | The picker reads `listExternalAddresses` live each time the page opens; a saved choice that is no longer detected stays listed and selected. Boot fills an EMPTY value with the first address; a tunnel connecting keeps the current choice while it is still detected. The Lambda routes on the `hubUrl` claim baked into each token, so **already-issued tokens keep the old URL** — a moved hub needs a re-link. |

**Not on the Lambda.** The Lambda is skill-side code that receives directives; it
cannot unlink itself or initiate a re-link. Account linking belongs to Amazon's
machinery. The most a skill can do is fail with
`INVALID_AUTHORIZATION_CREDENTIAL` so Alexa surfaces "needs re-linking" — which is
exactly what an unlink here produces.

### The destination-hub step of linking

Linking starts in the Alexa app, which opens the skill Lambda's `/authorize`
(`lambda-template/authorize-page.js`). That page asks for the hub's public HTTPS
address — typed, because a cloud function cannot read this hub's `local-network`
roles — and checks it before sending the browser on (https, not a local address,
`GET /api/oauth2/integrations` answers as a CamStack hub that serves
`export-alexa`, certificate trusted by the Lambda). Every refusal is shown on the
same page with a reason code (`not_https`, `local_address`, `unreachable`,
`tls_error`, `not_camstack`, `integration_missing`, `hub_starting`). The hub shows
the value to type as **Hub address to enter in the Alexa app** (the setup block,
`setup-block.ts`: the External address pick, else the palette's public endpoint).

The hub then runs consent (`/api/oauth2/authorize`). A request the hub refuses —
unknown or not-yet-registered integration, a redirect target the descriptor does
not admit — sends a browser to the admin-ui `/sso-complete` page with
`status=error` and a reason code (`invalid_request`, `unavailable`); a machine
caller keeps the JSON. Consent **denied** still returns to Amazon with
`error=access_denied` (the OAuth contract requires it); the page after that is
Amazon's.

**Linking to a different hub later** is the same flow: Unlink now on the old hub,
re-link from the Alexa app and type the new address. A re-link mints a new link
at the broker (the old credential dies) but does not move the old hub's sessions
— Unlink first.

## Who a link acts for (D767)

A link is the hub user who consented (`userId` on the token), and EVERYTHING
is cut to that user's live grants (`access/`): the router refuses an endpoint
directive whose endpoint is not under an exposed device, names an accessory
that is not a real child, or is not covered by the user's grant at the
directive's access (`view` to see/stream/read, `create` to actuate or talk).
Discovery and every AddOrUpdateReport are filtered per account; proactive
events read `accountVisibility` (refreshed every 60 s, off the event path).
Admins see everything; a deleted user gets `INVALID_AUTHORIZATION_CREDENTIAL`.
A loss deletes endpoints from that user's Alexa account only after two
refreshes agree. Never add a directive handler that skips the router gate.

## What may be declared (D769)

`endpoints/validate-endpoint.ts` is Amazon's discovery rules as code — the
interface allowlist with versions, ids, names, ModeController modes,
EndpointHealth beside sensors, CAMERA first with RTC. It runs in the spec
matrix (`endpoint-shape-validation.spec.ts`, which also checks that every
`retrievable` property is answered by ReportState) and at runtime before every
push, withholding (and logging) an invalid endpoint. **A new capability adds
its device to that matrix first.** `Alexa.BatteryLevelSensor` is not an Amazon
interface; battery is not exported.

## What each endpoint carries

| Endpoint | Interfaces | Fed by |
| --- | --- | --- |
| `<cam>` | RTC (full duplex only with intercom AND `create`), CameraStream, EndpointHealth 3.1, MotionSensor (firmware motion), DoorbellEventSource, PTZ Mode/Toggle, SnapshotProvider (switch), SmartVision.ObjectDetectionSensor + DataController `Camera.SmartVisionData` (switch + per-camera toggle, D779) | gateway: motion, doorbell, connectivity; `vision/` ObjectDetection events (track lifecycle) |
| `<cam>__det_<class>` | MotionSensor + EndpointHealth — only the classes the camera's selection names (D778) | `detection-sensors/` (track lifecycle + active-track reconcile) |
| `<cam>__privacy`, `__autotrack`, `<cam>__<child>` | Power(+Brightness), proactive | `state-reports/` (DeviceStateChanged) |
| `<id>__alarm` | SecurityPanelController, proactive | `state-reports/` |
| `<id>__dev` | lock / contact / motion / temperature / humidity / switch / light + EndpointHealth | `state-reports/` + `handlers/generic-state.ts` |

- **EndpointHealth (D770)** must always have a value in Alexa's hands: ReportState
  answers it (OK when the status read fails) and an initial connectivity report
  follows every AddOrUpdateReport / Discover. Declared-but-unreported broke
  live view in the phone app once.
- **Talk-back (D771)**: `handleOffer({ talkback })` — the broker relays the
  Echo's microphone to `intercom.pushTalkAudio`. The hub strips the flag from
  browser calls.
- **Snapshots (D773)**: `GET /snapshot/:file` is public at the hub; the handler
  is the gate (HMAC + 10 min + account-link token of the minting user + S1).
  410 for anything expired/invalid/switched off. Never a redirect.
- **State changes arrive as `DeviceStateChanged {deviceId, capName, slice}`**
  only — the cap `on…Changed` events are never emitted, and
  `DeviceOnline/Offline` come from Reolink only (D776).
- **Only setting-driven endpoints are ever deleted by a push** (`mayRetire`:
  detection sensors). An accessory missing from one build may be a failed read.
- **Detection-sensor classes are per camera (D778)**: offered = the camera's
  `listEventKinds` answer (`DetectionClassSource`; `package` only with a
  package zone), published = offered ∩ the saved multiselect
  (`alexaDetectionSensorClasses` in the per-device store
  `<addonId>:addon-devices`). NEVER SAVED = NONE — that is also the migration
  of the D772 "all four" cameras. The integration switch is the master gate.
- **Object detection (D779, en-US-only interfaces, shipped as an experiment)**:
  person/package `ObjectDetection` events come from the pipeline's track
  lifecycle (`vision/object-detection-feed.ts`), NEVER from firmware motion.
  Ids derive from the track (`vision/vision-ids.ts`) so `ReportData` hands
  Alexa the same ids; images are LAZY signed URLs on the snapshot route
  (`SnapshotStore.mintLazy`), none while Snapshots is off. Per-camera state
  (`alexaVision`: the app's class choice, an id→track index, hidden ids) and the
  toggle (`alexaObjectDetection`) live in the per-device store. A camera that
  declares it is pushed in its OWN AddOrUpdateReport (`sync-engine.ts`), and
  every pushed endpoint logs `alexa sync: AddOrUpdateReport endpoint result`.
  **Kill switch**: Features → "Object detection (experimental)" off (the
  switch re-pushes every camera itself; Troubleshooting → "Re-sync now" forces
  it) — the cameras are re-sent without the two interfaces.
- **A ChangeReport goes only to an endpoint the exported signature names with
  that interface** — anything else is a 202 the cloud drops (D76).
- **PTZ directions are pulses of the cap's `ptz.move`, never `continuousMove` /
  timer / `stop`** (`handlers/ptz-travel.ts`, used by the ToggleController
  `ptz.panLeft…` and the ModeController `ptz.pan` / `ptz.tilt`). `move` is a
  self-terminating burst whose length the DRIVER reports as
  `getOptions().moveImpulseMs`; one voice command issues
  `max(1, round(TARGET_TRAVEL_MS / moveImpulseMs))` of them (1000 ms of travel;
  unknown impulse = one `move`), each awaited and then padded to its impulse,
  because reolink / amcrest / onvif return at once while hikvision waits. ONVIF
  throws on `continuousMove`, which is why the old timer path failed there. The
  response follows the travel (~1 s) and always reports OFF / `center`; only a
  failed FIRST pulse is an `INTERNAL_ERROR`.

## Plugs, the Alexa name and bulk selection (D875)

- A `switch` with the `outlet` role (HA `device_class: outlet`) is SMARTPLUG; a
  dimmable one is still LIGHT; any other switch is SWITCH.
- `alexaName` (per-device store key, form field `alexa:<id>:alexaName`) is the
  endpoint `friendlyName`; the endpoint id stays `<deviceId>__dev`. A rename is
  pushed with `pushDevice` (the shape signature ignores names). Validation:
  `endpoints/alexa-name.ts` (Amazon's rule: up to 256 letters, digits and
  spaces; no punctuation).
- The Export table selects in bulk by Role / Provider / Type / search
  ("Select N shown"); nothing is hidden by default.

## Secrets on read surfaces (D768)

The status `setup` block carries a MASK of the ingress token; the token is
returned only by the admin-only `revealIngressToken`. Every custom action here
is `auth: 'admin'` (the framework default is any authenticated user).

## When you change any of this

- **A per-integration control reads the authority that already owns the function**
  ([D62](../../docs/decisions/adr-0062.md), [D104](../../docs/decisions/adr-0104.md)).
  `unlinkAlexaAccounts` writes the oauth session store and this addon's own token
  store. Never add a third place that records whether Alexa is linked.
- **`OauthSessionSummarySchema` is not on the `@camstack/types` barrel.** Re-declare
  the fields you need locally (`link-status.ts`, `lwa-tokens-callback.ts` both do).
  Widening the barrel puts an addon-only change on the publish train.
- **A 2xx from the Event Gateway is not delivery.** The cloud accepts the envelope
  and drops the event when the endpoint never declared the interface. Check
  `exportedSignatures` before believing a "posted" log line.
- Shipping: this package goes live with `camstack deploy packages/addon-export-alexa`.
  Anything in `server/backend`, `@camstack/types` or `@camstack/system` needs a
  publish train + `applyServerUpdate`. Talk-back also needs the stream broker
  (`camstack deploy packages/addon-pipeline`) and the `webrtc-session` cap field
  on the hub (publish train).
- R4 (object detection + event history) is BUILT as a switchable experiment
  (D779); R6 (remote live view) is a design only:
  `docs/design/2026-10-08-alexa-*.md`. The skill-console steps for the en-US
  test live in the publication runbook (`alexa-publish-notes/runbook.md`).

## Actions as scenes ([D968](../decisions/adr-0968-an-exporter-may-expose-actions-and-notification-targets-as-list-entries-beside-devices.md))

An exported action is a scene endpoint (`action:<id>`, `SCENE_TRIGGER`,
`Alexa.SceneController`); Activate runs `actions.run`. It is not a device, so it
bypasses the per-device sync engine (`action-scenes.ts` holds its own push and
delete). Only an ADMIN link sees or fires one — a scoped link is answered
`NO_SUCH_ENDPOINT`. An action that is already running or in cooldown answers
`ENDPOINT_BUSY` and is logged, never queued.
