import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { Plugin } from 'vite'

/** Where the manifest lands inside the package, and what the publish step reads. */
export const BUNDLE_MODULES_MANIFEST = '.bundle-modules.json'

const WORKSPACE_MODULE = /(?:^|\/)((?:packages|server)\/[^/]+\/(?!node_modules\/).+)$/

/**
 * Writes `dist/.bundle-modules.json`: every workspace module that reached the
 * bundle, mapped to the sha256 of what the bundler rendered for it (after
 * tree-shaking, before minification). Sorted, and independent of chunking and
 * of the names the minifier picks.
 *
 * Why it exists: a module-federation page remote compiles ui-library's source
 * into its own bundle, and two builds of ONE tree differ byte for byte (the
 * federation runtime chunk is not deterministic). The publish step compares
 * these manifests instead of bytes, so a library edit the page never reaches
 * does not republish the addon (planning #332).
 */
export function bundleModulesManifest(): Plugin {
  return {
    name: 'camstack-bundle-modules-manifest',
    generateBundle(_options, bundle) {
      const modules: Record<string, string> = {}
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, rendered] of Object.entries(output.modules)) {
          const match = WORKSPACE_MODULE.exec(id.split(path.sep).join('/'))
          if (match === null || rendered.code === null || rendered.code === undefined) continue
          if (rendered.renderedLength === 0) continue
          modules[match[1]] = createHash('sha256').update(rendered.code).digest('hex')
        }
      }
      const sorted = Object.fromEntries(
        Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)),
      )
      this.emitFile({
        type: 'asset',
        fileName: BUNDLE_MODULES_MANIFEST,
        source: `${JSON.stringify(sorted, null, 1)}\n`,
      })
    },
  }
}
