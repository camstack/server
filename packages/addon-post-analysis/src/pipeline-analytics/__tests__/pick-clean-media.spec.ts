/**
 * Unit tests for `pickCleanMedia` — the crop-forced (viewer reel) media picker.
 *
 * The reel requests `?kind=crop` / `thumbnailSmall`; this picker returns a
 * subject crop (crop / thumbnail / thumbnailSmall) or undefined. Full-frame
 * fallback lives in `resolveCropForcedMedia` — a keyFrame still beats an icon.
 */
import { describe, it, expect } from 'vitest'
import type { MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { pickCleanMedia } from '../index.js'

function file(kind: MediaFile['kind'], mediaId?: number): MediaFile {
  return makeTestMediaFile({ kind, mediaId, base64: 'AAAA', sizeBytes: 4, timestamp: 1_000 })
}

describe('pickCleanMedia', () => {
  it('returns the exact crop when present', () => {
    const files = [file('fullFrameBoxed'), file('crop'), file('thumbnail')]
    expect(pickCleanMedia(files, 'crop')?.kind).toBe('crop')
  })

  it('degrades to the track thumbnail (subject crop since 2026-07-17) when the crop is missing', () => {
    const files = [file('fullFrameBoxed'), file('thumbnail'), file('fullFrame')]
    expect(pickCleanMedia(files, 'crop')?.kind).toBe('thumbnail')
  })

  it('does NOT degrade to a full frame when the subject crop is missing', () => {
    // 2026-08-24: gallery `?kind=thumbnailSmall` on a track with only keyFrame
    // used to paint the whole scene. A 404 (icon) is the honest miss.
    const files = [file('fullFrameBoxed'), file('fullFrame'), file('keyFrame')]
    expect(pickCleanMedia(files, 'crop')).toBeUndefined()
    expect(pickCleanMedia(files, 'thumbnailSmall')).toBeUndefined()
  })

  it('does NOT treat keyFrame as a crop substitute', () => {
    const files = [file('fullFrameBoxed'), file('lastFrame'), file('keyFrame')]
    expect(pickCleanMedia(files, 'crop')).toBeUndefined()
  })

  it('NEVER returns a boxed frame — undefined when only boxed media exists', () => {
    const files = [file('fullFrameBoxed'), file('lastFrame'), file('snapshot'), file('firstFrame')]
    expect(pickCleanMedia(files, 'crop')).toBeUndefined()
  })

  it('returns undefined for an empty media list', () => {
    expect(pickCleanMedia([], 'crop')).toBeUndefined()
  })

  it('prefers the crop over other clean frames', () => {
    const files = [file('keyFrame'), file('fullFrame'), file('crop')]
    expect(pickCleanMedia(files, 'crop')?.kind).toBe('crop')
  })

  it('still serves an explicitly requested non-crop kind (videoclips snapshot)', () => {
    const files = [file('snapshot'), file('keyFrame')]
    expect(pickCleanMedia(files, 'snapshot')?.kind).toBe('snapshot')
    expect(pickCleanMedia(files, 'keyFrame')?.kind).toBe('keyFrame')
  })
})
