/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- Vite UserConfig import via relative path doesn't resolve types under projectService context. The build call works at runtime. */
import { defineConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Server-side addon entry build.
 *
 * The agent-ui package has TWO builds (mirrors admin-ui):
 *   1. `vite.config.ts` — React SPA (status dashboard). Runs first,
 *      populates `dist/` with `index.html` + `assets/`.
 *   2. This config (`vite.lib.config.ts`) — the server-side addon entry
 *      (`src/addon.ts`) that registers the `admin-ui` capability and
 *      points the static-dir at the SPA assets. Runs second with
 *      `emptyOutDir: false` so it doesn't wipe the SPA assets.
 *
 * Without this second build, `dist/addon.js` (the manifest `entry`)
 * never exists, so the agent's forked `agent-ui` runner crash-loops on
 * "Entry point not found" until the circuit-breaker trips.
 */

const appVersion: string = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
    version: string
  }
).version

const base = buildLibPreset({
  entries: { addon: 'src/addon.ts' },
  externals: 'self-contained',
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
