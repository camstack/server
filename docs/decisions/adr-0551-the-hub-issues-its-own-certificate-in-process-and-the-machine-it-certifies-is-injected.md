---
id: D551
title: The hub issues its own certificate in-process, and the machine it certifies is injected
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/system/src/tls/cert-issue.ts
  - packages/system/src/tls/cert-identity.ts
  - packages/system/src/tls/cert-manager.ts
---

## Context

`cert-openssl.ts` shelled out to the `openssl` binary three times to build the
hub's local root and its leaf. Eight of the 23 `cert-manager` specs were green
on a developer Mac and red on the self-hosted CI runner (run 35497173489, the
first run in weeks that reached the test step at all), with:

    expected 'not-issued-by-local-ca' to be 'san-coverage-gap'
    expected false to be true
    expected true to be false

The cause, reproduced on the runner itself and then judged by Node 24's
`X509Certificate` on the exact pair it emitted:

| openssl | where | `ca.ca` | `leaf.checkIssued(ca)` |
| --- | --- | --- | --- |
| 3.6.2 (Homebrew) | developer Mac | `true` | `true` |
| 1.1.1f (Ubuntu 20.04) | CI runner `ci-runner` | **`false`** | **`false`** |

OpenSSL 1.1.1's `req -x509 -addext` **adds** to whatever the ambient
`/etc/ssl/openssl.cnf` already contributes through `[req] x509_extensions =
v3_ca`; OpenSSL 3 lets `-addext` override it. So on 1.1.1 the root came out
carrying `basicConstraints` twice and `subjectKeyIdentifier` twice. RFC 5280
§4.2 allows each extension at most once, and OpenSSL 3 — which is what
`node:crypto` is — flags such a certificate invalid. Our own root then read
`ca === false`, `checkIssued()` refused the pair, `evaluateExistingCert`
answered `not-issued-by-local-ca` before it ever reached the SAN check, and
under D227 that means: rotate the root. On every boot. Forever. Voiding every
trust an operator had granted by hand — precisely the disease D227 exists to
prevent, defeated by the generator underneath it.

This is not a CI artefact. It is what any install on OpenSSL 1.1.1 (Ubuntu
20.04, Debian 10, an operator-built image) has always done. The shipped hub
image is Ubuntu 24.04 / OpenSSL 3.0.13 and is unaffected, but this fleet
already runs four implementations — 3.6.2, LibreSSL 3.3.6 (`/usr/bin/openssl`
on macOS, where the Electron agent lives), 3.0.13 and 1.1.1f — and they do not
agree about what our flags mean.

The second half of the same class: `collectCertIdentity` read `os.hostname()`
and `os.networkInterfaces()` directly, so every SAN-drift spec was a statement
about the box running it. A runner that happens to own `10.x.x.x` turns
"regenerates on a SAN coverage gap" green for the wrong reason.

The alternative considered and rejected was to keep openssl and make the
invocation config-proof — pass our own `-config`, self-sign the root through
`x509 -req -signkey` so no config section can contribute. That fixes THIS
divergence and not the class: the next one (LibreSSL's `-extfile` default
section, an OpenSSL 4 change) reintroduces it, and no test here can see it
coming.

## Decision

The hub's TLS material is produced **in-process** — keys from `node:crypto`'s
WebCrypto, DER from `@peculiar/x509` — and `src/tls/**` spawns no process. The
machine being certified arrives as an injected `HostFacts`
(`{ hostname, networkInterfaces }`), defaulting to `systemHostFacts()`, the
way `evaluateExistingCert` already takes `now` instead of reading the clock.
`os` is touched in exactly one function in the whole directory.

The certificate's shape is unchanged: RSA-2048 / SHA-256, a 10-year root with
`CA:TRUE, pathlen:0` + `keyCertSign, cRLSign` + SKID and no EKU, a 397-day leaf
with `CA:FALSE` + `digitalSignature, keyEncipherment` + `serverAuth` + SKID +
AKID + SAN. Only the producer moved.

## Consequences

- `@camstack/system` gains `@peculiar/x509` (already in the lockfile as a
  werift transitive). Vite inlines JS deps, so it costs ~400 kB in the system
  bundle (79 kB gzip) and nothing in the closure.
- The hub no longer needs an `openssl` binary to obtain a TLS identity. The
  Dockerfile still installs one for other reasons; nothing in `tls/` uses it.
- Existing installs are untouched. The material already on disk still parses,
  still matches its key, still carries `serverAuth`, and is still issued by the
  root beside it — `evaluateExistingCert` returns `null` and nothing is
  reissued. An install that HAD been churning on OpenSSL 1.1.1 reissues once
  more, gets a conformant root, and then stops.
- The scratch-directory dance in `regenerate` is gone: every byte now exists in
  memory before anything on disk is touched, and the write is still
  `.new` + `rename`.

## Enforcement

`packages/system/src/tls/__tests__/no-ambient-binary.guard.spec.ts` — no file
under `src/tls/` names `execFile`/`spawn`/`fork` or imports
`node:child_process`. It runs as a test of the package it reads (D548), not as
a `scripts/` guard.

Behaviourally, `cert-manager.spec.ts` issues a full pair with `PATH` pointing
at an empty directory and asserts the pair is valid AND that no extension
appears twice; and it certifies an injected identity that is not this
machine's. Both are red against the openssl generator (`spawn openssl ENOENT`
and `expected undefined to be 'some-other-box.lan'`), verified by restoring it.
