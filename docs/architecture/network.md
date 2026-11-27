---
title: The hub network layer
covers:
  - packages/types/src/capabilities/hub-address.ts
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/types/src/capabilities/network-access.cap.ts
  - packages/types/src/capabilities/mesh-network.cap.ts
  - packages/system/src/builtins/local-network/**
  - packages/addon-cloudflare/src/tunnel/**
  - packages/addon-tailscale/**
---

# The hub network layer

Read this page when you ask "which address does this link use, and why?". It
explains the address palette, the four roles an address can serve, the addons
that feed the palette, and who reads what. Notification tap URL shapes are in [notifications](notifications.md); the Alexa-specific consequences are in
[addon-export-alexa](../addons/addon-export-alexa.md) (the `routing-claim-stale`
row); this page does not repeat them.

Not to be confused with the `network-link` capability: that is a device's own
wifi or ethernet link (`packages/types/src/capabilities/network-link.cap.ts`),
unrelated to how clients reach the hub.

## 1. What the layer answers

"At which address is this hub reached, and for what?" One builtin owns the
answer: `local-network` (`packages/system/src/builtins/local-network/local-network.addon.ts`).
It builds a **palette** of detected addresses, lets the operator add custom ones,
lets the operator **flag** an address for a **role**, and resolves each role
(`packages/types/src/capabilities/hub-address.ts`). No environment variable
carries this answer (D729): every consumer asks `localNetwork.getAddresses`.

## 2. The palette

Each row is a `ConnectionEndpoint` (`kind`, `interfaceKind`, `priority`, optional
`stable`). Lower priority is tried first. Built in `buildEndpoints`.

| Row | `kind` / `interfaceKind` | Where it comes from | Priority | Example |
| --- | --- | --- | --- | --- |
| Local name | `lan-ipv4` / `lan` | The LAN http listener's local hostname, only when the LAN http listener is on and listening | 0 | `http://camstack.local:4480` |
| LAN IPv4 | `lan-ipv4` | The preferred interface first, then every other non-internal, non-link-local IPv4 interface | 0, then 10+ | `https://192.168.1.9:4443` |
| LAN IPv6 | `lan-ipv6` | Plausible, non-link-local IPv6 interfaces (skipped when IPv4-only) | 10+ | `https://[2001:db8::9]:4443` |
| Public tunnel | `public` / `public` | The tunnel hostname (section 4) | 100 | `https://camstack.example.com` |
| Mesh | `public` / `vpn` | The mesh endpoint (section 4); always https | 150 | `https://hub.tailnet.example.ts.net:4443` |
| Loopback | `loopback` | Only when the caller asks for it | 1000 | `https://127.0.0.1:4443` |
| App link | `app-link` | Only with `includeAppLink: true` (the Network page); priority -1; never raced, never ranked | -1 | `https://camstack.zentik.app` |
| Custom | `custom` | An operator-entered address (`addCustomAddress`); serves only the roles it is flagged with | n/a | `https://192.0.2.20:4443` |

Every LAN address advertised over `http://<ip>:4480` also has an
`https://<ip>:4443` row straight after it (`withLanHttpsCounterparts` in
`packages/system/src/builtins/local-network/address-book.ts`), ticked for App
connections by default (D859). Only the app-connection palette and the table
carry it; `internal` and `publicEndpoint` resolve over the https palette.
A phone that trusts the hub's local CA reaches the https row and the viewer
prefers it when both of a host answer; a phone that does not fails that
candidate in the race it already runs (logged once per session as
`tls-untrusted` or `unreachable`) and keeps the http row or the tunnel. Plain
http on the LAN carries the session token in clear, so a phone that should be
protected at home needs the CA installed. The LAN TLS design is in
[2026-08-22-lan-tls-zero-touch](../design/2026-08-22-lan-tls-zero-touch.md). A Quick tunnel row is labelled "Public tunnel (temporary
address)" and carries `stable: false` (D860).

## 3. The four roles

An address, detected or custom, carries role flags. A flag wins outright; no flag
means automatic. Automatic picks only among detected rows: loopback, the app link
and custom rows are never an automatic answer, and a row with `stable: false` is
never an automatic answer for any role. An explicit flag still wins. `null` means
nothing qualifies; callers report that instead of substituting `127.0.0.1`.

| Role | Cardinality | Meaning | Automatic pick |
| --- | --- | --- | --- |
| `appConnections` | many | What the CamStack apps race when connecting | Every LAN IPv4 plus the stable public tunnel. Never IPv6, mesh, loopback or custom. A flagged set none of which is up falls back to automatic |
| `notificationTaps` | one | ONLY where tapping a notification opens | The app link; a hub address may be flagged. The app link is accepted by this role only |
| `publicEndpoint` | one | Every URL that must work from outside the home network: sign-in links, OIDC and OAuth2 callbacks, the passkey relying party, account linking, notification buttons, attachments and media links | In order: public tunnel, then mesh, then a LAN IPv4 literal, then any plausible LAN address |
| `internal` | one | What agents and LAN devices download from: addon bundles, models, a camera relay's broker host, Home Assistant media | LAN IPv4 literal, then any plausible LAN address, then mesh. Never a public tunnel |

Rules enforced by `checkRoleAddress`: an address is an http(s) origin with a host,
no credentials, no path, never loopback; a plain-http address may carry
`publicEndpoint` only when the operator passes `acceptInsecureHttp` (passkeys and
most identity providers refuse http).

Examples, with a hub at `192.168.1.9` and a stable tunnel `camstack.example.com`:

- `appConnections` automatic = `https://192.168.1.9:4443` and
  `https://camstack.example.com`. At home the app wins on the LAN row; away it
  wins on the tunnel.
- `publicEndpoint` automatic = `https://camstack.example.com`. With no tunnel and
  no mesh it falls to the LAN address, which no cloud can reach.
  Once automatic has resolved to the tunnel it is **sticky** (D1085): the
  local-network owner remembers the address and the addon that supplied it, and
  keeps answering it (`source: 'auto-remembered'`) while the tunnel row is absent
  (boot, a restarting tunnel) for as long as that addon has an integration, enabled
  or not. Only removing the integration clears it; a failed read does not. A live
  tunnel and an explicit flag both win over the memory.
- `internal` automatic = `https://192.168.1.9:4443`. An agent never detours
  through the tunnel.
- Flag a custom `https://203.0.113.5:8443` as `publicEndpoint` when the hub sits
  behind NAT or a reverse proxy the hub cannot detect.

Single-valued roles (`notificationTaps`, `publicEndpoint`, `internal`) are carried
by one address each; flagging another moves the flag. Changing the public endpoint
changes the passkey relying party, so passkeys registered under the old one stop
working. OIDC, passkeys and OAuth2 take the public endpoint; see
[authentication](authentication.md).

A **custom address** is for an address the hub cannot detect: Docker bridge
networking (the hub only sees 172.17.x), NAT, a VPN, a reverse proxy. It is
validated, serves only the roles flagged on it, and never wins a role
automatically.

Flag by hand when the hub cannot detect the right address (NAT, reverse proxy, a
VPN you want clients to prefer). Do not flag by hand to work around a missing
automatic pick: find out why the row is missing (section 7).

## 4. Providers and addons

| Provider | Package | Capability | Feeds |
| --- | --- | --- | --- |
| `local-network` | builtin in `packages/system` | `local-network` | The palette, the roles, the allowlist, the mDNS advertisement |
| `cloudflare-tunnel` | `packages/addon-cloudflare` | `network-access` (collection, `providerKind: ingress`) | The public tunnel row. Its `mode` is `quick` (random `*.trycloudflare.com`, no account) or a named tunnel on the operator's own domain |
| `tailscale-client` | `packages/addon-tailscale` | `mesh-network` (collection, `providerKind: mesh`) | The mesh row |

How `local-network` learns the tunnel hostname:

1. Fast path: the `NetworkTunnelStarted` event. Placeholder hostnames
   (`*.placeholder`, `pending.*`) are ignored.
2. Pull-reconcile from `network-access.getStatus` before each palette build
   (throttled to one pull per 5 s, time-boxed to 2 s). `connected` with an
   endpoint adopts it; `connected: false` clears it; a failed read (throw, no
   provider, timeout) changes nothing. Events are lossy, so the pull is the
   authority.

How it learns the mesh endpoint: the `MeshNetworkChanged` event, plus a pull from
the `tailscale-client` provider's `getStatus` (host is the MagicDNS name, else the
mesh IP). New mesh providers are added to `MESH_PROVIDER_ADDON_IDS`.

Cap methods (`local-network.cap.ts`): `getAddresses`, `addCustomAddress`,
`removeCustomAddress`, `setAddressRole`. Deprecated and kept for older addons:
`getHubAddresses` (`cluster` = `internal`, `browser` = `publicEndpoint`),
`setNotificationEndpoint`, `setViewerEndpoints`.

## 5. Who reads what

| Consumer | Role | Why | Source |
| --- | --- | --- | --- |
| Notification taps | `notificationTaps` | Open the native app | `addon-post-analysis/src/notification-center/default-tap-url.ts` |
| Notification buttons, attachments, media, admin links | `publicEndpoint` | Must work off the LAN; the tap role must not move them (D734) | `addon-post-analysis/src/notification-center/link-endpoints.ts` |
| Alexa OAuth `hubUrl` claim and directive routing | `publicEndpoint` | The Lambda calls back from the cloud | `addon-export-alexa/src/public-endpoint.ts` |
| Google export | `publicEndpoint` | Google calls from its cloud | `addon-export-google/src/public-endpoint.ts` |
| Google OAuth redirect | `publicEndpoint`, else `internal` | Redirect origin | `addon-google-services/src/oauth-redirect-origin.ts` |
| OIDC callback, passkey relying party | `publicEndpoint` | A browser returns here | `addon-auth/src/hub-browser-origin.ts` |
| Device enrolment link | `publicEndpoint`, then every `appConnections` address | A phone leaves the LAN | `system/src/builtins/local-auth/local-auth.addon.ts` |
| Agent downloads and pairing offer | `internal` | The agent dials on the LAN | `server/backend/src/api/hub-cluster-url.ts`, `server/backend/src/api/core/agent-pairing.router.ts` |
| mDNS `_camstack._tcp` advertisement | `internal` | Clients find the hub on the LAN (D838); TXT carries `nodeId`, `version`, `role`, `url`, `hubId` | `system/src/builtins/local-network/hub-mdns.ts` |
| Reolink webhook | `internal` | A camera posts to the hub's LAN http host | `addon-provider-reolink/src/baichuan-webhook-shared.ts` |
| Camera relay broker host | `internal` | A broker on another node dials it | `addon-provider-dreame/src/devices/dreame-camera-stream.ts` |
| SMTP | `internal` | Host for the mail client | `addon-smtp-nodemailer/src/smtp.addon.ts` |

The CamStack apps race the `appConnections` set (`getViewerEndpoints`, a
deprecated-setter sibling of `getAddresses`).

## 6. Discovery over mDNS (D838)

The hub publishes ONE `_camstack._tcp` service for its HTTPS endpoint, so
`camstack login`, `camstack discover` and an agent's local UI find it on the LAN.
The TXT record carries `nodeId`, `version`, `role=hub`, `url` and `hubId`; `url` is
the `internal` role, never ranked again by the advertiser
(`packages/system/src/builtins/local-network/hub-mdns.ts`). Finding a hub grants
nothing: every client still signs in, and an agent adopts an announced address
only after the pinned-CA check. mDNS needs UDP 5353 multicast on the LAN (a
dedicated container IP or host networking, not Docker bridge); the `mdnsAdvertise`
setting turns it off. Agents advertise `_camstack-agent._tcp` so a hub can find
them to pair. The transport details and the CLI browse are in
[transport](transport.md#clients-find-a-hub-over-mdns-not-the-mesh-channel-d838).

## 7. Failure modes

- Retired variables: `CAMSTACK_HUB_PUBLIC_URL` and `CAMSTACK_PUBLIC_ORIGIN` are
  ignored. A container that still sets one logs a WARN in the `public-url` scope on
  every boot, and the hub removes it from its environment before any addon runner
  forks (`server/backend/src/boot/retired-public-url-env.ts`). The guard
  `scripts/check-no-hub-address-env.ts` refuses runtime code that names either.
- A role resolves to `null`: the consumer refuses with a reason naming the Network
  page. There is no loopback fallback.
- A tunnel row missing from the palette: `publicEndpoint` silently falls to the
  next rank (mesh, then LAN).
- A Quick tunnel is up but `publicEndpoint` is the LAN: expected, a temporary
  address is never automatic (D860). Use a named tunnel, or flag it knowingly.

Worked example, 2026-11-21. After a hub restart with the tunnel already running,
`local-network` had missed the one-shot `NetworkTunnelStarted` event. The palette
had no public row, so `publicEndpoint` resolved to `http://192.168.1.9:4480`
(a LAN row) instead of `https://camstack.example.com`. Alexa account linking
baked that LAN URL into the OAuth code as the `hubUrl` claim; the cloud Lambda
could not reach it and timed out on the token exchange. The fix was the
pull-reconcile from `network-access.getStatus` (commit 049b97221), not a manual
flag: a flag would have pinned a value that no longer follows the tunnel.
The lesson: an address is learned from state, never from a single event.

## 8. How to inspect

```bash
node scripts/hub/hub.mjs GET localNetwork.getAddresses
```

The answer lists every palette row, the role flags and, per role, `flagged`,
`resolved` and `source` (`flagged`, `auto` or `none`). Check `roles.publicEndpoint`
first when a link points at a LAN address.

## Device networks (Network → Device networks)

A sibling of "Mesh networks" (the VPN meshes, which are integration instances with credentials), not a kind of it: the radio / IP meshes of devices (a Matter fabric over Thread or Wi-Fi, Zigbee later) are read from the devices, through the device-native `device-mesh` capability. The section enumerates the devices that carry the capability (`deviceManager.search` requiring it) and reads one `getTopology` per network: a topology answers for the whole mesh the device sits in, so every device already listed as a node of a read topology is skipped. A read that fails is its own network with the reason, never an empty one. The selected node is `?node=<deviceId>`; the device page's "View in the network" link opens the section on it. The device page itself carries the `host/device-mesh` widget, derived from the capability's `deviceConfig`.
