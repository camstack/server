import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The sign-in and the renewal are in-house; `alexa-cookie2` must stay only what it is in the
 * lockfile, a transitive dependency of `alexa-remote2` that this addon never loads. The module
 * headers that credit its MIT origin mention the name in comments; only an import counts here.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = path.join(SRC, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'fixtures' ? [] : sources(full)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : []
  })
}

const IMPORT_OF =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]alexa-cookie2(?:\/[^'"]*)?['"]/

describe('alexa-cookie2 stays out of this addon', () => {
  it('is not imported by any source file', () => {
    const offenders = sources(SRC).filter((file) => IMPORT_OF.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('is not a dependency of the package', () => {
    const manifest: unknown = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'))
    expect(JSON.stringify(manifest)).not.toContain('alexa-cookie2')
  })

  it('the import detector sees the shapes it is meant to forbid', () => {
    for (const line of [
      "import AlexaCookie from 'alexa-cookie2'",
      "const c = require('alexa-cookie2')",
      "await import('alexa-cookie2/lib/x.js')",
      "import 'alexa-cookie2'",
    ]) {
      expect(IMPORT_OF.test(line)).toBe(true)
    }
    expect(IMPORT_OF.test('// adapted from alexa-cookie2 (MIT)')).toBe(false)
  })
})
