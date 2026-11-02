---
id: D1001
title: ESPHome board keys are read through Home Assistant ingress, never from a port opened on the LAN
status: proposed
date: 2026-11-02
supersedes:
applies-to:
  - packages/addon-provider-homeassistant/src/ha-board-key-source.ts
  - packages/addon-provider-esphome/src/esphome-key-import.ts
  - packages/types/src/capabilities/board-key-source.cap.ts
---

## Context

An encrypted ESPHome board needs its API key, which lives only in the board's
YAML under the ESPHome Builder add-on that runs inside Home Assistant. The
operator was copying each key by hand. The Builder serves a dashboard that can
return a board's resolved config (`json-config`), but it listens on a plain,
unauthenticated port (6052) when that port is published: anyone on the LAN can
read every YAML secret, Wi-Fi passphrase included. Publishing it for CamStack
would have opened that to the whole network, and a second credential would have
been needed to guard it.

## Decision

The key is read through Home Assistant ingress with the long-lived token the
Home Assistant broker already holds: `supervisor/api` finds the Builder
(`/discovery`, `/addons/<slug>/info`), an admin-only `/ingress/session` grants a
cookie, and `devices` / `json-config` are read over `/api/hassio_ingress/`. No
port is opened and no credential is added. The reader is the
`board-key-source` capability (admin-only), served by `provider-homeassistant`;
`provider-esphome` consumes it through `ctx.api`. The `json-config` body holds
every secret, so it is parsed into a schema naming only `api.encryption.key`
and nothing else is kept, returned or logged. A read that fails returns a typed
reason and never reaches the store, so an existing key is not cleared (D49).

## Consequences

Only an administrator token can import keys; a non-admin one is refused with
`not-admin`. A broker authenticated by supervisor token has no address, so it
answers `no-ingress-url`. The path depends on the Builder's ingress and
`json-config` shapes. A second key source needs a provider-namespaced
`sourceId`, because collection calls fan out to every provider.

## Enforcement

`ha-board-key-source.spec.ts` asserts that neither the result nor any log line
contains a secret other than the key, and that a non-admin token is refused.
`esphome-key-import.spec.ts` asserts a failed read never writes. Nothing
checks that no port is opened: review only.
