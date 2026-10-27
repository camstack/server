import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locate bundled `python/alexa_worker.py` from dist/ or from src/ under test. */
export function resolveAlexaWorkerScript(fromModuleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(fromModuleUrl))
  const candidates = [
    join(here, '../python/alexa_worker.py'),
    join(here, '../../python/alexa_worker.py'),
    join(here, '../../../python/alexa_worker.py'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`import-alexa: alexa_worker.py not found. Searched:\n${candidates.join('\n')}`)
}
