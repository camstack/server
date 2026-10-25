import { describe, expect, it } from 'vitest'
import { describeRelease, parseReleaseIdentity } from '../release-identity'

describe('describeRelease', () => {
  it('shows the product as beta and the server package beside it', () => {
    expect(
      describeRelease({
        productVersion: '0.1.0',
        serverVersion: '1.2.621',
        fallbackVersion: '1.2.466',
      }),
    ).toEqual({ kind: 'both', productLabel: '0.1.0 beta', serverVersion: '1.2.621' })
  })

  it('does not label a 1.x product as beta', () => {
    expect(
      describeRelease({
        productVersion: '1.0.0',
        serverVersion: '1.2.621',
        fallbackVersion: null,
      }),
    ).toEqual({ kind: 'both', productLabel: '1.0.0', serverVersion: '1.2.621' })
  })

  it('falls back to the addon version when the hub has not answered', () => {
    expect(
      describeRelease({ productVersion: null, serverVersion: null, fallbackVersion: '1.2.466' }),
    ).toEqual({ kind: 'fallback', version: '1.2.466' })
  })
})

describe('parseReleaseIdentity', () => {
  it('reads the two versions and nothing else', () => {
    expect(parseReleaseIdentity({ productVersion: '0.1.0', serverVersion: '1.2.621' })).toEqual({
      productVersion: '0.1.0',
      serverVersion: '1.2.621',
    })
  })

  it('refuses a body that is not an object', () => {
    expect(parseReleaseIdentity('0.1.0')).toBeNull()
  })
})
