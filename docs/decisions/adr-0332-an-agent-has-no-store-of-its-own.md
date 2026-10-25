---
id: D332
title: An agent has no store of its own — persistence is the hub's, and the data door forwards there
status: accepted
date: 2026-09-01
supersedes:
applies-to:
  - server/backend/src/agent/agent-infra-capabilities.ts
  - packages/system/src/builtins/storage-orchestrator/hub-settings-forward.ts
  - packages/system/src/builtins/storage-orchestrator/data-store-dispatch.ts
---

## Context

`AGENT_INFRA` was `INFRA_CAPABILITIES`, unfiltered. That list carries
`{ name: 'data-store-provider', required: true }`; `sqlite-settings` is the only
addon in the tree that declares it, and it ships inside the `@camstack/system`
closure the agent scans. **An agent could not boot without opening a database of
its own.** Not a setting an operator could turn off — a precondition of boot,
enforced by `assertRequiredInfraResolved`.

What that database actually held, measured on `agent-a` on 2026-09-01
(114 KB, 17 tables, 16 indexes, 33 objects, one page each — against 204 objects
on the hub):

| Table | Rows |
| --- | --- |
| `addon-settings` | 0 |
| `hub-forwarder:addon-settings` | 0 |
| `metrics-native:addon-settings` | 0 |
| `platform-probe:addon-settings` | 0 |
| `storage-orchestrator:addon-settings` | 0 |
| `addon-devices`, `addon-device-settings`, `device-settings`, `device-runtime-state`, `provider-settings`, `sections`, `alerts`, `vec_indexes` | 0 |
| `system-settings` | 21 — every one a boot-seeded default |
| `storage_locations` | 4 — every one `is_system=1 is_default=1`, re-derived from declarations at every boot |

And on the hub, `settingsStore.get` over `<addonId>/addon-settings/root`
answered `null` for `storage-orchestrator`, `platform-probe`, `hub-forwarder`
and `native-metrics`. **Nothing had ever been written on either side.**

The premise that per-node addon configuration lived on the node turned out to be
false, and the code says so in three places. `addon-settings` is
`nodeIdMode: 'data'`, `mode: 'singleton'` — the generated cap router resolves the
hub's provider unconditionally, so `NodeAddonsSettingsPanel` passing a `nodeId`
never routes anywhere; `AddonCallGateway`'s `remote-agent` branch is unreachable
because `resolveNode` answers the hub in both of its own branches; and per-node
values are scoped per FIELD inside the hub's single blob, as `<key>@<nodeId>`
(`packages/types/src/addon/per-node-store.ts`). Every addon FORKED on an agent
already reached that store — `ipcParentLink` → the agent's `onUnownedCall`
(`getResolver: () => null`) → `forwardToHub` → `$hub-cap-fwd`.

The only writers of the agent's own file were the four infra addons that boot
INSIDE agent-main. Those get `[localProviderLink, brokerTransportLink]` and a
`capabilityRegistry`, so `ctx.api.settingsStore` resolved against the process's
own provider registry — i.e. against the local data door, whose dispatcher
refuses when no engine is registered. Dropping the engine without doing anything
else would have turned every one of their settings reads into a rejection.

## Decision

**An agent holds no data engine. Its `settings-store` door has the hub behind
it, and the payload crosses untouched.**

1. `resolveAgentInfraCapabilities` filters `data-store-provider` out of the
   agent's Phase 1 list. `INFRA_CAPABILITIES` is untouched — the hub reads the
   same array — and the order of everything else is preserved, because Phase 1
   walks the list in order.
2. On a node that registers no engine, `createDataStoreDispatch` resolves a
   REMOTE instead of throwing: `createHubSettingsForward`, one
   `$hub-cap-fwd.forward` per call, under the cap name `settings-store` (never
   the engine name — that would step around the door on the far side).
   A **local engine always wins**; the remote is a fallback, not a policy. A hub
   never builds one, or it would route its own door back into itself.
3. **No new key space.** The agent reads and writes the same row the hub's copy
   of that addon reads, `<addonId>:addon-settings` / `root`, and per-node values
   stay where they already are — `<key>@<nodeId>` inside that blob. A second,
   addon-level `(nodeId, addonId)` row would be a second authority over one
   fact, which is the shape [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
   forbids: the hub's copy would keep writing the bare row and nothing would
   reconcile them.
4. The storage-orchestrator's `storage_locations` store stays **in-memory on an
   agent** and is NOT pointed at the forwarding door. That table is keyed by a
   bare location id (`recordings:default`, `eventMedia:default`, …) which every
   node shares, so an agent writing through the door would land on the HUB's
   rows. An agent's locations are re-seeded from its addon declarations at every
   boot; the operator's real, node-pinned locations already live in the hub's
   table under `__nodeId`.

## Consequences

- **Without the hub, an agent's settings reads REJECT.** They never answer
  "empty". `ctx.settings` distinguishes a MISS from a FAILURE precisely so a
  failed read cannot make the next read-modify-write persist the patch alone;
  an empty answer would be indistinguishable from an empty store. This matches
  the standing rule for the node: without the hub an agent has no work.
- **An agent's storage locations no longer persist across a restart.** Nothing
  observable follows from that today — all four rows on the live agent were
  system defaults the seed pass recreates — but an operator who edits a location
  through an agent's own orchestrator would lose it. The line that used to say
  "running in-memory until one registers" now says what is true on an agent:
  that wait does not end, by design.
- **A rollback is an env var, not a revert.** `CAMSTACK_AGENT_LOCAL_DATA_STORE=1`
  restores `INFRA_CAPABILITIES` exactly and the agent boots its own engine
  again; the forwarding door goes inert the moment a local engine exists. This
  path has already cost three boot holes (1.2.149 skip-infra, 1.2.151 the
  D44×D87 crash-loop, 1.2.152 the `resolveConfig` hang), and a boot change that
  can only be undone by shipping a build stays broken for a release cycle.
- **The leftover `camstack.db` on an existing agent is inert, and NOT retirable
  through `RETIRED_COLLECTIONS`.** Every table it holds is a table the hub still
  declares, so listing any of them would drop the hub's copy at every boot; and
  the purge runs inside the engine's own boot, which no longer happens there.
  That failure mode is already visible on the `macmini` node, whose leftover
  store still carries `devices` and `device_settings_kv` — the two tables
  [D183](./adr-0183.md) retired — because its engine has not booted since
  2026-05-09. Deleting an operator's database file is an operator decision, not
  a boot-time one.

## Enforcement

- `server/backend/src/agent/__tests__/agent-infra-capabilities.spec.ts` runs the
  SAME `planInfraBoot` Phase 1 runs and writes one file per `initialize` step:
  `sqlite-settings.opened` must not exist, and must reappear under the rollback
  env var.
- `packages/system/src/builtins/storage-orchestrator/__tests__/hub-settings-forward.spec.ts`
  pins the gate (hub → `null`, agent → a forwarder), the envelope, verbatim
  payload passthrough, and that an unreachable hub rejects.
- `data-store-dispatch.spec.ts` pins local-engine precedence and that neither a
  missing remote nor an ambiguous local set is ever resolved silently.
- `scripts/check-retired-collections-are-dead.ts` (CI) refuses any <!-- drift-ok: deleted 2026-10-22 (D901) -->
  `RETIRED_COLLECTIONS` entry that still appears in the generated
  `docs/reference/storage.md`, so the "retire the agent's tables" mistake cannot
  be made by hand.
