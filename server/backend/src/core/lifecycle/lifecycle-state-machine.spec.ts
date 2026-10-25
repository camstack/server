import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LifecycleStateMachine } from './lifecycle-state-machine'
import type { IEventBus, SystemEvent } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'

const createMockEventBus = (): IEventBus & { emitted: SystemEvent[] } => {
  const emitted: SystemEvent[] = []
  return {
    emitted,
    emit: vi.fn((event: SystemEvent) => emitted.push(event)),
    subscribe: vi.fn(() => () => {}),
    getRecent: vi.fn(() => []),
  }
}

const createMockLogger = (): IScopedLogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
})

describe('LifecycleStateMachine', () => {
  let eventBus: ReturnType<typeof createMockEventBus>
  let logger: IScopedLogger
  let machine: LifecycleStateMachine

  beforeEach(() => {
    eventBus = createMockEventBus()

    logger = createMockLogger()
    machine = new LifecycleStateMachine('test-element', 'device', eventBus, logger)
  })

  it('starts in stopped state', () => {
    expect(machine.state).toBe('stopped')
    expect(machine.getStatus().state).toBe('stopped')
    expect(machine.getStatus().restartCount).toBe(0)
    expect(machine.getStatus().uptime).toBe(0)
  })

  it('allows valid transition: stopped → starting → running', () => {
    const result1 = machine.transition('starting')
    expect(result1).toBe(true)
    expect(machine.state).toBe('starting')

    const result2 = machine.transition('running')
    expect(result2).toBe(true)
    expect(machine.state).toBe('running')
  })

  it('rejects invalid transition (e.g. stopped → running directly)', () => {
    const result = machine.transition('running')
    expect(result).toBe(false)
    expect(machine.state).toBe('stopped')

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid state transition'),
      expect.anything(),
    )
  })

  it('emits event on bus for each valid transition', () => {
    machine.transition('starting')
    machine.transition('running')

    expect(eventBus.emit).toHaveBeenCalledTimes(2)

    expect(eventBus.emitted[0]!.category).toBe('device.state.starting')

    expect(eventBus.emitted[0]!.source).toEqual({ type: 'device', id: 'test-element' })

    expect(eventBus.emitted[0]!.data).toMatchObject({
      from: 'stopped',
      to: 'starting',
      elementId: 'test-element',
    })

    expect(eventBus.emitted[1]!.category).toBe('device.state.running')

    expect(eventBus.emitted[1]!.data).toMatchObject({
      from: 'starting',
      to: 'running',
    })
  })

  it('does not emit event on invalid transition', () => {
    machine.transition('running')

    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('tracks uptime when running', () => {
    machine.transition('starting')
    machine.transition('running')

    const status = machine.getStatus()
    expect(status.uptime).toBeGreaterThanOrEqual(0)
    expect(status.startedAt).toBeDefined()
    expect(status.stoppedAt).toBeUndefined()
  })

  it('records error message in error state', () => {
    machine.transition('starting')
    machine.transition('error', 'connection refused')

    const status = machine.getStatus()
    expect(status.state).toBe('error')
    expect(status.error).toBe('connection refused')
    expect(status.stoppedAt).toBeDefined()
  })

  it('getStatus returns complete info after full lifecycle', () => {
    machine.transition('starting')
    machine.transition('running')
    machine.transition('stopping')
    machine.transition('stopped')

    const status = machine.getStatus()
    expect(status.state).toBe('stopped')
    expect(status.restartCount).toBe(0)
    expect(status.stoppedAt).toBeDefined()
    expect(status.uptime).toBe(0)
  })

  it('increments restart count only on subsequent starts', () => {
    // First start
    machine.transition('starting')
    machine.transition('running')
    expect(machine.getStatus().restartCount).toBe(0)

    // Stop and restart
    machine.transition('stopping')
    machine.transition('stopped')
    machine.transition('starting')
    machine.transition('running')
    expect(machine.getStatus().restartCount).toBe(1)

    // Error and restart
    machine.transition('error', 'crash')
    machine.transition('starting')
    machine.transition('running')
    expect(machine.getStatus().restartCount).toBe(2)
  })

  it('allows disabled state from stopped', () => {
    const result = machine.transition('disabled')
    expect(result).toBe(true)
    expect(machine.state).toBe('disabled')
  })

  it('requires going through stopped to leave disabled', () => {
    machine.transition('disabled')

    expect(machine.transition('starting')).toBe(false)
    expect(machine.transition('stopped')).toBe(true)
    expect(machine.state).toBe('stopped')
  })

  it('incrementRestartCount manually increments the counter', () => {
    machine.incrementRestartCount()
    machine.incrementRestartCount()
    expect(machine.getStatus().restartCount).toBe(2)
  })
})
