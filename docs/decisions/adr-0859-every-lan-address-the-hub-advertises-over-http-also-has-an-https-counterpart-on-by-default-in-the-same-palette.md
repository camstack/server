---
id: D859
title: Every LAN address the hub advertises over http also has an https counterpart, on by default, in the same palette — there is no separate "secure connection" mechanism
status: accepted
date: 2026-10-16
supersedes:
applies-to:
  - packages/system/src/builtins/local-network/address-book.ts
  - packages/system/src/builtins/local-network/local-network.addon.ts
  - packages/addon-admin-ui/src/pages/system/address-table-model.ts
---

## Context

With the LAN HTTP listener on, the hub advertises each LAN address only as
`http://<ip>:4480` so a native app skips the private certificate (D226 and the
local-access work). That has a cost nobody had to pay while sessions were only
read: the session token, and now the device-certificate pairing (D855), cross
the home WiFi in clear.

A second "secure connection" mechanism was the first idea — a flag, a probe, a
separate list the app consults. The hub already does the one thing that
mechanism would do: it tells the viewer which addresses to try, through the
`local-network` palette the operator manages on the admin **Network** page
(D729, D732, D734), and the viewer already races that list and keeps whatever
answers. A second list would be a second authority on the same fact (D62), and
the operator would have two places to look when a phone "does not connect".

The hub's TLS listener (port 4443 by default) already serves every LAN address
(it is what the hub advertises when LAN HTTP is off), so the counterpart needs
no new listener.

## Decision

For every LAN address (IPv4, IPv6 and the local name) advertised over plain
`http://<host>:<http port>`, the palette carries its HTTPS counterpart
`https://<host>:<tls port>` as its own row, straight after the http one
(`withLanHttpsCounterparts`). It is an ordinary detected row: it appears in the
Network page's Addresses table with the same role boxes as every other row,
**App connections is ticked by default** (a LAN IPv4 row is an automatic app
connection), and unticking it persists in `appConnectionUrls` exactly as for any
address — a disabled counterpart is not advertised. No new page, section,
setting or API.

Only the app-connection palette and the table carry the counterparts. The
palette `internal` and `publicEndpoint` resolve over does not, so every other
role keeps its answer, and `notificationTaps` and the app link are untouched. A
row already on https (LAN HTTP off), the tunnel, the mesh, custom addresses and
loopback have no counterpart. An operator who curated an explicit App
connections list before this change sees the new rows unticked — their list is
theirs; tick them to opt in.

**The advertised palette is the only authority.** The viewer never builds a
counterpart for a hub that did not advertise one on a native client (the toggle
would stop meaning anything); the hosted page's old `secureLanTwin` stays what
it was, a swap for an `https:` page that would otherwise drop the http row.

What a phone does with the new candidate, in the race it already runs
(`candidate-probe.ts`):

- **It trusts the hub's local CA** (the profile is installed and trusted): the
  https candidate answers `/health`. When both addresses of one host answer,
  the https one wins — a tie-break inside the existing race, not a new step —
  so the token no longer crosses the WiFi in clear, and pairing at home has a
  secure route.
- **It does not trust it**: the TLS handshake fails in milliseconds (or the port
  never answers). The candidate is skipped; the plain-http candidate and the
  tunnel carry on exactly as before. The viewer logs the failure once per
  session and candidate (`secure-twin-failed`), with the class `tls-untrusted`
  (the host answers over http but not over https — or the platform says
  certificate/ssl/tls) or `unreachable`.
- **It never delays the connection.** A candidate whose host also answers
  over http (a "secure twin") is probed with at most 800 ms and, once any other
  candidate has answered, is waited for at most 250 ms — only to break the
  tie. Nothing retries it inside a race; the next race is the next race.

## Consequences

- **Security.** Plain HTTP on the LAN carries the session token in clear. The
  HTTPS counterpart protects it only on a device that trusts the hub's local
  CA; a device that does not keeps the old behaviour (HTTP at home, or the
  public URL), silently. The operator who wants no cleartext at home unticks the
  http row of the LAN address (or turns LAN HTTP off) once the phones trust the
  CA.
- **Device-certificate pairing (D855) needs a secure route**: the public HTTPS
  URL or a trusted LAN HTTPS address. A phone without the CA that is on the
  home WiFi but has no public URL has no secure route; that is a limit of the
  pairing, not something this decision hides.
- **Android follow-up (not done here).** An Android app ignores user-installed
  CAs unless its network security config trusts the `user` store. The first
  Android release must either add `<certificates src="user"/>` for the hub
  domains/addresses or pin the hub CA; until then an Android phone behaves as
  "does not trust" even with the CA installed. Recorded as an open item — native
  configuration is deliberately unchanged by this decision.
- **A second row per address** doubles the LAN rows on the Network page, and
  the race probes one more candidate per LAN address. Both are cheap and
  bounded (above).
- The local name's counterpart needs the name in the leaf certificate's SANs;
  the hub already adds it (`writeExtraSans`), a custom certificate without it
  fails TLS name validation and the candidate is skipped like any untrusted one.

## Enforcement

`address-book.spec.ts` (palette: counterpart per LAN row with the TLS port,
default on, toggle persists, off ⇒ not advertised, roles unchanged, no
counterpart for tunnel / mesh / loopback / custom or when LAN HTTP is off),
`AddressesCard.spec.tsx` (the row and its box), and the viewer's
`lan-https-candidates.spec.ts` (native races the advertised https candidate and
never synthesises one; a twin that never answers ends the race one grace after
the first answer; https wins the tie; one `secure-twin-failed` line per
session). Each was disarmed (guard removed, spec red, restored).
