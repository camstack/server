---
id: D592
title: A per-device cap whose mode is `collection` is mounted on the collection dispatcher
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - scripts/generate-cap-mounts.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
---

## Context

An onboard clip played for an instant and stopped. The byte read was refused,
and the refusal came from the wrong addon — twice, with the same file:

- *"…is an analytics visit — a window over recorded footage with no file behind
  it"* (the recorder's videoclips provider), and then, after the addons were
  redeployed in another order,
- *"…was not minted by the HomeKit source"* (export-hap's).

Two different wrong answers to one request is what first-wins resolution looks
like from outside. Naming the provider in the method input (D591) did not
change it, and neither did the top-level `addonId` pin.

The cause is one line in a generator. `device-collection-dispatch.ts` exists
precisely for this — its header says `requireDeviceScoped` "resolves ONE
provider for a device … `getProviderForDevice` on a collection cap returns the
FIRST registered provider, so leaving `videoclips` on it would have answered
every camera from whichever addon booted first". `cap-router-runtime.ts`
branches on `getMode(capName) === 'collection'` and hands those caps to the
collection twin.

**`generate-cap-mounts.ts` never branched.** Every mount it emitted for a
`device-scoped` cap called `requireDeviceScoped`, so for `videoclips` the
runtime's branch was unreachable and the dispatcher — fan-out per source, the
`provider` pin, scalar routing by the source inside the clip id — was dead code
in production. It is the fifth decision found this day that is written
somewhere nothing executes.

## Decision

The generator emits `requireDeviceCollection` for a per-device cap whose
`mode` is `collection`, and `requireDeviceScoped` for every other one. The
mount and the runtime now agree, which is the only way the dispatcher's three
rules reach a caller.

## Consequences

Every `videoclips` call — from the app, from another addon, from the broker —
now resolves through the dispatcher: array methods fan across the device's
sources, a pinned `provider` narrows to one, and a scalar call routes by the
source prefix inside the id it carries. An id no source claims is refused by
name rather than answered by whoever registered first.

This is a server-side change: it is not live until a `@camstack/server`
containing it is installed on the node.

## Enforcement

`videoclips-two-provider-dispatch.spec.ts` already exercised the dispatcher
directly, which is why it stayed green while nothing reached it — a guard on
the MOUNT is what was missing, and the generator is now the single place that
decides. 313 cap-router tests and the 2183-test backend suite pass on the
regenerated mounts.
