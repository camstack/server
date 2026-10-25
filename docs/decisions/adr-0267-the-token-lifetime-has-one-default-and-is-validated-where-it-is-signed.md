---
id: D267
title: The session-token lifetime has ONE default, and is validated where it is signed
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/system/src/auth/token-expiry.ts
  - packages/system/src/auth/auth-manager.ts
  - packages/system/src/builtins/local-auth/auth-config-reader.ts
  - packages/system/src/builtins/system-config/system-config.addon.ts
  - packages/types/src/constants.ts
---

## Context

`system-config.tokenExpiry` is a live, editable field in System → Settings →
Authentication. Three defaults disagreed about what it meant:

| where | value |
| --- | --- |
| the schema the operator reads | `30d` |
| `RUNTIME_DEFAULTS['auth.tokenExpiry']` | `7d` |
| `AuthManager.signToken`'s hardcoded fallback | `30d` |

The [settings census](../design/2026-08-28-cluster-settings-census.md) called
the field dead, tracing it to `local-auth`'s config reader, which whitelists
three paths and answers `undefined` for everything else — so *that* AuthManager
always signs the hardcoded `30d`.

Tracing the whole path found the census one construction short and the
conclusion different. `AuthService extends AuthManager`
(`server/backend/src/core/auth/auth.service.ts`) is a SECOND instance, built
with `ConfigService extends ConfigManager`, and it is the one that signs every
session token (`api/core/auth.router.ts`, `main.ts`). `ConfigManager.get`
resolves yaml → `system-settings` → `RUNTIME_DEFAULTS`, so it reaches `7d`
before the hardcoded fallback is ever consulted. The value actually in force on
an untouched hub was **7d**, while every surface an operator could read said
30d. The control was not inert in the way it looked inert; it was inert in a
way that also lied about its own default.

The operator's Save does land where that signer reads: `system-config` is a hub
builtin, so its `ctx.settings` is `ConfigManager.createSettingsView`, whose
`setSection('auth', …)` writes `system-settings` keys `auth.*` — the same
keyspace `ConfigManager.get('auth.tokenExpiry')` resolves. (An agent's
`ctx.settings` is a different view backed by the `sections` collection, which
nothing in the auth path reads. `system-config` being hub-only is what keeps
that from mattering.)

Two further hazards sat behind the field, both reachable by typing in the box.
`jsonwebtoken` THROWS on an `expiresIn` it cannot parse, and the only caller is
the login/refresh path — one typo turns every login into a 500. And it hands a
bare numeric string to `ms()`, which reads it as MILLISECONDS: an operator
typing `3600` meaning "an hour" gets a token that dies in 3.6 seconds.

## Decision

`DEFAULT_TOKEN_EXPIRY` (`@camstack/types`) is the one default. It is `30d` —
the value the product documents and the one an operator decided on — and it is
imported by the schema, by `RUNTIME_DEFAULTS` and by the signer's fallback. No
second spelling of it exists, including inside the parser, which derives its
seconds from the constant rather than restating them.

`AuthManager.signToken` reads the setting on EVERY mint (so a change needs no
restart) and passes it through `parseTokenExpiry` first. Accepted: an
`ms`-style duration string with a mandatory unit, between one minute and one
year. Rejected, loudly and to the default: a bare number, anything unparseable,
anything shorter than a minute, anything longer than a year. A rejection never
resolves to `undefined` and never widens a lifetime. The parser returns
SECONDS, so exactly one parser decides what the operator's text meant and the
`ms` bare-number branch is never entered.

`local-auth`'s reader stays an explicit allow-list — it exists because
`AuthConfigReader.get` is synchronous while `ctx.settings.getSection` is not, so
the list is the set of values that were awaited, not a security boundary that
could be "removed". `auth.tokenExpiry` was added to it as one more pre-resolved
path (`createAuthConfigReader`), so both AuthManager instances agree about the
lifetime.

## Consequences

- **What the operator observes.** A hub that never touched the field moves from
  a 7-day to a 30-day session lifetime; devices reopened after a week stop
  being logged out. Tokens already issued are unaffected — they keep the
  lifetime they were signed with — so nothing is revoked and nothing shortens
  retroactively. An operator who WANTS a shorter lifetime now gets it: setting
  `1h` produces a 1-hour token on the next login or silent refresh.
- A value the field previously accepted silently is now refused: `3600`,
  `1h30m`, `forever`, `30s`, `10y`. Each logs one WARN naming the value and the
  reason, and signs `30d`. Refusals are reported once per distinct bad value
  per process, not once per login — the signer re-reads on every mint and a
  viewer's silent refresh would otherwise flood the log.
- `AuthConfigReader.get` / `UserConfigReader.get` now return `T | undefined`.
  That is what they always did; the type said otherwise.
- Not addressed here: `createServiceToken` still takes its own `expiresIn`
  string and casts it, and agent service tokens remain a fixed 24h.

## Enforcement

- `packages/system/src/auth/__tests__/auth-manager-token-expiry.spec.ts` and
  `token-expiry-end-to-end.spec.ts` assert on `exp - iat` of the SIGNED token,
  never on the call that produced it. The end-to-end spec drives a real
  `ConfigManager` through `createSettingsView('system-config').setSection` —
  the operator's Save — and both AuthManager constructions.
- `token-expiry.spec.ts` pins the grammar, the bounds, and that a rejection
  always resolves to the single default.
- Disarm results: making the signer ignore the configured value turns 10 of 62
  auth tests red; dropping `auth.tokenExpiry` from the reader's allow-list, 2;
  restoring the second `7d` default, 2; removing validation, 10.
