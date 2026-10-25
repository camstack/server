/**
 * Unit tests for audio-analyzer device-settings contribution.
 *
 * Exercises `getDeviceSettingsContribution`, `getDeviceLiveContribution`,
 * and `applyDeviceSettingsPatch` on the `AudioAnalyzerProvider` class
 * (the cap provider returned by the addon at init time).
 */
import { describe, it, expect, vi } from 'vitest'
import { makeTestAudioAnalyzerProvider } from '../../__tests__/support/audio-analyzer-provider.js'
import type {
  IScopedLogger,
  AudioAnalysisSettings,
  ConfigUISchemaWithValues,
} from '@camstack/types'
import type { IAudioPipeline } from '../audio-pipeline.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makePipeline(): IAudioPipeline {
  return {
    initialize: vi.fn(async () => {}),
    classify: vi.fn(async () => ({ classifications: [], inferenceMs: 0 })),
    dispose: vi.fn(async () => {}),
    getPid: vi.fn(() => null),
  }
}

function makeProvider() {
  const store: Record<number, Record<string, unknown>> = {}
  const contributionSchema: ConfigUISchemaWithValues = {
    sections: [
      {
        id: 'audio-classes',
        title: 'Audio Detection',
        tab: 'detection',
        fields: [
          {
            type: 'slider',
            key: 'minConfidence',
            label: 'Min Confidence',
            min: 0,
            max: 1,
            step: 0.05,
            default: 0.3,
            value: 0.3,
          },
        ],
      },
    ],
  }

  const deviceSettingsResolver = vi.fn(
    async (_deviceId: number): Promise<AudioAnalysisSettings | null> => null,
  )
  const deviceContributionResolver = vi.fn(
    async (deviceId: number): Promise<ConfigUISchemaWithValues | null> => {
      const overlay = store[deviceId] ?? {}
      void overlay
      // The test doesn't need to apply the overlay into the returned schema —
      // it only needs to echo the canonical schema and rely on the patcher
      // round-trip for value changes.
      return contributionSchema
    },
  )
  const deviceSettingsPatcher = vi.fn(async (deviceId: number, patch: Record<string, unknown>) => {
    store[deviceId] = { ...store[deviceId], ...patch }
  })

  const provider = makeTestAudioAnalyzerProvider(makeLogger(), makePipeline(), 'yamnet-onnx', {
    deviceSettingsResolver,
    deviceContributionResolver,
    deviceSettingsPatcher,
    reprobeImpl: async () => ({ backend: 'test' }),
  })
  return { provider, deviceContributionResolver, deviceSettingsPatcher, store }
}

describe('AudioAnalyzerProvider — device-settings contribution', () => {
  const CAM_ID = 1

  it('delegates getDeviceSettingsContribution to the injected resolver', async () => {
    const { provider, deviceContributionResolver } = makeProvider()
    const out = await provider.getDeviceSettingsContribution({ deviceId: CAM_ID })
    expect(deviceContributionResolver).toHaveBeenCalledWith(CAM_ID)
    expect(out!.sections[0]!.tab).toBe('detection')
  })

  it('getDeviceLiveContribution is null (audio has no live info)', async () => {
    const { provider } = makeProvider()
    expect(await provider.getDeviceLiveContribution({ deviceId: CAM_ID })).toBeNull()
  })

  it('applyDeviceSettingsPatch delegates to the injected patcher', async () => {
    const { provider, deviceSettingsPatcher, store } = makeProvider()
    await provider.applyDeviceSettingsPatch({ deviceId: CAM_ID, patch: { minConfidence: 0.7 } })
    expect(deviceSettingsPatcher).toHaveBeenCalledWith(CAM_ID, { minConfidence: 0.7 })
    expect(store[CAM_ID]?.['minConfidence']).toBe(0.7)
  })
})
