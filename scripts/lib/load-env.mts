/**
 * Tiny zero-dependency .env loader for the Reolink smoke-test scripts.
 *
 * Usage from a test script:
 *
 *   import { loadEnv } from './lib/load-env.js'
 *   loadEnv('.env.reolink')
 *
 * Behaviour:
 *   - Looks for `<repoRoot>/<filename>` then the CWD as a fallback.
 *   - Skips lines that are blank or start with `#`.
 *   - `KEY=value` parses the value verbatim — surrounding double quotes
 *     are stripped, no shell-style escape interpolation.
 *   - Existing `process.env[KEY]` is NEVER overwritten (so an explicit
 *     command-line `KEY=value npx tsx ...` still wins).
 *   - Silent no-op when the file is missing — the test script just
 *     continues with whatever env vars are already set.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function findEnvFile(filename: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  // Walk up from this script's location to find the repo root marker.
  let dir = here
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, filename)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const cwdCandidate = resolve(process.cwd(), filename)
  return existsSync(cwdCandidate) ? cwdCandidate : null
}

export function loadEnv(filename: string): boolean {
  const path = findEnvFile(filename)
  if (!path) return false

  const content = readFileSync(path, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
  return true
}
