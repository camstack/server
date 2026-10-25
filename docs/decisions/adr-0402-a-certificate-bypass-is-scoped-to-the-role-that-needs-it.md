---
id: D402
title: A certificate bypass is scoped to the role that needs it, and a remote hub is trusted by an operator-confirmed pin
status: accepted
date: 2026-09-08
supersedes:
last-verified: 2026-09-09
applies-to:
  - packages/desktop/src/role/cert-trust.ts
  - packages/desktop/src/role/boot-role.ts
  - packages/desktop/src/role/effective-role.ts
  - packages/desktop/src/product/desktop-product.ts
  - packages/desktop/src/setup/render-setup-html.ts
  - packages/desktop/src/setup/render-viewer-setup.ts
  - packages/desktop/src/setup/render-node-setup.ts
---

## Context

`packages/desktop/src/main.ts` appended `ignore-certificate-errors` at module
top, unconditionally, with one comment for justification and no record. It was
correct for what existed: the hub role serves its admin UI over HTTPS with
material it generates itself under `<dataDir>/tls/` (D227), Chromium refuses
`https://localhost:4443` on a chain it does not know, and the switch is the
shortest way past that. The blast radius was the loopback interface — the shell
and the server it accepted a certificate from were the same machine, started by
the same app.

The viewer role breaks that containment. Its window loads
`https://<hub>/viewer/camstack/` from a hub across the LAN, and it carries the
hub's session cookie, every snapshot and every live stream. A process-wide
"accept any certificate" there means any host on the path can present any
certificate and the shell takes it — the whole transport security of a camera
system, traded for a convenience that was only ever about localhost.

The switch also cannot be narrowed by branching later: it is a Chromium
command-line switch that must be appended before `app.whenReady`, and it
*pre-empts* both `app.on('certificate-error')` and
`session.setCertificateVerifyProc` — with the switch on, a verify proc never
sees a failure to adjudicate. So a viewer that inherited it could not implement
any policy of its own, whatever code it ran.

The obvious fix — install the hub's root CA in the OS trust store — is the
strongest one and D227 designed the root for it, but it is a manual,
per-OS, admin-privileged step and the file lives on the hub. `localNetwork.downloadCa`
cannot bootstrap it either: it is reachable only *over* the connection being
validated.

## Decision

The `ignore-certificate-errors` switch is appended only for the roles whose
certificate is on loopback — `hub` and `agent`. The role is therefore read
synchronously from the store file at module top (`readBootRoleSync`; a
corrupt/absent file reads as `hub`, so the switch keeps being appended exactly
as before in every pre-existing situation). The viewer role appends nothing and
decides trust per session partition in `decideCertificateTrust`, in this order:
Chromium's own `net::OK` is accepted; otherwise the issuer's SHA-256 fingerprint
must equal the fingerprint pinned for that hub; anything else is REJECTED. No
pin and a mismatch are different refusals: no pin is trust-on-first-use and the
shell shows the fingerprint for the operator to compare against the hub's admin
UI (*Network → Local access certificate*) before confirming, while a mismatch
against an existing pin is never offered one-click acceptance — re-pinning means
removing the hub entry.

## Amended 2026-09-09 — retired, then restored on the measurement

Slice 2's reduced product was retired and restored the same afternoon. Both
moves are recorded because the second one is the lesson.

**Retired**, on the argument that ONE binary already carries all three roles —
which is what the setup window's hub / agent / viewer picker is for — so the
second product bought download size and nothing else. Installing the hub app and
picking `viewer` gives identical behaviour, certificate policy included, because
that policy is scoped by ROLE and not by build.

**Restored**, when both artifacts were finally built and measured:

| | DMG | installed |
| --- | --- | --- |
| viewer | **113 MB** | the app only |
| hub | **508 MB** | plus 1.1 GB staged closure and a 116 MB Node runtime |

The closure is `npm install --omit=dev @camstack/server`: every `addon-*`
transitively, `addon-pipeline`'s python/wasm/swift assets, the native prebuilds
(node-av, sharp, better-sqlite3) and the admin UI's monaco / module-federation.
It is not waste to be trimmed — it is what a hub node genuinely weighs. Which
makes the split worth a factor of 4.5 on the download and **more than a gigabyte
on disk**, for a machine whose entire job is to render a web page served by a
hub.

**The mistake worth keeping:** the retirement was decided on the capability
argument, and the numbers arrived immediately after it. The argument was sound
and the conclusion was wrong, because the question was never "can one binary do
this" — it was always "what does it cost the person who only watches". When the
whole decision is a magnitude, measure before deciding.

Kept regardless, and found only while building the reduced product: the closure
was being packed **twice** — once staged into `Resources/node_modules` where the
starter loads it, once bundled into `app.asar` by electron-builder's
production-dependency rule. Removing the second copy took `app.asar` from 362 MB
to 3.6 MB in BOTH products, and
`scripts/check-viewer-build-carries-no-server.ts` keeps it out of both.

## Amended 2026-09-09 — the role is the PRODUCT, and the switch is gated on the product first

Two products shipping one setup window that offers all three roles was the
visible half of the contradiction: the 508 MB build offered `viewer`, a role for
which the operator had just downloaded 1.1 GB of closure they would never run,
and the 113 MB build offered `hub` and `agent`, two roles it physically cannot
run. The window now differs by build:

- the NODE product offers **hub and agent only**;
- the VIEWER product offers **no picker at all** — one field, the hub address,
  and a confirm. `Change hub…` reopens exactly that form.

**Which product this is** is read from `app.getName()`, once, in `main.ts`, and
resolved by `resolveDesktopProduct`. `electron-builder.viewer.json` writes
`extraMetadata.name`/`productName` into the packaged `package.json`, which is
the file Electron derives `getName()` from — so the name IS the build config,
with no second file to read and no fs access, and it is readable *before*
`app.whenReady`, which the switch decision requires. The match is POSITIVE on
the reduced product's two spellings; every other name is the node product, so an
unrecognised name falls to the build whose posture is the pre-existing one.
An UNPACKAGED run (`npm run dev`) has no such metadata and is the **node**
product; `CAMSTACK_DESKTOP_PRODUCT=viewer` overrides that in development only —
never in a packaged app, where an environment variable must not be able to give
a viewer install the certificate switch.

**The switch composition.** The product is now the outer gate, ahead of the
store: `readBootRoleSync(userDataDir, product)` returns `viewer` for the viewer
product *without reading the file at all*, so a leftover hub store, a corrupt
one, an absent one and `parseRoleSetting`'s "anything unknown → hub" fallback
are all incapable of putting `ignore-certificate-errors` back into a viewer
process. That is one composition point, not a check scattered over call sites.
Symmetrically, `roleForProduct` coerces the node product's retired `viewer`
store value to `hub`, so that build never runs a role its own UI cannot express
— one tray, one window, one posture.

That coercion re-arms the switch for such an install, which is safe **only**
because `isRoleRetiredByProduct` sends it back to the setup window before any
window loads a remote origin: the operator picks hub or agent, and nothing
LAN-facing loads in the meantime. The two must stay together; separating them
would produce exactly the D402 hazard — a shell pointed at a LAN hub with
certificate verification off.

Hostile cases carry their own assertions (`effective-role.test.ts`): viewer
product + hub store, + agent store, + corrupt store, + no store, + a store file
that cannot even be opened; node product + `viewer` in the store. The gate was
removed and all seven confirmed red before restoring it.

## Consequences

- The viewer's first connection to a self-signed hub is a page, not a stream.
  That is the honest cost of TOFU and it is stated as such in the UI: the
  out-of-band fingerprint comparison IS the security this provides.
- A pin must not churn, or the operator learns to click past the page. D227
  guarantees it: the root survives SAN drift and DHCP moves, only the leaf is
  reissued. If that ever stops being true, this record is what breaks.
- Trust is per hub and per partition (`persist:hub-<id>`). Two hubs never share
  a pin or a cookie jar.
- Nothing changes for a hub or agent INSTALL of the node product: same switch,
  same moment, same behaviour. A node install that had chosen `viewer` is the
  one exception — it is asked to pick again on next launch.
- The only new failure mode is a store file that cannot be read the way
  `electron-store` reads it — hence `parseBootRole`'s spec, and the mismatch
  warning logged in `whenReady` when the file-read role and the store-read role
  disagree.
- Whether `setCertificateVerifyProc` is effective in a process where the switch
  WAS appended for another role is untested and unrelied-upon: one process runs
  one role. Anyone who later runs several roles in one process must verify it
  first.

## Enforcement

Unit specs on `decideCertificateTrust` (accept-on-OS-trust, accept-on-pin,
reject-no-pin, reject-on-mismatch) and on `shouldIgnoreCertificateErrors` /
`parseBootRole`, plus `resolveDesktopProduct`, `roleForProduct` and the
product+store composition exercised end to end from the bytes on disk
(`effective-role.test.ts`), and the per-product setup window
(`render-setup-html.test.ts`, which keeps asserting that the viewer form names
no secret and promises no discovery). Each guard was removed in turn and the
matching spec confirmed to go red before restoring it. Beyond that: review only — nothing today stops a
future edit from moving the `appendSwitch` call back above the role check, which
would be silent. A guard asserting the switch is appended only inside a
`shouldIgnoreCertificateErrors` branch would be worth adding if this file grows
another certificate path.
