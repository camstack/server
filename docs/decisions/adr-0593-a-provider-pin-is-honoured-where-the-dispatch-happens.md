---
id: D593
title: A provider pin is honoured where the dispatch happens, and a resolution that refuses reaches the caller
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - packages/addon-pipeline/src/stream-broker/addon.ts
---

## Context

`videoclips` is a `collection` cap with three providers on this hub —
`recorder`, `provider-reolink`, `export-hap`. D554 made naming one REQUIRED and
D552 settled what an unanswerable pin does: it is refused by name, never served
by a sibling. Both rules were implemented in `pinnedProvider`
(`device-collection-dispatch.ts`), which the hub's tRPC mount calls, and D592
fixed the mount so a collection cap resolves through it at all.

Measured against the live hub on 2026-09-22, that path is correct: the
operator's own clip id, pinned to `provider-reolink`, returned 459 157 bytes;
pinned to `recorder` it produced the recorder's named refusal; an id nobody
claims produced `catalog-miss`.

The operator's clip still would not play. The broker's log said why:

```
clip playback: byte fetch failed
  provider: "provider-reolink"
  error:    "…was not minted by the HomeKit source"
```

The pin was travelling and being ignored, because **the call never reached that
mount.** The stream-broker runs in its own runner, so
`ctx.api.videoclips.readClipBytes` leaves the process over Moleculer;
`findServiceCandidates` returns every service exposing the action, and the
dispatch took `candidates[0]` — the broker's discovery order. Three providers
register that action, so the same tap was answered by the recorder ("an
analytics visit … has no file behind it") and, after a redeploy in a different
order, by export-hap ("was not minted by the HomeKit source"). The same clip,
two different wrong answers: the signature of a first-wins resolution seen from
outside.

What was tried first and did not work: naming the provider a SECOND time, as a
top-level `addonId`, on the theory that the collection pin was a different
field from the method's parameter. Nothing on this path read either field. This
repo's recurring failure — a decision written where nothing executes it — for
the sixth time in two days.

A second fault was found in the same place. The resolution step ran inside a
bare `void (async () => …)()`: a throw from it escaped the observable, became
an unhandled rejection, and the caller's `.query(...)` never settled. The two
refusal tests did not fail, they **timed out at 10 s** — a refusal was
indistinguishable from a hang.

## Decision

A provider pin is honoured **where the dispatch happens**, not only at the hub
mount. `narrowToPinnedProvider` narrows the discovered candidates to the
service the caller named (Moleculer service names map 1:1 to addon ids), and a
pin no candidate answers is **refused by name, listing the candidates** — the
transport twin of `pinnedProvider`. The provider pin picks the SERVICE; a node
pin then picks the host among that service's nodes, in that order, because a
pin is not a node.

It applies only when the choice is AMBIGUOUS — two or more distinct candidate
services. With one there is nothing to choose, and `provider` is an ordinary
parameter name on caps that have a single implementation, so an unmatched
string there must not become a routing failure.

**Unpinned calls are deliberately unchanged.** 44 capabilities on this hub have
more than one provider row; "which provider should an unpinned cross-process
collection call reach" is a separate question from "was the pin honoured", and
answering it here would change 44 capabilities at once.

And a resolution that refuses reaches the caller: the resolve step is wrapped
and its failure is delivered through `observer.error`, so a refusal is a
rejection and never a hang.

## Consequences

- One spelling for the pin on both paths: `PROVIDER_PIN_FIELD` is `provider` at
  the transport exactly as it is at the mount. A pin with two spellings is a
  pin only half the system honours, which is what this record is about.
- A caller that names a provider now gets an error instead of a stranger's
  answer. That is the point, and it is a behaviour change for any caller that
  was relying on a wrong answer without noticing.
- The dead `addonId` field is gone from the broker's byte read. A leftover that
  describes the right design reads as verification and is worse than nothing.
- Every other resolution failure — a bad service map, a discovery deadline —
  now rejects the caller instead of hanging it. Callers that swallowed a hang
  will start seeing an error.
- Still open, and NOT decided here: an unpinned cross-process call to a
  multi-provider collection cap is still answered positionally. It should
  probably refuse too, but not before each of the 44 is looked at.
- **Shipping.** This code is NOT bundled into a self-contained addon — the
  addon dist names `brokerTransportLink` only in a comment and imports
  `@camstack/system/addon-utils` as an external. The transport link runs from
  `/opt/camstack-hub/node_modules/@camstack/system`, inside the
  `@camstack/server` closure, so the fix goes live on a SERVER INSTALL and a
  `camstack deploy` of the addon does nothing for it.

## Enforcement

`packages/system/src/kernel/__tests__/moleculer/trpc-links-provider-pin.spec.ts`
— six cases over a real `ServiceBroker` with three services registering the
same action: the named provider answers though it is not first; an unmatched
pin is refused and the candidates are named; a single candidate is left alone;
the node pin composes. Removing `narrowToPinnedProvider` turns four of them red
and the first returns `answeredBy: 'recorder'`, which is the operator's bug
verbatim.
