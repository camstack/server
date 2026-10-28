/**
 * What the profile editor STORES (D893): the common fields the kind offers,
 * folded back from the flat form bag; the provider's `providerConfig` passed
 * through as the form left it; and a field the kind does NOT offer carried
 * over from the profile being edited rather than erased.
 */
import type { LlmProfile, LlmProfileKindDescriptor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  advancedCommonSchema,
  commonValuesOf,
  draftToProfile,
  effectiveFeatures,
  generationSchema,
  modelChoices,
} from '../ai-profile-form'

const ALL = [
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'contextLength',
  'systemPrompt',
  'timeoutMs',
  'connectTimeoutMs',
  'firstTokenTimeoutMs',
  'idleTimeoutMs',
  'retry',
  'toolsEnabled',
] as const

const KIND: LlmProfileKindDescriptor = {
  kind: 'acme-llm',
  label: 'Acme',
  icon: 'plug',
  addonId: 'acme',
  connectionSchema: { sections: [] },
  features: { vision: false, tools: true, streaming: true },
  visionEditable: true,
  modelCatalog: 'fetch',
  profileFields: ['temperature', 'maxTokens', 'systemPrompt', 'timeoutMs', 'retry'],
}

const EXISTING: LlmProfile = {
  id: 'p-1',
  name: 'old',
  kind: 'acme-llm',
  addonId: 'acme',
  enabled: false,
  model: 'm-old',
  supportsVision: false,
  topK: 40,
  timeoutMs: 61_000,
  connectTimeoutMs: 9_000,
  firstTokenTimeoutMs: 100_000,
  idleTimeoutMs: 50_000,
  retry: { enabled: false, maxAttempts: 1 },
  toolsEnabled: true,
  providerConfig: { endpoint: 'https://acme.example.com' },
}

const draft = (over: Partial<Parameters<typeof draftToProfile>[2]> = {}) => ({
  name: 'new',
  model: 'm-new',
  supportsVision: true,
  common: {},
  providerConfig: { endpoint: 'https://acme.example.com/v2', token: '__redacted__' },
  ...over,
})

describe('draftToProfile', () => {
  it('keeps the id and the enabled flag of the profile being edited', () => {
    const out = draftToProfile(KIND, EXISTING, draft())
    expect(out.id).toBe('p-1')
    expect(out.enabled).toBe(false)
    expect(out.kind).toBe('acme-llm')
    expect(out.addonId).toBe('acme')
  })

  it('passes providerConfig through exactly as the form left it', () => {
    expect(draftToProfile(KIND, EXISTING, draft()).providerConfig).toEqual({
      endpoint: 'https://acme.example.com/v2',
      token: '__redacted__',
    })
  })

  it('folds the flat retry pair back and reads numbers typed as strings', () => {
    const out = draftToProfile(
      KIND,
      null,
      draft({ common: { retryEnabled: true, retryMaxAttempts: '3', maxTokens: '256' } }),
    )
    expect(out.retry).toEqual({ enabled: true, maxAttempts: 3 })
    expect(out.maxTokens).toBe(256)
  })

  it('a field the kind does not offer keeps its value — never erased by a form that cannot show it', () => {
    const out = draftToProfile(KIND, EXISTING, draft())
    expect(out.topK).toBe(40)
    expect(out.toolsEnabled).toBe(true)
    expect(out.connectTimeoutMs).toBe(9_000)
  })

  it('an offered optional left empty is omitted, not written as undefined', () => {
    const out = draftToProfile(KIND, null, draft({ common: { temperature: '' } }))
    expect('temperature' in out).toBe(false)
    expect('systemPrompt' in out).toBe(false)
  })

  it('round-trips the common values it reads', () => {
    const values = commonValuesOf(EXISTING)
    const out = draftToProfile(
      { ...KIND, profileFields: [...ALL] },
      EXISTING,
      draft({ common: values }),
    )
    expect(out.timeoutMs).toBe(61_000)
    expect(out.topK).toBe(40)
    expect(out.retry).toEqual(EXISTING.retry)
  })
})

describe('the common schemas follow profileFields', () => {
  it('a field appears exactly when the kind offers it', () => {
    const keys = (generationSchema(['temperature', 'topK'])?.sections ?? []).flatMap((s) =>
      s.fields.map((f) => f.key),
    )
    expect(keys).toEqual(['temperature', 'topK'])
    expect(generationSchema(['timeoutMs'])).toBeNull()
    const advanced = (advancedCommonSchema(['retry'])?.sections ?? []).flatMap((s) =>
      s.fields.map((f) => f.key),
    )
    expect(advanced).toEqual(['retryEnabled', 'retryMaxAttempts'])
  })
})

describe('features and the model list', () => {
  it('a model overrides the kind defaults field by field', () => {
    expect(effectiveFeatures(KIND, { id: 'x', features: { vision: true } })).toEqual({
      vision: true,
      tools: true,
      streaming: true,
    })
    expect(effectiveFeatures(KIND, undefined)).toEqual(KIND.features)
  })

  it('the picker shows what listModels answered, else a static kind’s own list', () => {
    expect(modelChoices(KIND, null)).toEqual([])
    expect(modelChoices(KIND, [{ id: 'a' }])).toEqual([{ id: 'a' }])
    expect(modelChoices({ modelCatalog: 'static', staticModels: [{ id: 'only' }] }, null)).toEqual([
      { id: 'only' },
    ])
  })
})

describe('reasoningEffort in the editor', () => {
  const OFFERING = { ...KIND, profileFields: [...KIND.profileFields, 'reasoningEffort' as const] }

  it('an offered select maps to the profile field; the default option omits it', () => {
    const off = draftToProfile(OFFERING, null, draft({ common: { reasoningEffort: 'off' } }))
    expect(off.reasoningEffort).toBe('off')
    const dflt = draftToProfile(OFFERING, null, draft({ common: { reasoningEffort: 'default' } }))
    expect('reasoningEffort' in dflt).toBe(false)
  })

  it('a kind that does not offer it keeps the stored value', () => {
    const out = draftToProfile(KIND, { ...EXISTING, reasoningEffort: 'low' }, draft())
    expect(out.reasoningEffort).toBe('low')
  })

  it('is drawn as a select only where offered', () => {
    const withIt = generationSchema(['temperature', 'reasoningEffort'])
    expect(withIt?.sections[0]?.fields.map((f) => f.key)).toContain('reasoningEffort')
    const without = generationSchema(['temperature'])
    expect(without?.sections[0]?.fields.map((f) => f.key)).not.toContain('reasoningEffort')
  })

  it('shows the stored value, or Default when unset', () => {
    expect(commonValuesOf({ ...EXISTING, reasoningEffort: 'high' }).reasoningEffort).toBe('high')
    expect(commonValuesOf(EXISTING).reasoningEffort).toBe('default')
  })
})
