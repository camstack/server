---
id: D959
title: A PetKit re-login is gated, because the account has one session
status: accepted
date: 2026-10-28
applies-to:
  - packages/addon-provider-petkit/src/**
---

## Context

PetKit keeps ONE active session per account. A login here ends the session of
the phone app and of any Home Assistant integration on the same account, and
theirs ends ours. The wrapped client holds a fixed session id, so before this
record the addon never signed in again: a kicked session failed every poll
(30 s per feeder) until the operator re-saved the integration. Re-logging in
eagerly was rejected: two holders re-logging in on every refusal take the
session from each other forever.

The cloud signals the loss as application error code 5 ("session expired");
the Python client `pypetkitapi` 1.31.1 maps exactly that code to a session-
expired error whose message advises a separate account. Code 5 does not tell a
kick from a natural expiry. (Code 125 is "email not registered", not a kick.)

## Decision

A session loss re-logs in only through `ReloginGate`: at most one re-login per
5 minutes, the delay doubling per attempt up to 60 minutes, and after 3
re-logins inside 6 hours it stops until the operator re-saves the account. Every
re-login and every refusal is logged with its reason; once stopped, the
integration reports `another app signed in with this account — use a dedicated
family account`. Rejected credentials never trigger a re-login. The account
form tells the operator to use a family-member account, so the main account
stays on the phone.

## Consequences

A natural expiry costs one re-login. A shared account settles into "stopped"
within hours instead of ping-ponging. The 5 min / 60 min / 6 h / 3 constants are
operator-unverified guesses (named in `petkit-relogin-gate.ts`).

## MQTT push — spike result, NOT implemented

`pypetkitapi` 1.31.1 contains only the credential half. `GET user/iotDeviceInfo_v2`
(fallback `user/iotDeviceInfo`) with the session header returns
`{ali: IotInfo, petkit: IotInfo}` or a flat `IotInfo`, preferred `petkit` > `ali`
> flat. `IotInfo` fields: `deviceName`, `deviceSecret`, `productKey`,
`mqttHost`, `mqttIp`, `standbyMqttHost`, `standbyMqttIp`, `iotInstanceId`,
`iotPlatform`, `regionId`. This is an Alibaba IoT-style device triple, which
implies a signed MQTT username/password derived from it.

Missing from the package, so push is not built: the MQTT client itself — port,
TLS, client id, the sign-in derivation from `deviceSecret`, the topic names, the
payload format and the event vocabulary (feeding done, food low, errors). They
live in the Home Assistant component, not in the pip package. Building them from
memory would be a guess against a live vendor broker. Next step: read that
component's MQTT module as data, then implement `pushUpdates` (default off) in
the addon, triggering the existing per-feeder refresh and keeping polling.
`mqtt` 5.x is already in the workspace lockfile.

## Enforcement

`petkit-relogin-gate.spec.ts` and `petkit-integration-manager-relogin.spec.ts`
(a burst of failing polls yields one re-login; repeated kicks stop and surface
the message; a re-save re-arms).
