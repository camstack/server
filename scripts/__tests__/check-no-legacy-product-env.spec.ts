import { describe, expect, it } from 'vitest'
import { findLegacyProductEnv } from '../check-no-legacy-product-env'

const file = (rel: string, content: string) => ({ rel, content })

describe('check-no-legacy-product-env', () => {
  it('flags a raw legacy env read', () => {
    const f = findLegacyProductEnv([file('a/src/x.ts', "const r = process.env['CAMSTACK_ROLE']")])
    expect(f).toEqual([{ file: 'a/src/x.ts', line: 1, token: 'CAMSTACK_ROLE' }])
  })

  it('flags a Dockerfile ENV and a workflow variable', () => {
    const f = findLegacyProductEnv([
      file('Dockerfile', 'ENV CAMSTACK_DATA=/data'),
      file('.github/workflows/x.yml', 'CAMSTACK_FFMPEG_PATH: /x'),
    ])
    expect(f.map((x) => x.token)).toEqual(['CAMSTACK_DATA', 'CAMSTACK_FFMPEG_PATH'])
  })

  it('accepts the new names and code identifiers that are not env names', () => {
    const f = findLegacyProductEnv([
      file(
        'a.ts',
        'process.env.DOMINEVO_ROLE; RECORDING_SOURCE_CAMSTACK_ADDON; __CAMSTACK_EMBED__',
      ),
      file('b.ts', 'const o = CAMSTACK_APP_LINK_ORIGIN'),
    ])
    expect(f).toEqual([])
  })

  it('allows the rename tooling and the history', () => {
    const f = findLegacyProductEnv([
      file('scripts/rename/LAYER2.md', 'CAMSTACK_ROLE'),
      file('packages/x/CHANGELOG.md', 'CAMSTACK_ROLE'),
      file('docs/decisions/adr-1.md', 'CAMSTACK_ROLE'),
    ])
    expect(f).toEqual([])
  })
})

describe('check-no-legacy-product-env regex escapes', () => {
  it('flags a name that follows a regex word boundary or a newline escape', () => {
    const f = findLegacyProductEnv([
      file('a.ts', String.raw`const re = /\bCAMSTACK_TOKEN\b/`),
      file('b.ts', String.raw`const s = "x\nCAMSTACK_DATA=1"`),
    ])
    expect(f.map((x) => x.token)).toEqual(['CAMSTACK_TOKEN', 'CAMSTACK_DATA'])
  })
})
