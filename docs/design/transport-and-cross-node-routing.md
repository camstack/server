# Transport & Cross-Node Capability Routing

> **Why this doc exists.** The two-tier transport and the *cross-node* capability
> path are the single most subtle part of CamStack, and the area where wrong
> assumptions cost the most. This is the canonical reference: read it before
> touching anything in `packages/system/src/kernel/transport/`,
> `packages/system/src/kernel/moleculer/`, `server/backend/src/agent/`, or
> `server/backend/src/core/addon/`. It is written to spare a future session the
> multi-hour re-investigation that produced it.

Last verified against `main` on 2026-06-26 (live homelab cluster: hub `.89`
Intel Ultra 7 + agent `agent-a` `.128` Intel N100).

---

## 1. The shape of the system

- **One hub, N agents.** The hub orchestrates; agents are autonomous workers that
  join the cluster by being paired from the hub (a mesh certificate, mutual TLS, D826, D857) and offload heavy work
  (detection, decode, motion). Each is a separate OS process tree on a separate
  machine. The mesh is a star: an enrolled agent talks to the hub only (D848).
- **One addon = one process.** Every addon runs in its own forked `addon-runner`
  subprocess (`resolveRunnerId` in `packages/types/src/interfaces/addon.ts`).
  Co-location is an explicit opt-in via a shared `execution.group`; no shipped
  addon uses it. There is no in-process hot-reload — install/update/restart all
  reduce to (re)spawning a runner.
- **Everything is a capability.** Functionality is exposed as capabilities
  (`*.cap.ts`). An addon calls another addon ONLY through `ctx.api.<cap>.<method>`
  — never a direct import, never `addonRegistry.getAddon()`.

The hard question this doc answers: **when addon A calls `ctx.api.X.Y()`, how does
the call reach the right provider — which may be in A's own process, in a sibling
process on the same node, or on a different machine — and who decides?**

---

## 2. Two-tier transport

There are exactly two wire transports. Do not add a third.

| Plane | Transport | Used for |
| --- | --- | --- |
| Parent ↔ its forked children (intra-node) | **UDS** (Unix domain socket, MsgPack) | the hub ↔ its hub-local addon runners; an agent ↔ its own addon runners |
| Hub ↔ remote agent (inter-node) | **Moleculer** (TCP transporter over mutual TLS; no agent ↔ agent link, D848) | node-level RPCs (`$hub.*`, `$agent.*`, `$process.*`) + the cap-forward action |

Key consequence, and the one that breaks intuitions:

> **A forked `addon-runner` registers NO Moleculer service.** It is UDS-only.
> `addon-runner.ts` says it explicitly: *"No Moleculer service to mount
> (UDS-only)… the `createAddonService` schema / method+timeout resolvers are
> gone."* So on an agent, there is **no** `detection-pipeline` Moleculer service,
> no `${addonId}.${cap}.${method}` action, no `${addonId}.settings.${method}`
> action. The only Moleculer services an agent exposes are node-level:
> `$node`, `$agent`, `$agent-cap-fwd`, `$event-bus`, `$hwaccel`, `$process`.

This is why you cannot reach an agent addon by calling a per-addon Moleculer
action. You reach it through the agent's **node-level forward service** (§4).

---

## 3. How a capability call routes — the link chain

A forked addon's `ctx.api` is a tRPC client built in
`packages/system/src/kernel/moleculer/addon-context-factory.ts` with this link
chain (UDS mode):

```
localProviderLink  →  ipcParentLink  →  (broker fallback)
```

1. **`localProviderLink`** (`trpc-links.ts`): if the cap+method is provided by a
   provider registered in *this same process*, call it directly (zero
   serialization) and stop. Otherwise pass through.
2. **`ipcParentLink`** (`trpc-links.ts`): send the call to the runner's PARENT
   over UDS as a `cap-call-out` message (`callOut` → `LocalChildClient`). The
   parent's `LocalChildRegistry` receives it and, if no local sibling owns the
   cap, hands it to **`onUnownedCall`**.
3. **`onUnownedCall`** (`parent-unowned-call.ts`) is where the real routing
   decision is made — it is **resolver-first**:

```ts
const resolver = deps.getResolver()           // the parent's CapRouteResolver
if (resolver) {
  const route = resolver.resolveCapRoute(input.capName, { nodeId?, deviceId? })
  return resolver.dispatch(route, input.method, input.args)
}
// else: broker fallback (Moleculer service discovery) — legacy/in-process-infra only
```

Two answers come BEFORE the resolver, both out of band of name routing: a
`native: true` call (`resolveNative` → `CapabilityRegistry.getNativeProvider`),
and a `getStatus` with a `deviceId` on a CLAIMED `(cap, device)`
(`answerClaimedGetStatus` → `CapabilityRegistry.resolveClaimedStatus`, the hub
mirror's merged slice — D663, ruling S3). Routing a claimed `getStatus` to the
owning runner would answer the native value, which is exactly the surface split
(HomeKit native, UI merged) the hook closes. The SAME question is asked by the
two other entries that resolve by name — `LocalChildRegistry`'s sibling
short-circuit (step 2 above, BEFORE this handler is ever reached) and the hub's
`callCapabilityOnNode` — through the one shared function, and
`scripts/check-claimed-get-status.ts` fails a fourth entry that does not ask.

So the authority for cross-node routing is the **`CapRouteResolver`**
(`packages/system/src/kernel/transport/cap-route-resolver.ts`), reached via the
parent's `onUnownedCall`. (The codegen cap routers in `server/backend` reach the
same resolver via `moleculer.service.ts` `callCapabilityOnNode` — a parallel
entry point for calls that originate at the hub's tRPC API rather than from a
forked addon's `ctx.api`.)

### The four route kinds

`classifyCapRoute` (`cap-route.ts`) classifies `(capName, { nodeId?, deviceId? })`
into one of:

| Route | Meaning | Dispatch |
| --- | --- | --- |
| `hub-in-process` | provider lives in the hub host process | call it directly |
| `hub-local-uds` | provider is a forked hub-local child | `LocalChildRegistry.callCapOnChild` over UDS |
| `remote-moleculer` | provider is a *Moleculer-discoverable* service on a node | `broker.call('${addonId}.${cap}.${method}', …, { nodeID })` |
| `agent-child-forward` | provider is a forked child UNDER a remote agent (the common agent case) | `broker.call('$agent-cap-fwd.forward', { capName, method, args, childId?, deviceId? }, { nodeID: agentNodeId })` |

Precedence on the explicit-nodeId path: `hub-in-process` → `hub-local-uds` →
`remote-moleculer` → `agent-child-forward`. With **no** nodeId, a singleton cap
resolves to the hub; a device-scoped cap resolves to the device's owning node
(derived from `deviceId`).

---

## 4. The agent side — `$agent-cap-fwd.forward`

Because agent addon runners are UDS-only (§2), the hub cannot call them directly.
The agent runs a node-level Moleculer service that bridges Moleculer → its own
internal UDS:

- **Service:** `$agent-cap-fwd` (`AGENT_CAP_FWD_SERVICE`), registered in
  `server/backend/src/agent/agent-cap-dispatch-service.ts` (wired by
  `register-agent-cap-dispatch.ts` during agent boot).
- **Action `forward`:** receives `{ capName, method, args, childId?, deviceId? }`,
  resolves the owning child in the agent's OWN `LocalChildRegistry`
  (`resolveChildId`), and dispatches over UDS via `callCapOnChild`.
- **In-process fallback (important):** if no forked UDS child owns the cap, the
  handler consults an **`inProcessLookup`** — the agent's core builtins
  (`platform-probe`, `metrics-provider`, …) register their singleton providers in
  the agent's *own process* `CapabilityRegistry`, NOT as forked children. This is
  how the hub reaches an agent's in-process singleton.

So the full cross-node path for "hub calls an agent addon's cap":

```
hub addon ctx.api.X.Y()
  → localProviderLink (miss)
  → ipcParentLink (UDS → hub parent)
  → onUnownedCall → CapRouteResolver → agent-child-forward
  → broker.call('$agent-cap-fwd.forward', …, { nodeID: agent })   [Moleculer/TCP]
  → agent: resolveChildId / inProcessLookup
  → agent: callCapOnChild (UDS) OR in-process provider
```

---

## 5. Addon-LEVEL calls (settings / routes / custom) — the gateway

Capabilities are not the only surface. Addon-LEVEL methods — the `settings`
(`getGlobalSettings`/`updateGlobalSettings`/…), `routes`, and `custom`-action
surfaces — are routed by a separate, single chokepoint:

- **`AddonCallGateway`** (`server/backend/src/core/addon/addon-call-gateway.ts`).
  `classify(addonId, nodeId?)` → `in-process | hub-local-child | remote-agent`.
  Hub-local forked addons go over UDS (`callAddonOnChild`); the in-process branch
  is only the `@camstack/system` builtins.

> **DEAD PATH WARNING.** `AddonCallGateway.callRemoteAgent` maps a remote-agent
> settings call to `broker.call('${addonId}.settings.${method}', …)`. **That
> Moleculer action does not exist on agents** (§2 — addon-runner is UDS-only).
> So *addon-level settings of a remote agent's addon are currently unreachable by
> this path.* This was discovered the hard way: a "route settings to the owning
> node" change classified correctly but found no service (`matchNodeIDs=[]` in a
> live `getServiceList` dump) and silently fell back. If you need agent
> addon-level settings, you must add a node-level forward analogous to
> `$agent-cap-fwd` (an `$agent-addon-fwd` that re-dispatches `callAddonOnChild`),
> OR model the per-node datum as a CAP (which already forwards — §4).

### How per-node settings work *today* (Model B)

`detection-pipeline` is a hub-known addon, so `addon-settings` always serves
*every* node's settings from the **hub** instance, reading a **cluster-central,
hub-resident** settings store. The store is a single shared blob
(`settings-store` cap is `mode: 'singleton'` → resolves to the hub; the agent's
own `ctx.settings` also routes there — `addon-context-factory.ts`: *"the
settings-store is hub-resident"*). Per-node values that must differ by hardware
are stored **node-scoped** as `<key>@<nodeId>` within that one blob
(`nodeScopedKey`; `detection-pipeline/engine-store-keys.ts` holds the node-id
normaliser). Everything else stays shared.

> The engine cascade (`engineBackend` / `engineDevice` / `probedBestEngine`) was
> the original example of this and is **gone**: engine selection is no longer an
> operator choice — each node runs a device-array of inference pools and the
> node-default pool derives live from that node's hardware. The keys are
> retired and deleted at boot
> (`system/src/builtins/sqlite-storage/retired-settings-keys.ts`). Live examples
> of the node-scoped pattern today: `probedBestHwaccel@<node>` (decoder-ffmpeg /
> decoder-nodeav) and `probedBestAudioBackend@<node>` (audio-analyzer).

---

## 6. Per-call node pinning — `nodePin`

A singleton cap resolves to the hub by default (§3). To query a SPECIFIC node's
provider — e.g. the hub's `detection-pipeline` needs the *agent's* own
`platform-probe` hardware to offer correct per-node engine options — pin the
call to that node. Node targeting is a property of the CALL, not of the method,
so the nodeId rides OUT-OF-BAND, never in the validated zod args.

```ts
// packages/types/src/cap-call-context.ts
await api.platformProbe.getCapabilities.query(undefined, nodePin('agent-a'))
```

Mechanism (all additive, optional `nodeId?` threaded along the existing path):

```
nodePin(nodeId)                         → tRPC op.context (out-of-band)
ipcParentLink: readNodePin(op.context)  → CapCallInput.nodeId        (trpc-links.ts)
UDS wire (cap-call-out)                 → carries nodeId             (local-child-*.ts)
onUnownedCall                           → resolveCapRoute({ nodeId }) (parent-unowned-call.ts)
CapRouteResolver                        → agent-child-forward → $agent-cap-fwd → agent's in-process platform-probe
```

`platform-probe` is a `singleton` cap whose `getCapabilities` takes `z.void()` —
it has **no** `nodeId` parameter, by design. (Historically `resolveHwAccel` had a
vestigial `nodeId` arg that the provider *ignored* — do not copy that pattern;
per-node routing belongs in the transport, not in method signatures.)

Consumer that uses it: `detection-pipeline.resolveProbeHardware(node)` — pins to
`node` when it differs from the local node, so a remote agent's offered engine
devices reflect ITS hardware (e.g. an N100 has no NPU) instead of the hub's.

---

## 7. Store / settings facts worth pinning

- `settings-store` is `scope: 'system'`, `mode: 'singleton'` → **hub-resident**.
  Every node's `ctx.settings` reads/writes the same central blob.
- Per-node keys are persisted node-scoped (`<key>@<nodeId>`), never bare. The
  engine cascade that introduced the pattern is retired (see §5); live users are
  `probedBestHwaccel` and `probedBestAudioBackend`.
- `getGlobalSettings` returns `null` ("keep last-known") only when the store is
  genuinely UNREADABLE — an empty store is a harmless first boot, and there is no
  longer a persisted engine selection to protect. The UI keeps the last good
  value on `null`.

---

## 8. Hard-won lessons (don't re-learn these)

- **Agent addons are UDS-only.** No per-addon Moleculer service exists for them.
  Verify with a live `getServiceList` dump before assuming a `${addonId}.*` action
  is reachable. (Set a temp `process.stderr.write` of the service list in the
  router and read `docker logs`.)
- **Singleton caps default to the hub.** To hit another node's singleton, you
  need an explicit nodeId pin AND a transport that forwards it (`agent-child-forward`
  via `$agent-cap-fwd`, whose `inProcessLookup` resolves the agent's in-process
  provider). There is no "call this singleton on node X" without a pin.
- **`op.context` flows through the tRPC link chain** (verified end-to-end against
  the real `@trpc/client` v11). It is the correct channel for per-call metadata
  that must NOT pollute validated args.
- **The hub is a `br0` container** (`<hub-ip>`), not host-published. Probe it
  from the Mac → `.9`, or `docker exec CamStack curl 127.0.0.1:4443`; host
  loopback never reaches it.
- **Login for live tRPC:** `POST /trpc/auth.login {username,password}` (the admin
  JWT secret rotates on greenfield, so a stale `.env` token may 401 — log in
  fresh instead).
- **The cap name on the wire is DERIVED, not carried.** `ctx.api.<key>` is a tRPC
  proxy keyed by `kebabToCamel(cap.name)`; `parsePath()` in `trpc-links.ts` turns
  that key back into a cap name with `toKebab()` before it reaches
  `ipcParentLink` → `onUnownedCall` → the resolver. That inverse only holds for
  kebab-case names, which is why cap names must be kebab
  ([D114](../decisions/adr-0114.md), `scripts/check-cap-name-kebab.ts`). It
  cannot be replaced by the generated key→name map: `trpc-links.ts` is inside the
  addon-runner closure, where a `@camstack/types` barrel value-import is refused
  ([D28](../decisions/adr-0028.md)). Consequence to remember when reading a
  resolver miss: **if the cap in the error message is not spelled the same as the
  cap in the "Provider registered" line, it is this, not a boot-window race.**

---

## 9. File map

| Concern | File |
| --- | --- |
| Cap route classification | `packages/system/src/kernel/transport/cap-route.ts` |
| Cap route resolver + dispatch + `$agent-cap-fwd` wire | `…/transport/cap-route-resolver.ts` |
| tRPC links (local / ipc-parent / broker) | `…/moleculer/trpc-links.ts` |
| Forked addon `ctx.api` construction | `…/moleculer/addon-context-factory.ts` |
| Parent routing of a child's unowned call | `…/transport/parent-unowned-call.ts` |
| UDS wire messages (`cap-call-out` etc.) | `…/transport/child-cap-protocol.ts`, `local-child-{client,registry}.ts` |
| Agent-side cap forward service | `server/backend/src/agent/agent-cap-dispatch-service.ts` |
| Per-call node pin | `packages/types/src/cap-call-context.ts` (`nodePin`/`readNodePin`) |
| Addon-level (settings/routes/custom) gateway | `server/backend/src/core/addon/addon-call-gateway.ts` |
| Engine per-node store keys | `packages/addon-pipeline/src/detection-pipeline/engine-store-keys.ts` |
