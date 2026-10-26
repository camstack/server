/**
 * A discovery candidate that must be finished in the integration form
 * (pairing, credentials) instead of one-click device adoption.
 *
 * The flag lives on `prefilledConfig` under {@link SETUP_INTEGRATION_KEY}.
 * The same string is `SHC_SETUP_INTEGRATION_KEY` in addon-provider-bosch.
 */
export const SETUP_INTEGRATION_KEY = 'setupIntegration'

export interface IntegrationFormSeed {
  readonly addonId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

export interface DiscoveryProposal {
  readonly suggestedName: string
  readonly prefilledConfig: Readonly<Record<string, unknown>>
}

export function integrationSetupSeed(
  addonId: string,
  candidate: DiscoveryProposal,
): IntegrationFormSeed | null {
  if (candidate.prefilledConfig[SETUP_INTEGRATION_KEY] !== true) return null
  const host = candidate.prefilledConfig['host']
  if (typeof host !== 'string' || host.trim().length === 0) return null
  return {
    addonId,
    name: candidate.suggestedName,
    config: { host: host.trim() },
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Location state left by a scan on another page (`{ integrationSeed }`). */
export function readIntegrationSeed(state: unknown): IntegrationFormSeed | null {
  if (!isRecord(state) || !isRecord(state['integrationSeed'])) return null
  const seed = state['integrationSeed']
  const addonId = seed['addonId']
  const name = seed['name']
  const config = seed['config']
  if (typeof addonId !== 'string' || addonId.length === 0) return null
  if (typeof name !== 'string') return null
  if (!isRecord(config)) return null
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) copy[key] = value
  return { addonId, name, config: copy }
}
