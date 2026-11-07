/**
 * The face matching form's derived suggestion floor is served by ONE helper, on the scoped
 * overlay hook and on the legacy `getGlobalSettings` override alike. The threshold the operator
 * STORED moves the sentence beside it; nothing is written, and an unsaved edit of the field is not
 * previewed (the hook is handed no draft).
 *
 * Disarm: return `{}` from `faceSuggestionReadoutOverlay` — the readout assertions fail.
 */
import { fakeAddonContext } from '@camstack/types/testing'
import type { ConfigFieldWithValue, ConfigUISchemaWithValues } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
import {
  faceSuggestionReadoutOverlay,
  formatSuggestionThresholdReadout,
  SUGGESTION_THRESHOLD_READOUT_KEY,
} from '../settings-schema.js'
import { resolveFaceSettings } from '../face-settings.js'

class Booted extends PipelineAnalyticsAddon {
  protected override async onInitialize(): ReturnType<PipelineAnalyticsAddon['onInitialize']> {
    return { providers: [] }
  }
  overlayOf(cap: string, scope: 'cluster' | 'device-defaults' | 'node' = 'cluster') {
    return this.scopedSettingsOverlay(scope, cap)
  }
}

async function boot(stored: Record<string, unknown>): Promise<Booted> {
  const addon = new Booted()
  await addon.initialize(
    fakeAddonContext({
      id: 'pipeline-analytics',
      settings: { readAddonStore: async () => ({ ...stored }), writeAddonStore: async () => {} },
    }),
  )
  return addon
}

function readoutOf(form: ConfigUISchemaWithValues | null): unknown {
  for (const section of form?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field && field.key === SUGGESTION_THRESHOLD_READOUT_KEY && 'value' in field) {
        return field.value
      }
    }
  }
  return undefined
}

describe('the scoped overlay hook of pipeline-analytics', () => {
  it('the face-gallery cluster form shows the readout of the STORED threshold', async () => {
    const addon = await boot({ similarityThreshold: 0.5 })
    expect(readoutOf(await addon.getScopedSettings('cluster', 'face-gallery'))).toBe(
      formatSuggestionThresholdReadout(0.5),
    )
  })

  it('only the face-gallery cluster form is overlaid', async () => {
    const addon = await boot({ similarityThreshold: 0.5 })
    expect(await addon.overlayOf('face-gallery')).not.toBeNull()
    expect(await addon.overlayOf('pipeline-analytics')).toBeNull()
    expect(await addon.overlayOf('face-gallery', 'device-defaults')).toBeNull()
    expect(await addon.overlayOf('face-gallery', 'node')).toBeNull()
  })
})

describe('faceSuggestionReadoutOverlay', () => {
  it('derives the readout from the stored similarity threshold', () => {
    const stored = { similarityThreshold: 0.5 }
    expect(faceSuggestionReadoutOverlay(stored)).toEqual({
      [SUGGESTION_THRESHOLD_READOUT_KEY]: formatSuggestionThresholdReadout(0.5),
    })
  })

  it('an unset threshold reads as the default one, and a different threshold moves it', () => {
    const fallback = resolveFaceSettings({}).similarityThreshold
    expect(faceSuggestionReadoutOverlay({})[SUGGESTION_THRESHOLD_READOUT_KEY]).toBe(
      formatSuggestionThresholdReadout(fallback),
    )
    expect(faceSuggestionReadoutOverlay({ similarityThreshold: 0.8 })).not.toEqual(
      faceSuggestionReadoutOverlay({ similarityThreshold: 0.4 }),
    )
  })
})
