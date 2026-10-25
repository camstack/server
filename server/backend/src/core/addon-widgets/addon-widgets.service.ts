import * as path from 'node:path'
import * as fs from 'node:fs'
import { LoggingService } from '../logging/logging.service'
import { CapabilityService } from '../capability/capability.service'
import { AddonRegistryService } from '../addon/addon-registry.service'
import type { IScopedLogger, IAddonWidgetsSourceProvider } from '@camstack/types'

/**
 * Strip the `@<nodeId>` suffix the CapabilityBridge appends to
 * collection-provider registry keys for cross-node addons. The widget
 * static-file route always receives the bare manifest id.
 */
function stripNodeSuffix(registryKey: string): string {
  const at = registryKey.indexOf('@')
  return at === -1 ? registryKey : registryKey.slice(0, at)
}

/** A content-version namespace segment: `v<hex>` (the aggregator's dir hash). */
const VERSION_SEGMENT_RE = /^v[0-9a-f]{6,}$/

/**
 * Strip the optional leading content-version segment (`v<hash>/`) from a
 * requested bundle path. The version is a cache-busting NAMESPACE only — the
 * real file lives at `distDir/<rest>`; MF relative imports resolve against the
 * versioned URL, so `v<hash>/_stub.js` must resolve to `_stub.js`. Returns
 * `{ filePath, versioned }` — `versioned` lets the route serve content-
 * addressed files as `immutable`. Pure + exported for the spec.
 */
export function stripBundleVersionSegment(rawPath: string): {
  readonly filePath: string
  readonly versioned: boolean
} {
  const slash = rawPath.indexOf('/')
  if (slash > 0 && VERSION_SEGMENT_RE.test(rawPath.slice(0, slash))) {
    return { filePath: rawPath.slice(slash + 1), versioned: true }
  }
  return { filePath: rawPath, versioned: false }
}

/**
 * AddonWidgetsService — server-side helper that backs the static file
 * route `/api/addon-widgets/:addonId/*` (registered in `main.ts`).
 *
 * Mirrors `AddonPagesService` exactly. The public listing surface
 * (`addonWidgets.listWidgets` on the AppRouter) lives in the
 * `addon-widgets-aggregator` builtin which walks every
 * `addon-widgets-source` collection provider and stamps versioned
 * `bundleUrl`s. Both ends flow through codegen.
 *
 * What stays here: filesystem path resolution + traversal protection
 * for the static file route. The registered-provider check uses
 * `CapabilityService` (so unknown / unregistered addons can't be
 * probed via path traversal tricks); the on-disk path comes from
 * `AddonRegistryService.getAddonInstallPath()` so bundled addons
 * (where one npm package ships multiple addon entries under
 * `dist/<entryId>/`) resolve to the right sub-folder instead of the
 * pre-bundle `addons/@camstack/addon-<id>/dist/` layout.
 */
export class AddonWidgetsService {
  private readonly logger: IScopedLogger

  constructor(
    private readonly loggingService: LoggingService,
    private readonly caps: CapabilityService,
    private readonly registry: AddonRegistryService,
  ) {
    this.logger = this.loggingService.createLogger('AddonWidgetsService')
  }

  /**
   * Resolve the filesystem path to an addon's widget bundle file.
   * Returns null if the addon is not registered, the file doesn't exist,
   * or the path would escape the addon directory (path traversal protection).
   */
  resolveBundle(addonId: string, filePath: string): string | null {
    // The collection cap doesn't carry an `id` on its provider, so we
    // attribute via `getCollectionEntries` (returns `[addonId, provider]`).
    //
    // For cross-node addons the CapabilityBridge registers the provider
    // under a node-qualified key `<addonId>@<nodeId>` (see
    // `moleculer.service.ts`). The bundle is hub-resident and keyed by
    // the bare manifest id, so the route always carries the bare
    // `addonId` — match it against each registry key with the
    // `@<nodeId>` suffix stripped.
    const entries =
      this.caps.getCollectionEntries<IAddonWidgetsSourceProvider>('addon-widgets-source')
    const isRegistered = entries.some(([id]) => stripNodeSuffix(id) === addonId)
    if (!isRegistered) {
      this.logger.warn('Bundle resolve failed: addon not registered as widget provider', {
        tags: { addonId },
      })
      return null
    }

    const installPath = this.registry.getAddonInstallPath(addonId)
    if (!installPath) {
      this.logger.warn('Bundle resolve failed: addon install path not found', { tags: { addonId } })
      return null
    }

    // Drop the content-version namespace (`v<hash>/`) the aggregator stamps —
    // it exists only to atomically cache-bust the bundle on update.
    const { filePath: bareFilePath } = stripBundleVersionSegment(filePath)
    const resolvedBase = path.resolve(installPath.distDir)
    const resolvedFile = path.resolve(installPath.distDir, bareFilePath)

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
}
