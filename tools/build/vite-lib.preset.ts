/**
 * Shared Vite-lib preset for camstack Node-side packages.
 *
 * Phase E of the bundles + builder modernization spec
 * (`docs/superpowers/specs/2026-05-09-bundles-and-builder-modernization-design.md`).
 *
 * Replaces the per-package tsup configs with a single source of truth.
 * Each package imports this preset and passes its entries; the preset
 * applies the externals contract, output formats, target, and (for
 * framework packages) DTS emission.
 *
 * Why Vite-lib over tsup:
 *   - Stable Rolldown backend (Vite 7+) — 2-3× faster on large bundles
 *   - Declarations for framework packages are emitted by TypeScript 7
 *     (`scripts/tsc7 -p tsconfig.dts.json`) after vite build — not by an
 *     in-process TS 6 plugin
 *   - Single tooling for both library + page-bundle builds (admin-ui,
 *     benchmark, agent-ui already on Vite for Module Federation)
 *
 * Architecture:
 *   - **Framework externals** (always provided by runtime): @camstack/types,
 *     @camstack/kernel, zod, @trpc/{server,client}, node builtins.
 *     Singletons whose identity must match across boundaries.
 *   - **JS deps**: bundled inline. Each addon ships self-contained.
 *   - **Native deps** (.node): always external. Listed in manifest's
 *     `camstack.nativeDependencies` so the addon installer runs
 *     per-addon `npm install` + `electron-rebuild` at install time.
 *   - **UI externals** (react, react-dom, @tanstack/*): added when the
 *     package ships React components consumed by admin-ui.
 */
import type { LibraryFormats, UserConfig } from 'vite'

export type ExternalsMode = 'framework' | 'framework+ui' | 'self-contained' | 'self-contained+ui'

/**
 * Bare `@camstack/types` + every subpath export stay host-resolved. This is
 * the default framework contract (single source of truth for cap defs).
 */
const BARE_TYPES_EXTERNAL: RegExp = /^@camstack\/types(\/.*)?$/

/**
 * Same contract for `@camstack/system`, for the reason already spelled out on
 * {@link BARE_TYPES_EXTERNAL}: a bare-string external matches the EXACT
 * specifier only, so `@camstack/system/addon-utils` was not external and
 * rolldown tried to bundle it. The breakage stayed invisible for as long as
 * the nx cache kept serving a dist built before that subpath existed — the
 * build only failed once an unrelated edit invalidated the cache, which is
 * why a passing `camstack deploy` was not evidence the bundle still built.
 */
const BARE_SYSTEM_EXTERNAL: RegExp = /^@camstack\/system(\/.*)?$/

/**
 * Subpath-only `@camstack/types` external. Keeps `@camstack/types/node`,
 * `/addon`, `/catalogs` (and any other subpath) host-resolved while allowing
 * the BARE `@camstack/types` entry to be BUNDLED into the package's own dist.
 * Used only when `bundleTypesMainEntry` is set — lets a system-level package
 * carry one authoritative copy of the cap-derived value symbols so that
 * `camstack deploy packages/system` refreshes the hub's capability surface
 * without a new server image.
 */
const TYPES_SUBPATH_ONLY_EXTERNAL: RegExp = /^@camstack\/types\/.+$/

/**
 * Node + dispatcher externals — the minimum that MUST stay outside the
 * addon bundle. These are the runtime kernel + filesystem; everything
 * else is fair game to inline.
 */
const RUNTIME_EXTERNALS: readonly (string | RegExp)[] = [
  // Electron-runtime modules. `@camstack/system`'s restart-coordinator +
  // native-deps loader import `electron` / `@electron/rebuild` lazily
  // (`await import(...).catch(() => null)`) and only when actually running
  // inside the Electron desktop shell. In the hub/agent server process they
  // are absent — so they MUST stay external, never bundled. (Previously
  // bundled silently only because a hoisted `electron` devDep happened to be
  // installed; the Electron 42 bump exposed the latent break.)
  'electron',
  /^@electron\/rebuild(\/.*)?$/,
  // Node builtins — every flavor.
  /^node:/,
  'fs',
  'fs/promises',
  'path',
  'os',
  'crypto',
  'http',
  'https',
  'http2',
  'stream',
  'stream/promises',
  'stream/consumers',
  'stream/web',
  'url',
  'util',
  'events',
  'child_process',
  'cluster',
  'worker_threads',
  'net',
  'tls',
  'dns',
  'dgram',
  'buffer',
  'querystring',
  'zlib',
  'assert',
  'perf_hooks',
  'inspector',
  'process',
  'timers',
  'timers/promises',
  'string_decoder',
  'punycode',
  'readline',
  'repl',
  'tty',
  'v8',
  'vm',
  'async_hooks',
  'console',
]

/**
 * Legacy framework externals — `@camstack/{types,core,sdk}` + zod +
 * tRPC. Required when the hub's `symlinkPeerDepsIntoAddonsDir` plants
 * a shared copy of these into `addonsDir/node_modules/@camstack/` and
 * addons resolve them via parent-walk. Identity-based dispatch (the
 * old model) required this so zod schema + cap-definition references
 * matched between hub and addons.
 *
 * Use `'framework'` mode for addons that have not yet migrated to
 * self-contained bundling. New addons should use `'self-contained'`.
 */
const FRAMEWORK_EXTERNALS: readonly (string | RegExp)[] = [
  ...RUNTIME_EXTERNALS,
  // Match the bare specifier AND every subpath export (e.g.
  // `@camstack/types/node`, which carries the FilesystemStorageProvider).
  // A bare-string external only matches `@camstack/types` exactly, so the
  // kernel/runner used to BUNDLE a frozen copy of `@camstack/types/node` —
  // causing "rebuilt types but runtime still old" bugs. The regex keeps every
  // `@camstack/types/*` import host-resolved (single source of truth).
  BARE_TYPES_EXTERNAL,
  // @camstack/system: marked external so addon bundles don't inline the
  // sqlite-storage builtin. Inlining drags `require('better-sqlite3')`
  // into the addon's shared chunk, which then fails at load time because
  // `better-sqlite3` lives in `@camstack/system`'s own node_modules (not
  // hoisted to the root). Keep it external — addons resolve it through the
  // workspace symlink at `node_modules/@camstack/system`, which sees its
  // own `node_modules/` for native deps.
  BARE_SYSTEM_EXTERNAL,
  '@camstack/sdk',
  '@camstack/ui-library',
  // Zod identity matters: input parsing in the cap router must use the
  // same zod instance that produced the schema. If two addons bundled
  // their own copies, instanceof checks would fail across boundaries.
  'zod',
  '@trpc/server',
  '@trpc/client',
]

/**
 * Self-contained externals — `@camstack/types`, `zod`, `@camstack/sdk`
 * are INLINED into the addon dist. The addon ships everything it needs
 * to run except the kernel dispatcher + Node builtins. Survives server
 * upgrades that don't change cap shapes (additive schemas, renames in
 * unrelated caps, …) because the addon brought its own copy of
 * everything that's NOT the dispatch protocol.
 *
 * Cost: cap.name strings replace `cap` object references at call sites
 * (because the cap-definition objects in the addon are a separate
 * instance from the hub's). See `BaseAddon.registerProvider`.
 *
 * `@camstack/system` + `@camstack/ui-library` stay external because they
 * carry native binaries (better-sqlite3) or React (UI singleton).
 */
const SELF_CONTAINED_EXTERNALS: readonly (string | RegExp)[] = [
  ...RUNTIME_EXTERNALS,
  BARE_SYSTEM_EXTERNAL,
  '@camstack/ui-library',
]

/** UI-only externals — only for packages shipping React widgets/pages. */
const UI_EXTERNALS: readonly (string | RegExp)[] = [
  // String matching is path-exact in rollup — `'react-dom'` does NOT
  // match `'react-dom/client'`. Use regex prefixes for sub-path imports
  // so deep imports (`react-dom/client`, `react-dom/server`,
  // `@tanstack/react-query/devtools`, …) stay external too. Without this,
  // the missing sub-paths get bundled (= ~6000 lines of inlined React DOM
  // CJS in every consumer dist), and the bundled CJS shim emits
  // `import { createRequire } from 'node:module'` at the top of the
  // output — which Module Federation's browser-target widget builds
  // reject as an unrecognized specifier.
  /^react($|\/)/,
  /^react-dom($|\/)/,
  'tailwindcss',
  /^@tanstack\/react-query($|\/)/,
  /^@tanstack\/react-table($|\/)/,
  /^@trpc\/react-query($|\/)/,
  // react-konva ships its own `react-reconciler` (a second React
  // renderer) and is a Module Federation `shared` singleton — it must
  // never be bundled into a ui package. react-konva is also CJS, so
  // inlining it would emit the `node:module` `createRequire` shim that
  // the browser-target widget builds reject.
  /^react-konva($|\/)/,
  /^konva($|\/)/,
]

/**
 * Common native deps that must NEVER be bundled — they ship as `.node`
 * binaries that need ABI-matched per-runtime install. The addon
 * installer reads `camstack.nativeDependencies` from the manifest and
 * runs `npm install --prefix <addonDir>` + `electron-rebuild` (Electron)
 * or `npm rebuild` (plain Node) against the host runtime ABI.
 *
 * Listed here as a guard: even if an addon forgets to declare its
 * native dep, the preset still excludes it from the bundle so a build
 * error surfaces at runtime (Cannot find module) rather than a
 * mysterious .node-not-found at first invocation.
 */
const COMMON_NATIVE_DEPS: readonly string[] = [
  // ONLY true `.node`-loading natives stay external — they cannot be bundled and
  // resolve from the host framework closure (see HOST_EXTERNAL_SPECIFIERS).
  // better-sqlite3 is hub-only (never an addon import); node-av/sharp/node-pty
  // are shared from the framework. Pure-JS libs an addon uses (ssh2, werift,
  // systeminformation) are NOT listed here on purpose — they bundle into the
  // self-contained dist, so no per-addon node_modules is ever installed for
  // them. onnxruntime-node was removed: the Node ONNX path is gone (inference is
  // Python subprocess now), so it is dead metadata.
  'better-sqlite3',
  'node-av',
  'node-pty',
  'sharp',
  // ssh2: pure-JS BUT ships OPTIONAL native accelerators (cpu-features /
  // sshcrypto `.node`) that the bundler cannot inline — so it must stay external
  // and resolve from the framework closure like the other host-externals.
  'ssh2',
]

export interface ViteLibPresetOptions {
  /**
   * Map of entry name → source path. The output paths mirror the
   * entry-name structure: `entry name "foo/index"` → `dist/foo/index.{js,mjs}`.
   */
  readonly entries: Record<string, string>

  /**
   * Which set of externals to apply.
   *   - `'framework'`: Node-only addons. Default.
   *   - `'framework+ui'`: addons shipping React components.
   */
  readonly externals?: ExternalsMode

  /**
   * Extra externals beyond the preset's defaults. Listed here so an
   * addon can opt out of inlining a specific JS dep (e.g., the addon
   * provides a peer that must be shared with the host process).
   */
  readonly extraExternals?: readonly (string | RegExp)[]

  /**
   * Output formats. Default `['cjs', 'es']` for addons (kernel loads
   * CJS, modern tools prefer ESM). Set to `['es']` only for ESM-only
   * packages.
   */
  readonly formats?: readonly LibraryFormats[]

  /**
   * Compilation target. Default `es2022` matches our tsconfig.base.
   */
  readonly target?: string

  /**
   * When set, a custom output dir (default `dist`).
   */
  readonly outDir?: string

  /**
   * When `true`, the BARE `@camstack/types` entry is BUNDLED into this
   * package's dist (its subpaths — `/node`, `/addon`, `/catalogs`, … — stay
   * external). Only `@camstack/system` sets this: it lets the hub source its
   * cap-derived runtime value symbols (`ALL_CAPABILITY_DEFINITIONS`,
   * `METHOD_ACCESS_MAP`, …) from `@camstack/system` so `camstack deploy
   * packages/system` refreshes the capability surface with no server image,
   * and `@camstack/types` is never deployed to the hub. Does NOT mutate the
   * shared `FRAMEWORK_EXTERNALS`; only this package's effective externals are
   * adjusted. Default `false`.
   */
  readonly bundleTypesMainEntry?: boolean
}

/**
 * Build a Vite UserConfig for a camstack Node-side library.
 *
 * Usage:
 * ```ts
 * import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'
 * export default buildLibPreset({
 *   entries: {
 *     'pipeline-runner/index': 'src/pipeline-runner/index.ts',
 *     // ...
 *   },
 *   externals: 'framework',
 * })
 * ```
 */
export function buildLibPreset(opts: ViteLibPresetOptions): UserConfig {
  const mode = opts.externals ?? 'framework'
  const baseExternals = mode.startsWith('self-contained')
    ? SELF_CONTAINED_EXTERNALS
    : FRAMEWORK_EXTERNALS
  // When `bundleTypesMainEntry` is set, swap the bare-types regex for the
  // subpath-only regex in THIS package's effective list — without mutating the
  // shared `FRAMEWORK_EXTERNALS` array (sdk relies on bare-types staying
  // external). The bare `@camstack/types` import then inlines into the
  // package's dist while `@camstack/types/{node,addon,catalogs}` stay external.
  const externals: (string | RegExp)[] = opts.bundleTypesMainEntry
    ? baseExternals.map((ext) => (ext === BARE_TYPES_EXTERNAL ? TYPES_SUBPATH_ONLY_EXTERNAL : ext))
    : [...baseExternals]
  if (mode === 'framework+ui' || mode === 'self-contained+ui') {
    externals.push(...UI_EXTERNALS)
  }
  // Native deps must be external for the bare specifier AND any subpath
  // (e.g. `onnxruntime-node/bin`). A bare-string external matches only the
  // exact id, so a subpath import would otherwise be inlined — and a native
  // addon's `binding.js` (`createRequire(import.meta.url)` + `require('…/x.node')`)
  // then TDZ-crashes the ESM output with "Cannot access 'require' before
  // initialization". Match each native dep + its subpaths.
  for (const dep of COMMON_NATIVE_DEPS) {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    externals.push(new RegExp(`^${escaped}(/.*)?$`))
  }
  if (opts.extraExternals) {
    externals.push(...opts.extraExternals)
  }

  const formats = opts.formats ?? ['cjs', 'es']
  const target = opts.target ?? 'es2022'
  const outDir = opts.outDir ?? 'dist'

  const plugins: UserConfig['plugins'] = []

  return {
    build: {
      target,
      outDir,
      lib: {
        entry: opts.entries,
        formats: formats as LibraryFormats[],
        // The fileName fn keeps the entry-name structure as-is and
        // appends the format-specific extension. With entry name
        // `'pipeline-runner/index'` and format 'cjs' you get
        // `dist/pipeline-runner/index.js`; ESM gets `index.mjs`.
        fileName: (format, entryName) => {
          const ext = format === 'es' ? 'mjs' : 'js'
          return `${entryName}.${ext}`
        },
      },
      rollupOptions: {
        external: externals,
        output: {
          preserveModules: false,
          // Disable shared-chunk splitting between entries. Each entry
          // bundles its own full dependency tree — same as tsup. The
          // kernel's `await import(entryPath)` then resolves into a
          // single self-contained file per entry without chasing chunk
          // requires across the dist.
          //
          // Returning a function that always names the same chunk
          // would still split; the right knob is `manualChunks: () => null`
          // which tells rollup "don't extract this — inline into the
          // entry that imported it".
          manualChunks: () => null,
        },
      },
      // No sourcemaps — addons run in server-defined environments; the
      // .map files only bloat the shipped runtime dist.
      sourcemap: false,
      emptyOutDir: true,
      // Library builds shouldn't minify — debugging stack traces stays
      // readable, sourcemaps round-trip cleanly, and addon authors can
      // patch dist/ in development without re-bundling.
      minify: false,
      // SSR mode tells Vite this is a Node target — picks the `node`
      // export condition over `browser`. Critical for deps like
      // `jimp` (used by Reolink driver via nodelink-js) that ship
      // separate Node + browser bundles. Without this, rollup pulls
      // the browser variant which has different named exports.
      ssr: true,
    },
    plugins,
    // Resolve workspace packages from source during dev to support
    // hot-reload across the monorepo. Plus prefer Node conditions for
    // package.json#exports resolution (mirror of build.ssr above).
    resolve: {
      preserveSymlinks: false,
      conditions: ['node', 'import', 'module', 'default'],
    },
    // Hint Vite that we're building for Node — extends ssr-aware
    // module externalization defaults (e.g. node:* builtins are
    // implicitly external).
    ssr: {
      target: 'node',
      // Bundle workspace deps into the addon (otherwise SSR mode
      // makes everything external by default — opposite of what we
      // want for self-contained addons).
      noExternal: true,
    },
  }
}

export const FRAMEWORK_EXTERNALS_LIST = FRAMEWORK_EXTERNALS
export const SELF_CONTAINED_EXTERNALS_LIST = SELF_CONTAINED_EXTERNALS
export const UI_EXTERNALS_LIST = UI_EXTERNALS
export const COMMON_NATIVE_DEPS_LIST = COMMON_NATIVE_DEPS
