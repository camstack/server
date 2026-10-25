import { describe, it, expect } from 'vitest'
import { AI_FEATURE_BIT } from '@apocaliss92/nodedreame'
import { AI_FEATURE_LABEL, dreameAiSwitchSchema } from '../devices/dreame-ai-switch-device.js'

describe('dreame AI-switch config + labels', () => {
  const baseConfig = {
    dreameDeviceId: 'd1',
    brokerId: 'b1',
    model: 'dreame.vacuum.r2538z',
    system: 'dreame' as const,
  }

  it('accepts a valid AI feature and surfaces it typed', () => {
    const parsed = dreameAiSwitchSchema.parse({ ...baseConfig, aiFeature: 'petDetection' })
    expect(parsed.aiFeature).toBe('petDetection')
  })

  it('rejects an unknown AI feature', () => {
    expect(() =>
      dreameAiSwitchSchema.parse({ ...baseConfig, aiFeature: 'notARealFeature' }),
    ).toThrow()
  })

  it('rejects config with no aiFeature', () => {
    expect(() => dreameAiSwitchSchema.parse(baseConfig)).toThrow()
  })

  it('has a non-empty human label for every AI feature the library knows', () => {
    // AI_FEATURE_BIT enumerates every int-encodable feature; each must have a
    // display label so a spawned switch child never renders unnamed.
    const labelled = new Set(Object.keys(AI_FEATURE_LABEL))
    for (const feature of Object.keys(AI_FEATURE_BIT)) {
      expect(labelled.has(feature)).toBe(true)
    }
    for (const label of Object.values(AI_FEATURE_LABEL)) {
      expect(label.length).toBeGreaterThan(0)
    }
  })
})
