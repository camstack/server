---
id: D814
title: A login made directly from an operator-listed trusted network may skip the second factor — never through a proxy, always audited
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - server/backend/src/auth/auth-network-policy.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/auth/sso-routes.ts
  - packages/system/src/builtins/system-config/system-config.addon.ts
  - packages/system/src/kernel/system-settings-policy.ts
---

## Context

The operator asked for an opt-in: on the home network, a password should be
enough. Done carelessly this is a bypass from the internet — the tunnel makes
every request look local, and anyone can send a forwarding header naming a LAN
address.

## Decision

`auth.trustedNetworks` (System → Authentication) lists CIDRs; empty, the
default, is off. A password login, a passkey-first login or an SSO finish
skips the second factors it would owe when the real client address (D809) is
inside a listed network AND the request came directly from it — its socket
peer is not a trusted proxy. Anything through the Cloudflare tunnel, the
public origin or a reverse proxy, loopback included, never qualifies, whatever
its headers claim. Every skip is written to the auth audit log first; a skip
that cannot be audited does not happen. The settings form shows a danger
notice above the field.

## Consequences

- Anyone on a listed network with a user's password gets in — a compromised
  camera or a guest device included. That is the operator's choice, stated on
  the form; keep the list to one trusted VLAN.
- `second-factor-skipped` rows say who, from where, and which factors.

## Enforcement

`auth-network-policy.spec.ts` (off by default; never via the tunnel, a LAN
proxy, loopback, or a forged header; fails closed on an unreadable setting),
`auth-router-trusted-network.spec.ts` (direct LAN skips and audits; tunnel and
forged header do not), the trusted-network cases in `sso-finish.spec.ts`,
`system-config-auth-settings.spec.ts`.
