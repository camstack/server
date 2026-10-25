---
id: D188
title: An unregister carries proof that it owns the registration
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/system/src/kernel/capability-registry.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/child-cap-protocol.ts
  - server/backend/src/core/moleculer/moleculer.service.ts
---

## Context

2026-08-20 00:45, during a mass-update of 30 addons. `addon-recorder`'s runner
was replaced. The hub's log says exactly what happened, in order:

```
00:45:03 [hub/recorder] 7 - (CapabilityRegistry) Provider unregistered from capability {capability=recording}
00:45:03 [hub/recorder] 7 - ...                                                        {capability=storage-evictable}
00:45:03 [hub/recorder] 7 - ...                                                        {capability=recording-export}
```

pid 7 is hub-main — the unregister ran in the PARENT, on behalf of a child that
had already died, and it landed *after* the successor had handshaked. The result
was a registry holding nothing for three capabilities while the new recorder
process ran perfectly and kept writing segments. `recording.getAvailability`
answered "Capability recording provider not available" for ~7 hours, the
viewer's timeline was dead, and only a redeploy fixed it.

The mechanism is that **`(capability, addonId)` is not an identity over time**.
`resolveRunnerId` is deterministic, so the replacement runner reconnects as the
same `hub/recorder` node and registers under the same key. Two layers then
treated the successor's state as the predecessor's:

- `LocalChildRegistry.onConnection`'s `channel.onClose` did
  `children.delete(childId)` without checking that the entry it was deleting
  belonged to the channel that closed. The predecessor's socket close evicted
  the LIVE successor and fired `onChildGone`.
- `MoleculerService.removeNodeFromRegistry` then read
  `nodeRegistry.getNodeManifest('hub/recorder')` — which by then was the
  SUCCESSOR's manifest — and unregistered every cap in it.

The ordering that produces this is not exotic and cannot be scheduled away. The
alternative that was considered and rejected is "de-register the old runner
BEFORE the new one registers": it is deterministic, but it opens a window in
which the capability is genuinely absent on every single update — trading a rare
7-hour outage for a frequent short one, on a path (`recording`) where absence is
what a caller sees.

The absence was also silent in a second way: the successor's takeover produced
no log line at all, so nothing in the record said "two generations held this id".

## Decision

**An unregister must present the owner token of the registration it deletes.**

A registration may declare an owner — a `ProviderOwnerToken` naming the
INCARNATION that made it (`hub/recorder#7`, connection-scoped, never derived
from the node id alone). `CapabilityRegistry.unregisterProvider` accepts that
token and, when the registration declared one, deletes only on an exact match:
a different token, or no token at all, is a logged no-op. The same gate exists
one level up, on the node: `removeNodeFromRegistry` refuses a teardown whose
token is not the one currently backing that node id.

Two obligations come with it:

- Whoever can OBSERVE an incarnation must supply it. A UDS child's incarnation
  is its connection (`RegisteredChild.incarnation`), and `LocalChildRegistry`
  ignores the close of a channel that is no longer the one registered under that
  childId.
- A generation that TAKES OVER an unchanged registration must re-stamp it
  (`reassignProviderOwner`). Leaving the dead generation's token on a live
  registration converts this rule into a permanent leak — nothing the live
  process can present would ever match.

Registrations that declare no owner behave exactly as before. That is deliberate:
the token is meaningful only where the key is reused across process generations,
and an in-process builtin's `addonId` is already a unique identity.

## Consequences

- A hub-local child's capabilities are now cleaned up by the UDS `onChildGone`
  path ONLY. Moleculer's `$node.disconnected` cannot observe which incarnation
  died, so it presents no token and is refused against an owned registration.
  This is correct while a child's death always closes its UDS socket — if that
  ever stops being true, an owned registration can outlive its process.
- Remote agent nodes register no owner, so their behaviour is unchanged. They do
  not need one: the hub's broker serialises disconnect-before-reconnect for a
  given nodeID, and an agent aggregates its whole subtree into ONE manifest, so
  a stale agent-child teardown is prevented by the same `LocalChildRegistry`
  fix running inside the agent.
- Two takeover events now log: `local child superseded by a new connection`
  (parent side, at handshake) and `ignoring close of a superseded local child
  connection`. A generation change is never silent again.

## Enforcement

Tests, both of which fail when the guard is removed (verified by deleting each
gate and re-running):

- `packages/system/src/kernel/__tests__/capability-registry-ownership.spec.ts` —
  register gen-2, unregister as gen-1, provider must remain; no
  `capability:provider-unregistered` event; no singleton promotion; ownerless
  registrations unaffected; `reassignProviderOwner` semantics.
- `packages/system/src/kernel/__tests__/transport/local-child-registry.spec.ts`
  — two channels claim the same childId over a real UDS transport; closing the
  predecessor must not evict the successor nor fire `onChildGone`, and closing
  the successor still must.

No static guard: the rule is about a token a call site chooses to pass, which no
lint can see. The hub-side wiring is covered only by type-checking that the
token is threaded through `applyNodeManifest` / `removeNodeFromRegistry`.
