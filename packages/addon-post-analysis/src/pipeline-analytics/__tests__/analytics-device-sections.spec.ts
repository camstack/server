/**
 * `toAnalyticsDeviceSections` — the pure transform that hoists the global
 * analytics settings sections into the per-device `Analytics` top-tab.
 *
 *   - Every section is tagged `location: 'top-tab'` so `DeviceDetail`
 *     discovers a dedicated "Analytics" device-detail tab (out of Config).
 *   - Sections without a `tab` default to `Analytics`; an explicit `tab`
 *     is preserved.
 *   - All other section fields pass through untouched (pure copy).
 */
import { describe, it, expect } from 'vitest'
import {
  DETECTION_PIPELINE_SECTION_IDS,
  retagDetectionSections,
  toAnalyticsDeviceSections,
} from '../index.js'

type SectionFixture = {
  readonly id: string
  readonly title?: string
  readonly columns?: number
  readonly tab?: string
  readonly fields?: readonly { readonly key: string; readonly type: string }[]
}

describe('toAnalyticsDeviceSections', () => {
  it('marks every section location:top-tab and defaults the tab to the well-known analytics id', () => {
    const out = toAnalyticsDeviceSections<SectionFixture>([
      { id: 'tracking-core', title: 'Tracking' },
      { id: 'retention', title: 'Retention' },
    ])
    expect(out).toHaveLength(2)
    for (const s of out) {
      expect(s.location).toBe('top-tab')
      expect(s.tab).toBe('analytics')
    }
  })

  it('preserves an explicitly-declared tab', () => {
    const [s] = toAnalyticsDeviceSections<SectionFixture>([{ id: 'x', tab: 'custom' }])
    expect(s).toBeDefined()
    expect(s!.tab).toBe('custom')
    expect(s!.location).toBe('top-tab')
  })

  it('passes through all other fields untouched and does not mutate input', () => {
    const input: SectionFixture[] = [{ id: 'media-policy', title: 'Snapshots', columns: 2 }]
    const [out] = toAnalyticsDeviceSections(input)
    expect(out).toBeDefined()
    expect(out!.id).toBe('media-policy')
    expect(out!.title).toBe('Snapshots')
    expect(out!.columns).toBe(2)
    // Input is not mutated (immutability).
    expect(input[0]).not.toHaveProperty('location')
  })
})

describe('retagDetectionSections', () => {
  // The FP-knob field keys added to tracking-settings.ts — the "Tracking form"
  // the consolidated Detection pipeline → Settings sub-tab must surface.
  const FP_KNOB_KEYS = [
    'dedupEnabled',
    'dedupSpawnIou',
    'dedupMergeIou',
    'dedupMergeFrames',
    'personAnimalDedup',
    'animalOverPersonMaxScore',
    'animalOverPersonIou',
    'classVotingEnabled',
    'classVoteMinFraction',
    'confirmBypassEnabled',
    'confirmBypassScore',
    'perClassMinScoreEnabled',
    'minScorePerson',
    'minScoreAnimal',
    'minScoreVehicle',
  ] as const

  it('re-homes tracking / detection-sensitivity / stationary onto detection-pipeline', () => {
    const out = retagDetectionSections([
      { id: 'detection-sensitivity', tab: 'analytics' },
      { id: 'tracking', tab: 'analytics' },
      { id: 'stationary-objects', tab: 'analytics' },
    ])
    for (const s of out) expect(s.tab).toBe('detection-pipeline')
  })

  it('leaves non-detection analytics sections on their tab', () => {
    const out = retagDetectionSections([
      { id: 'media-policy', tab: 'analytics' },
      { id: 'tracking-core', tab: 'analytics' },
      { id: 'retention', tab: 'analytics' },
    ])
    for (const s of out) expect(s.tab).toBe('analytics')
  })

  it('preserves the Tracking form FP knobs while re-tagging the section', () => {
    const trackingSection = {
      id: 'tracking',
      tab: 'analytics',
      fields: FP_KNOB_KEYS.map((key) => ({ key, type: 'number' as const })),
    }
    const [out] = retagDetectionSections([trackingSection])
    expect(out).toBeDefined()
    expect(out!.tab).toBe('detection-pipeline')
    const keys = out!.fields!.map((f) => f.key)
    for (const knob of FP_KNOB_KEYS) expect(keys).toContain(knob)
  })

  it('exposes the detection section id set (tracking is one of them)', () => {
    expect(DETECTION_PIPELINE_SECTION_IDS.has('tracking')).toBe(true)
    expect(DETECTION_PIPELINE_SECTION_IDS.has('detection-sensitivity')).toBe(true)
    expect(DETECTION_PIPELINE_SECTION_IDS.has('stationary-objects')).toBe(true)
    expect(DETECTION_PIPELINE_SECTION_IDS.has('media-policy')).toBe(false)
  })

  it('does not mutate the input sections', () => {
    const input = [{ id: 'tracking', tab: 'analytics' }]
    retagDetectionSections(input)
    expect(input[0]!.tab).toBe('analytics')
  })
})
