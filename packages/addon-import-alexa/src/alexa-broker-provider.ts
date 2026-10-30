import { errMsg, type IBrokerProvider, type IScopedLogger } from '@camstack/types'
import { buildConnectionFormSchema, settingsToAlexaConnection } from './config.js'
import type { AlexaBrokerEntry } from './config.js'
import type { AlexaBrokerRegistry } from './alexa-broker-registry.js'
import { ALEXA_BROKER_KIND } from './speak/constants.js'

export interface AlexaBrokerProviderDeps {
  readonly ownerAddonId: string
  readonly registry: Pick<
    AlexaBrokerRegistry,
    'list' | 'get' | 'createEntry' | 'removeEntry' | 'updateEntry' | 'size' | 'connectedCount'
  >
  readonly getBrokers: () => readonly AlexaBrokerEntry[]
  readonly persistBrokers: (brokers: readonly AlexaBrokerEntry[]) => Promise<void>
  readonly cascadeRemoveDevices: (brokerId: string) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * Construct the `broker` cap provider for the Alexa import addon. Pure builder.
 * Mirrors `buildEcowittBrokerProvider`. The cookie + refresh token are secrets:
 * redacted on settings reads, preserved on an empty round-trip. State sync is
 * poll-based (no pub/sub) — `publish`/`subscribe`/`getState` are no-ops.
 */
export function buildAlexaBrokerProvider(deps: AlexaBrokerProviderDeps): IBrokerProvider {
  const { ownerAddonId, registry, getBrokers, persistBrokers, cascadeRemoveDevices, logger } = deps

  const owns = (id: string): boolean => getBrokers().some((b) => b.id === id)

  const redact = (entry: AlexaBrokerEntry): Record<string, unknown> => ({
    ...entry.connection,
    cookie: '',
    refreshToken: '',
    macDms: '',
  })

  return {
    list: async ({ kind }) => {
      if (kind && kind !== ALEXA_BROKER_KIND) return []
      return registry.list().map((info) => ({ ...info, addonId: ownerAddonId }))
    },

    get: async ({ id }) => {
      const info = registry.get(id)
      return info ? { ...info, addonId: ownerAddonId } : null
    },

    listProviders: async () => [
      {
        addonId: ownerAddonId,
        kinds: [
          {
            kind: ALEXA_BROKER_KIND,
            label: 'Alexa',
            signIn: { basePath: '/addon/import-alexa/login', methods: ['device-code'] },
          },
        ],
      },
    ],

    add: async ({ kind, name, settings }) => {
      if (kind !== ALEXA_BROKER_KIND) {
        throw new Error(
          `import-alexa: only kind '${ALEXA_BROKER_KIND}' is handled here (got '${kind}')`,
        )
      }
      const entry = await registry.createEntry(name, settingsToAlexaConnection(settings))
      await persistBrokers([...getBrokers(), entry])
      return { id: entry.id }
    },

    remove: async ({ id }) => {
      if (!owns(id)) return
      await registry.removeEntry(id)
      await cascadeRemoveDevices(id).catch((err: unknown) => {
        logger.warn('alexa: broker cascade-remove threw', {
          tags: { brokerId: id },
          meta: { error: errMsg(err) },
        })
      })
      await persistBrokers(getBrokers().filter((b) => b.id !== id))
    },

    testConnection: async ({ id }) => {
      if (!owns(id)) return { ok: false, error: 'unknown broker' }
      const info = registry.get(id)
      if (!info) return { ok: false, error: 'unknown broker' }
      if (info.status === 'connected') {
        return {
          ok: true,
          latencyMs: info.lastCheckedAt ? Math.max(0, Date.now() - info.lastCheckedAt) : 0,
        }
      }
      return { ok: false, error: info.error ?? `status: ${info.status}` }
    },

    getSettings: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      return entry ? redact(entry) : null
    },

    setSettings: async ({ id, settings }) => {
      if (!owns(id)) return
      const existing = getBrokers().find((b) => b.id === id)
      if (!existing) return
      const parsed = settingsToAlexaConnection(settings)
      // Preserve stored secrets when the incoming value is the redacted (empty)
      // round-trip value.
      const merged = {
        ...parsed,
        cookie: parsed.cookie.length > 0 ? parsed.cookie : existing.connection.cookie,
        refreshToken:
          parsed.refreshToken.length > 0 ? parsed.refreshToken : existing.connection.refreshToken,
        macDms: parsed.macDms.length > 0 ? parsed.macDms : existing.connection.macDms,
      }
      const updated = await registry.updateEntry(id, merged)
      await persistBrokers(getBrokers().map((b) => (b.id === id ? updated : b)))
    },

    getBrokerConfig: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      return entry ? redact(entry) : null
    },

    getSettingsSchema: async ({ kind }) => {
      if (kind !== ALEXA_BROKER_KIND) return null
      return buildConnectionFormSchema()
    },

    testSettings: async ({ kind, settings }) => {
      if (kind !== ALEXA_BROKER_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
      try {
        settingsToAlexaConnection(settings)
        return { ok: true }
      } catch (err: unknown) {
        return { ok: false, error: errMsg(err) }
      }
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
