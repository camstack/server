---
id: D860
title: An "install an addon for X" offer is answered from the published manifests, and a temporary tunnel address is never an automatic hub address
status: accepted
date: 2026-10-16
supersedes:
applies-to:
  - server/backend/src/core/addon/addon-package.service.ts
  - packages/addon-admin-ui/src/pages/system/Addons.tsx
  - packages/addon-admin-ui/src/pages/system/CapabilityCatalog.tsx
  - packages/types/src/capabilities/hub-address.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
  - packages/addon-cloudflare/src/tunnel/cloudflare-tunnel.ts
---

## Context

Two defects, found together on the Remote Access page.

**An install button that could never install.** Every admin "add an addon for X"
button (Remote Access, Mesh, TURN, Integrations, Training) links to
`/system/addons?capability=<cap>`. The page applied that filter only to the
INSTALLED addons: the npm picker never received the capability, and the npm
search returned no capabilities to filter on. Tailscale could never be offered
for `network-access` while it was not installed — the one situation the button
exists for. The Logging page carried the same button for `log-destination`,
whose every provider is built into `@camstack/system`: a button to nothing.

A hand-kept keyword per package ("tailscale", "mesh") was the first idea. It
would be a second declaration of what a package provides, next to the
`camstack.addons[].capabilities` the package already publishes (D4).

**A random URL as the hub's address.** The Cloudflare addon's default Quick mode
runs `cloudflared --url …` and gets a random `*.trycloudflare.com` hostname that
changes on every respawn. `local-network` tails `network.tunnel.started` and
turned that hostname into the `public` palette entry, which the automatic role
resolution ranks FIRST for `publicEndpoint` (rank 0) and includes in the
automatic `appConnections`. Every sign-in link, OIDC callback, passkey relying
party and notification button built on the automatic public endpoint then
named an address that died at the next restart.

## Decision

1. **The npm search answers from each package's own manifest.**
   `addons.searchAvailable` takes `capability?` and each result carries
   `capabilities: string[] | null`, read from the package's `/latest`
   (`camstack.addons[].capabilities`), through a worker pool of 6 and a 10-minute
   cache. `null` means the lookup failed — unknown, never `[]` (D393) — and an
   unknown package is excluded from a filtered result, counted and logged once
   per search. No keyword or tag is added by hand.
2. **A `?capability=` link shows two groups**: "Installed" (as before) and
   "Available to install" (the filtered npm results, with the page's Install
   action). Each group has its own empty state, and not-yet-answered or failed is
   never rendered as "none" (D315).
3. **A tunnel provider says whether its address is stable.** `network-access`
   endpoints and the `network.tunnel.started` event carry `stable?: boolean`
   (`false` = re-issued on its own; absent = stable). The Cloudflare addon sets it
   from its mode, not from the hostname: Quick is `false`, a named tunnel is
   `true`. `local-network` carries it onto the palette entry
   (`ConnectionEndpoint.stable`, label "Public tunnel (temporary address)").
4. **Automatic role resolution skips an unstable address** — `publicEndpoint`
   and `appConnections` (in `hub-address.ts`, the one resolver). The entry stays
   in the palette and on the Remote Access card; an operator who flags it on the
   Network page still gets it (D729, D732, D734). `notificationTaps` is unaffected:
   its automatic answer is the CamStack app link.

## Consequences

- With only a Quick tunnel and a LAN address, the automatic `publicEndpoint` is
  the mesh if there is one, else the LAN address. Links that must work off the
  home network then need a named tunnel, a mesh funnel or an explicit flag —
  which is the truth the old behaviour hid until the next restart.
- A Cloudflare addon deployed before this change emits no `stable`; absent is
  read as stable, so an old Quick tunnel keeps today's behaviour until the addon
  is redeployed.
- A capability-filtered search costs one registry request per camstack package on
  a cold cache (6 in flight), then none for 10 minutes. A failed lookup is retried
  on the next search.

## Enforcement

`scripts/check-addon-install-links.ts` (wired into `checks.yml`): every
`install: { capability }` and `addonCatalogHref(...)` names a capability a
`packages/addon-*` package declares, and the catalog URL is spelled only by
`addonCatalogHref` in `@camstack/types`. Specs: `search-npm-capability.spec.ts`,
`Addons.spec.tsx` (capability group, pending vs empty), `hub-address.spec.ts`,
`address-book.spec.ts` and `tunnel-stability.spec.ts` (unstable address never
automatic, flag still wins, named tunnel unchanged).
