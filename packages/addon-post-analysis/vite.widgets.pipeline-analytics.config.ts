/* eslint-disable @typescript-eslint/no-unsafe-call -- vite's defineConfig signature resolves to `unknown` under projectService when imported from a per-package config file; the build call works at runtime. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

/**
 * Widget bundle config — produces a Module Federation remote at
 * `dist/pipeline-analytics/remoteEntry.js`. Lives at the bundle root
 * so paths resolve correctly when invoked via `vite build --config
 * vite.widgets.pipeline-analytics.config.ts` from the package root.
 *
 * Output goes under `dist/pipeline-analytics/` (mirroring the
 * server-side entry path declared in `package.json` for the
 * `pipeline-analytics` addon) so the static-file route
 * `/api/addon-widgets/pipeline-analytics/*` finds the bundle inside
 * the right per-addon sub-folder.
 *
 * See `addon-pipeline/vite.widgets.stream-broker.config.ts` for the
 * rationale behind the shared singleton list and the `base` setting.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'addon_pipeline_analytics_widgets',
      filename: 'remoteEntry.js',
      // Disable MF DTS generation — it walks the exposed modules' imports
      // through the `@camstack/*` → src aliases and leaks a `.d.ts` next to
      // every framework source file (Bug-1, guarded by
      // scripts/check-no-dts-in-src.sh). These widget types are not
      // consumed cross-package.
      dts: false,
      exposes: {
        './widgets': './src/pipeline-analytics/widgets/index.tsx',
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
  base: '/api/addon-widgets/pipeline-analytics/',
  build: {
    target: 'es2022',
    outDir: 'dist/pipeline-analytics',
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: 'src/pipeline-analytics/widgets/index.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
})
