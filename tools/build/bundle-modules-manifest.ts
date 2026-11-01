import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Plugin } from 'vite'

/** Where the manifest lands inside the package, and what the publish step reads. */
export const BUNDLE_MODULES_MANIFEST = '.bundle-modules.json'

const WORKSPACE_MODULE = /(?:^|\/)((?:packages|server)\/[^/]+\/(?!node_modules\/).+)$/

/** The module's source bytes; `null` for a virtual id with no file behind it. */
function readSource(id: string): Buffer | null {
  const file = id.split('?')[0] ?? id
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/**
 * Writes `dist/.bundle-modules.json`: every workspace module that reached the
 * bundle, mapped to the sha256 of its SOURCE file bytes. Not of the rendered
 * code: that carries absolute `#region` paths and deconflicted identifiers, so
 * one tree built in two checkouts hashed differently. Sorted, and independent
 * of chunking, of the checkout path and of the names the minifier picks.
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
          const source = readSource(id)
          if (source === null) continue
          modules[match[1]] = createHash('sha256').update(source).digest('hex')
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
