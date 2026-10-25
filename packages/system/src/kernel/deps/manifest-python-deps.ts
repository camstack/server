import { join, isAbsolute } from 'node:path'
import type { AddonDeclaration, IAddonDepsManager, IScopedLogger } from '@camstack/types'

/**
 * Auto-install the pip requirements file declared in an addon's manifest
 * (`camstack.addons[].python.requirements`) into the embedded portable
 * Python before `onInitialize()` runs.
 *
 * Idempotent: `installPythonRequirements` skips when the file's content
 * hash matches an existing marker under `<python>/.requirements-installed/`.
 * Re-downloading the embedded Python wipes the marker dir together with
 * site-packages, forcing a fresh re-install.
 *
 * Failure modes:
 *   - manifest doesn't declare `python.requirements` → no-op.
 *   - embedded Python download fails → warn + continue. The addon's
 *     own `onInitialize` will raise a precise error if Python is
 *     actually required.
 *   - pip install fails → propagate so the group-runner aborts boot
 *     loudly (vs silently shipping a half-installed env).
 */
export async function installManifestPythonDeps(
  declaration: AddonDeclaration,
  addonDir: string,
  deps: IAddonDepsManager,
  logger: IScopedLogger,
): Promise<void> {
  const reqRel = declaration.python?.requirements
  if (!reqRel) return

  const reqAbs = isAbsolute(reqRel) ? reqRel : join(addonDir, reqRel)

  const pythonPath = await deps.ensurePython()
  if (!pythonPath) {
    logger.warn('Embedded Python unavailable — skipping manifest pip requirements install', {
      meta: { addonId: declaration.id, requirements: reqAbs },
    })
    return
  }

  await deps.installPythonRequirements(reqAbs)
}
