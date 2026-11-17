import { describe, expect, it } from 'vitest'
import { clipDialCapInput, clipReadCapInput } from '../clip-cap-input'

/**
 * The broker's clip calls into `videoclips` (`readClipBytes`, `dialClipStream`)
 * carry the operator's wake when — and only when — the handle the viewer's
 * `playClip` built says so. A sleeping standalone battery camera refuses a
 * read without it, so a dropped field here is every SD clip on such a camera
 * answering `sleeping` (planning#566).
 */
describe('the broker clip cap inputs', () => {
  const base = {
    deviceId: 640,
    clipId: 'native:reolink:onboard:0:AAAA',
    provider: 'provider-reolink',
    profile: 'low' as const,
  }

  it('the operator dial carries the authorised wake', () => {
    expect(clipDialCapInput({ ...base, audio: 'opus', wake: 'authorised' })).toEqual({
      deviceId: 640,
      clipId: 'native:reolink:onboard:0:AAAA',
      provider: 'provider-reolink',
      profile: 'low',
      audio: 'opus',
      wake: 'authorised',
    })
  })

  it('the operator file read carries the authorised wake', () => {
    expect(clipReadCapInput({ ...base, wake: 'authorised' })).toMatchObject({ wake: 'authorised' })
  })

  it('an unstated wake is no wake — the key is absent, never defaulted', () => {
    expect('wake' in clipDialCapInput({ ...base, audio: 'none' })).toBe(false)
    expect('wake' in clipReadCapInput(base)).toBe(false)
  })

  it('a null profile is the provider default, not a field', () => {
    expect('profile' in clipReadCapInput({ ...base, profile: null })).toBe(false)
  })
})
