/**
 * Event-media storage root. Moved out of `pipeline-analytics/index.ts`
 * verbatim (Plan B, boot extraction): only the visibility of the entry point
 * changed. Every dependency is read through the deps object.
 */

import path from 'node:path'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { ARTIFACTS_MEDIA_LOCATION } from '../../notification-center/artifact-store.js'
import type {
  LocationAwareMediaBlobStorage,
  MediaBlobStorage,
} from '../location-aware-media-storage.js'
import { createLocationAwareMediaStorage } from '../location-aware-media-storage.js'
import { RETRAIN_MEDIA_LOCATION } from '../retrain/retrain-frame-store.js'
import {
  GALLERY_MEDIA_LOCATION,
  GALLERY_TENANT_SUBPATH,
  LEGACY_ADDON_DATA_GALLERY_LOCATION,
} from '../store/media-store.js'

export interface ResolveMediaStorageDeps {
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly mediaLocationStorage: () => LocationAwareMediaBlobStorage | null
  readonly setMediaLocationStorage: (value: LocationAwareMediaBlobStorage | null) => void
}

export class ResolveMediaStorage {
  constructor(protected readonly deps: ResolveMediaStorageDeps) {}

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get mediaLocationStorage(): LocationAwareMediaBlobStorage | null {
    return this.deps.mediaLocationStorage()
  }

  protected set mediaLocationStorage(value: LocationAwareMediaBlobStorage | null) {
    this.deps.setMediaLocationStorage(value)
  }

  /** Event-media storage. By default it uses `ctx.kernel.storage`, rooted at
   *  the node data dir (appData) → heavy thumbnail/track-frame churn hammers
   *  the appData/cache disk. When `CAMSTACK_MEDIA_ROOT` is set (the dedicated
   *  media share), root a FilesystemStorageProvider there instead, so event
   *  media is written to (and read back from — one provider, both sides) the
   *  share and never touches appData. See also the recorder's rec-tmp root. */
  async resolveMediaStorage(logger: IScopedLogger): Promise<LocationAwareMediaBlobStorage> {
    let storage: MediaBlobStorage | undefined = this.ctx.kernel.storage
    const mediaRoot = process.env.CAMSTACK_MEDIA_ROOT?.trim()
    if (mediaRoot) {
      const { FilesystemStorageProvider } = await import('@camstack/types/node')
      // `eventMedia` resolves to the media root ITSELF (not `<root>/eventMedia`):
      // media paths are `<deviceId>/events/…`, rooted per camera next to the
      // recorder's segment trees (2026-07-29 layout unification).
      storage = new FilesystemStorageProvider(mediaRoot, {
        eventMedia: mediaRoot,
      })
      logger.info('pipeline-analytics: event media rooted at CAMSTACK_MEDIA_ROOT', {
        meta: { mediaRoot },
      })
    }
    if (!storage) throw new Error('pipeline-analytics requires ctx.kernel.storage')
    // Phase 3: rows may carry a locationId once the relocate mover exists —
    // route those through the storage cap's resolved roots (direct fs I/O),
    // default location stays on the bypass provider above.
    // The enrolled gallery is the THIRD TENANT of the shared `artifacts`
    // class (D341): rows keep their PERMANENT `locationId: 'galleryMedia'`
    // and the ref is mapped here to the tenant subtree
    // (`<artifactsRoot>/gallery/…`). Never restamped — remapping the ref
    // instead of rewriting 300+ rows is what makes a boot that counts every
    // enrolled sample `missing` (and lets stage 2 delete it) unrepresentable.
    const routed = createLocationAwareMediaStorage({
      base: storage,
      defaultLocation: 'eventMedia',
      resolveRoot: (locationId) =>
        // Legacy alias, read-side: rows stamped while the gallery lived in the
        // addon data dir (2026-08-31 → 2026-09-04) name a location type no
        // orchestrator knows. They resolve to that dir until the boot
        // reconcile has moved them onto `galleryMedia` — see
        // LEGACY_ADDON_DATA_GALLERY_LOCATION for the removal condition.
        locationId === LEGACY_ADDON_DATA_GALLERY_LOCATION
          ? Promise.resolve(path.join(this.ctx.dataDir, 'gallery'))
          : locationId === GALLERY_MEDIA_LOCATION
            ? this.ctx.api.storage.resolve.query({
                location: ARTIFACTS_MEDIA_LOCATION,
                relativePath: GALLERY_TENANT_SUBPATH,
              })
            : // The retrain dataset is the artifacts class's fourth tenant
              // (D781). Its rows' relative paths already carry the top-level
              // `retrain/` subtree, so the ref maps onto the class ROOT.
              locationId === RETRAIN_MEDIA_LOCATION
              ? this.ctx.api.storage.resolve.query({
                  location: ARTIFACTS_MEDIA_LOCATION,
                  relativePath: '',
                })
              : this.ctx.api.storage.resolve.query({
                  location: locationId,
                  relativePath: '',
                }),
    })
    this.mediaLocationStorage = routed
    return routed
  }
}
