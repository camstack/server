import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { federation } from '@module-federation/vite'
import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * Benchmark addon page bundle — produces a Module Federation remote at
 * `dist/remoteEntry.js`. The exposed module `./page` resolves to
 * `src/page.tsx`, whose default export is the React component the host
 * `<AddonPageLoader>` mounts when the user navigates to
 * `/addon/benchmark`.
 *
 * Same shape as the widget bundles — see
 * `addon-stream-broker/vite.widgets.config.ts` for the rationale behind
 * the shared singleton list, the `import: false` flag on workspace
 * packages, and the `base` setting. The static-file route at
 * `/api/addon-pages/:addonId/*` (registered in `server/backend/src/main.ts`)
 * serves `dist/remoteEntry.js` plus all chunked output (`assets/*.js`).
 */

// Ensure self-signed cert exists — generate if missing
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
      name: 'addon_benchmark_page',
      filename: 'remoteEntry.js',
      // Disable Module Federation's DTS generation. The MF dts-plugin is
      // on by default and walks the exposed module's import graph through
      // the `@camstack/ui-library` → `../ui-library/src` alias, emitting a
      // `.d.ts` next to every framework source file it touches — the
      // "Bug-1" leak that `scripts/check-no-dts-in-src.sh` guards against.
      // This remote's types are never consumed by another package, so no
      // type generation is needed.
      dts: false,
      exposes: {
        './page': './src/page.tsx',
      },
      // See `addon-stream-broker/vite.widgets.config.ts` for the
      // rationale behind `import: false` everywhere.
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
  // Lib builds do NOT auto-substitute `process.env.NODE_ENV`; the bundled
  // deps (react-query, etc) ship dev-mode checks that explode in the
  // browser ("process is not defined"). Pin it to "production" at build
  // time so those branches are dead-stripped by the minifier.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: {
      '@camstack/ui': path.resolve(__dirname, '../ui-library/src/index.ts'),
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
  base: '/api/addon-pages/benchmark/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    minify: true,
    // `lib` mode — see widget configs for the rationale.
    lib: {
      entry: 'src/page.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
  server: {
    port: 3002,
    https: httpsConfig,
    proxy: {
      '/trpc': { target: 'https://localhost:4443', ws: true, secure: false },
      '/api': { target: 'https://localhost:4443', secure: false },
    },
  },
})
