---
id: D994
title: Passive discovery and a 30-minute sweep feed one persisted proposal stream
status: accepted
date: 2026-11-02
supersedes:
applies-to:
  - packages/system/src/builtins/local-network/passive/**
  - packages/system/src/builtins/device-manager/discovery-proposal-service.ts
  - packages/system/src/builtins/device-manager/discovery-proposal-store.ts
  - packages/system/src/builtins/device-manager/record-kinds.ts
  - packages/types/src/capabilities/schemas/discovery-proposals.ts
  - packages/addon-admin-ui/src/components/integrations/DiscoveryProposalsBanner.tsx
---

## Context

Discovery (D977) only ran when the operator pressed "Scan network", and its
answer lived in the modal: close it and the findings were gone. A device that
joined the LAN a week later was never offered. Dismissing a candidate was not
possible at all, so a scan kept showing the same neighbour's devices.

## Decision

The `local-network` builtin owns two feeds into ONE stream, and
`device-manager` owns the stream's memory.

- **Passive listener.** On by default (`passiveDiscovery`), it joins the mDNS
  and SSDP multicast groups and never sends a probe. It de-duplicates what it
  hears (10 minutes per sighting), batches it every 5 seconds and calls
  `deviceManager.reportDiscoveryObservations`. Device-manager matches each
  sighting against the discovery modes the providers DECLARE and hands the hit
  to that provider's `classifyDiscoveryHits`, as a scan hit would be.
- **Sweep.** Every 30 minutes (never two at once, no sweep at boot) the watcher
  calls `deviceManager.runDiscoverySweep`, which runs the discovery the
  integrations already offer (`discoverProviders`) and records its candidates.
- **Memory.** The `discovery-proposals` record kind (`config`, id
  `<addonId>::<stableId>`, 90 days from `lastSeenAt`) holds the candidate, the
  adopting addon, `firstSeenAt`, `lastSeenAt` and `dismissed`. Seeing a device
  again moves `lastSeenAt` and refreshes the candidate; it never clears
  `dismissed`. What the operator already owns (a device with that `stableId`, an
  integration with that origin, a candidate flagged `alreadyOnboarded`) is hidden
  when the list is READ, so an adoption by any path hides the proposal without a
  write.
- **Adoption is not new.** The UI adopts through `deviceManager.adoptDevice`, or
  opens the integration form for a `setupIntegration` candidate: the flows the
  scan modal uses. The Integrations page shows "N new devices found" and a modal
  with Adopt and Dismiss.

## Consequences

The hub listens on UDP 5353 and 1900 by default; a host where another process
owns them exclusively logs `passive discovery: listener unavailable` and keeps
the sweep. A device that announces only on another subnet is found by the sweep
(which covers the saved subnets), not by the listener. A first sweep runs 30
minutes after boot; the listener fills the gap. Four methods are added to the
`device-manager` capability.

## Enforcement

Specs: `device-manager/__tests__/discovery-proposals.spec.ts` (real records
store: persistence across a reopen, dismissed stays dismissed, adopted hidden),
`local-network/passive/__tests__/discovery-watcher.spec.ts` (fake timers: the
30-minute bound, one sweep at a time, de-duplication) and
`addon-admin-ui/.../discovery-proposals-banner.spec.tsx` (the count follows the
proposals).
