import * as path from 'node:path'
import * as fs from 'node:fs'
import { LoggingService } from '../logging/logging.service'
import { ConfigService } from '../config/config.service'
import { CapabilityService } from '../capability/capability.service'
import type { IScopedLogger } from '@camstack/types'
import type { IAddonPageProvider } from '@camstack/types'

/**
 * AddonPagesService — server-side helper that backs the static file
 * route `/api/addon-pages/:addonId/*` (registered in `main.ts`).
 *
 * The public listing surface (`addonPages.listPages` on the AppRouter)
 * has been split out of this class — it now lives in the
 * `addon-pages-aggregator` builtin (`@camstack/system/builtins/...`)
 * which walks every `addon-pages-source` collection provider and
 * stamps versioned `bundleUrl`s. The split lets both ends flow through
 * codegen instead of relying on a hand-written wrapper.
 *
 * What stays here: filesystem path resolution + traversal protection
 * for the static file route. Both rely on `CapabilityService` to
 * enumerate registered page providers (so unknown / unregistered
 * addons can't be probed via path traversal tricks) and on
 * `ConfigService` to locate the addons directory.
 */
export class AddonPagesService {
  private readonly logger: IScopedLogger

  constructor(
    private readonly loggingService: LoggingService,
    private readonly configService: ConfigService,
    private readonly caps: CapabilityService,
  ) {
    this.logger = this.loggingService.createLogger('AddonPagesService')
  }

  /**
   * Resolve the filesystem path to an addon's page bundle file.
   * Returns null if the addon is not registered, the file doesn't exist,
   * or the path would escape the addon directory (path traversal protection).
   */
  resolveBundle(addonId: string, filePath: string): string | null {
    // Check if the addon is a registered page provider via the
    // collection cap. `addon-pages-source` is the new home for the raw
    // per-provider declarations (the public `addon-pages` cap is the
    // aggregated singleton — different shape, different surface).
    const providers = this.caps.getCollection<IAddonPageProvider>('addon-pages-source')
    const isRegistered = providers.some((p) => p.id === addonId)
    if (!isRegistered) {
      this.logger.warn('Bundle resolve failed: addon not registered as page provider', {
        tags: { addonId },
      })
      return null
    }

    const addonsDir = this.resolveAddonsDir()
    // Addon packages are at addons/@camstack/addon-<id>/dist/
    const addonDistPath = path.join(addonsDir, '@camstack', `addon-${addonId}`, 'dist')

    const resolvedBase = path.resolve(addonDistPath)
    const resolvedFile = path.resolve(addonDistPath, filePath)

    // Path traversal protection
    if (!resolvedFile.startsWith(resolvedBase + path.sep) && resolvedFile !== resolvedBase) {
      this.logger.warn('Path traversal denied for addon', { tags: { addonId }, meta: { filePath } })
      return null
    }

    if (!fs.existsSync(resolvedFile)) {
      this.logger.debug('Bundle file not found', { meta: { resolvedFile } })
      return null
    }

    return resolvedFile
  }

  /** Resolve the addons directory from config */
  private resolveAddonsDir(): string {
    const dataPath = this.configService.get<string>('server.dataPath') ?? 'camstack-data'
    return path.resolve(dataPath, 'addons')
  }
}
