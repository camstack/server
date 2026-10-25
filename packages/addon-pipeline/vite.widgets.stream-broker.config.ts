/* eslint-disable @typescript-eslint/no-unsafe-call -- vite's defineConfig signature resolves to `unknown` under projectService when imported from a per-package config file; the build call works at runtime. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

/**
 * Widget bundle config — produces a Module Federation remote at
 * `dist/stream-broker/remoteEntry.js`. Lives at the bundle root (not
 * under `src/stream-broker/`) so paths resolve correctly when invoked
 * via `vite build --config vite.widgets.stream-broker.config.ts` from
 * the package root.
 *
 * Output goes under `dist/stream-broker/` (mirroring the server-side
 * entry path declared in `package.json` for the `stream-broker` addon)
 * so the static-file route `/api/addon-widgets/stream-broker/*` —
 * which resolves to `<addonDir>/<distSubdir>/<filePath>` via
 * `AddonRegistryService.getAddonInstallPath()` — finds the bundle
 * inside the right per-addon sub-folder.
 *
 * Shared deps: react / react-dom / @tanstack/react-query / @trpc/* /
 * @camstack/* — all marked `singleton`. Workspace packages
 * (`@camstack/{ui-library,sdk,types}`) additionally use `import: false`
 * so MF skips bundling a build-time fallback chunk for them. The
 * fallback would otherwise pull in each package's CJS dist (which
 * still contains top-level `require("zod")` calls baked in by tsup);
 * those crash in the browser when the host hasn't yet registered the
 * matching shared instance. With `import: false`, the loader throws a
 * clean `[Module Federation] Shared module 'X' must be provided by
 * host` error instead — the host (admin-ui, via `@module-federation/
 * vite`'s host plugin) is required to register them up front.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'addon_stream_broker_widgets',
      filename: 'remoteEntry.js',
      // Disable MF DTS generation — it walks the exposed modules' imports
      // through the `@camstack/*` → src aliases and leaks a `.d.ts` next to
      // every framework source file (Bug-1, guarded by
      // scripts/check-no-dts-in-src.sh). These widget types are not
      // consumed cross-package.
      dts: false,
      exposes: {
        './widgets': './src/stream-broker/widgets/index.tsx',
      },
      shared: {
        react: { singleton: true, requiredVersion: false, import: false },
        'react-dom': { singleton: true, requiredVersion: false, import: false },
        'react-dom/client': { singleton: true, requiredVersion: false, import: false },
        'react/jsx-runtime': { singleton: true, requiredVersion: false, import: false },
        '@tanstack/react-query': { singleton: true, requiredVersion: false, import: false },
        '@trpc/client': { singleton: true, requiredVersion: false, import: false },
        '@trpc/react-query': { singleton: true, requiredVersion: false, import: false },
        '@camstack/ui-library': { singleton: true, requiredVersion: false, import: false },
        '@camstack/sdk': { singleton: true, requiredVersion: false, import: false },
        '@camstack/types': { singleton: true, requiredVersion: false, import: false },
      },
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  base: '/api/addon-widgets/stream-broker/',
  build: {
    target: 'es2022',
    outDir: 'dist/stream-broker',
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: 'src/stream-broker/widgets/index.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
})
