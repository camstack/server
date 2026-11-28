/**
 * Where the two copies of the onboarding manifest live (D1077): the snapshot the
 * CLI bundles, and the document a docs checkout emits. Shared by the guard and
 * the sync script.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SNAPSHOT_PATH = join(ROOT, 'packages/cli/src/onboarding/manifest.snapshot.json')
export const DOCS_MANIFEST_RELATIVE = 'public/onboarding/v1/manifest.json'

/** `docs` beside the MAIN checkout — a worktree's own parent is not it. */
export function docsCheckout(): string | null {
  const fromEnv = process.env['DOMINEVO_DOCS_DIR']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
  const beside = join(dirname(dirname(common)), 'docs')
  return existsSync(join(beside, DOCS_MANIFEST_RELATIVE)) ? beside : null
}
