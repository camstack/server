import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { federation } from '@module-federation/vite'
import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * OSD Manager addon page bundle — produces a Module Federation remote at
 * `dist/remoteEntry.js`. The exposed module `./page` resolves to
 * `src/page.tsx`, whose default export is the React component the host
 * `<AddonPageLoader>` mounts when the user navigates to
 * `/addon/osd-manager`.
 *
 * Modeled directly on `addon-model-studio/vite.page.config.ts` (itself
 * modeled on `addon-benchmark`). The SERVER bundle is built separately by
 * `vite.config.ts` (the shared lib preset) — this config appends ONLY the
 * page remote and therefore sets `emptyOutDir: false` so it does not wipe
 * the server `dist/`. The static-file route at
 * `/api/addon-pages/:addonId/*` (registered in `server/backend/src/main.ts`)
 * serves `dist/remoteEntry.js` plus all chunked output (`assets/*.js`).
 */

// Ensure self-signed cert exists — generate if missing (dev server only).
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
  } catch {
    /* server will generate it */
  }
}

const httpsConfig = fs.existsSync(certPath)
  ? {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  : undefined

// eslint-disable-next-line @typescript-eslint/no-unsafe-call
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    federation({
      name: 'addon_osd_manager_page',
      filename: 'remoteEntry.js',
      // Disable MF DTS generation — see benchmark's config for the "Bug-1"
      // leak rationale. This remote's types are never consumed elsewhere.
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
  // Pin NODE_ENV so bundled dev-mode checks are dead-stripped in the browser.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: {
      '@camstack/ui': path.resolve(__dirname, '../ui-library/src/index.ts'),
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
  base: '/api/addon-pages/osd-manager/',
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
  server: {
    port: 3004,
    https: httpsConfig,
    proxy: {
      '/trpc': { target: 'https://localhost:4443', ws: true, secure: false },
      '/api': { target: 'https://localhost:4443', secure: false },
    },
  },
})
