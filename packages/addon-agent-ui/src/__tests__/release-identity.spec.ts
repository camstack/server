import { describe, expect, it } from 'vitest'
import { describeRelease } from '../release-identity'

describe('describeRelease', () => {
  it('shows 0.1.0 beta next to the server package', () => {
    expect(
      describeRelease({
        productVersion: '0.1.0',
        serverVersion: '1.2.621',
        fallbackVersion: null,
      }),
    ).toEqual({ kind: 'both', productLabel: '0.1.0 beta', serverVersion: '1.2.621' })
  })

  it('uses the Electron app version when the product env is absent', () => {
    expect(
      describeRelease({
        productVersion: null,
        serverVersion: '1.2.621',
        fallbackVersion: '1.2.400',
      }),
    ).toEqual({ kind: 'server', serverVersion: '1.2.621' })
  })
})
