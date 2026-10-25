import { errMsg, type IBrokerProvider, type IScopedLogger } from '@camstack/types'
import { buildConnectionFormSchema, settingsToHmConfig } from './config.js'
import type { HmBrokerEntry } from './config.js'
import type { HmBrokerRegistry } from './homematic-broker-registry.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Kind tag registered by this provider — matches the `listProviders` entry. */
const HM_KIND = 'homematic'

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Injected dependencies for {@link buildHmBrokerProvider}. Nothing coupled to addon-ctx. */
export interface HmBrokerProviderDeps {
  /** Addon id of the addon that owns this provider (stamped on every BrokerInfo). */
  readonly ownerAddonId: string
  /** Live broker registry — subset of {@link HmBrokerRegistry} methods needed here. */
  readonly registry: Pick<
    HmBrokerRegistry,
    'list' | 'get' | 'createEntry' | 'removeEntry' | 'updateEntry' | 'size' | 'connectedCount'
  >
  /** Returns the current persisted broker list (read from addon settings). */
  readonly getBrokers: () => readonly HmBrokerEntry[]
  /** Persist the supplied broker list to addon settings. */
  readonly persistBrokers: (brokers: readonly HmBrokerEntry[]) => Promise<void>
  /**
   * Cascade-remove all adopted devices that were sourced from `brokerId`.
   * Injected so the provider stays decoupled from the kernel device registry
   * (the caller wires the actual {@link cascadeRemoveDevicesForBroker} call).
   */
  readonly cascadeRemoveDevices: (brokerId: string) => Promise<void>
  readonly logger: IScopedLogger
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Construct the `broker` cap provider for the Homematic addon.
 *
 * Pure builder: receives all side-effecting deps via injection so the
 * returned object is unit-testable without a real addon context.
 */
export function buildHmBrokerProvider(deps: HmBrokerProviderDeps): IBrokerProvider {
  const { ownerAddonId, registry, getBrokers, persistBrokers, cascadeRemoveDevices, logger } = deps

  /** True when this provider's registry owns the given id. */
  const owns = (id: string): boolean => getBrokers().some((b) => b.id === id)

  return {
    // ── Registry CRUD ──────────────────────────────────────────────────────

    list: async ({ kind }) => {
      if (kind && kind !== HM_KIND) return []
      return registry.list().map((info) => ({ ...info, addonId: ownerAddonId }))
    },

    get: async ({ id }) => {
      const info = registry.get(id)
      return info ? { ...info, addonId: ownerAddonId } : null
    },

    listProviders: async () => [
      { addonId: ownerAddonId, kinds: [{ kind: HM_KIND, label: 'Homematic' }] },
    ],

    add: async ({ kind, name, settings }) => {
      if (kind !== HM_KIND) {
        throw new Error(
          `provider-homematic: only kind '${HM_KIND}' is handled here (got '${kind}')`,
        )
      }
      const entry = await registry.createEntry(name, settingsToHmConfig(settings))
      await persistBrokers([...getBrokers(), entry])
      return { id: entry.id }
    },

    remove: async ({ id }) => {
      // No-op for ids this provider does not own — the collection fallback
      // may route a foreign id here.
      if (!owns(id)) return
      await registry.removeEntry(id)
      // Cascade-delete all adopted devices whose source brokerId matches.
      // devices.remove cascades to children and emits device.unregistered
      // per removed device.
      await cascadeRemoveDevices(id).catch((err: unknown) => {
        logger.warn('homematic: broker cascade-remove threw', {
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

    // ── Settings ───────────────────────────────────────────────────────────

    getSettings: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      if (!entry) return null
      // Never expose the stored password over the admin API.
      return { ...entry.connection, password: '' }
    },

    setSettings: async ({ id, settings }) => {
      if (!owns(id)) return
      const existing = getBrokers().find((b) => b.id === id)
      if (!existing) return
      const parsed = settingsToHmConfig(settings)
      // If the incoming password is empty the operator submitted the
      // redacted round-trip value — preserve the stored secret.
      const merged = {
        ...parsed,
        password: parsed.password.length > 0 ? parsed.password : existing.connection.password,
      }
      const updated = await registry.updateEntry(id, merged)
      await persistBrokers(getBrokers().map((b) => (b.id === id ? updated : b)))
    },

    getBrokerConfig: async ({ id }) => {
      const entry = getBrokers().find((b) => b.id === id)
      if (!entry) return null
      // Never expose the stored password over the admin API.
      return { ...entry.connection, password: '' }
    },

    // ── Per-kind creation schema + pre-creation test ───────────────────────

    getSettingsSchema: async ({ kind }) => {
      if (kind !== HM_KIND) return null
      return buildConnectionFormSchema()
    },

    testSettings: async ({ kind, settings }) => {
      if (kind !== HM_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
      try {
        settingsToHmConfig(settings)
        return { ok: true }
      } catch (err: unknown) {
        return { ok: false, error: errMsg(err) }
      }
    },

    // ── Pub/sub no-ops ─────────────────────────────────────────────────────
    //
    // Homematic is NOT a pub/sub bus — it pushes events via XML-RPC callbacks
    // to the addon and has no concept of ad-hoc subscriptions from outside.
    // These methods are part of the generic broker surface; they return safe
    // no-op results so the generic broker UI can probe them without crashing.

    publish: async () => null,

    subscribe: async () => ({ subscriptionId: '' }),

    unsubscribe: async () => undefined,

    getState: async () => null,

    // ── Status ─────────────────────────────────────────────────────────────

    getStatus: async () => ({
      brokerCount: registry.size(),
      connectedCount: registry.connectedCount(),
    }),
  }
}
