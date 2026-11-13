/**
 * Dahua smart events are this camera's motion. A Start/Stop pair has the
 * same edges as VideoMotion. Overlapping codes stay on until the last Stop.
 * A Pulse has no Stop: it holds motion for `AMCREST_PULSE_HOLD_MS`, then
 * turns it off, unless a Start is still held — that Stop owns the off.
 * The keepalive arms only while a Start is held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AMCREST_PULSE_HOLD_MS, AmcrestCamera } from '../amcrest-camera.js'
import type { AmcrestEvent } from '../amcrest-cgi-client.js'

const DEVICE = 16

interface MotionEdge {
  readonly detected: boolean
  readonly timestamp: number
}

interface Subject {
  id: number
  motionActive: boolean
  motionKeepaliveTimer: ReturnType<typeof setInterval> | null
  activeMotionCodes: Set<string>
  motionPulseTimer: ReturnType<typeof setTimeout> | null
  ctx: {
    logger: {
      info: (message: string, opts?: { tags?: Record<string, unknown> }) => void
      debug: (message: string, opts?: { tags?: Record<string, unknown> }) => void
      warn: (message: string) => void
      error: (message: string) => void
    }
    eventBus: { emit: (event: { data: MotionEdge }) => void }
  }
}

function event(code: string, action: string, observedAt: number): AmcrestEvent {
  return { observedAt, code, action, index: 0, raw: '' }
}

function makeSubject(): { subject: Subject; edges: MotionEdge[] } {
  const edges: MotionEdge[] = []
  const subject: Subject = {
    id: DEVICE,
    motionActive: false,
    motionKeepaliveTimer: null,
    activeMotionCodes: new Set<string>(),
    motionPulseTimer: null,
    ctx: {
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      eventBus: {
        emit: (ev) => {
          edges.push({ detected: ev.data.detected, timestamp: ev.data.timestamp })
        },
      },
    },
  }
  // Sibling methods (`onMotionStart`, `emitMotion`) live on the prototype.
  // A plain object would miss them when `handleAmcrestEvent` calls through `this`.
  Object.setPrototypeOf(subject, AmcrestCamera.prototype)
  return { subject, edges }
}

function deliver(subject: Subject, ev: AmcrestEvent): void {
  AmcrestCamera.prototype['handleAmcrestEvent'].call(subject, ev)
}

describe('Amcrest smart events count as onboard motion', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    'SmartMotionHuman',
    'SmartMotionVehicle',
  ])('%s Start then Stop has VideoMotion edges', (code) => {
    const { subject, edges } = makeSubject()
    deliver(subject, event(code, 'Start', 1_000))
    deliver(subject, event(code, 'Stop', 4_000))
    expect(edges).toEqual([
      { detected: true, timestamp: 1_000 },
      { detected: false, timestamp: 4_000 },
    ])
    expect(subject.motionActive).toBe(false)
  })

  it('CrossLineDetection Start then Stop has VideoMotion edges', () => {
    const { subject, edges } = makeSubject()
    deliver(subject, event('CrossLineDetection', 'Start', 2_000))
    deliver(subject, event('CrossLineDetection', 'Stop', 5_000))
    expect(edges).toEqual([
      { detected: true, timestamp: 2_000 },
      { detected: false, timestamp: 5_000 },
    ])
    expect(subject.motionActive).toBe(false)
  })

  it('CrossRegionDetection Start then Stop has VideoMotion edges', () => {
    const { subject, edges } = makeSubject()
    deliver(subject, event('CrossRegionDetection', 'Start', 3_000))
    deliver(subject, event('CrossRegionDetection', 'Stop', 6_000))
    expect(edges).toEqual([
      { detected: true, timestamp: 3_000 },
      { detected: false, timestamp: 6_000 },
    ])
    expect(subject.motionActive).toBe(false)
  })

  it('overlapping codes stay on until the last Stop', () => {
    const { subject, edges } = makeSubject()
    deliver(subject, event('VideoMotion', 'Start', 1_000))
    deliver(subject, event('SmartMotionHuman', 'Start', 2_000))
    deliver(subject, event('SmartMotionHuman', 'Stop', 3_000))
    expect(subject.motionActive).toBe(true)
    expect(subject.motionKeepaliveTimer).not.toBeNull()
    expect(edges.some((edge) => edge.detected === false)).toBe(false)
    deliver(subject, event('VideoMotion', 'Stop', 4_000))
    expect(edges).toEqual([
      { detected: true, timestamp: 1_000 },
      { detected: false, timestamp: 4_000 },
    ])
    expect(subject.motionActive).toBe(false)
    expect(subject.motionKeepaliveTimer).toBeNull()
  })

  it('a Pulse turns motion on, then off after the hold', () => {
    const { subject, edges } = makeSubject()
    vi.setSystemTime(7_000)
    deliver(subject, event('CrossLineDetection', 'Pulse', 7_000))
    expect(edges).toEqual([{ detected: true, timestamp: 7_000 }])
    expect(subject.motionActive).toBe(true)
    expect(subject.motionKeepaliveTimer).toBeNull()
    expect(subject.motionPulseTimer).not.toBeNull()
    vi.advanceTimersByTime(AMCREST_PULSE_HOLD_MS - 1)
    expect(subject.motionActive).toBe(true)
    vi.advanceTimersByTime(1)
    expect(edges).toEqual([
      { detected: true, timestamp: 7_000 },
      { detected: false, timestamp: 7_000 + AMCREST_PULSE_HOLD_MS },
    ])
    expect(subject.motionActive).toBe(false)
    expect(subject.motionPulseTimer).toBeNull()
    expect(subject.motionKeepaliveTimer).toBeNull()
  })

  it('a Pulse during a held Start does not turn motion off when the hold ends', () => {
    const { subject, edges } = makeSubject()
    vi.setSystemTime(8_000)
    deliver(subject, event('VideoMotion', 'Start', 8_000))
    deliver(subject, event('CrossRegionDetection', 'Pulse', 8_100))
    expect(subject.motionPulseTimer).not.toBeNull()
    expect(subject.motionKeepaliveTimer).not.toBeNull()
    vi.advanceTimersByTime(AMCREST_PULSE_HOLD_MS)
    expect(edges.some((edge) => edge.detected === false)).toBe(false)
    expect(subject.motionActive).toBe(true)
    expect(subject.motionKeepaliveTimer).not.toBeNull()
    deliver(subject, event('VideoMotion', 'Stop', 9_000))
    expect(edges.at(-1)).toEqual({ detected: false, timestamp: 9_000 })
    expect(subject.motionActive).toBe(false)
  })

  it('a second Pulse during the hold extends it', () => {
    const { subject, edges } = makeSubject()
    vi.setSystemTime(10_000)
    deliver(subject, event('CrossLineDetection', 'Pulse', 10_000))
    vi.advanceTimersByTime(AMCREST_PULSE_HOLD_MS - 1_000)
    const extendedAt = 10_000 + AMCREST_PULSE_HOLD_MS - 1_000
    deliver(subject, event('CrossLineDetection', 'Pulse', extendedAt))
    vi.advanceTimersByTime(AMCREST_PULSE_HOLD_MS - 1)
    expect(subject.motionActive).toBe(true)
    expect(edges.some((edge) => edge.detected === false)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(edges.at(-1)).toEqual({
      detected: false,
      timestamp: extendedAt + AMCREST_PULSE_HOLD_MS,
    })
    expect(subject.motionActive).toBe(false)
  })
})
