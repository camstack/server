import { Logger, LogLevel } from '@matter/main'
import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import { attachMatterJsLogger } from '../matter-js-logging.js'

function recorder(): { logger: IScopedLogger; lines: string[] } {
  const lines: string[] = []
  const logger: IScopedLogger = {
    debug: (m) => void lines.push(`debug:${m}`),
    info: (m) => void lines.push(`info:${m}`),
    warn: (m) => void lines.push(`warn:${m}`),
    error: (m) => void lines.push(`error:${m}`),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

function emit(level: LogLevel, text: string): void {
  const destination = Object.values(Logger.destinations).find(
    (d) => d.name === 'camstack-matter-broker',
  )
  destination?.write(text, { now: new Date(), level, facility: 'test', prefix: '', values: [] })
}

describe('attachMatterJsLogger', () => {
  it('maps severities, then restores the original default destination', () => {
    const original = Logger.destinations['default']
    const { logger, lines } = recorder()
    const detach = attachMatterJsLogger(logger)
    expect('default' in Logger.destinations).toBe(false)
    emit(LogLevel.DEBUG, 'd')
    emit(LogLevel.INFO, 'i')
    emit(LogLevel.WARN, 'w')
    emit(LogLevel.ERROR, 'e')
    emit(LogLevel.FATAL, 'f')
    expect(lines).toEqual(['debug:d', 'debug:i', 'warn:w', 'error:e', 'error:f'])
    detach()
    expect(Logger.destinations['default']).toBe(original)
  })

  it('is reference counted: the last detach restores', () => {
    const original = Logger.destinations['default']
    const a = attachMatterJsLogger(recorder().logger)
    const b = attachMatterJsLogger(recorder().logger)
    a()
    a()
    expect('default' in Logger.destinations).toBe(false)
    b()
    expect(Logger.destinations['default']).toBe(original)
  })
})
