/**
 * OSD Manager addon — the only place the `osd-manager` provider is wired
 * to the real cluster. Everything it needs is injected as a function, so
 * `OsdManager` itself has no tRPC surface in it and its tests need no fake
 * transport.
 */
import {
  addonPagesSourceCapability,
  BaseAddon,
  type AddonPageDeclaration,
  type ConfigUISchema,
  EventCategory,
  type IAddonPageProvider,
  OsdStatusSchema,
  osdManagerCapability,
  type ProviderRegistration,
} from '@camstack/types'
import { OsdBindingsStore } from './bindings-handle.js'
import {
  ABSENT_BOUND_INDEX,
  type BoundIndexHandle,
  OSD_BOUND_INDEX_KEY,
  OsdBoundIndexSchema,
} from './bound-index.js'
import { DEFAULT_TICK_MS, type OsdDeviceSummary, OsdManager } from './osd-manager.js'
import {
  EMPTY_TEMPLATES,
  OSD_TEMPLATES_KEY,
  OsdNamedTemplatesSchema,
  type TemplatesHandle,
} from './templates-store.js'

interface OsdManagerConfig {
  /** Seconds between render passes over the bound cameras. */
  readonly tickSeconds: number
}

const DEFAULTS: OsdManagerConfig = {
  tickSeconds: DEFAULT_TICK_MS / 1000,
}

export class OsdManagerAddon extends BaseAddon<OsdManagerConfig> {
  readonly id = 'osd-manager'

  private manager: OsdManager | null = null

  /**
   * Module-Federation page declaration surfaced via the `addon-pages-source`
   * collection cap. Mirrors the manifest `pages[]` entry — admin-ui's
   * `<AddonPageLoader>` loads `addon_osd_manager_page/page` from
   * `/api/addon-pages/osd-manager/remoteEntry.js`. Modeled directly on
   * `addon-benchmark` / `addon-model-studio` (former roadmap item 4d).
   */
  readonly pages: readonly AddonPageDeclaration[] = [
    {
      id: 'osd-manager',
      label: 'OSD Manager',
      icon: 'monitor',
      path: '/addon/osd-manager',
      remoteName: 'addon_osd_manager_page',
      bundle: 'remoteEntry.js',
      section: 'detection',
    },
  ] as const

  constructor() {
    // A BaseAddon without `super({})` dies at init while still reporting
    // "running". Never remove this.
    super({ ...DEFAULTS })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const ctx = this.ctx
    const store = new OsdBindingsStore((deviceId, key, schema, fallback) =>
      this.deviceState(deviceId, key, schema, fallback),
    )
    // The durable work list. `BaseAddon.state` is the addon's own store — the
    // same mechanism the bindings themselves use, one level up (per-addon rather
    // than per-device).
    const boundIndex: BoundIndexHandle = this.state(
      OSD_BOUND_INDEX_KEY,
      OsdBoundIndexSchema,
      ABSENT_BOUND_INDEX,
    )
    const templates: TemplatesHandle = this.state(
      OSD_TEMPLATES_KEY,
      OsdNamedTemplatesSchema,
      EMPTY_TEMPLATES,
    )

    const manager = new OsdManager({
      logger: ctx.logger,
      readOsdStatus: async (deviceId) => {
        try {
          // The generated `getStatus` is auto-injected from the cap's
          // `status` block and typed `unknown` on the addon API, so this is
          // a real system boundary — validate rather than assert.
          const raw = await ctx.api.osd.getStatus.query({ deviceId })
          const parsed = OsdStatusSchema.safeParse(raw)
          if (!parsed.success) {
            ctx.logger.warn('osd-manager: osd.getStatus returned an unexpected shape', {
              tags: { deviceId },
              meta: { error: parsed.error.message },
            })
            return null
          }
          return parsed.data
        } catch (err) {
          // A camera with no `osd` cap answers with a routing error, not an
          // empty status. That is "unsupported", not a failure — but it is
          // still logged, because so is a camera that is merely offline.
          ctx.logger.debug('osd-manager: osd.getStatus unavailable', {
            tags: { deviceId },
            meta: { error: String(err) },
          })
          return null
        }
      },
      writeOverlay: async (deviceId, overlayId, patch) => {
        await ctx.api.osd.setOverlay.mutate({ deviceId, overlayId, patch })
      },
      readDeviceSnapshot: (deviceId) => ctx.api.deviceState.getSnapshot.query({ deviceId }),
      listDevices: async (): Promise<readonly OsdDeviceSummary[]> => {
        const devices = await ctx.api.deviceManager.listAll.query({ projection: 'slim' })
        return devices.map((d) => ({ id: d.id, name: d.name, type: d.type ?? null }))
      },
      // Filtered SERVER-SIDE. Only a camera can carry an overlay, so the
      // reconcile has no business reading the other 946 rows of a 976-device
      // directory — and `listAll` already answers this question
      // (`isCamera: true`), so shipping every row to `.filter()` here would be
      // the same defect one layer down.
      listCameras: async (): Promise<readonly OsdDeviceSummary[]> => {
        const cameras = await ctx.api.deviceManager.listAll.query({
          isCamera: true,
          projection: 'slim',
        })
        return cameras.map((d) => ({ id: d.id, name: d.name }))
      },
      // ONE cap call for the whole set. `getBindings` per device is the same
      // resolver run N times over N round trips — measured on the live hub
      // 2026-08-25 at 1 211 ms for seventy-five; the source catalog asks about
      // every device there is, so on 2026-08-30 that was 1 019 of them behind
      // one operator click. `getBindingsBatch` dedupes ids and keeps a row for
      // a device with nothing bound, so the catalog sees exactly the devices it
      // asked about.
      listDeviceCapsBatch: async (deviceIds) => {
        const rows = await ctx.api.deviceManager.getBindingsBatch.query({
          deviceIds: [...deviceIds],
        })
        return new Map(
          rows.map((row) => [row.deviceId, [...new Set(row.entries.map((e) => e.capName))]]),
        )
      },
      readLatestRecognitions: async (deviceId) => {
        const [faces, plates] = await Promise.all([
          ctx.api.faceGallery.listRecentFaces.query({
            deviceId,
            limit: 1,
            filter: 'identified',
            includeCrops: false,
          }),
          ctx.api.plateGallery.listPlates.query({ deviceId, limit: 1 }),
        ])
        const face = faces[0]
        const plate = plates[0]
        return {
          ...(face?.identityName !== undefined
            ? { person: { text: face.identityName, atMs: face.timestamp } }
            : {}),
          ...(plate !== undefined ? { plate: { text: plate.text, atMs: plate.timestamp } } : {}),
        }
      },
      bindings: (deviceId) => store.forDevice(deviceId),
      boundIndex: boundIndex,
      templates,
    })

    this.manager = manager
    this.subscribe({ category: EventCategory.PipelineAnalyticsTrackLifecycle }, (event) => {
      manager.onTrackLifecycle(event.data)
    })
    this.subscribe({ category: EventCategory.PipelineAnalyticsFaceGalleryChanged }, (event) => {
      manager.onRecognitionGalleryChanged(event.data.deviceId)
    })
    this.subscribe({ category: EventCategory.PipelineAnalyticsPlateGalleryChanged }, (event) => {
      manager.onRecognitionGalleryChanged(event.data.deviceId)
    })
    // ARMED, never awaited. `initialize()` is on the critical path of the whole
    // capability graph — the runner publishes this addon's manifest only after
    // it returns — and awaiting `start()` is what left `osd-manager` and
    // `addon-pages-source` absent cluster-wide for 546 s on 2026-08-19
    // (docs/architecture/addon-lifecycle.md).
    void manager.start(Math.max(1, this.config.tickSeconds) * 1000).catch((err: unknown) => {
      ctx.logger.error('osd-manager: render loop failed to start — no camera will be re-rendered', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    const pagesProvider: IAddonPageProvider = {
      id: this.id,
      listPages: () => this.pages,
    }

    return [
      { capability: osdManagerCapability, provider: manager },
      { capability: addonPagesSourceCapability, provider: pagesProvider },
    ]
  }

  protected async onConfigChanged(): Promise<void> {
    const manager = this.manager
    if (manager === null) return
    manager.stop()
    // Awaited here, unlike at boot: this is an operator save, not the
    // capability graph's critical path, and `start()` now costs one store read
    // before it returns — the fleet scan it arms is background work.
    await manager.start(Math.max(1, this.config.tickSeconds) * 1000)
  }

  protected async onShutdown(): Promise<void> {
    this.manager?.stop()
    this.manager = null
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'osd-manager',
          title: 'OSD Manager',
          description:
            'Drives the text cameras burn into their own video. Slot bindings are configured per camera; this page only sets how often bound cameras are re-rendered. A slot is written only when its text changes, so a short interval costs nothing while values are steady.',
          columns: 2,
          fields: [
            this.field({
              type: 'number',
              key: 'tickSeconds',
              label: 'Render interval (seconds)',
              description:
                'How often every bound camera is re-rendered. Lower means a fresher clock and a faster reaction to a state change.',
              min: 1,
              max: 300,
              step: 1,
              default: DEFAULTS.tickSeconds,
            }),
          ],
        },
      ],
    })
  }
}
