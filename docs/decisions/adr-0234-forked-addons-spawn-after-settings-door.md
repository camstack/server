---
id: D234
title: Forked addons spawn only after the settings engine and door are ready
status: accepted
date: 2026-08-25
supersedes:
applies-to:
  - packages/system/src/kernel/isolated-builtin-phase.ts
  - server/backend/src/core/addon/addon-registry.service.ts
  - packages/types/src/addon/base-addon.ts
  - packages/addon-cloudflare/src/tunnel/auto-start.ts
  - packages/addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts
  - scripts/check-hub-settings-ready-before-forks.ts
---

## Context

[D231](adr-0231-sqlite-settings-forks-infra-isolates-spawn-before-the-door.md)
forks sqlite-settings so `Statement.run` leaves the API loop.
[D233](adr-0233-hub-local-isolated-infra-is-proxied.md) waits until
`data-store-provider` is in the parent's collection before in-process
builtins read the door. The wait was placed AFTER the rest of the forked
spawn plan so `onModuleInit` would yield (1.2.151 threw on timeout and
crash-looped; 1.2.152 hung because sqlite itself waited on the door).

That placement is the wrong side of every *other* forked addon.
`initializeAddonGroup` returns when the child *process* exists. The
child then `resolveConfig()` → `readAddonStoreWithRetry` (~2 s) while
sqlite's handshake is still in flight and the in-process door has not
booted. The retry budget expires, the addon keeps constructor defaults.

On 2026-08-25 after 1.2.153 cold boot, persisted cloudflare-tunnel
settings were `mode: custom` + hostname `camstack.<local-user>.top`.
The running addon logged `mode=quick hasCustomToken=false` and spawned a
trycloudflare URL. Notification attachments still minted the marked
named hostname. Cloudflare answered 530 / error 1033. LAN
`/addon/pipeline-analytics/nc-artifact/…` was fine. Restarting the addon
once sqlite was up loaded custom mode and the named hostname returned
200.

A competing diagnosis — "just don't auto-start quick" — would hide the
next forked addon that reads settings at init (snapshot already has a
boot-window test for this). The wave order is the rule.

## Decision

Hub addon boot is exactly `runHubAddonBoot`: spawn isolated infra
(sqlite) → wait until `data-store-provider` is in `getCollection` →
boot in-process infra (the settings door) → spawn every other forked
addon → remaining in-process builtins → isolated consumers (snapshot).

`waitUntilReady` yields via `setTimeout`; the 1.2.151 deadlock was
sqlite's `resolveConfig` waiting on a door this sequence had not built
yet (sqlite now skips that read), not the wait blocking the UDS read. A
timeout still logs and continues — it must not throw.

A settings store that never answered is not an empty store.
`BaseAddon.settingsStoreReady` is true only after `readAddonStore`
returns. cloudflare-tunnel auto-starts only when that flag is true —
constructor `mode: 'quick'` is not an operator choice.

## Consequences

- Forked addons pay sqlite handshake + door init before they start. That
  is the cost of reading real settings at `initialize()`.
- A timeout on the engine wait still lets other forks start against an
  empty door (same as 1.2.150). They must not auto-start from defaults
  when `settingsStoreReady` is false.
- Agents still boot sqlite in-process; this record does not change that.

## Enforcement

- `packages/system/src/kernel/__tests__/isolated-builtin-phase.spec.ts`
  — `runHubAddonBoot` records forked spawn after the door is up.
- `scripts/check-hub-settings-ready-before-forks.ts` — the hub registry
  must call `runHubAddonBoot`; inlining a different order fails CI.
- `packages/types/src/addon/__tests__/base-addon-state.spec.ts` — a store
  that throws `provider not available` does not set `settingsStoreReady`.
- `packages/addon-cloudflare/src/tunnel/__tests__/auto-start.spec.ts` —
  quick-mode defaults do not auto-start when the store never answered.
