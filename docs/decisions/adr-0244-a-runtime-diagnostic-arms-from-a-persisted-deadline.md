---
id: D244
title: A boot-window diagnostic arms from a persisted deadline, never an env var
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - server/backend/src/api/trpc/http-request-census.ts
  - server/backend/src/api/trpc/http-request-census-hook.ts
  - server/backend/src/api/trpc/http-request-census.singleton.ts
  - server/backend/src/api/core/request-census-settings.ts
---

## Context

`deviceManager.listAll` is called **4 960 times in a two-minute hub boot**, ~1 017
rows each — five million rows. `FleetReadCensus`
(`packages/system/src/builtins/device-manager/fleet-read-census.ts`) attributes
the ADDONS correctly (~64 calls in total, because a cap-channel call carries its
origin as data) and can say nothing at all about the other ~4 900: it reads the
local JS stack, and every frame above a call that arrived over the wire is the
same generic dispatcher. Two client-side fixes were made on suspicion — admin-ui
`GlobalSearch`, embed `EmbedGridPage` — and the number went from 4 888 to 4 960.
Guessing did not work, again.

The HTTP layer still holds what the store lost: source IP, `User-Agent`, and the
principal a bearer resolved to. But arming an instrument there ran into the exact
constraint `FleetReadCensus` documents and then gets wrong:

- **An env var cannot be switched off.** `CAMSTACK_FLEET_READ_CENSUS_MS` arms at
  construction because the storm is at boot, and it is right that no action can
  arrive in time. It is also a container recreation away from being changed,
  cannot be disarmed, and the operator has explicitly asked for no more of them.
- **A live-armed action closes before the window it wants.** `StoreReadCensus`'s
  `debug.storeCensus` arms in RAM. Arm it, restart the hub to reproduce the boot
  storm, and the arm is gone with the process — it can only ever measure steady
  state, which is 39/min and not the mystery.

A third failure was avoided rather than made: hooking Fastify's `onRequest` gives
every HTTP request but no principal — the bearer is unvalidated there, so the only
identity available is the raw `Authorization` header, which must never be logged
or keyed on.

## Decision

**A diagnostic whose window is a BOOT arms from a deadline persisted in
`system-settings`, and is read on the request path as a plain in-memory boolean.**
The operator arms through an admin cap method (`system.setRequestCensus`), the
deadline is written as `armedUntilMs`, and `restore()` re-arms the REMAINDER once
at boot, immediately before `app.listen`. Switching off is another call and takes
effect at once. What is stored is a deadline and never a flag, so a census
somebody forgot expires by itself; and the deadline written is the one the census
CLAMPED, so a restore can never outlive the bound.

Counting hangs off the tRPC context factory, not `onRequest`: it is the first
point at which a principal exists and the only one `@trpc/server` calls exactly
once per HTTP request, batched or not. The identity recorded is
`describeTrpcPrincipal(ctx.user)` — a username and a credential KIND — never a
token and never a header.

## Consequences

- The armed check must be a boolean FIELD, not a clock comparison, and it must be
  the first statement of the hook: this sits on a path taking ~41 requests/second
  and a disarmed diagnostic must cost a read and a return. The window therefore
  closes on a timer (generation-stamped, so nothing has to be cleared) rather than
  on a `Date.now()` taken per request.
- The census cannot see a request so malformed that tRPC never builds a context.
  That request never invoked a procedure either, so the totals it is read for are
  unaffected — but the blind spot is real and is written down in the module.
- The census sees the HTTP plane ONLY. The viewer talks to the hub over `wsLink`
  exclusively and the mesh bridge uses `createCaller`; neither is HTTP. The
  snapshot therefore carries `wsConnections` alongside the per-procedure totals,
  so "8 HTTP calls, 37 WebSocket connections opened" reads as a plane being
  excluded rather than as an instrument that was never switched on.
- A settings-store that is down still arms the census, and says so
  (`persisted: false` plus a WARN). Reporting a durable arm that is not durable is
  how a whole boot window gets measured, lost to the restart, and blamed on the
  instrument.

## Enforcement

`server/backend/src/api/trpc/__tests__/http-request-census.spec.ts` pins the
disarmed cost with a request whose every property getter THROWS — moving the
armed check below any field access fails the spec instead of taxing the hub. The
batch rules, the totals under the cardinality bound, and the persisted-deadline
behaviour (`server/backend/src/api/core/__tests__/request-census-settings.spec.ts`)
are each pinned with a stated neutralisation. The admin gate on both cap methods
is pinned through the codegen'd router in
`server/backend/src/__tests__/cap-routers/system-request-census.router.spec.ts`.
No guard script: the rule is about a shape of diagnostic, and there are two in the
repo to compare against.
