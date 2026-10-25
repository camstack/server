---
title: addon-export-google — package notes
covers:
  - packages/addon-export-google/**
---

# addon-export-google — package notes

Moved verbatim from `packages/addon-export-google/AGENTS.md` on 2026-10-09 so that root +
package `AGENTS.md` stay inside the 32 KiB Codex reads. That file keeps
the intro and the skill pointers and links here; edit the notes HERE.

## What is built, and what is not

**Built and tested end to end (in-process):** the fulfillment brain and the
device model. `POST /addon/export-google/fulfillment` verifies a hub-minted
OAuth bearer, then answers `action.devices.SYNC`, `.QUERY`, `.EXECUTE` and
`.DISCONNECT` for switches, dimmable lights, locks and covers.

**Not built:**

- **Report State / `requestSync`.** Both are HomeGraph API calls and HomeGraph
  authenticates with a service-account key this addon deliberately does not
  hold ([D269](../../docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md)).
  Every device syncs with `willReportState: false` and Google POLLS. A new
  exposed device appears only on Google's next sync — "Hey Google, sync my
  devices".
- **Cameras.** No `CameraStream` trait: it must answer `GetCameraStream` with a
  playable URL or a WebRTC signaling endpoint, and neither exists here. A camera
  is dropped from SYNC with a logged reason, never declared-and-broken
  ([D273](../../docs/decisions/adr-0273-one-capability-is-one-trait-row-that-declares-reads-and-writes.md)).
- **Anything verified against real Google traffic.** No hub was contacted while
  this was written. Every claim below about Google's behaviour comes from the
  published contract, not from a session.

## `publicHubUrl` — the one value an operator owns

It is used for ONE thing: rendering the three console URLs. Nothing routes on
it. All of the policy lives in `src/public-hub-url.ts`, which is pure and
carries the long-form reasoning; the addon holds only the adapter onto
`ctx.api.networkAccess` and the settings surface.

- **Source: the `network-access` cap**, the same one `addon-export-alexa` uses.
  **Not** the hub's `agents` or `signIn` address (`local-network.getAddresses`) — Google calls
  from its own cloud, and a LAN or loopback answer here renders three console
  URLs that look finished and can never be reached.
- **Default, never override.** Detection FILLS an empty field. A value already
  there is what the operator pasted into Google's console; rewriting it would
  leave the two sides disagreeing with nothing on screen to say so. This is the
  one place the mechanism diverges from Alexa's, whose `redetectPublicHubUrl`
  *does* clobber — sound there, because Alexa routes on the value.
- **The field says where its content came from.** `detectedPublicHubUrl` is
  persisted alongside so the panel can render `Derived from remote access` vs
  `Set by you`, and offer the detected alternative when they disagree. A URL
  that appears by itself with no provenance is worse than a blank field.
- **A non-routable address is refused, not adopted.** A `network-access`
  provider reporting an HTTPS ingress on `192.168.…` / `localhost` / `*.local`
  is dropped with a logged reason. Alexa forwards those; here they would be
  strictly worse than an empty field.
- **Text field, not Alexa's `select`.** A hub behind a port-forward + DDNS name,
  or a reverse proxy, has no `network-access` provider at all and still works
  perfectly with Google. A picker limited to detected endpoints makes that setup
  unreachable.
- **Detection is detached at init and re-run on `NetworkTunnelStarted`.**
  Awaiting a cross-addon `ctx.api` call inside `onInitialize` is what left
  `export-alexa` stuck in "Still waiting for capability": a provider goes live
  only once `onInitialize` RETURNS.
- The button is a `customAction` (`src/custom-actions.ts`), so it costs no
  capability, no codegen and no framework publish train.

## The one rule that shapes the whole addon

**One capability = one row in `src/google-home/trait-catalog.ts`**, and that row
owns declaration, read, write and the post-write echo. SYNC, QUERY and EXECUTE
all walk the same array; none of them carries its own list of capability names.
A capability without a complete row is not exported at all.

Adding a capability is therefore: one `TraitDescriptor`, one `CapCall` variant,
one arm in each switch of `cap-dispatch.ts`. Forgetting the dispatch arm is a
compile error (`never` binding), not a runtime 404. See
[D273](../../docs/decisions/adr-0273-one-capability-is-one-trait-row-that-declares-reads-and-writes.md).

`resolveCommand` and `projectState` are PURE. They must stay pure — that is what
lets `__tests__/` exercise the whole mapping without a tRPC client, and it is
why Google's relative commands (`BrightnessRelative`, `openRelativePercent`) are
REFUSED rather than resolved: they need the current value.

## Traps

- **`ctx.api` never appears in an intent handler.** They take a `DeviceGateway`
  (`src/device-gateway.ts`). `AddonApi` is a generated tRPC router type wide
  enough that a test fake for it is only constructible with a cast, and this
  repo forbids casts. Reach for `ctx.api` and the tests stop being writable.
- **`loadFacts` returning `null` and `loadFacts` REJECTING mean different
  things.** `null` is "not in the registry" (a stale exposed entry →
  `deviceNotFound`); a rejection is a hub problem. Collapsing them reports a
  healthy device as deleted.
- **The exposed-list check in `query.ts` and `execute.ts` is a security gate.**
  Without it, a linked Google account can read and actuate any device id it
  guesses, including ones the operator never exported. Two tests cover it; do
  not "simplify" them away.
- **A lock reports its STABLE state, never its target.** `locking` projects to
  `isLocked: false`. Reporting the target is what makes a jammed motor look like
  a successful lock.
- **EXECUTE echoes the state the call establishes rather than re-reading**, for
  the same reason: a lock that accepted the command sits in `locking` for
  seconds, and a read-back would tell the operator it failed.
- **Executions run sequentially on purpose.** Google splits "turn the lamp on
  and dim it" into two executions in one request; a lane pool would race them.
- **Field keys in the device-details panel are namespaced `google:<id>:…`.** The
  aggregate form flattens fields by `key` across sections, so a bare `enabled`
  collides with HAP's and Alexa's and routes this toggle to their writer.

## Credentials — read before adding a settings field

This addon holds **no Google credential**, and a HomeGraph service-account key
must never become one. `type: 'password'` masks in the browser only:
`packages/types/src/interfaces/config-ui.ts:1356` records that password fields
deliberately hydrate with their stored value, so `getGlobalSettings` returns
plaintext. The `device-export` cap's `ExportSetupField.secret` has the same
shape. When Report State is built, the key arrives by file path or environment
variable. Full reasoning:
[D269](../../docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md).

`scripts/check-no-service-account-keys.ts` fails CI on a service-account JSON or
a PEM private key anywhere in the tree.

**Do not copy `packages/addon-export-alexa/src/public-skill.ts`.** Committing
that LWA secret is sound for Amazon's published-skill model. A HomeGraph key is
a different class of credential and the answer is always no.

## Operator setup (all on Google's side)

1. A Google Home Developer Console cloud-to-cloud integration, in **test mode**
   — publishing needs Google certification a private hub cannot obtain.
2. Fulfillment URL: `https://<hub>/addon/export-google/fulfillment`
3. Authorization URL: `https://<hub>/api/oauth2/authorize?integration=export-google`
4. Token URL: `https://<hub>/api/oauth2/token`
5. The hub must be reachable from the public internet over HTTPS — Google calls
   from its own cloud.

The Export panel renders 2–4 once `publicHubUrl` is set — and it sets itself
from remote access when one is detected, so on a hub with a tunnel up the
operator usually finds them already filled. When nothing is detected the panel
says so instead of guessing. Nothing comes back to
the hub: the client id and secret live in the Google console, and the hub does
not verify the client secret
([D92](../../docs/decisions/adr-0092.md)).

## Shipping

`camstack deploy packages/addon-export-google`. Editing `src/` and rebuilding
`dist/` has no runtime effect until you do. No new capability was added, so no
framework publish train is required — the addon registers against the existing
`device-export`, `addon-routes` and `oauth-integration` caps.
