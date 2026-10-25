---
id: D726
title: A node's certificate is set only in the admin UI, and what the UI shows is what the listener serves
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/system/src/tls/boot-tls.ts
  - packages/system/src/tls/https-listener.ts
  - packages/system/src/tls/tls-actions.ts
  - packages/system/src/tls/tls-status.ts
  - server/backend/src/boot/boot-config.ts
---

## Context

A hub had two ways to get a certificate that was not its own generated one
([D227](adr-0227-the-hub-reissues-its-certificate-only-when-it-cannot-do-its-job.md)):
the env pair `CAMSTACK_TLS_CERT` / `CAMSTACK_TLS_KEY` (mapped onto the
`config.yaml` keys `tls.certPath` / `tls.keyPath`, read once at boot and
invisible to the UI), and the upload on **Network → Local access**, which writes
`<dataDir>/tls/camstack.crt` + `camstack.key` and the `tls/mode` marker
`uploaded`. The status cap only ever knew the second one: a node booted from the
env pair reported its generated certificate as the one in use while serving a
different one.

Removing the env pair exposed that the UI path never survived a restart. Boot
ran every certificate through `ensureTlsCert`, and "the leaf is not issued by the
root on disk" is one of D227's reissue triggers — which an operator's upload is
by definition. The first reboot after an upload replaced it with a fresh
generated leaf (reproduced by the spec below). The env pair was the only
non-generated certificate path that survived a restart.

The same day the operator uploaded an mkcert certificate on the live hub, and
the status disagreed with the wire three ways. It said `uploaded` with the new
leaf (`F9:53:16:…`), while `openssl s_client` was still handed the boot-time
generated leaf (`93:EE:EF:…`): no action ever touched the listener — the
"The HTTPS listener reloads" text on Regenerate described code that did not
exist. It said `restartRequired: false`: the actions returned `true`, but the
UI invalidated the query on success and `getTlsStatus` hard-coded `false`, so
the warning lived for one render. And it reported the **local** CA's
fingerprint as the CA of a certificate mkcert had signed, offering it on
Download CA — an upload with a CA also overwrote `camstack-ca.crt` while
leaving the local CA's key beside it.

On 2026-10-06 no node used the env pair: the hub container and the
`agent-a` agent container set no `CAMSTACK_TLS_*` variable, the hub's
`config.yaml` has no `tls` section, and the live status reported `generated`.
The macOS agent could not be inspected over SSH; the desktop app sets neither
variable anywhere in its code.

## Decision

**The admin UI is the one way to set a node's certificate.** Boot reads the
`tls/mode` marker: `uploaded` (with both files present) is served **verbatim**
and never evaluated, let alone reissued; anything else runs D227's generated
path. `CAMSTACK_TLS_CERT`, `CAMSTACK_TLS_KEY`, `tls.certPath` and `tls.keyPath`
are ignored, and a node that still sets any of them logs one WARN at boot naming
them and pointing at Network → Local access. An `uploaded` marker whose files
are gone falls back to the generated certificate, rewrites the marker, and WARNs.

**What the status shows is what a client is served.** Every certificate action
(upload, regenerate, revert, a hostname-driven reissue) ends by putting the pair
on disk on the HTTPS listener with `setSecureContext` — new handshakes get it,
no restart. The server registers its listener once (`registerHttpsListener`, on
`globalThis` so a builtin's separate module instance still finds it), and
`restartRequired` is **measured**: the listener's served leaf differs from the
leaf on disk. In `uploaded` mode the CA is the upload's own issuer — the CA
supplied with it (kept in `tls/uploaded-ca.crt`) or the rest of the uploaded
chain, verified by signature — and `null` when the upload did not include it;
the local CA is never reported, downloaded or overwritten for an upload.

`CAMSTACK_TLS_ENABLED` stays: plain HTTP on the main listener, for a reverse
proxy that terminates TLS, has no UI equivalent (the UI's LAN HTTP setting adds
a second HTTP port next to HTTPS; it does not turn HTTPS off).

## Consequences

- A node that relied on the env pair would come up on its generated
  certificate. None did when this landed; the boot WARN is the migration notice.
- D227's reissue rule applies to the **generated** certificate only. An uploaded
  certificate expires, or stops naming the node, on the operator's schedule —
  the UI shows its fingerprint and validity, and nothing renews it.
- The Unraid templates (maintained outside this repo, D717) and the public
  deploying page drop the two variables.

## Enforcement

`packages/system/src/tls/__tests__/tls-actions.spec.ts` — a real HTTPS server
hands out the uploaded leaf on the next handshake (red with a no-op reload,
verified 2026-10-06), the status says `restartRequired` exactly while the
listener lags the disk, revert restores the ORIGINAL local CA, and a bare leaf,
a chain, a supplied CA and a wrong CA each report the right issuer or none (red
when uploaded mode reads `camstack-ca.crt`, verified 2026-10-06).

`packages/system/src/tls/__tests__/boot-tls.spec.ts` — an upload of a leaf a
foreign root issued is served byte-for-byte across a boot; removing the
`uploaded` branch turns it red (verified 2026-10-06), because `ensureTlsCert`
replaces it. `server/backend/src/boot/__tests__/boot-config-tls.spec.ts` — the
env pair and the YAML keys never reach the parsed config, the boot WARN names
them (red with the WARN removed, verified 2026-10-06), and
`CAMSTACK_TLS_ENABLED=false` still parses to plain HTTP.
