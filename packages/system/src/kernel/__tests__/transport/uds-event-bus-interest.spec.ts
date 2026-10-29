/**
 * Producer-side suppression of orphan telemetry (D8).
 *
 * The parent pushes each forked child the categories somebody ELSE wants
 * (`event-interest`). A high-frequency (ring-denied) category outside that set
 * is delivered to the child's own subscribers and goes no further: it is never
 * serialised onto the UDS socket, because the hub would only drop it
 * (`fanoutOrphans`). Before the first set arrives the child sends everything.
 */
import type { SystemEvent } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { UdsEventChannel } from '../../transport/uds-event-bus.js'
import { createUdsEventBus } from '../../transport/uds-event-bus.js'

function evt(category: string): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    source: { type: 'core', id: 'x' },
    category,
    data: {},
  }
}

function makeChannel() {
  const emitEvent = vi.fn<(event: SystemEvent) => void>()
  let interestHandler: ((patterns: readonly string[] | null) => void) | null = null
  const channel: UdsEventChannel = {
    emitEvent,
    onEvent: () => {},
    updateEventPatterns: () => {},
    onEventInterest(handler) {
      interestHandler = handler
    },
  }
  return {
    channel,
    emitEvent,
    pushInterest(patterns: readonly string[] | null) {
      if (interestHandler === null) throw new Error('no interest handler registered')
      interestHandler(patterns)
    },
  }
}

describe('createUdsEventBus — event interest', () => {
  it('sends everything before the first interest set (fail open)', () => {
    const { channel, emitEvent } = makeChannel()
    const bus = createUdsEventBus(channel, 'pipeline')
    bus.emit(evt('pipeline.trace'))
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps a high-frequency category nobody wants off the socket, but delivers it locally', () => {
    const { channel, emitEvent, pushInterest } = makeChannel()
    const bus = createUdsEventBus(channel, 'pipeline')
    const local = vi.fn()
    bus.subscribe({ category: 'pipeline.trace' }, local)
    pushInterest(['device.*'])

    bus.emit(evt('pipeline.trace'))

    expect(emitEvent).not.toHaveBeenCalled()
    expect(local).toHaveBeenCalledTimes(1)
  })

  it('still sends a wanted high-frequency category', () => {
    const { channel, emitEvent, pushInterest } = makeChannel()
    const bus = createUdsEventBus(channel, 'pipeline')
    pushInterest(['pipeline.*'])
    bus.emit(evt('pipeline.trace'))
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('always sends a category the hub retains (not high-frequency), wanted or not', () => {
    const { channel, emitEvent, pushInterest } = makeChannel()
    const bus = createUdsEventBus(channel, 'pipeline')
    pushInterest([])
    bus.emit(evt('device.state-changed'))
    bus.emit(evt('broker.message'))
    expect(emitEvent).toHaveBeenCalledTimes(2)
  })

  it('a null set clears the suppression (fail open again)', () => {
    const { channel, emitEvent, pushInterest } = makeChannel()
    const bus = createUdsEventBus(channel, 'pipeline')
    pushInterest([])
    bus.emit(evt('pipeline.trace'))
    expect(emitEvent).not.toHaveBeenCalled()
    pushInterest(null)
    bus.emit(evt('pipeline.trace'))
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('logs the transition into "suppressed: no consumer" once per category and spell', () => {
    const { channel, pushInterest } = makeChannel()
    const info = vi.fn()
    const bus = createUdsEventBus(channel, 'pipeline', { logger: { info } })
    pushInterest([])
    bus.emit(evt('pipeline.trace'))
    bus.emit(evt('pipeline.trace'))
    bus.emit(evt('stream-broker.metrics-snapshot'))
    expect(info).toHaveBeenCalledTimes(2)
    expect(info.mock.calls.map((c) => c[1])).toEqual([
      { category: 'pipeline.trace' },
      { category: 'stream-broker.metrics-snapshot' },
    ])

    // A consumer appears, then goes away: a new spell, a new line.
    pushInterest(['pipeline.*'])
    bus.emit(evt('pipeline.trace'))
    pushInterest([])
    bus.emit(evt('pipeline.trace'))
    expect(info).toHaveBeenCalledTimes(3)
  })
})
