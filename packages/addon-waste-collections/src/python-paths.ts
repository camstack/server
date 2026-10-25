import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate the addon's bundled `python/` dir at runtime (deployed package
 * root or workspace package root). Same candidate walk as detection-pipeline.
 */
export function resolvePythonDir(fromModuleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(fromModuleUrl))
  const candidates = [
    join(here, '../python'), // dist/ → package/python/
    join(here, '../../python'), // src/ → package/python/ when tests import from src
    join(here, 'python'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'fetch_source.py'))) return c
  }
  throw new Error(
    `addon-waste-collections: python/ dir not found. Searched:\n${candidates.join('\n')}`,
  )
}

export function resolveFetchScript(fromModuleUrl: string = import.meta.url): string {
  return join(resolvePythonDir(fromModuleUrl), 'fetch_source.py')
}
