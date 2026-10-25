---
id: D809
title: The client address comes from forwarding headers only through a trusted proxy, and every auth rate limit keys on it — per address and per account
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - server/backend/src/auth/client-address.ts
  - server/backend/src/auth/auth-network-policy.ts
  - server/backend/src/auth/auth-rate-limit.ts
  - server/backend/src/api/core/auth-limits.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/auth/sso-routes.ts
  - server/backend/src/main.ts
  - packages/system/src/auth/cidr.ts
  - packages/types/src/interfaces/addon-routes.ts
  - packages/types/src/capabilities/addon-routes.cap.ts
---

## Context

The Cloudflare tunnel's connector dials the hub on loopback and Fastify's
`trustProxy` is off, so every internet request reached the auth limiters as
`127.0.0.1`. One bucket served the whole internet: ten wrong passwords a minute
from anywhere locked every remote user out of login. Reading
`X-Forwarded-For` naively is the classic opposite hole — any client can send
it. The OIDC start and callback, the SSO finish and `beginExternalLink` had no
limit at all.

## Decision

`resolveClientAddress` reads `CF-Connecting-IP`, then the right-most
`X-Forwarded-For` hop that is not itself a trusted proxy, ONLY when the socket
peer is a trusted proxy: loopback always, plus the CIDRs in
`auth.trustedProxies` (System → Authentication). From any other peer — the LAN
included — the headers are ignored and the peer is the client. Every auth
limit keys on that address:

- per address: credential legs 10/min, ceremony legs 30/min; the SSO finish
  and any public addon route that declares `rateLimit: 'auth'` (the OIDC start
  and callback) 30/min, applied by the hub before the handler;
- per account, on FAILURES only: 20 per 15 min, peeked before the secret is
  checked (password, TOTP, passkey, re-authentication);
- per user: `beginExternalLink` 5/min, `reauthenticate` 10/min.

## Consequences

- A remote attacker spends their own bucket, not everyone's.
- Someone who knows a username can hold that account at its failure limit for
  15 minutes; the owner's successful logins never spend it. Accepted trade.
- A reverse proxy on another host must be listed in `auth.trustedProxies`, or
  its users share its bucket again. An entry that is not an address or CIDR
  refuses the save.
- The `rateLimit` route flag crosses the forked-route bridge; an older hub
  ignores it (the route stays unlimited, as before).

## Enforcement

`client-address.spec.ts` (forged headers from an untrusted peer ignored, LAN
included; right-most untrusted hop; chains), `auth-rate-limit.spec.ts` (two
tunnelled clients get two buckets), `auth-router-rate-limits.spec.ts` (per
address, per account, owner logins never spend it), `sso-routes.spec.ts`,
`child-addon-call-dispatch.spec.ts` (the flag survives the bridge),
`system-config-auth-settings.spec.ts`.
