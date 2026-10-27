import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { federation } from '@module-federation/vite'
import path from 'node:path'

/**
 * Speak-on-Echo page bundle. The server bundle is `vite.config.ts`;
 * `emptyOutDir: false` keeps that output. The host loads
 * `/api/addon-pages/import-alexa/remoteEntry.js`.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    federation({
      name: 'addon_import_alexa_page',
      filename: 'remoteEntry.js',
      dts: false,
      exposes: {
        './page': './src/page.tsx',
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
  resolve: {
    alias: {
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
  base: '/api/addon-pages/import-alexa/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: 'src/page.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
})
