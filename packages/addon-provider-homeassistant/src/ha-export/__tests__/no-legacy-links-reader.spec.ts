/**
 * What the export carries to an instance lives in its `ha-export-links` record; after the
 * migration nothing in the runtime reads the old shape. A reader of the `membership` setting, of
 * the dynamic `exportTo:` / `mediaRole:` store keys, or of the integration's settings would be a
 * second path that answers "off" or "empty" on a store the migration already emptied.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
/** The only module that names the form keys (they are form fields, routed to the records). */
const FORM_KEYS_MODULE = 'link-records.ts'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === '__tests__' || name === 'migrations') return []
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

const code = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))

const FORBIDDEN: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: 'the membership setting', pattern: /config\??\.membership\b|\bmembership:\s*\{/ },
  // The one allowed mention binds the migration catalogue's `readStored` port.
  { what: 'the raw addon store', pattern: /^(?!.*\breadStored:).*\bresolveGlobalStore\b/ },
  { what: 'the instance settings of an integration', pattern: /ha-instance-settings/ },
  { what: 'the integrations capability', pattern: /\bapi\.integrations\b|integration_settings/ },
]

describe('no runtime reader of the legacy export shape', () => {
  for (const { what, pattern } of FORBIDDEN) {
    it(`never reads ${what}`, () => {
      const offenders = sources(SRC).filter((file) => code(file).some((l) => pattern.test(l)))
      expect(offenders).toEqual([])
    })
  }

  it('names the dynamic exportTo: / mediaRole: keys only where the form routes them', () => {
    const offenders = sources(SRC).filter(
      (file) =>
        !file.endsWith(FORM_KEYS_MODULE) &&
        code(file).some((l) => /['"`](exportTo|mediaRole):/.test(l)),
    )
    expect(offenders).toEqual([])
  })
})
