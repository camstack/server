---
id: D734
title: Address roles are named for what they serve, and notification links follow the public endpoint
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/types/src/capabilities/hub-address.ts
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/system/src/builtins/local-network/address-book.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
  - packages/addon-post-analysis/src/notification-center/link-endpoints.ts
  - packages/addon-post-analysis/src/notification-center/default-tap-url.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/addon-admin-ui/src/pages/system/address-table-model.ts
  - packages/addon-admin-ui/src/lib/connect-phone-link.ts
---

## Context

D732 gave every hub address role flags: `viewer`, `notifications`, `agents`,
`signIn`. The names described who READ an address, not what it was FOR, and
one of them did two jobs:

- `notifications` decided where a tap opens **and**, through
  `collectArtifactEndpoints`, led the ladder every other notification link
  was minted on — action buttons, attachment / media links, the admin page a
  system event taps into. An operator who flagged a LAN address so taps opened
  the hub at home quietly moved every button and attachment onto the LAN,
  where a phone away from home cannot open them. The default (the CamStack app
  link) hid the coupling, because the ladder skips the app link and fell
  through to the tunnel.
- `signIn` already resolved "the address that works from outside" (tunnel,
  then mesh, then LAN), which is exactly what a notification button needs —
  under a name that said sign-in only.
- `viewer` and `agents` named consumers (the viewer app is not the only app;
  "agents" also covered Home Assistant and the Dreame relay).

## Decision

Four roles, named for what they serve. The operator's labels in the Network
page's Addresses table are in bold:

| Role | Label | Values | Serves | Automatic |
| --- | --- | --- | --- | --- |
| `appConnections` | **App connections** | many | the addresses the CamStack apps try when connecting | LAN IPv4 + the public tunnel |
| `notificationTaps` | **Notification taps** | one | ONLY where tapping a notification opens | the CamStack app link |
| `publicEndpoint` | **Public endpoint** | one | every URL that must work off the LAN: sign-in links, OIDC / OAuth2 callbacks, the passkey relying party, account linking, and the notification centre's action buttons, attachment / media links and admin links; the admin "Connect a phone" link pre-selects it | the tunnel, then the mesh, then the LAN |
| `internal` | **Internal** | one | what agents and LAN devices download from: addon / model delivery, the Dreame relay host, the Home Assistant media base | the hub's LAN address |

- The notification centre reads the taps role ONLY for a camera tap
  (`tapBase` → `viewerLinkBaseOf(getNotificationEndpoint)`); every other link
  is built by `link-endpoints.ts` on `getAddresses().roles.publicEndpoint`,
  and the connected-ingress / LAN rungs of `collectArtifactEndpoints` remain
  only for when `local-network` cannot answer.
- The app link can be the notification-taps address only. `checkRoleAddress`
  refuses it for the public endpoint even with plain http accepted.
- The plain-http confirmation rule of D732 moves with the role: the public
  endpoint on `http://` is refused unless the operator accepts it.

**No migration.** The old role ids are removed completely — no alias, no
read-path mapping. Storage moves to new keys (`appConnectionUrls`,
`notificationTapUrl`, `publicEndpointUrl`, `internalUrl`); a value stored
under `viewerBaseUrls`, `notificationBaseUrl`, `signInBaseUrl` or
`agentBaseUrl` is ignored and that role reads automatic. This hub is the only
install, and the operator re-sets the four values by hand after the release;
migration code would be read-path logic kept forever for one hand edit. This
reverses D732's "the role flags keep their keys" storage clause and its
promotion of the D709 / D729-amendment values. What stays from that rule is
the DHCP case: a single-valued flag naming an address in no row is still shown
as a custom address carrying the role.

## Consequences

- A framework change (`HubAddressRoleSchema`, the `getAddresses().roles`
  shape, `setAddressRole`): an admin UI or addon built before it sends or
  reads role ids the hub no longer knows. Ship the server, admin UI,
  `addon-auth`, `addon-post-analysis`, the Dreame and Home Assistant
  providers together.
- After the upgrade every role is automatic until re-set. With the defaults,
  buttons and attachments move from the notifications address to the public
  endpoint's automatic pick (the tunnel when there is one).
- Changing the public endpoint changes the passkey relying party: passkeys
  registered under the old one stop working. The Addresses card says so.
- `getNotificationEndpoint` / `getViewerEndpoints` keep their names (shipped
  apps call them) and now describe the taps and app-connections roles.

## Enforcement

- `packages/types/src/capabilities/__tests__/hub-address.spec.ts` — every
  role's automatic order; the app link refused for the public endpoint.
- `packages/system/src/builtins/local-network/__tests__/address-book.spec.ts`
  — through the real addon: the app link refused for `publicEndpoint`,
  values under the old keys ignored.
- `packages/addon-post-analysis/src/notification-center/__tests__/link-endpoints.spec.ts`
  — buttons / media / admin links resolve on the public endpoint and never
  read the taps role; `dispatcher-app-link-tap.spec.ts` — the camera tap
  follows the taps role (app link or a hub address), an admin tap uses the
  public endpoint even when the taps role is the app link or a LAN address.
- Consumers through their role: `hub-cluster-url.spec.ts` (agent delivery =
  `internal`, OAuth2 = `publicEndpoint`), the addon-auth OIDC / WebAuthn
  specs, `dreame-camera-stream.spec.ts`, `media-base-url.spec.ts` (Home
  Assistant), `ConnectPhoneCard.spec.tsx`.
- Nothing mechanically refuses a new consumer that reads the taps role for a
  non-tap link — review only.
