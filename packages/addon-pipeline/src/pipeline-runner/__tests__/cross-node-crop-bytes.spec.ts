/**
 * A cross-node crop is base64 only for a caller that cannot read bytes (D462).
 *
 * ## The measurement
 *
 * 2026-09-11, live hub, one minute of `[mem] hub-main`:
 *
 *   pipeline-analytics!pipeline-runner.getNativeCrop       224078kB/219 : r85/d134
 *   pipeline-analytics!pipeline-runner.getParkedTrackFrame 179445kB/70  : r0/d70
 *
 * Four hundred megabytes a minute of already-compressed JPEG, and the `d`
 * half of that census is the expensive half: a DECODED forward means hub-main
 * materialised the payload rather than copying it through. Each of those
 * payloads is a base64 STRING of 1.8-2.5 MB, so hub-main was allocating
 * multi-megabyte strings in old space at several per second — while `oldSpace`
 * sat at 1041 MB.
 *
 * The consumer's very next statement was `Buffer.from(reply.jpeg, 'base64')`.
 * Nothing wanted the string. It existed because the schema said `z.string()`.
 *
 * ## Why a flag rather than just changing the field
 *
 * Dropping base64 unilaterally breaks a consumer that has not been redeployed
 * yet, and leaving both fields populated pays the base64 cost anyway — which
 * is the entire cost being removed. So the CALLER declares what it can read,
 * exactly as D455 made the audio consumer declare its `accept`, and a caller
 * that says nothing keeps the old wire verbatim.
 *
 * The transport was never the obstacle: `NativeCropResultSchema.bytes` has
 * carried a `Uint8Array` across this same boundary all along.
 */
import { describe, expect, it } from 'vitest'
import { encodeCrossNodeCrop } from '../on-demand-retention.js'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

describe('encodeCrossNodeCrop', () => {
  it('hands the bytes through untouched when the caller accepts them', () => {
    const out = encodeCrossNodeCrop({ jpeg: JPEG, acceptBytes: true })
    expect(out?.jpegBytes).toEqual(JPEG)
    expect(out?.jpeg, 'base64 was produced for a caller that never asked for it').toBeUndefined()
  })

  it('still answers a caller that did not declare it, byte-for-byte as before', () => {
    const out = encodeCrossNodeCrop({ jpeg: JPEG, acceptBytes: false })
    expect(out?.jpeg).toBe(Buffer.from(JPEG).toString('base64'))
    expect(out?.jpegBytes).toBeUndefined()
  })

  it('treats an absent declaration as the old wire, never as consent', () => {
    // A pre-D462 consumer sends no flag at all. Reading `undefined` as "yes"
    // would hand it a Uint8Array where its code does Buffer.from(x,'base64').
    const out = encodeCrossNodeCrop({ jpeg: JPEG })
    expect(out?.jpeg).toBe(Buffer.from(JPEG).toString('base64'))
    expect(out?.jpegBytes).toBeUndefined()
  })

  it('is a miss when there is no jpeg, on either path', () => {
    expect(encodeCrossNodeCrop({ acceptBytes: true })).toBeNull()
    expect(encodeCrossNodeCrop({})).toBeNull()
  })
})
