import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = 'dreo_worker.py'

/**
 * Absolute path of the bundled `python/dreo_worker.py`: next to `dist/` in a deployed
 * package, two levels up from `src/` in the workspace.
 */
export function resolveDreoWorker(fromModuleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(fromModuleUrl))
  const candidates = [join(here, '../python'), join(here, '../../python'), join(here, 'python')]
  for (const dir of candidates) {
    const file = join(dir, WORKER)
    if (existsSync(file)) return file
  }
  throw new Error(`provider-dreo: ${WORKER} not found. Searched:\n${candidates.join('\n')}`)
}
