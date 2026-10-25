/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- Vite UserConfig import via relative path doesn't resolve types under projectService context. The build call works at runtime. */
import { defineConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Server-side addon entry build (Phase E migration).
 *
 * The admin-ui package has TWO builds:
 *   1. `vite.config.ts` — React app (admin-ui SPA + Module Federation
 *      remotes). Runs first, populates `dist/` with the SPA assets.
 *   2. This config (`vite.lib.config.ts`) — server-side addon entry
 *      that mounts the static files. Runs second with
 *      `emptyOutDir: false` so it doesn't wipe the SPA assets.
 *
 * Replaces the previous `tsup --entry src/server/addon.ts` step.
 */

const appVersion: string = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
    version: string
  }
).version

const base = buildLibPreset({
  entries: { 'server/addon': 'src/server/addon.ts' },
  externals: 'self-contained+ui',
  formats: ['es'],
})

export default defineConfig({
  ...base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    ...base.build,
    emptyOutDir: false,
  },
})
