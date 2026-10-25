/**
 * The mirror the log path reads, and what it costs when nothing is configured.
 *
 * The load-bearing test here is `costs one boolean read while unrestricted`:
 * it hands the gate an entry whose `level` getter THROWS. An unconfigured hub
 * emits every line through this gate, so the guard has to be the FIRST
 * statement — the moment it moves below a field access, this spec fails
 * instead of the hub silently paying for a knob nobody set.
 *
 * Neutralisation checked: inverting `if (!this.restricted) return true` to read
 * the rank first makes the first test throw. Confirmed 2026-08-27.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_LOG_LEVEL, LoggingGate } from '../logging-gate.js'
import { LogManager } from '../log-manager.js'
import type { LogEntry } from '../log-ring-buffer.js'

/** An entry that punishes any property access. */
function boobyTrapped(): LogEntry {
  return new Proxy({} as LogEntry, {
    get(_target, prop) {
      throw new Error(`log entry property read while the gate was unrestricted: ${String(prop)}`)
    },
  })
}

describe('LoggingGate', () => {
  it('costs one boolean read while unrestricted - no property access at all', () => {
    const gate = new LoggingGate()

    expect(gate.restrictsDestinations).toBe(false)
    expect(gate.destinationFloor).toBe(DEFAULT_LOG_LEVEL)
    // Throws if the guard is not the first statement.
    expect(gate.allowsDestination(boobyTrapped())).toBe(true)
  })

  it('stays unrestricted when the floor is set to the default', () => {
    const gate = new LoggingGate()
    gate.setDestinationFloor(DEFAULT_LOG_LEVEL)

    expect(gate.restrictsDestinations).toBe(false)
    expect(gate.allowsDestination(boobyTrapped())).toBe(true)
  })

  it('drops entries below the floor and keeps the rest', () => {
    const gate = new LoggingGate()
    gate.setDestinationFloor('warn')

    expect(gate.restrictsDestinations).toBe(true)
    expect(gate.allowsDestination({ level: 'debug' })).toBe(false)
    expect(gate.allowsDestination({ level: 'info' })).toBe(false)
    expect(gate.allowsDestination({ level: 'warn' })).toBe(true)
    expect(gate.allowsDestination({ level: 'error' })).toBe(true)
  })

  it('returns to unrestricted when the floor is lowered again', () => {
    const gate = new LoggingGate()
    gate.setDestinationFloor('error')
    gate.setDestinationFloor(DEFAULT_LOG_LEVEL)

    expect(gate.restrictsDestinations).toBe(false)
    expect(gate.allowsDestination(boobyTrapped())).toBe(true)
  })
})

describe('LogManager honours the gate', () => {
  it('gates the DESTINATIONS and never the ring buffer', () => {
    const manager = new LogManager(100)
    const gate = new LoggingGate()
    manager.setLoggingGate(gate)
    const written: string[] = []
    manager.addDestination({
      initialize: async () => {},
      shutdown: async () => {},
      write: (entry) => {
        written.push(`${entry.level}:${entry.message}`)
      },
    })

    const logger = manager.createLogger('spec')
    logger.debug('before')
    gate.setDestinationFloor('warn')
    logger.debug('quietened')
    logger.error('loud')

    expect(written).toEqual(['debug:before', 'error:loud'])
    // The viewer keeps every line: the floor is not a ring admission level.
    expect(manager.query({}).map((e) => e.message)).toEqual(
      expect.arrayContaining(['before', 'quietened', 'loud']),
    )
    expect(manager.bufferSize()).toBe(3)
  })
})
