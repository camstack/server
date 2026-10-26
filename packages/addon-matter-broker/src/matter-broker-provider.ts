import { errMsg, type IBrokerProvider, type IScopedLogger } from '@camstack/types'
import {
  buildConnectionFormSchema,
  mergeMatterSecrets,
  publicMatterConnection,
  settingsToMatterConnection,
} from './config.js'
import type { MatterBrokerEntry } from './config.js'
import type { MatterBrokerRegistry } from './matter-broker-registry.js'
import { parsePairingCode } from './matter-commissioning.js'

const MATTER_KIND = 'matter'

export interface MatterBrokerProviderDeps {
  readonly ownerAddonId: string
  readonly registry: Pick<
    MatterBrokerRegistry,
    | 'list'
    | 'get'
    | 'createEntry'
    | 'removeEntry'
    | 'updateEntry'
    | 'size'
    | 'connectedCount'
    | 'commissionNode'
    | 'getCommissionProgress'
  >
  readonly getBrokers: () => readonly MatterBrokerEntry[]
  readonly persistBrokers: (brokers: readonly MatterBrokerEntry[]) => Promise<void>
  readonly cascadeRemoveDevices: (brokerId: string) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * Construct the `broker` cap provider for the Matter addon. Pure builder.
 * Mirrors `buildEcowittBrokerProvider`. The defining Matter operation —
 * commissioning — is surfaced through `publish` with
 * `target: { action: 'commissionNode' }` and `payload: { pairingCode }`.
 * `threadDataset` and `wifiPassword` are redacted on settings reads and
 * preserved on an empty round-trip. Fabric keys stay in matter.js storage.
 */
export function buildMatterBrokerProvider(deps: MatterBrokerProviderDeps): IBrokerProvider {
  const { ownerAddonId, registry, getBrokers, persistBrokers, cascadeRemoveDevices, logger } = deps

  const owns = (id: string): boolean => getBrokers().some((b) => b.id === id)

  const redact = (entry: MatterBrokerEntry): Record<string, unknown> =>
    publicMatterConnection(entry.connection)

  return {
    list: async ({ kind }) => {
      if (kind && kind !== MATTER_KIND) return []
      return registry.list().map((info) => ({ ...info, addonId: ownerAddonId }))
    },

    get: async ({ id }) => {
      const info = registry.get(id)
      return info ? { ...info, addonId: ownerAddonId } : null
    },

    listProviders: async () => [
      { addonId: ownerAddonId, kinds: [{ kind: MATTER_KIND, label: 'Matter' }] },
    ],

    add: async ({ kind, name, settings }) => {
      if (kind !== MATTER_KIND) {
        throw new Error(`matter-broker: only kind '${MATTER_KIND}' is handled here (got '${kind}')`)
      }
      const entry = await registry.createEntry(name, settingsToMatterConnection(settings))
      await persistBrokers([...getBrokers(), entry])
      return { id: entry.id }
    },

    remove: async ({ id }) => {
      if (!owns(id)) return
      await registry.removeEntry(id)
      await cascadeRemoveDevices(id).catch((err: unknown) => {
        logger.warn('matter: broker cascade-remove threw', {
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
      const parsed = settingsToMatterConnection(settings)
      const merged = mergeMatterSecrets(existing.connection, parsed)
      const updated = await registry.updateEntry(id, merged)
      await persistBrokers(getBrokers().map((b) => (b.id === id ? updated : b)))
    },

    getBrokerConfig: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      return entry ? redact(entry) : null
    },

    getSettingsSchema: async ({ kind }) => {
      if (kind !== MATTER_KIND) return null
      return buildConnectionFormSchema()
    },

    testSettings: async ({ kind, settings }) => {
      if (kind !== MATTER_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
      try {
        settingsToMatterConnection(settings)
        return { ok: true }
      } catch (err: unknown) {
        return { ok: false, error: errMsg(err) }
      }
    },

    /**
     * `publish` is the commissioning + control action channel.
     * `target: { action: 'commissionNode' }`, `payload: { pairingCode }` →
     * runs the controller's `commissionNode`. Other actions are a TODO.
     */
    publish: async ({ brokerId, target, payload }) => {
      if (!owns(brokerId)) throw new Error(`matter: unknown broker ${brokerId}`)
      const action = typeof target['action'] === 'string' ? target['action'] : undefined
      if (action === 'commissionNode') {
        const code = pairingCodeFromPayload(payload)
        // Fail fast on a malformed code before touching the controller.
        parsePairingCode(code)
        return registry.commissionNode(brokerId, code)
      }
      throw new Error(`matter: unsupported publish action '${action ?? '(none)'}'`)
    },

    // ── Pub/sub: attribute reports flow over the event bus as broker.message ──
    subscribe: async () => ({ subscriptionId: '' }),
    unsubscribe: async () => undefined,
    getState: async ({ brokerId, key }) => {
      if (key !== 'commission') return null
      return registry.getCommissionProgress(brokerId)
    },

    getStatus: async () => ({
      brokerCount: registry.size(),
      connectedCount: registry.connectedCount(),
    }),
  }
}

function pairingCodeFromPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('pairingCode' in payload)) return ''
  const code = payload.pairingCode
  if (typeof code === 'string') return code
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return ''
}
