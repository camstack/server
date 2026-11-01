/**
 * The starter layer ports the requirement check (it cannot import a runtime
 * value from `@camstack/types`). One table, both implementations: they cannot
 * drift without this failing.
 */
import { type PackageRequires, type RunningWrapper, unmetRequirements } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { addonsBelowMinimum, unmetWrapperRequirements } from '../requirements.js'

const WRAPPERS: readonly RunningWrapper[] = [
  { kind: 'image', version: '1.2.600' },
  { kind: 'image', version: null },
  { kind: 'desktop', version: '0.1.6' },
  { kind: 'desktop', version: '0.2.0' },
  { kind: 'native', version: null },
  { kind: 'unknown', version: null },
]
const REQUIRES: readonly PackageRequires[] = [
  {},
  { wrapper: { image: '>=1.2.600' } },
  { wrapper: { image: '>=1.2.601', desktop: '>=0.2.0' } },
  { wrapper: { desktop: '>=0.1.7' } },
  { addons: { '@camstack/a': '>=2.0.0', '@camstack/b': '>=1.0.0-beta.1' } },
]
const INSTALLED = [
  {},
  { '@camstack/a': '2.0.0', '@camstack/b': '1.0.0' },
  { '@camstack/a': '1.9.9' },
]

describe('requirements port parity', () => {
  it('agrees with @camstack/types on every wrapper case', () => {
    for (const requires of REQUIRES)
      for (const wrapper of WRAPPERS) {
        const expected = unmetRequirements(requires, {
          server: '1.0.0',
          addons: {},
          wrapper,
        }).filter((u) => u.kind === 'wrapper-too-old')
        expect(
          unmetWrapperRequirements(requires, wrapper),
          JSON.stringify({ requires, wrapper }),
        ).toEqual(expected)
      }
  })

  it('agrees with @camstack/types on every addon case', () => {
    for (const requires of REQUIRES)
      for (const installed of INSTALLED) {
        const expected = unmetRequirements(requires, {
          server: '1.0.0',
          addons: installed,
          wrapper: null,
        })
          .filter((u) => u.kind === 'addon-too-old')
          .map((u) => ({ packageName: u.packageName, required: u.required, installed: u.running }))
        expect(
          addonsBelowMinimum(requires, installed),
          JSON.stringify({ requires, installed }),
        ).toEqual(expected)
      }
  })
})
