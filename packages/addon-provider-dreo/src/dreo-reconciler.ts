import { errMsg, OrphanIntegrationSweep, type IScopedLogger } from '@camstack/types'

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

export interface DreoReconcilerDeps {
  readonly addonId: string
  readonly logger: IScopedLogger
  readonly clients: ReconcilerClients
  readonly listIntegrations: () => Promise<readonly ReconcilerIntegration[]>
  /** Read the integration's settings and upsert its client; false when they hold no usable connection. */
  readonly applySettings: (integration: ReconcilerIntegration) => Promise<boolean>
  /** Remove the Container and Gateway devices of an integration (children follow their Container). */
  readonly removeDevices: (integrationId: string) => Promise<number>
  /** Integration ids that own devices here; absent = no orphan sweep (two concordant reads, see OrphanIntegrationSweep). */
  readonly ownerIntegrationIds?: () => Promise<readonly string[]>
  /** Test seam for the sweep's clock and interval. */
  readonly sweepOptions?: { readonly minIntervalMs?: number; readonly now?: () => number }
}

export type IntegrationLifecycleKind = 'enabled' | 'disabled' | 'deleted'

/**
 * Keeps one live client per enabled integration. Devices are removed ONLY on an explicit
 * lifecycle event naming the integration (D49): a list that failed, an empty list or an
 * unreadable connection changes nothing about devices and is logged, never read as "gone".
 */
export class DreoReconciler {
  readonly #deps: DreoReconcilerDeps
  readonly #sweep: OrphanIntegrationSweep
  #rerun: ReturnType<typeof setTimeout> | null = null

  constructor(deps: DreoReconcilerDeps) {
    this.#deps = deps
    this.#sweep = new OrphanIntegrationSweep({ logger: deps.logger, ...deps.sweepOptions })
  }

  /** Upsert a client per usable enabled integration; drop the CLIENT (never devices) of one the list answered is gone. */
  async reconcile(): Promise<void> {
    const { logger, clients } = this.#deps
    let all: readonly ReconcilerIntegration[]
    try {
      all = await this.#deps.listIntegrations()
    } catch (err) {
      logger.warn('Dreo integration reconcile skipped — the integration list did not answer', {
        meta: { error: errMsg(err) },
      })
      return
    }
    const enabled = all.filter((i) => i.addonId === this.#deps.addonId && i.enabled)
    for (const integration of enabled) {
      try {
        if (!(await this.#deps.applySettings(integration))) {
          logger.warn('Dreo integration has no usable connection — left as it is', {
            meta: { integrationId: integration.id },
          })
        }
      } catch (err) {
        logger.warn('Dreo reconcile failed for integration — left as it is', {
          meta: { integrationId: integration.id, error: errMsg(err) },
        })
      }
    }
    const enabledIds = new Set(enabled.map((i) => i.id))
    for (const id of clients.list()) {
      if (!enabledIds.has(id)) await clients.remove(id)
    }
    await this.#sweepOrphans(all.map((i) => i.id))
  }

  /** Stop the scheduled second read (addon stop). */
  dispose(): void {
    if (this.#rerun !== null) clearTimeout(this.#rerun)
    this.#rerun = null
  }

  /**
   * An integration deleted while this addon was down emits nothing it sees: its id owns devices
   * yet is absent from the ANSWERED list. Removal needs a second answered read later, so one
   * re-run is scheduled when a suspect appears (bounded: one timer, no retry loop).
   */
  async #sweepOrphans(listedIds: readonly string[]): Promise<void> {
    const { ownerIntegrationIds, removeDevices, logger } = this.#deps
    if (ownerIntegrationIds === undefined) return
    try {
      const ownerIds = await ownerIntegrationIds()
      const result = await this.#sweep.sweep({ ownerIds, listedIds, removeDevices })
      if (result.newSuspects > 0 && this.#rerun === null) {
        this.#rerun = setTimeout(() => {
          this.#rerun = null
          void this.reconcile()
        }, this.#sweep.minIntervalMs + 1_000)
        this.#rerun.unref()
      }
    } catch (err) {
      logger.warn('Orphan integration sweep failed — devices left as they are', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** An explicit lifecycle event: only `deleted` / `disabled` of a named integration remove devices. */
  async onLifecycle(kind: IntegrationLifecycleKind, integrationId: string | null): Promise<void> {
    await this.reconcile()
    if (kind === 'enabled' || integrationId === null) return
    try {
      const removed = await this.#deps.removeDevices(integrationId)
      this.#deps.logger.info('Dreo integration devices removed', {
        meta: { integrationId, kind, removed },
      })
    } catch (err) {
      this.#deps.logger.warn('Dreo integration device removal failed', {
        meta: { integrationId, kind, error: errMsg(err) },
      })
    }
  }
}
