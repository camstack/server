import { describe, it, expect } from 'vitest'
import { isWorkerRequest, isWorkerReply } from '../worker-protocol.js'

describe('worker-protocol — nativeCrop request/reply guards', () => {
  it('accepts a well-formed nativeCrop request (with and without maxWidth)', () => {
    expect(
      isWorkerRequest({
        kind: 'nativeCrop',
        requestId: 5,
        frameId: 12,
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      }),
    ).toBe(true)
    expect(
      isWorkerRequest({
        kind: 'nativeCrop',
        requestId: 5,
        frameId: 12,
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        maxWidth: 256,
      }),
    ).toBe(true)
  })

  it('rejects a nativeCrop request with a malformed bbox or non-finite ids', () => {
    expect(
      isWorkerRequest({ kind: 'nativeCrop', requestId: 1, frameId: 1, bbox: { x: 0, y: 0, w: 0 } }),
    ).toBe(false)
    expect(
      isWorkerRequest({
        kind: 'nativeCrop',
        requestId: Number.NaN,
        frameId: 1,
        bbox: { x: 0, y: 0, w: 0, h: 0 },
      }),
    ).toBe(false)
    expect(
      isWorkerRequest({
        kind: 'nativeCrop',
        requestId: 1,
        frameId: 1,
        bbox: { x: 0, y: 0, w: 0, h: 0 },
        maxWidth: 'big',
      }),
    ).toBe(false)
  })

  it('accepts a nativeCropResult reply (raw bytes) and a nativeCropMiss reply', () => {
    expect(
      isWorkerReply({
        kind: 'nativeCropResult',
        requestId: 5,
        bytes: new Uint8Array([1, 2, 3]),
        width: 64,
        height: 48,
      }),
    ).toBe(true)
    expect(
      isWorkerReply({
        kind: 'nativeCropResult',
        requestId: 5,
        bytes: new Uint8Array([1, 2, 3]),
        width: 64,
        height: 48,
        source: 'tile',
      }),
    ).toBe(true)
    expect(isWorkerReply({ kind: 'nativeCropMiss', requestId: 5 })).toBe(true)
  })

  it('rejects a nativeCropResult whose bytes are not a Uint8Array (base64/array leak guard)', () => {
    expect(
      isWorkerReply({
        kind: 'nativeCropResult',
        requestId: 5,
        bytes: [1, 2, 3],
        width: 1,
        height: 1,
      }),
    ).toBe(false)
  })

  it('accepts a well-formed releaseNativeLease request and rejects a non-finite frameId', () => {
    expect(isWorkerRequest({ kind: 'releaseNativeLease', frameId: 7 })).toBe(true)
    expect(isWorkerRequest({ kind: 'releaseNativeLease', frameId: 'x' })).toBe(false)
    expect(isWorkerRequest({ kind: 'releaseNativeLease' })).toBe(false)
  })
})
