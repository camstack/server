import { describe, expect, it } from 'vitest'
import { sirenPlayDuration } from '../siren-play-duration.js'

describe('sirenPlayDuration', () => {
  it('plays until switched off (manual mode) when no duration is configured', () => {
    expect(sirenPlayDuration(true, undefined)).toBeUndefined()
  })

  it('treats 0 as "until switched off", never as "play zero times"', () => {
    expect(sirenPlayDuration(true, 0)).toBeUndefined()
  })

  it('plays a configured positive number of times', () => {
    expect(sirenPlayDuration(true, 3)).toBe(3)
  })

  it('sends no duration when switching off', () => {
    expect(sirenPlayDuration(false, 3)).toBeUndefined()
  })
})
