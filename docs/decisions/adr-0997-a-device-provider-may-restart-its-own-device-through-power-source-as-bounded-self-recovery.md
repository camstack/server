---
id: D997
title: A device's own provider may call power-source forceRestart for its own device, as a bounded self-recovery
status: proposed
date: 2026-11-02
supersedes:
applies-to:
  - packages/types/src/capabilities/power-source.cap.ts
  - packages/addon-provider-velux/src/velux-power-recovery.ts
  - packages/addon-provider-velux/src/velux-integration-manager.ts
---

## Context

`power-source` was MANUAL ONLY: an operator linked a smart switch to a device
and pressed restart. A KLF-200 gateway wedges after a session is closed with the
house status monitor on (it refuses the next TLS handshake, then ECONNREFUSED,
until it reboots on its own hours later). The operator was power-cycling its
plug with Home Assistant automations, outside CamStack, which knew nothing of
the outage.

Tried first: a "Power switch" setting on the Velux integration. Rejected: the
link already exists as a Customize extension of the gateway device, and a second
copy of it would drift (D676).

## Decision

A device's OWN provider may call `power-source.forceRestart` for its own device
as a bounded self-recovery. Velux is the first. The bounds: only after the device
has been unreachable continuously for 10 minutes; only when
`power-source.getStatus` says `linked`; at most one attempt per 30 minutes, the
time persisted before the call so a respawn keeps it and a refusal counts; never
while a live session exists; never two in flight; the provider does not hand-roll
off, wait, on. A skip is logged once per cooldown window with its reason; every
line carries the integration and device tags. After an accepted restart the
provider waits for the boot, then reconnects with a reset backoff.

## Consequences

Nothing else may call `forceRestart` on its own initiative: a new self-recovery
adds itself to this record. The recovery is a no-op without a linked switch.

## Enforcement

Specs in `packages/addon-provider-velux/src/__tests__/velux-power-recovery.spec.ts`
(threshold, cooldown across a respawn, live session, unlinked, refusal). Review
only for other providers.
