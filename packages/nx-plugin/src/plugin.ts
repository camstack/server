import type { CreateNodesV2, CreateNodesContextV2, CreateNodesResult } from '@nx/devkit'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Auto-inference plugin. Any workspace package whose `package.json`
 * declares `camstack.addons[]` automatically gains a `deploy` target
 * wired to `@camstack/nx-plugin:deploy` — no manual project.json edit
 * required.
 *
 * Register in `nx.json`:
 *   {
 *     "plugins": ["@camstack/nx-plugin"]
 *   }
 *
 * The matcher scans for `package.json` files (any depth) and inspects
 * the JSON for the manifest. Files that don't parse or don't declare
 * the manifest are skipped silently — the plugin must NOT fail boot
 * for unrelated packages.
 */
export const createNodesV2: CreateNodesV2 = [
  '**/package.json',
  async (configFilePaths: readonly string[], _opts: unknown, ctx: CreateNodesContextV2) => {
    const results: Array<readonly [string, CreateNodesResult]> = []
    for (const configFile of configFilePaths) {
      const projectRoot = path.dirname(configFile)
      const projectName = readProjectName(ctx.workspaceRoot, configFile)
      if (!projectName) continue
      results.push([
        configFile,
        {
          projects: {
            [projectRoot]: {
              name: projectName,
              targets: {
                deploy: {
                  executor: '@camstack/nx-plugin:deploy',
                  dependsOn: ['build'],
                  cache: false,
                  options: {},
                },
              },
            },
          },
        },
      ])
    }
    return results
  },
]

/**
 * Read package.json + decide whether this project should get the
 * deploy target. We require:
 *   1. valid JSON,
 *   2. `name` field present,
 *   3. `camstack.addons` is a non-empty array.
 *
 * Anything else returns null — caller skips the entry.
 */
function readProjectName(workspaceRoot: string, configFile: string): string | null {
  const absPath = path.isAbsolute(configFile) ? configFile : path.join(workspaceRoot, configFile)
  try {
    const raw = fs.readFileSync(absPath, 'utf-8')
    const pkg = JSON.parse(raw) as {
      name?: unknown
      camstack?: { addons?: unknown }
    }
    if (typeof pkg.name !== 'string') return null
    const addons = pkg.camstack?.addons
    if (!Array.isArray(addons) || addons.length === 0) return null
    return pkg.name
  } catch {
    return null
  }
}
