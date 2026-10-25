import { describe, expect, it } from 'vitest'
import { resolveIncludeCrops } from '../include-crops-default.js'

/**
 * The DEFAULT was the path that cannot complete.
 *
 * Measured on the live hub 2026-08-25, 500 rows: `faceGallery.listRecentFaces`
 * with crops inline took **60 457 ms and then timed out on the UDS channel**,
 * while the same call with `includeCrops: false` answered in 701 ms with
 * 297 KB. `plateGallery.listPlates` was 826 565 bytes inline against 31 173
 * without — a 96% difference on a call the Plates page polls.
 *
 * Both defaulted to `true`, so the DEFAULT behaviour of these endpoints was the
 * one that fails at production row counts, and the only thing holding the
 * system up was that all three known callers remembered to opt out. The next
 * caller to forget gets a 60-second timeout, in production.
 *
 * So the default inverts. It is a no-op for every caller that exists — the
 * admin UI and the viewer
 * (`FACE_ID_RESOLUTION_QUERY`) all pass `false` explicitly — and it makes the
 * expensive shape something a caller has to ASK for.
 */
describe('resolveIncludeCrops', () => {
  it('does NOT inline crops when the caller said nothing', () => {
    expect(resolveIncludeCrops(undefined)).toBe(false)
    expect(resolveIncludeCrops({})).toBe(false)
  })

  it('inlines them only when a caller explicitly asks', () => {
    expect(resolveIncludeCrops({ includeCrops: true })).toBe(true)
  })

  it('honours an explicit false, which is what every caller sends today', () => {
    expect(resolveIncludeCrops({ includeCrops: false })).toBe(false)
  })
})
