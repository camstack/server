import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { federation } from '@module-federation/vite'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

// Ensure self-signed cert exists — generate if missing (race condition with server boot)
const tlsDir = path.resolve(__dirname, '../../server/backend/camstack-data/tls')
const certPath = path.join(tlsDir, 'camstack.crt')
const keyPath = path.join(tlsDir, 'camstack.key')

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  fs.mkdirSync(tlsDir, { recursive: true })
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
        `-days 825 -nodes -subj "/CN=camstack.local" ` +
        `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: 'pipe', timeout: 10000 },
    )
    console.log('[vite] Generated self-signed TLS cert at', certPath)
  } catch (e) {
    console.warn('[vite] Failed to generate TLS cert — falling back to HTTP', e)
  }
}

const httpsConfig = fs.existsSync(certPath)
  ? {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  : undefined

// Resolve a workspace package's ESM entry (the `exports['.'].import` target)
// to an absolute path, used to pin the Module Federation host provider's
// `import:` source.
//
// VITE 8 / ROLLDOWN: the MF host (`command === 'build'`) provides each shared
// singleton by importing the package's "local provider" source. When no
// `import:` is configured, `@module-federation/vite` resolves that source by
// `require.resolve(pkg)` (the package's `main` field), which for our
// self-built `@camstack/*` system packages is the CJS bundle
// (`dist/index.cjs`). vite 8's rolldown backend then tries to parse that
// `.cjs` as ESM and throws `[PARSE_ERROR] Cannot use import statement outside
// a module ../ui-library/dist/index.cjs`. The `resolve.alias` → `src` entries
// below are deliberately bypassed by MF for shared modules (it warns about
// the "alias conflict"), so they can't redirect the provider either.
//
// Pinning `import:` to the package's own ESM entry (`exports['.'].import`,
// i.e. `dist/index.js` / `dist/index.mjs`) makes the MF plugin import the
// already-ESM bundle as the host provider — rolldown parses it cleanly. The
// path still resolves to the same workspace package, so MF keeps treating it
// as a workspace singleton (the runtime sharing/singleton semantics are
// unchanged; only the on-disk file MF reads switches from `.cjs` to ESM).
function workspaceEsmEntry(pkgDir: string): string {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'))
  const importTarget: string = pkgJson.exports?.['.']?.import ?? pkgJson.module ?? pkgJson.main
  return path.resolve(pkgDir, importTarget)
}

// NOTE: `uiLibraryEsm` intentionally points to the WORKSPACE SOURCE ENTRY
// (`src/index.ts`) rather than the pre-built `dist/index.js`.
//
// Why: tsup (ui-library's build tool) bundles all source into dist/index.js as a
// library, inlining dynamic `import()` calls as `Promise.resolve().then(() => module)`
// so no real code-split happens in the dist.  When MF used dist/index.js as the
// provider input, Rolldown included MaskShapeCanvas's full Konva render code (~300 KB)
// in the synchronous `dist-*.js` ui-library chunk — defeating the lazy split.
//
// Pointing `import:` to the source lets the admin-ui's own Rolldown run process
// ui-library through the same build graph that handles the rest of the app, so
// `React.lazy(() => import('./composites/cap-settings/MaskShapeCanvas.js'))` in
// src/index.ts produces a REAL async chunk (code-split at build time), and the
// synchronous ui-library chunk is konva-free.
//
// The `resolve.alias` entry (`@camstack/ui-library` → `src/`) already routes all
// non-MF source imports through this path; `import:` keeps the MF provider
// consistent with the same source tree.
//
// sdkEsm and typesEsm still use the dist entries because those packages don't
// have heavy lazy-splittable code — keeping them on dist avoids the extra tsconfig
// processing overhead without any bundle-size cost.
const uiLibraryEsm = path.resolve(__dirname, '../ui-library/src/index.ts')
const sdkEsm = workspaceEsmEntry(path.resolve(__dirname, '../sdk'))
const typesEsm = workspaceEsmEntry(path.resolve(__dirname, '../types'))

// Admin-UI plugin version, injected at build time and shown in the UI
// (login footer + sidebar) so operators can see which build is loaded.
const appVersion: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
).version

export default defineConfig(({ command }) => ({
  // RELATIVE base: the shell references its assets as `./assets/…`, so the
  // build runs unchanged at the hub root AND under a reverse-proxy path prefix
  // (the Home Assistant relay), where the hub injects `<base href="<prefix>/">`
  // into the shell. Chunks locate their siblings through `import.meta.url`.
  // A root-absolute `/assets/…` ignores `<base>` and leaves the relay.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    // Module Federation host. The remotes map is intentionally empty —
    // every addon-contributed widget remote is registered at runtime
    // from `<WidgetRegistryProvider>` via `registerRemotes()` once the
    // aggregator query lands. Declared `shared` deps below provide the
    // canonical singletons remotes inherit through the MF runtime
    // sharing layer (matches every remote's `shared` block).
    //
    // DEV MODE: the plugin emits TLA-bearing virtual modules that
    // collide with Vite's CJS dep prebundler when workspace deps
    // (ui-library/sdk built CJS) `require("@camstack/types")` — the
    // CJS-must-not-import-TLA error blocks the dev server. Since no
    // remotes are registered statically (we register at runtime from
    // the registry provider), the host's only build-time benefit from
    // MF is the shared-deps sharing layer; loading remotes in dev with
    // `loadRemote` works without the plugin once the runtime has been
    // initialized through the aggregator-driven `registerRemotes`
    // flow. So skip the plugin entirely in `vite serve` and let the
    // production build (`vite build`) wire the full sharing graph.
    ...(command === 'build'
      ? [
          federation({
            name: 'admin_ui_host',
            remotes: {},
            // Disable MF DTS generation. Even as a host with no exposes,
            // the dts-plugin starts a type-hint worker that can follow the
            // `@camstack/*` → src aliases and leak framework `.d.ts` into
            // src (Bug-1, guarded by scripts/check-no-dts-in-src.sh).
            dts: false,
            shared: {
              react: { singleton: true, requiredVersion: false },
              'react-dom': { singleton: true, requiredVersion: false },
              'react-dom/client': { singleton: true, requiredVersion: false },
              'react/jsx-runtime': { singleton: true, requiredVersion: false },
              // react-konva ships its own `react-reconciler` (a second React
              // renderer). Shared as a singleton so the whole cluster uses
              // ONE react-konva/react-reconciler bound to the ONE shared
              // React — a widget bundling its own copy resolves the
              // reconciler against a different React internals snapshot
              // (`dispatcher.getOwner is not a function`).
              //
              // `eager: false` (default) — konva is now deferred off the
              // host's first-paint chunk (~300 KB savings).  The host's
              // konva-using components (MotionZonesSettings, PrivacyMaskSettings)
              // are wrapped with React.lazy in host-widgets.ts, so the konva
              // chunk is fetched only when a user first opens a canvas-based
              // device-config tab.  The MF runtime's async share-scope path
              // ensures the singleton constraint is still met — every remote
              // that declares react-konva with `import:false` resolves from
              // the host's single loaded instance.
              'react-konva': { singleton: true, requiredVersion: false },
              konva: { singleton: true, requiredVersion: false },
              '@tanstack/react-query': { singleton: true, requiredVersion: false },
              '@trpc/client': { singleton: true, requiredVersion: false },
              '@trpc/react-query': { singleton: true, requiredVersion: false },
              // Remotes that transitively touch ui-library's MF helpers must
              // resolve this from the host — a bare browser import of the
              // package name fails (`Failed to resolve module specifier`).
              '@module-federation/runtime': { singleton: true, requiredVersion: false },
              // `import:` pins the host provider source to each package's ESM
              // entry so rolldown doesn't pull in the CJS `main` bundle (see
              // `workspaceEsmEntry` above). These stay full providers (NOT
              // `import: false`) so the host still supplies the singleton that
              // every widget remote — built with `import: false` — consumes
              // from the shared scope at runtime.
              '@camstack/ui-library': {
                singleton: true,
                requiredVersion: false,
                import: uiLibraryEsm,
              },
              '@camstack/sdk': { singleton: true, requiredVersion: false, import: sdkEsm },
              '@camstack/types': { singleton: true, requiredVersion: false, import: typesEsm },
            },
          }),
        ]
      : []),
    // Defer Konva off the cold-load critical path. The MF host emits a
    // `<link rel="modulepreload">` for every shared singleton — including
    // `konva` + `react-konva` (~310 KB raw / ~91 KB gzip combined). Those power
    // ONLY the canvas-based device-config tabs (motion zones / privacy mask),
    // which are React.lazy'd (`MaskShapeCanvas` in ui-library's `index.ts`) and
    // are never the first screen. Prefetching them on every cold load is pure
    // waste. Stripping the preload HINT leaves the MF singleton graph untouched
    // — the chunk still loads on demand the moment a canvas tab opens (via
    // `loadShare('konva')`); only the eager first-load fetch is removed. Runs
    // `post` + last so it rewrites the HTML after MF has injected its links.
    {
      name: 'camstack:defer-konva-preload',
      // The MF host injects its shared-singleton preloads OUTSIDE Vite's
      // `transformIndexHtml` pipeline, so rewrite the emitted `index.html` on
      // disk once everything is written (`closeBundle` runs after every
      // `writeBundle`). Idempotent + no-op in dev (no dist emitted).
      closeBundle(): void {
        if (command !== 'build') return
        const indexHtml = path.resolve(__dirname, 'dist/index.html')
        if (!fs.existsSync(indexHtml)) return
        const before = fs.readFileSync(indexHtml, 'utf-8')
        const after = before.replace(/<link\b[^>]*modulepreload[^>]*konva[^>]*>/gi, '')
        if (after !== before) fs.writeFileSync(indexHtml, after)
      },
    },
  ],
  resolve: {
    alias: {
      '@camstack/sdk': path.resolve(__dirname, '../sdk/src/index.ts'),
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
      // Alias `@camstack/types` to source so MF's `mf-shared:` wrapper
      // doesn't end up routing through `ui-library/dist/index.cjs`'s
      // `require("@camstack/types")` — that path can't reach a TLA
      // shared module from CJS. Pure-ESM source resolves cleanly.
      // `/client` first: the alias table matches by prefix, so the bare key
      // below would turn `@camstack/types/client` into `index.ts/client`.
      '@camstack/types/client': path.resolve(__dirname, '../types/src/client.ts'),
      '@camstack/types': path.resolve(__dirname, '../types/src/index.ts'),
    },
    // Hoist tRPC packages to a single instance across the monorepo.
    // Without this, ui-library (aliased to its source) imports
    // @trpc/react-query from its own nested node_modules, while admin-ui
    // imports @trpc/client from its own nested node_modules — same
    // version but DIFFERENT module instances. The React proxy ends up
    // wrapping a vanilla client whose internal `clientCallTypeMap` is
    // a different reference, which makes proxy invocations crash with
    // `client[procedureType] is not a function` on the React Query
    // queryFn path. Deduping forces a single shared module.
    dedupe: ['@trpc/client', '@trpc/react-query', '@trpc/server'],
  },
  server: {
    port: 3001,
    https: httpsConfig,
    proxy: {
      '/trpc': {
        target: 'https://localhost:4443',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/api': {
        target: 'https://localhost:4443',
        changeOrigin: true,
        secure: false,
      },
      '/addon': {
        target: 'https://localhost:4443',
        changeOrigin: true,
        secure: false,
        bypass(req) {
          // SPA page navigations (browser reload) → let Vite serve index.html
          if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
            return '/index.html'
          }
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    // Module Federation's `loadShare` runtime emits top-level await in
    // the per-shared-dep wrapper modules. Bump the target so esbuild
    // accepts the TLA syntax instead of trying to transpile it.
    target: 'es2022',
  },
  optimizeDeps: {
    // Same TLA target bump for the dev-mode dep prebundler.
    esbuildOptions: { target: 'es2022' },
  },
}))
