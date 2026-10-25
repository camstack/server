import type {
  ProviderRegistration,
  IMotionDetectionProvider,
  MotionAnalysisResult,
  FrameHandle,
  FrameInput,
  DetectorOutput,
  SpatialDetection,
} from '@camstack/types'
import type { DeviceProxy } from '@camstack/types'
import { BaseAddon, DeviceType, hydrateSchema, motionDetectionCapability } from '@camstack/types'
import type { ConfigUISchemaWithValues, ConfigUISchema } from '@camstack/types'
import {
  WasmMotionDetector,
  DEFAULT_CONFIG,
  type WasmMotionConfig,
} from '../wasm-motion-detector.js'
import { gateMotionRegions } from '../zone-gate.js'
import { getSharp } from '../../shared/lazy-sharp.js'

/**
 * Motion detection addon using WebAssembly.
 *
 * Drop-in replacement for addon-motion-detection. Same IMotionDetector interface,
 * but uses WASM blur+diff+dilate+CCL instead of JS pixel loop.
 *
 * Produces bounding box regions (not just changed pixel count).
 * ~3ms/frame at 640×360 with full pipeline.
 *
 * Settings redesign Phase 3: motion-wasm has ONLY device-level settings
 * (all four fields were `scope: 'device'` in the legacy schema — every
 * camera tunes threshold/subject size/blurRadius/dilateRadius independently
 * for its scene). So the addon implements `getDeviceSettings` /
 * `updateDeviceSettings` and nothing else. Fresh cameras with no
 * overrides get the schema defaults via `hydrateSchema()` at read time.
 * There is no cluster-wide "default threshold" knob — if operators want
 * to change the baseline, they edit the schema defaults in code.
 */
export default class MotionWasmAddon extends BaseAddon implements IMotionDetectionProvider {
  private detector: WasmMotionDetector | null = null

  private readonly cameras = new Map<
    string,
    {
      prevGray: Uint8Array | null
      width: number
      height: number
    }
  >()

  private readonly deviceConfigCache = new Map<
    string,
    { config: WasmMotionConfig; fetchedAt: number }
  >()
  private static readonly DEVICE_CONFIG_TTL_MS = 60_000

  /**
   * Last logged "which rule is this camera on" signature, per camera. The
   * operator's gesture for D394 is a settings write, and a settings write is
   * invisible: this is how they confirm it took, on the next analysed frame.
   * Keyed and logged only on CHANGE, so it costs one line per camera per
   * change rather than one per TTL expiry.
   */
  private readonly loggedRule = new Map<string, string>()

  /**
   * Per-device {@link DeviceProxy} used for zone gating. Built lazily
   * on first analyze() for a device; the proxy's reactive state
   * handles (`state.zones`, `state.zoneRules`) keep their `.value`
   * fresh via the kernel's runtime-state mirror, so the gate reads
   * are sync and free of bus plumbing inside this addon.
   */
  private readonly proxies = new Map<number, DeviceProxy>()
  /** Unsubscribe pins kept so the slice handles stay subscribed for
   *  the camera's lifetime — `.value` only flows through the cache
   *  when at least one watcher is active. */
  private readonly proxyUnsubs = new Map<number, ReadonlyArray<() => void>>()

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.detector = new WasmMotionDetector()
    await this.detector.load()
    this.ctx.logger.info('WASM motion detector loaded')

    // Register as motion-detection wrapper with defaultActive so every
    // camera picks it up automatically via device-manager.getBindings.
    // Operators disable per-device via device-manager.setWrapperActive.
    return [
      {
        capability: motionDetectionCapability,
        provider: this,
      },
    ]
  }

  // Sentinel key used by the pipeline-step `process()` path, which owns a
  // dedicated per-addon instance (one per camera via AddonEngineManager)
  // and therefore does not need a real deviceId.
  private static readonly PIPELINE_STEP_KEY = '__pipeline__'

  /**
   * Pipeline step interface — called by PipelineRunner.
   * Uses single-camera state (one instance per camera via AddonEngineManager).
   */
  async process(
    input: FrameInput,
  ): Promise<DetectorOutput & { rawDetections: ReadonlyArray<SpatialDetection> }> {
    const start = performance.now()
    const result = await this.analyzeInternal(MotionWasmAddon.PIPELINE_STEP_KEY, input)

    const toSpatial = (r: {
      bbox: { x: number; y: number; w: number; h: number }
      intensity: number
    }): SpatialDetection => ({
      class: 'motion',
      originalClass: 'motion',
      score: Math.min(1, r.intensity / 128),
      bbox: r.bbox,
    })

    const detections = result.regions.map(toSpatial)
    const rawDetections = result.rawRegions.map(toSpatial)

    return {
      detections,
      rawDetections,
      inferenceMs: performance.now() - start,
      modelId: 'wasm-motion',
    }
  }

  /**
   * motion-detection cap: analyze a frame, return regions + stats.
   * Per-device state keyed by the numeric deviceId (stringified internally
   * so the pipeline-step sentinel shares the same Map).
   *
   * Pixels arrive inline (`frame`). The `frameHandle` input is DORMANT since
   * the shm-ring removal (2026-07-16): the runner always ships inline gray
   * pixels now. A handle can only arrive under version skew (an old runner
   * against a new provider); with no shm passthrough there is no way to
   * resolve its pixels, so it degrades to an empty result. The field stays
   * defined so no cap-surface change is needed.
   */
  async analyze({
    deviceId,
    frame,
    frameHandle,
  }: {
    deviceId: number
    frame?: FrameInput
    frameHandle?: FrameHandle
  }): Promise<MotionAnalysisResult> {
    if (!frame) return this.emptyMotionResult(frameHandle)
    return this.analyzeInternal(String(deviceId), frame)
  }

  /** Zeroed motion result for a missed `frameHandle` read (dropped frame). */
  private emptyMotionResult(handle: FrameHandle | undefined): MotionAnalysisResult {
    return {
      detected: false,
      regionCount: 0,
      regions: [],
      rawRegions: [],
      frameWidth: handle?.width ?? 0,
      frameHeight: handle?.height ?? 0,
      analysisMs: 0,
    }
  }

  private async analyzeInternal(
    cameraId: string,
    frame: FrameInput,
  ): Promise<MotionAnalysisResult> {
    if (!this.detector) {
      return {
        detected: false,
        regionCount: 0,
        regions: [],
        rawRegions: [],
        frameWidth: 0,
        frameHeight: 0,
        analysisMs: 0,
      }
    }

    const start = performance.now()

    // The frame data is expected to be grayscale when coming from NodeAvDecoderSession.
    // If JPEG (from old decoder), convert via sharp.
    let gray: Uint8Array
    let width: number
    let height: number

    if (frame.format === 'jpeg') {
      // Fallback: decode JPEG to grayscale
      const sharp = await getSharp()
      const { data, info } = await sharp(Buffer.from(frame.data))
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      width = info.width
      height = info.height
    } else {
      // Already raw grayscale (from node-av decoder)
      gray = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data)
      width = frame.width
      height = frame.height
    }

    // Get or create per-camera state
    let state = this.cameras.get(cameraId)
    if (!state || state.width !== width || state.height !== height) {
      // First frame or resolution change — init WASM for these dimensions
      this.detector.init(width, height)
      this.cameras.set(cameraId, { prevGray: gray, width, height })
      return {
        detected: false,
        regionCount: 0,
        regions: [],
        rawRegions: [],
        frameWidth: width,
        frameHeight: height,
        analysisMs: performance.now() - start,
      }
    }

    state = this.cameras.get(cameraId)!

    // Resolve per-device config (cached, TTL-based)
    const deviceCfg = await this.getDeviceConfig(cameraId)

    // The detector is shared by every camera on this node — make sure the
    // WASM (and the relative bar's denominator) is sized for THIS view.
    this.detector.ensureSize(width, height)

    // Detect motion — raw CCL components, and the merged subjects that
    // cleared the area bar (D394).
    const { raw, filtered, suppressedByCoverage } = this.detector.detect(
      state.prevGray!,
      gray,
      deviceCfg,
    )
    if (suppressedByCoverage > 0) {
      // A branch that drops work says so. Without this line a camera silenced
      // by weather is indistinguishable from a camera nobody walks past.
      this.ctx.logger.info('motion storm suppressed', {
        tags: { deviceId: Number(cameraId) },
        meta: {
          groups: suppressedByCoverage,
          maxCoverageFraction: deviceCfg.maxCoverageFraction,
          view: `${width}x${height}`,
        },
      })
    }
    state.prevGray = Buffer.from(gray) // save for next frame

    const toRegion = (r: { x: number; y: number; w: number; h: number; pixels: number }) => ({
      bbox: { x: r.x, y: r.y, w: r.w, h: r.h },
      pixelCount: r.pixels,
      intensity: Math.min(255, Math.round((r.pixels / (r.w * r.h)) * 255)),
    })

    let regions = filtered.map(toRegion)
    const rawRegions = raw.map(toRegion)

    // Apply zone-rule gating when running with a numeric deviceId.
    // The pipeline-step path uses a sentinel cameraId — `Number()`
    // returns NaN, so the lookup misses and gating is skipped, which
    // matches "no per-device context, no zones" semantics.
    const numericDeviceId = Number(cameraId)
    if (Number.isFinite(numericDeviceId)) {
      const proxy = await this.ensureProxy(numericDeviceId)
      if (proxy) {
        const zones = proxy.state.zones.value?.zones ?? []
        const rules = proxy.state.zoneRules.value?.motion ?? []
        if (rules.length > 0 && zones.length > 0) {
          const gated = gateMotionRegions(regions, zones, rules, width, height)
          regions = [...gated.passed]
        }
      }
    }

    return {
      detected: regions.length > 0,
      regionCount: regions.length,
      regions,
      rawRegions,
      frameWidth: width,
      frameHeight: height,
      analysisMs: performance.now() - start,
    }
  }

  /**
   * Resolve (and cache) a {@link DeviceProxy} for the given device.
   * Pins the `state.zones` + `state.zoneRules` slice handles so the
   * kernel runtime-state mirror keeps `.value` warm — subsequent
   * analyze() calls read both slices synchronously without any bus
   * plumbing or per-frame cap query. Returns null on first-call
   * failure (logged) so motion analysis never blocks on zone
   * resolution.
   */
  private async ensureProxy(deviceId: number): Promise<DeviceProxy | null> {
    const cached = this.proxies.get(deviceId)
    if (cached) return cached
    try {
      const proxy = await this.ctx.fetchDevice(deviceId)
      this.proxies.set(deviceId, proxy)
      const unsubs = [
        proxy.state.zones.subscribe(() => {
          /* keep slice warm */
        }),
        proxy.state.zoneRules.subscribe(() => {
          /* keep slice warm */
        }),
      ]
      this.proxyUnsubs.set(deviceId, unsubs)
      return proxy
    } catch (err: unknown) {
      this.ctx.logger.debug('ensureProxy failed — gating skipped', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  /** Drop the proxy + slice subscriptions for a device. */
  private releaseProxy(deviceId: number): void {
    const unsubs = this.proxyUnsubs.get(deviceId)
    if (unsubs) {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* swallow */
        }
      }
    }
    this.proxyUnsubs.delete(deviceId)
    this.proxies.delete(deviceId)
  }

  /**
   * Resolve the effective per-device config for a camera. Reads the raw
   * device store and overlays it on top of the schema defaults via
   * `hydrateSchema()`, then narrows to the typed `WasmMotionConfig` shape.
   * Cached with a TTL to avoid hammering the settings store on every frame.
   */
  private async getDeviceConfig(cameraId: string): Promise<WasmMotionConfig> {
    const now = Date.now()
    const cached = this.deviceConfigCache.get(cameraId)
    if (cached && now - cached.fetchedAt < MotionWasmAddon.DEVICE_CONFIG_TTL_MS) {
      return cached.config
    }
    if (!this.ctx?.settings) return DEFAULT_CONFIG

    // cameraId in this addon is the stringified numeric device id —
    // convert once at the settings-store boundary.
    const raw = await this.ctx.settings.readDeviceStore(Number(cameraId))
    const hydrated = hydrateSchema(this.deviceSettingsSchema()!, raw)
    // Flatten hydrated fields into a key→value map.
    const flat: Record<string, unknown> = {}
    for (const section of hydrated.sections) {
      for (const field of section.fields) {
        if (field.type === 'separator' || field.type === 'info' || field.type === 'button') continue
        if (field.type === 'group') continue
        flat[field.key] = (field as { readonly value: unknown }).value
      }
    }
    const resolved: WasmMotionConfig = {
      threshold:
        typeof flat['threshold'] === 'number' ? flat['threshold'] : DEFAULT_CONFIG.threshold,
      blurRadius:
        typeof flat['blurRadius'] === 'number' ? flat['blurRadius'] : DEFAULT_CONFIG.blurRadius,
      dilateRadius:
        typeof flat['dilateRadius'] === 'number'
          ? flat['dilateRadius']
          : DEFAULT_CONFIG.dilateRadius,
      minArea: typeof flat['minArea'] === 'number' ? flat['minArea'] : DEFAULT_CONFIG.minArea,
      minAreaFraction:
        typeof flat['minAreaFraction'] === 'number'
          ? flat['minAreaFraction']
          : DEFAULT_CONFIG.minAreaFraction,
      mergeRadiusDivisor:
        typeof flat['mergeRadiusDivisor'] === 'number'
          ? flat['mergeRadiusDivisor']
          : DEFAULT_CONFIG.mergeRadiusDivisor,
      maxCoverageFraction:
        typeof flat['maxCoverageFraction'] === 'number'
          ? flat['maxCoverageFraction']
          : DEFAULT_CONFIG.maxCoverageFraction,
    }
    this.deviceConfigCache.set(cameraId, { config: resolved, fetchedAt: now })

    const rule = resolved.minArea > 0 ? 'legacy-per-region' : 'merged-relative'
    const signature =
      rule === 'legacy-per-region'
        ? `${rule}:${resolved.minArea}`
        : `${rule}:${resolved.minAreaFraction}:${resolved.maxCoverageFraction}`
    if (this.loggedRule.get(cameraId) !== signature) {
      this.loggedRule.set(cameraId, signature)
      this.ctx.logger.info('motion area rule resolved', {
        tags: { deviceId: Number(cameraId) },
        meta: {
          rule,
          minArea: resolved.minArea,
          minAreaFraction: resolved.minAreaFraction,
          maxCoverageFraction: resolved.maxCoverageFraction,
        },
      })
    }
    return resolved
  }

  async removeCamera({ deviceId }: { deviceId: number }): Promise<void> {
    const key = String(deviceId)
    this.cameras.delete(key)
    this.deviceConfigCache.delete(key)
    this.loggedRule.delete(key)
    this.releaseProxy(deviceId)
  }

  async reset(): Promise<void> {
    this.cameras.clear()
    this.deviceConfigCache.clear()
    this.loggedRule.clear()
    for (const id of this.proxies.keys()) this.releaseProxy(id)
  }

  protected async onShutdown(): Promise<void> {
    this.cameras.clear()
    this.deviceConfigCache.clear()
    this.loggedRule.clear()
    for (const id of this.proxies.keys()) this.releaseProxy(id)
    this.detector = null
  }

  // ── Standard ICamstackAddon — three-level settings API (Phase 3) ─────
  //
  // motion-wasm is a pure per-device addon: every parameter is tuned on
  // a per-camera basis. It implements only `getDeviceSettings` /
  // `updateDeviceSettings`. No addon-level, no node-global.

  protected deviceSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'motion-wasm-settings',
          title: '',
          tab: 'motion',
          order: 10,
          columns: 2,
          fields: [
            // Every motion-wasm knob is an analyzer-side tuning param —
            // when the operator picks `onboard`-only on the orchestrator's
            // motionSources field, the wasm analyzer doesn't run, so
            // exposing the threshold/area/blur/dilate fields would be
            // misleading. Gate on the same key the orchestrator reads
            // (`motionSources`) so all four hide together.
            {
              type: 'slider',
              key: 'threshold',
              label: 'Threshold',
              description:
                'Pixel intensity difference to count as changed (higher = less sensitive)',
              min: 1,
              max: 255,
              step: 1,
              default: DEFAULT_CONFIG.threshold,
              showValue: true,
              showWhen: { field: 'motionSources', includes: 'analyzer' },
            },
            {
              type: 'slider',
              key: 'minAreaFraction',
              label: 'Min Subject Size',
              description:
                'Smallest subject that triggers motion, as a share of the analysed view. ' +
                'Fragments of one subject are merged before this is applied, so a partly ' +
                'hidden animal counts once at its full size. Only in effect when Min Area ' +
                'is 0.',
              min: 0.001,
              max: 0.05,
              step: 0.0005,
              default: DEFAULT_CONFIG.minAreaFraction,
              showValue: true,
              showWhen: { field: 'motionSources', includes: 'analyzer' },
            },
            {
              type: 'number',
              key: 'minArea',
              label: 'Min Area',
              description:
                'Absolute pixel bar, applied to each motion region on its own. This is ' +
                'how motion has always worked, and it stays the default. Set it to 0 to ' +
                'move THIS camera to Min Subject Size, which merges the fragments of one ' +
                'subject before measuring it and keeps its meaning at any resolution — ' +
                'expect more motion, so move one camera at a time.',
              min: 0,
              max: 50000,
              step: 100,
              default: DEFAULT_CONFIG.minArea,
              unit: 'px',
              showWhen: { field: 'motionSources', includes: 'analyzer' },
            },
            {
              type: 'slider',
              key: 'maxCoverageFraction',
              label: 'Storm Cutoff',
              description:
                'A merged region whose changed pixels cover more of the view than this is ' +
                'weather, an IR cut or an exposure step, not a subject, and does not fire ' +
                'motion. A real mover inside the storm still fires on its own region. ' +
                'Only in effect when Min Area is 0; 1 disables the cutoff.',
              min: 0.2,
              max: 1,
              step: 0.05,
              default: DEFAULT_CONFIG.maxCoverageFraction,
              showValue: true,
              showWhen: { field: 'motionSources', includes: 'analyzer' },
            },
            {
              type: 'slider',
              key: 'blurRadius',
              label: 'Blur Radius',
              description: 'Gaussian blur before diff (reduces noise)',
              min: 0,
              max: 10,
              step: 1,
              default: DEFAULT_CONFIG.blurRadius,
              showValue: true,
              showWhen: { field: 'motionSources', includes: 'analyzer' },
            },
            {
              type: 'slider',
              key: 'dilateRadius',
              label: 'Dilation Radius',
              description: 'Expand motion regions to merge nearby changes',
              min: 0,
              max: 10,
              step: 1,
              default: DEFAULT_CONFIG.dilateRadius,
              showValue: true,
              showWhen: { field: 'motionSources', includes: 'analyzer' },
            },
          ],
        },
      ],
    })
  }

  async getDeviceSettings(deviceId: number) {
    // Device-details aggregator pings every addon at page mount, which
    // may fire before this addon's `initialize()` resolves. Return an
    // empty-hydrated schema in that window — the UI retries on the next
    // settings round-trip once we're live.
    const ctx = this.ctxIfReady
    const raw = (await ctx?.settings?.readDeviceStore(deviceId)) ?? {}
    return hydrateSchema(this.deviceSettingsSchema()!, raw)
  }

  async updateDeviceSettings(deviceId: number, patch: Record<string, unknown>): Promise<void> {
    await this.ctx.settings?.writeDeviceStore(deviceId, patch)
    // Invalidate the cached per-device config so the next analyze() call
    // picks up the new values immediately — and re-logs the resolved rule,
    // which is how an operator sees that the write took.
    this.deviceConfigCache.delete(String(deviceId))
  }

  // ── Device-details aggregator contribution (motion-detection cap) ────────
  //
  // motion-wasm contributes its 4 tuning knobs (threshold, blurRadius,
  // dilateRadius, subject size) to the `detection` tab for every camera. Live
  // info is skipped — motion runtime stats are already streamed via the
  // pipeline-orchestrator live contribution.

  async getDeviceSettingsContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    // Camera-only — motion tuning is meaningless on Switches / Lights /
    // Sensors / Buttons (none of them produce video). Source-side gate
    // keeps the policy with the addon that owns the cap and avoids
    // ghost top-tabs in the device-detail UI.
    if (!(await this.isCameraDevice(input.deviceId))) return null
    const schema = this.deviceSettingsSchema()
    if (!schema) return null
    const raw = (await this.ctx?.settings?.readDeviceStore(input.deviceId)) ?? {}
    // Re-home the section into the `detection` tab so the aggregator merges
    // motion-wasm settings with orchestrator/pipeline contributions there.
    const withTab: ConfigUISchema = {
      ...schema,
      sections: schema.sections.map((s) => ({ ...s, tab: s.tab ?? 'detection' })),
    }
    return hydrateSchema(withTab, raw)
  }

  async getDeviceLiveContribution(_input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return null
  }

  async applyDeviceSettingsPatch(input: {
    deviceId: number
    patch: Record<string, unknown>
  }): Promise<{ success: true }> {
    await this.updateDeviceSettings(input.deviceId, input.patch)
    return { success: true as const }
  }

  /**
   * Best-effort camera-type check. Used by the settings/live contribution
   * methods to short-circuit on non-camera devices (Lights, Switches,
   * Sensors, Buttons). Returns `true` on lookup failure so a transient
   * device-manager hiccup never silently hides legitimate camera
   * sections.
   */
  private async isCameraDevice(deviceId: number): Promise<boolean> {
    const api = this.ctx?.api
    if (!api) return true
    try {
      const dev = await api.deviceManager.getDevice.query({ deviceId })
      if (!dev) return true
      return (dev as { type?: string }).type === DeviceType.Camera
    } catch {
      return true
    }
  }
}
