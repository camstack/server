import {
  errMsg,
  hydrateSchema,
  imageCapability,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  type DeviceContext,
  type ImageStatus,
  type InferNativeProvider,
} from '@camstack/types'
import {
  VacuumDevice as DreameVacuum,
  renderVacuumPng,
  type MapColorScheme,
  type RenderVacuumPngOptions,
  type VacuumMap,
} from '@apocaliss92/nodedreame'
import { DreameChildDevice } from './dreame-child-device.js'
import { deleteMapImage, getMapBaseUrl, setMapImage } from '../dreame-map-store.js'

const CAP_NAME = 'image'
const COLD: ImageStatus = { url: null, lastUpdated: null }

/** Default renderer style — flat (node-dreame's own schemes only). */
const DEFAULT_COLOR_SCHEME: MapColorScheme = 'flat'

const MAP_COLOR_SCHEMES: readonly MapColorScheme[] = ['flat', 'dark-neon', 'materico']

/**
 * Dreame cleaning-MAP child — a `DeviceType.Image` grouped UNDER the robot's
 * Container (NOT folded onto the Vacuum device, per the container directive). It
 * shares the vacuum's cloud device id + broker, narrows the facade handle to the
 * library {@link DreameVacuum}, and on each new map frame (the PATH push,
 * surfaced as `vacuum.mapFilename`) fetches + renders the map to a PNG, caches it
 * for the addon's `/map` data-plane route, and points the `image` cap's `url` at
 * that route with a cache-busting timestamp.
 *
 * The raw OSS blob is an ENCODED map (not a browser-renderable image), so the
 * rendered PNG (`renderVacuumPng`) is served through the addon data-plane rather
 * than handing the browser the OSS URL.
 */
export class DreameVacuumMapDevice extends DreameChildDevice {
  /** The last map filename rendered — guards against re-fetching unchanged frames. */
  #lastFilename: string | null = null
  /** Single-flight guard for the async fetch+render. */
  #inflight = false

  // Widens the base's `protected` constructor to public so `dreameMapChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Surface the LAST saved map without waiting for a fresh clean: seed the map
    // filename from the cloud shadow. This emits `stateChanged`, which the base
    // listener routes into `recomputeSlice()` → the first render. Best-effort —
    // an idle robot with no shadow map, or an expired OSS blob, just stays null.
    const vacuum = this.resolveVacuum()
    if (vacuum !== null) {
      vacuum.refreshSavedMapFilename().catch((err: unknown) => {
        this.ctx.logger.debug('dreame map: saved-map seed failed', {
          tags: { deviceId: this.id },
          meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
        })
      })
    }
  }

  /** Narrow the generic handle to the library's typed {@link DreameVacuum}, or null. */
  private resolveVacuum(): DreameVacuum | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameVacuum ? handle : null
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof imageCapability> = {
      getStatus: async () => this.runtimeState.getCapState<ImageStatus>(CAP_NAME) ?? COLD,
    }
    this.ctx.registerNativeCap(imageCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, COLD)
  }

  protected override recomputeSlice(): void {
    const vacuum = this.resolveVacuum()
    if (vacuum === null) return
    const filename = vacuum.mapFilename
    // Only (re)render when a NEW map frame has been advertised — the fetch is an
    // async OSS round-trip + decode, far too costly to run on every push.
    if (filename === null || filename === this.#lastFilename) return
    this.#lastFilename = filename
    void this.#refreshMapImage(vacuum)
  }

  /** Single-flight: fetch the latest map, render it, publish the PNG + the url. */
  async #refreshMapImage(vacuum: DreameVacuum): Promise<void> {
    if (this.#inflight) return
    this.#inflight = true
    try {
      // Streaming fetch: an I-frame re-seeds the merge base, a P-frame is folded
      // onto it so the live grid stays COMPLETE during a clean (a P-frame decoded
      // standalone is only byte-deltas). null = P-frame before any I-frame, or an
      // out-of-order/fresh-map reset — keep the last rendered image until the next
      // I-frame re-seeds.
      const map = await vacuum.fetchLatestMapStreaming()
      if (map === null) return
      this.#publishRender(map)
    } catch (err) {
      this.ctx.logger.warn('dreame map: fetch/render failed', {
        tags: { deviceId: this.id },
        meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
      })
    } finally {
      this.#inflight = false
    }
  }

  /** Render a map with the persisted style options + publish the PNG and `url`. */
  #publishRender(map: VacuumMap): void {
    const png = renderVacuumPng(map, this.#renderOpts())
    const ts = Date.now()
    setMapImage(this.dreameDeviceId, { bytes: png, contentType: 'image/png', ts })
    const base = getMapBaseUrl()
    const url =
      base !== null ? `${base}?did=${encodeURIComponent(this.dreameDeviceId)}&t=${ts}` : null
    this.runtimeState.setCapState(CAP_NAME, { url, lastUpdated: ts })
  }

  /** Build the renderer options from the persisted map-style config (lib defaults when unset). */
  #renderOpts(): RenderVacuumPngOptions {
    return {
      colorScheme: this.config.get('mapColorScheme') ?? DEFAULT_COLOR_SCHEME,
      showPath: this.config.get('mapShowPath') ?? true,
      showRobot: this.config.get('mapShowRobot') ?? true,
      showCharger: this.config.get('mapShowCharger') ?? true,
      showNoGo: this.config.get('mapShowNoGo') ?? true,
      showVirtualWalls: this.config.get('mapShowVirtualWalls') ?? true,
      showObstacles: this.config.get('mapShowObstacles') ?? true,
      showSegmentLabels: this.config.get('mapShowSegmentLabels') ?? false,
      showSegmentNames: this.config.get('mapShowSegmentNames') ?? true,
      colorObstaclesByType: this.config.get('mapColorObstaclesByType') ?? true,
      showFurniture: this.config.get('mapShowFurniture') ?? true,
      showCleanedArea: this.config.get('mapShowCleanedArea') ?? false,
    }
  }

  /**
   * Editable map-style form on the map child — colour scheme + per-feature
   * toggles, mirroring the HA integration's map customization. Persisted in the
   * device config and folded into {@link renderVacuumPng} on every render.
   */
  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'map-style',
          title: 'Map Style',
          titleKey: 'provider-dreame:schema.s_map-style.title',
          columns: 2,
          fields: [
            {
              type: 'select',
              key: 'mapColorScheme',
              label: 'Colour scheme',
              labelKey: 'provider-dreame:schema.s_map-style.mapColorScheme.label',
              default: DEFAULT_COLOR_SCHEME,
              options: MAP_COLOR_SCHEMES.map((s) => ({ value: s, label: colorSchemeLabel(s) })),
            },
            {
              type: 'boolean',
              key: 'mapShowPath',
              label: 'Cleaning path',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowPath.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowRobot',
              label: 'Robot',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowRobot.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowCharger',
              label: 'Charger',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowCharger.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowNoGo',
              label: 'No-go / no-mop zones',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowNoGo.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowVirtualWalls',
              label: 'Virtual walls',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowVirtualWalls.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowObstacles',
              label: 'Obstacles',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowObstacles.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowSegmentLabels',
              label: 'Room id labels',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowSegmentLabels.label',
              default: false,
            },
            {
              type: 'boolean',
              key: 'mapShowSegmentNames',
              label: 'Room names',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowSegmentNames.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapColorObstaclesByType',
              label: 'Colour obstacles by type',
              labelKey: 'provider-dreame:schema.s_map-style.mapColorObstaclesByType.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowFurniture',
              label: 'Furniture zones',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowFurniture.label',
              default: true,
            },
            {
              type: 'boolean',
              key: 'mapShowCleanedArea',
              label: 'Cleaned-area tint',
              labelKey: 'provider-dreame:schema.s_map-style.mapShowCleanedArea.label',
              default: false,
            },
          ],
        },
      ],
    }
    const opts = this.#renderOpts()
    return hydrateSchema(schema, {
      mapColorScheme: opts.colorScheme,
      mapShowPath: opts.showPath,
      mapShowRobot: opts.showRobot,
      mapShowCharger: opts.showCharger,
      mapShowNoGo: opts.showNoGo,
      mapShowVirtualWalls: opts.showVirtualWalls,
      mapShowObstacles: opts.showObstacles,
      mapShowSegmentLabels: opts.showSegmentLabels,
      mapShowSegmentNames: opts.showSegmentNames,
      mapColorObstaclesByType: opts.colorObstaclesByType,
      mapShowFurniture: opts.showFurniture,
      mapShowCleanedArea: opts.showCleanedArea,
    })
  }

  /** Persist a map-style change and re-render the last map immediately. */
  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    await super.applySettingsPatch(patch)
    const map = this.resolveVacuum()?.lastMap ?? null
    if (map !== null) this.#publishRender(map)
  }

  override async removeDevice(): Promise<void> {
    await super.removeDevice()
    deleteMapImage(this.dreameDeviceId)
  }
}

/** Operator-friendly label for a {@link MapColorScheme} select option. */
function colorSchemeLabel(scheme: MapColorScheme): string {
  switch (scheme) {
    case 'flat':
      return 'Flat'
    case 'dark-neon':
      return 'Dark Neon'
    case 'materico':
      return 'Materico'
  }
}
