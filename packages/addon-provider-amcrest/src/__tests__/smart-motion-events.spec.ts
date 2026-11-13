/**
 * Dahua smart events are this camera's motion. A Start/Stop pair has the
 * same edges as VideoMotion. A Pulse has no Stop: one rising edge, and the
 * session cooldown is the close — the keepalive that holds a Start must not
 * arm, or motion would stay on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmcrestCamera } from '../amcrest-camera.js'
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

  it('a Pulse with no Stop emits one rising edge and does not hold motion', () => {
    const { subject, edges } = makeSubject()
    deliver(subject, event('CrossLineDetection', 'Pulse', 7_000))
    vi.advanceTimersByTime(30_000)
    expect(edges).toEqual([{ detected: true, timestamp: 7_000 }])
    expect(subject.motionActive).toBe(false)
    expect(subject.motionKeepaliveTimer).toBeNull()
  })
})
