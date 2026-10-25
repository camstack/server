---
id: D240
title: An internal cap floors its unannotated methods to admin
status: accepted
date: 2026-08-26
supersedes:
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/cap-router-predicates.ts
  - packages/system/src/kernel/cap-router-builder.ts
  - scripts/generate-cap-routers.ts
  - scripts/gen-api-reference.ts
  - scripts/check-method-tiers.ts
---

## Context

`CapabilityDefinition.internal` documents that a cap's methods are for
in-process (`ctx.api`) consumption only — decoders, providers, pipeline steps,
things no browser client is meant to reach. Nothing enforced that. `internal`
does not gate the mount: `resolveCapMount` (`capability-definition.ts`) never
reads the field, so an `internal` cap still got a full tRPC router. And a
method that omitted an explicit `auth` used to default — permanently, at
`method()`-call time — to `'protected'`, reachable by ANY authenticated
session, regardless of `internal`.

A declaration nothing enforces is not a rule. It cost a real privilege
escalation. `ssoBridge.signBridgeToken` mints an HMAC-signed token from
CALLER-SUPPLIED claims, including `isAdmin`; the token is redeemed at
`/api/auth/sso/finish` to mint a session. Its cap is `internal: true` — meant
for `oauth-grants.ts`, `main.ts` registration and the OIDC/magic-link addons,
all of which call it via `ctx.api`. The method's `auth` was unset, so it
defaulted to `'protected'` and was reachable on the AppRouter by any
authenticated (non-admin) session: mint a token with `isAdmin: true`, redeem
it, become admin. An audit of the 22 `internal: true` caps found this pattern
on **45 procedures across 13 caps** — every one closed by adding an explicit
`auth: 'admin'` annotation and shipping `@camstack/server@1.2.170`.

That closed the exposure that existed TODAY. It did nothing for the next cap.
A new `internal` cap, or a new method on an existing one, that omits `auth`
reproduces the exact same hole — nothing in the type system or the build
stopped it before, and reviewing 45 procedures by hand once is not a process
that scales to catching number 46.

Two designs were considered and rejected:

- **Hard `mount: 'skip'` for every `internal` cap.** Simpler, but wrong: it
  would also override a cap that DELIBERATELY left a method
  `'public'`/`'protected'` (a login-ceremony call, a viewer static-asset
  lookup) — the `mount: 'skip'` family (`login-method`, `auth-provider`,
  `log-destination`, `addon-routes`) is already a hand-picked set for exactly
  that reason, made by explicit choice per cap, not by a blanket rule keyed on
  `internal`.
- **Forcing `admin` on every `internal` cap's method unconditionally**,
  ignoring what the author wrote. Rejected for the same reason, more directly:
  `viewer-ui` and `admin-ui` are `internal` AND legitimately called by
  non-admin sessions in some paths; a blanket override cannot tell "unset" from
  "deliberately public".

## Decision

`resolveMethodAuth(def, method)` (`cap-router-predicates.ts`) is the single
place that resolves a method's effective auth tier. The rule: if the method
has NO explicit `auth`, the floor is `'admin'` when the enclosing cap is
`internal: true`, else `'protected'` (the prior default). An EXPLICIT `auth`
on the method — `'public'`, `'protected'`, or `'admin'` — always wins over the
floor; the author already made a deliberate choice, and an annotation that
happens to agree with the floor is documentation, not redundancy.

For this to work, `method()` (`capability-definition.ts`) had to stop baking
`'protected'` in at definition time — it now leaves `auth` UNSET when the
caller omits it, so "was this explicit" survives as real information all the
way to `resolveMethodAuth`. `CapabilityMethodSchema.auth` changed from
required to optional to carry that.

Every site that used to compute an effective auth tier from `.auth` — the
runtime cap-router builder (`cap-router-builder.ts`), the router codegen
(`generate-cap-routers.ts`), and the API-reference generator
(`gen-api-reference.ts`) — now calls `resolveMethodAuth` instead of
re-implementing `?? 'protected'` locally. That is deliberate: this repo has
shipped the runtime and the codegen disagreeing on the same decision before
(`resolveCapMount` exists for exactly that reason, on the mount question), and
a floor computed two different ways is not a floor.

## Consequences

An `internal` cap author no longer needs to remember to annotate every
method — an omission now fails CLOSED (`admin`) instead of failing open
(`protected`). A method that genuinely needs non-admin reachability (a
pre-auth login-ceremony call, a viewer static-asset lookup habitually reached
by non-admin sessions) MUST set `auth` explicitly; the floor does not know the
difference between "forgot" and "chose", so the choice has to be recorded.

The 45 explicit `auth: 'admin'` annotations already shipped are now
redundant — the floor would produce the same result if they were removed —
and stay in place anyway. Removing them would read as "these methods were
never considered," which is false; the annotation is the record that they
were.

Regenerating the codegen after this change touched exactly 4 caps' auth
tier in the generated (type-only) router file and the API reference doc:
`addon-routes`, `auth-provider`, `log-destination`, `login-method` — all four
`mount: { kind: 'skip' }`, so none of them is actually reachable over tRPC
either before or after. Every OTHER `internal` cap's methods were already
explicitly annotated by the prior pass, so the floor changed nothing
observable for any currently-mounted cap. That is the expected shape of a
systemic fix landing after the instance-level fix: it should find little left
to change, and prevent the next one.

## Enforcement

`packages/types/src/capabilities/__tests__/cap-router-predicates.spec.ts`
(`resolveMethodAuth` describe block) pins the floor logic directly: an
`internal` cap's unannotated method resolves to `admin`; an explicit `auth` of
any value is preserved; a non-`internal` cap is unaffected.
`packages/system/src/kernel/__tests__/cap-router-internal-auth-floor.spec.ts`
drives the same assertion through the real runtime router builder
(`buildOneCapRouter`), so the floor is proven at the layer that actually picks
`publicProcedure`/`protectedProcedure`/`adminProcedure`, not only at the
predicate.

`scripts/check-method-tiers.ts` (already wired into
`.github/workflows/ci.yml`'s repository-guards step) pins every cap method's
EFFECTIVE auth tier — computed through `resolveMethodAuth`, not a locally
re-implemented default — into `scripts/method-tier-baseline.json`, and fails
on ANY drift from that baseline: a tier that widens, narrows, appears, or
disappears. A new `internal` cap whose method is left unannotated now bakes
`admin` into the baseline the first time someone runs `--update`, and the
`--update` diff is the artefact a reviewer reads — "NEW methods" / "WIDENED"
call out exactly the lines that deserve a second look. Before this record the
guard computed its own `?? 'protected'` fallback independently of the runtime
builder and the codegen — the same "two places decide the same thing"
disagreement risk this record's Decision section calls out — and its
baseline had silently gone stale since the 45-procedure fix
landed without a `--update`, so it was pinning `'protected'` for methods the
live cap defs already declared `'admin'`. Both are fixed in the same pass:
`check-method-tiers.ts` now calls `resolveMethodAuth`, and the baseline was
regenerated against the current, correct cap surface.
