---
id: D783
title: A secret is declared by its schema type, and never travels on argv, in the environment or in a log line
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-cloudflare/src/tunnel/cloudflared-invocation.ts
  - packages/addon-cloudflare/src/tunnel/cloudflare-tunnel.ts
  - packages/addon-cloudflare/src/tunnel/ensure-cloudflared.ts
  - packages/addon-tailscale/src/auth-key-file.ts
  - packages/addon-tailscale/src/client/tailscale-cli.ts
  - packages/addon-tailscale/src/ingress/tailscale-cli.ts
  - packages/types/src/device/zod-to-config-ui.ts
  - server/backend/src/api/trpc/device-config-secret-redaction.ts
---

## Context

The secrets-keychain survey (2026-10-08) found three secrets reaching logs and
two kinds of secret that the non-admin redaction (D634) could not see.

- **Logs and argv.** cloudflared ran as `tunnel run --token <token>` and the
  spawn line logged `args.join(' ')`, so the named-tunnel token sat in
  `/proc/<pid>/cmdline`, `/data/logs` and Loki. `tailscale up --auth-key <key>`
  did the same on argv, and execFile's `Command failed: …` message repeated the
  key into the thrown error, which the auto-rejoin path logs. The magic-link
  addon logged the login link itself — a link is a login.
- **The first fix that was proposed, and refused.** Moving both tokens to the
  environment (`TUNNEL_TOKEN`, `TS_AUTHKEY`). The environment is inherited by
  every child, readable from `/proc/<pid>/environ` by the same user, and dumped
  by crash reporters and `addon-terminal` PTYs. The operator ruled it out: no
  secret travels through an environment variable, ever.
- **Declared by name.** D634 decided a device-config secret by its KEY: a
  substring list (`password`, `secret`, `token`, `apikey`, `api_key`) on the top
  level of the `config` blob only. Nested `connection.{password,apiKey}`
  (UniFi, VeSync, Velux, Rademacher, Ecowitt, Unraid) went out whole, and Tuya
  `localKey` and Dreame `navigationAccessCode` match no keyword at all. HAP
  `fixedPin` and Matter `threadDataset` were plain `text` fields. A name list is
  right on the day it is written and wrong on the day a driver adds
  `pairingCode`.

## Decision

**A field is a secret because its schema says so — `type: 'password'` or
`secret: true` on a config-UI field, `.meta({ secret: true })` on a Zod
schema — never because of its name.** Every consumer that must treat secrets
specially (non-admin redaction now, keychain storage later) reads the
declaration. A device advertises the declared paths of its config schema
(`secretConfigPaths`, dotted, `[]` for array items) when it registers, and the
non-admin redaction withholds those paths at any depth.

**A secret value never travels on a process's argv, in its environment, or in
a log line or error message.** A CLI that needs one gets it from an owner-only
(0600) file in an owner-only (0700) directory, written right before the call
and deleted when the call or child ends (`cloudflared --token-file`,
`tailscale up --auth-key=file:`), or over stdin, or through the library API.
A log line records the event (`delivered: false`, `hasToken: true`,
`tokenLength`), never the value.

## Consequences

- cloudflared must be ≥ 2025.4.0 (the first release with `--token-file`). A
  PATH or cached binary older than that is treated as absent and the pinned
  release is downloaded; there is no fallback to argv or env.
- The magic-link `log-only` mode no longer yields a usable link. It is a
  setup aid that now only proves the request path works.
- The D634 keyword list stays, in this phase, as a **backstop** for non-admin
  redaction only. It is not a declaration and nothing new may rely on it; the
  guard below fails when a credential-named field is not declared.
- The keychain (P1/P2) keys storage on the same declaration, so a field that
  is declared here is keychain-backed there without a second list.

## Enforcement

- The `check-secret-fields-declared` guard under scripts (and its spec) scans every addon's
  Zod object properties and config-UI fields and fails on a credential-named
  key that is not declared secret by type. Exceptions are a pinned allowlist
  with a reason each; it should only shrink.
- Specs with canary values: the cloudflared and tailscale invocations (argv,
  env, error text, logs), the magic-link request path (logs), the D634
  redaction of declared nested paths.
- Nothing yet scans arbitrary `logger.*` calls for secret values; that is the
  central redactor of keychain P1.
