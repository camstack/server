---
name: camstack-addon
description: Create or change a CamStack addon (plugin) — a device provider, notifier, storage or log destination, pipeline stage, exporter, a builtin, or any new `camstack.addons[]` manifest entry. Covers the silent wiring misses (vite entries, `super({})`), forked vs in-process behaviour, the two per-device settings stores, custom actions, device-page widgets, `camstack deploy` and its traps (installs, may not respawn, ships what is built), and how to prove the new code is the code running. Use for "new addon", "add a provider", "my addon change has no effect", "the addon is running but nothing happens".
---

# Creating or changing an addon

Written from doing it. Every step below exists because skipping it produced a
failure that compiled, passed tests, and broke at runtime or left the docs
lying. Long-form: `docs/architecture/addon-lifecycle.md` (processes, boot,
crashes) and `docs/architecture/addon-custom-actions.md`.

> Skill names with no file in this pack (`camstack-ui`, `camstack-ui-admin`,
> `camstack-server-change`, `camstack-diagnose`, `camstack-publish-ci`) are
> server-repository skills under `.claude/skills/`; this text stands on its own.

## Tooling (prefer this over hand-copying)

```bash
camstack develop scaffold addon <name> [--kind empty|provider|notifier|osd|post-analysis]
camstack develop extend <existing-addon> --entry <new-id>
camstack develop find-example <topic>
camstack develop validate <name-or-path>
```

Nx equivalent (same idea): `nx g @camstack/nx-plugin:addon <name>`.
The develop scaffold also writes `vite.config.ts` `entries` — the miss that
fails only at runtime.

## 1. Decide where it lives

- **A builtin** (`packages/system/src/builtins/<name>/`) if the kernel cannot
  function without it, or it must exist on every node with no install step.
  Builtins ship inside the `@camstack/server` closure.
- **Its own package** (`packages/addon-<name>/`) otherwise. Install is then the
  opt-in, and it updates via `camstack deploy` independently of the framework.

Read `docs/architecture/addon-lifecycle.md` first if you are unsure.

## 2. Write the addon

```
packages/<pkg>/src/<path>/
  <name>.addon.ts     the BaseAddon subclass
  <name>-<thing>.ts   the provider implementation
  index.ts            barrel, re-exporting the addon class
  __tests__/
```

Rules that bite:

- **Providers must not log if they sit on the logging path.** A
  `log-destination` that logs feeds itself. See `loki-destination.ts`.
- **`write`-style hot methods must not throw.** `LogManager` fans one entry to
  every destination; throwing takes the siblings down.
- Keep behavioural capability metadata OUT of the manifest — it belongs in the
  `*.cap.ts` (D4).
- Emit only through `ctx.eventBus` with the `EventCategory` enum
  (D11).
- Never `console.log` — use `ctx.logger`.

### Rules that bite at RUNTIME, not at build time

- **A `BaseAddon` subclass must call `super({})`** (or `super(defaults)`).
  Without it `resolveConfig` throws `Cannot convert undefined or null to
  object` at init — build, tests and `check-addon-entries` all pass, the node
  lists the addon as running, and the boot log says the builtin "failed to
  initialize — skipping", sometimes followed by a misleading "Package
  directory missing". Call one of its caps to prove it is alive.
- **`ctx.kernel.devices`** (create / register / remove / list) is on EVERY
  addon, not only on `BaseDeviceProvider`. An addon that owns devices it
  declares itself (an integration's panel, a synthetic device) reconciles them
  with `DeclaredDevices` (`packages/types/src/device/declared-device.ts`) —
  never a private `ensure…Device` (`scripts/check-declared-device-single-owner.ts`).
- **A settings collection is declared before it is queried.** The SQLite
  backend refuses an undeclared collection (`declareCollection` in `init()`);
  the in-memory test store auto-creates buckets and hides the miss, so pin the
  path with a spec on the real backend.
- **Device state in a FORKED addon can go stale.** A `device.state-changed`
  push does not reliably reach forked children, so a consumer of
  `proxy.state.<cap>.value` reconciles with `refresh()` on a timer.
- **Device providers:** emit motion on every tick the camera reports, not only
  on the rising edge — the pipeline's motion phase is keepalive-driven and
  expires without it. Write the cap slice on the edge only.
- **Two per-device settings stores.** A forked addon reads its per-device
  config from `<addonId>:addon-devices` (one blob per device);
  `addonSettingsRaw.updateDevice` writes a DIFFERENT table. The UI path
  (`applyDeviceSettingsPatch`) is right. A script fixing one device writes
  `settingsBackend.set {collection:"<addonId>:addon-devices", key, value}`,
  which REPLACES the blob — read it with `settingsBackend.query` and merge first.
- **Bundle pure-JS dependencies** (put them in `devDependencies`); runtime
  `dependencies` are for true natives only, because the installer runs
  `npm install` on a node only when runtime dependencies remain.
- **A forked addon serving its own HTTP** goes through the hub's
  `/addon/:addonId/*` bridge, which does not compress (`server/backend/src/main.ts`);
  own the encoding end to end and never add compression to a byte-stream route.
- **Secrets** — any password, token or key field, `secretStatePaths`, a
  credential for a spawned child: the `camstack-secrets` skill. Never read a
  credential from the environment.

## 3. Wire it — the four places, one of which is silent

| # | Place | What happens if you miss it |
| --- | --- | --- |
| 1 | `camstack.addons[]` in the package's `package.json` | the addon does not exist |
| 2 | **`vite.config.ts` `entries` map** | **everything compiles and the addon fails at runtime** |
| 3 | `src/index.ts` re-export | consumers and tests cannot import it |
| 4 | `packages/system/src/index.ts` (builtins only) | same |

Number 2 is the one. A manifest `entry` is just a string — nothing resolves it at
build time. `scripts/check-addon-entries.ts` now catches it; run it.

Manifest fields worth knowing: `protected: true` blocks uninstall ·
`execution.placement: 'agent-only' | 'any-node'` (default `hub-only`) ·
`execution.group` co-locates into one process (D2)
· `instanceMode` · `storageLocations` · `icon` / `color`.

**`icon` is a promise the hub must keep.** It is an asset PATH inside the
package (`assets/icon.svg`, or `assets/<addonId>/icon.svg` when one package ships
several addons — `@camstack/system` does this for every builtin), and the folder
must be in `files` or `npm pack` drops it. The Admin UI requests
`/api/addon-assets/<addonId>/<icon>` only for an addon that declares one
(`addon-admin-ui/src/lib/addon-icons.ts`); everything else draws a glyph with no
request, so never build that URL by hand or guess an id. House style: 24-unit
`viewBox`, no fill, `stroke-width="2"`, round caps/joins, a fixed stroke colour
(the `<img>` cannot inherit `currentColor`), legible at 16 px.
`scripts/check-addon-icons-shipped.ts` fails CI on a declared icon that is
missing or unshipped.

**`description` is not optional in practice** — it is what
`docs/reference/addons.md` and the Admin UI show. An addon with no description
documents itself as `—`.

## 4. Opt-in, if it should be off by default

There is **no `enabled` flag on a manifest**, and **no `enabled` setting in an
addon's own config either** (D777): the capability toggle is the ONE enable. A
private "master switch" is a second truth that can say "off" while the toggle
says "on". The scaffolds do not generate one; do not add one. The real
mechanisms:

1. **Config-default inertness** — an empty required field (a URL, a token) in
   the addon's own settings, which the provider treats as inert. Register the
   provider anyway, so the UI can show it and the operator can configure it.
   This is what `loki-logging` does.
2. **Capability toggle** — `addons.setCapabilityProviderEnabled({ capName,
   addonId, enabled })`, the Enable/Disable control the UI already shows.
   Collection caps only; persisted **globally** under
   `capabilities.collection.<cap>`, not per node. It refuses a provider that is
   not registered yet, so never call it from `onInitialize` (the providers it
   returns register only after it returns) — retry in the background, as
   `loki-logging/retire-enabled-flag.ts` does.
3. **A separate npm package** — installing it is the opt-in.

Prefer 1 for "needs configuring first", and 2 for an on/off choice.

## 5. Verify

```bash
npm run codegen                       # only if you touched a *.cap.ts
npx tsx scripts/check-addon-entries.ts
npm run typecheck && npm run test     # typecheck = code + specs vs the pinned debt (D695)
npm run typecheck -w packages/<pkg>   # your package raw: a NEW addon has no pinned debt, so it must be clean
npm run docs:check
```

Then **actually build it** and confirm the entry was emitted:

```bash
npm run build -w packages/<pkg> && ls packages/<pkg>/dist/<path>/
```

## 6. Documentation

`docs/reference/{addons,packages,capabilities,guards}.md` regenerate from the
manifests on commit — do not describe your addon in prose a table covers. The
rest (sessions entry, an ADR for a rejected alternative, a package
`AGENTS.md` for traps a future session will hit — see
`docs/addons/addon-provider-reolink.md`) follows the `camstack-docs`
ladder. `npm run docs:check` fails on a dead path.

## 7. Ship it — and prove the new code is the code running

An addon runs from its DEPLOYED copy under `<dataDir>/addons/@camstack/<name>/`
(in a workspace dev hub, the data dir under `server/backend`), never from
`packages/<name>/dist`. Editing and rebuilding has **no runtime effect** until
you deploy. A **builtin** travels inside `@camstack/server` instead — the
`camstack-server-change` skill (D16).

```bash
camstack deploy packages/addon-<name>                 # to the hub; or: camstack deploy <name>
camstack deploy packages/addon-<name> -n <nodeId>     # to one agent — one node at a time
camstack deploy packages/addon-<name> --no-verify     # then poll /health yourself (below)
```

Auth comes from `camstack login` (cached per server) or `--token` /
`--token-file` / `$CAMSTACK_TOKEN`; `-s <url>` names the hub. Full reference:
`docs/architecture/update-and-release.md` §"Deploying an addon during
development", which also has the stale-addon detector to run after a rebase.

Traps, each of which has cost a session:

- **`deploy` INSTALLS, it does not only update.** Deploying a package that is
  not installed on the target hot-loads it — a second provider on a singleton
  can break a working one. Check the target's addons first
  (`nodes.getNodeAddons`; `addons.list` can be a stale cache).
- **It ships what is BUILT in that package, committed or not** — including
  another agent's work in the same tree. "Do not deploy" in one brief does not
  stop a sibling from deploying the same package; keep must-not-ship changes
  out of the built tree.
- **It may not respawn the runner.** The new dist can land while the old
  module keeps running. Confirm a fresh process (a new PID / boot line for the
  addon) or call `addons.restartAddon({ addonId })`.
- **A multi-manifest package may come back partly unregistered.** After the
  deploy, check `capabilities.listCapabilities` (or `getCapability`) for every
  cap the package provides; a cap with no provider → `addons.restartAddon`.
- **The post-deploy health probe races the restart** and reports
  `1/1 target(s) failed` after a successful install — use `--no-verify` and
  poll `/health` yourself.
- **`-n <nodeId>` accepts an id that does not exist** and still prints
  `✓ Deployed`. Verify on the node. `nodes.deployAddon` does not ship bundles —
  the CLI's `-n` is the channel.
- **Agents run their own copy.** A hub deploy does not update an agent's copy
  of a hub-only addon, and enabling a feature on a node whose code lacks it
  shows as "Cannot register provider for undeclared capability" — version
  skew, roll the enablement back.
- **Repeated rapid deploys of media addons** (stream broker, providers)
  degrade the hub. One deploy, then verify; a restart only if needed.
- **The hub auto-updater** follows registry `latest` in either direction
  (D942) when the addon's channel allows it, and replaces a CLI-deployed
  build whose version is not that tag. An agent follows the **hub's**
  installed version, not npm. The framework row is still strictly newer
  (D175). Deploy after the version-bump commit if the deploy must survive
  the next sweep.
- **admin-ui** deploys need no hub restart, but a browser keeps the old PWA
  bundle until a hard reload; a blank page with a "MIME type text/html" module
  error is a stale service worker.
- **Never hand-edit the node's addon manifest** (`<dataDir>/addons/manifest.json`):
  an entry whose directory is gone kills the runner and everything co-located.
  "Required and cannot be uninstalled" comes from `protected: true` in the
  installed `package.json`.

**Proof the change is live**: grep the deployed bundle for a string that is
new in this build, then exercise the behaviour (call the cap, press the
button, watch the new log line) — the `camstack-diagnose` skill. A deployed
bundle is not the running code until the process restarted.

## Extending (second entry in one package)

Multi-entry packages (auth, cloudflare, …) need a new id, source file, manifest
row, **and** vite `entries` key. Prefer:

```bash
camstack develop extend <package> --entry <new-id>
```

## Operator buttons (custom actions)

An addon-owned RPC on the `addons.custom` bridge, rendered by the settings form
as a button — no bespoke admin page. Read
`docs/architecture/addon-custom-actions.md`
BEFORE adding one.

The trap it exists to prevent: there are **two** registration paths, and which
one applies depends on whether the addon runs in-process or forked — which is
not a property of the source. Populate BOTH the `customActions` named export of
the entry module AND the `customActions` returned by `onInitialize`, or the
bridge answers 404 with your code visibly present in the built bundle.

## A UI surface on a DEVICE page (widgets)

Your addon has an editor, a panel, a canvas — richer than a form — and it
belongs on the camera's own page. Read this before writing any of it, because
one of the available mechanisms **silently does nothing**, and choosing between
the other two is a judgement call with a rule
(D526).

### What the device page actually asks

`getDeviceSettingsAggregate` is **binding-driven** (`device-aggregation.ts`,
D12): it walks the `(cap, provider)`
pairs bound to THIS device and asks each. Cap names are shared across vendors
and a device belongs to exactly one integration, so a contribution may only come
from a provider bound to it. For each binding it either derives the section from
a `deviceConfig` cap (D14) or, when the
cap sets `exposesDeviceSettings`, asks the provider —
`registry.getProviderByAddon(capName, entry.providerAddonId)`, the ADDON's
provider, never the per-device native.

**There is no addon-level route into that page.** That is deliberate, not an
omission.

### The trap

Declaring a `type: 'widget'` field in your addon's `deviceSettingsSchema()`
looks right and is valid everywhere you can check it: the hub returns the
section, `ConfigFormField` renders `type:'widget'` via `WidgetField`, your
component is in the shipped bundle. **Nothing appears**, because that method
feeds only **Cluster → Pipeline → Device Overrides**, whose addon set is a
hand-written list:

```ts
// packages/addon-admin-ui/src/components/pipeline/pipeline-panel-addons.ts
export const PIPELINE_CLUSTER_DEVICE_ADDONS = [
  'pipeline-orchestrator', 'motion-wasm', 'audio-analyzer', 'detection-pipeline',
] as const
```

Its own comment says addons not on it "fall off silently". **That list is a
defect** — an addon declaring a valid schema is ignored with no log line — but
adding yours is still the wrong fix: that page is for per-camera detection
tuning, not for your feature.

### Pick by ownership, not by example

Both real mechanisms hang the widget off a **capability** bound to the device.
Which one you use is decided by ONE question, and it is not "which did I see
first" — neither is canonical:

> **Would another vendor implement this capability, without changing it?**

- **Yes — the cap is GENERIC.** Let the framework derive the section. Any other
  answer means the same section gets hand-written once per vendor and diverges
  at the first edit.
- **No — the cap is OWNED**, meaning one addon implements it *and* that addon
  owns the device. Declare the section yourself.

Answer it about the capability, not about today's fleet. A cap with one
implementer right now can still be generic: `navigation` and `consumables` are
dreame-only today and another robot vendor would implement either untouched, so
both are generic. `consumables` says so in its own definition — `status.empty`
plus `status.itemArray` make it a device-link synthesize target, so it can
appear on a device no dreame provider owns at all.

### A GENERIC cap — the framework derives the section

```ts
deviceConfig: {
  ui: { kind: 'widget', widgetId: 'host/your-widget', tab: 'streaming', label: '…' },
}
```

The framework emits the structural section out of the binding entry — **no
provider call, so it cannot fail** — and the widget self-persists through the
cap's own mutations. `motion-zones`, `privacy-mask`, `ptz`, `ptz-autotrack`,
`navigation` and `consumables` all do this, and all six are correct. Register
the component in `HOST_WIDGETS`
(`packages/ui-library/src/widgets/host-widgets.ts`).

**Weigh the cost honestly before minting a cap for this.** A new cap is a
framework change: `npm run codegen`, the two hand-edits in
`packages/types/src/capabilities/index.ts`, and it reaches a node only inside a
published `@camstack/server` (D16).
`camstack deploy <your-addon>` will NOT make the widget appear, and neither will
deploying `admin-ui` — the cap carrying the section does not exist there yet.

### An OWNED cap — your addon returns the section

The cap sets `exposesDeviceSettings: true` and the provider RETURNS a
`ConfigUISchema` containing the widget field. `recording`
(`recorder/recording-device-settings.ts`) and `camera-grid-layout`
(`system/src/builtins/camera-grid/grid-layout-native-provider.ts`, section built in
`grid-device-settings.ts`) are the two:

```ts
sections: [{ id: '…', tab: 'recording', location: 'top-tab', order: 10,
             fields: [{ type: 'widget', widgetId: 'host/recording-panel' }] }]
```

What that buys, and nothing else does: the ADDON picks the section, tab,
location and order, and it can decline PER DEVICE — `recording` returns `null`
for anything that is not a camera, so the tab never appears there.

`recording` is also the example worth remembering, because it LOOKS generic and
is not: "record this camera" sounds like something several addons could offer,
and only the recorder ever does.

Three things bite here:

- **Return the WIRE shape.** Run your schema through `hydrateSchema(schema, {})`
  — a widget stores no values, but the aggregation expects the hydrated form.
- **A `deviceNative` cap needs the contribution on BOTH providers — one
  builder, two registrations.** There are two paths and they reach different
  objects:
  - the DEVICE PAGE resolves with
    `registry.getProviderByAddon(capName, entry.providerAddonId)`
    (`device-aggregation.ts`), which reads the ADDON-level provider map only.
    No addon-level provider ⇒ the section is dropped and **nothing is logged**.
  - a DIRECT cap call carries a `deviceId`, so `child-cap-dispatch` answers it
    from the DEVICE-scoped provider and THROWS when the method is missing there
    (the singleton fallback exists only for a collection cap's list method).

  Both were measured on the live hub on 2026-09-17, one after the other: the
  wrapper alone gave HTTP 500 on the direct call; the native alone gave a device
  aggregate of 30 sections with ours absent and no error anywhere. Build the
  provider ONCE in a factory and register it twice — as the native
  (`registerNativeCap`, typed `InferProvider`, which a native registration
  happily accepts as a superset) and as the addon's own provider from
  `onInitialize`. Worked example:
  `packages/system/src/builtins/camera-grid/grid-layout-native-provider.ts`.
  `getDeviceSettingsContribution` must return the WIRE shape — run the schema
  through `hydrateSchema(schema, {})`; a widget stores no values.
- **`deviceConfig` and `exposesDeviceSettings` are mutually exclusive**
  (`capability-definition.ts`). Remove one as you add the other.

**Neither shape avoids the capability.** `exposesDeviceSettings` on a cap you do
not own is not an option: the caps a device-owning addon typically already has
bound (`device-status`, `feature-probe`, `stream-catalog`, `device-ops`) are
SHARED across dozens of providers, and flipping that flag makes the aggregation
call `getDeviceSettingsContribution` on every one of them. Fleet-wide blast
radius to render one panel.

Two more that bite either way:

- **`topTab: true` needs a known tab.** A `topTab` widget must name a tab in
  `WELL_KNOWN_TAB_MAP` (`packages/types/src/interfaces/config-ui.ts`) or the UI
  renders the raw tab id as the label. Use an existing tab unless you also add
  the entry — and note that the tab's label, icon and position in the bar are a
  `@camstack/types` constant, so they are a framework publish whichever
  mechanism declares the section.
- **If the addon owns the device, make the cap `deviceNative`** and register it
  from the device class, so the widget asks *the camera* through the ordinary
  device proxy.

### Diagnosing which failure you have

```bash
node scripts/hub/hub.mjs GET addonSettings.getDeviceSettings '{"addonId":"…","deviceId":N}'
node scripts/hub/hub.mjs GET deviceManager.getBindings '{"deviceId":N}'
```

If the first returns your section and the second does not list your cap, the
data is fine and **nobody is asking** — you are on the wrong mechanism. Grepping
the deployed bundle for your widget id proves only that the code shipped; it
says nothing about whether anything requests it. On the day this was diagnosed,
three checks out of four said "fine"; only "who ASKS" told the truth.

## Done-gate

```
ADDON DONE — <addonId>
wiring:    manifest + vite entries + index re-export; check-addon-entries ok
checks:    typecheck / tests / build emitted <dist path>
deployed:  <nodes> — fresh runner; caps registered
proved:    <the call / log line observed>
docs:      <files | none needed: reason>
```
