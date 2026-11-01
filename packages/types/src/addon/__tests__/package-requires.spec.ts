import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  describeUnmet,
  PackageRequiresSchema,
  unmetRequirements,
  type RunningVersions,
} from '../package-requires'

const running = (over: Partial<RunningVersions> = {}): RunningVersions => ({
  server: '1.5.0',
  addons: {},
  wrapper: { kind: 'native', version: null },
  ...over,
})

describe('compareVersions', () => {
  it('orders numerically, not lexically, and a prerelease below its release', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })
})

describe('PackageRequiresSchema', () => {
  it('accepts only ">=X.Y.Z" minimums', () => {
    expect(PackageRequiresSchema.safeParse({ server: '>=1.2.3' }).success).toBe(true)
    expect(PackageRequiresSchema.safeParse({ server: '^1.2.3' }).success).toBe(false)
    expect(PackageRequiresSchema.safeParse({ addons: { a: '1.0.0' } }).success).toBe(false)
  })
})

describe('unmetRequirements', () => {
  it('is empty without a declaration', () => {
    expect(unmetRequirements(undefined, running())).toEqual([])
  })

  it('names a server older than the addon needs', () => {
    expect(unmetRequirements({ server: '>=1.6.0' }, running())).toEqual([
      { kind: 'server-too-old', required: '1.6.0', running: '1.5.0' },
    ])
  })

  it('accepts a server at the minimum', () => {
    expect(unmetRequirements({ server: '>=1.5.0' }, running())).toEqual([])
  })

  it('treats an unreadable running server as not met', () => {
    expect(unmetRequirements({ server: '>=1.0.0' }, running({ server: null }))).toEqual([
      { kind: 'server-too-old', required: '1.0.0', running: null },
    ])
  })

  it('names an addon that is too old or absent', () => {
    const req = { addons: { '@camstack/addon-a': '>=2.0.0', '@camstack/addon-b': '>=1.0.0' } }
    expect(unmetRequirements(req, running({ addons: { '@camstack/addon-a': '1.9.0' } }))).toEqual([
      {
        kind: 'addon-too-old',
        packageName: '@camstack/addon-a',
        required: '2.0.0',
        running: '1.9.0',
      },
      { kind: 'addon-too-old', packageName: '@camstack/addon-b', required: '1.0.0', running: null },
    ])
  })

  it('binds a wrapper minimum only to the shell it names', () => {
    const req = { wrapper: { desktop: '>=3.0.0', image: '>=1.2.0' } }
    expect(unmetRequirements(req, running())).toEqual([])
    expect(
      unmetRequirements(req, running({ wrapper: { kind: 'desktop', version: '2.9.0' } })),
    ).toEqual([
      { kind: 'wrapper-too-old', wrapper: 'desktop', required: '3.0.0', running: '2.9.0' },
    ])
  })

  it('counts a wrapper that reports nothing as below the minimum', () => {
    expect(
      unmetRequirements(
        { wrapper: { image: '>=1.2.0' } },
        running({ wrapper: { kind: 'image', version: null } }),
      ),
    ).toEqual([{ kind: 'wrapper-too-old', wrapper: 'image', required: '1.2.0', running: null }])
  })
})

describe('describeUnmet', () => {
  it('names both versions', () => {
    expect(describeUnmet({ kind: 'server-too-old', required: '1.6.0', running: '1.5.0' })).toBe(
      'requires server >= 1.6.0, running 1.5.0',
    )
  })
})
