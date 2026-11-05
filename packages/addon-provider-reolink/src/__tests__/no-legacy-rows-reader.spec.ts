/**
 * After the rows-to-record move (planning#416, D1007) nothing in this addon's runtime reads or
 * writes the legacy integration rows: the connection comes from the integration's
 * record only. A reader put back (a fallback, an alias, a dual read) fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
// The addon-level fleet default (`deviceDefaultsSchema`) stays: it holds the clip refresh default, not a connection.
const LEGACY_READS = [
  /integrations\.(getSettings|setSettings|clearSettings)\b/,
  /\bgetIntegrationSettings\b/,
  /\b(protected|override)\s+(override\s+)?(async\s+)?integrationFormSchema\b/,
]

function runtimeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : runtimeFiles(path)
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

describe('no runtime reader of the legacy integration rows', () => {
  it('reads the integration record, never the rows', () => {
    const offenders = runtimeFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return LEGACY_READS.filter((re) => re.test(text)).map(
        (re) => `${file.slice(SRC.length)} matches ${re.source}`,
      )
    })
    expect(offenders).toEqual([])
  })
})
