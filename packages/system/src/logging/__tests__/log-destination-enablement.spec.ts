import { describe, it, expect } from 'vitest'
import { LogManager, LOG_BUFFER_DESTINATION_ID } from '../log-manager.js'
import type { ILogDestination, LogEntry } from '@camstack/types'

function collector(): { dest: ILogDestination; lines: LogEntry[] } {
  const lines: LogEntry[] = []
  // `initialize`/`shutdown` are part of the contract but never invoked by
  // `LogManager.addDestination` — the owner of a destination drives its
  // lifecycle. No-ops keep this collector a full `ILogDestination`.
  return {
    dest: {
      initialize: async () => undefined,
      shutdown: async () => undefined,
      write: (e: LogEntry) => void lines.push(e),
    },
    lines,
  }
}

/**
 * The orchestrator's per-destination Enable/Disable toggle was WRITE-ONLY for
 * `log-destination`: it added the addon to the registry's disabled set and
 * nothing ever read it. Console and winston could therefore not be turned off
 * at all, while the UI badge said they were — and Loki appeared to work only
 * because it carried a SECOND, private `enabled` setting (audit 2026-07-30).
 */
describe('LogManager — per-destination enablement', () => {
  it('writes to a destination whose addon is enabled', () => {
    const mgr = new LogManager()
    const a = collector()
    mgr.addDestination(a.dest, { replay: false, addonId: 'winston-logging' })
    mgr.setDestinationEnabledCheck(() => true)
    mgr.createLogger('t').info('hello')
    expect(a.lines).toHaveLength(1)
  })

  it('SKIPS a destination whose addon the operator disabled', () => {
    const mgr = new LogManager()
    const on = collector()
    const off = collector()
    mgr.addDestination(on.dest, { replay: false, addonId: 'winston-logging' })
    mgr.addDestination(off.dest, { replay: false, addonId: 'loki-logging' })
    mgr.setDestinationEnabledCheck((addonId) => addonId !== 'loki-logging')
    mgr.createLogger('t').info('hello')
    expect(on.lines).toHaveLength(1)
    expect(off.lines).toHaveLength(0)
  })

  it('an UNTAGGED destination is never gated (agent / legacy wiring)', () => {
    const mgr = new LogManager()
    const legacy = collector()
    mgr.addDestination(legacy.dest, { replay: false })
    mgr.setDestinationEnabledCheck(() => false)
    mgr.createLogger('t').info('hello')
    expect(legacy.lines).toHaveLength(1)
  })

  it('with NO check wired, everything writes (default-open)', () => {
    const mgr = new LogManager()
    const a = collector()
    mgr.addDestination(a.dest, { replay: false, addonId: 'anything' })
    mgr.createLogger('t').info('hello')
    expect(a.lines).toHaveLength(1)
  })

  it('the toggle takes effect live, with no re-registration', () => {
    const mgr = new LogManager()
    const a = collector()
    mgr.addDestination(a.dest, { replay: false, addonId: 'loki-logging' })
    let enabled = true
    mgr.setDestinationEnabledCheck(() => enabled)
    const log = mgr.createLogger('t')
    log.info('one')
    enabled = false
    log.info('two')
    enabled = true
    log.info('three')
    expect(a.lines.map((l) => l.message)).toEqual(['one', 'three'])
  })
})

// The in-memory buffer answers to the SAME toggle. It lives in the kernel (it
// must exist before any addon, for boot lines, and it backs `logs.query`), but
// "stop holding logs in RAM" is a legitimate operator choice — and yes, it also
// empties the log viewer, which is what the operator is asking for.
describe('LogManager — the in-memory buffer as a destination', () => {
  it('buffers by default', () => {
    const mgr = new LogManager()
    mgr.createLogger('t').info('kept')
    expect(mgr.query({}).map((e) => e.message)).toContain('kept')
  })

  it('stops buffering when the operator disables it', () => {
    const mgr = new LogManager()
    mgr.setDestinationEnabledCheck((id) => id !== LOG_BUFFER_DESTINATION_ID)
    mgr.createLogger('t').info('dropped')
    expect(mgr.query({})).toHaveLength(0)
  })

  it('disabling the buffer does NOT silence the other destinations', () => {
    const mgr = new LogManager()
    const file = collector()
    mgr.addDestination(file.dest, { replay: false, addonId: 'winston-logging' })
    mgr.setDestinationEnabledCheck((id) => id !== LOG_BUFFER_DESTINATION_ID)
    mgr.createLogger('t').info('to disk only')
    expect(mgr.query({})).toHaveLength(0)
    expect(file.lines).toHaveLength(1)
  })

  it('reconfigure takes effect without a restart', () => {
    const mgr = new LogManager()
    mgr.reconfigureBuffer({ perAddonCapacity: 2 })
    const log = mgr.createLogger('t')
    log.info('one')
    log.info('two')
    log.info('three')
    // The partition trims to the NEW capacity as entries arrive.
    expect(mgr.query({}).length).toBeLessThanOrEqual(2)
  })
})
