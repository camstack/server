/**
 * A discovery candidate that must be finished in the integration form
 * (pairing, credentials) instead of one-click device adoption.
 *
 * The flag is the typed `setupIntegration` field of the candidate. The older
 * `prefilledConfig.setupIntegration` marker ({@link SETUP_INTEGRATION_KEY}) is
 * still read for one release, and never copied into the form.
 */
export const SETUP_INTEGRATION_KEY = 'setupIntegration'

export interface IntegrationFormSeed {
  readonly addonId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

export interface DiscoveryProposal {
  readonly suggestedName: string
  readonly setupIntegration?: boolean | undefined
  readonly prefilledConfig: Readonly<Record<string, unknown>>
}

/** True when picking the candidate opens the integration form, not an adoption. */
export function needsIntegrationSetup(candidate: DiscoveryProposal): boolean {
  return (
    candidate.setupIntegration === true || candidate.prefilledConfig[SETUP_INTEGRATION_KEY] === true
  )
}

/** The form seed a candidate carries: its whole prefilled config, minus the legacy marker. */
export function seedFromCandidate(
  addonId: string,
  candidate: DiscoveryProposal,
): IntegrationFormSeed {
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(candidate.prefilledConfig)) {
    if (key === SETUP_INTEGRATION_KEY) continue
    config[key] = typeof value === 'string' && key === 'host' ? value.trim() : value
  }
  return { addonId, name: candidate.suggestedName, config }
}

export function integrationSetupSeed(
  addonId: string,
  candidate: DiscoveryProposal,
): IntegrationFormSeed | null {
  return needsIntegrationSetup(candidate) ? seedFromCandidate(addonId, candidate) : null
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
