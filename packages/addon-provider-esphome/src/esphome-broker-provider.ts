import { errMsg, type IBrokerProvider, type IScopedLogger } from '@camstack/types'
import {
  buildConnectionFormSchema,
  mergeConnectionSecrets,
  redactConnection,
  settingsToConnection,
  type EspBrokerEntry,
} from './config.js'
import { ESP_BROKER_KIND, type EspBrokerRegistry } from './esphome-registry.js'

export interface EspBrokerProviderDeps {
  /** Addon id stamped on every BrokerInfo. */
  readonly ownerAddonId: string
  readonly registry: Pick<
    EspBrokerRegistry,
    'list' | 'get' | 'createEntry' | 'removeEntry' | 'updateEntry' | 'size' | 'connectedCount'
  >
  readonly getBrokers: () => readonly EspBrokerEntry[]
  readonly persistBrokers: (brokers: readonly EspBrokerEntry[]) => Promise<void>
  /** Remove every adopted device sourced from the board. */
  readonly cascadeRemoveDevices: (brokerId: string) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * The `broker` cap provider of the ESPHome addon. Pure builder: every side effect
 * is injected, so it is testable without an addon context. A board's keys never
 * leave through a read: `getSettings` and `getBrokerConfig` blank them, and a
 * write that echoes the blank keeps the stored key.
 */
export function buildEspBrokerProvider(deps: EspBrokerProviderDeps): IBrokerProvider {
  const { ownerAddonId, registry, getBrokers, persistBrokers, cascadeRemoveDevices, logger } = deps
  const owns = (id: string): boolean => getBrokers().some((b) => b.id === id)

  return {
    list: async ({ kind }) => {
      if (kind && kind !== ESP_BROKER_KIND) return []
      return registry.list().map((info) => ({ ...info, addonId: ownerAddonId }))
    },

    get: async ({ id }) => {
      const info = registry.get(id)
      return info ? { ...info, addonId: ownerAddonId } : null
    },

    listProviders: async () => [
      { addonId: ownerAddonId, kinds: [{ kind: ESP_BROKER_KIND, label: 'ESPHome' }] },
    ],

    add: async ({ kind, name, settings }) => {
      if (kind !== ESP_BROKER_KIND) {
        throw new Error(
          `provider-esphome: only kind '${ESP_BROKER_KIND}' is handled here (got '${kind}')`,
        )
      }
      const entry = await registry.createEntry(name, settingsToConnection(settings))
      await persistBrokers([...getBrokers(), entry])
      return { id: entry.id }
    },

    remove: async ({ id }) => {
      if (!owns(id)) return
      await registry.removeEntry(id)
      await cascadeRemoveDevices(id).catch((err: unknown) => {
        logger.warn('esphome: broker cascade-remove threw', {
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
      return entry ? redactConnection(entry.connection) : null
    },

    setSettings: async ({ id, settings }) => {
      const existing = getBrokers().find((b) => b.id === id)
      if (!existing) return
      const merged = mergeConnectionSecrets(settingsToConnection(settings), existing.connection)
      await registry.updateEntry(id, merged)
      await persistBrokers(
        getBrokers().map((b) => (b.id === id ? { ...b, connection: merged } : b)),
      )
    },

    getBrokerConfig: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      return entry ? redactConnection(entry.connection) : null
    },

    getSettingsSchema: async ({ kind }) =>
      kind === ESP_BROKER_KIND ? buildConnectionFormSchema() : null,

    // Validates the shape only: a test never opens a session, so a half-typed
    // key cannot be tried against a board.
    testSettings: async ({ kind, settings }) => {
      if (kind !== ESP_BROKER_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
      try {
        settingsToConnection(settings)
        return { ok: true }
      } catch (err: unknown) {
        return { ok: false, error: errMsg(err) }
      }
    },

    // An ESPHome board is not a pub/sub bus: these satisfy the generic surface.
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
