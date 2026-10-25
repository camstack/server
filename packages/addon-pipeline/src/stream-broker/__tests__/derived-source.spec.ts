import { describe, expect, it } from 'vitest'
import { type DerivedSourceRef, derivedSourceToStreamRequest } from '../derived/derived-source.js'

describe('derivedSourceToStreamRequest', () => {
  it('maps a profile source to a ready getStreamWithCodec request (profile selector)', () => {
    const source: DerivedSourceRef = { kind: 'profile', profile: 'mid' }
    const result = derivedSourceToStreamRequest(source, 42)
    expect(result).toEqual({
      kind: 'ready',
      request: { deviceId: 42, video: 'copy', audio: 'aac', profile: 'mid' },
    })
  })

  it('maps a camStream source to a needs-resolver shape (cap has no camStream selector)', () => {
    const source: DerivedSourceRef = { kind: 'camStream', camStreamId: 'native:mid' }
    const result = derivedSourceToStreamRequest(source, 42)
    expect(result).toEqual({
      kind: 'needs-camstream-resolver',
      deviceId: 42,
      camStreamId: 'native:mid',
      video: 'copy',
      audio: 'aac',
    })
  })
})
