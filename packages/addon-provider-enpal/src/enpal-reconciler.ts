import { errMsg, type IScopedLogger } from '@camstack/types'

export interface ReconcilerIntegration {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
}

export interface ReconcilerClients {
  list(): readonly string[]
  remove(integrationId: string): Promise<void>
}

export interface EnpalReconcilerDeps {
  readonly addonId: string
  readonly logger: IScopedLogger
  readonly clients: ReconcilerClients
  readonly listIntegrations: () => Promise<readonly ReconcilerIntegration[]>
  /** Read the integration's settings and upsert its client; false when they hold no usable connection. */
  readonly applySettings: (integration: ReconcilerIntegration) => Promise<boolean>
  /** Remove the Container and Gateway devices of an integration (children follow their Container). */
  readonly removeDevices: (integrationId: string) => Promise<number>
}

export type IntegrationLifecycleKind = 'enabled' | 'disabled' | 'deleted'

/**
 * Keeps one live client per enabled integration. Devices are removed ONLY on an explicit
 * lifecycle event naming the integration (D49): a list that failed, an empty list or an
 * unreadable connection changes nothing about devices and is logged, never read as "gone".
 */
export class EnpalReconciler {
  readonly #deps: EnpalReconcilerDeps

  constructor(deps: EnpalReconcilerDeps) {
    this.#deps = deps
  }

  /** Upsert a client per usable enabled integration; drop the CLIENT (never devices) of one the list answered is gone. */
  async reconcile(): Promise<void> {
    const { logger, clients } = this.#deps
    let all: readonly ReconcilerIntegration[]
    try {
      all = await this.#deps.listIntegrations()
    } catch (err) {
      logger.warn('Enpal integration reconcile skipped — the integration list did not answer', {
        meta: { error: errMsg(err) },
      })
      return
    }
    const enabled = all.filter((i) => i.addonId === this.#deps.addonId && i.enabled)
    for (const integration of enabled) {
      try {
        if (!(await this.#deps.applySettings(integration))) {
          logger.warn('Enpal integration has no usable connection — left as it is', {
            meta: { integrationId: integration.id },
          })
        }
      } catch (err) {
        logger.warn('Enpal reconcile failed for integration — left as it is', {
          meta: { integrationId: integration.id, error: errMsg(err) },
        })
      }
    }
    const enabledIds = new Set(enabled.map((i) => i.id))
    for (const id of clients.list()) {
      if (!enabledIds.has(id)) await clients.remove(id)
    }
  }

  /** An explicit lifecycle event: only `deleted` / `disabled` of a named integration remove devices. */
  async onLifecycle(kind: IntegrationLifecycleKind, integrationId: string | null): Promise<void> {
    await this.reconcile()
    if (kind === 'enabled' || integrationId === null) return
    try {
      const removed = await this.#deps.removeDevices(integrationId)
      this.#deps.logger.info('Enpal integration devices removed', {
        meta: { integrationId, kind, removed },
      })
    } catch (err) {
      this.#deps.logger.warn('Enpal integration device removal failed', {
        meta: { integrationId, kind, error: errMsg(err) },
      })
    }
  }
}
