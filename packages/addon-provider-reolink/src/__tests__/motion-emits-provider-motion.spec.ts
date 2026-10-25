/**
 * D673 — a Reolink motion push (bare `motion` and an AI class alike) is the
 * camera's RAW motion: it rides `ProviderMotion`, never `MotionOnMotionChanged`.
 * The orchestrator's camera-sensors bridge is the one emitter of the effective
 * motion, so a Confirm or Replace sensor can suppress the camera's own.
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { createMotionSensorTracker } from '../motion-sensor-source.js'
import { ReolinkCamera } from '../reolink-camera.js'

interface Emitted {
  readonly category: string
  readonly data: Record<string, unknown>
}

function makeSubject(): {
  readonly subject: object
  readonly emitted: Emitted[]
  readonly info: ReturnType<typeof vi.fn>
  readonly motionSensors: ReturnType<typeof createMotionSensorTracker>
} {
  const emitted: Emitted[] = []
  const info = vi.fn()
  const motionSensors = createMotionSensorTracker()
  const subject = {
    motionSensors,
    id: 102,
    lastEventAt: 0,
    consecutiveStaleHealthChecks: 0,
    nextEventHealthCheckAt: 0,
    markPassiveContact: vi.fn(),
    // The sleep-push gate reads the operator preference; an unset key is the
    // `auto` default, and a native push (no `source`) passes it either way.
    config: { get: (_key: string): unknown => undefined },
    baichuanWebhookSupportedCached: false,
    runtimeState: {
      patchCapState: vi.fn(async () => undefined),
      getCapState: vi.fn(() => undefined),
    },
    noteNativeDetectionSuppressed: vi.fn(),
    eventSource: () => ({ type: 'device', id: 102, addonId: 'provider-reolink', deviceId: 102 }),
    reportWakeSignal: vi.fn(async () => undefined),
    ctx: {
      logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      eventBus: {
        emit: (e: Emitted) => {
          emitted.push(e)
        },
      },
    },
  }
  return { subject, emitted, info, motionSensors }
}

/** The meta of the `Reolink simpleEvent received` line. */
const receivedMeta = (info: ReturnType<typeof vi.fn>): unknown =>
  info.mock.calls.find((call) => call[0] === 'Reolink simpleEvent received')?.[1]

describe('ReolinkCamera.handleSimpleEvent', () => {
  it('emits a bare motion push as ProviderMotion, onboard', () => {
    const { subject, emitted } = makeSubject()

    ReolinkCamera.prototype.handleSimpleEvent.call(subject, {
      type: 'motion',
      channel: 0,
      timestamp: 5,
    })

    expect(emitted.map((e) => e.category)).toEqual([EventCategory.ProviderMotion])
    expect(emitted[0]?.data).toMatchObject({ deviceId: 102, detected: true, source: 'onboard' })
  })

  it('keeps the UNGATED AI-class motion tick on ProviderMotion even with native forwarding off', () => {
    const { subject, emitted } = makeSubject()

    ReolinkCamera.prototype.handleSimpleEvent.call(subject, {
      type: 'people',
      channel: 0,
      timestamp: 5,
    })

    expect(emitted.map((e) => e.category)).toEqual([EventCategory.ProviderMotion])
    expect(emitted[0]?.data).toMatchObject({ deviceId: 102, detected: true, source: 'onboard' })
  })

  it('logs WHICH sensor fired a motion push — read off the raw event the simple event drops', () => {
    const { subject, info, motionSensors } = makeSubject()
    // The client emits the raw notification first (our prepended observer),
    // then the API maps the same emit into the simple event.
    motionSensors.observe({
      type: 'motion',
      channel: 0,
      motion: { channel: 0, state: true, source: 'pir' },
    })
    ReolinkCamera.prototype.handleSimpleEvent.call(subject, {
      type: 'motion',
      channel: 0,
      timestamp: 5,
      source: 'baichuan',
    })
    expect(receivedMeta(info)).toMatchObject({ meta: { type: 'motion', motionSensor: 'pir' } })

    // Consumed once: the next push on the channel, with no raw notification
    // of its own (an email push), says it does not know.
    info.mockClear()
    ReolinkCamera.prototype.handleSimpleEvent.call(subject, {
      type: 'motion',
      channel: 0,
      timestamp: 6,
    })
    expect(receivedMeta(info)).toMatchObject({ meta: { motionSensor: null } })
  })

  it('takes a hub-routed sensor for a hub child, which has no socket of its own', () => {
    const { subject, info } = makeSubject()
    ReolinkCamera.prototype.handleSimpleEvent.call(
      subject,
      { type: 'motion', channel: 2, timestamp: 5 },
      'md',
    )
    expect(receivedMeta(info)).toMatchObject({ meta: { motionSensor: 'md' } })
  })
})
