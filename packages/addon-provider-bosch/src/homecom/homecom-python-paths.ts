import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = 'homecom_worker.py'

/**
 * Absolute path of the bundled `python/homecom_worker.py`: next to `dist/` in a deployed
 * package (one level up from a `dist/` chunk, two from `dist/homecom/`), two levels up from
 * `src/homecom/` in the workspace.
 */
export function resolveHomeComWorker(fromModuleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(fromModuleUrl))
  const candidates = [join(here, '../python'), join(here, '../../python'), join(here, 'python')]
  for (const dir of candidates) {
    const file = join(dir, WORKER)
    if (existsSync(file)) return file
  }
  throw new Error(`provider-bosch: ${WORKER} not found. Searched:\n${candidates.join('\n')}`)
}
