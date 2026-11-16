import { describe, expect, it } from 'vitest'
import { WorkloadTransitionDetector } from '../workload-transition.js'

describe('WorkloadTransitionDetector (#585)', () => {
  it('the first state seen is a seed, not an event', () => {
    const det = new WorkloadTransitionDetector()
    expect(det.note(1, { state: 'running', since: 10 })).toBeNull()
  })

  it('stopped → starting → running is ONE started', () => {
    const det = new WorkloadTransitionDetector()
    det.note(1, { state: 'stopped', since: 1 })
    expect(det.note(1, { state: 'starting', since: 2 })).toBeNull()
    expect(det.note(1, { state: 'running', since: 3 })).toEqual({
      kind: 'started',
      deviceId: 1,
      state: 'running',
      previous: 'stopped',
      since: 3,
    })
    expect(det.note(1, { state: 'running', since: 3 })).toBeNull()
  })

  it('crashed → starting → running is recovered, not started', () => {
    const det = new WorkloadTransitionDetector()
    det.note(1, { state: 'running', since: 1 })
    expect(det.note(1, { state: 'crashed', since: 2 })?.kind).toBe('crashed')
    det.note(1, { state: 'starting', since: 3 })
    expect(det.note(1, { state: 'running', since: 4 })?.kind).toBe('recovered')
  })

  it('an unknown state is neither an event nor remembered', () => {
    const det = new WorkloadTransitionDetector()
    det.note(1, { state: 'running', since: 1 })
    expect(det.note(1, { state: null, since: null })).toBeNull()
    expect(det.note(1, { state: 'stopped', since: 5 })?.kind).toBe('stopped')
  })

  it('a value outside the lifecycle reads as unknown', () => {
    const det = new WorkloadTransitionDetector()
    det.note(1, { state: 'running', since: 1 })
    expect(det.note(1, { state: 'exited', since: 2 })).toBeNull()
  })

  it('devices are independent, and a forgotten device seeds again', () => {
    const det = new WorkloadTransitionDetector()
    det.note(1, { state: 'running', since: 1 })
    det.note(2, { state: 'stopped', since: 1 })
    expect(det.note(2, { state: 'running', since: 2 })?.kind).toBe('started')
    det.forget(1)
    expect(det.note(1, { state: 'stopped', since: 3 })).toBeNull()
  })
})
