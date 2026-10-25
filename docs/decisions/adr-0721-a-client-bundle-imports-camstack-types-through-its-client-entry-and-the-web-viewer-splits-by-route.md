---
id: D721
title: A client bundle imports @camstack/types through its client entry, and the web viewer splits by route
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/types/src/client.ts
  - packages/types/vite.client.config.ts
  - packages/types/package.json
  - camstack/metro.config.js
  - camstack/app.config.ts
---

## Context

The hosted viewer's web bundle was ONE file: 7.45 MB minified, 1.89 MB gzip,
measured from `expo export --platform web` with source maps and attributed per
package. The largest single contributor was `@camstack/types` at 1.19 MB,
because its bare entry is one pre-bundled `index.mjs` (2.7 MB unminified, every
capability schema, every generated proxy) and Metro does not tree-shake. The
viewer reads about 80 values from it (NC catalogs and helpers, a few schemas,
`DeviceType`, `EventCategory`, plus `SystemMirror` / `createSystemProxy`
through `@camstack/sdk`).

Tried first and measured: Expo's experimental tree shaking
(`EXPO_UNSTABLE_TREE_SHAKING` + `experimentalImportSupport`). 7.42 MB: no change,
because it can only drop unused EXPORTS of a module, and the barrel is a single
module whose top level is all `z.object(...)` calls it must assume have effects.
The same assumption defeats Rolldown when it builds the barrel, so a subpath
that merely re-exports from the barrel came out the same size until module side
effects were switched off for it.

## Decision

1. `@camstack/types` publishes a `client` subpath: `src/client.ts` re-exports
   exactly the runtime values a client bundle reads, built ALONE by
   `vite.client.config.ts` with `treeshake.moduleSideEffects: false` (466 KB
   unminified against the barrel's 2.7 MB plus chunks). The main entries keep
   the default side-effect handling: the hub and addons import them whole.
2. The viewer's Metro resolver maps the bare `@camstack/types` to
   `@camstack/types/client` whenever the installed package has that entry
   (`@camstack/sdk`'s own import included). An older package keeps resolving
   the barrel.
3. The viewer turns on expo-router async routes for WEB only
   (`asyncRoutes: { web: true, default: false }`): each route is its own chunk,
   and code shared by several routes lands in `__common`. Native is unchanged.

## Consequences

Measured on the same tree (web export, minified):

| | before | after |
| --- | --- | --- |
| files loaded for the login screen | `index` 7.45 MB | `index` 1.10 MB + `__common` 4.18 MB + layouts/route ~0.34 MB |
| gzip -9 of the JS loaded for the login screen | 1.88 MB | 1.46 MB (`__common` 1.05 MB + `index` 0.30 MB + layouts/route 0.12 MB) |
| `@camstack/types` in the bundle | 1.19 MB | 0.19 MB |

Screens not on the first route (events, rule editors, camera detail, settings
sub-pages: 30 chunks) load when navigated to.

- A value missing from `client.ts` is `undefined` at runtime in the viewer, not
  a build error. Hence the two guards below; adding a runtime import of
  `@camstack/types` to the viewer means adding the name to `client.ts` and
  publishing `@camstack/types` before the viewer ships.
- The client entry only takes effect once a `@camstack/types` containing it is
  published and the viewer's dependency is bumped.
- The remaining large shared code (`react-native-reanimated` 0.73 MB, `zod`
  0.37 MB, the app's own components) is in `__common` because several routes
  use it; splitting further means lazy components inside routes, not routes.

## Enforcement

- `packages/types/src/__tests__/client-entry.spec.ts`: every name the client
  entry exports is defined, including the two `@camstack/sdk` imports.
- `camstack/src/__tests__/types-client-entry.spec.ts`: every non-type import of
  `@camstack/types` in the viewer's `src/` and `app/` (parsed with the
  TypeScript AST) is exported by the installed `@camstack/types/client`;
  skipped while the installed package predates the entry.
