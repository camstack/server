---
title: Architecture overview
applies-to:
  - server/backend/src/main.ts
  - server/backend/src/manual-boot.ts
  - server/backend/src/api/static/frame-policy.ts
  - server/backend/src/agent/main.ts
  - packages/system/src/logging/log-manager.ts
covers:
  - packages/system/src/kernel/**
last-verified: 2026-10-02
---

# Architecture overview

CamStack is a kernel plus addons. The kernel owns processes, transport and
registries; **every user-visible feature is an addon** — device providers, the
detection pipeline, streaming, recording, analytics, the Admin UI itself.

For the current inventory, read the generated pages, not this one:

- [Packages](../reference/packages.md) — who is framework, who is an addon, and
  how each reaches a node
- [Addons](../reference/addons.md) — every manifest entry, its category, its
  process group
- [Capabilities](../reference/capabilities.md) — every `*.cap.ts`
- [Guards](../reference/guards.md) — what the repo refuses to let you commit

## The six things worth knowing first

**1. A node is a process running `@camstack/server`.** Hub and agent are the same
package; the role is `CAMSTACK_ROLE` ([D16](../decisions/adr-0016.md)). A hub
orchestrates; an agent contributes capabilities and hardware.

**2. Capabilities are the only interface.** A capability is a named, typed
contract defined once in `packages/types/src/capabilities/*.cap.ts`. Addons
register providers for it; callers invoke `ctx.api.<cap>.<method>` and never learn
where it ran. Addons do not import each other — there is no other channel.

**3. Transport is two-tier and invisible.** Hub ↔ hub-local addon children speak
UDS/MsgPack; hub ↔ remote agents speak Moleculer. `CapRouteResolver` classifies
every `(cap, node, device)` into one of four routes and the call signature is
identical for all of them. See [transport.md](transport.md).

**4. One addon = one process, unless it opts into co-location.** Default is
isolation; a shared `execution.group` collapses members into one runner so their
calls resolve in-process ([D2](../decisions/adr-0002.md)). Two motives sanction
it: a payload that must not cross a boundary
([D9](../decisions/adr-0009.md)), and — for non-live, frame-free, low-crash
addons only — reclaiming the ~80MB floor every solitary runner costs
([D29](../decisions/adr-0029.md)). Never a device provider, never a data-plane
runner: a co-located crash respawns the whole runner.

**5. Codegen is authoritative.** Touching a `*.cap.ts` without `npm run codegen`
produces silent drift: routers, the client-side status-type map and the
`DeviceProxy` facade are all derived from it.

**6. Authorization is one matcher over generated tables, not a check per
router.** Every cap method declares an `auth` tier (`public` / `protected` /
`admin`, and **omitting it means `protected`**); a non-admin call then goes
through `server/backend/src/api/trpc/scope-access.ts`, which reads the
generated method-access and device-reference tables. A grant says WHAT
(`category` / `capability` / `addon` / `device` rows) and, for devices, a
`DeviceSelector` — `all`, explicit `ids`, or a **dynamic** `types` / `locations`
set that a device added later joins with no re-grant. Tiers in
[capabilities.md](capabilities.md); assigning a grant in [ui.md](ui.md); why an
addon's own calls are exempt in [transport.md](transport.md).

## Boot

`server/backend/src/main.ts` boots Fastify manually — no DI framework. The service
graph is constructed by hand in dependency order in
`server/backend/src/manual-boot.ts` (NestJS was removed). In order: storage and
settings come up, the capability registry is created and every shipped cap is
`declareCapability`'d before `app.init()`, the addon plan is built
(`buildAddonGroupPlan`, which resolves co-location), runners are forked, and each
registers its providers. The tRPC router is assembled at boot from
`ALL_CAPABILITY_DEFINITIONS` — there is no per-capability line to add
([capabilities.md](capabilities.md)).

One response-layer hook is installed on the same instance: every `text/html`
reply the hub sends carries `Content-Security-Policy: frame-ancestors 'self'`
(`api/static/frame-policy.ts`,
[D425](../decisions/adr-0425-the-hub-is-framed-only-by-its-own-origin-and-a-foreign-host-reaches-it-through-a-same-origin-relay.md)).
It is stamped centrally rather than at each shell-send site because a policy
that depends on every future route remembering it is a policy that drifts.

**The router is built, and the `$core-caps` mesh bridge registered, in
`app.init({ beforeAddonBoot })` — before a single addon boots**
([D171](../decisions/adr-0171-the-hub-core-api-is-on-the-mesh-before-the-first-addon-boots.md)).
`app.init()` *is* the addon boot, so while the bridge was registered after it
every `ctx.api.<coreCap>` call made during boot was not slow but unanswerable —
30 s of discovery and a fast-fail, with no boot-window retry, because core caps
are excluded from it. Building the router early is safe precisely because
`ALL_CAPABILITY_DEFINITIONS` is declared before init and every provider is
resolved **per request**, never at build time. Same instance is handed to
Fastify afterwards; there is exactly one.

An agent (`server/backend/src/agent/main.ts`) does the same, then hands its
complete manifest to its parent in one `registerNode` RPC — `$hub.registerNode`
for agents and hub children, `$agent.registerNode` for an agent's own children
([D3](../decisions/adr-0003.md)).

## Where the code lives

`packages/system` is the kernel: `src/kernel/` (registry, loader, transport,
Moleculer, supervision), `src/builtins/` (storage, settings, logging, snapshot,
device-manager, backup), plus HTTP, auth, process and Python plumbing. The
storage engine is one process that can own several SQLite files, each on its own
thread: [storage-files.md](storage-files.md). It absorbed
what used to be `packages/kernel` and `packages/core`. <!-- drift-ok: naming packages that no longer exist is the point -->

`packages/addon-pipeline` is the media and vision plane in one package with six
addon manifests: `pipeline-runner`, `detection-pipeline`, `motion-wasm`,
`stream-broker`, `recorder`, `audio-analyzer`. Only the first three share the
`detection` group; `stream-broker`, `recorder` and `audio-analyzer` each get their
own runner. It absorbed the former `addon-detection-pipeline`,
`addon-pipeline-runner` and `addon-motion-wasm` packages.

`packages/types` holds capability definitions, the device model and most generated
artifacts (`src/generated/`); the rest land in `packages/ui-library/src/generated/`
(React hooks) and `server/backend/src/api/trpc/` (the cap-router type map).
`packages/ui-library` holds shared React composites and hooks.

## Logging, and where each knob lives

Four `log-destination` providers, all peers. `LogManager` fans every entry to each
**enabled** destination; enabling one never disables another. Manage them under
**Data → Logging**, which lists whatever is registered.

| Destination | Does | Configured by |
| --- | --- | --- |
| `console-logging` | stdout / stderr | its addon settings (level) |
| `winston-logging` | rotated files in `<nodeDataDir>/logs` | its addon settings (level, retention days) |
| `loki-logging` | pushes to Grafana Loki, **opt-in** | its addon settings (URL, level, labels, auth, batching) |
| `hub-forwarder` | agent → hub, **agent-only** | — |

Each destination's settings come from its own `globalSettingsSchema()`, are stored
**per node**, and are rendered by the derived form — under Data → Logging, and
equally under Cluster → node → Settings. Nothing about a destination is hard-coded
in the UI.

**On/off is the orchestrator's Enable/Disable toggle, and it is the only truth.**
`LogManager` tags each destination with the addon that provides it and consults an
injected check, wired at boot in `server/backend/src/manual-boot.ts` to
`CapabilityRegistry.isProviderDisabled('log-destination', addonId)`; the toggle
takes effect live, with no re-registration. Until 2026-07-30 that toggle was
write-only — console and winston could not be turned off at all while the UI badge
said they were, and Loki only appeared to obey because it carried a second, private
`enabled` setting. That private setting is retired (a stored `false` migrates once
into a registry disable), so a destination has exactly one switch. An untagged
destination — the agent's own wiring — is never gated.

**The in-memory buffer answers to the same toggle, under the reserved id
`log-buffer`, but it is not an addon.** The Admin UI's live log stream reads a RAM
ring buffer owned by `LogManager`, partitioned per `addonId` so a chatty addon
evicts only its own lines. It lives in the kernel because it must exist before any
addon loads (boot lines) and because it backs `logs.query`/`subscribe` — so turning
it off also empties the log viewer, which is what the operator asking for it means.
Its *size* is configured in `config.yaml`, not in addon settings, and only on the
hub — an agent hardcodes 5000 (`server/backend/src/agent/main.ts`).

| `config.yaml` key | Default | |
| --- | --- | --- |
| `eventBus.perAddonLogBufferSize` | `5000` | **Hard** ring size per addon bucket |
| `eventBus.maxTotalLogBufferSize` | unset → `DEFAULT_MAX_TOTAL_LOG_ENTRIES` (50 000) | Ceiling across all buckets. An explicit `null` opts out — the per-addon rings are then the only bound |
| `eventBus.logBufferPruneLevel` | `debug` | Highest severity the total sweep may discard |

Two bounds doing different jobs. The per-addon ring is the hard guarantee, but it
scales with addon count — the measured ~60-bucket hub retained ~300k entries
(~92 MB at ~306 B/entry) with no aggregate bound at all, on the one process that
must fit inside the cgroup. So the total is **bounded out of the box**; it was
`null` by default until 2026-08-18 and the service forced it back to `null` on top
of that, which is why the buffer could not be configured into a bound at all.

**Prune first, and only then drop a whole bucket.** When the total is exceeded the
sweep discards entries at or below `logBufferPruneLevel` — default `debug`, the
overwhelming majority of any busy buffer — oldest first, from the largest buckets
first, so a live addon's `warn`/`error` are never traded for lines about frame
timings. Only when pruning cannot reach the target are whole
least-recently-**written** buckets dropped, never the one being written to: a bound
that pruning alone cannot hold is not a bound, and a dead addon's 5 000 immortal
`info` lines were exactly that failure.

## Reading further

| Topic | Page |
| --- | --- |
| Link chain, route kinds, node pinning | [transport.md](transport.md) |
| Cap definition → router → provider | [capabilities.md](capabilities.md) |
| Install / update / restart / crash | [addon-lifecycle.md](addon-lifecycle.md) |
| Frames, decode, media transport | [data-planes.md](data-planes.md) |
| Devices, runtime state, settings | [device-model.md](device-model.md) |
| Publish, deploy, update a node | [update-and-release.md](update-and-release.md) |
| Admin UI architecture | [ui.md](ui.md) |
| Building UI (both clients): components, tokens, patterns | [../ui/README.md](../ui/README.md) |

Deep dives that predate this set, still accurate and more detailed:
[`docs/design/transport-and-cross-node-routing.md`](../design/transport-and-cross-node-routing.md)
and [`docs/design/decode-path.md`](../design/decode-path.md). Both are required
reading before touching their subjects.
