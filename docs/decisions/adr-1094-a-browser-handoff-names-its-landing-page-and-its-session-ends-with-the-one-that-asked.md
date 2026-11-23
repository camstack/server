---
id: D1094
title: A browser handoff names its landing page, and the session it opens ends with the one that asked
status: accepted
date: 2026-11-23
supersedes:
applies-to:
  - server/backend/src/auth/native-return.ts
  - server/backend/src/auth/sso-routes.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/api/core/auth-sessions.procedures.ts
  - server/backend/src/core/auth/handoff-code.service.ts
---

## Context

Amends D801. A browser handoff (`auth.createBrowserHandoff`, redeemed at
`/api/auth/browser-handoff`) landed on the account page and nowhere else: "the
route takes no destination". The viewer's app switcher needs the same one-time
mechanism to open the Admin UI inside the app, signed in, on a phone — where a
session cannot be shared the way the hub-served web viewer shares its cookie.

Two ways to get there were rejected. A second route that lands on the admin
root would duplicate the redeem, the rate limits and the "never a token in a log"
rule. Letting the caller pass any `next` path would turn the handoff into an
open landing-page selector.

The other half: the session a handoff opens is a login session of its own
(`new-session`). Signing out of the viewer ended only the viewer's, so an Admin
session opened from it stayed alive for its whole expiry.

## Decision

`createBrowserHandoff` takes an optional `destination`, `account` (default) or
`admin`, and no other value exists; the redeem route reads the same closed
enum from its query (anything else is `account`). `admin` lands on the admin UI
root, with the session in the fragment exactly as before — the URL carries a
code, never a token.

The code remembers the login session that minted it. When the redeem opens a
session, `HandoffCodeService` ties it to that parent, and `auth.logout` of the
parent revokes the children it opened. The tie is in memory, like the codes: a
hub restart forgets it and the child then lives out its own expiry.

## Consequences

Signing out of the viewer ends its Admin sessions on the hub. `logout
everywhere` already ended everything. A new destination is a new enum member
and a spec, never a path from the caller.

## Enforcement

`native-return.spec.ts` (location per destination, closed enum),
`auth-router-native-link.spec.ts` (the minted path names only a code and the
destination), `auth-router-sessions.spec.ts` (logout revokes the child, and
only the child).
