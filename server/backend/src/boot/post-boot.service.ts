import { randomUUID } from 'node:crypto'
import type { EnsureTlsResult } from '@camstack/system'
import { readPendingRestart, retirePreviousLocalCa } from '@camstack/system'
import type {
  IScopedLogger,
  PendingRestartMarkerPayload,
  TlsCertChangedPayload,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { AddonRegistryService } from '../core/addon/addon-registry.service'
import { EventBusService } from '../core/events/event-bus.service'
import { LoggingService } from '../core/logging/logging.service'
import { blankToNull, PRODUCT_VERSION_ENV } from '../core/release-identity.js'
import { announceProductVersionChange } from '../core/updates/node-update-announcement.js'
import { ELECTRON_APP_VERSION_ENV } from '../server-root/index.js'
import { reconcileLifecycleJobsAtBoot } from './reconcile-lifecycle-jobs.js'

export interface PostBootContext {
  readonly port: number
  readonly host: string
  readonly dataPath: string
  readonly trpcRegistered: boolean
  /** Outcome of `ensureTlsCert` at phase 2c — absent when TLS is off or
   *  the operator supplied their own certificate. */
  readonly tlsCert?: EnsureTlsResult
}

export class PostBootService {
  private readonly logger: IScopedLogger

  /**
   * Holds the marker that fired `system.restart-completed` on this boot
   * for `LAST_RESTART_RETENTION_MS`. Lets clients query the marker
   * after they reconnect — the live event itself is emitted before the
   * WS resubscribe has a chance to land.
   */
  private static lastRestart: { payload: PendingRestartMarkerPayload; expiresAt: number } | null =
    null

  /** How long the last-restart marker stays queryable after boot (5 min). */
  static readonly LAST_RESTART_RETENTION_MS = 5 * 60_000

  constructor(
    _addonRegistry: AddonRegistryService,
    private readonly eventBus: EventBusService,
    loggingService: LoggingService,
  ) {
    this.logger = loggingService.createLogger('PostBoot')
  }

  /**
   * Snapshot of the most-recent restart marker, or `null` after the
   * retention window. The hub's `addons.getLastRestart` cap method
   * delegates here.
   */
  static getLastRestart(): PendingRestartMarkerPayload | null {
    const entry = PostBootService.lastRestart
    if (entry === null) return null
    if (entry.expiresAt <= Date.now()) {
      PostBootService.lastRestart = null
      return null
    }
    return entry.payload
  }

  async run(context: PostBootContext): Promise<void> {
    const { port, host, dataPath, trpcRegistered, tlsCert } = context

    // Device stream wiring moved into `addon-stream-broker` — the addon
    // does its own initial sync against `ctx.deviceRegistry` plus listens
    // to `DeviceRegistered` events for future registrations. No kernel
    // orchestration shim needed here anymore.

    // Emit system.boot event
    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'system' },
      category: EventCategory.SystemBoot,
      data: { port, host, trpcRegistered, dataPath },
    })

    // If the previous shutdown was driven by RestartCoordinator, emit a
    // `system.restart-completed` event so the admin UI can surface a
    // success toast describing what changed (framework update, manual
    // restart, …). `readPendingRestart` clears the marker atomically so
    // we never re-fire on a crash-loop boot.
    this.emitRestartCompletedIfPending(dataPath)

    // A container that came up on a different image than its previous boot
    // says so (`node-updating`): the old container is gone before this runs.
    this.announceImageChangeIfAny(dataPath)

    // A certificate that changed underneath the operator is an alert, not
    // a boot line they will never scroll back to (D227).
    this.emitTlsCertChangedIfReissued(tlsCert)

    // The listener is up on the replacement CA's leaf: the retired unconstrained CA (and
    // its key) kept on disk for the replacement window can go (D873).
    if (retirePreviousLocalCa(dataPath)) {
      this.logger.warn('Retired the previous local CA that had no name constraints (D873)')
    }

    // Re-drive every non-terminal lifecycle job (addon task phases) from its
    // on-disk checkpoint. Framework tasks are no longer applied by the engine
    // (single-copy collapse — framework updates ship via applyServerUpdate);
    // any stray framework task is skipped during reconcile.
    await this.reconcileLifecycleJobsIfAny()
  }

  private async reconcileLifecycleJobsIfAny(): Promise<void> {
    const { resumed, failed } = await reconcileLifecycleJobsAtBoot()
    if (resumed + failed > 0) {
      this.logger.info('Lifecycle jobs reconciled at boot', { meta: { resumed, failed } })
    }
  }

  private emitTlsCertChangedIfReissued(tlsCert: EnsureTlsResult | undefined): void {
    if (tlsCert === undefined || !tlsCert.generated) return

    const payload: TlsCertChangedPayload = {
      reason: tlsCert.reason ?? 'unknown',
      fingerprintSha256: tlsCert.fingerprintSha256,
      caFingerprintSha256: tlsCert.caFingerprintSha256,
      caRotated: tlsCert.caRotated,
      caCertPath: tlsCert.caCertPath,
      validTo: tlsCert.validTo,
      sans: tlsCert.sans,
    }

    this.logger.warn('TLS certificate reissued', { meta: payload })
    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'system' },
      category: EventCategory.SystemTlsCertChanged,
      data: payload,
    })
  }

  private announceImageChangeIfAny(dataDir: string): void {
    try {
      announceProductVersionChange({
        dataDir,
        productVersion: blankToNull(process.env[PRODUCT_VERSION_ENV]),
        underDesktopShell: (process.env[ELECTRON_APP_VERSION_ENV] ?? '').length > 0,
        bus: this.eventBus,
        sourceId: 'system',
        nodeId: process.env['CAMSTACK_NODE_ID'] ?? 'hub',
        logger: this.logger,
      })
    } catch (err) {
      // Telemetry (D8): never block the boot.
      this.logger.warn('image change check failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private emitRestartCompletedIfPending(dataDir: string): void {
    const marker = readPendingRestart(dataDir)
    if (marker === null) return

    const payload: PendingRestartMarkerPayload = {
      kind: marker.kind,
      requestedAt: marker.requestedAt,
      nodeId: process.env['CAMSTACK_NODE_ID'] ?? 'hub',
      ...(marker.packageName !== undefined ? { packageName: marker.packageName } : {}),
      ...(marker.fromVersion !== undefined ? { fromVersion: marker.fromVersion } : {}),
      ...(marker.toVersion !== undefined ? { toVersion: marker.toVersion } : {}),
      ...(marker.requestedBy !== undefined ? { requestedBy: marker.requestedBy } : {}),
    }

    this.logger.info('Restart completed', { meta: payload })
    PostBootService.lastRestart = {
      payload,
      expiresAt: Date.now() + PostBootService.LAST_RESTART_RETENTION_MS,
    }
    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'system' },
      category: EventCategory.SystemRestartCompleted,
      data: payload,
    })
  }
}
