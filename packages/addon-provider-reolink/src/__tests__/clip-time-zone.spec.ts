import { describe, expect, it } from 'vitest'
import { resolveClipTimeZone, resolveClipTimeZoneOnce } from '../clips/clip-time-zone.js'
import { alarmJoinKey } from '../clips/clip-alarm-labels.js'
import { createRecordingLogger } from './clip-test-logger.js'

describe('clip time zone', () => {
  it('keeps a valid zone', () => {
    expect(resolveClipTimeZone('Europe/Rome', 'Europe/Paris')).toEqual({ timeZone: 'Europe/Rome' })
  })
  it('falls back to the camera zone, then UTC, for Etc/Unknown', () => {
    expect(resolveClipTimeZone('Etc/Unknown', 'Europe/Rome')).toEqual({
      timeZone: 'Europe/Rome',
      rejected: 'Etc/Unknown',
    })
    expect(resolveClipTimeZone('Etc/Unknown', undefined).timeZone).toBe('UTC')
  })
  it('warns once per device and the catalog formatter then works', () => {
    const logger = createRecordingLogger()
    const warned = { done: false }
    const tz1 = resolveClipTimeZoneOnce('Etc/Unknown', undefined, logger, 592, warned)
    resolveClipTimeZoneOnce('Etc/Unknown', undefined, logger, 592, warned)
    expect(logger.warns).toHaveLength(1)
    expect(JSON.stringify(logger.warns[0]?.extras)).toContain('Etc/Unknown')
    expect(logger.warns[0]?.extras.tags).toEqual({ deviceId: 592 })
    expect(() => alarmJoinKey(Date.now(), tz1)).not.toThrow()
    expect(() => alarmJoinKey(Date.now(), 'Etc/Unknown')).toThrow(/Invalid time zone/)
  })
  it('a valid zone never warns', () => {
    const logger = createRecordingLogger()
    resolveClipTimeZoneOnce('Europe/Rome', undefined, logger, 1, { done: false })
    expect(logger.warns).toHaveLength(0)
  })
})
