/**
 * `check-runner-barrel-free` — the source-closure guard must follow RE-EXPORTS
 * (`export … from`, `export * from`) as well as imports. The barrel reached the
 * runner through `transport/index.ts` re-exporting a file with a bare
 * `@camstack/types` value import, and the guard only followed `import … from`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GUARDED_ENTRIES,
  findAddonDefinitionUses,
  findBarrelViolations,
} from '../check-runner-barrel-free.js'

const dirs: string[] = []

function fixture(files: Readonly<Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barrel-free-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const LEAF = "import { createEvent } from '@camstack/types'\nexport const x = createEvent\n"

const flagged = (files: Readonly<Record<string, string>>): readonly string[] => {
  const dir = fixture(files)
  return findBarrelViolations(path.join(dir, 'entry.ts'), dir).violations.map((v) => v.file)
}

describe('which edges the closure walk follows', () => {
  it('catches a barrel value import reached through `export { … } from`', () => {
    expect(
      flagged({
        'entry.ts': "export { x } from './sub/index.js'",
        'sub/index.ts': "export { x } from './leaf.js'",
        'sub/leaf.ts': LEAF,
      }),
    ).toEqual(['sub/leaf.ts'])
  })

  it('catches a barrel value import reached through `export * from`', () => {
    expect(flagged({ 'entry.ts': "export * from './leaf.js'", 'leaf.ts': LEAF })).toEqual([
      'leaf.ts',
    ])
  })

  it('catches a re-export of the barrel itself', () => {
    expect(flagged({ 'entry.ts': "export * from '@camstack/types'" })).toEqual(['entry.ts'])
    expect(flagged({ 'entry.ts': "export { createEvent } from '@camstack/types'" })).toEqual([
      'entry.ts',
    ])
  })

  it('catches a plain import, a side-effect import and a relative dynamic import', () => {
    expect(flagged({ 'entry.ts': LEAF })).toEqual(['entry.ts'])
    expect(flagged({ 'entry.ts': "import '@camstack/types'" })).toEqual(['entry.ts'])
    expect(
      flagged({ 'entry.ts': "export const l = () => import('./leaf.js')", 'leaf.ts': LEAF }),
    ).toEqual(['leaf.ts'])
  })
})

describe('what stays allowed', () => {
  it('lets type-only imports and type-only re-exports through', () => {
    expect(
      flagged({
        'entry.ts': [
          "import type { A } from '@camstack/types'",
          "import { type B } from '@camstack/types'",
          "export type { C } from '@camstack/types'",
          "export type * from '@camstack/types'",
        ].join('\n'),
      }),
    ).toEqual([])
  })

  it('lets the addon subpath and a type position `import()` through', () => {
    expect(
      flagged({
        'entry.ts':
          "import { createEvent } from '@camstack/types/addon'\nlet v: import('@camstack/types').Foo",
      }),
    ).toEqual([])
  })

  it('ignores a comment that mentions the barrel', () => {
    expect(
      flagged({ 'entry.ts': "// import { x } from '@camstack/types'\nexport const y = 1" }),
    ).toEqual([])
  })
})

describe('the real guarded entries', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

  it('guards the addon-runner AND the addon-utils entry', () => {
    expect(GUARDED_ENTRIES).toContain('packages/system/src/addon-utils.ts')
    expect(GUARDED_ENTRIES).toContain('packages/system/src/kernel/moleculer/addon-runner.ts')
  })

  it.each(GUARDED_ENTRIES)('%s reaches no barrel value import', (entry) => {
    expect(findBarrelViolations(path.join(root, entry), root).violations).toEqual([])
  })
})

describe('ALL_CAPABILITY_DEFINITIONS in addon server code', () => {
  const uses = (files: Readonly<Record<string, string>>): readonly string[] => {
    const dir = fixture(files)
    return findAddonDefinitionUses(dir).map((v) => `${v.file}:${v.line}`)
  }
  const USE =
    "import { ALL_CAPABILITY_DEFINITIONS } from '@camstack/types'\nexport const n = ALL_CAPABILITY_DEFINITIONS.length\n"

  it('flags server code with the file and line', () => {
    expect(uses({ 'packages/addon-x/src/gate.ts': USE })).toEqual([
      'packages/addon-x/src/gate.ts:1',
      'packages/addon-x/src/gate.ts:2',
    ])
  })

  it('lets specs, UI directories, the admin UI package and comments through', () => {
    expect(
      uses({
        'packages/addon-x/src/__tests__/a.spec.ts': USE,
        'packages/addon-x/src/b.spec.ts': USE,
        'packages/addon-x/src/ui/c.ts': USE,
        'packages/addon-x/src/widgets/d.ts': USE,
        'packages/addon-admin-ui/src/e.ts': USE,
        'packages/addon-x/src/f.ts':
          '// ALL_CAPABILITY_DEFINITIONS used to be read here\nexport const x = 1\n',
        'packages/system/src/g.ts': USE,
      }),
    ).toEqual([])
  })

  it('the real addons have none', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
    expect(findAddonDefinitionUses(root)).toEqual([])
  })
})
