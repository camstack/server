---
id: D627
title: A method declared optionalMethod refuses by NAME across a process boundary
status: accepted
date: 2026-09-24
applies-to:
  - packages/system/src/kernel/moleculer/child-cap-dispatch.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
  - scripts/generate-collection-array-methods.ts
---

## Context

`providerOptional` was a TYPE-only flag. It made a method optional on
`InferProvider` and nothing read it at runtime, so a source that honestly does
not serve one produced `INTERNAL_SERVER_ERROR` — the same signature as a method
somebody forgot. Measured on the live hub: `videoclips.getPlaybackOptions` at
the recorder's `analytics` source, a time WINDOW with no file behind it, threw
on every player open over our own clips.

The hub already HAD the named refusal, in `callSource`:

```ts
if (typeof fn !== 'function') throw new TRPCError({ code: 'NOT_IMPLEMENTED', … })
```

and it is **vacuous across a process boundary**. A forked provider reaches the
hub as a UDS proxy that fabricates a callable for every property, so the check
always passes, the call crosses, and the absence is only observable on the
child. The dispatcher's own deps comment says exactly this — but only for
collection LIST methods, which degrade to `[]`. A non-array optional method fell
through to a generic throw.

## Decision

The CHILD says it, with a stable prefixed token
(`CAP_METHOD_NOT_IMPLEMENTED`), and the hub turns that into the SAME
`NOT_IMPLEMENTED` its in-process arm produces — through one message builder, so
the two paths cannot describe one fact differently.

The predicate is a generated, schema-free table (`PROVIDER_OPTIONAL_METHODS`),
emitted by the same generator as `COLLECTION_ARRAY_METHODS`, so a forked runner
never imports the schema barrel — ~144 MB RSS per runner ([D28](adr-0028.md)).

## Consequences

An honest absence and a typo now have different signatures, which is the whole
point: a refusal vocabulary that cannot tell them apart teaches the next reader
to ignore both. Four methods are affected today, all on `videoclips`, so the
500 had four ways to arrive rather than one.

A token crossing a boundary as a plain message is a weaker contract than an
error class, and it is the only one available: the UDS transport carries
messages, not prototypes.

## Enforcement

`child-cap-dispatch.spec.ts` pins both arms — the named refusal and the typo
still reading as a bug. `videoclips-two-provider-dispatch.spec.ts` pins the
hub-side translation through the real router with a provider that throws the
token, which is the shape a forked provider actually presents. Disarming any of
the three (the child branch, calling every method optional, dropping the hub's
translation) fails exactly one of them.
