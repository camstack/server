---
id: D1085
title: The automatic public endpoint is sticky on the tunnel it once resolved to, until that integration is removed
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/capabilities/hub-address.ts
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/system/src/builtins/local-network/address-book.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
---

## Context

Automatic resolution of `publicEndpoint` was computed live and never kept. At hub
boot the tunnel row is absent until the tunnel integration starts, so automatic
answered the LAN http address for a few seconds. In that window the Alexa skill's
routing claim (the tunnel origin) was refused and Amazon unlinked the skill. A
FLAGGED absent address already survived as a custom row (D732); automatic had no
memory.

## Decision

When automatic `publicEndpoint` resolves to a tunnel row, the local-network owner
persists the pick in its own store: the base URL (`rememberedPublicEndpointUrl`)
and the addon whose `NetworkTunnelStarted` event supplied the row
(`rememberedPublicEndpointAddon`, the event source). While that addon still has an
integration row (`integrations.listByAddon`, enabled or not), automatic keeps
answering the remembered address when no live tunnel row is detected. A live
tunnel always wins and refreshes the memory; an explicit flag always wins over
both. The memory is cleared only by an ANSWERED, empty integration list; a read
that failed changes nothing (D49). The answer carries `source: 'auto-remembered'`
on the single-valued roles; the deprecated `getHubAddresses` maps it to `auto`.
A LAN-only hub never remembers anything.

## Consequences

The tunnel is only remembered once an event named its addon; a hub whose tunnel was
adopted by the pull reconcile alone has no memory until the next start event. A
tunnel that is no longer wanted but whose integration stays is still answered —
the operator flags another address or removes the integration. The memory is
written from the address-book read, outside the mDNS announcement (which reads it).

## Enforcement

`packages/system/src/builtins/local-network/__tests__/sticky-public-endpoint.spec.ts`
(boot with the row absent, removal, flag, LAN-only, unreadable list).
