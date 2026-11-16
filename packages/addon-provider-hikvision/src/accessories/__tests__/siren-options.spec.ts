import { describe, expect, it } from 'vitest'
import { buildHikvisionSirenOptions } from '../siren-options.js'

describe('hikvision siren options', () => {
  it('is real seconds, defaulting to the configured pulse', () => {
    const options = buildHikvisionSirenOptions({
      pulseDurationMs: 8_000,
      portConfirmedByCamera: true,
      nowMs: 5,
    })
    expect(options.unit).toBe('seconds')
    expect(options.secondsPerPlay).toBeNull()
    expect(options.defaultSeconds).toBe(8)
    expect(options.source).toBe('camera')
    expect(options.fetchedAt).toBe(5)
  })

  it('says fallback when the camera did not confirm the alarm input', () => {
    expect(
      buildHikvisionSirenOptions({ pulseDurationMs: 5_000, portConfirmedByCamera: false, nowMs: 1 })
        .source,
    ).toBe('fallback')
  })

  it('never defaults to zero or beyond the bound', () => {
    const none = buildHikvisionSirenOptions({
      pulseDurationMs: 0,
      portConfirmedByCamera: true,
      nowMs: 1,
    })
    expect(none.defaultSeconds).toBe(1)
    const huge = buildHikvisionSirenOptions({
      pulseDurationMs: 9_999_999,
      portConfirmedByCamera: true,
      nowMs: 1,
    })
    expect(huge.defaultSeconds).toBe(600)
  })
})
