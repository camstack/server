---
id: D947
title: Echo speech uses one long-lived alexapy worker
status: superseded
superseded-by: D949
date: 2026-10-27
supersedes:
applies-to:
  - packages/addon-import-alexa/python/**
  - packages/addon-import-alexa/src/speak/**
---

## Context

A notification should be read aloud on Echo devices. The official Alexa skill
(`addon-export-alexa`) can show a camera and run routines, but it cannot carry
arbitrary text. Home Assistant's Alexa Media Player can speak, and that would
make every utterance depend on another product. Spawning a Python process per
message would also throw away the login the library just paid for.

The unofficial import addon already holds an Amazon account, through a
different client (`alexa-remote2`). That cookie jar is not the session
`alexapy` writes. The two must not be mixed, and the import's placement must
not change to host this.

## Decision

Speech is a `notification-output` provider on `addon-import-alexa`. One Python
process per addon instance speaks line-delimited JSON on stdin and stdout.
`alexapy` 1.29.20 (Apache-2.0) is a pinned requirement, not a vendored tree.
The password and the cookie jar are owner-only files the request names; they
are never arguments, environment variables, or log lines. A crash restarts
inside the same bound the runner supervisor uses (five times in 60 seconds),
then sends fail so the outbox retries. A repeated sentence, a burst, and Do
Not Disturb are recorded skips, not retries.

## Consequences

The operator signs in on Speak on Echo. A one-time code raises a single
`addon.error` alert. A captcha cannot be solved in the page. Tests mock
`alexapy` and must not contact Amazon. A second addon instance with the same
account can speak the same sentence twice.

## Enforcement

`packages/addon-import-alexa/python/test_alexa_protocol.py` and
`src/__tests__/secret-and-worker.spec.ts`. Nothing scans the pin. Review only
for a new process-per-message spawn.
