import { errMsg, type IScopedLogger } from '@camstack/types'
import { connectionFromSettings, gatewayKeyOf, type EcowittConnectionRead } from './config.js'
import type { EcowittConfig } from './config.js'
import type { EcowittSettingsRead } from './ecowitt-instances.js'

export interface ReconcilerIntegration {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
  readonly originStableId?: string | undefined
}

export interface ReconcilerClients {
  list(): readonly string[]
  upsert(
    integrationId: string,
    gatewayKey: string,
    name: string,
    connection: EcowittConfig,
  ): Promise<void>
  remove(integrationId: string): Promise<void>
}

export interface EcowittReconcilerDeps {
  readonly addonId: string
  readonly logger: IScopedLogger
  readonly clients: ReconcilerClients
  readonly listIntegrations: () => Promise<readonly ReconcilerIntegration[]>
  /** The integration's connection record, read through the instances provider. */
  readonly readSettings: (integrationId: string) => Promise<EcowittSettingsRead>
  /** Remove the Gateway and Container devices of an integration (sensors follow their Container). */
  readonly removeDevices: (integrationId: string) => Promise<number>
}

export type IntegrationLifecycleKind = 'enabled' | 'disabled' | 'deleted'

/**
 * Keeps one live client per enabled integration. Devices are removed ONLY on an explicit
 * lifecycle event naming the integration (D49): a read that failed, a locked keychain or an
 * unreadable connection changes nothing and is logged, never read as "the integration is gone".
 */
export class EcowittReconciler {
  readonly #deps: EcowittReconcilerDeps

  constructor(deps: EcowittReconcilerDeps) {
    this.#deps = deps
  }

  /** Upsert a client per usable enabled integration; drop the client of one the list ANSWERED is gone/disabled. */
  async reconcile(): Promise<void> {
    const { logger, clients } = this.#deps
    let all: readonly ReconcilerIntegration[]
    try {
      all = await this.#deps.listIntegrations()
    } catch (err) {
      logger.warn('Ecowitt integration reconcile skipped — the integration list did not answer', {
        meta: { error: errMsg(err) },
      })
      return
    }
    const enabled = all.filter((i) => i.addonId === this.#deps.addonId && i.enabled)
    for (const integration of enabled) {
      await this.#upsertOne(integration)
    }
    const enabledIds = new Set(enabled.map((i) => i.id))
    for (const id of clients.list()) {
      if (!enabledIds.has(id)) await clients.remove(id)
    }
  }

  async #upsertOne(integration: ReconcilerIntegration): Promise<void> {
    const { logger, clients } = this.#deps
    try {
      const stored = await this.#deps.readSettings(integration.id)
      const read: EcowittConnectionRead | null = connectionFromSettings(
        stored.values,
        stored.secretsLocked,
      )
      if (read === null) {
        logger.warn('Ecowitt integration has no usable connection — left as it is', {
          meta: { integrationId: integration.id },
        })
        return
      }
      if (read.passwordLocked && read.connection.transport === 'local') {
        logger.warn(
          'Ecowitt integration password is stored but unreadable now — left as it is, not dialled with an empty one',
          { meta: { integrationId: integration.id } },
        )
        return
      }
      await clients.upsert(
        integration.id,
        gatewayKeyOf(integration),
        integration.name,
        read.connection,
      )
    } catch (err) {
      logger.warn('Ecowitt reconcile failed for integration — left as it is', {
        meta: { integrationId: integration.id, error: errMsg(err) },
      })
    }
  }

  /** An explicit lifecycle event: only `deleted` / `disabled` of a named integration remove devices. */
  async onLifecycle(kind: IntegrationLifecycleKind, integrationId: string | null): Promise<void> {
    await this.reconcile()
    if (kind === 'enabled' || integrationId === null) return
    try {
      const removed = await this.#deps.removeDevices(integrationId)
      this.#deps.logger.info('Ecowitt integration devices removed', {
        meta: { integrationId, kind, removed },
      })
    } catch (err) {
      this.#deps.logger.warn('Ecowitt integration device removal failed', {
        meta: { integrationId, kind, error: errMsg(err) },
      })
    }
  }
}
