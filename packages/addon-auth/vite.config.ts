import { defineConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Authentication bundle — 2 entries (oidc, webauthn).
 * Each addon keeps its own addon id + runner; this only bundles the
 * PACKAGE (no co-location). Self-contained externals — these addons
 * are not imported cross-package, so no DTS emission is needed.
 */
export default defineConfig(
  buildLibPreset({
    entries: {
      'oidc/auth-oidc.addon': 'src/oidc/auth-oidc.addon.ts',
      'webauthn/auth-webauthn.addon': 'src/webauthn/auth-webauthn.addon.ts',
    },
    externals: 'self-contained',
  }),
)
