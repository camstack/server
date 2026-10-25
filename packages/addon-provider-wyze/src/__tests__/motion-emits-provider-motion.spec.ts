/**
 * D673 — a Wyze motion push is the camera's RAW motion: it rides
 * `ProviderMotion`, never `MotionOnMotionChanged` (the orchestrator's
 * camera-sensors bridge is the one emitter of the effective motion).
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WyzeCamera } from '../wyze-camera.js'

describe('WyzeCamera.emitMotion', () => {
  it('emits ProviderMotion, onboard, carrying the addon id', () => {
    const emitted: {
      category: string
      source: Record<string, unknown>
      data: Record<string, unknown>
    }[] = []
    const subject = {
      id: 620,
      ctx: {
        eventBus: {
          emit: (e: {
            category: string
            source: Record<string, unknown>
            data: Record<string, unknown>
          }) => emitted.push(e),
        },
      },
    }

    WyzeCamera.prototype['emitMotion'].call(subject, 30)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.category).toBe(EventCategory.ProviderMotion)
    expect(emitted[0]?.data).toMatchObject({
      deviceId: 620,
      detected: true,
      timestamp: 30,
      source: 'onboard',
    })
    expect(emitted[0]?.source).toMatchObject({ deviceId: 620 })
  })
})
