---
id: D732
title: A hub address is a row with role flags, and a custom address is a row like a detected one
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/types/src/capabilities/hub-address.ts
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/system/src/builtins/local-network/address-book.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
  - packages/addon-admin-ui/src/pages/system/AddressesCard.tsx
  - packages/addon-admin-ui/src/pages/system/address-table-model.ts
  - server/backend/src/api/hub-cluster-url.ts
  - packages/addon-auth/src/hub-browser-origin.ts
---

## Context

By 2026-10-06 the Network page had three notions of "the address this hub is
reached at":

- the endpoint table, with rows ticked for **Viewer** (many) and
  **Notifications** (one) — `viewerBaseUrls`, `notificationBaseUrl` (D709);
- the **Notification links** card's free "custom address" field, which wrote
  the same `notificationBaseUrl` with any typed URL, so the flag could name an
  address that was in no row at all;
- the **Hub addresses** card (D729 amendment, the same day): two typed
  overrides, `agentBaseUrl` and `signInBaseUrl`, read through
  `getHubAddresses` / `setHubAddress`.

Each was a correct answer to one question, and together they were three
different ways to say "this hub is reachable at X, use it for Y". An operator
behind NAT typed the same public address into two fields and could still not
make the apps race it — the viewer set accepted only detected rows. The
operator asked for one concept.

## Decision

An address is a **row**: a detected endpoint, an operator-entered **custom
address** (url + label), or the CamStack app link. Every row carries **role
flags**, the same way for detected and custom rows:

| Role | Values | Automatic (no flag) |
| --- | --- | --- |
| `viewer` — what the apps race and connect to | many | every LAN IPv4 address + the public tunnel |
| `notifications` — where taps and links point | one | the CamStack app link (D709) |
| `agents` — what agents and LAN devices pull from | one | LAN IPv4 literal, plausible LAN, mesh |
| `signIn` — sign-in links, OIDC callbacks, passkey RP, OAuth2 | one | tunnel, mesh, LAN |

- A single-valued role is stored as ONE URL, so at most one row carries it by
  construction; flagging another row moves it. The UI renders those columns as
  radio groups and shows per role the address in use and whether it is
  automatic.
- Automatic picks only among DETECTED endpoints. A custom address serves
  exactly the roles it is flagged with — it never wins a role by ranking.
- One resolver per role in `@camstack/types` (`resolveViewerAddresses`,
  `resolveNotificationsAddress`, `resolveAgentsAddress`,
  `resolveSignInAddress`); `local-network.getAddresses()` returns their
  answers, and every consumer — agent deliveries and model distribution,
  OAuth2, addon-auth, the Dreame relay, the Home Assistant media base —
  reads `roles.<role>.resolved`. Nothing ranks the palette itself.
- Validation is the D729 amendment's, for every row and every flag: http(s),
  a host, no credentials, no path, never loopback. The app link carries
  `notifications` only.
- **`signIn` on plain http is refused unless the operator explicitly accepts
  it** (`acceptInsecureHttp`; the UI asks first). Passkeys need a secure
  context and most identity providers refuse a plain-http redirect URI, so an
  http sign-in address silently breaks exactly the flows that matter most off
  the LAN. A password or magic-link sign-in that never leaves the operator's
  own network does work over http, and the LAN HTTP listener (`:4480`) is a
  legitimate home setup, so it is a deliberate opt-in rather than a ban. The
  other roles take http without ceremony: a LAN pull or a viewer race over
  http is the normal case.
- The apps need no change: `getConnectionEndpoints` carries the custom
  addresses flagged `viewer` (`kind: 'custom'`, which carries its own port and
  is never port-dependent), and `getViewerEndpoints().resolved` lists them, so
  a shipped viewer filtering the palette by it races them.

**Storage and migration.** The role flags keep their keys —
`viewerBaseUrls`, `notificationBaseUrl`, `agentBaseUrl`, `signInBaseUrl` — so
a rolled-back hub reads each with the meaning it already knew; custom
addresses are a new `customAddresses` list. In the READ path
(`normalizeAddressBook`), every single-valued flag that names neither a
detected row, a custom address nor the app link becomes a custom address
carrying that role: the D709 typed notification address becomes "Notification
links address" flagged `notifications`, and the two D729-amendment overrides
become custom addresses flagged `agents` / `signIn`. The next write persists
the result. It is one rule forever, not a one-off script: a flagged detected
address that disappears (a DHCP move) shows as a custom row instead of
vanishing while it still wins.

**Compatibility.** `setHubAddress` is removed (only the admin UI called it; an
older admin UI's save shows the error, nothing crashes). `getHubAddresses`
stays one release as a deprecated read-only shim over the role resolvers so an
addon built against the D729 amendment keeps resolving. `get/
setNotificationEndpoint` and `get/setViewerEndpoints` stay (the notification
centre and shipped apps read them); the two setters are deprecated and write
the same flags.

## Consequences

- The Network page has one **Addresses** table; the Hub addresses card and the
  notification custom-address field are gone. The Notification links card
  keeps its live preview and its "use default" button.
- This is a framework change (cap methods, `ConnectionEndpoint.kind` grew
  `'custom'`): it is live only with a `@camstack/server` that contains it, and
  every exhaustive switch over the kind must handle `'custom'`.
- An addon updated before the hub calls `getAddresses` on a hub that lacks it
  and falls back to its "unavailable" branch; ship the server first.
- A notifications flag set through the deprecated setter on an undetected URL
  is accepted (as before) and becomes a custom address; through
  `setAddressRole` an address must already be a row.

## Enforcement

- `packages/types/src/capabilities/__tests__/hub-address.spec.ts` — every
  role's automatic order, a flag winning for its role only, detected and
  custom flagged rows resolving the same way, loopback / app-link flags never
  handed out, the plain-http sign-in rule.
- `packages/system/src/builtins/local-network/__tests__/address-book.spec.ts`
  — through the real addon: single-valued roles move between rows, a custom
  and a detected row are flagged the same way, loopback refused with nothing
  stored, http sign-in refused until accepted, the D709 value and the D729
  overrides migrated into flagged custom rows (fails with the promotion
  removed), and a viewer-flagged custom address reaching
  `getConnectionEndpoints` + `getViewerEndpoints`.
- `server/backend/src/api/__tests__/hub-cluster-url.spec.ts`, the addon-auth
  OIDC / WebAuthn specs — consumers read `getAddresses().roles`.
- Admin UI: `address-table-model.spec.ts`, `AddressesCard.spec.tsx`.
- Guard `scripts/check-no-hub-address-env.ts` still refuses the retired
  variables. Nothing mechanically refuses a new consumer that ranks
  `getConnectionEndpoints` itself — review only.

## Amendment — 2026-10-07: the Notification links card is gone

The Consequences above kept the **Notification links** card for its preview
and its "use default" button. Both duplicated the table: the summary already
names the notifications address with **Use automatic**, and the app-link row
shows the `hub=` its links carry. A second card answering "where does a tap
go" was the same split this record removed, so it is deleted
(`NotificationLinkCard`, `notification-link-model`). The Addresses card now
opens with a collapsed **What are roles?** explanation built from
`ROLE_COLUMNS` (the same text the column tooltips use), so the role wording
lives in one place. Enforcement: `NetworkAddresses.spec.tsx` (no card, no
`getNotificationEndpoint` query), `AddressesCard.spec.tsx` (the explanation).

## Amendment — 2026-10-07: roles renamed, notification links split (D734)

The four roles are renamed for what they serve and one is split:
`viewer` → `appConnections`, `notifications` → `notificationTaps` (narrowed to
where a tap opens), `signIn` → `publicEndpoint` (widened to every off-LAN URL,
including the notification centre's buttons, attachments / media and admin
links), `agents` → `internal`. The "Storage and migration" section above no
longer holds: the old keys are not read, and nothing is migrated. See
[D734](adr-0734-address-roles-are-named-for-what-they-serve-and-notification-links-follow-the-public-endpoint.md).
