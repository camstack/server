/**
 * What the export carries to a target lives in its `ha-export-targets` record; after the
 * migrations nothing in the runtime reads the old shape. A reader of the retired `ha-export-links`
 * kind, of the `membership` setting, of the dynamic `exportTo:` / `mediaRole:` store keys, of the
 * `knownBrokers` / `reconcileIntervalSec` settings or of the integration's settings would be a
 * second path that answers "off" or "empty" on a store the migrations already emptied. The old
 * names live under `migrations/` only.
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

const code = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))

const FORBIDDEN: readonly {
  readonly what: string
  readonly pattern: RegExp
}[] = [
  {
    what: 'the membership setting',
    pattern: /config\??\.membership\b|\bmembership:\s*\{/,
  },
  // The one allowed mention binds the migration catalogue's `readStored` port.
  {
    what: 'the raw addon store',
    pattern: /^(?!.*\breadStored:).*\bresolveGlobalStore\b/,
  },
  {
    what: 'the instance settings of an integration',
    pattern: /ha-instance-settings/,
  },
  {
    what: 'the integrations capability',
    pattern: /\bapi\.integrations\b/,
  },
  {
    what: 'the retired ha-export-links kind',
    pattern: /ha-export-links|ExportLinks|haExportLinksKind/,
  },
  { what: 'the retired knownBrokers cache', pattern: /knownBrokers/ },
  {
    what: 'the retired addon-level reconcile interval',
    pattern: /config\??\.reconcileIntervalSec/,
  },
  { what: 'the retired global settings page', pattern: /globalSettingsSchema/ },
  {
    what: 'the dynamic exportTo: / mediaRole: keys',
    pattern: /['"`](exportTo|mediaRole):/,
  },
]

describe('no runtime reader of the legacy export shape', () => {
  for (const { what, pattern } of FORBIDDEN) {
    it(`never reads ${what}`, () => {
      const offenders = sources(SRC).filter((file) => code(file).some((l) => pattern.test(l)))
      expect(offenders).toEqual([])
    })
  }
})
