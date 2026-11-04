/**
 * The exposure lists live in a record; after the migration nothing reads the old settings keys.
 * A runtime reader of `config.exposed` / `config.exposedActions` would be a second path that
 * serves an empty list on a store the migration already emptied.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === '__tests__' || name === 'migrations') return []
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('no runtime reader of the legacy exposure keys', () => {
  it('reads exposure only through the record', () => {
    const code = (file: string): string[] =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    const offenders = sources(SRC).filter((file) =>
      code(file).some((line) => /config\??\.(exposed|exposedActions)\b/.test(line)),
    )
    expect(offenders).toEqual([])
  })
})
