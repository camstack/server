---
id: D873
title: The generated local CA is name-constrained, and an upload not signed by a public CA must bring its CA
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/system/src/tls/cert-name-constraints.ts
  - packages/system/src/tls/cert-issue.ts
  - packages/system/src/tls/cert-manager.ts
  - packages/system/src/tls/cert-evaluation.ts
  - packages/system/src/tls/uploaded-cert.ts
  - packages/system/src/tls/tls-actions.ts
  - packages/system/src/tls/tls-status.ts
  - packages/system/src/tls/agent-https.ts
  - packages/system/src/tls/boot-tls.ts
---

## Context

A phone that installs the hub's CA to trust `https://<hub>:4443` trusts that CA for
**every** site, not just the hub. The CA `ensureTlsCert` generated
([D227](adr-0227-the-hub-reissues-its-certificate-only-when-it-cannot-do-its-job.md))
had no `nameConstraints`, so a leaked `camstack-ca.key` could vouch for a bank. The
same is true of the CA a tool like mkcert makes, and the public guide told people to
install either one.

Two related gaps showed up on the operator's hub the same day. An upload of a
certificate NOT signed by a public CA was accepted without its CA
([D726](adr-0726-a-nodes-certificate-is-set-only-in-the-admin-ui-and-what-the-ui-shows-is-what-the-listener-serves.md)
made the status honest about it): "Download CA" then had nothing to hand out and no
device could be told to trust the hub. And "Revert to generated" **deleted** the
upload (it overwrote `camstack.crt`/`camstack.key` and removed the stored CA), so
switching back cost the operator the material.

## Decision

**The generated CA carries a CRITICAL `nameConstraints` extension** (RFC 5280
4.2.1.10), permitted subtrees only: IP `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `100.64.0.0/10` (CGNAT: Tailscale addresses), `127.0.0.0/8`, `fc00::/7`, `::1/128`; DNS `.local`, `.lan`,
`.home.arpa`, `.internal`, `.localdomain`, `localhost`, plus the hub's own
local-only host names at the moment the CA is created (a single-label OS hostname
has no suffix to sit under). A conforming client must reject a certificate whose
critical extension it does not understand, so the constraint cannot be ignored
silently. The set is built and read in one place, `cert-name-constraints.ts`.

**One stable CA; the leaf follows the machine.** An address or host-name change
re-issues the leaf and never the CA. Because OpenSSL rejects a whole chain when one
SAN falls outside the CA's constraints, `cert-manager` filters the identity through
the constraints read from the CA on disk before it signs AND before it measures SAN
coverage (otherwise a public IPv6 or a CGNAT address would be a permanent
`san-coverage-gap` and reissue the leaf on every boot). Names that are filtered out
are logged at boot and returned as `EnsureTlsResult.droppedNames`. The hub-signed
agent leaves (D856) are filtered the same way, so an agent whose node id is a
single label outside the CA's host-name set is certified by address only.

**One-time replacement of an unconstrained CA, on the normal path.** `ensureTlsCert`
treats "the stored CA has no critical name constraint" as a root-level reason
(`ca-unconstrained`, like `ca-expiring`): it generates the constrained CA once and
issues the leaf under it. It is not a boot purge. The old CA and its key are copied
to `camstack-ca.crt.previous` / `camstack-ca.key.previous` before anything is
replaced and stay on disk until the listener is up on the new leaf, when
`retirePreviousLocalCa` removes them (post-boot). The replacement is written to
`tls/ca-replaced.json`; the status exposes `caReplacedAt` and the admin UI shows, for
30 days, that every device must download and trust the CA again. It reaches the
existing `system.tls-cert-changed` alert with `caRotated: true` and the agents
re-pin through the existing `caRotation` signal. A hub serving an **uploaded**
certificate keeps a dormant generated CA that still signs agent leaves; at boot
`replaceUnconstrainedLocalCa` replaces that CA alone and never touches the served
pair.

**An upload that does not lead to a public CA requires its CA.** `checkUploadedCa`
accepts an upload when (a) a CA is supplied and it parses, is a CA (`CA:TRUE`), is in
date, and actually signed the leaf, or (b) the uploaded chain carries a valid issuer,
or (c) the chain leads to a public root (Node's bundled Mozilla roots). Anything else
is refused before a single file is written, with a translated `userError`
(`tls.ca-required`, `tls.ca-unparsable`, `tls.ca-not-issuer`, `tls.ca-not-a-ca`,
`tls.ca-expired` in the `server` catalog, [D863](adr-0863-settings-texts-and-user-facing-errors-are-translated-by-the-hub-from-catalogs-the-english-text-always-travels-beside-the-key.md)).
The validated issuer is stored in `uploaded-ca.crt`, which is what Download CA serves.
A hub already holding an upload with no CA (the operator's mkcert leaf) reports
`caMissing: true`, and the admin UI says "CA missing - clients cannot download it;
upload the CA".

**"Revert to generated" keeps the upload.** An upload is stored twice: as the served
pair and as `uploaded.crt` / `uploaded.key` (+ `uploaded-ca.crt`). Reverting switches
the mode and regenerates the served pair only; `useStoredUploadedCertificate` serves
the kept upload again (`storedUpload` in the status; a button in Local access). An
upload made before this change is copied aside by the revert itself.

## Consequences

- Every device that trusts the old unconstrained CA must install the new one once;
  the alert, the boot log and the Local access banner say so.
- A name outside the constraints is never in the generated leaf: a public DNS name in
  `extraSans` or a global IPv6 address (Tailscale/CGNAT `100.64.0.0/10` is permitted). A hub that
  needs a public name serves an uploaded certificate (which is what a public name
  needs anyway).
- The cluster mesh is untouched: its CA is a separate EC CA (`mesh-mtls/mesh-ca.ts`,
  key in the keychain), never constrained or replaced here. Only the HTTPS CA and the
  HTTPS leaves of agents (D856) are affected; a single-label node id is not in an
  agent's HTTPS leaf, which is certified by address.
- A hostname the operator sets later is covered only when it sits under a permitted
  suffix; a new single-label hostname is not (the CA is never re-issued for it).
- Two new direct dependencies of `@camstack/system`, `@peculiar/asn1-schema` and
  `@peculiar/asn1-x509`, already in the tree through `@peculiar/x509`, which has no
  name-constraints class.

## Open

- **Verify on a real iPhone (checklist, NOT claimed).** That iOS/macOS trustd honours
  the IP-range constraints of a user-installed root must be confirmed on a device:
  install the new CA on an iPhone against the dev hub .50 first, load
  `https://<.50>:4443` and confirm it is trusted; then confirm a site outside the
  ranges is still validated by the system roots as before. Rolling out to the other
  hubs waits on this.
- Android: apps that opt into user CAs apply the same constraints through the
  platform validator; untested.

## Enforcement

`packages/system/src/tls/__tests__/local-ca-constraints.spec.ts`: the generated CA's
extension is critical with the exact ranges; OpenSSL accepts a permitted leaf and
rejects one outside; a leaf re-issue keeps the CA; an unconstrained CA is replaced
once with the old kept until retired; an upload without a CA is refused for a private
chain and accepted for a public one; CA validation errors; revert keeps the upload.
Removing the extension from `generateCa`, or the refusal in `storeUploadedCertificate`,
turns those specs red.
