import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the `@camstack/addon-auth` bundle.
 *
 * The bundle ships two addons under one package (oidc, webauthn). `vitest`
 * is pinned to `^3.2.4` in this package's own devDependencies, mirroring the
 * sibling addon packages, so the suite runs on the same toolchain the
 * repo root expects.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
