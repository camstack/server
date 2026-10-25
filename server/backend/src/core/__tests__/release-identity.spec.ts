import { describe, expect, it } from 'vitest'
import { releaseIdentityFrom } from '../release-identity'

describe('releaseIdentityFrom', () => {
  it('keeps the product release and the server package as two versions', () => {
    expect(
      releaseIdentityFrom({
        productVersionEnv: '0.1.0',
        serverVersion: '1.2.621',
      }),
    ).toEqual({ productVersion: '0.1.0', serverVersion: '1.2.621' })
  })

  it('treats a missing product version as absent, not as the server version', () => {
    expect(
      releaseIdentityFrom({
        productVersionEnv: undefined,
        serverVersion: '1.2.621',
      }),
    ).toEqual({ productVersion: null, serverVersion: '1.2.621' })
  })

  it('treats a blank product version as absent', () => {
    expect(
      releaseIdentityFrom({ productVersionEnv: '  ', serverVersion: '1.2.621' }).productVersion,
    ).toBeNull()
  })
})
