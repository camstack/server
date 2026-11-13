import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

/**
 * Widget bundle — a Module Federation remote at `dist/widgets/remoteEntry.js`
 * exposing `./widgets` (`src/widgets/index.tsx`: stableId → component). It
 * lives in its own folder because the page bundle owns `dist/remoteEntry.js`
 * and `dist/_stub.js`. The shared singletons mirror the page config and
 * `addon-pipeline-orchestrator/vite.widgets.config.ts`.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'addon_provider_homematic_widgets',
      filename: 'remoteEntry.js',
      // No MF DTS: it leaks `.d.ts` files into framework sources (Bug-1).
      dts: false,
      exposes: {
        './widgets': './src/widgets/index.tsx',
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
  base: '/api/addon-widgets/provider-homematic/widgets/',
  build: {
    target: 'es2022',
    outDir: 'dist/widgets',
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: 'src/widgets/index.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
})
