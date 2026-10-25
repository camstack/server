import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { LoggingService } from '../logging/logging.service'

// Dynamically imported to tolerate missing / unbuilt packages at startup
type AddonLoader = import('@camstack/system').AddonLoader
type AddonInstaller = import('@camstack/system').AddonInstaller
type RegisteredAddon = import('@camstack/system').RegisteredAddon

/**
 * AddonBridgeService — slim package-management surface.
 *
 * Historically this service also cached per-camera pipeline configs + per-
 * addon config records + hosted an in-process `PipelineRunner` that consumers
 * called via `processFrame` / `processMotionFrame`. Every piece of that
 * plumbing was dead post commit 2c (the runtime scheduler moved to
 * `addon-pipeline-runner`) and the pipeline page redesign finishes the job
 * by deleting the cache, the AddonEngineManager wiring, the bridge-pipeline
 * tRPC router, and the PipelineWiringModule that bolted the legacy addon
 * resolver onto this service.
 *
 * What's left is ONLY the addon package management surface: the installer
 * + the loader + `reloadPackages` + `listAvailableAddons`. These are still
 * used by `server/backend/src/api/addon-upload.ts` (multipart upload →
 * install → loader reload). The `bridge-addons.router.ts` that also used it
 * was never mounted and was deleted on 2026-10-08 — its hard-coded REQUIRED
 * set read like the uninstall guard and was not; uninstall is the `addons`
 * cap's (`core/addon/addon-uninstall.ts`).
 */
export class AddonBridgeService {
  private readonly logger: IScopedLogger

  private loader!: AddonLoader
  private installer: AddonInstaller | null = null

  /** Whether the bridge initialised successfully */
  private available = false

  constructor(private readonly loggingService: LoggingService) {
    this.logger = this.loggingService.createLogger('AddonBridge')

    // Initialize installer eagerly in constructor (no async needed).
    // This ensures install/uninstall works even before onModuleInit completes.
    try {
      const kernel = require('@camstack/system') as typeof import('@camstack/system')
      const dataDir = process.env.CAMSTACK_DATA ?? 'camstack-data'
      const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
      const workspacePackagesDir = kernel.detectWorkspacePackagesDir(__dirname)
      this.installer = new kernel.AddonInstaller({
        addonsDir,
        workspacePackagesDir: workspacePackagesDir ?? undefined,
      })
      kernel.ensureDir(addonsDir)
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.warn('Installer init failed', { meta: { error: msg } })
    }
  }

  async onModuleInit(): Promise<void> {
    this.logger.info('Initializing addon bridge (package management only)...')

    try {
      const kernel = await import('@camstack/system')

      this.loader = new kernel.AddonLoader(this.logger.child('AddonLoader'))

      const dataDir = process.env.CAMSTACK_DATA ?? 'camstack-data'
      const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
      await this.loader.loadFromDirectory(addonsDir)

      this.available = true
      this.logger.info('Addon bridge initialized', {
        meta: { count: this.loader.listAddons().length },
      })
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.warn('Addon bridge loader failed — install/uninstall still available', {
        meta: { error: msg },
      })
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.info('Addon bridge shut down')
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Whether the bridge is ready for use */
  isAvailable(): boolean {
    return this.available
  }

  /** Return the underlying AddonLoader (for querying / introspection) */
  getLoader(): AddonLoader {
    return this.loader
  }

  /** List IDs of all successfully loaded addons */
  listAvailableAddons(): string[] {
    if (!this.available) return []
    return this.loader.listAddons().map((a: RegisteredAddon) => a.declaration.id)
  }

  /** Return the AddonInstaller instance (may be null if bridge failed to init) */
  getInstaller(): AddonInstaller | null {
    return this.installer
  }

  /** Re-discover addons from the addons directory (call after install/uninstall) */
  async reloadPackages(): Promise<void> {
    if (!this.available) {
      this.logger.warn('reloadPackages called but bridge is unavailable — skipping')
      return
    }

    const kernel = await import('@camstack/system')
    this.loader = new kernel.AddonLoader(this.logger.child('AddonLoader'))

    const dataDir = process.env.CAMSTACK_DATA ?? 'camstack-data'
    const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
    await this.loader.loadFromDirectory(addonsDir)

    this.logger.info('Reloaded', { meta: { count: this.loader.listAddons().length } })
  }
}
