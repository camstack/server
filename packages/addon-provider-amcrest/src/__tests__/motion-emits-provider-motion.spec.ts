/**
 * D673 — an Amcrest VideoMotion Start/Stop is the camera's RAW motion: it
 * rides `ProviderMotion`, never `MotionOnMotionChanged` (the orchestrator's
 * camera-sensors bridge is the one emitter of the effective motion).
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AmcrestCamera } from '../amcrest-camera.js'

describe('AmcrestCamera.emitMotion', () => {
  it('emits ProviderMotion, onboard, for both edges', () => {
    const emitted: { category: string; data: Record<string, unknown> }[] = []
    const subject = {
      id: 108,
      eventSource: () => ({ type: 'device', id: 108, addonId: 'provider-amcrest', deviceId: 108 }),
      ctx: {
        eventBus: {
          emit: (e: { category: string; data: Record<string, unknown> }) => emitted.push(e),
        },
      },
    }

    AmcrestCamera.prototype['emitMotion'].call(subject, true, 10)
    AmcrestCamera.prototype['emitMotion'].call(subject, false, 20)

    expect(emitted.map((e) => e.category)).toEqual([
      EventCategory.ProviderMotion,
      EventCategory.ProviderMotion,
    ])
    expect(emitted[0]?.data).toMatchObject({
      deviceId: 108,
      detected: true,
      timestamp: 10,
      source: 'onboard',
    })
    expect(emitted[1]?.data).toMatchObject({ detected: false, timestamp: 20, source: 'onboard' })
  })
})
