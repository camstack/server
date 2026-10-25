---
id: D226
title: The hub declares the port it listens on — a client never invents it
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/types/src/capabilities/local-network.cap.ts
  - packages/system/src/builtins/local-network/**
---

## Context

`localNetwork.getConnectionEndpoints` took `port: number` from the caller and
echoed it onto every LAN and loopback base URL it advertised. The hub applied a
number it never checked against the socket it had actually bound.

Clients therefore had to guess. The viewer derives the port from the URL the
operator configured, and an operator who typed a bare public hostname
(`https://camstack.example.top`) gives it nothing to derive from — so it inferred
443 from the scheme, asked with 443, and the hub answered
`https://192.168.x.x:443` for a hub listening on 4443. Measured on the operator's
device: `{"url":"https://192.168.x.x:443","ok":false,"ms":6,"error":"Could not
connect","channel":"lan"}`.

The failure is worse than a dead candidate. A candidate that loses a race reads
in the log exactly like a LAN that was tried and was slower, so nothing pointed
at the port. An operator sitting on his own WiFi ran on the public tunnel for
weeks with the LAN candidate born dead on every connect.

The first fix was client-side and deliberately partial: the viewer DROPS
candidates whose port it had to infer, and logs the drop, because a client that
invents a better guess becomes a second authority on the hub's socket — and a
second authority that disagrees with the first is worse than none (D62). That
made the failure visible without making the LAN work.

## Decision

The hub resolves its own listen port — `server.port` from the live config
section, then `CAMSTACK_PORT`, then the caller's hint, then the boot default —
and builds every LAN/loopback URL from it. `port` in the input is optional and
carries no authority: it is a legacy hint, used only when the hub cannot read
its own configuration. The result reports `localPort: { port, source }`, and
`source` names which of those four places the number came from.

The provenance is returned, not just applied, because "the URL is right" and
"the client can know the URL is right" are different properties. A client seeing
only a corrected URL cannot tell a hub that fixed the port from one that echoed
what it sent, so it cannot decide whether to race the candidate or discard it.
With `source`, anything but `caller-hint` is the hub's own socket.

## Consequences

Both directions of the version skew stay honest:

- **Old client, new hub** — keeps sending `port`, which is now ignored in favour
  of the truth. A client that used to receive a dead `:443` LAN URL now receives
  the live one; a client that already sent the right port sees no change. The
  extra `localPort` field is ignored by clients that do not read it.
- **New client, old hub** — `localPort` is absent. Absent means the same thing as
  `caller-hint`: the URLs were built from a number the client supplied, so the
  client degrades to discarding what it cannot verify rather than inventing a
  replacement.

What this forbids: no consumer may pass a port in order to STEER the advertised
URLs. A LAN URL that is not the hub's own socket — a reverse proxy in front of it
on another port — is not this method's to invent either; pin it through
`setNotificationEndpoint` or a configured origin, which is an operator statement
rather than a guess.

The cost: a hub whose config section is unreadable falls back to echoing, and
says so. That path is labelled rather than hidden, and it logs.

This does NOT make a LAN endpoint usable on its own. The hub's LAN certificate is
self-signed (`CN=camstack.local`, issuer = subject), so an iOS client refuses the
handshake regardless of the port being correct. That is a separate block with a
separate owner; this record only removes the port from the list of reasons.

## Enforcement

`packages/system/src/builtins/local-network/__tests__/listen-port.spec.ts` pins
the resolution order, the provenance label, and the provider path: asking with
`port: 443` against a hub configured for 4443 must produce `:4443` URLs and
`source: 'server-config'`. The cap schema makes `port` optional, so a caller that
sends nothing is a supported call rather than a validation error.
