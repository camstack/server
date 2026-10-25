/**
 * One profile builder for the whole suite.
 *
 * It goes through `LlmProfileSchema.parse` on purpose: every bound and policy
 * field carries a schema default, and a hand-written literal in each spec would
 * drift from the schema the moment a field is added — which is exactly how a
 * test ends up asserting a shape production never produces.
 *
 * For brevity a spec may name a provider field FLAT (`baseUrl`, `apiKey`,
 * `extraHeaders`, `runtime`, `appleFoundation`): it is folded into
 * `providerConfig` by the SAME `migrateProfileBody` the store runs on a stored
 * pre-D893 row (plus `apiKey`, which the store keeps in the row's keychain
 * slot), so the profile handed to the code under test is always the real shape.
 */
import { type LlmProfile, LlmProfileSchema } from '@camstack/types'
import { migrateProfileBody } from '../../profile-migration.js'

function providerConfigOf(body: Record<string, unknown>): Record<string, unknown> {
  const config = body.providerConfig
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? { ...config }
    : {}
}

export function makeProfile(overrides: Record<string, unknown> = {}): LlmProfile {
  const { body } = migrateProfileBody({
    id: 'p',
    name: 'test profile',
    kind: 'openai-compatible',
    addonId: 'ai',
    enabled: true,
    model: 'llama3.2:3b',
    baseUrl: 'http://ollama.lan:11434/v1',
    supportsVision: false,
    ...overrides,
  })
  const { apiKey, ...rest } = body
  const config = providerConfigOf(rest)
  return LlmProfileSchema.parse({
    ...rest,
    providerConfig: typeof apiKey === 'string' ? { ...config, apiKey } : config,
  })
}
