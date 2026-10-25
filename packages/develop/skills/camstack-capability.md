---
name: camstack-capability
description: Add or change a CamStack capability (`*.cap.ts`) end to end — decide whether one is needed at all, pick its cardinality (singleton, collection, device-native, wrapper, internal, node-hosted), codegen and the two hand-edits it cannot do, registerProvider and the manifest, provider selection through bindings, CAP_INPUT_DEFAULTS, a capability-driven UI, typed routing errors, and what must be published for it to reach a running hub. Use for "new cap", "add a method", "add a field to a cap", "two addons implement the same cap", "No procedure found on path", "provider not available".
---

# Adding or changing a capability

A capability is a typed contract between addons, defined once in
`packages/types/src/capabilities/<name>.cap.ts`. The long-form reference is
`docs/architecture/capabilities.md`; the inventory is the generated
`docs/reference/capabilities.md` and `docs/reference/api.md`. Read the first
before you design anything.

> Skill names with no file in this pack (`camstack-ui`, `camstack-ui-admin`,
> `camstack-server-change`, `camstack-diagnose`, `camstack-publish-ci`) are
> server-repository skills under `.claude/skills/`; this text stands on its own.

## Tooling

```bash
camstack develop scaffold cap <name> [--scope system|device] [--mode singleton|collection]
camstack develop list-caps
camstack develop who-provides <cap-name>
```

The scaffold writes a stub only. You still hand-edit the index + run codegen.

## 0. Do you need one?

A new capability is a **framework change**: codegen, a publish of the server
closure, and an update of every node before anyone can call it. Check first:

- **Enumerating providers of an existing collection?**
  `addons.listCapabilityProviders({ capName })` works even for `internal` caps.
- **An addon's own configuration?** `globalSettingsSchema()` plus the existing
  `addon-settings` cap; the settings panel already renders it.
- **Enable / disable a provider?** `addons.setCapabilityProviderEnabled` (the
  toggle is the ONE enable — D777).
- **A field on an existing method?** Additive output fields need only the
  providing addon redeployed (the router passes output through structurally).
  A new INPUT field is different: the hub validates input against ITS copy of
  the schema and strips unknown keys, so it needs the server update too (§6).

A new capability is right when there is genuinely new state or behaviour that
several addons implement or call.

## 1. Pick the cardinality — it decides everything downstream

| Archetype | Declare | Who answers a call |
| --- | --- | --- |
| **singleton** | `mode: 'singleton'` | one active provider (§4 selection) |
| **collection** | `mode: 'collection'` | every enabled provider; a caller may pin one with `addonId` (global) or `provider` (device collection, required — D554) |
| **device-native** | `scope: 'device'`, registered from the device class | the provider owning that device (`ctx.registerNativeCap`) |
| **wrapper** | `kind: 'wrapper'` (+ `defaultActive` **and** `deviceTypes`) | a provider bound per device via `deviceManager.getBindings` / `setBinding` |
| **internal** | `internal: true` (+ `mount: { kind: 'skip' }` for no route at all) | in-process consumers only; without `skip` it is still a full tRPC router whose un-annotated methods floor to `admin` (D240) |
| **node-hosted** (one per node, called with `{nodeId}`) | `mode: 'singleton'` — **never `'per-node'`** | the pinned node's provider |

`per-node` is a declared enum value that codegen does **not** wire:
`scripts/generate-capability-router-types.ts` matches only
`singleton|collection`, so a `per-node` cap is silently missing from
`ALL_CAPABILITY_DEFINITIONS` and every call answers "provider not available".
Route a node-hosted cap with a pin instead: codegen injects a `nodeId` selector
into every method of a remote-capable singleton, and `nodePin(id)`
(`packages/types/src/cap-call-context.ts`) carries the same pin out of band.

The mount is **derived** from scope and mode. Set `mount` only for
`server-provided` (also needs a factory in `buildServerProviders`), `hub-only`
or `skip`.

## 2. Define it

```ts
export const fooCapability = {
  name: 'foo',                 // kebab-case — scripts/check-cap-name-kebab.ts
  scope: 'system',             // or 'device'
  mode: 'singleton',           // or 'collection'
  methods: { … },              // method(input, output, { auth, access })
} as const satisfies CapabilityDefinition
export type IFooProvider = InferProvider<typeof fooCapability>
```

- **Auth tier on every method.** Omitted = `protected` (reachable by every
  signed-in non-admin). Every tier is pinned in
  `scripts/method-tier-baseline.json`; accept a deliberate change with
  `npx tsx scripts/check-method-tiers.ts --update` and read the diff. A method
  naming a device keeps the id in a TOP-LEVEL `deviceId`-style field or the
  scope gate cannot see it (`docs/architecture/capabilities.md` §"A
  system-scope method that names a device").
- **Export coverage.** A cap either exports to the ecosystems or is a written
  exception: `npx tsx scripts/check-export-coverage.ts`. Both checks run in
  the pre-commit hook when a `*.cap.ts` is staged.
- Behavioural metadata (`kind`, `defaultActive`, `mode`) lives here and only
  here (D4). The manifest lists the cap by `name` (plus `optional`,
  `dependsOn`), nothing else.
- Device state: `status: { schema, kind }`, `runtimeState` including
  `lastFetchedAt: z.number()`. A camera-config cap uses the `deviceConfig`
  archetype with an honest, camera-probed `getOptions` — the UI is derived from
  it (D14). `deviceConfig` and `exposesDeviceSettings` are mutually exclusive.
- A `z.enum` in a cap is a second declaration of a union (it reaches the
  generated client): when removing a member, grep both.

## 3. Hand-edits, then codegen

In `packages/types/src/capabilities/index.ts`:

1. a value re-export of the capability and its types;
2. a member of the **`AnyCapability` union** (it produces `CapabilityName`).

`scripts/check-capability-union-complete.ts` (inside codegen) refuses a miss.

```bash
npm run codegen          # routers, mounts, proxies, hooks, access maps, CAP_INPUT_DEFAULTS, addon-api.ts…
```

Skipping it is silent drift; `codegen:check` catches it later, not in time.
Codegen rebuilds a stale `types`/`system` dist itself; if `addon-api.ts` did not
change when your method is new, the dist was stale — rebuild and rerun. Its
guard failures are findings, not noise.

**Defaults:** a Zod `.default()` on an INPUT runs only where the router parses
it. A call from an addon through `ctx.api` never reaches the router, so codegen
emits `CAP_INPUT_DEFAULTS` (`scripts/generate-cap-input-defaults.ts`) and the
local link merges them. Only TOP-LEVEL defaults are carried — a nested default
arrives `undefined` on the addon path. Prefer top-level defaults.

## 4. Implement, register, select

- System scope: return it from `onInitialize` / `ctx.registerProvider(capName,
  impl)`. Device scope: `ctx.registerNativeCap(cap, impl)` from a `BaseDevice`
  subclass. Providers are flat — no nested sub-objects.
- **Declare it in the manifest** of the same package
  (`camstack.addons[].capabilities`) —
  `scripts/check-registered-caps-declared.ts` fails a registered-but-undeclared
  cap. A builtin that registers in `onInitialize` is no exception.
- **Agents:** an agent declares capabilities from a hand-curated array in
  `server/backend/src/agent/main.ts`. A cap that must exist on agents goes
  there too; nothing else teaches it.
- **Two addons implement the same cap?** Both register unconditionally — never
  gate registration behind a private setting. Choose with the binding:
  singleton → `capabilities.setActiveSingleton({ capability, addonId, nodeId? })`
  (persisted as `capabilities.singleton.<cap>` / `capabilities.singletonNode.<cap>.<node>`;
  System → Capabilities in the UI); collection → the enable toggle or
  `capabilities.setCollectionEnabledProviders`; wrapper → the device binding.
  Resolution order for a singleton: per-node override → cluster default → the
  first provider on that node. Two entries on a singleton in
  `capabilities.listCapabilities` is the tell of a silent duplicate.
- **Consuming another addon's cap:** only `ctx.api.<cap>.<method>` — never an
  import, never `ctx.capabilities` (local process only). In kernel/builtin
  code that needs one addon's provider: `registry.getProviderByAddon(cap, addonId)`.
- **Never hand-write an interface over a cap.** Type against the generated
  client and narrow it:
  `type FooClient = Pick<import('../generated/addon-api.js').AddonApi['foo'], 'get' | 'set'>`
  (precedent: `SettingsStoreClient` in `settings-store.cap.ts`). A hand-written
  copy keeps compiling after a method is removed and fails at runtime as
  `No procedure found on path`.

## 5. UI and errors that follow from the cap

- **The UI is derived from the cap, never hard-coded.** To make something
  appear in an admin list, register the cap that drives the page (a collection
  rendered by the generic page — e.g. `network-access` on Remote Access); never
  add a hand-written card. Device-page UI goes through the device aggregate:
  `deviceConfig` (generic cap) or `exposesDeviceSettings` with the three
  injected methods (owned cap) — never a parallel tab system. Decision rule and
  traps: the `camstack-addon` skill, "A UI surface on a DEVICE page".
- **"Absent" only from an answered query** (D315): ask
  `capabilities.getCapability` / `useCapabilityPresence`, never infer absence
  from `(data ?? [])`, and never throw the literal "provider not available"
  from an accessor — substring matchers mistake it for absence.
- **Routing errors say WHY.** A dispatch failure carries cap, method, node and
  device plus a typed reason (`CapRouteError` in
  `packages/system/src/kernel/transport/cap-route.ts`: `no-provider`,
  `node-offline`, …), never an opaque "not available".

## 6. Spec it, ship it, verify it

Spec in `server/backend/src/__tests__/cap-routers/` — the router builder does
not re-validate OUTPUT, so the test pins the shape.

**What must be published.** The hub reads `ALL_CAPABILITY_DEFINITIONS` from
**`@camstack/system`**, which bundles the cap definitions — and nx-affected
does NOT mark `@camstack/system` changed for an edit under `packages/types`.
So a cap change always force-publishes it with the server:

```bash
gh workflow run "Publish Packages" --ref main -f bump=patch -f scope=affected \
  -f include_dependents=false -f force_packages=@camstack/system,@camstack/server
```

Then the server-side chain — publish → `applyServerUpdate` on the hub AND every
agent → one more restart for builtins → verify — is the `camstack-server-change`
skill; CI mechanics are `camstack-publish-ci`. Then `camstack deploy` the
providing addon (its provider must have the method).

Two 404s, two causes:
- `No procedure found on path "<cap>.<method>"` → the node still runs the old
  closure (server update missing).
- `method '<m>' not found on provider …` → the providing addon is stale
  (deploy it).

Verify on the running node: `capabilities.getCapability({ name })` lists the
provider, and a real call of the new method answers. A new INPUT field is
verified by a call that USES it — a save that "succeeds" while the hub strips
the field is the failure mode.

## 7. Done-gate — paste it before "done"

```
CAPABILITY DONE — <cap>.<method>
archetype:   <singleton|collection|device-native|wrapper|internal|node-hosted>
hand-edits:  index.ts re-export + AnyCapability union — yes
codegen:     npm run codegen — clean; method tiers / export coverage — <accepted diff | unchanged>
manifest:    declared in <package>/package.json (+ agent main.ts array: <yes|n/a>)
spec:        <spec file> — <result>
shipped:     <"not shipped" | published system+server X.Y.Z, applied on <nodes>, addon deployed>
verified:    <the call and its answer, or "not deployed">
docs:        camstack-docs gate — <files | none needed: reason>
```
