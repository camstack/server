import { describe, expect, it } from 'vitest'
import { missingDeclarations, type PackageFacts } from '../check-requires-declared'

const addon = (camstack: Record<string, unknown>): PackageFacts => ({
  dir: 'packages/addon-x',
  name: '@camstack/addon-x',
  private: false,
  camstack,
})

describe('check-requires-declared (D988)', () => {
  it('refuses a published addon with no declaration', () => {
    expect(missingDeclarations([addon({ addons: [] })])).toEqual([
      'packages/addon-x (@camstack/addon-x) declares no camstack.requires.server',
    ])
  })

  it('refuses a declaration that is not a range the resolver can read', () => {
    expect(
      missingDeclarations([addon({ addons: [], requires: { server: 'latest' } })]),
    ).toHaveLength(1)
  })

  it('accepts an addon that declares the server it needs', () => {
    expect(missingDeclarations([addon({ addons: [], requires: { server: '>=1.2.718' } })])).toEqual(
      [],
    )
  })

  it('holds the wrappers to the same rule', () => {
    const wrapper: PackageFacts = {
      dir: 'packages/desktop',
      name: '@camstack/desktop',
      private: true,
      camstack: null,
    }
    expect(missingDeclarations([wrapper])).toHaveLength(1)
  })

  it('ignores a private package and the server itself', () => {
    expect(
      missingDeclarations([
        {
          dir: 'packages/system',
          name: '@camstack/server-framework',
          private: true,
          camstack: { addons: [] },
        },
        {
          dir: 'server/backend',
          name: '@camstack/server',
          private: false,
          camstack: { addons: [] },
        },
      ]),
    ).toEqual([])
  })
})
