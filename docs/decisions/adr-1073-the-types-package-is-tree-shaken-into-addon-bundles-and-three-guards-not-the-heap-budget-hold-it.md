---
id: D1073
title: The types package is tree-shaken into addon bundles, and three guards, not the heap budget, hold it
status: accepted
date: 2026-11-21
supersedes:
applies-to:
  - packages/types/vite.config.ts
  - packages/types/package.json
  - tools/build/pure-initializers.ts
  - packages/types/src/treeshake-canary.ts
  - packages/types/src/generated/device-local-state.ts
  - scripts/generate-device-proxy.ts
  - scripts/check-addon-dist-footprint.ts
  - scripts/check-addon-types-reachability.ts
  - scripts/check-device-local-state-schema-free.ts
---

## Context

[D15](adr-0015.md) has every addon inline `@camstack/types`, and
[D28](adr-0028.md) keeps that inlined copy from costing a runner more heap than a
budget allows. The budget did its job as a tripwire and nothing more: five addons
sat on the 60 MB line, and each time the types package grew (a cap, a device type)
the dated entry in `addon-dist-footprint-budgets.json` was raised, with a reason
that read "the shared inlined types schemas, not this addon's code".

That sentence was the finding. `@camstack/types` reached an addon as ONE
pre-bundled 5 MB ESM (`dist/index.mjs`), and a bundler cannot tree-shake a top-level
initializer it cannot prove pure: `const X = z.object(...)`, `method(...)`,
`Object.freeze({...})` and every `.extend(...)` chain are calls. Measured on the
built reolink dist, 68 % of the types statements (1.86 MB of 2.75 MB) were reachable
from no addon code and were kept anyway, then evaluated at load. Separately,
`BaseDevice.state` read `DEVICE_LOCAL_STATE_CAPS`, a table of every device-native cap
DEFINITION, to get one string (`cap.name`) per proxy: ~400 KB of schemas in every
device provider.

Tried first and not enough: marking a whole module side-effect free and annotating
every call. Marking the BARE top-level calls `macro(...)` / `sub(...)` pure made the
types package stop loading (`EVENT_KIND_BY_CAP ... unknown taxonomy kind`): those
statements exist for their effect, they populate the event taxonomy.

## Decision

`@camstack/types` is tree-shakable, and the rule that keeps it so is three guards on
the BUILT addons, with the heap budget demoted to a backstop.

- `packages/types` also emits `dist/esm/`, one ESM file per source module
  (`preserveModules`), and each export names it under the `module` condition, ahead
  of `import`. A bundler (the addon builds) takes it; Node `import`, `require` and
  vitest keep the bundled `dist/*.mjs` / `dist/*.js`. The package declares
  `"sideEffects": false` (no module is imported only for its effect).
- A build plugin (`tools/build/pure-initializers.ts`) puts `/* @__PURE__ */` on every
  top-level INITIALIZER call (`const X = call(...)`, `export const X = call(...)`),
  and never on a bare expression statement or an IIFE.
- `BaseDevice.state` builds its slice proxy from a generated, schema-free name table
  (`DEVICE_LOCAL_STATE_CAP_NAMES`), the `COLLECTION_ARRAY_METHODS` pattern again.

A new top-level initializer in `packages/types` needs no ceremony. A new bare
statement that must run keeps running. A module imported only for its effect must be
listed in `sideEffects` instead of the flag being dropped.

## Consequences

- Measured heap growth over the bare runner, before to after: reolink +64.0 to +35.2 MB,
  pipeline-analytics +89.6 to +62.9 MB, embedding-encoder +60.4 to +14.5 MB. Types
  statements in the reolink dist: 2,752 KB to 562 KB.
- The default budget falls from 60 to 45 MB; the dated entries that only recorded
  the types growth are gone, and pipeline-analytics keeps one for its own code.
- D15 stands: the addon still carries its own copy of `@camstack/types`. The copy is
  now the part of it the addon reaches.
- D28 stands for the runner (the barrel stays out of it); for addons the rule is
  these guards, and a budget no longer excuses a failure of them.
- `dist/` grows by the per-module copy (~5 MB). It is a second copy on purpose: making
  the per-module files the `import` target sent `vitest related` out of memory (a
  ~700-file module graph crawled for every spec). Node, vitest, admin-ui (source alias)
  and the Metro viewer (no `module` condition, no tree-shaking) see no difference.

## Enforcement

- `scripts/check-addon-dist-footprint.ts` fails when `TreeshakeCanarySchema`'s literal
  appears in any built addon dist: nothing reads that schema, so it appears only when
  an unreachable initializer survives the bundle.
- The same guard calls `scripts/check-addon-types-reachability.ts`: types statements
  no addon code reaches may total at most 40 KB per addon closure (measured 3 to 32 KB;
  before this record 1,500+ KB).
- `scripts/check-device-local-state-schema-free.ts` (in `scripts/ci/run-barrel-guards.sh`)
  refuses a value import of a `*.cap` module in the generated name table;
  `device-local-state-cap-names.spec.ts` proves the names equal the live table's.
- `scripts/__tests__/pure-initializers.spec.ts` pins what the plugin marks and what it never does.
