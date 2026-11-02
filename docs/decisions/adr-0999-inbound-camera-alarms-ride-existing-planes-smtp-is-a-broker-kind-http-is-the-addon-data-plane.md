---
id: D999
title: Inbound camera alarms ride existing planes — SMTP is a broker kind, HTTP is the addon data plane
status: accepted
date: 2026-11-02
supersedes: D986 §6 (inbound receivers as a hub builtin)
applies-to:
  - packages/addon-smtp-nodemailer/src/**
  - packages/addon-provider-reolink/src/email-push-bridge.ts
  - packages/types/src/brokers/smtp-inbound.ts
---

## Context

Battery Reolink cameras report motion by email. The Reolink addon ran its own
SMTP listener on :2525, with its own settings, its own keychain password and a
`listLanHosts()` that ranked the network palette by itself (a D729 violation).
D986 §6 proposed to move such receivers into a hub builtin
(`builtin:inbound-receiver`): a new process-level concept with no cap, no UI
and no owner for the credentials.

Every piece that builtin would have needed already exists. The `broker` cap is
a kind-tagged pub/sub registry with an admin UI (BrokerManager / BrokerForm),
`broker.message` events and a typed `getBrokerConfig`. `smtp-nodemailer` is
already the addon that owns email in the outbound direction. For HTTP, the
addon data plane (`ctx.dataPlane.serve`) is already reachable on the LAN
through the hub's plain-HTTP listener.

## Decision

An inbound camera alarm rides a plane that already exists. **SMTP is a broker
kind**: `smtp-inbound`, provided by `smtp-nodemailer` beside its relays, one
`mailboxes` record per mailbox, one smtp-server per record, bound only while a
record exists. A consumer subscribes with the recipient local-parts it owns;
the union of all subscriptions is the RCPT allowlist and anything else is
refused with 550. Messages travel as `broker.message` events and are
reconciled by RPC from a bounded per-mailbox ring (`getState('since:<seq>')`),
because events are telemetry (D8). The attachment is never put on the bus,
only its metadata (D613). The camera-facing host comes from the
`local-network` `internal` role (D729), never from the addon. **HTTP is the
addon data plane**: no new receiver concept.

D986 §6 is withdrawn.

## Consequences

- The mailbox password is a secret record field in the keychain, and the
  Reolink addon keeps no copy. Cameras already configured keep working: the
  port, domain, username and password are carried over by the Reolink owner
  migration `email-push-to-mailbox` (D987).
- The :2525 listener moves from the Reolink process to the `smtp-nodemailer`
  process. The container contract (D717) is unchanged: same port, same
  container.
- A recipient is claimed by one subscriber only
  (`smtp-inbound/recipient-claimed`).
- The webhook half (HaCfg push over the data plane, the :9081 compatibility
  intake and the removal of `listLanHosts`) is a follow-up; until it lands the
  Reolink webhook server is unchanged.

## Enforcement

Specs in `smtp-nodemailer` (no record means no listener, unknown RCPT gets
550, claimed recipient gives the typed error, ring replay, host `null` with a
reason without an `internal` role) and in `provider-reolink` (the migration
preserves the credentials and never reads a locked secret as empty).
