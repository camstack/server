import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

/**
 * Widget bundle config — produces a Module Federation remote at
 * `dist/remoteEntry.js`. The exposed module `./widgets` resolves to
 * `src/widgets/index.tsx`, whose default export is the
 * `Record<stableId, ComponentType<WidgetProps>>` map the host's
 * `WidgetRegistry` consumes.
 *
 * `react-konva` + `konva` ARE shared singletons. `react-konva` ships
 * `react-reconciler` — a second React renderer that reads React's
 * internals. Bundling a private copy in this remote makes the
 * reconciler resolve against a different React-internals snapshot than
 * the host's shared React (`dispatcher.getOwner is not a function` /
 * the minified `$1` variant). Sharing react-konva as a singleton keeps
 * exactly one reconciler bound to the one shared React. The admin-ui
 * host registers the matching `shared` entry.
 *
 * See `addon-stream-broker/vite.widgets.config.ts` for the rationale
 * behind the shared singleton list and the `base` setting.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'addon_pipeline_orchestrator_widgets',
      filename: 'remoteEntry.js',
      // Disable MF DTS generation — it walks the exposed modules' imports
      // through the `@camstack/*` → src aliases and leaks a `.d.ts` next to
      // every framework source file (Bug-1, guarded by
      // scripts/check-no-dts-in-src.sh). These widget types are not
      // consumed cross-package.
      dts: false,
      exposes: {
        './widgets': './src/widgets/index.tsx',
      },
      // See `addon-stream-broker/vite.widgets.config.ts` for the
      // rationale behind `import: false` everywhere.
      shared: {
        react: { singleton: true, requiredVersion: false, import: false },
        'react-dom': { singleton: true, requiredVersion: false, import: false },
        'react-dom/client': { singleton: true, requiredVersion: false, import: false },
        'react/jsx-runtime': { singleton: true, requiredVersion: false, import: false },
        'react-konva': { singleton: true, requiredVersion: false, import: false },
        konva: { singleton: true, requiredVersion: false, import: false },
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
  base: '/api/addon-widgets/pipeline-orchestrator/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    minify: true,
    // `lib` mode — see `addon-stream-broker/vite.widgets.config.ts`.
    lib: {
      entry: 'src/widgets/index.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
})
