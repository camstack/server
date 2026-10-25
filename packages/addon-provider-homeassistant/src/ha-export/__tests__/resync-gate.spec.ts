import { describe, expect, it } from 'vitest'
import { ResyncGate } from '../resync-gate.js'

describe('ResyncGate', () => {
  it('the first pass after a start is a full resync', () => {
    const gate = new ResyncGate()
    expect(gate.take('boot')).toBe(true)
    expect(gate.take('structure-changed')).toBe(false)
  })

  it('any gap forces the NEXT pass to be full, even an event-debounced one, and only once', () => {
    const gate = new ResyncGate()
    gate.take('boot')
    gate.markGap('push-failed')
    expect(gate.pending()).toBe(true)
    expect(gate.take('structure-changed')).toBe(true)
    expect(gate.take('structure-changed')).toBe(false)
  })

  it('link-restored and periodic passes are always full', () => {
    const gate = new ResyncGate()
    gate.take('boot')
    expect(gate.take('link-restored')).toBe(true)
    expect(gate.take('periodic')).toBe(true)
  })

  it('a gap noted during a pass is not consumed by that pass', () => {
    const gate = new ResyncGate()
    gate.take('boot')
    const full = gate.take('periodic')
    gate.markGap('announce-undelivered')
    expect(full).toBe(true)
    expect(gate.take('structure-changed')).toBe(true)
  })
})
