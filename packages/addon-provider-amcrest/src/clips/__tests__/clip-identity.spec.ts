/**
 * Clip identity — the time window, because that is what `/cam/playback`
 * accepts and `FilePath` is not.
 */
import { describe, expect, it } from 'vitest'

import {
  CLIP_SOURCE_ONBOARD,
  clipKeyFor,
  clipKeyOf,
  mintClipId,
  parseClipId,
} from '../clip-identity.js'

const START_MS = Date.UTC(2026, 8, 23, 8, 23, 27)
const END_MS = Date.UTC(2026, 8, 23, 8, 24, 41)

describe('mintClipId / parseClipId', () => {
  it('round-trips the window', () => {
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, startMs: START_MS, endMs: END_MS })
    expect(id).toBe(`${CLIP_SOURCE_ONBOARD}:${String(START_MS / 1000)}-${String(END_MS / 1000)}`)
    const parsed = parseClipId(id)
    expect(parsed).toEqual({ source: CLIP_SOURCE_ONBOARD, startMs: START_MS, endMs: END_MS })
    expect(parsed === null ? '' : clipKeyOf(parsed)).toBe(clipKeyFor(START_MS, END_MS))
  })

  it('refuses an id another source minted', () => {
    // This is how the collection dispatcher's "nobody claimed this id" branch
    // stays honest: an id is never routed here by prefix luck.
    expect(parseClipId('native:reolink:onboard:0:Zm9v')).toBeNull()
    expect(parseClipId('native:hikvision:onboard:101:Zm9v')).toBeNull()
    expect(parseClipId('analytics:visit:1')).toBeNull()
    expect(parseClipId('')).toBeNull()
  })

  it('refuses a zero-length window — a JPEG row wearing a clip id', () => {
    expect(parseClipId(`${CLIP_SOURCE_ONBOARD}:1000-1000`)).toBeNull()
    expect(parseClipId(`${CLIP_SOURCE_ONBOARD}:1001-1000`)).toBeNull()
  })

  it('refuses a key that is not two integers — the segment reaches a filesystem', () => {
    expect(parseClipId(`${CLIP_SOURCE_ONBOARD}:../../etc-1`)).toBeNull()
    expect(parseClipId(`${CLIP_SOURCE_ONBOARD}:abc-def`)).toBeNull()
    expect(parseClipId(`${CLIP_SOURCE_ONBOARD}:1000`)).toBeNull()
  })
})
