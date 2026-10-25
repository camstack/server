import { createRequire } from 'node:module'
import type { Plugin, UserConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

const require = createRequire(import.meta.url)

/**
 * Files inside `@homebridge/hap-nodejs` that read the library's OWN
 * `package.json` purely to stamp a version string.
 *
 * `dist/index.js` does `require.resolve("../package.json")` and
 * `dist/lib/model/AccessoryInfo.js` does
 * `require.resolve("../../../package.json")`. Those relative depths are
 * correct from hap-nodejs' installed layout, but once the library is
 * flattened into the addon bundle they re-anchor at the addon's `dist/`
 * and resolve to nothing.
 */
const HAP_PKG_DIR = 'node_modules/@homebridge/hap-nodejs'

/**
 * `JSON.parse(readFileSync(require.resolve("<../>*package.json"), "utf-8"))`
 * as emitted by hap-nodejs' TypeScript build (the `readFileSync` binding is
 * namespaced, e.g. `node_fs_1.readFileSync`).
 */
const HAP_VERSION_READ =
  /JSON\.parse\(\s*\(\s*0\s*,\s*\w+\.readFileSync\s*\)\(\s*require\.resolve\(\s*(["'])(?:\.\.\/)+package\.json\1\s*\)\s*,\s*(["'])utf-8\2\s*\)\s*\)/g

/** Version of the hap-nodejs actually being bundled — inlined at build time. */
function bundledHapVersion(): string {
  const pkg: unknown = require('@homebridge/hap-nodejs/package.json')
  if (pkg === null || typeof pkg !== 'object') {
    throw new Error('export-hap: could not read @homebridge/hap-nodejs/package.json')
  }
  const version = (pkg as Record<string, unknown>).version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('export-hap: @homebridge/hap-nodejs/package.json has no version')
  }
  return version
}

/**
 * Replace hap-nodejs' self-`package.json` reads with the literal version, so
 * the library can be INLINED into the addon's self-contained bundle.
 *
 * Why this must exist: the addon dir on a hub has no `node_modules`. Addon
 * dists are fully bundled precisely so `addons/` stays node_modules-free
 * (ADR-0027), and the OTA/staged update path swaps a staged tree into place
 * with NO `npm install` at all — so an addon that leaves a real runtime import
 * external can never resolve it after an OTA update. Live cost: 123 consecutive
 * load retries of `export-hap` on hub-main with
 * `Cannot find module '@homebridge/hap-nodejs'`, reported by the health monitor
 * as "package may still have a broken manifest" (the manifest was fine).
 *
 * THROWS when a targeted file stops matching. A silent no-op patch would ship
 * a bundle that dies at first `Accessory.publish()` — the guard is the point.
 */
function inlineHapVersionReads(): Plugin {
  const version = bundledHapVersion()
  const patched = new Set<string>()
  return {
    name: 'camstack:inline-hap-version-reads',
    enforce: 'pre',
    transform(code: string, id: string) {
      const normalized = id.split('\\').join('/')
      if (!normalized.includes(HAP_PKG_DIR)) return null
      if (!code.includes('require.resolve')) return null
      HAP_VERSION_READ.lastIndex = 0
      const next = code.replace(HAP_VERSION_READ, `({ version: ${JSON.stringify(version)} })`)
      if (next === code) {
        throw new Error(
          `export-hap: ${normalized} reads its own package.json via require.resolve but did not ` +
            `match the known pattern — hap-nodejs ${version} changed shape. Update ` +
            `HAP_VERSION_READ in vite.config.ts; leaving it unpatched ships a bundle that ` +
            `crashes at Accessory.publish().`,
        )
      }
      patched.add(normalized)
      return { code: next, map: null }
    },
    buildEnd() {
      if (patched.size === 0) {
        throw new Error(
          'export-hap: no @homebridge/hap-nodejs package.json read was patched — the library ' +
            'was not inlined into the bundle (is it still listed in extraExternals?).',
        )
      }
    },
  }
}

/**
 * HomeKit-export bundle — 2 entries (addon entry + barrel).
 *
 * `@homebridge/hap-nodejs` is INLINED (self-contained, like every other addon).
 * See `inlineHapVersionReads` for the one thing that blocked inlining and how
 * it is neutralised.
 */
const base: UserConfig = buildLibPreset({
  entries: {
    index: 'src/index.ts',
    // The entry was renamed `export-hap.addon.js` → `hap-export.addon.js` on
    // 2026-08-12 to clear a cached ESM module REJECTION in hub-main: the loader
    // busted Node's module cache with `?v=<mtimeMs>`, and `npm pack` stamps
    // every file with one fixed mtime, so the module URL was identical for
    // every version of every addon and one failed load was replayed 126 times
    // over ~10.5h. A new filename was a new URL. The loader was fixed
    // independently (the cache-buster keys on version + entry
    // hash), so the rename is no longer load-bearing — but renaming it BACK
    // would be a third module URL for no gain. Leave it.
    'hap-export.addon': 'src/hap-export.addon.ts',
  },
  externals: 'self-contained',
})

export default {
  ...base,
  plugins: [...(base.plugins ?? []), inlineHapVersionReads()],
} satisfies UserConfig
