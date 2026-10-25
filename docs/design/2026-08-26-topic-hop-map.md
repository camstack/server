---
title: Hop map — where an argument gets lost between cap and provider
date: 2026-08-26
status: accepted
covers:
  - packages/system/src/kernel/cap-router-builder.ts
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - packages/system/src/kernel/transport/cap-route-resolver.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/local-child-client.ts
  - packages/system/src/kernel/transport/parent-unowned-call.ts
  - packages/system/src/kernel/transport/hub-cap-forward.ts
  - server/backend/src/agent/agent-cap-dispatch-service.ts
  - scripts/generate-cap-routers.ts
---

# Hop map — where an argument gets lost between cap and provider

Task 7.1 of [`plans/phase-7-topics-lost-between-hops.md`](plans/phase-7-topics-lost-between-hops.md).
No product code was touched. This document names the hops, with
file and line; where a hop is safe it says **why**.

Method: three real traces (`columns`, a pin that crosses the remote proxy, an
argument that crosses the UDS channel), and for each hop two questions —
does it **re-declare** the schema or inherit it? does it **forward** everything or name the fields one
by one?

---

## 0. The discovery that changes the plan: the generated router does NOT run

`server/backend/src/api/trpc/generated-cap-routers.ts` is **type-only**.

- `server/backend/src/api/trpc/trpc.router.ts:73` — `import type { mountAllCaps }`
- `server/backend/src/api/trpc/trpc.router.ts:351` — the value comes from
  `buildRuntimeCapRouters(...)`, cast to `ReturnType<typeof mountAllCaps>` at the
  «documented type boundary».
- `createCapRouter_*` is not invoked by any production file: the only hits
  outside the two generated files are comments in
  `server/backend/src/__tests__/cap-routers/harness.ts:86` («drop-in replacement
  for the **retired** codegen `createCapRouter_<Cap>`»).

The **live** router is `buildCapRouters` in
`packages/system/src/kernel/cap-router-builder.ts`, driven at runtime by
`ALL_CAPABILITY_DEFINITIONS`.

Direct consequence on the `includeCrops` case: the corrected line
`return p.listIdentities` **was not the code that
ran**. It was the TYPE. The generated file declared the old input
(`{ nodeId?: string }`) and therefore no typed client (SDK, viewer,
`addon-api.ts`) could *compile* a call with `includeCrops`. The loss
was at the compile boundary, not at dispatch. At runtime the builder derives the
schema from the cap def and passes `input` (§3, line 481).

The plan describes `includeCrops` as «a template bug». **It is not.** The
template emits a zero-argument call **only** in the `method.isVoidInput` branch
(`scripts/generate-cap-routers.ts`:238-263), that is, only
when the input is really `z.void()`. `listIdentities.input` is today
`z.object({...}).optional()` → a `ZodOptional`, which is neither void nor object
(`packages/types/src/capabilities/cap-router-predicates.ts`:18-29) → it lands in the
third branch (line 322-331), which passes `input`. The committed file was **stale**:
generated when the input was `z.void()` and never regenerated.

The guard against that staleness already exists: `npm run codegen -- --check` is
in CI (`.github/workflows/ci.yml:128`, `npm run codegen:check`, introduced on
2026-07-24). It still let `includeCrops` through — we need to
understand why before writing a second guard (§7).

---

## 1. Trace A — `columns`, from `settings-store` to the SQLite backend

Real path: `pipeline-analytics` (or any addon) →
`ctx.api.settingsStore.query({ …, columns })` → door (`storage-orchestrator`) →
engine (`sqlite-settings`, **separate process**,
`packages/system/package.json` → `execution.isolate: true`) → SQL.

| # | Hop | File:line | Re-declares? | Forwards? | Verdict |
|---|---|---|---|---|---|
| A1 | `localProviderLink` (fills the `.default()`s) | `packages/system/src/kernel/moleculer/trpc-links.ts:180`, merge at `packages/types/src/generated/cap-input-defaults.ts:134` | No — reads a map generated from the cap def | Yes, additive `{ ...given }`; unknown keys survive | **SAFE** — `mergeDefaults` copies the input and only adds missing keys; it never rebuilds the object from a list of fields |
| A2 | `ipcParentLink` → UDS wire | `trpc-links.ts:876`, envelope at line 903-909 | Re-declares **the envelope** (`capName`/`method`/`args`/`deviceId`/`nodeId`) | `args: op.input` passes **whole**, not destructured | **SAFE for the payload**, at risk for the envelope (§4) |
| A3 | `onUnownedCall` → `CapRouteResolver` | `packages/system/src/kernel/transport/parent-unowned-call.ts`:413-417 | No | `resolver.dispatch(route, input.method, input.args)` — args intact | **SAFE for the payload** |
| A4 | `resolver.dispatchInner` → in-process hub provider | `cap-route-resolver.ts:327` (`route.ref.invoke(method, args)`) | No | Yes | **SAFE** |
| A5 | The door: `createDataStoreDispatch` | `packages/system/src/builtins/storage-orchestrator/data-store-dispatch.ts`:70-83 | No | `query: async (input) => (await engine()).query(input)` — verbatim forwarding, **no destructuring** | **SAFE — by construction, and documented**: «It is a ROUTER, not a translator … the payload crosses untouched» |
| A6 | Hub proxy → engine's UDS child | `server/backend/src/core/moleculer/moleculer.service.ts`:1074-1078 | Re-declares **the methods** (`Object.keys(expandCapMethods(capDef))`), not the fields | `proxy[m] = (methodParams) => callFn(m, methodParams)` | **SAFE for the fields**; a method not declared on the cap does not exist on the proxy (loud failure, not silent) |
| A7 | `LocalChildRegistry.toCapCall` (parent → child) | `local-child-registry.ts`:499-508 | **Yes, field by field** | `args` whole; drops `input.nodeId` and `input.native` | **LOSES, but inert** (§4.1) |
| A8 | `LocalChildClient` (child, wire → dispatch) | `local-child-client.ts`:211-222 | **Yes, field by field** | `args` whole; drops `native`/`nodeId` | **LOSES, but inert** — and this hop has already caused a live bug: the comment in place cites «the auth 3×-magic-link bug — every wire field must survive this extraction seam» |
| A9 | `createChildCapDispatch` → provider | `packages/system/src/kernel/moleculer/child-cap-dispatch.ts:112` (`fn.call(provider, args)`) | No | Yes | **SAFE** |
| A10 | The engine reads the input | `packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts`:601-605 | **Yes — destructures `{ namespace, collection, filter, columns }` from a hand-written TS interface**, `SettingsQueryInput` (`packages/types/src/interfaces/storage.ts:107`) | Reads only what it destructures | **THIS IS THE HOP THAT LOST `columns`** |

### Where `columns` was really lost

In the door → engine path **there is no Zod parse at all**. A5 forwards the
object, A6/A7/A8 carry it whole, A9 delivers it. The field *arrived*.
The engine simply **did not read it**: `sqlite-settings-backend.query`
destructures from `SettingsQueryInput`, a hand-written TypeScript interface
that is the **third** declaration of the same shape and before the fix
did not have `columns`.

The three declarations of the same shape are:

1. `settingsStoreCapability.methods.query.input` — Zod, the door
   (`settings-store.cap.ts`:143-152, `columns` at line 148)
2. `dataStoreProviderCapability.methods.query.input` — Zod, the engine-as-cap
   (`data-store-provider.cap.ts`:82-100, `columns` at line 97)
3. `SettingsQueryInput` — TS interface, what the engine **implements**
   (`packages/types/src/interfaces/storage.ts`:107-134)

`data-door-schema-parity.spec.ts` ties **1 and 2**. It does not tie 3. And 2 is not tied to
3 even by the compiler, for the reason in §6.

The comment placed in `data-store-provider.cap.ts`:86-95 («Zod objects STRIP
what they do not declare: a field present on the door and absent here … silently
disappears one hop before the engine») describes a mechanism that **does not exist on this
path**. It is accurate only for a *direct* tRPC call to
`dataStoreProvider.query` (§5), which is not how the door reaches the engine. By
CLAUDE.md («a leftover that describes the right design is worse than nothing»)
that prose must be corrected in 7.3/7.4: it reads as verification of a link that
is not there.

**Conclusion of trace A:** the hop that loses is not a transport one. It is
`sqlite-settings-backend.ts:601` — a provider that destructures from a type
declaration disconnected from the cap it says it implements.

---

## 2. Trace B — an argument crossing the remote proxy

`createCapabilityProxy` /`resolveProvider` is the «remote» leg of the cap mounts
(`server/backend/src/api/trpc/cap-router-runtime.ts`:295-315,
`server/backend/src/core/moleculer/moleculer.service.ts:1237`). Live example:
`platformProbe.getCapabilities` / `modelConvert.convert` pinned to an agent.

| # | Hop | File:line | Re-declares? | Forwards? | Verdict |
|---|---|---|---|---|---|
| B1 | Runtime router, object branch | `cap-router-builder.ts`:418-420 | `looseSchema(inputSchema)` = `.loose()` **only at the top level** | `stripKeys(input, ['nodeId'])` → `rest` to the provider | **LOSES on nested objects** (§5.1) |
| B2 | `createCapabilityProxy` | `moleculer.service.ts`:1266-1276 | No — a `Proxy` that fabricates a function for **every** property name | `(params) => callCapabilityOnNode(nodeId, cap, method, params)` — **a single argument** | **SAFE for the fields**; but a method with 2 arguments (e.g. subscription `(input, push)`) cannot be represented |
| B3 | `callCapabilityOnNode` | `moleculer.service.ts`:825-846 | No | `resolver.dispatch(route, methodName, params)` | **SAFE** |
| B4a | `dispatchInner` → `remote-moleculer` | `cap-route-resolver.ts`:348-368 | No | `callWithServiceDiscovery(..., args, ...)` whole | **SAFE for the payload** |
| B4b | `dispatchInner` → `agent-child-forward` | `cap-route-resolver.ts`:372-399 | **Yes — builds `AgentCapForwardParams` field by field** | `capName`/`method`/`args`/`childId`/`deviceId` and **nothing else** | **LOSES `addonId` and `native`** (§4.2) |
| B5 | `callWithServiceDiscovery` (inline pin strip) | `trpc-links.ts`:559-604 | No | **Deliberately removes `args.nodeId`** before sending (line 573-578) | **SAFE and intended** — the pin is routing, not data; but see §5.2 for the `nodeIdMode:'data'` caps |
| B6 | `$agent-cap-fwd.forward` — `narrowParams` | `server/backend/src/agent/agent-cap-dispatch-service.ts`:30-52 | **Yes — rebuilds the envelope field by field from `ctx.params`** | `args` whole | **LOSES every future envelope field** (§4.2) |
| B7 | Agent: reconstruction of `CapCallInput` | `agent-cap-dispatch-service.ts`:109-114 | **Yes, field by field** | drops `addonId`, `native`, `nodeId` | **LOSES** (§4.2) |
| B8 | Agent → its child: A7/A8 again | as above | | | |

---

## 3. Trace C — an argument crossing the UDS channel to a forked addon

Already covered as A2/A7/A8/A9. Two things that apply only here:

- **`withCapInputDefaults` runs in ONE place only**: `localProviderLink`
  (`trpc-links.ts:203`). It is not called in `ipcParentLink`, not in
  `ipcChildLink`, not in `child-cap-dispatch`, not in the runtime router (there the
  `.default()`s fire because Zod does `parse`). The chain
  `[localProviderLink, ipcParentLink]` of `addon-context-factory.ts:423` ensures that the
  defaults are applied **before** the detour — `localProviderLink`
  passes `opWithDefaults` to `next(...)` in all three bail-out branches. It is
  safe **only because that link is always first**. A path that entered
  `ipcParentLink` without `localProviderLink` upstream would deliver empty
  defaults, which is exactly the 2026-07-30 failure cited in the comment.
- **A missing method on the provider is not symmetric.** The runtime router calls
  `provider[method.name]?.(payload)` — optional call
  (`cap-router-builder.ts`:413/429/466/474/483): absent method → `undefined`, **200**.
  `child-cap-dispatch.ts`:99-107 on the other hand **throws**, except for the array methods of a
  collection cap (deliberate and documented degradation). Two authorities, two
  answers to the same defect; the hub's is silent.

---

## 4. The hops that lose, in order of severity

### 4.1 Field-by-field envelope reconstructions (5 hops, all in the same defect class)

Each of these takes a typed envelope and **rewrites** a copy of it
by naming the fields:

| Hop | File:line | Fields it drops today |
|---|---|---|
| `LocalChildRegistry.toCapCall` | `local-child-registry.ts`:499-508 | `nodeId`, `native` |
| `LocalChildClient` (`cap-call`) | `local-child-client.ts`:211-222 | `nodeId`, `native` |
| `resolver.dispatchInner` → `hub-local-uds` | `cap-route-resolver.ts`:338-344 | `addonId`, `native`, `nodeId` |
| `resolver.dispatchInner` → `agent-child-forward` | `cap-route-resolver.ts`:387-393 | `addonId`, `native` (they do not exist on `AgentCapForwardParams`, line 162-172) |
| `$agent-cap-fwd.narrowParams` + reconstruction | `agent-cap-dispatch-service.ts`:30-52 and `109-114` | everything that is not `capName`/`method`/`args`/`childId`/`deviceId` |

On the first two, the two dropped fields are **inert in that direction**: `nodeId`
has already been consumed by routing and `native` is declared on `CapCallMessage`
only because `CapCallInput = Omit<CapCallMessage,'kind'>` — the comment in
`child-cap-protocol.ts` says so: «a child DISPATCH ignores it». So today they
lose nothing alive. **But the shape is the one that has already lost**: the comment at
`local-child-client.ts`:216-219 cites by name the 3× magic-link bug, caused
exactly by a field that did not survive that seam.

### 4.2 `addonId` does not cross the hub → agent boundary — **live structural gap**

`CapCallMessage.addonId` exists for a precise reason, written in the protocol
(`child-cap-protocol.ts`, field `addonId`): a **grouped** runner
(`execution.group`) hosting two addons that register the **same** collection cap
cannot be selected without that field, because the hub's collection mount
strips it from the args after resolving the provider.

`AgentCapForwardParams` (`cap-route-resolver.ts`:162-172) **does not have that field**.
`narrowParams` on the agent would not read it anyway
(`agent-cap-dispatch-service.ts`:44-51) and the `CapCallInput` the agent
reconstructs does not carry it (line 109-114).

So: **provider selection for grouped runners works on the hub and
not on the agent.** Today the damage is limited because the only group shipped is `ml`
(D29), but the field is already declared as necessary by the protocol and the
disparity is not documented anywhere.

A symmetry note that confirms it is an omission and not a design: the
**inverse** direction (agent → hub) explicitly carries `native` and
documents the obligation — `packages/system/src/kernel/transport/hub-cap-forward.ts`:46-52,
«It MUST survive the envelope». `native` in the hub → agent direction is not really
needed, because `parent-unowned-call.ts`:302-337 resolves the natives **before**
routing, against the single authority (`CapabilityRegistry.getNativeProvider`) that
already covers remote agents: that one is **safe, and for a reason**. `addonId`
has no equivalent reason.

### 4.3 `ipcChildLink` — a dead link that documents the WRONG design

`packages/system/src/kernel/moleculer/trpc-links.ts`:816-857. It does not read
`readNodePin(op.context)`: if any hub-local child owns the cap's name, it
short-circuits there **ignoring an explicit pin**. It is the third instance of the
family «an explicit pin must win over a co-located provider with the same
name» — the other two were fixed (`localProviderLink`, Model Studio case
P3; `LocalChildRegistry.resolveChildId`).

**It is not wired into any production chain**: the only references are
the export in `packages/system/src/kernel/index.ts:204` and
`__tests__/moleculer/ipc-child-link.spec.ts`. `buildLinkChain` does not use it.
So it loses nothing today — but there is a test that **endorses** it, which is the pattern
CLAUDE.md calls «a leftover that reads as verification». Whoever wired it
tomorrow would reintroduce the bug with a green suite.

### 4.4 The provider is not checked against the cap it claims to implement

`packages/types/src/interfaces/addon.ts`:158-173:

```ts
readonly provider: CapabilityDefinition extends TCap ? object : InferProvider<TCap>
```

`onInitialize()` returns `ProviderRegistration[]` — a **heterogeneous** array,
so `TCap` is the default `CapabilityDefinition` and `provider` is typed `object`.
**No structural check.** The comment admits it and defers to the «runtime
capability router», which however (§3) answers `undefined`/200 on an absent method,
and does not look at the *fields* at all.

This is what makes trace A possible: `SqliteSettingsBackend implements
ISettingsBackend` (`sqlite-settings-backend.ts:256`) — not
`IDataStoreProvider` — and it registers as the provider of
`dataStoreProviderCapability` (`sqlite-settings.addon.ts:187`) without anything
comparing the two shapes.

**This is the common enabler.** As long as the provider is not checked against
`InferProvider<cap>`, a field can be declared on the cap, carried correctly by
every hop, and simply not read at the other end.

---

## 5. Hops that lose *silently* even though they are «by design»

### 5.1 `.loose()` is shallow — nested objects keep stripping

Both the codegen template (`generate-cap-routers.ts:280`,
`${schema}.input.loose()`) and the runtime builder
(`cap-router-builder.ts:419`, `looseSchema(inputSchema)`) widen **only the top
level**, to let the `nodeId`/`addonId` selectors through.

Exact consequence on the `verified` case: `setTrackFlags`
(`packages/types/src/capabilities/pipeline-analytics.cap.ts`:1652-1661) has input
`{ deviceId, trackId, flags: TrackFlagsPatchSchema }`, and
`TrackFlagsPatchSchema = z.object(TrackFlagFields)` (line 298) is **nested**.
The top level is permissive, `flags` is stripping. An unknown key in
`flags` vanishes without error and the mutation answers **200 having written nothing**.

Note: `verified` is not an existing field. `TrackFlagFields` (line 272-280)
declares only `markForTrain`, `debug`, `favourited`. So the `verified` case is
**two overlapping defects**: (a) a nested object that strips silently instead of
returning 400, and (b) the version skew of §5.3.

The repo therefore has **two opposite semantics in the same input object**:
permissive top level (an unknown key survives and travels), stripping nested
(an unknown key vanishes). Neither raises an error. It is the constraint
the plan places on 7.4 — and the READ/WRITE classification alone does not
solve it, because here the level matters as much as the direction.

### 5.2 `nodeIdMode: 'data'` — three authorities that must agree

`nodeId` is routing by default and **data** for the `nodeIdMode:'data'` caps. The
distinction is replicated in three independent places:

- runtime router: `cap-router-builder.ts`:419-427 (`nodeIdData` → not `.loose()`, does not strip)
- codegen template: `generate-cap-routers.ts`:278-291 (`passthrough`)
- `onUnownedCall`: `parent-unowned-call.ts`:362-365 (`deps.isDataNodeIdCap`)

They agree today because all three read `capDef.nodeIdMode`. But
`callWithServiceDiscovery` (`trpc-links.ts`:573-578) removes `args.nodeId`
**unconditionally**, without consulting `nodeIdMode`: a
`nodeIdMode:'data'` cap reached by `remote-moleculer` loses its own data.
Today it does not bite because the `data` caps (`addon-settings`, `addons`, `nodes`,
`pipeline-orchestrator`) are hub-resident and never take that route —
but it is an undeclared coupling, not an invariant.

### 5.3 Version skew: the schema that validates is the HUB's

The live router compiles the inputs from the `@camstack/types` **installed on the hub**
(`ALL_CAPABILITY_DEFINITIONS` from the dist). A field added to a `*.cap.ts` and
shipped with the addon does not exist for the hub's validator until a
`@camstack/server` containing it arrives. The comment in
`face-gallery.cap.ts`:120-126 says so at length and is correct: *«the hub router
validates cap inputs against its own compiled Zod and strips a key it does not
know»*.

This hop **cannot be repaired with `.strict()`** — in fact `.strict()` turns it
from «field ignored» into «400 on every call from the new client», which is
precisely the rolling upgrade that the plan forbids breaking. It must be treated
separately from 7.4.

### 5.4 `internal: true` no longer prevents the mount

`resolveCapMount` (`packages/types/src/capabilities/capability-definition.ts`:696-701)
looks at `mount`, `deviceNative`, `mode` — **never `internal`**. The runtime builder
mounts everything that is not `skip` (`cap-router-builder.ts`:530-533,
`isBuilderMounted`). So `data-store-provider` — declared
`internal: true` — **is mounted on the live AppRouter as a `protectedProcedure`**,
reachable by any authenticated token.

The field's documentation (`capability-definition.ts`:570-573) still states
the opposite: *«trpc.router.ts simply does not reference it»*. It was true for the
codegen mount; it is not for the runtime builder. On that path — and **only** on
that one — the Zod parse of `data-store-provider.query` is real, and it is the only
scenario in which the rationale written in `data-store-provider.cap.ts`:86-95 is
literally true.

---

## 6. Summary: the hops that lose

**They lose today, in a live way:**

1. `packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts:601`
   — the provider destructures from a type declaration disconnected from the cap.
   *It is the hop that lost `columns`.*
2. `packages/types/src/interfaces/addon.ts:173` — `ProviderRegistration` does not
   check the provider against `InferProvider<TCap>` on the common path.
   *It is the enabler of (1).*
3. `packages/system/src/kernel/cap-router-builder.ts:419` +
   `scripts/generate-cap-routers.ts:280` — shallow `.loose()`: a **nested**
   object strips an unknown key silently, 200.
   *It is the hop that lost `verified`.*
4. `packages/system/src/kernel/transport/cap-route-resolver.ts`:162-172 and `387-393`
   + `server/backend/src/agent/agent-cap-dispatch-service.ts`:30-52, `109-114`
   — `addonId` has no field in the hub → agent envelope.
5. `packages/system/src/kernel/cap-router-builder.ts`:413/429/466/474/483 —
   `provider[method]?.(payload)`: absent method → `undefined`, 200. The child
   side throws; the hub does not.
6. `server/backend/src/api/trpc/generated-cap-routers.ts` — it is the **type**
   of the AppRouter. When it is stale, a new field is unreachable from every typed
   client even though it works at runtime.
   *It is the hop that lost `includeCrops`.*

**They lose by shape, inert today:**

7. `local-child-registry.ts`:499-508 and `local-child-client.ts`:211-222 —
   field-by-field reconstructions that drop `nodeId`/`native`. Inert because
   those fields are consumed earlier. The seam has already lost a live field once
   (3× magic-link).
8. `cap-route-resolver.ts`:338-344 — same pattern on the `hub-local-uds` branch.

**Dead, but endorsing the wrong design:**

9. `trpc-links.ts`:816-857 (`ipcChildLink`) — does not honour `nodePin`; not wired;
   covered by a test that makes it look correct.

**Safe, and why:**

- `data-store-dispatch.ts`:70-83 — verbatim forwarding, no destructuring, and
  the reason is written in the file (the engine composes the table name from the payload;
  a dispatcher that injected or removed a namespace would rename every
  table).
- `cap-input-defaults.ts`:152-190 (`mergeDefaults`) — `{ ...given }`, additive,
  never rebuilt from a list.
- `cap-route-resolver.ts`:293/327/348-368 — `args` crosses `dispatch`,
  `hub-in-process` and `remote-moleculer` as a single opaque value.
- `moleculer.service.ts`:1266-1276 (`createCapabilityProxy`) — a `Proxy` that
  fabricates for every name; no method list to keep aligned.
- `child-cap-dispatch.ts:112` — `fn.call(provider, args)`.
- `hub-cap-forward.ts`:46-52 — carries `native` **and declares it mandatory**;
  the opposite direction does not need it because `parent-unowned-call.ts`:302-337
  resolves the natives against the single authority before routing.
- `callWithServiceDiscovery` removing `args.nodeId` (`trpc-links.ts`:573-578)
  — intended: the pin is routing. With the reservation of §5.2.

---

## 7. Do the three known cases share a hop?

**No. They are three different hops, of three different natures.** The common denominator is not
a hop, it is a principle: *no hop in this chain is checked against the
cap it claims to serve.*

| Case | Hop that lost | Nature |
| --- | --- | --- |
| `columns` | `sqlite-settings-backend.ts:601` — the provider did not read the field | **Provider ⇄ cap contract** unchecked |
| `includeCrops` | `generated-cap-routers.ts` stale — the AppRouter's TYPE | **Drift of the generated file** (+ runtime version skew) |
| `verified` | shallow `.loose()` on nested `flags` | **Nested Zod semantics**, and the field does not exist (version skew) |

---

## 8. What this makes unnecessary / insufficient in 7.2, 7.3, 7.4

### 7.2 — «the codegen must not be able to emit a call without arguments»: **to be rewritten, the premise is false**

- The template **cannot** emit a zero-argument call for a non-void
  input: the `p.method()` branch is reachable only from `isVoidInput`
  (`generate-cap-routers.ts`:238-263), and `isVoidInput` is pure `ZodVoid`.
  A test that «constructs on purpose a case that must fail» (Step 2) **will not
  fail** — the generator is already correct.
- And even if it were corrected, it **would not change the runtime**: that file does not
  run (§0).
- The real question 7.2 must ask: **why did `codegen:check` in CI
  (`.github/workflows/ci.yml:128`) not break the build when
  `generated-cap-routers.ts` was stale?** The file was stale from the change to
  `face-gallery.cap.ts` until a later regeneration. Either CI did not run on those
  commits, or the regenerator produces different output in CI than locally
  (`--check` depends on a fresh `@camstack/types` dist — see
  `findUnusableFrameworkDists` in `scripts/codegen.ts`). This has to be established
  before adding a second guard that would cover the same ground.
- A test that **does** have value, rewritten: for every cap def, the **runtime** router
  (`buildCapRouters`) must mount every method with `<cap>.methods.<m>.input` and
  pass the payload to the provider; and `provider[m]?.(payload)` must stop being
  a silent optional call (§6.5).

### 7.3 — «parity guard between schemas that proxy each other»: **useful, but insufficient as specified**

- Comparing cap ⇄ cap pairs with the same method name finds the
  `settings-store` ⇄ `data-store-provider` pair, which is **already in parity**. It would not
  have found `columns`: the missing declaration was the third,
  `SettingsQueryInput`, which is not a cap.
- The guard that is really needed is the one in §6.2: **the registered provider must
  satisfy `InferProvider<cap>`**. This would have caught `columns` at the first
  `typecheck`. It can be obtained without touching the heterogeneous signature of
  `onInitialize` — with a `scripts/` guard that, for every
  `{ capability: X, provider: Y }` literal, asserts conformity with a generated
  `satisfies`.
- It is still worth extending the parity **to nested objects**: the current spec compares
  only the top-level `Object.keys(schema.shape)`
  (`data-door-schema-parity.spec.ts`:28-33).
- To be done in 7.3, not after: fix the comment in
  `data-store-provider.cap.ts`:86-95, which asserts a mechanism that does not exist
  on that path.

### 7.4 — «an unknown key must fail, not vanish»: **necessary, but the classification must be done on TWO axes, not one**

- The plan classifies on READ/WRITE. Two axes are needed, because the
  **level** matters as much as the direction:
  - **top-level**: permissive by construction today (`.loose()` carries
    `nodeId`/`addonId`). Making it `.strict()` is impossible without breaking
    routing — the solution is to remove the selectors from the input, not to stiffen the
    schema.
  - **nested** (`flags`, `patch`, `target`, `profile`, …): strips silently today.
    **Here `.strict()` is the right and low-risk move**, because the
    top level continues to cover the rolling compatibility that
    `LinkedCamerasCache` requires.
- `verified` is **not repaired** by `.strict()`: the field does not exist in
  `TrackFlagFields`. `.strict()` turns it from silent-200 into 400 — which is
  the intended behaviour, but does not make the flag get written.
- The plan's rolling-upgrade constraint is tighter than as written: by
  §5.3 the schema that validates is **the hub's**, so a `.strict()` on a write
  input breaks every client NEWER than the hub, not only the older nodes. Shipping
  order: hub last remains correct, but the clients
  (OTA viewer, admin-ui) must be considered nodes too.

### Not covered by any of the three tasks, and must be opened

- **`addonId` in the hub → agent envelope** (§4.2).
- **Dead `ipcChildLink` that does not honour `nodePin`** (§4.3) — delete it with
  its test, or wire it after teaching it the pin.
- **`internal: true` that does not prevent the mount** (§5.4) — it is an unintended
  authenticated surface, besides being false documentation.
- **`provider[m]?.(payload)`** (§6.5) — the hub answers 200 where the child throws.
