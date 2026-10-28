---
title: Transport and cross-node routing
applies-to:
  - packages/system/src/kernel/transport/cap-route-resolver.ts
  - packages/system/src/kernel/transport/cap-child-index.ts
  - packages/system/src/kernel/transport/frame-codec.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/local-child-client.ts
  - packages/system/src/kernel/transport/hub-cap-forward.ts
  - packages/system/src/kernel/transport/cap-routing-hints.ts
  - packages/system/src/kernel/transport/socket-channel.ts
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - packages/system/src/kernel/moleculer/addon-context-factory.ts
  - patches/moleculer+0.15.0.patch
  - server/backend/src/api/trpc/core-cap-bridge.ts
  - server/backend/src/api/trpc/trpc.context.ts
  - packages/system/src/kernel/moleculer/mesh-identity.ts
  - packages/system/src/kernel/moleculer/mesh-access-middleware.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/pairing/pairing-protocol.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/pairing/agent-pairing.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/pairing/hub-pairing.ts
  - server/backend/src/core/moleculer/hub-mesh-guard.ts
  - server/backend/src/agent/agent-mesh-gate.ts
  - server/backend/src/agent/agent-pairing-routes.ts
  - server/backend/src/api/core/agent-pairing.router.ts
  - server/backend/src/agent/agent-hub-registration.ts
  - server/backend/src/core/moleculer/agent-registration-request.ts
  - packages/system/src/kernel/moleculer/agent-event-scope.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/tls-tcp-transporter.ts
  - scripts/bench-frame-decoder.mts
  - scripts/bench-moleculer-tcp-parser.mts
  - scripts/bench-uds-relay.mts
covers:
  - packages/system/src/kernel/transport/**
  - packages/system/src/kernel/moleculer/**
last-verified: 2026-10-16
---

# Transport and cross-node routing

> The authoritative deep dive is
> [`docs/design/transport-and-cross-node-routing.md`](../design/transport-and-cross-node-routing.md)
> — **required reading** before touching `kernel/transport`, `kernel/moleculer`,
> the agent code, or addon capability plumbing. This page is the orientation.

## The claim being made

A caller writes `ctx.api.<cap>.<method>.query(...)` and gets an answer. It does not
learn, and must not depend on, whether the provider was in the same process, in a
sibling process on the same machine, or on a different machine.

That is the whole design. Everything below is what it costs.

## Two tiers, not one

| Plane | Transport | Who |
| --- | --- | --- |
| hub ↔ hub-local addon child | **UDS + MsgPack** | `LocalChildRegistry` (parent) ↔ `LocalChildClient` (child) |
| hub ↔ remote agent | **Moleculer** | the cluster mesh |

There is **no per-addon Moleculer broker**. Addons run broker-less; a child reaches
the hub, and its siblings, over the UDS channel, and the parent routes a child's
unowned capability calls via `onUnownedCall`. Moleculer exists only for the
inter-node hop.

Agent addon runners expose **no per-addon Moleculer service** — only
`$agent-cap-fwd`, whose exact symmetric inverse on the hub side is
`hub-cap-forward.ts`. The design doc explains why; the short version is that
per-addon services multiply the mesh registry by the addon count for no routing
benefit.

## Resolving a route costs nothing the second time

`LocalChildRegistry.resolveChildId` answers `(capName, deviceId?) → childId` on
every `cap-call-out`. It used to walk every connected child and, for each,
every descriptor in its cap manifest — **7.1 % of hub-main's busy main thread
(1 259 ms of 17 687)** across 39 children, which after [D448](../decisions/adr-0448-a-sibling-call-crosses-the-parent-as-an-envelope-and-an-opaque-tail.md) was larger than
all of msgpack put together, and the decoded sibling branch paid it twice by
resolving and then calling `callCap`, which resolved again.

It is now a derived index (`cap-child-index.ts`), and the important half of
that is what makes it safe rather than what makes it fast:
`buildCapChildIndex` is a **pure function** of `children.values()`, the
registry drops it in the same statement as every write to that map (a register
— which replaces a manifest wholesale — and a delete on a close that was not
superseded), and there is no incremental path that could disagree with the map.
The map stays the single authority; the index holds no fact it does not
([D3](../decisions/adr-0003.md) — a maintained index would be a shadow
registry, and a stale one routes work into a socket nobody is reading).

Two things are deliberately NOT in it. The operator's `setActiveSingleton`
preference changes without any child connecting or leaving, so it is read live
and the index supplies only the ordered candidate list. And the two tiers stay
separate — a device lookup is never answered from a deviceId-less descriptor —
because `resolveChildId` owns the fallback between them
([D457](../decisions/adr-0457-reassembly-never-re-copies-what-it-is-holding-and-a-route-nobody-changed-is-not-recomputed.md)).

## The link chain

A FORKED addon's chain:

```
localProviderLink → ipcParentLink → onUnownedCall → CapRouteResolver
```

Each link answers "can I serve this myself?" and passes on if not. In-process
providers are matched first, at zero cost, which is what makes the `detection`
co-location group ([D9](../decisions/adr-0009.md)) fast rather than merely
co-resident.

An **in-process** addon's chain does not end at a parent, and that is a real
difference rather than a simplification:

```
localProviderLink → deviceCapResolverLink → brokerTransportLink
```

The middle link exists because the two ends cannot reach a forked device
provider between them. Forked children are broker-less, so hikvision's `ptz`
advertises nothing on the Moleculer bus; no candidate matched and the call fell
through to the `<cap>.<cap>.<method>` shape `trpc-links.ts` documents as the
broken one — `Service 'ptz.ptz.getOptions' is not found`, logged 48 times by an
autotrack builtin that was switched on and unable to move a camera (2026-09-18).
`deviceCapResolverLink` dispatches through `callCapabilityOnNode`, the entry the
codegen cap routers already use, which extracts the `deviceId` and asks the
`CapRouteResolver` — the only authority that can route `(cap, deviceId)` into
another child.

It is narrow on purpose, in three ways worth preserving. It intercepts only caps
whose **definition** says `scope: 'device'`, read from
`ALL_CAPABILITY_DEFINITIONS` rather than a hand-written list. It intercepts only
when the call carries a numeric `deviceId`, so a system cap that happens to take
one (`deviceManager.getBindings`, `deviceState.getCapSlice`) is untouched. And a
resolver failure does **not** fall back to the broker: the resolver's error names
the node and the reason, and burying it under "service not found" is exactly how
this hid for a morning.

## Where the plane is OBSERVED, and where it is not

`nodes.getCapUsageGraph` reads hub-main's `CapUsageRegistry`, and the hub's
`LocalChildRegistry` is the only thing that writes to it — one observation per
`cap-call-out`, taken **before** the sibling/unowned branch, from the
`callerAddonId` the parent stamps off the connection the frame arrived on.

That placement is not incidental. `resolveChildId` short-circuits a cap owned by
a sibling runner straight to `callCap`, so most inter-addon traffic never reaches
`onUnownedCall` at all; and `getCapUsageRegistry()` is a **per-process** module
singleton, so the observer that `addon-context-factory.ts` gives a runner's
`localProviderLink` writes to an object hub-main cannot read. Both together are
why the graph answered `[]` on a hub running 64 addons
([D310](../decisions/adr-0310-an-observation-is-recorded-in-the-process-that-reads-it-and-names-the-plane-it-cannot-see.md)).

Three planes are therefore invisible to that graph, and an edge's absence means
"not seen here", never "did not happen": hub-main → hub-main in-process calls
(one shared `ctx.api` client, no per-caller identity), a runner's own co-located
calls, and anything originating on an agent (`$hub-cap-fwd`'s envelope carries the
agent-stamped `callerAddonId` since D787, but nothing records it into the graph).
The list lives on `LocalChildRegistryOptions.capUsageObserver`; keep it true.

## Who is calling: the caller stamp

A provider that must know its caller (today: the keychain, D787) reads
`callerAddonId` from its args, and only the TRANSPORT writes it:

| Plane | Who stamps | From what |
| --- | --- | --- |
| forked hub child → hub-main | the hub's `LocalChildRegistry` | the UDS connection the frame arrived on (`childId`) |
| child → sibling child (short-circuit) | the parent, in the `cap-call` frame | the same `childId`; the serving child writes it into the args |
| agent child → hub | the agent's `LocalChildRegistry`, carried in `$hub-cap-fwd`'s envelope | the agent child's connection; the hub drops a stamp the sending agent does not host, and the mesh gate strips any stamp — or `caller` — inside the forwarded args (D802) |
| hub in-process builtin | nobody — the caller states it (`ctx.secrets`) | the only place a claim is trusted: no wire is crossed |

`stampCallerAddonId` (`cap-route-resolver.ts`) is the one rule: a stamp
OVERWRITES whatever the args say, and a call with NO stamp has a claimed
`callerAddonId` STRIPPED. A session can never supply it either: no input schema
declares the field, so the tRPC router's parse drops it. A grouped runner is
stamped with its group id, not the addon id. This is identity against bugs and
misrouting, not against a malicious addon (every runner is the same OS user,
and a `childId` is self-declared at `register`).

## Four route kinds

`CapRouteResolver` (`packages/system/src/kernel/transport/cap-route-resolver.ts`)
classifies every `(cap, node, device)` triple into exactly one:

| Kind | Meaning |
| --- | --- |
| `hub-in-process` | provider lives in this process |
| `hub-local-uds` | provider is a hub-local addon child |
| `remote-moleculer` | provider is on another node |
| `agent-child-forward` | provider is an addon child *of* another node |

When resolution fails, the resolver reports which candidates it rejected and why
(`{ kind: 'hub-local-uds', why: 'UDS registry not available' }`). Read that before
theorising about a missing capability.

A provider that REFUSES by throwing is not a routing failure. `dispatch` wraps a
throw as `CapRouteError{reason:'transport-failed'}` ("not routable to node …")
only when nobody answered — channel closed, request timed out. A throw from an
`hub-in-process` provider, or a `PeerAnsweredError` (what `SocketChannel`
rejects with when the far end answered `ok:false`), propagates with the
provider's own sentence. Until 2026-09-25 every throw was wrapped, and a PTZ
Home refused for "no home preset configured" reached the operator as "not
routable to node hub/provider-amcrest". The two mesh kinds still wrap every
error: a Moleculer error restored from a remote answer is not yet told apart
from a local timeout.

## A channel identifies an INCARNATION, not a child

`childId` is reused across process generations — `resolveRunnerId` is
deterministic, so a replaced runner reconnects under the same id. Until
2026-08-20 `channel.onClose` did `children.delete(childId)` blind, so the
PREDECESSOR's socket close evicted the live successor and fired `onChildGone`;
the hub then read the successor's manifest and unregistered every capability in
it. Recording was absent for ~7 hours from a process that never stopped writing
segments
([D188](../decisions/adr-0188-an-unregister-carries-proof-of-ownership.md)).

Every connection therefore carries a monotonic `RegisteredChild.incarnation`,
the parent stamps it onto what it derives from the child, and the close of a
channel that is no longer the registered one is **ignored and logged** (`ignoring
close of a superseded local child connection`, plus `local child superseded by a
new connection` at handshake — a generation change is never silent again). The
ordering that produces the bug cannot be scheduled away, and de-registering the
old runner first was rejected: it trades a rare long outage for a short one on
every single update, on a path where absence is what the caller sees.

### A runner's lifecycle is said by the registry

A forked runner has no Moleculer broker, so `$node.connected` /
`$node.disconnected` never fire for it, and until 2026-10-02 nothing emitted
`WorkerOnline` / `WorkerOffline` for one (every consumer was dead for every
forked runner). The parent's `LocalChildRegistry` is the liveness source for
its children, and with `lifecycleEvents` (wired by the hub and every agent) it
says so on the node's kernel bus, keyed `<node>/<childId>`:
- `WorkerOnline` at a new INCARNATION's first register — the pre-init frame of
  `LocalChildClient.start()`, before the runner loads any addon, emitted before
  that frame is acked. A re-register of the same connection says nothing.
- `WorkerOffline` after the LIVE connection's teardown; a superseded
  connection's close says nothing, for the reason above. On the HUB the
  teardown (`removeNodeFromRegistry`) is synchronous, so the hub's registry no
  longer holds the child when the event fires. On an AGENT it is not: the
  agent's `onChildGone` triggers an ASYNC upward registration, so the hub can
  hear `WorkerOffline <agent>/<child>` before its own registry drops that
  child. A consumer that re-reads the registry on the event may still see it
  once (harmless for the D696 provider gate, whose providers are hub-only).

This is the existing liveness signal surfaced, not a re-implementation of one.
The events are telemetry (D8): a consumer must survive a dropped one.

## Per-call node pinning

Some capabilities are registered by every node — a platform probe, an LLM runtime,
a server-management surface. Targeting one node is a **transport** concern,
expressed as `nodePin(nodeId)`, not a `nodeId` field threaded through the payload.

The exception is real and documented per capability: `pipeline-orchestrator` takes
`nodeId` as *data* because it configures a node rather than asking one. A `nodePin`
context is ignored there, deliberately.

## Per-call PROVIDER pinning, on the mesh dispatch too

A node pin picks the host. A `{ provider }` pin picks *which implementation of a
collection cap* answers, and it has to be honoured at the transport and not only
at the hub's tRPC mount ([D593](../decisions/adr-0593-a-provider-pin-is-honoured-where-the-dispatch-happens.md)).
A cross-process addon never reaches that mount: `ctx.api.<cap>.<method>` leaves
its runner over Moleculer, and `resolveBrokerCapCall` used to take
`candidates[0]` — the broker's discovery order. `videoclips` has three providers
on this hub, so one operator clip tap was answered by `recorder` ("an analytics
visit has no file behind it") and, after a redeploy in a different order, by
`export-hap` ("was not minted by the HomeKit source"): the same clip, two
different wrong answers, while the call named the provider the whole time.

`narrowToPinnedProvider` narrows the candidates to the named service — Moleculer
service names map 1:1 to addon ids — and **refuses an unanswerable pin by name**,
listing the candidates, rather than letting a sibling answer it. The provider pin
picks the service, the node pin then picks the host among that service's nodes,
in that order. Two deliberate limits: it engages only when the choice is
genuinely ambiguous (≥2 distinct services), because `provider` is an ordinary
parameter name on single-implementation caps; and **unpinned calls are
unchanged**, because "which provider should an unpinned cross-process collection
call reach" is a separate question that would change 44 capabilities at once.

The resolve step is wrapped so a refusal reaches `observer.error`. It ran in a
bare `void (async …)()`, so a throw escaped the observable and the caller never
settled — the two refusal tests did not fail, they *timed out*. A branch that
drops the caller's work says so through the caller's own channel.

## Asking for the NATIVE, not the wrapper

A wrapper cap and the per-device natives it delegates to share ONE name. Inside
hub-main that is harmless: the wrapper resolves the native through the
`CapabilityRegistry`, which distinguishes them. From a runner it is not, because
both routes out of the process resolve by NAME — `localProviderLink` answers
from the runner's own provider without touching the socket, and the parent's
`resolveChildId` falls back to a deviceId-less descriptor, which for a wrapper
is the wrapper's own child. A forked wrapper asking for its native therefore
calls itself, and the re-entrant call waits on a single-flight promise only the
outer call can settle. Silently.

So the intent travels out of band, like a node pin: `ctx.getNativeProvider` in a
UDS runner emits a `cap-call-out` with `native: true`. `LocalChildRegistry`
refuses to short-circuit it to any sibling, and `onUnownedCall` answers from
`CapabilityRegistry.getNativeProvider` — one authority covering in-process
natives, hub-local vendor children and remote agents. No native for that
`(cap, device)` rejects; it never falls back to name routing. Wrappers read that
rejection ("no native provider for capability …") as ABSENT and run their own
strategy, so the wording is part of the contract
([D123](../decisions/adr-0123.md)).

One more intent wins over a co-located provider, and over name routing
altogether: a `getStatus` about a device whose cap is CLAIMED (D663, ruling S3)
is answered from the hub mirror's merged slice, and the owning runner — whose
`getStatus` is the NATIVE slice — is never asked. There is no single chokepoint
for calls that resolve a cap by name, so each of the three entries asks the hub's
claim authority (`CapabilityRegistry.resolveClaimedStatus`) through the ONE
shared `answerClaimedGetStatus` (`transport/claimed-get-status.ts`) before it
resolves: `LocalChildRegistry`'s sibling short-circuit (an HA-MQTT / HomeKit
exporter or the notification center, hub-local forked children, calling a device
owned by the hub-local `provider-homeassistant` child — the case that carried the
live traffic and that a hook in the handler alone never saw), the parent's
`onUnownedCall` (no sibling owns it: a remote agent's device, a hub-in-process
cap, an agent's forward through `$hub-cap-fwd`), and the hub's own
`callCapabilityOnNode` (every tRPC call with a `nodeId` pin — the generated
`DeviceProxy` always sends one — and every hub in-process addon's `ctx.api`
device-cap call through `deviceCapResolverLink`). A node pin does not bypass it.
A device whose claims are not yet known has them resolved first and is never
answered native; one whose row cannot be read is `null`, "not reported".
`scripts/check-claimed-get-status.ts` fails a production file that calls
`resolveCapRoute` / `resolveChildId` / `callCapOnChild` without asking, so a
fourth entry cannot be added quietly. The agent's handler and registry have no
claim authority: a hub-hosted cap still reaches the hub's entries, but an
agent-resident child asking an agent-resident device is answered by the agent's
local dispatcher with no hub round-trip — a known gap, recorded in D663.

## Who may talk to the hub: the mesh gate (D802, D857)

Every action and event another Moleculer node sends to the hub passes one
broker middleware, `createMeshAccessMiddleware`
(`packages/system/src/kernel/moleculer/mesh-access-middleware.ts`), installed
when the hub broker is built (`HubMeshGuard`,
`server/backend/src/core/moleculer/hub-mesh-guard.ts`). Calls the hub makes to
itself (`ctx.nodeID` = `hub`, which includes everything its UDS runners route
through the broker) are not touched.

**The identity is the certificate (D857).** There is no shared secret and no
join. A node is admitted when its mutual-TLS handshake chained to the mesh CA,
its leaf CN is the node id it speaks as, and the serial is not on the CRL. The
transporter enforces the first two on every packet (a TLS packet whose `sender`
is not the peer CN is dropped) and answers the third:
`TlsTcpTransporter.verifiedPeer(nodeId)`. `MeshIdentityGate`
(`mesh-identity.ts`) only turns that answer into allow or deny, and holds no
state, so a revocation takes effect on the next packet and nothing waits for a
handshake-after-the-handshake.

**The verdict per remote action** (`MeshIdentityGate.admitCall`):

| Action | Node without a verified certificate | Node with one |
| --- | --- | --- |
| `$process.*`, `$node.*`, `$hub.setLogLevel` | refused | **refused** — never from another node |
| `$hub.registerNode` | refused | allowed (itself only) |
| `$hub.unregisterNode` | refused | itself only |
| anything else | refused | allowed |

Events from a node without a certificate are dropped (one rate-limited line per
node). `$hub.joinChallenge` and `$hub.authenticateNode` no longer exist: an agent
older than D857 reads "no such action" as "the hub predates the join" and goes on
(its `registerNode` hash is ignored; its certificate admits it).

**Forged identity is stripped.** Before the handler runs, a remote request
loses `caller` (the user identity the tRPC router injects for
`caller: 'required'` methods — `keychainAdmin.reveal` reads it) and
`callerAddonId` from its params; for `$hub-cap-fwd.forward` they go from the
forwarded `args`, and the envelope's `callerAddonId` stays subject to the
manifest check below. `$hub-cap-fwd` also drops `args.caller` itself
(`stripForwardedCaller`), so the forward path holds without the middleware.
Every hub in-process addon is ALSO a raw Moleculer service
(`createAddonService`: `keychain.keychain-admin.reveal`, …) — the middleware is
what covers those.

**Agent inbound (same middleware).** Each agent broker installs
`createMeshAccessMiddleware` with `AgentMeshIdentityGate`
(`server/backend/src/agent/agent-mesh-gate.ts`): only the hub, verified by the
certificate the agent's own TLS listener checked, may call it. An agent that is not
paired holds no certificate and admits no mesh peer. Unlike the hub gate,
`$process.*` stays callable from the certified hub (topology polls `$process.list`);
`$node.*` is refused for everyone. Nothing is held while a join settles (D848 §3 is
gone with the join): the hub is recognised from its first packet.

**The registration follows the hub's connection, and the hub asks for it.** The hub drops a
node's registration on every `$node.disconnected` IT sees, and Moleculer raises
that on one side only — a third node's gossip, a failed write, a late heartbeat.
The agent therefore re-sends its full manifest (one atomic `$hub.registerNode`)
every time the hub node connects (`agent-hub-registration.ts`), and the hub calls
`$agent.requestRegistration` on every agent `$node.connected`
(`agent-registration-request.ts`). If the hub refuses the registration because it
does not accept the agent's certificate (revoked, issued by another CA) the agent
reports `certificate-rejected` and keeps retrying until it is paired again. An online
agent the hub holds no registration for is reported (`nodes.topology`
`capabilitiesRegistered: false`), never silently capless. Proven in
`agent-registration-rejoin.cluster.spec.ts` (2026-10-14: the D848 rollout left two
agents online with zero capabilities).

## An enrolled agent talks to the hub only (D848)

The cluster's agent-side mesh is a star. Nothing an agent needs comes from
another agent: it has no `CapRouteResolver` and forwards every unowned cap call
to `$hub-cap-fwd`, its runners are UDS-only, and every packet a peer agent sent
was refused by the receiving gate anyway. So:

- **Events** — `createAgentMeshGate` puts an outbound `transitPublish` gate
  (`agent-event-scope.ts`) on every agent broker: an EVENT packet to any node but
  the hub is not written (counted per peer, one log line per peer). Until
  2026-10-13 every agent's telemetry went to every peer too (~3,000 events/min
  each, all refused on arrival).
- **Connections** — an agent with a mesh leaf builds its `TlsTcpTransporter`
  with `hubOnlyPeers`: no clear TCP reader, a TLS listener that keeps only the
  hub's certificate (a peer's leaf from the same CA is refused after the
  handshake), a writer that dials only the hub, and a gossip filter that adopts
  no node but the hub from the hub's gossip. Agents therefore never learn, dial
  or broadcast to each other. The TLS-only hub dials every peer on mTLS.
- **Ports** — a TLS-listening node puts its listen port in the gossip HELLO it
  sends on connect (`meshTlsPort`); the dialler uses it, else 6443. An enrolled
  agent listens on `agentTlsListenPort` (default 6443), so two nodes on one host
  (tests, a dev cluster) no longer collide.

Proven on a real hub + two enrolled agents in
`agent-mesh-isolation.cluster.spec.ts` (`npm run test:cluster -w server/backend`).

**What mutual TLS closed** ([plan](../design/2026-10-09-mesh-mtls-plan.md),
D826, D848): every mesh socket of an enrolled cluster is TLS 1.3 with the
sender bound to the certificate CN. An agent without a mesh leaf still speaks
clear text and can reach only a pre-D826 hub; there a self-declared sender id
remains spoofable.

## A core router reached over the mesh: `mesh` or `node:<id>`

The hub's CORE routers — the hand-written single-impl ones plus the
service-backed cap routers — have no addon provider, so nothing publishes a
Moleculer service for them and a forked addon's `ctx.api.<coreCap>.<method>`
would fall through to `brokerTransportLink`'s deadline-less discovery wait and
hang forever. `buildCoreCapService`
(`server/backend/src/api/trpc/core-cap-bridge.ts`) closes that: it walks the
appRouter, picks the core namespaces, and republishes each query/mutation as
`$core-caps.<kebab-cap>.<method>`, which `brokerTransportLink` then routes like
any other cap.

The tRPC caller behind that bridge is built from `createMeshTrpcContext`
(`server/backend/src/api/trpc/trpc.context.ts`) with a principal naming the
origin (D802): `mesh` for the hub's own runners, `node:<nodeId>` for another
node — an id the mesh gate has bound to a proof (in `transition`, possibly only
claimed). Both are still **admin principals** that skip the scope matcher; what
another node may not reach is decided by the bridge: `repl` is not bridged at
all (it executes code in the hub), and `logs` / `addonSettingsRaw` are refused
to `node:<id>` (`REMOTE_DENIED_NAMESPACES`). Narrowing `node:<id>` to a per-method grant is enforced in
`core-cap-bridge.ts`: `REMOTE_PRIVILEGE_ALLOWLIST` names the dotted procedure
paths another node may call (census-seeded); anything else is refused with
`CORE_CAP_REMOTE_FORBIDDEN`, with one hub warn per `(nodeId, path)` per process
before the throw. Set `REMOTE_PRIVILEGE_LOG_ONLY` to log non-grant calls without
refusing (measurement mode). Two things follow, and both matter:

- Tightening a core router to `adminProcedure` never regresses an addon caller.
  That is what made it safe to close the `eventBusProxy.emit` and
  `addonSettingsRaw.*` leaks — both were reachable by any authenticated
  non-admin token and both are reached by addons over this mesh.
- **tRPC auth is not a boundary between addons.** Anything on the mesh is
  admin; never rely on a procedure's tier to protect an addon-facing surface.

`auth` is deliberately NOT bridged: minting service or scoped tokens over the
trusted mesh would let any forked addon issue itself admin credentials. `live`
and `systemEvents` are excluded for a different reason — they are hub-only push
streams, and `NEVER_BRIDGED_CAPS` in
`packages/system/src/kernel/moleculer/trpc-links.ts` fast-fails them on the
worker side.

## Mesh and HTTPS certificates of a node (D856)

The hub records every mesh leaf it issues in `mesh_node_certificates`, and a node
enrolled before that existed from the leaf it presents on its live connection
(`TlsTcpTransporter.peerLeaf`). Revoked serials are persisted there and replayed
into the CRL at boot. Two operator actions, both through `certificates.*`:

- **Renew** (`renewMeshOnNode`) is a hand-over, never a blind swap: the node makes a
  new key and CSR, the hub signs and records it, the node persists it beside the old
  leaf and reconnects, the hub waits until it SEES the node with the new leaf, and
  only then is the old serial put on the CRL. A failed swap keeps the old leaf (and the
  node rolls back by itself if no confirmation arrives).
  A reconnect replaces the broker's TRANSPORT in place (`broker-transport-swap.ts`); the
  broker, its services (`$agent`, `$process`, `$agent-cap-fwd`) and the forked child runners
  survive it, and the hub's reconnection re-sends the whole subtree in one `registerNode`. The hub
  confirms only on a registration that carries the addons the node had before (D856 amendment).
- **Revoke** (`revokeMeshOnNode`) puts the serial on the CRL and closes the node's
  sockets; the node must be paired again.
  `clusterNodes.forgetNode` stays the way to remove a node.

The hub reaches a node through the node-pinned `node-certificates` capability,
provided by the agent runtime like `server-management`. An agent's API port also
serves HTTPS on the SAME port (the first byte picks the protocol), with a leaf the
hub signs from its local CA for the agent's private addresses and local-only names
(only those the CA's name constraints permit, D873);
`renewHttpsOnNode` re-issues it and the agent hot-swaps it without a restart.

**Operator procedure, one node (renew both, verify both).**
1. System -> Identity -> Certificates -> HTTPS -> the node -> Renew. Verify on the
   hub: the row shows the new leaf fingerprint and expiry; on the node:
   `openssl s_client -connect <node>:4444 -servername <node> </dev/null | openssl x509 -noout -fingerprint -sha256 -enddate`
   prints the same fingerprint and `<dataDir>/tls/agent.crt` has the same one (the key
   lives in `<dataDir>/tls/agent-https.json`, mode 0600, with the leaf and the pinned CA).
2. Mesh -> the node -> Renew. Verify on the hub: the node's row shows a new `current`
   leaf (`issuedVia: renewal`), `presentingCurrent: true`, and the old one under history
   as `revoked`; its serial is in `revokedSerials`. On the node: `agent.json` has a new
   `meshTls.certPem` and no `meshTlsPrevious`; the agent log has `Mesh leaf swap:
   confirmed by the hub`, and the hub log has `Mesh renewal: done` for the node id.
3. A failure says which stage failed and `keptPreviousLeaf: true`; nothing was
   revoked, and the node still works on its previous leaf.

## Pairing an agent (D857)

An agent holds no secret and is given none. The hub starts a pairing and the
operator confirms the SAME six digits on the hub and on the agent's own page.

```
hub                                   agent (unpaired, plain HTTP :4444)
 | GET  /api/agent/pairing/hello  ------------->| { nodeId, state, version }
 | POST /api/agent/pairing/offer  ------------->| mesh CA cert, commit = H(caFp | hubNonce), hubUrl, hubMeshAddress
 |<---------- { pairingId, CSR, agentNonce } ---| the mesh key is made on the agent; TTL 5 min
 | POST /api/agent/pairing/reveal ------------->| hubNonce (the agent checks the commit)
 | code = 6 digits of H(caFp | agentPublicKey | hubNonce | agentNonce), on BOTH sides
 | the operator types the code read on the agent into the hub, and the hub's into the agent
 | POST /api/agent/pairing/complete ----------->| leaf + ES256 proof, installed only after the local confirmation
```

- **Discovery.** Every agent advertises `_camstack-agent._tcp` on its API port (TXT
  `nodeId`, `version`, `state=unpaired|pending|paired`, `fp` once paired) —
  `AgentMdnsAdvertiser`, re-announced when the state changes. The hub browses it
  (`agentPairing.listDiscoveredAgents`) or probes a typed address
  (`addAgentByAddress`, a private/local address only). Same container contract as the
  hub's own advertisement: dedicated IP or host networking, not Docker bridge.
- **Commit–reveal** keeps a man in the middle from grinding a CA whose code equals the
  real one (the code is 20 bits). A wrong code three times cancels the pairing on the side
  it was typed into; expiry or a rejection on either side cancels both.
- **Order does not matter.** The hub learns the agent confirmed by polling
  `GET .../pairing/status`; it completes as soon as both confirmed. The agent refuses
  `complete` (`awaiting-local-confirmation`) until its own operator confirmed, and
  verifies the proof with the CA it was OFFERED.
- **One at a time.** A second hub is refused while one is pending; a paired agent refuses
  every offer; the hub refuses a node id that is already connected and revokes the older
  leaves of a node id it pairs again.
- **Surface.** An unpaired agent's `:4444` serves only these routes, health and the static
  UI to the network; every other `/api/` route needs loopback or a session redeemed from a
  hub unlock ticket (ES256 by the mesh CA key, verified against the CA the agent pinned).
- **Boot mode.** An unpaired agent boots `pairing-only` (`agent-boot-mode.ts`): pairing, health,
  the static UI and its mDNS advertisement, no core addon. It has no mesh transport, so booting the
  core addons would block on the hub's settings and abort in a respawn loop. Once pairing installs
  the certificate the process relaunches (D5) and boots in full. An unpaired agent still updates
  its own closure from npm (`update-and-release.md`, "An agent follows its own closure").
- **Unpair.** Hub: `agentPairing.unpairAgent` tells the agent first
  (`node-certificates.forgetHub`), then revokes every certificate and drops the sockets.
  Agent: `POST /api/agent/pairing/forget` from its machine or a hub-unlocked session.
  Both leave the agent unpaired and advertising.

There are no join tokens (D857): a certificate comes only from a pairing. "Loopback" on the
agent means a loopback peer with a local Host, no foreign Origin and a JSON content type on a
mutation; a relay on the same host (socat, `ssh -R`, a port-forward) defeats it, so none may run
on :4444. An unpaired agent has no mesh reader at all (hub-only TLS transporter, no material), and
the transporter drops any packet whose sender is missing or is the receiver itself.

## Mesh UDP discovery is gone (D804, D826, D843)

Until D826 the hub announced `<namespace>|hub|<tcpPort>` over UDP 4445 and an
agent with no `hubAddress` heard it and dialled the hub. D826 turned the hub's
announcement off; D843 removed the agent's listening side. An agent with no
hub address now dials nobody and reports `unconfigured`; its local UI lists the
hubs found over mDNS (below); it is paired from the hub (D857), never by pasting a secret.
Nothing in the mesh uses UDP 4445 any more — close it in firewalls.

## Clients find a hub over mDNS, not the mesh channel (D838)

D826 turned the mesh UDP announcement off on every hub, so `camstack login` and
`camstack discover` no longer listen to it. The `local-network` builtin
advertises one `_camstack._tcp` mDNS service for the hub's HTTPS endpoint
(`@homebridge/ciao`; TXT `nodeId`, `version`, `role=hub`, `url`; the address is
the `internal` role of the address book, never ranked again). The CLI browses it
(`multicast-dns`) and unions it with the hubs the machine knows — cached
sessions, `$CAMSTACK_HUB_URL`, `scratchpad/.hub-url`
— probes each on https, dedupes by host:port, and picks (one) or asks (several,
with each source and an "Enter an address…" entry). Agents never advertise it.

**Container contract:** mDNS needs UDP 5353 multicast to reach the LAN, so it
works with a dedicated container IP (Unraid br0 / macvlan) or host networking
and NOT in Docker bridge mode. Without it the hub is simply not announced:
`camstack login --server https://<host>:<port>` still works, and a hub the
machine already knows is still offered. The `mdnsAdvertise` setting on the
local-network addon turns the announcement off.

The agent's local UI uses the same browse (D839): `GET /api/agent/hubs-found`
(cached) and `POST /api/agent/hubs-found/refresh` (a bounded scan) list the mDNS
hubs plus the configured hub address, each probed on https, and the page's
"Hubs found on this network" select fills the hub-address field. The browse
lives once in `@camstack/develop/hub-discovery`; the CLI imports the same module.
An agent joins by being paired from that hub (D857). An agent updates an addon
only by asking the hub to bring the package to the hub's version (D840): the
hub's installed version is what each reconnect restores.

## Rules that follow

- **Everything over tRPC.** Every capability is reachable via `AddonContext.api`.
  Only the `$hub.*` / `$agent.*` node-registration handshakes remain raw infra RPC
  ([D3](../decisions/adr-0003.md)).
- **`ctx.api` is the only cross-addon layer — even for existence checks.**
  `ctx.capabilities` is the *local* registry of the calling addon's runner: it sees
  only providers in the same process. To check whether something exists elsewhere,
  use `ctx.api.capabilities.listProviders.query(...)`. Reserve `ctx.capabilities`
  for self-lookup and kernel boot plumbing.
- **Do not re-implement discovery or liveness.** `$node.connected` /
  `$node.disconnected` and `broker.waitForServices` already exist. A timer added to
  "wait for a node to be ready" is a bug even when it works.
- **No `process.send` for business logic.** Parent↔child business traffic goes over
  the UDS capability and event channels, never raw IPC messages.
- **Transparency is not free.** The signature is identical for a boolean and a 4 MB
  frame; the machine's behaviour is not. See
  [data-planes.md](data-planes.md) and [D9](../decisions/adr-0009.md).

## What a large payload costs on this plane

`FrameDecoder` (`packages/system/src/kernel/transport/frame-codec.ts`) reassembles
every UDS frame, and a socket delivers a multi-megabyte payload in kernel-sized
pieces. It used to accumulate with `Buffer.concat` **per chunk**, which is
quadratic: a 4 MiB native crop arriving in 64 KiB chunks copied ~128 MiB
synchronously on hub-main. It now keeps pending chunks in a list and concatenates
once per completed frame — and not at all when a frame arrives whole. Measured
with `scripts/bench-frame-decoder.mts`: an 8 MiB frame in 64 KiB chunks went from
32.3 ms to 0.86 ms; a 4 MiB frame in 16 KiB chunks from 58.6 ms to 0.85 ms.

The wire contract did not change — 4-byte big-endian length, then that many
MsgPack bytes — and there is still **no upper bound on a declared length**. An
oversized prefix parks bytes until the peer completes or the socket closes.
Bounding it is a protocol change, not a decoder cleanup.

## What a large payload costs on the MESH plane

The same defect, in a library, on the other tier. Moleculer's TCP transporter
`Parser._write` accumulated a partial packet with `Buffer.concat([this.buf,
chunk])` **plus** `Buffer.from(packet)` — two full copies of the pending
remainder — once per socket chunk. Quadratic in the chunk count, and measured
as such rather than assumed: `scripts/bench-moleculer-tcp-parser.mts` on one
4 MiB packet reads 8.26 ms at 64 KiB chunks, 17.03 at 32 K, 33.57 at 16 K,
65.18 at 8 K, 132.61 at 4 K — halving the chunk size doubles the time. The
profile put it at **20.8 % of hub-main's busy main thread**, and it is the
cross-node mesh, never UDS.

It now holds pending chunks in a list and concatenates once per completed
packet — 0.15 ms for that same 4 MiB / 64 KiB case, and FLAT across chunk
sizes. The fix lives in `patches/moleculer+0.15.0.patch` because `moleculer` is
**bundled** into `@camstack/system/dist/index.js` at build time, so the patch
ships inside the published closure; it is not a runtime dependency on the hub
and there is no `patches/` directory there. A new transporter was rejected —
there are exactly two transports and a 25-line accumulator is not a reason to
add a third.

Two things about that sentence cost a session
([D478](../decisions/adr-0478-a-patch-reaches-production-only-if-it-is-bundled-or-applied-in-the-closure.md)).
It is TRUE — re-verified 2026-09-12 in the published
`@camstack/system@1.2.224` tarball and in the live closure on hub and agent —
but the closure also carries an unpatched `node_modules/moleculer`, which one
file requires for `Errors` alone and which frames nothing, so grepping THAT
copy reads as a missing patch. And the marker has to be
`rest.buffer.byteLength`, never the `pinsTooMuch` identifier the patch spells:
rolldown inlines a single-use const, so that name is absent from every bundle
including the correct ones. The asymmetry to remember is that `werift`, on the
other data plane, is deliberately NOT bundled and therefore did NOT ship its
patch; `patches/patch-reach.json` now states per patch which of the two it is,
and `scripts/check-patches-reach-production.ts` checks the claim.

What is big enough to split into many chunks is two senders, by design:
`pipelineRunner.getNativeCrop` with `encodeJpeg` (the cross-node compressed
fetch, [D9](../decisions/adr-0009.md) / D18) and `pipelineRunner.runStatelessStep`
with a full-frame `frameJpeg` (D54), both base64, under a 10 MiB
`maxPacketSize`. That is an enumeration from the contracts; the live size
distribution on the mesh is **not instrumented** — `meshQueued=` says what is
waiting to be written, nothing says what arrives
([D457](../decisions/adr-0457-reassembly-never-re-copies-what-it-is-holding-and-a-route-nobody-changed-is-not-recomputed.md)).

## A sibling call crosses the parent as an envelope and an opaque tail

Until 2026-09-11 a child↔child frame was decoded and re-encoded by the parent
router — args in, message rebuilt, args out, and the same for the answer. The
decoded-audio plane alone (broker → hub → orchestrator → hub → analyzer,
~5 967 chunks/min at ~13.5 KB) was **340 of the ~470 MB/min** hub-main moved
over UDS, decoded and re-encoded twice
([D446](../decisions/adr-0446-every-outbound-queue-hub-main-writes-to-is-on-the-heartbeat-and-a-held-one-is-named.md)),
and 79 % of child requests on the live hub are sibling-routed.

Now the sender packs `args` once and sends them as the frame's LAST msgpack
key, `pl`, a `bin` tail after the envelope (`encodeFrameHead` in
`frame-codec.ts`). The parent's ordinary decode yields the tail as a zero-copy
view; it reads the envelope, decides the route, and writes the view through
behind a fresh `cap-call` head under `cork()` — no decode, no encode, no copy
of the payload. The answer returns the same way (`PayloadReply`). The routing
facts the parent used to read out of `args` travel as `hints` lifted by the
sender (`cap-routing-hints.ts`): an inline `nodeId` pin, an `{ addonId }`
selector on a global collection, and — since
[D595](../decisions/adr-0595-the-routing-envelope-carries-the-pin-or-the-pin-is-decided-blind.md)
— a device collection's `{ provider }` pin together with the `deviceId` it
applies to, never one without the other, because a provider pin alone cannot say
whose sources to narrow. **A field this envelope does not carry is a field the
routing DECISION cannot see**, and that decision runs before `onUnownedCall`:
D594 taught `onUnownedCall` to honour `{ provider }` and wired
`isAddonPinnedCall` to recognise it, but `isAddonPinnedCall` is handed these
hints rather than the args, so the predicate saw `{}`, answered false, and the
call was short-circuited to a sibling before the handler written for it could
run. Correct and unreachable — the same shape `addonPinOf`'s own docblock
records for the first `addonId` attempt, reproduced a month later, on the fourth
fix of one bug. A call that leaves the sibling path (`onUnownedCall`,
`native: true`, a target that cannot take a payload) materialises the args at
that branch. Negotiated at `register` (`rawForward` both ways), additive for a
legacy peer on either side — and that negotiation is the ONLY thing that can
put a call on the decoded path. There is no switch: raw-forward is the
behaviour of every parent of this release, and the way out of a bad release
is `serverManagement.rollbackServerUpdate`, not an environment variable
([D449](../decisions/adr-0449-the-timeline-taxonomy-is-the-configured-one-raw-forward-has-no-switch-and-a-one-row-write-waits-on-the-disk.md)).

The parent stops seeing exactly one thing: the CONTENT of a sibling call's
args and result. It still counts every byte per peer (head and tail), still
reads every queue, still gates every event, still records every call on the
cap-usage graph, still bounds every method — and it now counts what it did
not read: `socketFwd=<raw>/<decoded>` on the `[mem]` line, appended last. A
`raw=0` under load is a failed negotiation. Measured in a parent process of
its own (`scripts/bench-uds-relay.mts`): −37 % to −70 % of the parent's CPU
per relayed call and −59 % to −89 % of its GC time, by shape
([D448](../decisions/adr-0448-a-sibling-call-crosses-the-parent-as-an-envelope-and-an-opaque-tail.md)).

## What the parent knows about a peer that stops reading

Every channel reports `socket.writableLength` live (`SocketChannel.queuedBytes`),
and the `[mem] hub-main` line carries it per peer on every probe —
`socketQueued=` / `socketQueuedTop=` for the UDS children, `meshQueued=` /
`meshQueuedTop=` for Moleculer's writer sockets to the agents. The mesh ones are
the reason the reading lives on the channel: `TcpWriter` **unrefs** every socket
it opens, so a census over `process._getActiveHandles()` never lists them, and
"every socket queue was excluded" on 2026-09-10 was a statement about the
ref'd subset. A queue held at or above 64 MiB for a minute is named with its
peer, peak and hold; its release — by draining, or by the socket dying — gets a
line with the same numbers. The gate terminates nothing (D446).

## Known dead path

Addon-level settings routing has a remote path that is not reachable. It is
documented in the design doc rather than removed; do not build on it.
