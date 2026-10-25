import type { ExecutorContext } from '@nx/devkit'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DeployExecutorSchema } from './schema.js'
import { resolveDeployConfig } from '../../lib/resolve-config.js'
import { packAddon } from '../../lib/pack-addon.js'
import { uploadAddon } from '../../lib/upload-addon.js'

/**
 * Nx executor: pack + push an addon to a running CamStack hub.
 *
 * Steps:
 *   1. Resolve server + token from (options → env → ~/.camstackrc → defaults)
 *   2. Run `npm pack --json` in the project's source dir → .tgz
 *   3. POST the tarball to `${server}/api/addons/upload`
 *   4. Delete the .tgz unless `keepTarball` is set
 *
 * Build dependency: declare `dependsOn: ['build']` in project.json so
 * the addon's compiled `dist/` is fresh. (You can skip this with the
 * `skipBuild` option for iterative pack-only debugging.)
 */
export default async function deployExecutor(
  options: DeployExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const projectName = context.projectName
  if (!projectName) {
    throw new Error(
      'deploy executor requires a project context (run via `nx run <project>:deploy`)',
    )
  }
  const projectConfig = context.projectsConfigurations?.projects[projectName]
  if (!projectConfig) {
    throw new Error(`deploy executor: no project configuration for ${projectName}`)
  }
  const projectRoot = path.resolve(context.root, projectConfig.root)

  // Quick sanity check: the project must be a packable addon (have a
  // package.json + a `camstack.addons` manifest). Surfacing this here
  // beats a confusing `npm pack` error later.
  const pkgJsonPath = path.join(projectRoot, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`deploy executor: no package.json at ${projectRoot}`)
  }
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
    camstack?: { addons?: unknown[] }
  }
  if (
    !pkgJson.camstack?.addons ||
    !Array.isArray(pkgJson.camstack.addons) ||
    pkgJson.camstack.addons.length === 0
  ) {
    throw new Error(
      `deploy executor: ${projectName} doesn't declare any addons in package.json (no \`camstack.addons\` array). ` +
        `This executor is only meaningful for runtime addon packages.`,
    )
  }

  const { server, token } = resolveDeployConfig({
    server: options.server,
    token: options.token,
    rcPath: options.rcPath,
  })

  console.info(`[deploy] packing ${projectName}…`)
  const pack = packAddon(projectRoot)
  console.info(
    `[deploy] packed: ${path.basename(pack.tarballPath)} (${pack.packageName}@${pack.version})`,
  )

  if (options.packOnly) {
    console.info(`[deploy] packOnly — skipping upload`)
    console.info(pack.tarballPath)
    return { success: true }
  }

  let uploadOk = false
  try {
    console.info(`[deploy] uploading to ${server}/api/addons/upload…`)
    const result = await uploadAddon({
      server,
      token,
      tarballPath: pack.tarballPath,
    })
    console.info(`[deploy] ✓ HTTP ${result.status}`)
    if (typeof result.body === 'object' && result.body !== null) {
      console.info(JSON.stringify(result.body, null, 2))
    }
    uploadOk = true
  } finally {
    if (!options.keepTarball && uploadOk) {
      try {
        fs.unlinkSync(pack.tarballPath)
      } catch {
        /* best-effort */
      }
    } else if (options.keepTarball) {
      console.info(`[deploy] kept tarball at ${pack.tarballPath}`)
    }
  }

  return { success: uploadOk }
}
