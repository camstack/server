import { describe, expect, it } from 'vitest'
import { extractHostExternals, findHostExternalDrift } from '../check-host-externals-identical'

const ts = (items: string) =>
  `export const HOST_EXTERNAL_SPECIFIERS: readonly string[] = [\n${items}\n]\n`
const mjs = (items: string) => `const HOST_EXTERNAL_SPECIFIERS = [\n${items}\n]\n`

describe('check-host-externals-identical', () => {
  it('reads the quoted entries and ignores comments', () => {
    expect(
      extractHostExternals(ts(`  '@camstack/server/system',\n  // 'zod' is not here\n  'sharp',`)),
    ).toEqual(['@camstack/server/system', 'sharp'])
  })

  it('is silent when the lists agree', () => {
    const items = `  '@camstack/server/system',\n  'sharp',`
    expect(
      findHostExternalDrift([
        { rel: 'a.ts', content: ts(items) },
        { rel: 'b.mjs', content: mjs(items) },
      ]),
    ).toEqual([])
  })

  it('names the file that lacks a specifier the others carry', () => {
    const drift = findHostExternalDrift([
      { rel: 'a.ts', content: ts(`  '@camstack/server/system',\n  'sharp',`) },
      { rel: 'b.mjs', content: mjs(`  '@camstack/system',\n  'sharp',`) },
    ])
    expect(drift.map((d) => d.file)).toEqual(['a.ts', 'b.mjs'])
    expect(drift[0]?.missing).toEqual(['@camstack/system'])
    expect(drift[1]?.missing).toEqual(['@camstack/server/system'])
  })

  it('fails a file whose array it cannot find', () => {
    expect(findHostExternalDrift([{ rel: 'c.ts', content: 'export const x = 1' }])[0]?.file).toBe(
      'c.ts',
    )
  })
})
