import { describe, expect, it } from 'vitest'
import {
  portsSurfaceProblems,
  SEAM_FILE,
  type SourceFile,
  withoutComments,
} from '../lib/migration-ports-surface.js'

const CATALOGUE = 'packages/addon-provider-x/src/migrations/2026-11-01-move.ts'
const HUB = 'packages/system/src/migrations/hub/2026-11-01-move.ts'

function file(path: string, text: string): SourceFile {
  return { path, text }
}

describe('check-migration-ports-surface', () => {
  it('passes a catalogue that imports types, zod and its neighbours only', () => {
    const files = [
      file(
        CATALOGUE,
        "import { z } from 'zod'\nimport type { MigrationApiV1 } from '@camstack/types'\nimport { helper } from './helper.js'\nexport const x = 1\n",
      ),
    ]
    expect(portsSurfaceProblems(files, [])).toEqual([])
  })

  it('refuses ctx and this.ctx in a catalogue source, hub or addon', () => {
    const problems = portsSurfaceProblems(
      [
        file(CATALOGUE, 'export const f = (ctx) => ctx.api.devices\n'),
        file(HUB, 'export class A { f() { return this.ctx.api } }\n'),
      ],
      [],
    )
    expect(problems).toHaveLength(2)
    expect(problems.every((p) => p.includes('reads `ctx`'))).toBe(true)
  })

  it('does not take a comment that names ctx.api for a use of it', () => {
    const text = '/** over ctx.api */\n// ctx.records too\nexport const a = 1\n'
    expect(portsSurfaceProblems([file(CATALOGUE, text)], [])).toEqual([])
    expect(withoutComments("const u = 'http://x' // ctx.a")).toContain("'http://x'")
  })

  it('refuses a server import in a catalogue source', () => {
    const problems = portsSurfaceProblems(
      [file(CATALOGUE, "import { fs } from 'node:fs'\nimport { a } from '@camstack/system'\n")],
      [],
    )
    expect(problems).toHaveLength(2)
  })

  it('leaves the engine and the definition helpers out of scope', () => {
    const engine = file(
      'packages/system/src/builtins/sqlite-storage/migrations/migration-engine.ts',
      "import fs from 'node:fs'\nconst c = ctx.x\n",
    )
    expect(portsSurfaceProblems([engine], [])).toEqual([])
  })

  it('allows defineAddonMigrations( only in the seam, or in a pending file', () => {
    const caller = file('packages/addon-y/src/y.addon.ts', 'defineAddonMigrations(CAT, ports)\n')
    const seam = file(SEAM_FILE, 'defineAddonMigrations(catalogue, bindPorts(api))\n')
    expect(portsSurfaceProblems([seam], [])).toEqual([])
    expect(portsSurfaceProblems([caller], [])).toHaveLength(1)
    expect(portsSurfaceProblems([caller], [caller.path])).toEqual([])
  })

  it('refuses a pending entry that no longer calls it, so the list only shrinks', () => {
    const converted = file(
      'packages/addon-y/src/y.addon.ts',
      'this.runMigrations(CAT, (api) => p)\n',
    )
    const problems = portsSurfaceProblems([converted], [converted.path])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('delete the entry')
  })
})
