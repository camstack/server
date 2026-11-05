import type { IBrokerProvider } from '@camstack/types'
import type { AlexaBrokerEntry } from './config.js'
import type { AlexaBrokerRegistry } from './alexa-broker-registry.js'

export interface AlexaBrokerProviderDeps {
  readonly registry: Pick<AlexaBrokerRegistry, 'size' | 'connectedCount'>
  readonly getBrokers: () => readonly AlexaBrokerEntry[]
}

/**
 * Construct the `broker` cap provider for the Alexa import addon. Pure builder.
 * The bus half only (D1013): creating, listing, editing and removing an account is
 * `integration-instances`. The cookie + refresh token are secrets, redacted on the config
 * read. State sync is poll-based (no pub/sub) — `publish`/`subscribe`/`getState` are no-ops.
 */
export function buildAlexaBrokerProvider(deps: AlexaBrokerProviderDeps): IBrokerProvider {
  const { registry, getBrokers } = deps

  const redact = (entry: AlexaBrokerEntry): Record<string, unknown> => ({
    ...entry.connection,
    cookie: '',
    refreshToken: '',
    macDms: '',
  })

  return {
    getBrokerConfig: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      return entry ? redact(entry) : null
    },

    // ── Pub/sub no-ops: state flows over the bus as broker.message via poll ──
    publish: async () => null,
    subscribe: async () => ({ subscriptionId: '' }),
    unsubscribe: async () => undefined,
    getState: async () => null,

    getStatus: async () => ({
      brokerCount: registry.size(),
      connectedCount: registry.connectedCount(),
    }),
  }
}
