---
id: D227
title: The hub reissues its certificate only when it cannot do its job, and rotates the root only for root reasons
status: accepted
date: 2026-08-22
supersedes:
applies-to:
  - packages/system/src/tls/**
---

## Context

Measured against the live hub on 2026-08-22, the certificate `ensureTlsCert`
generates had four defects at once: no `extendedKeyUsage`, a single self-signed
`CA:TRUE` leaf, an 825-day validity, and `fe80::` SANs that can never match
because a link-local address needs a zone index a SAN cannot carry. Apple's
trustd rejects an app-supplied anchor whose leaf has no `id-kp-serverAuth`
(`testAppTrustLeaf_MissingEKU_AfterJul2019` asserts failure), and Conscrypt
skips validation entirely — expiry included — when a self-signed leaf is its own
anchor. So the certificate was unusable by the app *and* validated nothing on
Android, and manual trust was the only thing keeping the hub reachable.

The fifth defect is the one this record is about. `ensureTlsCert` returned early
whenever an unexpired certificate existed. A hub that moved under DHCP, gained
an interface or changed hostname kept a certificate that no longer named its own
address, forever, with nothing saying so.

The naive fix — "regenerate when the SAN set differs from the interface set" —
is worse than the bug. `os.networkInterfaces()` reports docker bridges, VPN
tunnels and SLAAC privacy addresses that rotate roughly daily; a symmetric
difference fires on all of them, and a certificate that changes on every boot
invalidates every trust an operator granted by hand. The first design here was
symmetric and was rejected for exactly that reason.

## Decision

**Reissue when, and only when, the material on disk cannot do its job** — never
because it is old, never because the machine picked up an address the
certificate does not need, never because a new build shipped. The triggers are
absence, unreadability, a key that does not match the certificate, a root that
is absent or inside its renewal window, a leaf inside its 30-day renewal window,
a leaf without `extendedKeyUsage = serverAuth`, a leaf not issued by the root on
disk, a leaf whose validity span exceeds 397 days, and **a name or address the
hub must answer for that is missing from the SAN list**.

That last check is **one-directional**: a missing name is a fault, an extra name
is not. Only a *stable* identity gates it — IPv4 on non-volatile interfaces, the
hostname, the CN, and operator-declared `extraSans`. Addresses on docker/VPN/mesh
interfaces and **every IPv6 address** (global and ULA) are certified but never
gate: `os` cannot tell a permanent address from a temporary one, and on the live
hub the ULA interface-id rotated on every restart, reissuing the leaf under
`san-coverage-gap` eight times in one day (2026-10-03).

**The root rotates only for root-level reasons.** SAN drift reissues the leaf
alone under the existing `camstack-ca.crt`, so trust an operator granted to the
root survives every address change the hub will ever see.

Every trigger is a pure function of (files on disk, machine identity, clock), so
a reissue that clears them clears them for good: the next boot returns
`generated: false`. And a reissue is **never silent** — it is logged at phase 2c
with the old and new fingerprints and whether the root moved, and re-reported
post-boot as a `system.tls-cert-changed` event, which the alerts builtin turns
into a warning in the admin UI.

## Consequences

- `<dataDir>/tls` now holds four files, not two. `camstack.crt` is a **chain**
  (leaf then root); `camstack-ca.crt` is the file an operator installs as
  trusted. Anything that treated `camstack.crt` as a single certificate to pin
  is now pinning the wrong layer — pin the root.
- **Every existing install reissues exactly once**, under reason `no-local-ca`,
  and the root rotates with it. Operators who trusted the old self-signed
  certificate by hand must install `camstack-ca.crt`. This is a one-time cost and
  it is the last one: no future drift rotates the root.
- Recreating the container changes `os.hostname()` and therefore reissues the
  leaf. That is deliberate and cheap now that the root absorbs it.
- A hub reachable **only** over an IPv6 address that changes will not self-heal,
  because no IPv6 address can gate without risking daily reissues. Declare a
  stable one through `extraSans` if it matters.
- The renewal window means the hub reissues 30 days before expiry instead of
  serving a dead certificate until something notices.

## Enforcement

`packages/system/src/tls/__tests__/cert-manager.spec.ts` — one test per defect
(EKU present and narrow, CA→leaf with a verified issuance, ≤397 days, link-local
SANs dropped), plus the two that pin the rule itself: drift reissues, and a
certificate that is a *superset* of the current identity does **not**. The
one-shot property is asserted directly (`replaces a legacy self-signed cert
exactly once`), as is the anchor's survival (`rotates only the leaf on drift`).
Removing the coverage gate turns the drift tests red and leaves the anti-churn
test green — verified on 2026-08-22.
