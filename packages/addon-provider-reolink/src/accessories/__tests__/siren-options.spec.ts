import { describe, expect, it } from 'vitest'
import {
  buildReolinkSirenOptions,
  playsForSeconds,
  SIREN_MAX_PLAYS,
  secondsForPlays,
} from '../siren-options.js'

describe('reolink siren options', () => {
  it('reports plays converted to seconds, honestly marked as a fallback', () => {
    const options = buildReolinkSirenOptions({ configuredPlays: 3, secondsPerPlay: 4, nowMs: 9 })
    expect(options.unit).toBe('plays')
    expect(options.secondsPerPlay).toBe(4)
    expect(options.source).toBe('fallback')
    expect(options.defaultSeconds).toBe(12)
    expect(options.rangeSeconds).toEqual({ min: 4, max: SIREN_MAX_PLAYS * 4, step: 4 })
  })

  it('a configured count of 0 (manual) does not become a zero-length default', () => {
    expect(
      buildReolinkSirenOptions({ configuredPlays: 0, secondsPerPlay: 2, nowMs: 1 }).defaultSeconds,
    ).toBeGreaterThan(0)
  })

  it('converts a requested duration into a whole number of plays and back', () => {
    const options = buildReolinkSirenOptions({ configuredPlays: 3, secondsPerPlay: 4, nowMs: 1 })
    expect(options.rangeSeconds?.step).toBe(4)
    expect(playsForSeconds(11, 4)).toBe(3)
    expect(secondsForPlays(3, 4)).toBe(12)
  })

  it('never asks the camera for zero plays', () => {
    expect(playsForSeconds(0.2, 4)).toBe(1)
  })
})
