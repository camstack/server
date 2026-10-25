# packages/types — contracts and generated code

`@camstack/types` holds capability definitions, the device model, and every
generated artifact. It is the single source of truth for what CamStack's parts
promise each other.

Inventory: `docs/reference/capabilities.md` (generated).
How to add one: `docs/architecture/capabilities.md`.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed `*.cap.ts`; picking a provider → `camstack-capability` (`.claude/skills/camstack-capability/SKILL.md`)
- A change to `server/backend`, `system`, `types` or `sdk`: test, build, ship → `camstack-server-change` (`.claude/skills/camstack-server-change/SKILL.md`)
- Filling DETECTOR_PERF / detector-latency for a node×device → `camstack-benchmark-detection` (`.claude/skills/camstack-benchmark-detection/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Layout

| Path | What |
| --- | --- |
| `src/capabilities/*.cap.ts` | one file per capability — **authoritative** |
| `src/capabilities/capability-definition.ts` | the contract every cap file implements |
| `src/device/` | `BaseDevice`, `DeviceConfig`, runtime-state slices + bridge helper |
| `src/interfaces/addon.ts` | `AddonContext`, manifest types, `resolveRunnerId` |
| `src/generated/` | **never edit** — `npm run codegen` writes these |

## Non-negotiable

**Run `npm run codegen` after touching a `*.cap.ts`.** Codegen produces the tRPC
routers, `CapStatusTypeMap` and the `DeviceProxy` facade. Skipping it is silent
drift; CI's `codegen:check` catches it, which is not the same as catching it in
time.

Also re-export the new cap from `src/capabilities/index.ts` — a cap file nothing
imports generates nothing.

## Rules

- **Behavioural metadata lives only here.** `kind`, `defaultActive`, `mode` never
  appear in an addon manifest or a runtime `ProviderRegistration`.
  ([D4](../../docs/decisions/adr-0004.md))
- **`runtimeState` must include `lastFetchedAt: z.number()`.** Convention:
  `runtimeState = StatusSchema.extend({ lastFetchedAt: z.number() })`.
- **`deviceConfig` and `exposesDeviceSettings` are mutually exclusive.**
  ([D14](../../docs/decisions/adr-0014.md))
- **`getOptions` must be honest**, camera-probed, never hardcoded — the UI is
  derived from it, so a wrong descriptor renders a control that does nothing.
  Shapes: `hasX`/`supportsX`, `{min,max,step}`, choice arrays. See
  `docs/architecture/capabilities.md`.
- **`z.infer<>`, never a duplicated shape.** Named types only.
- **The bare `@camstack/types` entry is bundled into addons; every subpath is
  host-resolved.** `types/node` carries the filesystem storage provider, so it must
  not be duplicated. ([D15](../../docs/decisions/adr-0015.md))

## Shipping

A new or changed capability is a framework change: `camstack deploy packages/types`
in development, a published `@camstack/server` in production. An *additive* field
on an existing method needs only the providing addon redeployed.
