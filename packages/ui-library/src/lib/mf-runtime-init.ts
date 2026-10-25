/**
 * Module Federation runtime — host-side init guard, shared across
 * `WidgetRegistryProvider` (widget remotes) and admin-ui's
 * `AddonPageLoader` (page remotes). Both kinds of remote share the same
 * MF runtime instance once initialized — `init` is idempotent and
 * `registerRemotes`/`loadRemote` will work for any name registered after
 * boot.
 *
 * Why a shared module: the production admin-ui build wires the host
 * through `@module-federation/vite`'s injected bootstrap, which seeds
 * the runtime against the host's bundled instances automatically. In
 * dev mode the plugin is intentionally skipped (it conflicts with
 * Vite's CJS dep prebundler — see `addon-admin-ui/vite.config.ts`), so
 * we manually init the runtime AND populate the shared module cache
 * here.
 *
 * The shared module cache is the critical bit. Every remote chunk that
 * `import: false`-shareds a workspace package emits a top-level guard:
 *
 *   const exportModule = __mfModuleCache.share[pkg]
 *   if (exportModule === undefined)
 *     throw new Error('imported before federation bootstrap finished')
 *
 * (see `node_modules/@module-federation/vite/lib/index.mjs` line 1233
 * for the generated code). The cache lives on
 * `globalThis['__mf_module_cache__']` and must be populated with the
 * actual namespace object for each shared package BEFORE the remote
 * evaluates. In production the plugin's host-auto-init module
 * synchronously imports the local instance and assigns it; in dev we
 * do the equivalent here. Without this step the remote fetches its
 * remoteEntry, evaluates the loadShare wrapper, and hits the throw.
 *
 *  - npm packages (react, react-dom, @tanstack/react-query, @trpc/*)
 *    are read off the bundler's import graph via namespace imports.
 *  - workspace packages (`@camstack/{ui-library,sdk,types}`) come off
 *    `window.__camstack{UiLibrary,Sdk,Types}` globals set by
 *    `addon-admin-ui/src/main.tsx` to avoid double-bundling them here.
 *
 * The runtime `init({ shared: ... })` call is still required so that
 * `loadRemote('name/...')` can resolve the same shared instance through
 * the runtime's own share-scope map. The cache populated here is just
 * the synchronous fast path that the per-remote `loadShare` wrappers
 * depend on.
 *
 * No-op in production builds — `getInstance()` is non-null because the
 * plugin's host bootstrap has already created and seeded the runtime.
 */
// We use `init()` (marked @deprecated upstream) instead of `createInstance()`
// because in MF runtime 2.4.0 the standalone-imported `registerRemotes` /
// `loadRemote` functions read from a module-private `FederationInstance`
// var that ONLY `init()` populates. `createInstance()` only sets the
// global federation instance, leaving the standalone exports asserting on
// a null local — manifests as runtime-009 "Please call createInstance".
// See node_modules/@module-federation/runtime/dist/index.cjs.js source map.
import { init, getInstance } from '@module-federation/runtime'

import * as __mfHostReact from 'react'
import * as __mfHostReactDOM from 'react-dom'
import * as __mfHostReactDOMClient from 'react-dom/client'
import * as __mfHostReactJsxRuntime from 'react/jsx-runtime'
import * as __mfHostTanstackQuery from '@tanstack/react-query'
import * as __mfHostTrpcClient from '@trpc/client'
import * as __mfHostTrpcReactQuery from '@trpc/react-query'
// react-konva / konva are NOT statically imported here.
//
// Why: a static top-level import dragged them into the host's initial bundle
// (and the `<link rel="modulepreload">` list in index.html) adding ~300 KB to
// first paint even though no canvas component renders until the user navigates
// to a device config tab.  Instead:
//
//   - In PRODUCTION builds the `@module-federation/vite` plugin's shared-scope
//     mechanism handles lazy loading automatically when `eager:false` is set in
//     `addon-admin-ui/vite.config.ts`.
//
//   - In DEV MODE (this manual-init path) we fire a fire-and-forget dynamic
//     import of both packages immediately at `ensureMfHostInit()` time.  The
//     import races concurrently with the rest of the app bootstrap; by the time
//     the user navigates to any konva-using tab (privacy-mask / motion-zones /
//     zone-editor widget), the modules are already resident and the cache entry
//     below will be set.  If a remote's own MF initPromise resolves before the
//     dynamic import completes (exceedingly unlikely on a local dev server),
//     the MF runtime's async share-scope path (`loadShare`) acts as the
//     fallback — it awaits the same dynamic import chain.
//
// The singleton guarantee is preserved: `singleton:true,requiredVersion:false`
// in vite.config.ts means MF's sharing layer ensures only one copy exists
// across host + all widget remotes, whether loaded eagerly or lazily.

type GlobalKey = '__camstackUiLibrary' | '__camstackSdk' | '__camstackTypes'

function readHostGlobal(name: GlobalKey): Record<string, unknown> {
  const win = (typeof globalThis !== 'undefined' ? globalThis : undefined) as
    | { [k: string]: unknown }
    | undefined
  const value = win?.[name]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const sharedConfig = { singleton: true, requiredVersion: false } as const
const npmShared = (lib: () => unknown) => ({
  version: '0.0.0' as const,
  scope: 'default' as const,
  lib: lib as () => Record<string, unknown>,
  shareConfig: sharedConfig,
})

// Must match `MODULE_CACHE_GLOBAL_KEY` in
// `@module-federation/vite/lib/index.mjs` — the per-remote loadShare
// wrappers read from `globalThis[this exact key]`. If the constant
// drifts in a future MF version, update this string.
const MODULE_CACHE_GLOBAL_KEY = '__mf_module_cache__' as const

interface ModuleCache {
  share: Record<string, unknown>
  remote: Record<string, unknown>
}

function getModuleCache(): ModuleCache {
  const g = globalThis as { [k: string]: unknown }
  const existing = g[MODULE_CACHE_GLOBAL_KEY]
  if (existing && typeof existing === 'object') {
    const cache = existing as Partial<ModuleCache>
    cache.share ??= {}
    cache.remote ??= {}
    return cache as ModuleCache
  }
  const fresh: ModuleCache = { share: {}, remote: {} }
  g[MODULE_CACHE_GLOBAL_KEY] = fresh
  return fresh
}

// Synchronous share cache the per-remote `loadShare` wrappers read from.
// Each entry must be a module namespace object (the result of
// `import * as Foo from 'pkg'`) — the wrappers pluck named exports off
// it via destructuring + re-export. Generated by the MF Vite plugin's
// `writeLoadShareModule` (line ~1220 of `index.mjs`).
function populateShareCache(): void {
  const cache = getModuleCache()
  cache.share['react'] ??= __mfHostReact
  cache.share['react-dom'] ??= __mfHostReactDOM
  cache.share['react-dom/client'] ??= __mfHostReactDOMClient
  cache.share['react/jsx-runtime'] ??= __mfHostReactJsxRuntime
  cache.share['@tanstack/react-query'] ??= __mfHostTanstackQuery
  cache.share['@trpc/client'] ??= __mfHostTrpcClient
  cache.share['@trpc/react-query'] ??= __mfHostTrpcReactQuery
  // react-konva / konva are NOT seeded synchronously here — they are
  // pre-warmed lazily below via fire-and-forget dynamic imports.
  cache.share['@camstack/ui-library'] ??= readHostGlobal('__camstackUiLibrary')
  cache.share['@camstack/sdk'] ??= readHostGlobal('__camstackSdk')
  cache.share['@camstack/types'] ??= readHostGlobal('__camstackTypes')
}

// Returns an MF shared-scope entry backed by an async dynamic import —
// the `get` property is a `SharedGetter` whose factory-Promise the MF
// runtime awaits when `loadShare(pkgName)` is called and no synchronous
// `lib` is present yet.  This covers the race window in dev mode where a
// widget remote calls `loadShare('react-konva')` before the prewarm
// Promise has resolved and populated the `__mf_module_cache__` fast path.
// Once the dynamic import settles, `lib` is set on the shared entry by
// the MF runtime itself (see SharedHandler.loadShare line 138), so
// subsequent `loadShare` calls return synchronously without re-importing.
const lazyNpmShared = (importFn: () => Promise<Record<string, unknown>>) => ({
  version: '0.0.0' as const,
  scope: 'default' as const,
  get: () => importFn().then((ns: Record<string, unknown>) => () => ns as Record<string, unknown>),
  shareConfig: sharedConfig,
})

// Pre-warms the `__mf_module_cache__` fast-path AND seeds the MF share
// scope so remotes that call `loadShare('react-konva')` after the Promise
// settles see the module synchronously.  The fire-and-forget here is
// intentional for the cache path — deterministic resolution is guaranteed
// by the `lazyNpmShared` entries in the `init()` shared config below.
function prewarmKonvaInDevMode(): void {
  const cache = getModuleCache()
  void import('react-konva').then((ns: Record<string, unknown>) => {
    cache.share['react-konva'] ??= ns
  })
  void import('konva').then((ns: Record<string, unknown>) => {
    cache.share['konva'] ??= ns
  })
}

export function ensureMfHostInit(): void {
  // The share cache is populated unconditionally — `??=` makes it
  // idempotent across HMR re-evaluations and across multiple callers.
  // `createInstance` is gated on `getInstance()` because creating a
  // second runtime with the same name would log a warning and shadow
  // the first one's remotes registry.
  populateShareCache()
  if (getInstance() !== null) return
  // Dev-mode only: fire background dynamic imports for konva so the
  // `__mf_module_cache__` synchronous fast path is populated as soon as
  // the modules resolve.  The `lazyNpmShared` entries in `init()` below
  // cover the race window — any remote calling `loadShare('react-konva')`
  // before the prewarm settles will await the `get()` Promise instead of
  // hitting a "provider not found" error.  In production `getInstance()`
  // is non-null at this point (plugin's bootstrap already ran) and we
  // never reach this line.
  prewarmKonvaInDevMode()
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional, see import comment
  init({
    name: 'admin_ui_host',
    remotes: [],
    shared: {
      react: npmShared(() => __mfHostReact),
      'react-dom': npmShared(() => __mfHostReactDOM),
      'react-dom/client': npmShared(() => __mfHostReactDOMClient),
      'react/jsx-runtime': npmShared(() => __mfHostReactJsxRuntime),
      '@tanstack/react-query': npmShared(() => __mfHostTanstackQuery),
      '@trpc/client': npmShared(() => __mfHostTrpcClient),
      '@trpc/react-query': npmShared(() => __mfHostTrpcReactQuery),
      // react-konva / konva use lazy shared entries backed by dynamic
      // imports.  The `get()` Promise is the authoritative provider: the
      // MF runtime awaits it when a remote calls `loadShare('react-konva')`
      // before the prewarm has settled, eliminating the race window that
      // fire-and-forget alone could not close.  Once either path resolves,
      // the runtime sets `lib` on the entry so all subsequent consumers
      // get a synchronous hit.  No static top-level konva import is added —
      // the lazy split introduced in 3f2185e7 is preserved.
      'react-konva': lazyNpmShared(() => import('react-konva')),
      konva: lazyNpmShared(() => import('konva')),
      '@camstack/ui-library': npmShared(() => readHostGlobal('__camstackUiLibrary')),
      '@camstack/sdk': npmShared(() => readHostGlobal('__camstackSdk')),
      '@camstack/types': npmShared(() => readHostGlobal('__camstackTypes')),
    },
  })
}
