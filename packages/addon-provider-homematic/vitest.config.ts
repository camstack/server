import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Vitest config for `@camstack/addon-provider-homematic`.
 *
 * The package's `vite.config.ts` is the shared Node-side lib preset
 * (`buildLibPreset`) with no `test` block, so a plain `vitest run` would
 * default to the Node environment for every spec — fine for the manager /
 * gate / format specs, wrong for the page's React component specs, which
 * need a DOM. Vitest 4 no longer honours environmentMatchGlobs; each
 * `.spec.tsx` file declares the jsdom environment via a vitest pragma.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    testTimeout: 10_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
