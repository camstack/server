---
id: D638
title: A provider's answer passes through the cap route; only a call nobody answered is wrapped as transport-failed
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/system/src/kernel/transport/cap-route-resolver.ts
  - packages/system/src/kernel/transport/socket-channel.ts
  - packages/system/src/kernel/transport/peer-answered-error.ts
last-verified: 2026-09-26
---

## Context

`CapRouteResolver.dispatch` wrapped EVERY throw that was not already a
`CapRouteError` as `CapRouteError{reason:'transport-failed'}`, rendered as
"`<cap>.<method>` not routable to node …". That included a provider refusing by
throwing — its own, deliberate answer.

On 2026-09-25 the operator pressed PTZ Home on Amcrest 3836 and read
`ptz.goHome not routable to node hub/provider-amcrest: transport-failed
(rejected: hub-local-uds=No home preset configured for this camera — set one in
the PTZ settings)`. The call had been routed and answered; the operator was told
the node was unreachable, and the admin UI's `capRouteReason` said the same.
Every cap on the fleet that refuses by throwing had the same wording.

The UDS channel could not tell the two apart: a `res` frame with `ok:false` and
a channel close both rejected with a plain `Error`.

## Decision

An answer is not a routing failure. `SocketChannel` rejects with
`PeerAnsweredError` when the far end ANSWERED `ok:false`; a close, a timeout or
a missing child stays a plain `Error`. `dispatch` propagates unchanged:

- anything thrown on a `hub-in-process` route (there is no transport there);
- any `PeerAnsweredError`.

Everything else is wrapped as `transport-failed`, with the cause, as before.

## Consequences

- The operator reads the provider's own sentence. A `TRPCError` thrown by an
  in-process provider keeps its own tRPC code.
- A routing miss that a CHILD answers (`child-cap-dispatch: no provider …`,
  `method not found`) now arrives as a `PeerAnsweredError`: it loses the
  "to node X (rejected: …)" decoration and `data.capRouteReason`. Message-based
  classifiers (`UDS_NO_ROUTE_PREFIX`, `CAP_METHOD_NOT_IMPLEMENTED`, "no native
  provider for capability", snapshot's "no provider for") match on text that is
  preserved verbatim, so none changes behaviour.
- A `hub-in-process` ref that is itself a transport (a wrapper delegating over
  UDS) now surfaces its `channel closed` raw rather than as `transport-failed`.
- NOT done: `remote-moleculer` and `agent-child-forward` still wrap every error.
  A Moleculer error restored from a remote answer is not yet told apart from a
  local timeout, so a provider on an agent that refuses still reads "not
  routable". That is the next step, not a license to wrap answers.

## Enforcement

`packages/system/src/kernel/__tests__/transport/cap-route-resolver.spec.ts`
(an in-process throw and a UDS `PeerAnsweredError` pass through by identity; a
plain UDS error is wrapped with its cause) and `socket-channel.spec.ts` (an
answered error is a `PeerAnsweredError`; a close is not). Each gate was removed
once and its spec went red.
