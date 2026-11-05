import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, LogExtras } from '../../interfaces/logging.js'
import {
  isUsableTimeZone,
  processTimeZoneOr,
  resetProcessTimeZoneWarning,
  usableProcessTimeZone,
} from '../process-time-zone.js'

describe('process time zone', () => {
  beforeEach(() => resetProcessTimeZoneWarning())

  it('refuses Etc/Unknown, empty and invalid zones', () => {
    expect(isUsableTimeZone('Etc/Unknown')).toBe(false)
    expect(isUsableTimeZone('')).toBe(false)
    expect(isUsableTimeZone('Not/AZone')).toBe(false)
    expect(isUsableTimeZone('Europe/Rome')).toBe(true)
  })

  it('returns the process zone only when usable', () => {
    expect(usableProcessTimeZone({ read: () => 'Europe/Rome' })).toBe('Europe/Rome')
    expect(usableProcessTimeZone({ read: () => 'Etc/Unknown' })).toBeNull()
  })

  it('falls back and warns once with the rejected value', () => {
    const warn = vi.fn<(message: string, extras?: LogExtras) => void>()
    const logger: IScopedLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn,
      error: () => undefined,
      child: () => logger,
      withTags: () => logger,
    }
    const probe = { read: () => 'Etc/Unknown' }
    expect(processTimeZoneOr('UTC', logger, probe)).toBe('UTC')
    expect(processTimeZoneOr('UTC', logger, probe)).toBe('UTC')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ meta: { rejectedTimeZone: 'Etc/Unknown' } })
  })
})
