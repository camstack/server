import { defineConfig } from 'tsup'

/**
 * CJS-only + dts. The package is PRIVATE: consumers (the hub's
 * `server/backend` server-root barrel and the agent's tsup build) BUNDLE
 * this dist into their own output at build time — it is never resolved
 * from node_modules at runtime, so a single CJS artifact is enough.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
})
