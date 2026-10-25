---
id: D729
title: The hub's address comes from the network capability, never from an environment variable
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/types/src/capabilities/hub-address.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
  - packages/addon-admin-ui/src/pages/system/AddressesCard.tsx
  - server/backend/src/api/hub-cluster-url.ts
  - server/backend/src/boot/retired-public-url-env.ts
  - scripts/check-no-hub-address-env.ts
---

## Context

The URL a hub handed an agent to pull a staged addon bundle or model from was
`process.env.CAMSTACK_HUB_PUBLIC_URL ?? 'https://127.0.0.1:4443'`
(`server/backend/src/api/addon-upload.ts`, `model-distributor.ts`). The desktop
app has no field for that variable and the Unraid template marked it optional,
so a Mac hub — and any container started without it — handed every agent
`https://127.0.0.1:4443`. Loopback names the AGENT: each deploy and model
distribution failed on the agent with a connection refused that read as a
network fault. The public docs ended up documenting a `launchctl setenv`
workaround for the Mac.

The same variable was also the default for magic-link e-mails, the OIDC
callback, the WebAuthn relying party, the OAuth2 `hubUrl` claim, a CORS
allowlist entry, a ranked notification-link candidate and the Dreame relay
host. Every one of those restated something the hub already knows: the
`local-network` capability enumerates the interfaces, knows the port the hub
really listens on, honours the operator's allowlist (Network page) and knows
the tunnel and mesh names. A second, hand-typed copy of that answer could only
drift from it.

## Decision

The hub's address is read from `local-network.getConnectionEndpoints` through
one function, `pickHubBaseUrl(endpoints, audience)` in `@camstack/types`:

- `cluster` (agents, LAN devices): a plausible LAN IPv4 literal, then any
  plausible LAN address, then the mesh. Never the public tunnel, never
  loopback, never the app link.
- `browser` (auth links and callbacks, the relying party, OAuth2): the tunnel,
  then the mesh, then the LAN. Never loopback, never the app link.

`null` is an answer: an agent delivery then FAILS with a reason naming the
Network page instead of shipping `127.0.0.1`. The operator override is the one
the Network page already has — the allowed-addresses list narrows what the
palette offers, and the address marked for notifications is the notification
links' explicit choice. Each auth addon keeps its own explicit field (RP ID,
origin, redirect URI, e-mail origin) for a hostname the hub cannot know.

The address the agent itself dialled was considered and not chosen: the hub
cannot see which destination address an agent used (the transport reports the
agent's source), old agents would need an update to rebase a URL, and the
agent's own derivation hard-codes the API port while the palette carries the
real one. The Unraid hub template runs on `br0`/host networking, where the
palette's LAN address is the container's real one.

`CAMSTACK_HUB_PUBLIC_URL` and the older `CAMSTACK_PUBLIC_ORIGIN` are retired.
A hub that still sets one logs a WARN on every boot ("ignored — the hub address
comes from Network") and removes it from its environment before forking any
runner.

## Consequences

- No deployment needs a variable for its own address; the Mac `launchctl`
  workaround and the template field go.
- A WebAuthn relying party left empty is derived from the palette and so moves
  when the hub's address does; the settings text asks the operator to pin it.
  (An IP literal was never a valid RP ID, so a hub whose variable held a LAN
  IP had to have pinned one already.)
- A container on Docker BRIDGE networking sees only its bridge address
  (`eth0`, 172.17.x), which the palette classifies as LAN: agents are handed an
  address they cannot reach, exactly as WebRTC already advertises one there.
  Bridge networking is not a supported hub deployment (`deploying.md`: host
  networking is the default; the Unraid template uses `br0`). If it ever must
  be, the fix is the agent rebasing the URL onto the host it dialled — not an
  environment variable.
- The CORS allowlist loses the configured public origin; a browser on the hub's
  own address is the `own-host` case and needs no entry.

## Enforcement

`scripts/check-no-hub-address-env.ts` refuses any runtime file that names
either variable outside the boot step that strips it. Specs:
`packages/types/src/capabilities/__tests__/hub-address.spec.ts` (ranking, never
loopback), `server/backend/src/__tests__/addon-upload.spec.ts` (an agent deploy
with no variable carries the LAN URL — fails against the env read — and an
empty palette refuses the deploy), and
`server/backend/src/boot/__tests__/retired-public-url-env.spec.ts`.

## Amendment — 2026-10-06: an editable address per audience

> **Superseded by [D732](./adr-0732-a-hub-address-is-a-row-with-role-flags-and-custom-addresses-are-rows-like-detected-ones.md), 2026-10-06.** The two per-audience
> override fields below became role flags (`agents`, `signIn`) on rows of one
> Addresses table, next to `viewer` and `notifications`; an override became a
> custom address carrying the flag. `setHubAddress` is gone and
> `getHubAddresses` is a deprecated shim. The rest of D729 stands.

The Consequences above named the gap: auto-detection sees the hub's own
interfaces, and a hub on Docker bridge networking (only 172.17.x), behind NAT
or reached over a VPN is dialled at an address it never holds. The operator
asked for the fix to live where the address already lives, not in an
environment variable.

`local-network` stores two overrides, edited in the Network page's **Hub
addresses** card:

- **Hub address for agents** (`agentBaseUrl`, audience `cluster`);
- **Public address for sign-in links** (`signInBaseUrl`, audience `browser`).

Empty means automatic — the behaviour above. A set value wins outright
(`resolveHubAddress`, which `pickHubBaseUrl` wraps). Both are validated on
write by `validateHubAddressOverride` — an http(s) origin with a host, no
credentials, no path, never loopback (`127.x`, `localhost`, `::1`,
`0.0.0.0`) — and an invalid one is refused with its reason, storing nothing;
the admin form runs the same function before the round trip. A stored value
that no longer validates is ignored rather than handed out.

Consumers no longer rank the palette themselves: they read
`local-network.getHubAddresses()`, which returns each audience's `override`,
the `resolved` address in use and its `source` (`override | auto | none`) —
the same answer the card shows next to each field.

**Why a second field and not the notification-link custom address.** The
notification address answers a different question with a different default:
it is chosen for a notification's RECIPIENT, off the LAN and hours later, and
its AUTO value is the CamStack app link — not a hub address at all (D709). A
sign-in link must name the hub itself, and an OIDC callback or a WebAuthn
relying party must stay stable once registered; tying them to a flag an
operator moves to change where notification taps open would silently break
logins. So sign-in has its own field, with the same rules as the agent one.

Enforcement for the amendment:
`packages/system/src/builtins/local-network/__tests__/hub-address-override.spec.ts` <!-- drift-ok: renamed to address-book.spec.ts by D732 -->
(the override wins — fails when the addon ignores it; clearing falls back;
loopback and non-http refused and nothing stored), the override cases in
`hub-address.spec.ts`, and `server/backend/src/api/__tests__/hub-cluster-url.spec.ts`
(an agent override beats a bridge address).

