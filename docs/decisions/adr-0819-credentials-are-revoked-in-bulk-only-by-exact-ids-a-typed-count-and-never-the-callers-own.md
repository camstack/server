---
id: D819
title: Credentials are revoked in bulk only by exact ids, a typed count and one audited call — never by a predicate, never the caller's own
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - server/backend/src/api/core/auth-revoke-credentials.procedures.ts
  - packages/addon-admin-ui/src/components/access/**
  - packages/addon-admin-ui/src/pages/system/Access.tsx
---

## Context

On 2026-10-09 a "Revoke all never used" button was added to Identity → Tokens
(share links and admin tokens). Minutes after it was deployed it deleted every
share link on the hub: 167 `csv_` rows revoked by the operator's session between
09:04:26 and 09:04:27, read from the hub log ("Share token revoked", Loki — the
auth audit trail recorded nothing, share-link revokes were not audited).

The button was a client-side predicate over every user's links — "`lastUsedAt`
absent" — looped one `revokeShareToken` call per row behind a yes/no dialog that
named only a count. "Never used" is not "unused": a link minted a minute ago and
not yet opened by whoever it was sent to is never used, and so is every link of
a grid nobody happened to open. A share-link revoke is a hard delete, so nothing
could be restored. The same toolbar also offered "Revoke all expired" — a second
predicate button.

## Decision

More than one credential is revoked only through `auth.revokeCredentials`
(admin, signed-in session only — no admin token) with the EXACT ids of one kind
(`share-link`, `admin-token`, `login-session`) and the count the operator TYPED
in the confirmation (`confirmCount`). The hub revokes those ids and nothing
else, refuses the whole call when the count does not match or an id repeats,
skips and reports the caller's own current session, ends sessions one by one
(never `revokeAllForUser`, which also moves the user's cutoff), and writes one
`credentials-revoked` audit row (kind, counts, ids). The UI reaches it only
from an explicit selection of rows on screen: filters and "Select expired" /
"Select all N shown" SELECT, they never revoke; the confirmation lists the
rows, breaks them down by status, and needs the number typed. No predicate
action ("never used", "unused", "all expired") exists on any credential list.

## Consequences

- A bulk revoke is one round trip and one audit row instead of N unaudited
  calls; an interrupted one leaves an exact account (`revoked` / `skipped`).
- Kinds whose store has no bulk-safe server path (scoped tokens, linked apps,
  sign-in links, legacy keys) are revoked one at a time until one is added the
  same way.
- An ops script holding an admin token cannot bulk-revoke; it revokes one
  admin token at a time through `revokeAdminToken`, as before.

## Enforcement

`server/backend/src/api/core/__tests__/auth-router-revoke-credentials.spec.ts`
(exact ids only, never-used link survives, count mismatch / duplicates refuse,
current session skipped, cutoff untouched, admin token refused, audited);
`ShareLinks.spec.tsx` and `AdminTokens.spec.tsx` (no "never used" action,
"Select expired" sends only expired ids with the typed count, a selection the
filter hides is not revoked); `LoginSessionsSection.spec.tsx` (the current
session is never selectable).
