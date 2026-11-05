---
id: D1010
title: The Amazon sign-in and renewal are in-house — the Alexa addon runs no sign-in library
status: accepted
date: 2026-11-05
supersedes:
applies-to:
  - packages/addon-import-alexa/src/amazon-auth/**
  - packages/addon-import-alexa/src/alexa-proxy-login-manager.ts
  - packages/addon-import-alexa/src/alexa-remote-client.ts
---

## Context

D955 kept `alexa-cookie2`'s own proxy running on loopback and put the hub login proxy in front of
it. That meant a patched third-party library, a loopback port, URL rewriting both ways, a
"wait for the cookie event" timeout (`exchange_failed` on a hung step) and a session file
beside the record that the library's own timer kept rewriting. Every Amazon change broke
the chain at a place we did not own.

## Decision

The hub login proxy dials Amazon's hosts directly (`serverCookieJar`). `src/amazon-auth/`
holds the whole flow: the OAuth sign-in URL (PKCE), the verdict on each page (done only on
`/ap/maplanding` with the code), device registration, token exchange, cookie exchange and the
registration blob (exactly the `dataVersion` 2 shape alexa-remote2 stores). The remote client
starts alexa-remote2 with `cookieRefreshInterval: 0` and its own renewal (every 4 days, once
per dead-session call, and before init when the token is older than 24 h). The
secret `cookie` field of the broker record is the only place the registration lives; the old
session file is moved into it once and deleted. `alexa-cookie2` is not a dependency; it stays
in the lockfile only as alexa-remote2's transitive dependency and is never loaded.

Code, cookies and tokens are never logged: only parameter names. The request shapes are adapted
from `alexa-cookie2` (MIT); `assets/alexa-cookie2.LICENSE.md` carries its notice.

## Consequences

Amazon changes are ours to follow. The loopback port setting is gone. Existing brokers need no
re-login (the stored blob is the same shape). The hub jar cannot be seeded with cookies, so
`frc` and `map-md` travel in the registration body and the login cookie only.

## Enforcement

`no-alexa-cookie2.spec.ts` (no import, no dependency); the remote-client spec fails if the
library timer returns or a transient failure is read as a sign-in problem.
