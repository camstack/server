import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

/**
 * WebAuthn widget bundle config — produces a Module Federation remote at
 * `dist/webauthn/remoteEntry.js`. The exposed module `./widgets` resolves
 * to `src/webauthn/widgets/index.tsx`, whose default export is the
 * `Record<componentKey, Component>` map the host's `WidgetRegistry` (and
 * the pre-auth login page's `loadRemoteBundle`) consume.
 *
 * Output lands in `dist/webauthn/` — NOT the package `dist/` root —
 * because `@camstack/addon-auth` is a multi-entry bundle: the static
 * route resolves the `auth-webauthn` addon's dist dir via the manifest
 * `entry` (`./dist/webauthn/auth-webauthn.addon.js`), so the widget
 * bundle MUST sit alongside it at `dist/webauthn/`.
 *
 * `@simplewebauthn/browser` is DELIBERATELY bundled (not shared) — the
 * whole point of this rework is that the WebAuthn library ships inside
 * the addon bundle, never in the host or `@camstack/ui-library`. Only the
 * framework singletons below are shared with the host so React context /
 * the tRPC client / the SDK resolve to the host's single instance.
 *
 * `import: false` everywhere: the host supplies every shared singleton at
 * runtime, so the remote never bundles its own copy — it borrows the
 * host's from the MF shared scope.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'addon_auth_webauthn_widgets',
      filename: 'remoteEntry.js',
      // Disable MF DTS generation — it walks the exposed modules' imports
      // through the `@camstack/*` → src aliases and leaks `.d.ts` next to
      // framework sources (Bug-1, guarded by scripts/check-no-dts-in-src.sh).
      dts: false,
      exposes: {
        './widgets': './src/webauthn/widgets/index.tsx',
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
  base: '/api/addon-widgets/auth-webauthn/',
  build: {
    target: 'es2022',
    outDir: 'dist/webauthn',
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: 'src/webauthn/widgets/index.tsx',
      formats: ['es'],
      fileName: () => '_stub.js',
    },
  },
})
