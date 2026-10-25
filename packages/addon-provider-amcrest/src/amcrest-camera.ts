import { userError } from '@camstack/types'
import type {
  CamStreamDescriptor,
  ClipSourceAvailability,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DayNightOptions,
  DayNightStatus,
  DeviceContext,
  ICameraDevice,
  ImageSettingsOptions,
  ImageSettingsStatus,
  InferNativeProvider,
  MotionZoneOptions,
  MotionZoneStatus,
  OsdOverlay,
  OsdStatus,
  PrivacyMaskOptions,
  PrivacyMaskRegion,
  PrivacyMaskShape,
  PrivacyMaskStatus,
  RecordingOnboardOptions,
  RecordingOnboardStatus,
  StreamParamsOptions,
  StreamParamsStatus,
  StreamProfile,
  StreamProfilePatch,
  StreamSourceEntry,
} from '@camstack/types'
import {
  BaseDevice,
  buildDeviceAdminUrl,
  buildStreamParamsConfigSchema,
  deviceAdminLinkCapability,
  createRuntimeStateBridge,
  DeviceFeature,
  DeviceType,
  dayNightCapability,
  hydrateSchema,
  imageSettingsCapability,
  motionCapability,
  hubMotionNativeProvider,
  motionZonesCapability,
  OPERATOR_WRITTEN_STALE_MS,
  osdCapability,
  privacyMaskCapability,
  providerMotionEvent,
  ptzCapability,
  type ReachabilityPollHandle,
  describeOnboardRefusal,
  recordingOnboardCapability,
  snapshotCapability,
  startReachabilityPoll,
  streamCatalogCapability,
  streamParamsCapability,
  summarisePrivacyAudio,
} from '@camstack/types'
import {
  AmcrestCgiClient,
  type AmcrestEvent,
  subscribeAmcrestEvents,
} from './amcrest-cgi-client.js'
import {
  amcrestBacklightToCap,
  amcrestDayNightModeToCap,
  amcrestExposureModeToCap,
  amcrestRotateToCap,
  capBacklightToAmcrest,
  capDayNightModeToAmcrest,
  capExposureModeToAmcrest,
  capRotateToAmcrest,
  clampDayNightDelaySec,
  DAY_NIGHT_DELAY_MAX_SEC,
  DAY_NIGHT_DELAY_MIN_SEC,
  dayNightSensitivityToPercent,
  percentToDayNightSensitivity,
} from './dahua-mappings.js'
import { availabilityFromStorage } from './clips/clip-availability.js'
import type { AmcrestClipCamera } from './clips/clip-service.js'
import {
  type AmcrestOnboardReads,
  type AmcrestRecordLimits,
  buildOnboardOptions,
  buildOnboardStatus,
  buildOnboardWrites,
  describeAmcrestScheduleRefusal,
  findLocalStorageGroup,
  parseOnboardStorage,
  parseRecordLimits,
  readPostRecordSec,
} from './recording-onboard-mapping.js'
import {
  AMCREST_EXTRAS_CONFIG_NAMES,
  buildExtrasSections,
  extrasPatchToCgiParams,
  parseExtrasSnapshot,
} from './extra-settings.js'
import { AMCREST_ADDON_ID, amcrestCameraSchema } from './schema.js'
import type { PtzHomePreset } from '@camstack/types'

/**
 * Amcrest/Dahua camera device — CGI control channel (snapshot, PTZ,
 * per-camera config) plus RTSP URLs handed to the stream-broker for
 * video pull. The broker owns the actual TCP/UDP RTSP session; this
 * class only ever hands out dialable `rtsp://` URLs and (for the
 * config caps) round-trips the Dahua CGI table format via
 * `AmcrestCgiClient`.
 *
 * v0.1 surface (this file):
 *   - `stream-catalog` → deterministic `cam/realmonitor` URLs (main/sub)
 *   - `snapshot` → `/cgi-bin/snapshot.cgi?channel=N`
 *   - `ptz` → `ptz.cgi` continuous-move + presets (this camera IS pan/tilt)
 *   - `stream-params` → `Encode` config (main/sub profiles)
 *   - `motion-zones` → `MotionDetect` grid (verified live: 22×18 cells)
 *   - `privacy-mask` → `PrivacyMasking` rects (verified live: 24 slots)
 *   - `osd` → `VideoWidget` overlays (timestamp/channel-name/4 custom texts)
 *   - `day-night` → `VideoInDayNight` (mode support conservative — see method doc)
 *   - `image-settings` → `VideoColor` (brightness/contrast/saturation only)
 *
 * All Dahua CGI table paths referenced in this file were confirmed
 * live against an IP4M-1041B (firmware per `getSystemInfo`, probed
 * 2026-07-08) — see `.superpowers/sdd/amcrest-addon-report.md`.
 */
export class AmcrestCamera extends BaseDevice<typeof amcrestCameraSchema> implements ICameraDevice {
  readonly type = DeviceType.Camera as const

  get features(): readonly DeviceFeature[] {
    const cache = this.config.get('deviceCache')
    const out: DeviceFeature[] = [DeviceFeature.NativeSnapshot, DeviceFeature.Rebootable]
    if (cache?.hasPtz === true) out.push(DeviceFeature.PanTiltZoom)
    return out
  }

  /** Lazy-built CGI client. Recreated on credential / host changes via
   *  `applySettingsPatch` (see `disconnectClient`). */
  private client: AmcrestCgiClient | null = null
  /** Active published streams keyed by `camStreamId` — mirrors the
   *  Hikvision provider's `published` map so the legacy
   *  `getStreamSources()` shim stays in sync with the last
   *  `stream-catalog` pull. */
  private readonly published = new Map<
    string,
    { camStreamId: string; label: string; rtspUrl: string }
  >()

  constructor(ctx: DeviceContext) {
    super(ctx, amcrestCameraSchema, { type: DeviceType.Camera })
    this.registerNativeCapabilities()
  }

  private registerNativeCapabilities(): void {
    this.registerStreamCatalogProvider()
    this.registerSnapshotCap()
    this.registerAdminLinkCap()
    // This camera model IS pan/tilt — register unconditionally (mirrors
    // the Hikvision provider's unconditional snapshot/reboot registration).
    this.registerPtzCap()
    this.registerStreamParamsCap()
    this.registerMotionZonesCap()
    this.registerMotionCap()
    this.registerPrivacyMaskCap()
    this.registerOsdCap()
    this.registerDayNightCap()
    this.registerImageSettingsCap()
    this.registerRecordingOnboardCap()
  }

  // ── Onboard-motion event stream state ──────────────────────────────
  /** Dahua CGI `eventManager` attach codes — VideoMotion is the base
   *  onboard-motion signal (Start/Stop). Smart sub-codes
   *  (SmartMotionHuman/Vehicle) are camera-AI detections handled by a
   *  separate cap and intentionally out of scope here. */
  private static readonly MOTION_EVENT_CODES = '[VideoMotion]'
  /** Re-emit interval (ms) for a sustained motion window. Dahua fires a
   *  single `VideoMotion action=Start` for the whole window (no per-tick
   *  repeats), but the pipeline-runner re-arms its `motionCooldownMs` on
   *  every `detected:true`. Without a heartbeat a >cooldown motion window
   *  would lapse the runner back to `watching`; a bounded ~0.1 Hz re-emit
   *  holds it `active` until the `Stop`. */
  private static readonly MOTION_KEEPALIVE_MS = 10_000

  /** Active event-stream subscription; aborted on dispose / conn change. */
  private eventStreamController: AbortController | null = null
  /** Dedicated CGI client for the long-poll — see {@link ensureEventClient}. */
  private eventClient: AmcrestCgiClient | null = null
  /** Reconnect attempt counter — drives exponential backoff. */
  private eventStreamReconnectAttempts = 0
  /** Pending reconnect timer. */
  private eventStreamReconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** True between a `VideoMotion Start` and its `Stop`. */
  private motionActive = false
  /** Keepalive re-emit timer for a sustained motion window. */
  private motionKeepaliveTimer: ReturnType<typeof setInterval> | null = null
  /** Control-plane reachability poll — drives `device.online` from Dahua CGI
   *  `getDeviceInfo` liveness, decoupled from stream-broker video health.
   *  Started in `onActivate`, stopped in `removeDevice`. */
  private reachabilityPoll: ReachabilityPollHandle | null = null

  /** Single-flight guard for the `stream-params` camera refresh. */
  private streamParamsRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `motion-zones` camera refresh. */
  private motionZonesRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `privacy-mask` camera refresh. */
  private privacyMaskRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `day-night` camera refresh. */
  private dayNightRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `image-settings` camera refresh. */
  private imageSettingsRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `recording-onboard` camera refresh. */
  private recordingOnboardRefreshInFlight: Promise<void> | null = null

  /** Channel is 1-based; defaults to the schema's configured value. */
  private get channel(): number {
    return this.config.get('channel') ?? 1
  }

  // ── Connection lifecycle ─────────────────────────────────────────

  /**
   * Which preset `goHome` targets, and who decided it.
   *
   * Dahua names no home of its own that we have probed, so the operator's pick
   * is the only answer. With none, `none` -- and `goHome` refuses rather than
   * moving the head to whatever happens to sit in slot 1.
   */
  private async resolveHomePreset(): Promise<PtzHomePreset> {
    const chosen = this.config.get('homePresetId') ?? ''
    if (chosen === '') return { presetId: null, source: 'none' }
    return { presetId: chosen, source: 'operator' }
  }

  /**
   * What the clip service needs to reach this camera's own recordings.
   *
   * The CGI client is the DEVICE's, not a second one: it carries a warm
   * digest state whose nonce-count is monotonic, and a second client for the
   * clip path would advance a second one against the same camera.
   *
   * `readStorage` is the SAME read and the SAME parser the `recording-onboard`
   * cap uses (D614) — `storageDevice.cgi?action=getDeviceAllInfo` through
   * `parseOnboardStorage` — mapped into the clip cap's own three states. There
   * is one storage reader in this addon and this is a caller of it, not a
   * second one. It is read live rather than taken off the cap's runtime slice
   * because that slice is `unknown` until the cap's first refresh, and
   * "CamStack has not read this camera yet" must not reach an operator as
   * "this camera cannot be reached".
   */
  getClipCamera(): AmcrestClipCamera {
    const https = this.config.get('https') ?? false
    return {
      deviceId: this.id,
      host: this.config.get('host'),
      port: this.config.get('port') ?? (https ? 443 : 80),
      https,
      username: this.config.get('username') ?? 'admin',
      password: this.config.get('password'),
      channel: this.channel,
      client: this.ensureClient(),
      readStorage: async (): Promise<ClipSourceAvailability | null> => {
        let table: ReadonlyMap<string, string>
        try {
          table = await this.ensureClient().getStorageDeviceAllInfo()
        } catch (err: unknown) {
          // A measurement that FAILED is not a measurement (D393). It is
          // never folded into "there is no card", which would tell the
          // operator to fit one that is already fitted.
          return {
            state: 'unreachable',
            reason: `The camera did not answer the storage read: ${
              err instanceof Error ? err.message : String(err)
            }`,
          }
        }
        return availabilityFromStorage(parseOnboardStorage(table))
      },
    }
  }

  private ensureClient(): AmcrestCgiClient {
    if (this.client) return this.client
    this.client = this.buildClient()
    return this.client
  }

  /**
   * A SECOND client, used only by the event-stream long-poll.
   *
   * `AmcrestCgiClient` carries one `DigestState` — a nonce plus a monotonic
   * nonce-count — and reuses it across every request so a warm session skips
   * the 401 round-trip. That is right for the ~20 short CGI calls this device
   * makes (snapshot, encode config, PTZ caps, OSD, …) and wrong for a
   * subscription that must stay authenticated for hours: the short calls keep
   * advancing `nc` on the shared state underneath it.
   *
   * The long-poll therefore gets its own client and its own digest state, which
   * is the last remaining difference between the provider's subscription and
   * the hand-rolled probes that DID receive events from this camera — same
   * host, same `codes` filter, same moment, three connections, only ours silent.
   */
  private ensureEventClient(): AmcrestCgiClient {
    if (this.eventClient) return this.eventClient
    this.eventClient = this.buildClient()
    return this.eventClient
  }

  private buildClient(): AmcrestCgiClient {
    const https = this.config.get('https') ?? false
    return new AmcrestCgiClient({
      host: this.config.get('host'),
      port: this.config.get('port') ?? (https ? 443 : 80),
      https,
      username: this.config.get('username') ?? 'admin',
      password: this.config.get('password'),
    })
  }

  /**
   * Settings-save dispatcher. Two kinds of keys arrive here:
   *
   *   - Extras keys (IR illuminator / status LED / NTP / auto-reboot) —
   *     camera-authoritative (D62). They are pushed to the camera over
   *     CGI `setConfig` and re-read into `deviceCache.extras`; they are
   *     NOT in the config schema, so `config.setAll` strips them and no
   *     second store ever exists.
   *   - Config keys (host / credentials / channel) — persisted by the
   *     base path; a connection-shape change additionally drops the
   *     cached CGI clients so the next call rebuilds them.
   */
  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    const { params: extrasParams, handled: extrasKeys } = extrasPatchToCgiParams(patch)
    if (Object.keys(extrasParams).length > 0) {
      const client = this.ensureClient()
      await client.setConfig(extrasParams)
      this.ctx.logger.info('amcrest: extras settings written to camera', {
        tags: { deviceId: this.id },
        meta: { keys: extrasKeys, cgiKeys: Object.keys(extrasParams) },
      })
      // A write is its own invalidation — re-read so the next form open
      // renders what the camera actually kept.
      await this.refreshExtrasSnapshot().catch((err: unknown) => {
        this.ctx.logger.warn('amcrest: extras snapshot re-read after save failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    } else if (extrasKeys.length > 0) {
      // Keys arrived but every value was refused (wrong type / outside
      // the verified enum). Dropping silently would read as "saved".
      this.ctx.logger.warn('amcrest: extras settings patch carried no writable value — dropped', {
        tags: { deviceId: this.id },
        meta: { keys: extrasKeys },
      })
    }
    await super.applySettingsPatch(patch)
    if (
      'host' in patch ||
      'port' in patch ||
      'https' in patch ||
      'username' in patch ||
      'password' in patch
    ) {
      this.clearPtzAutoStop()
      this.client = null
      this.eventClient = null
      // Rebuild the onboard-motion stream against the new connection —
      // its client reference is now stale. Skipped while disposed/inactive
      // (no controller and this runs post-activate only when a stream was up).
      const hadStream =
        this.eventStreamController !== null || this.eventStreamReconnectTimer !== null
      this.teardownEventSubscription()
      if (hadStream) this.ensureEventSubscription()
    }
  }

  // ── Onboard motion (Dahua eventManager attach stream) ──────────────
  //
  // Dahua/Amcrest cameras push firmware events over a long-lived
  // `multipart/x-mixed-replace` CGI GET
  // (`eventManager.cgi?action=attach&codes=[VideoMotion]`). Each part is a
  // `text/plain` block `Code=VideoMotion;action=Start|Stop;index=0`. We
  // translate Start→motion-on / Stop→motion-off into the same RAW
  // `EventCategory.ProviderMotion` (`source:'onboard'`) bus event the
  // Reolink/Hikvision providers emit (D673: the orchestrator's camera-sensors
  // bridge turns it into `MotionOnMotionChanged`), so the pipeline treats
  // this as an onboard motion source. Registering the native `motion` cap is what
  // makes the orchestrator default the camera to `motionSources:['onboard']`
  // (it keys off the native `motion` binding) — no adoption-time write.
  //
  // This provider writes NO `motion` runtime-state slice (D696): the
  // orchestrator is its only writer, with the EFFECTIVE motion. Here we emit
  // the raw push, and `isDetected` reads the hub's slice.

  /** Register the native `motion` cap. Its mere presence (a `kind:'native'`
   *  `motion` binding) is what the orchestrator reads to default a
   *  freshly-adopted camera to `motionSources:['onboard']`. `isDetected` and
   *  `getStatus` answer from the HUB's slice (`hubMotionNativeProvider`); an
   *  unreadable hub fails both — never `false` for unknown (D49, D393). */
  private registerMotionCap(): void {
    const provider = hubMotionNativeProvider(this.ctx.api.deviceState, this.id, 'AmcrestCamera')
    this.ctx.registerNativeCap(motionCapability, provider)
    this.ctx.logger.info('amcrest: motion cap registered', {
      tags: { deviceId: this.id },
    })
  }

  /** Reusable event-source identity for every emit on this device. */
  private eventSource(): {
    type: 'device'
    id: number
    addonId: string
    deviceId: number
  } {
    return {
      type: 'device',
      id: this.id,
      addonId: AMCREST_ADDON_ID,
      deviceId: this.id,
    }
  }

  /** Emit the camera's RAW onboard motion transition (`ProviderMotion`,
   *  D673). The orchestrator's camera-sensors bridge re-emits it as
   *  `MotionOnMotionChanged`; the runner subscribes to that and drives its
   *  phase machine via `reportMotion`. */
  private emitMotion(detected: boolean, timestamp: number): void {
    this.ctx.eventBus.emit(
      providerMotionEvent(this.eventSource(), {
        deviceId: this.id,
        detected,
        timestamp,
        source: 'onboard',
      }),
    )
  }

  /** Idempotently open the eventManager attach stream. */
  private ensureEventSubscription(): void {
    if (this.eventStreamController) return
    const client = this.ensureEventClient()
    this.eventStreamController = subscribeAmcrestEvents(client, AmcrestCamera.MOTION_EVENT_CODES, {
      onConnected: () => {
        this.eventStreamReconnectAttempts = 0
        // A reconnect resets any stuck `active` state — a `Stop` missed
        // while the socket was down would otherwise pin motion on.
        if (this.motionActive) this.onMotionStop(Date.now())
        this.ctx.logger.info('amcrest: event stream connected', {
          tags: { deviceId: this.id },
        })
      },
      onEvent: (ev) => {
        // Every event the camera delivers is named at INFO. `emitMotion` is
        // silent by design, so without this the whole path — camera fires,
        // provider receives, bus carries — leaves no trace at all, and an
        // absence of log lines cannot be told from an absence of motion.
        this.ctx.logger.info('amcrest: firmware event received', {
          tags: { deviceId: this.id },
          meta: { code: ev.code, action: ev.action, index: ev.index },
        })
        this.handleAmcrestEvent(ev)
      },
      onBytes: (byteLength, preview) => {
        this.ctx.logger.info('amcrest: event stream bytes', {
          tags: { deviceId: this.id },
          meta: { byteLength, preview },
        })
      },
      onBufferOverflow: (droppedBytes, preview) => {
        this.ctx.logger.warn(
          'amcrest: event stream buffer hit its cap — discarded the head, resyncing on the next boundary',
          {
            tags: { deviceId: this.id },
            meta: { droppedBytes, preview },
          },
        )
      },
      onUnparsedBlock: (reason, preview) => {
        this.ctx.logger.warn('amcrest: event block dropped — could not be parsed', {
          tags: { deviceId: this.id },
          meta: { reason, preview },
        })
      },
      onError: (err) => {
        this.ctx.logger.warn('amcrest: event stream error — will reconnect', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        this.eventStreamController = null
        this.scheduleEventReconnect()
      },
    })
  }

  /** Single pending reconnect timer with capped exponential backoff
   *  (1s → 60s) — same shape as the Hikvision alarm stream. */
  private scheduleEventReconnect(): void {
    if (this.eventStreamReconnectTimer) return
    const attempts = ++this.eventStreamReconnectAttempts
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
    this.eventStreamReconnectTimer = setTimeout(() => {
      this.eventStreamReconnectTimer = null
      this.ensureEventSubscription()
    }, delayMs)
  }

  private handleAmcrestEvent(ev: AmcrestEvent): void {
    // Only VideoMotion drives the onboard motion signal. Other codes
    // (SmartMotion*, Heartbeat, …) are logged at debug and dropped — onboard
    // AI detection is a separate cap, out of scope for the motion source.
    if (ev.code !== 'VideoMotion') {
      this.ctx.logger.debug('amcrest: unhandled event', {
        tags: { deviceId: this.id },
        meta: { code: ev.code, action: ev.action },
      })
      return
    }
    const action = ev.action.toLowerCase()
    if (action === 'start' || action === 'pulse') this.onMotionStart(ev.observedAt)
    else if (action === 'stop') this.onMotionStop(ev.observedAt)
  }

  private onMotionStart(now: number): void {
    const wasActive = this.motionActive
    this.motionActive = true
    this.emitMotion(true, now)
    if (!wasActive) {
      this.ctx.logger.info('amcrest: onboard motion started', {
        tags: { deviceId: this.id },
      })
    }
    // Heartbeat re-emit for the sustained window (see MOTION_KEEPALIVE_MS).
    if (this.motionKeepaliveTimer === null) {
      this.motionKeepaliveTimer = setInterval(() => {
        this.emitMotion(true, Date.now())
      }, AmcrestCamera.MOTION_KEEPALIVE_MS)
    }
  }

  private onMotionStop(now: number): void {
    this.clearMotionKeepalive()
    if (!this.motionActive) return
    this.motionActive = false
    this.emitMotion(false, now)
    this.ctx.logger.info('amcrest: onboard motion stopped', {
      tags: { deviceId: this.id },
    })
  }

  private clearMotionKeepalive(): void {
    if (this.motionKeepaliveTimer !== null) {
      clearInterval(this.motionKeepaliveTimer)
      this.motionKeepaliveTimer = null
    }
  }

  /** Abort the stream + clear all motion timers. Idempotent. */
  private teardownEventSubscription(): void {
    if (this.eventStreamReconnectTimer) {
      clearTimeout(this.eventStreamReconnectTimer)
      this.eventStreamReconnectTimer = null
    }
    if (this.eventStreamController) {
      try {
        this.eventStreamController.abort()
      } catch {
        /* swallow */
      }
      this.eventStreamController = null
    }
    this.clearMotionKeepalive()
    this.motionActive = false
  }

  /** Phase 5 — device is live: open the onboard-motion event stream. */
  override async onActivate(): Promise<void> {
    this.ensureEventSubscription()
    this.startReachabilityPolling()
    // Warm the extras snapshot (IR light / LED / NTP / auto-reboot) so
    // the settings form can render camera truth on first open. Failure
    // is logged inside; the form then honestly renders no extras
    // sections instead of fabricated defaults.
    void this.refreshExtrasSnapshot().catch(() => {
      /* logged inside */
    })
  }

  // ── Driver-authored settings (extras + connection) ─────────────────

  /** Single-flight guard for the extras snapshot refresh. */
  private extrasRefreshInFlight: Promise<void> | null = null
  /** Debounce for the serve-and-revalidate kick on form open. */
  private lastExtrasRevalidateKickAt = 0
  private static readonly EXTRAS_REVALIDATE_MIN_MS = 30_000

  /**
   * Read the four extras tables in one multi-name CGI round-trip and
   * persist the projection into `deviceCache.extras`. The camera stays
   * the authority — this snapshot only seeds form defaults (D62/D224).
   */
  private async refreshExtrasSnapshot(): Promise<void> {
    if (this.extrasRefreshInFlight) return this.extrasRefreshInFlight
    const promise = (async (): Promise<void> => {
      try {
        const client = this.ensureClient()
        const table = await client.getConfigs([...AMCREST_EXTRAS_CONFIG_NAMES])
        const extras = parseExtrasSnapshot(table, Date.now())
        const cache = this.config.get('deviceCache') ?? {}
        await this.config.setAll({ deviceCache: { ...cache, extras } })
      } catch (err) {
        this.ctx.logger.warn('amcrest: extras snapshot refresh failed — keeping last snapshot', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    })()
    this.extrasRefreshInFlight = promise
    try {
      await promise
    } finally {
      this.extrasRefreshInFlight = null
    }
  }

  /**
   * Driver settings form: the Connection card (same taxonomy as the
   * Hikvision/Reolink drivers) + the extras sections built from the last
   * camera read. Extras values are served from the persisted snapshot
   * and revalidated BEHIND the open (serve-and-revalidate, D224) — this
   * method is sync and must never dial the camera on the render path.
   */
  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const cache = this.config.get('deviceCache')
    const extras = cache?.extras
    const now = Date.now()
    const stale =
      extras?.fetchedAt === undefined || now - extras.fetchedAt > OPERATOR_WRITTEN_STALE_MS
    if (stale && now - this.lastExtrasRevalidateKickAt > AmcrestCamera.EXTRAS_REVALIDATE_MIN_MS) {
      this.lastExtrasRevalidateKickAt = now
      void this.refreshExtrasSnapshot().catch(() => {
        /* logged inside — the form keeps serving the persisted snapshot */
      })
    }
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'connection',
          tab: 'general',
          title: 'Connection',
          titleKey: 'provider-amcrest:schema.s_connection.title',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'Camera IP',
              labelKey: 'provider-amcrest:schema.s_connection.host.label',
              required: true,
              placeholder: '192.168.10.100',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              labelKey: 'provider-amcrest:schema.s_connection.port.label',
              default: 80,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'https',
              label: 'Use HTTPS',
              labelKey: 'provider-amcrest:schema.s_connection.https.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'number',
              key: 'channel',
              label: 'Channel (1-based)',
              labelKey: 'provider-amcrest:schema.s_connection.channel.label',
              default: 1,
              min: 1,
              max: 64,
              step: 1,
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'provider-amcrest:schema.s_connection.username.label',
              default: 'admin',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'provider-amcrest:schema.s_connection.password.label',
              required: true,
              showToggle: true,
            },
          ],
        },
        ...buildExtrasSections(extras),
      ],
    }
    const values: Record<string, unknown> = {
      host: this.config.get('host'),
      port: this.config.get('port'),
      https: this.config.get('https'),
      channel: this.config.get('channel'),
      username: this.config.get('username'),
      password: this.config.get('password'),
    }
    // Extras values come from the CAMERA snapshot — the config store
    // deliberately holds no copy of them (D62).
    if (extras !== undefined) {
      if (extras.irLightMode !== undefined) values['irLightMode'] = extras.irLightMode
      if (extras.irLightBrightness !== undefined)
        values['irLightBrightness'] = extras.irLightBrightness
      if (extras.statusLedEnabled !== undefined)
        values['statusLedEnabled'] = extras.statusLedEnabled
      if (extras.ntpEnabled !== undefined) values['ntpEnabled'] = extras.ntpEnabled
      if (extras.ntpServer !== undefined) values['ntpServer'] = extras.ntpServer
      if (extras.ntpPort !== undefined) values['ntpPort'] = extras.ntpPort
      if (extras.ntpUpdatePeriodMin !== undefined)
        values['ntpUpdatePeriodMin'] = extras.ntpUpdatePeriodMin
      if (extras.ntpTimeZoneIndex !== undefined)
        values['ntpTimeZoneIndex'] = extras.ntpTimeZoneIndex
      if (extras.autoRebootEnabled !== undefined)
        values['autoRebootEnabled'] = extras.autoRebootEnabled
      if (extras.autoRebootDay !== undefined) values['autoRebootDay'] = String(extras.autoRebootDay)
      if (extras.autoRebootHour !== undefined) values['autoRebootHour'] = extras.autoRebootHour
      if (extras.autoRebootMinute !== undefined)
        values['autoRebootMinute'] = extras.autoRebootMinute
    }
    return hydrateSchema(schema, values)
  }

  /** Start the control-plane reachability poll: a Dahua CGI `getDeviceInfo`
   *  round-trip every 30s drives `device.online`, with hysteresis. Replaces
   *  the old stream-health→online mirror so an on-demand (idle) but reachable
   *  camera still reports ONLINE. Idempotent. */
  private startReachabilityPolling(): void {
    if (this.reachabilityPoll) return
    this.reachabilityPoll = startReachabilityPoll({
      probe: async () => {
        const client = this.ensureClient()
        await client.getDeviceInfo()
        return true
      },
      setOnline: (online) => {
        this.markOnline(online)
      },
      isEnabled: () => !this.disabled,
      logger: this.ctx.logger,
    })
  }

  /** Teardown — stop the stream + motion timers, drop the client. */
  override async removeDevice(): Promise<void> {
    this.ctx.logger.info('Removing Amcrest camera', {
      tags: { deviceId: this.id },
    })
    this.teardownEventSubscription()
    this.clearPtzAutoStop()
    this.reachabilityPoll?.stop()
    this.reachabilityPoll = null
    this.client = null
  }

  // ── Stream catalog (PRIORITY) ─────────────────────────────────────

  private registerStreamCatalogProvider(): void {
    const provider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        return this.buildStreamCatalog()
      },
    }
    this.ctx.registerNativeCap(streamCatalogCapability, provider)
  }

  /** Build the dialable `rtsp://` URL for one Dahua `subtype` (0=main, 1=sub). */
  private buildRtspUrl(subtype: 0 | 1): string {
    const username = encodeURIComponent(this.config.get('username') ?? 'admin')
    const password = encodeURIComponent(this.config.get('password'))
    const host = this.config.get('host')
    return `rtsp://${username}:${password}@${host}:554/cam/realmonitor?channel=${this.channel}&subtype=${subtype}`
  }

  /**
   * Build this camera's pull-able stream catalog. Amcrest/Dahua's RTSP
   * path is deterministic (`cam/realmonitor?channel=N&subtype=0|1`) —
   * unlike Hikvision/ONVIF there is no channel-discovery round-trip
   * needed, so this never fails except on a malformed config. Best-effort
   * enrichment (codec/resolution/fps from the `Encode` config) is
   * attempted but never blocks the catalog — a probe failure just omits
   * those optional fields.
   */
  private async buildStreamCatalog(): Promise<CamStreamDescriptor[]> {
    const descriptors: CamStreamDescriptor[] = [
      {
        camStreamId: 'main',
        kind: 'pull-rtsp',
        url: this.buildRtspUrl(0),
        label: 'Main',
      },
      {
        camStreamId: 'sub',
        kind: 'pull-rtsp',
        url: this.buildRtspUrl(1),
        label: 'Sub',
      },
    ]

    try {
      const client = this.ensureClient()
      const encode = await client.getEncodeConfig()
      const enrich = (
        desc: CamStreamDescriptor,
        formatKey: 'MainFormat' | 'ExtraFormat',
      ): CamStreamDescriptor => {
        const prefix = `${formatKey}[0]`
        const codec = mapAmcrestCodec(encode.get(`${prefix}.Video.Compression`) ?? null)
        const width = parseIntOrUndefined(encode.get(`${prefix}.Video.Width`))
        const height = parseIntOrUndefined(encode.get(`${prefix}.Video.Height`))
        const fps = parseIntOrUndefined(encode.get(`${prefix}.Video.FPS`))
        return {
          ...desc,
          ...(codec ? { codec } : {}),
          ...(width !== undefined && height !== undefined ? { resolution: { width, height } } : {}),
          ...(fps !== undefined ? { fps } : {}),
        }
      }
      descriptors[0] = enrich(descriptors[0]!, 'MainFormat')
      descriptors[1] = enrich(descriptors[1]!, 'ExtraFormat')
    } catch (err) {
      this.ctx.logger.debug('amcrest: stream-catalog encode enrichment failed (URLs still valid)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    this.published.clear()
    for (const d of descriptors) {
      this.published.set(d.camStreamId, {
        camStreamId: d.camStreamId,
        label: d.label ?? d.camStreamId,
        rtspUrl: d.url ?? '',
      })
    }
    return descriptors
  }

  /** Compat shim for legacy `ICameraDevice.getStreamSources()` consumers.
   *  The broker PULLS the real catalog via `stream-catalog`; this just
   *  reflects the `published` map reconciled on the last pull. */
  async getStreamSources(): Promise<readonly StreamSourceEntry[]> {
    const out: StreamSourceEntry[] = []
    for (const p of this.published.values()) {
      out.push({
        id: p.camStreamId,
        label: p.label,
        protocol: 'rtsp' as const,
        url: p.rtspUrl,
        profileHint: p.camStreamId === 'main' ? 'high' : 'low',
      })
    }
    return out
  }

  // ── Snapshot (PRIORITY) ────────────────────────────────────────────

  private registerSnapshotCap(): void {
    const provider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`AmcrestCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const client = this.ensureClient()
        const channel = this.config.get('channel') ?? 1
        try {
          const { buffer, contentType } = await client.getSnapshot(channel)
          return { base64: buffer.toString('base64'), contentType }
        } catch (err) {
          this.ctx.logger.warn('amcrest snapshot failed', {
            tags: { deviceId: this.id },
            meta: {
              channel,
              error: err instanceof Error ? err.message : String(err),
            },
          })
          return null
        }
      },
      invalidateCache: async () => {
        // No local cache — the snapshot wrapper owns it.
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, provider)
  }

  // ── device-admin-link ──────────────────────────────────────────────

  /**
   * The camera's own web console. Amcrest is the same exact case as
   * Hikvision: `port` IS the HTTP CGI port, which is the port the web UI is
   * served on, and `https` is a real per-device flag — nothing is assumed.
   *
   * No credentials in the URL, although `username`/`password` are two fields
   * away in the same config object. See `buildDeviceAdminUrl`.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`AmcrestCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const host = this.config.get('host') ?? ''
        const built = buildDeviceAdminUrl({
          host,
          port: this.config.get('port') ?? null,
          scheme: this.config.get('https') === true ? 'https' : 'http',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('amcrest admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return { url: built.url, label: 'Web UI', target: 'device' as const, host }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }

  // ── PTZ ────────────────────────────────────────────────────────────

  /** Duration (ms) a one-shot `move` pulse runs before its safety
   *  auto-stop fires. The `usePTZ` UI hook already issues its own paired
   *  `stop` after a client-side pulse window; this timer is a backstop so
   *  a lone `move` (no following `stop`) can't leave the head gliding. */
  /**
   * Dahua's native PTZ speed scale is 1..8; `resolvePtzCodes` maps the cap's
   * normalized 0..1 onto it. Eight steps is COARSE -- three neighbouring
   * normalized requests round to the same one -- which is exactly why the
   * granularity is reported through `getOptions` instead of being hidden
   * behind a 0..1 float.
   */
  /** Dahua exposes 25 fixed preset slots, 1-based. */
  static readonly DAHUA_MAX_PRESETS = 25

  static readonly DAHUA_SPEED_STEPS = 8

  /**
   * How long one `ptz.move` pulse runs, ms. The DENOMINATOR of "how far did
   * the head travel per pulse", so it leaves the provider through
   * `getOptions` rather than staying a private literal.
   */
  static readonly PTZ_PULSE_MS = 350
  /** Short per-call deadline (ms) for the PTZ start/stop CGI so a slow or
   *  blocked camera round-trip fails fast instead of exceeding the
   *  hub-local-uds transport's abort window — the failure mode that
   *  surfaced live as
   *  `ptz.move ... hub-local-uds=This operation was aborted`. */
  private static readonly PTZ_CGI_TIMEOUT_MS = 2_500

  /** Dahua `ptz.cgi` direction/zoom codes currently started — tracked so
   *  `stop()` / the next `continuousMove()` can cleanly halt exactly the
   *  codes that are actually moving instead of guessing. */
  private readonly activePtzCodes = new Set<string>()

  /** Pending safety auto-stop for the last one-shot `move` pulse.
   *  Cleared by any subsequent move/continuousMove/stop so pulses and
   *  gestures never race a stale timer. */
  private ptzAutoStopTimer: ReturnType<typeof setTimeout> | null = null

  /** Cancel the pending one-shot `move` auto-stop, if any. */
  private clearPtzAutoStop(): void {
    if (this.ptzAutoStopTimer !== null) {
      clearTimeout(this.ptzAutoStopTimer)
      this.ptzAutoStopTimer = null
    }
  }

  /** Resolve a cap `PtzMoveCommand` into 0-2 Dahua CGI move commands
   *  (one pan/tilt code — possibly diagonal — plus one zoom code).
   *  `pan`/`tilt`/`zoom` are normalized -1..1. Speed maps to Dahua's 1-8
   *  scale: the explicit cap-level `speed` (0..1, from the UI speed
   *  slider) wins when supplied; otherwise the vector magnitude is used. */
  private resolvePtzCodes(
    pan?: number,
    tilt?: number,
    zoom?: number,
    speed?: number,
  ): readonly { code: string; speed: number }[] {
    const speedFor = (magnitude: number): number => {
      const normalized = speed !== undefined ? Math.abs(speed) : Math.abs(magnitude)
      return Math.max(1, Math.min(8, Math.round(normalized * 8)))
    }
    const out: { code: string; speed: number }[] = []
    const p = pan ?? 0
    const t = tilt ?? 0
    if (p !== 0 || t !== 0) {
      const code =
        p !== 0 && t !== 0
          ? `${t > 0 ? 'Up' : 'Down'}${p > 0 ? 'Right' : 'Left'}`
          : p !== 0
            ? p > 0
              ? 'Right'
              : 'Left'
            : t > 0
              ? 'Up'
              : 'Down'
      out.push({ code, speed: speedFor(Math.max(Math.abs(p), Math.abs(t))) })
    }
    const z = zoom ?? 0
    if (z !== 0) {
      out.push({ code: z > 0 ? 'ZoomTele' : 'ZoomWide', speed: speedFor(z) })
    }
    return out
  }

  /** Stop every currently-tracked PTZ code. Best-effort — a stop call
   *  for a code that already finished is harmless on Dahua firmware. */
  private async stopActivePtz(): Promise<void> {
    if (this.activePtzCodes.size === 0) return
    const client = this.ensureClient()
    const channel = this.channel
    const codes = [...this.activePtzCodes]
    this.activePtzCodes.clear()
    await Promise.all(
      codes.map((code) =>
        client.ptzStop(channel, code, AmcrestCamera.PTZ_CGI_TIMEOUT_MS).catch((err: unknown) => {
          this.ctx.logger.debug('amcrest: ptzStop failed (continuing)', {
            tags: { deviceId: this.id },
            meta: {
              code,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }),
      ),
    )
  }

  private async startPtzCodes(codes: readonly { code: string; speed: number }[]): Promise<void> {
    const client = this.ensureClient()
    const channel = this.channel
    // Issue pan/tilt + zoom concurrently (independent Dahua axes) with a
    // short deadline so the whole `move`/`continuousMove` cap call
    // resolves fast — never a serial per-axis round-trip.
    await Promise.all(
      codes.map(({ code, speed }) => {
        this.activePtzCodes.add(code)
        return client.ptzStart(channel, code, speed, AmcrestCamera.PTZ_CGI_TIMEOUT_MS)
      }),
    )
  }

  /** Serialized tail of PTZ CGI operations for this camera. */
  private ptzChain: Promise<void> = Promise.resolve()

  /** Serialize a PTZ CGI op onto the per-camera chain and return AT ONCE.
   *  The UI models a short tap as `move`+`stop` and a long press as
   *  `continuousMove`+`stop`. Two problems the chain solves together:
   *  (1) awaiting the camera round-trip (digest handshake + CGI) in the cap
   *  call makes the hub-local-uds transport abort it → `This operation was
   *  aborted`, head never moves; (2) issuing start/stop as independent
   *  fire-and-forget fetches RACES them — a `stop` fetch can land before its
   *  `start`, leaving the head gliding or never moving (why tap "only worked
   *  on long press"). Chaining runs each op to completion IN ORDER (start
   *  before its paired stop) while the cap returns immediately. */
  private enqueuePtz(label: string, op: () => Promise<void>): void {
    this.ptzChain = this.ptzChain.then(op).catch((err: unknown) => {
      this.ctx.logger.debug(`amcrest: ptz ${label} failed`, {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  private registerPtzCap(): void {
    const provider: InferNativeProvider<typeof ptzCapability> = {
      move: async ({ deviceId, pan, tilt, zoom, speed }) => {
        if (deviceId !== this.id) return
        // One-shot pulse. Dahua's CGI is continuous-only (no "absolute step"
        // action), so a `move` = quick `start` now + a `stop` shortly after.
        // CRITICAL: BOTH the start and the stop are fire-and-forget (issued in
        // the background, cap returns at once) — awaiting the CGI here is
        // exactly what pushed the cap call past the hub-local-uds transport's
        // abort window and made PTZ report `This operation was aborted` (head
        // never moved). Returning immediately keeps PTZ instant like the
        // vendor app. The UI hook also sends its own paired `stop`; idempotent.
        this.clearPtzAutoStop()
        const codes = this.resolvePtzCodes(pan, tilt, zoom, speed)
        if (codes.length === 0) return
        this.enqueuePtz('move', () => this.startPtzCodes(codes))
        // Backstop stop for a LONE `move` with no paired UI `stop`. The UI's
        // own `stop` (which calls clearPtzAutoStop) supersedes it; either way
        // the stop is chained AFTER the start, so the head always halts.
        this.ptzAutoStopTimer = setTimeout(() => {
          this.ptzAutoStopTimer = null
          this.enqueuePtz('auto-stop', () => this.stopActivePtz())
        }, AmcrestCamera.PTZ_PULSE_MS)
      },
      continuousMove: async ({ deviceId, pan, tilt, zoom, speed }) => {
        if (deviceId !== this.id) return
        // Gesture-driven: `start` now, keep moving until the caller's explicit
        // `stop`. Fire-and-forget (background) so the cap never blocks on the
        // camera round-trip and never gets transport-aborted.
        this.clearPtzAutoStop()
        const codes = this.resolvePtzCodes(pan, tilt, zoom, speed)
        this.enqueuePtz('continuousMove', async () => {
          await this.stopActivePtz()
          if (codes.length > 0) await this.startPtzCodes(codes)
        })
      },
      stop: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        this.clearPtzAutoStop()
        this.enqueuePtz('stop', () => this.stopActivePtz())
      },
      getPresets: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        const client = this.ensureClient()
        const presets = await client.getPtzPresets(this.channel)
        // Dahua's reserved preset band is model-dependent and we have not
        // probed it, so every id stays writable and a firmware that disagrees
        // refuses for itself, named -- guessing a band here would take a real
        // slot away from the operator.
        return presets.map((p) => ({
          id: String(p.id),
          name: p.name,
          fn: null,
          writable: true,
        }))
      },
      goToPreset: async ({ deviceId, presetId }) => {
        if (deviceId !== this.id) return
        const id = Number.parseInt(presetId, 10)
        // Dahua presets are 1-based; `GotoPreset&arg2=0` HTTP-400s. Guard
        // non-positive/NaN ids so a stale or empty selection can't 400.
        if (!Number.isFinite(id) || id < 1) return
        const client = this.ensureClient()
        this.enqueuePtz('goToPreset', () =>
          client.ptzGotoPreset(this.channel, id, AmcrestCamera.PTZ_CGI_TIMEOUT_MS),
        )
      },
      savePreset: async ({ deviceId, presetId, name }) => {
        if (deviceId !== this.id) return
        const client = this.ensureClient()
        // Dahua presets are 1-BASED (`SetPreset arg2=0` is invalid) with 25
        // fixed slots. Two callers:
        //   • UPDATE — the UI passes an EXISTING 1-based id (from getPtzPresets)
        //     to overwrite that slot with the current position: HONOUR it as-is
        //     (SetPreset re-points an occupied slot, no dodging).
        //   • CREATE — the generic hook suggests a 0-based/absent id: resolve
        //     the lowest UNUSED 1-based slot so the first Save lands on 1.
        const requested = Number.parseInt(presetId, 10)
        const DAHUA_MAX_PRESETS = 25
        let slot: number
        if (Number.isInteger(requested) && requested >= 1 && requested <= DAHUA_MAX_PRESETS) {
          slot = requested
        } else {
          // getPtzPresets returns only Enable=true slots (1-based ids).
          const used = new Set((await client.getPtzPresets(this.channel)).map((p) => p.id))
          slot = 1
          while (used.has(slot)) slot += 1
        }
        await client.ptzSetPreset(this.channel, slot)
        // Dahua's `SetPreset` takes no name — the firmware assigns `Preset N`.
        // No CGI rename endpoint is wired; `name` is accepted but not applied.
        void name
      },
      deletePreset: async ({ deviceId, presetId }) => {
        if (deviceId !== this.id) return
        const id = Number.parseInt(presetId, 10)
        if (!Number.isFinite(id)) return
        const client = this.ensureClient()
        await client.ptzClearPreset(this.channel, id)
      },
      getOptions: async ({ deviceId }) => {
        const cold = {
          hasPan: false,
          hasTilt: false,
          hasZoom: false,
          supportsPresets: false,
          hasAutofocus: false,
          // `resolvePtzCodes` maps the normalized speed onto Dahua's 1..8.
          speedSteps: AmcrestCamera.DAHUA_SPEED_STEPS,
          moveImpulseMs: AmcrestCamera.PTZ_PULSE_MS,
        }
        if (deviceId !== this.id) return cold
        const client = this.ensureClient()
        const caps = await client.getPtzCaps(this.channel)
        if (!caps) return cold
        return {
          hasPan: caps.hasPan,
          hasTilt: caps.hasTilt,
          hasZoom: caps.hasZoom,
          supportsPresets: caps.supportsPreset,
          hasAutofocus: false,
          speedSteps: AmcrestCamera.DAHUA_SPEED_STEPS,
          moveImpulseMs: AmcrestCamera.PTZ_PULSE_MS,
          ...(caps.maxPresets !== null ? { maxPresets: caps.maxPresets } : {}),
        }
      },
      goHome: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        // This used to go to preset 1 because "Dahua convention: preset id 1 is
        // commonly configured as home by the installer", fire-and-forget with a
        // background catch. On device 3836 preset 1 is "Preset1", and the
        // swallowed failure meant a head that never moved looked exactly like a
        // head that went home. Resolve, or refuse.
        const home = await this.resolveHomePreset()
        if (home.source === 'none' || home.presetId === null) {
          throw userError(
            'amcrest.home-preset-missing',
            undefined,
            'No home preset configured for this camera — set one in the PTZ settings',
          )
        }
        const id = Number.parseInt(home.presetId, 10)
        if (!Number.isFinite(id) || id < 1) {
          throw new Error(`Configured home preset is not a Dahua preset id: ${home.presetId}`)
        }
        const client = this.ensureClient()
        this.enqueuePtz('goHome', () =>
          client.ptzGotoPreset(this.channel, id, AmcrestCamera.PTZ_CGI_TIMEOUT_MS),
        )
      },
      getHomePreset: async ({ deviceId }) => {
        if (deviceId !== this.id) return { presetId: null, source: 'none' as const }
        return this.resolveHomePreset()
      },
      captureHomeHere: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        // Dahua's home is a preset too, so "set home here" claims a slot. The
        // reserved band on this vendor has NOT been probed, so the only ids
        // treated as unavailable are the ones the camera already reports: an
        // operator preset is never overwritten, and a full camera REFUSES
        // rather than choosing a victim.
        const client = this.ensureClient()
        const caps = await client.getPtzCaps(this.channel)
        const ceiling = caps?.maxPresets ?? AmcrestCamera.DAHUA_MAX_PRESETS
        // getPtzPresets returns only occupied (Enable=true) 1-based slots.
        const used = new Set((await client.getPtzPresets(this.channel)).map((p) => p.id))
        let slot = 1
        while (used.has(slot) && slot <= ceiling) slot += 1
        if (slot > ceiling) {
          throw new Error(
            'No free preset slot on this camera to store a home position — free one first',
          )
        }
        // `SetPreset` takes no name on Dahua — the firmware assigns "Preset N".
        // There is no rename endpoint wired, so the home slot is identified by
        // its id alone, which is why we persist it.
        await client.ptzSetPreset(this.channel, slot, AmcrestCamera.PTZ_CGI_TIMEOUT_MS)
        await this.config.setAll({ homePresetId: String(slot) })
        this.ctx.logger.info('amcrest: home pinned to the current position', {
          tags: { deviceId: this.id },
          meta: { presetId: slot },
        })
      },
      getHomeReturn: async () => {
        // Dahua has an idle "park" behaviour on some models; we do not read it,
        // and `null` says exactly that rather than claiming there is none.
        return null
      },
      setHomeReturn: async () => {
        throw new Error('Amcrest: the idle-return timer is not wired on this driver')
      },
      setHomePreset: async ({ deviceId, presetId }) => {
        if (deviceId !== this.id) return
        // `setAll` merges — never spread the snapshot back in (CLAUDE.md).
        await this.config.setAll({ homePresetId: presetId ?? '' })
      },
      getPosition: async () => {
        // Dahua CGI has no generic absolute-position read for this
        // model family — stub, matching the Hikvision provider's
        // documented fallback.
        return { pan: null, tilt: null, zoom: null }
      },
      getStatus: async () => {
        return { pan: null, tilt: null, zoom: null, autofocus: false }
      },
      setAutofocus: async () => {
        // No-op — `getOptions().hasAutofocus` is false, so the UI never
        // surfaces the toggle that would call this.
      },
    }
    this.ctx.registerNativeCap(ptzCapability, provider)
    this.ctx.logger.info('amcrest: PTZ cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── Stream-params cap ──────────────────────────────────────────────
  //
  // Dahua `Encode[0]` table — verified live against an IP4M-1041B:
  // `MainFormat[0]` = main profile, `ExtraFormat[0]` = sub profile,
  // `ExtraFormat[1]` = ext profile. Each carries `Video.{Width,Height,
  // Compression,FPS,BitRate,BitRateControl,Profile,GOP}` — all present
  // and all writable via generic `setConfig`. `encode.cgi?action=
  // getConfigCaps` gives per-format `BitRateOptions` (→ bitrateRange),
  // `CompressionTypes`, `FPSMax`, `H264Profile[]`, `ResolutionTypes`.

  private static readonly STREAM_PROFILE_PREFIX: Record<StreamProfile, string> = {
    main: 'Encode[0].MainFormat[0]',
    sub: 'Encode[0].ExtraFormat[0]',
    ext: 'Encode[0].ExtraFormat[1]',
  }

  private mapAmcrestEncoderProfile(
    raw: string | undefined,
  ): 'high' | 'main' | 'baseline' | undefined {
    if (!raw) return undefined
    const v = raw.toLowerCase()
    if (v.includes('baseline')) return 'baseline'
    if (v.includes('high')) return 'high'
    if (v.includes('main')) return 'main'
    return undefined
  }

  /** Map a Dahua `ResolutionTypes` token (`'2560x1440'`, `'1080P'`,
   *  `'720P'`, `'VGA'`, …) into `{width,height}`. Returns `undefined`
   *  for tokens outside the small known-name set — never guesses. */
  private parseAmcrestResolution(token: string): { width: number; height: number } | undefined {
    const direct = /^(\d+)x(\d+)$/i.exec(token.trim())
    if (direct) return { width: Number(direct[1]), height: Number(direct[2]) }
    const named: Record<string, { width: number; height: number }> = {
      '1080p': { width: 1920, height: 1080 },
      '720p': { width: 1280, height: 720 },
      vga: { width: 640, height: 480 },
    }
    return named[token.trim().toLowerCase()]
  }

  private mapEncodeConfigToProfile(
    table: Map<string, string>,
    prefix: string,
  ): StreamParamsStatus['main'] | undefined {
    const codec = mapAmcrestCodec(table.get(`${prefix}.Video.Compression`) ?? null)
    const width = parseIntOrUndefined(table.get(`${prefix}.Video.Width`))
    const height = parseIntOrUndefined(table.get(`${prefix}.Video.Height`))
    const framerate = parseIntOrUndefined(table.get(`${prefix}.Video.FPS`))
    const bitrate = parseIntOrUndefined(table.get(`${prefix}.Video.BitRate`))
    if (
      codec === undefined ||
      width === undefined ||
      height === undefined ||
      framerate === undefined ||
      bitrate === undefined
    ) {
      return undefined
    }
    const config: StreamParamsStatus['main'] = {
      width,
      height,
      codec,
      framerate,
      bitrate,
    }
    const bitrateControl = table.get(`${prefix}.Video.BitRateControl`)
    if (bitrateControl === 'VBR') config.bitrateMode = 'vbr'
    else if (bitrateControl === 'CBR') config.bitrateMode = 'cbr'
    const encoderProfile = this.mapAmcrestEncoderProfile(table.get(`${prefix}.Video.Profile`))
    if (encoderProfile !== undefined) config.encoderProfile = encoderProfile
    const gop = parseIntOrUndefined(table.get(`${prefix}.Video.GOP`))
    if (gop !== undefined) config.gop = gop
    return config
  }

  private async probeStreamParamsOptions(): Promise<StreamParamsOptions> {
    const client = this.ensureClient()
    const caps = await client.getEncodeCaps()
    const result: StreamParamsOptions = {}
    const slots: { profile: StreamProfile; capsKey: string }[] = [
      { profile: 'main', capsKey: 'MainFormat[0]' },
      { profile: 'sub', capsKey: 'ExtraFormat[0]' },
      { profile: 'ext', capsKey: 'ExtraFormat[1]' },
    ]
    for (const { profile, capsKey } of slots) {
      const compressionTypes = caps.get(`${capsKey}.Video.CompressionTypes`)
      if (compressionTypes === undefined) continue // format not advertised on this model
      const codecs: Array<'h264' | 'h265'> = []
      if (/h\.?264/i.test(compressionTypes)) codecs.push('h264')
      if (/h\.?265/i.test(compressionTypes)) codecs.push('h265')

      const resolutionTypes = caps.get(`${capsKey}.Video.ResolutionTypes`) ?? ''
      const resolutions = resolutionTypes
        .split(',')
        .map((t) => this.parseAmcrestResolution(t))
        .filter((r): r is { width: number; height: number } => r !== undefined)

      const fpsMax = parseIntOrUndefined(caps.get(`${capsKey}.Video.FPSMax`))
      const framerates = fpsMax ? [1, 5, 10, 15, 20, 25, 30].filter((f) => f <= fpsMax) : []

      const bitrateOptions = caps.get(`${capsKey}.Video.BitRateOptions`)
      const [minRaw, maxRaw] = bitrateOptions?.split(',') ?? []
      const bitrateRange: [number, number] | undefined =
        minRaw !== undefined && maxRaw !== undefined
          ? [Number.parseInt(minRaw, 10), Number.parseInt(maxRaw, 10)]
          : undefined

      result[profile] = {
        resolutions,
        codecs,
        framerates,
        bitrates: [],
        ...(bitrateRange ? { bitrateRange } : {}),
        supportsBitrateMode: true,
        supportsEncoderProfile: caps.has(`${capsKey}.Video.H264Profile[0]`),
        supportsGop: true,
      }
    }
    return result
  }

  private async applyStreamProfilePatch(
    profile: StreamProfile,
    patch: StreamProfilePatch,
  ): Promise<void> {
    const prefix = AmcrestCamera.STREAM_PROFILE_PREFIX[profile]
    const params: Record<string, string | number> = {}
    if (patch.codec !== undefined)
      params[`${prefix}.Video.Compression`] = patch.codec === 'h265' ? 'H.265' : 'H.264'
    if (patch.framerate !== undefined) params[`${prefix}.Video.FPS`] = patch.framerate
    if (patch.bitrate !== undefined) params[`${prefix}.Video.BitRate`] = patch.bitrate
    if (patch.bitrateMode !== undefined)
      params[`${prefix}.Video.BitRateControl`] = patch.bitrateMode === 'cbr' ? 'CBR' : 'VBR'
    if (patch.encoderProfile !== undefined) {
      params[`${prefix}.Video.Profile`] =
        patch.encoderProfile === 'high'
          ? 'High'
          : patch.encoderProfile === 'baseline'
            ? 'Baseline'
            : 'Main'
    }
    if (patch.gop !== undefined) params[`${prefix}.Video.GOP`] = patch.gop
    // width/height: a resolution change needs a paired
    // Width+Height+CustomResolutionName write and this camera's
    // `ResolutionTypes` caps list is name-based (not confirmed
    // round-trippable) — dropped here, same as the Hikvision provider
    // drops width/height from `StreamProfilePatch`.
    //
    // Audio is not here and never will be: `StreamProfilePatch` no longer
    // carries it. The microphone belongs to `privacy-mask`
    // (`setAudioEnabled`), which this provider does not yet implement — the
    // Dahua key would be `${prefix}.AudioEnable`, writable through the same
    // `setConfig` used above.
    if (Object.keys(params).length === 0) return
    const client = this.ensureClient()
    await client.setConfig(params)
  }

  private registerStreamParamsCap(): void {
    const CAP_NAME = 'stream-params' as const
    const STALE_MS = 10_000

    const refreshFromCamera = async (): Promise<void> => {
      if (this.streamParamsRefreshInFlight) return this.streamParamsRefreshInFlight
      const promise = (async () => {
        try {
          const client = this.ensureClient()
          const table = await client.getEncodeConfig()
          const next: StreamParamsStatus = { lastFetchedAt: Date.now() }
          for (const profile of ['main', 'sub', 'ext'] as const) {
            const mapped = this.mapEncodeConfigToProfile(
              table,
              AmcrestCamera.STREAM_PROFILE_PREFIX[profile],
            )
            if (mapped !== undefined) next[profile] = mapped
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('amcrest: stream-params refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      })()
      this.streamParamsRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.streamParamsRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: streamParamsCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      staleMs: STALE_MS,
      logger: this.ctx.logger,
      empty: (): StreamParamsStatus => ({ lastFetchedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof streamParamsCapability> = {
      getStatus: bridge.getStatus,
      getOptions: async ({ deviceId }): Promise<StreamParamsOptions> => {
        if (deviceId !== this.id) return {}
        return this.probeStreamParamsOptions()
      },
      getConfigSchema: async ({ deviceId }): Promise<ConfigUISchema | null> => {
        if (deviceId !== this.id) return null
        const opts = await this.probeStreamParamsOptions()
        await bridge.ensureFresh()
        const status = this.runtimeState.getCapState<StreamParamsStatus>(CAP_NAME) ?? null
        return buildStreamParamsConfigSchema(opts, status)
      },
      setProfile: async ({ deviceId, profile, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.applyStreamProfilePatch(profile, patch)
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(streamParamsCapability, provider)
    this.ctx.logger.info('amcrest: stream-params cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── Motion-zones cap ───────────────────────────────────────────────
  //
  // Dahua `MotionDetect[0]` table — verified live: `Region[0..17]` is
  // an 18-row × 22-bit-per-row cell lattice (each value 0..4194303 =
  // 2^22-1; bit `c` of row `r` = cell (r,c)). `MotionDetectWindow[0]`
  // carries the same `Region[]` plus `.Sensitive` (0-100) — both the
  // top-level and window-0 grids are kept in sync on write.

  private static readonly MOTION_GRID_WIDTH = 22
  private static readonly MOTION_GRID_HEIGHT = 18

  private decodeMotionGrid(table: Map<string, string>, prefix: string): readonly boolean[] {
    const cells: boolean[] = []
    for (let r = 0; r < AmcrestCamera.MOTION_GRID_HEIGHT; r++) {
      const raw = table.get(`${prefix}.Region[${r}]`)
      const value = raw !== undefined ? Number.parseInt(raw, 10) : 0
      for (let c = 0; c < AmcrestCamera.MOTION_GRID_WIDTH; c++) {
        cells.push(((value >> c) & 1) === 1)
      }
    }
    return cells
  }

  private encodeMotionGridRows(cells: readonly boolean[]): number[] {
    const rows: number[] = []
    for (let r = 0; r < AmcrestCamera.MOTION_GRID_HEIGHT; r++) {
      let value = 0
      for (let c = 0; c < AmcrestCamera.MOTION_GRID_WIDTH; c++) {
        const idx = r * AmcrestCamera.MOTION_GRID_WIDTH + c
        if (cells[idx] === true) value |= 1 << c
      }
      rows.push(value)
    }
    return rows
  }

  private registerMotionZonesCap(): void {
    const CAP_NAME = 'motion-zones' as const
    const STALE_MS = 10_000

    const refreshFromCamera = async (): Promise<void> => {
      if (this.motionZonesRefreshInFlight) return this.motionZonesRefreshInFlight
      const promise = (async () => {
        try {
          const client = this.ensureClient()
          const table = await client.getConfig('MotionDetect')
          const enabled = table.get('MotionDetect[0].Enable') === 'true'
          const sensitivity =
            parseIntOrUndefined(table.get('MotionDetect[0].MotionDetectWindow[0].Sensitive')) ?? 0
          const cells = this.decodeMotionGrid(table, 'MotionDetect[0]')
          const next: MotionZoneStatus = {
            enabled,
            sensitivity,
            regions: [
              {
                id: 0,
                enabled: true,
                shape: {
                  kind: 'grid',
                  gridWidth: AmcrestCamera.MOTION_GRID_WIDTH,
                  gridHeight: AmcrestCamera.MOTION_GRID_HEIGHT,
                  cells: [...cells],
                },
              },
            ],
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('amcrest: motion-zones refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      })()
      this.motionZonesRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.motionZonesRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: motionZonesCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      staleMs: STALE_MS,
      logger: this.ctx.logger,
      empty: (): MotionZoneStatus => ({
        enabled: false,
        sensitivity: 0,
        regions: [],
        lastFetchedAt: 0,
      }),
    })

    const provider: InferNativeProvider<typeof motionZonesCapability> = {
      getStatus: bridge.getStatus,
      getOptions: async ({ deviceId }): Promise<MotionZoneOptions> => {
        const cold: MotionZoneOptions = {
          maxRegions: 1,
          supportedShapes: ['grid'],
          grid: {
            width: AmcrestCamera.MOTION_GRID_WIDTH,
            height: AmcrestCamera.MOTION_GRID_HEIGHT,
          },
          sensitivity: { min: 0, max: 100, step: 1 },
        }
        if (deviceId !== this.id) return cold
        return cold
      },
      setZone: async ({ deviceId, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        const params: Record<string, string | number> = {}
        if (patch.enabled !== undefined)
          params['MotionDetect[0].Enable'] = patch.enabled ? 'true' : 'false'
        if (patch.sensitivity !== undefined) {
          params['MotionDetect[0].MotionDetectWindow[0].Sensitive'] = patch.sensitivity
        }
        const gridRegion = patch.regions?.find((r) => r.shape.kind === 'grid')
        if (gridRegion && gridRegion.shape.kind === 'grid') {
          const rows = this.encodeMotionGridRows(gridRegion.shape.cells)
          rows.forEach((value, r) => {
            params[`MotionDetect[0].Region[${r}]`] = value
            params[`MotionDetect[0].MotionDetectWindow[0].Region[${r}]`] = value
          })
        }
        if (Object.keys(params).length === 0) return
        const client = this.ensureClient()
        await client.setConfig(params)
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(motionZonesCapability, provider)
    this.ctx.logger.info('amcrest: motion-zones cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── Privacy-mask cap ───────────────────────────────────────────────
  //
  // Dahua `PrivacyMasking[0][N]` table — verified live: 24 fixed slots
  // (`N` 0..23), each `.Enable` + `.Rect[x,y,w,h]` in a normalized
  // 0..8191 (13-bit) integer space — the same coordinate scale
  // `MotionDetect`'s `Window[]` uses for "full frame". `.Polygon[]`
  // is present but only ever observed as a 3-element zeroed array on
  // this firmware — not enough evidence to wire polygon support, so
  // only the `rect` shape is advertised/implemented.

  private static readonly PRIVACY_MASK_MAX_REGIONS = 24
  private static readonly PRIVACY_COORD_MAX = 8191

  private registerPrivacyMaskCap(): void {
    const CAP_NAME = 'privacy-mask' as const
    const maxRegions = AmcrestCamera.PRIVACY_MASK_MAX_REGIONS
    const coordMax = AmcrestCamera.PRIVACY_COORD_MAX

    const refreshFromCamera = async (): Promise<void> => {
      if (this.privacyMaskRefreshInFlight) return this.privacyMaskRefreshInFlight
      const promise = (async () => {
        try {
          const client = this.ensureClient()
          // One round-trip for both halves: the mask slots AND the
          // per-profile microphone flags the `audioEnabled` summary needs.
          const table = await client.getConfigs(['PrivacyMasking', 'Encode'])
          const regions: PrivacyMaskRegion[] = []
          for (let i = 0; i < maxRegions; i++) {
            const prefix = `PrivacyMasking[0][${i}]`
            const enabled = table.get(`${prefix}.Enable`) === 'true'
            if (!enabled) continue
            const x = parseIntOrUndefined(table.get(`${prefix}.Rect[0]`)) ?? 0
            const y = parseIntOrUndefined(table.get(`${prefix}.Rect[1]`)) ?? 0
            const w = parseIntOrUndefined(table.get(`${prefix}.Rect[2]`)) ?? 0
            const h = parseIntOrUndefined(table.get(`${prefix}.Rect[3]`)) ?? 0
            regions.push({
              id: i,
              enabled: true,
              shape: {
                kind: 'rect',
                x: x / coordMax,
                y: y / coordMax,
                width: w / coordMax,
                height: h / coordMax,
              },
            })
          }
          // Per-profile microphone flags → the one answer the schema
          // promises. `some`, not `every` (a half-muted camera is still
          // audible), and an Encode read that carried no AudioEnable key
          // at all summarises to `null` — "no answer", never `false`.
          const audioProfiles = collectAudioEnableKeys(table).map((key) => ({
            audioEnabled: table.get(key) === 'true',
          }))
          const next: PrivacyMaskStatus = {
            enabled: regions.length > 0,
            regions,
            audioEnabled: summarisePrivacyAudio(audioProfiles),
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('amcrest: privacy-mask refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      })()
      this.privacyMaskRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.privacyMaskRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: privacyMaskCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      // The mask moves only when an operator moves it, and `setMask` below
      // re-reads the camera into this slice — so a write is its own
      // invalidation and the window only bounds a change made in the vendor
      // app. Served-and-revalidated because `getCameraStatuses` polls this cap
      // every 5s per camera and must never dial one on that path (D221).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      logger: this.ctx.logger,
      empty: (): PrivacyMaskStatus => ({
        enabled: false,
        // `null`, never `[]`, for the same reason `audioEnabled` is null on a
        // cold slice: a camera we have not asked must not report "no zones".
        // `[]` is a real answer and a consumer acts on it.
        regions: null,
        audioEnabled: null,
        lastFetchedAt: 0,
      }),
    })

    const provider: InferNativeProvider<typeof privacyMaskCapability> = {
      getStatus: bridge.getStatus,
      getOptions: async ({ deviceId }): Promise<PrivacyMaskOptions> => {
        // Audio mute verified live (2026-09-04): every
        // `Encode[0].*.AudioEnable` flag round-trips through the same
        // `setConfig` the mask writes use. A cold/mismatched deviceId
        // still answers `false` — a descriptor built without asking THIS
        // camera must not advertise a switch.
        const cold: PrivacyMaskOptions = {
          maxRegions,
          supportedShapes: ['rect'],
          supportsAudioMute: false,
        }
        if (deviceId !== this.id) return cold
        return { ...cold, supportsAudioMute: true }
      },
      setAudioEnabled: async ({ deviceId, enabled }): Promise<void> => {
        if (deviceId !== this.id) return
        const client = this.ensureClient()
        // Write EVERY profile slot the camera actually has — the keys are
        // discovered from a fresh Encode read, not enumerated, so a
        // firmware with more/fewer recording profiles stays covered and a
        // half-muted camera cannot survive the write.
        const encode = await client.getEncodeConfig()
        const keys = collectAudioEnableKeys(encode)
        if (keys.length === 0) {
          throw new Error(
            `device ${String(this.id)}: camera reported no Encode AudioEnable flags — microphone switch unavailable`,
          )
        }
        const params: Record<string, string> = {}
        for (const key of keys) params[key] = enabled ? 'true' : 'false'
        await client.setConfig(params)
        this.ctx.logger.info('amcrest: camera microphone flags written', {
          tags: { deviceId: this.id },
          meta: { enabled, profileCount: keys.length },
        })
        await refreshFromCamera()
      },
      setMask: async ({ deviceId, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        if (patch.regions === undefined) {
          // Only the master `enabled` flag changed — Dahua has no
          // single master switch, so map it onto every slot's Enable.
          if (patch.enabled !== undefined) {
            const params: Record<string, string> = {}
            for (let i = 0; i < maxRegions; i++) {
              params[`PrivacyMasking[0][${i}].Enable`] = patch.enabled ? 'true' : 'false'
            }
            const client = this.ensureClient()
            await client.setConfig(params)
            await refreshFromCamera()
          }
          return
        }
        // `patch.regions` is the FULL desired set (mirrors the
        // Hikvision provider's whole-list PUT semantics) — every slot
        // not present (or present with an unsupported 'polygon' shape)
        // is explicitly disabled so a removed region doesn't linger.
        const byId = new Map(patch.regions.map((r) => [r.id, r] as const))
        const params: Record<string, string | number> = {}
        for (let i = 0; i < maxRegions; i++) {
          const region = byId.get(i)
          const shape: PrivacyMaskShape | undefined = region?.shape
          if (region?.enabled && shape?.kind === 'rect') {
            params[`PrivacyMasking[0][${i}].Enable`] = 'true'
            params[`PrivacyMasking[0][${i}].Rect[0]`] = Math.round(shape.x * coordMax)
            params[`PrivacyMasking[0][${i}].Rect[1]`] = Math.round(shape.y * coordMax)
            params[`PrivacyMasking[0][${i}].Rect[2]`] = Math.round(shape.width * coordMax)
            params[`PrivacyMasking[0][${i}].Rect[3]`] = Math.round(shape.height * coordMax)
          } else {
            params[`PrivacyMasking[0][${i}].Enable`] = 'false'
            if (region?.enabled && shape?.kind === 'polygon') {
              this.ctx.logger.warn(
                'amcrest: privacy-mask polygon shape not supported — region disabled',
                {
                  tags: { deviceId: this.id },
                  meta: { regionId: i },
                },
              )
            }
          }
        }
        const client = this.ensureClient()
        await client.setConfig(params)
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(privacyMaskCapability, provider)
    this.ctx.logger.info('amcrest: privacy-mask cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── OSD cap ────────────────────────────────────────────────────────
  //
  // Dahua `VideoWidget[0]` table — verified live: `TimeTitle.EncodeBlend`
  // (timestamp), `ChannelTitle.EncodeBlend` (channel name — text is
  // firmware-owned, only visibility is exposed, mirroring the Hikvision
  // provider), and `CustomTitle[0..3].{EncodeBlend,Text}` (four free-text
  // overlay slots — this camera has two populated: a temperature and a
  // humidity reading pushed by another integration).

  private registerOsdCap(): void {
    const provider: InferNativeProvider<typeof osdCapability> = {
      getStatus: async ({ deviceId }): Promise<OsdStatus> => {
        if (deviceId !== this.id) {
          throw new Error(
            `AmcrestCamera: osd deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const client = this.ensureClient()
        const table = await client.getConfig('VideoWidget')
        const overlays: OsdOverlay[] = []
        overlays.push({
          id: 'dateTime',
          kind: 'timestamp',
          enabled: table.get('VideoWidget[0].TimeTitle.EncodeBlend') === 'true',
          availablePositions: [],
          readOnly: true,
        })
        overlays.push({
          id: 'channelName',
          kind: 'text',
          enabled: table.get('VideoWidget[0].ChannelTitle.EncodeBlend') === 'true',
          text: this.name,
          availablePositions: [],
          readOnly: true,
        })
        for (let i = 0; i < 4; i++) {
          const prefix = `VideoWidget[0].CustomTitle[${i}]`
          overlays.push({
            id: `text-${i}`,
            kind: 'text',
            enabled: table.get(`${prefix}.EncodeBlend`) === 'true',
            text: table.get(`${prefix}.Text`) ?? '',
            availablePositions: [],
          })
        }
        return { overlays }
      },
      setOverlay: async ({ deviceId, overlayId, patch }) => {
        if (deviceId !== this.id) return
        const client = this.ensureClient()
        if (overlayId === 'dateTime') {
          if (patch.enabled === undefined) return
          await client.setConfig({
            'VideoWidget[0].TimeTitle.EncodeBlend': patch.enabled ? 'true' : 'false',
          })
          return
        }
        if (overlayId === 'channelName') {
          if (patch.enabled === undefined) return
          await client.setConfig({
            'VideoWidget[0].ChannelTitle.EncodeBlend': patch.enabled ? 'true' : 'false',
          })
          return
        }
        if (overlayId.startsWith('text-')) {
          const i = Number.parseInt(overlayId.slice('text-'.length), 10)
          if (!Number.isFinite(i) || i < 0 || i > 3) return
          const prefix = `VideoWidget[0].CustomTitle[${i}]`
          const params: Record<string, string> = {}
          if (patch.enabled !== undefined)
            params[`${prefix}.EncodeBlend`] = patch.enabled ? 'true' : 'false'
          if (patch.text !== undefined) params[`${prefix}.Text`] = patch.text
          if (Object.keys(params).length === 0) return
          await client.setConfig(params)
        }
      },
    }
    this.ctx.registerNativeCap(osdCapability, provider)
    this.ctx.logger.info('amcrest: osd cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── Day/night cap ──────────────────────────────────────────────────
  //
  // Dahua `VideoInDayNight[0][0]` table — every mapping verified live
  // against the IP4M-1041B on 2026-09-04 (see `dahua-mappings.ts` + its
  // spec for the evidence): `Mode` is a VALIDATED enum of exactly
  // `Color` (force day) / `Brightness` (auto) / `BlackWhite` (force
  // night — snapshot went grayscale); `Photoresistor` is rejected with
  // HTTP 400. `Sensitivity` accepts 0..7 (8 → 400). `Delay` accepts
  // 2..10 seconds (1 and 11 → 400). The previous constants (max 3 /
  // 600 s) were doc-sheet guesses: the sensitivity map compressed the
  // slider's top half into one native step, and any delay above 10 s
  // made the whole multi-key write fail.

  private registerDayNightCap(): void {
    const CAP_NAME = 'day-night' as const
    const STALE_MS = 10_000

    const refreshFromCamera = async (): Promise<void> => {
      if (this.dayNightRefreshInFlight) return this.dayNightRefreshInFlight
      const promise = (async () => {
        try {
          const client = this.ensureClient()
          const table = await client.getConfig('VideoInDayNight')
          const sensitivityNative = parseIntOrUndefined(
            table.get('VideoInDayNight[0][0].Sensitivity'),
          )
          const delaySec = parseIntOrUndefined(table.get('VideoInDayNight[0][0].Delay'))
          const next: DayNightStatus = {
            mode: amcrestDayNightModeToCap(table.get('VideoInDayNight[0][0].Mode')),
            lastFetchedAt: Date.now(),
          }
          if (sensitivityNative !== undefined) {
            next.sensitivity = dayNightSensitivityToPercent(sensitivityNative)
          }
          if (delaySec !== undefined) next.switchDelaySec = delaySec
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('amcrest: day-night refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      })()
      this.dayNightRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.dayNightRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: dayNightCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      staleMs: STALE_MS,
      logger: this.ctx.logger,
      empty: (): DayNightStatus => ({ mode: 'auto', lastFetchedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof dayNightCapability> = {
      getStatus: bridge.getStatus,
      getOptions: async ({ deviceId }): Promise<DayNightOptions> => {
        const cold: DayNightOptions = {
          modes: [],
          supportsSensitivity: false,
          supportsSwitchDelay: false,
        }
        if (deviceId !== this.id) return cold
        // Three verified modes (Color/Brightness/BlackWhite) — no
        // `schedule`: the doc-sheet `Photoresistor` token is rejected by
        // this firmware and the `VideoInMode` time-section machinery is
        // a different mechanism.
        return {
          modes: ['auto', 'day', 'night'],
          supportsSensitivity: true,
          sensitivity: { min: 0, max: 100, step: 1 },
          supportsSwitchDelay: true,
          switchDelaySec: {
            min: DAY_NIGHT_DELAY_MIN_SEC,
            max: DAY_NIGHT_DELAY_MAX_SEC,
            step: 1,
          },
        }
      },
      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        const params: Record<string, string | number> = {}
        if (settings.mode !== undefined) {
          const nativeMode = capDayNightModeToAmcrest(settings.mode)
          if (nativeMode === undefined) {
            // `schedule` — no verified Dahua token exists on this firmware.
            this.ctx.logger.warn('amcrest: day-night mode has no verified Dahua token — ignored', {
              tags: { deviceId: this.id },
              meta: { requestedMode: settings.mode },
            })
          } else {
            params['VideoInDayNight[0][0].Mode'] = nativeMode
          }
        }
        if (settings.sensitivity !== undefined) {
          params['VideoInDayNight[0][0].Sensitivity'] = percentToDayNightSensitivity(
            settings.sensitivity,
          )
        }
        if (settings.switchDelaySec !== undefined) {
          // Clamp into the firmware's 2..10 s window — an out-of-window
          // value 400s the WHOLE multi-key write, silently dropping the
          // other fields in the same save.
          params['VideoInDayNight[0][0].Delay'] = clampDayNightDelaySec(settings.switchDelaySec)
        }
        if (Object.keys(params).length > 0) {
          const client = this.ensureClient()
          await client.setConfig(params)
        }
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(dayNightCapability, provider)
    this.ctx.logger.info('amcrest: day-night cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── Image-settings cap ─────────────────────────────────────────────
  //
  // Six Dahua tables feed this cap, read in ONE multi-name `getConfig`
  // round-trip. Everything below was verified live on the IP4M-1041B
  // (2026-09-04); the enum/int maps live in `dahua-mappings.ts` with
  // per-value evidence in its spec:
  //
  //   - `VideoColor[0][0].{Brightness,Contrast,Saturation}` — native
  //     0-100, identity mapping. `[0][0]` is the always-active profile.
  //   - `VideoInSharpness[0][0].Sharpness` — validated 0-100 (101 → 400).
  //   - `VideoInOptions[0].{Mirror,Flip}` — validated booleans
  //     (`Mirror=bogus` → 400).
  //   - `VideoImageControl[0].Rotate90` — 0/1/2; `=1` proven
  //     functionally (snapshot flipped to 1440×2560). No native 180°.
  //   - `VideoInExposure[0][0].Mode` — validated int; 0=auto, 4=manual
  //     (manual proven functionally: 1 ms exposure → near-black frame).
  //   - `VideoInBacklight[0][0].Mode` — Off/Backlight/WideDynamic/
  //     GlareInhibition (BLC proven via the `VideoInOptions[0].Backlight`
  //     mirror, WDR proven via snapshot, HLC via the intensity mirror +
  //     `devVideoInput getCaps GlareInhibition=1`). The field is NOT
  //     validated on-camera, so reads tolerate unknown stored tokens.
  //
  //   White balance stays UNSUPPORTED deliberately: every
  //   `VideoInWhiteBalance[0][0].Mode` token (and a bogus one) is stored
  //   verbatim, and a functional test — `Custom` with GainRed=100 /
  //   GainGreen=0 / GainBlue=100 — produced NO color cast in the
  //   snapshot. The table is dead storage on this firmware; a warmth
  //   slider wired to it would be the classic control-that-writes-nothing.

  private registerImageSettingsCap(): void {
    const CAP_NAME = 'image-settings' as const
    const STALE_MS = 10_000
    const NORMALIZED_RANGE = { min: 0, max: 100, step: 1 } as const

    const refreshFromCamera = async (): Promise<void> => {
      if (this.imageSettingsRefreshInFlight) return this.imageSettingsRefreshInFlight
      const promise = (async () => {
        try {
          const client = this.ensureClient()
          const table = await client.getConfigs([
            'VideoColor',
            'VideoInSharpness',
            'VideoInOptions',
            'VideoImageControl',
            'VideoInExposure',
            'VideoInBacklight',
          ])
          const brightness = parseIntOrUndefined(table.get('VideoColor[0][0].Brightness'))
          const contrast = parseIntOrUndefined(table.get('VideoColor[0][0].Contrast'))
          const saturation = parseIntOrUndefined(table.get('VideoColor[0][0].Saturation'))
          const sharpness = parseIntOrUndefined(table.get('VideoInSharpness[0][0].Sharpness'))
          const mirror = parseBoolOrUndefined(table.get('VideoInOptions[0].Mirror'))
          const flip = parseBoolOrUndefined(table.get('VideoInOptions[0].Flip'))
          const rotate = amcrestRotateToCap(
            parseIntOrUndefined(table.get('VideoImageControl[0].Rotate90')),
          )
          const exposureMode = amcrestExposureModeToCap(
            parseIntOrUndefined(table.get('VideoInExposure[0][0].Mode')),
          )
          const backlightMode = amcrestBacklightToCap(table.get('VideoInBacklight[0][0].Mode'))
          if (brightness === undefined && contrast === undefined && saturation === undefined) return
          const next: ImageSettingsStatus = {
            ...(brightness !== undefined ? { brightness } : {}),
            ...(contrast !== undefined ? { contrast } : {}),
            ...(saturation !== undefined ? { saturation } : {}),
            ...(sharpness !== undefined ? { sharpness } : {}),
            ...(mirror !== undefined ? { mirror } : {}),
            ...(flip !== undefined ? { flip } : {}),
            ...(rotate !== undefined ? { rotate } : {}),
            ...(exposureMode !== undefined ? { exposureMode } : {}),
            ...(backlightMode !== undefined ? { backlightMode } : {}),
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('amcrest: image-settings refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      })()
      this.imageSettingsRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.imageSettingsRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: imageSettingsCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      staleMs: STALE_MS,
      logger: this.ctx.logger,
      empty: (): ImageSettingsStatus => ({ lastFetchedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof imageSettingsCapability> = {
      getStatus: bridge.getStatus,
      getOptions: async ({ deviceId }): Promise<ImageSettingsOptions> => {
        const cold: ImageSettingsOptions = {
          supportsBrightness: false,
          supportsContrast: false,
          supportsSaturation: false,
          supportsSharpness: false,
          supportsMirror: false,
          supportsFlip: false,
          rotateOptions: [],
          whiteBalanceModes: [],
          supportsWarmth: false,
          exposureModes: [],
          backlightModes: [],
        }
        if (deviceId !== this.id) return cold
        return {
          ...cold,
          supportsBrightness: true,
          brightness: NORMALIZED_RANGE,
          supportsContrast: true,
          contrast: NORMALIZED_RANGE,
          supportsSaturation: true,
          saturation: NORMALIZED_RANGE,
          supportsSharpness: true,
          sharpness: NORMALIZED_RANGE,
          supportsMirror: true,
          supportsFlip: true,
          // No '180' — Dahua's Rotate90 has no native 180° (the vendor
          // UI composes mirror+flip for it).
          rotateOptions: ['0', '90', '270'],
          exposureModes: ['auto', 'manual'],
          backlightModes: ['off', 'blc', 'wdr', 'hlc'],
          // whiteBalanceModes stays [] — see the section doc: the WB
          // table is stored-but-dead on this firmware (functionally
          // disproven with a zero-green-gain snapshot).
        }
      },
      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        const params: Record<string, string | number> = {}
        if (settings.brightness !== undefined)
          params['VideoColor[0][0].Brightness'] = settings.brightness
        if (settings.contrast !== undefined) params['VideoColor[0][0].Contrast'] = settings.contrast
        if (settings.saturation !== undefined)
          params['VideoColor[0][0].Saturation'] = settings.saturation
        if (settings.sharpness !== undefined)
          params['VideoInSharpness[0][0].Sharpness'] = settings.sharpness
        if (settings.mirror !== undefined)
          params['VideoInOptions[0].Mirror'] = settings.mirror ? 'true' : 'false'
        if (settings.flip !== undefined)
          params['VideoInOptions[0].Flip'] = settings.flip ? 'true' : 'false'
        if (settings.rotate !== undefined) {
          const native = capRotateToAmcrest(settings.rotate)
          if (native === undefined) {
            // '180' — no verified native. Skip rather than store a
            // meaningless int the firmware would keep verbatim.
            this.ctx.logger.warn('amcrest: rotate value has no Dahua equivalent — ignored', {
              tags: { deviceId: this.id },
              meta: { requestedRotate: settings.rotate },
            })
          } else {
            params['VideoImageControl[0].Rotate90'] = native
          }
        }
        if (settings.exposureMode !== undefined)
          params['VideoInExposure[0][0].Mode'] = capExposureModeToAmcrest(settings.exposureMode)
        if (settings.backlightMode !== undefined)
          params['VideoInBacklight[0][0].Mode'] = capBacklightToAmcrest(settings.backlightMode)
        // whiteBalance / warmth: not wired — the Dahua WB table stores
        // values without applying them on this firmware (see section doc).
        if (Object.keys(params).length > 0) {
          const client = this.ensureClient()
          await client.setConfig(params)
        }
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(imageSettingsCapability, provider)
    this.ctx.logger.info('amcrest: image-settings cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── recording-onboard cap ──────────────────────────────────────────

  /**
   * Register the vendor-neutral `recording-onboard` cap.
   *
   * The camera's own card and the camera's own schedule — not CamStack's
   * recorder. The whole surface rides the existing digest CGI client:
   * `storageDevice.cgi?action=getDeviceAllInfo` serves the card,
   * `configManager.cgi` serves `Record` / `RecordMode` / `MediaGlobal` /
   * `StorageGroup` / `MotionDetect`, and `recordManager.cgi` +
   * `eventManager.cgi` serve the limits. No RPC2 session is needed.
   *
   * Writes follow D610 whole, and this firmware earns every word of it:
   *
   *   - **Refused before the wire**, against what the camera STATED —
   *     because `PacketLength=99` and `RecordLatch=999` were both stored
   *     although the camera's own caps forbid them.
   *   - **One request per config TABLE**, because a `setConfig` naming
   *     two answers `200 OK` and applies only the first.
   *   - **Verified after it by re-reading**, per field. Success is the
   *     read-back agreeing, never the absence of a thrown error — the
   *     body reads `Error` under HTTP 200 when a key is refused.
   */
  private registerRecordingOnboardCap(): void {
    const CAP_NAME = 'recording-onboard' as const
    // Dahua config tables are 0-based; `this.channel` is the 1-based
    // stream channel the schema carries.
    const configChannel = Math.max(0, this.channel - 1)

    const emptyStatus = (): RecordingOnboardStatus => ({
      storage: { kind: 'unknown', reason: 'CamStack has not read this camera yet.' },
      tracks: [],
      primaryTrackId: null,
      enabled: null,
      overwriteWhenFull: null,
      preRecordSec: null,
      postRecordSec: null,
      segmentMinutes: null,
      windows: [],
      unreadableWindows: 0,
      recordingToNowhere: false,
      lastFetchedAt: 0,
    })

    /** The camera's own statement of what it accepts. */
    let lastLimits: AmcrestRecordLimits = {
      maxPreRecordSec: null,
      packetLengthMinutes: null,
      recordLatchSec: null,
    }
    /** How many event handlers hold a post-record, and whether they agree. */
    let lastPostRecord: { handlers: number; disagree: boolean } = {
      handlers: 0,
      disagree: false,
    }
    /** `RecordMode[ch].Mode`, so turning recording back ON can preserve `manual`. */
    let lastRecordMode: number | null = null
    /** Which `StorageGroup` row is the local card. */
    let lastStorageGroupIndex: number | null = null

    /** Read every table this cap needs. A table that failed is null, never empty. */
    const readAll = async (): Promise<AmcrestOnboardReads> => {
      const client = this.ensureClient()
      const [storageTable, record, recordMode, mediaGlobal, storageGroup, motionDetect] =
        await Promise.all([
          client.getStorageDeviceAllInfo().catch(() => null),
          client.getConfig('Record').catch(() => null),
          client.getConfig('RecordMode').catch(() => null),
          client.getConfig('MediaGlobal').catch(() => null),
          client.getConfig('StorageGroup').catch(() => null),
          client.getConfig('MotionDetect').catch(() => null),
        ])
      return {
        // A read that FAILED is `unknown`, never folded into "no card"
        // (D393) — that is the difference between a camera with no card
        // and a camera that did not answer.
        storage:
          storageTable === null
            ? { kind: 'unknown', reason: 'The camera did not answer the storage read.' }
            : parseOnboardStorage(storageTable),
        record,
        recordMode,
        mediaGlobal,
        storageGroup,
        motionDetect,
        channel: configChannel,
      }
    }

    const applyReads = (reads: AmcrestOnboardReads): RecordingOnboardStatus => {
      lastRecordMode =
        reads.recordMode === null
          ? null
          : Number(reads.recordMode.get(`RecordMode[${String(configChannel)}].Mode`) ?? Number.NaN)
      if (lastRecordMode !== null && !Number.isFinite(lastRecordMode)) lastRecordMode = null
      lastStorageGroupIndex =
        reads.storageGroup === null ? null : findLocalStorageGroup(reads.storageGroup)
      const post = readPostRecordSec(reads.motionDetect)
      lastPostRecord = { handlers: post.handlers, disagree: post.disagree }
      return buildOnboardStatus({ reads, now: Date.now() })
    }

    const refreshFromCamera = async (): Promise<void> => {
      if (this.recordingOnboardRefreshInFlight) return this.recordingOnboardRefreshInFlight
      const promise = (async () => {
        try {
          const client = this.ensureClient()
          const [reads, recordCaps, eventCaps] = await Promise.all([
            readAll(),
            client.getRecordManagerCaps().catch(() => null),
            client.getEventManagerCaps().catch(() => null),
          ])
          lastLimits = parseRecordLimits({ recordCaps, eventCaps })
          const next = applyReads(reads)
          this.runtimeState.setCapState(CAP_NAME, next)

          if (next.recordingToNowhere) {
            this.ctx.logger.warn(
              'amcrest onboard recording: camera is scheduled to record and has no usable storage',
              {
                tags: { deviceId: this.id },
                meta: { windows: next.windows.length, unreadable: next.unreadableWindows },
              },
            )
          }
          if (next.unreadableWindows > 0) {
            this.ctx.logger.warn(
              'amcrest onboard recording: some schedule slots could not be read — the schedule shown is incomplete and cannot be written',
              {
                tags: { deviceId: this.id },
                meta: {
                  unreadableWindows: next.unreadableWindows,
                  readWindows: next.windows.length,
                },
              },
            )
          }
        } catch (err) {
          this.ctx.logger.debug('amcrest onboard recording refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      })()
      this.recordingOnboardRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.recordingOnboardRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: recordingOnboardCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      logger: this.ctx.logger,
      empty: emptyStatus,
    })

    const readOptions = (): RecordingOnboardOptions =>
      buildOnboardOptions({
        status: this.runtimeState.getCapState<RecordingOnboardStatus>(CAP_NAME) ?? null,
        limits: lastLimits,
        postRecord: lastPostRecord,
      })

    const provider: InferNativeProvider<typeof recordingOnboardCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<RecordingOnboardOptions> => {
        if (deviceId !== this.id) {
          throw new Error(`AmcrestCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        await bridge.ensureFresh()
        return readOptions()
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        // Nothing asked for is nothing refused.
        if (Object.keys(settings).length === 0) return

        // Options come from the LAST read. Refusing against a slice we
        // never filled would refuse everything on a camera that is
        // merely cold, so the read comes first.
        await bridge.ensureFresh()
        const refusal =
          describeOnboardRefusal(readOptions(), settings) ??
          (settings.windows === undefined ? null : describeAmcrestScheduleRefusal(settings.windows))
        if (refusal !== null) {
          this.ctx.logger.warn(
            'amcrest onboard recording: refusing a write this camera cannot take',
            { tags: { deviceId: this.id }, meta: { refusal, fields: Object.keys(settings) } },
          )
          throw new Error(`device ${String(this.id)}: ${refusal}`)
        }

        const writes = buildOnboardWrites(settings, {
          channel: configChannel,
          recordMode: lastRecordMode,
          storageGroupIndex: lastStorageGroupIndex,
        })
        const client = this.ensureClient()

        // One request PER TABLE: a setConfig naming two answers 200 OK
        // and applies only the first. Every verdict is collected — a
        // table that landed must not be hidden by one that did not.
        const rejected: string[] = []
        for (const write of writes) {
          try {
            await client.setConfig(write.params)
          } catch (err) {
            rejected.push(`${write.table}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // The camera changed, so the slice is stale whatever the verdict
        // was — including a PARTIAL one, which is the case that most
        // needs the UI to show what really landed.
        const after = await readAll()
        this.runtimeState.setCapState(CAP_NAME, applyReads(after))

        // Success is the READ-BACK agreeing, never the absence of an
        // error. Every key that was written is re-read from the table it
        // belongs to and compared to what was asked.
        const byTable: Readonly<Record<string, ReadonlyMap<string, string> | null>> = {
          Record: after.record,
          RecordMode: after.recordMode,
          MediaGlobal: after.mediaGlobal,
          StorageGroup: after.storageGroup,
          MotionDetect: after.motionDetect,
        }
        const discarded: string[] = []
        for (const write of writes) {
          const table = byTable[write.table] ?? null
          if (table === null) {
            discarded.push(`${write.table}: the camera would not say what it stored`)
            continue
          }
          for (const [field, check] of Object.entries(write.verify)) {
            const stored = table.get(check.key)
            if (stored === check.expect) continue
            discarded.push(`${field}: asked ${check.expect}, camera holds ${stored ?? '(nothing)'}`)
          }
        }

        if (rejected.length > 0 || discarded.length > 0) {
          this.ctx.logger.warn(
            'amcrest onboard recording: the camera did not keep part of the write',
            {
              tags: { deviceId: this.id },
              meta: { rejected, discarded, fields: Object.keys(settings) },
            },
          )
          throw new Error(
            `device ${String(this.id)}: the camera kept its own values — ${[...rejected, ...discarded].join('; ')}`,
          )
        }
        this.ctx.logger.info('amcrest onboard recording: write applied and verified', {
          tags: { deviceId: this.id },
          meta: { fields: Object.keys(settings), requests: writes.length },
        })
      },
    }

    this.ctx.registerNativeCap(recordingOnboardCapability, provider)
    this.ctx.logger.info('amcrest: recording-onboard cap registered', {
      tags: { deviceId: this.id },
    })
  }
}

/** Normalize Dahua's `Video.Compression` string (`'H.264'`, `'H.265'`,
 *  `'MJPG'`, …) into the cap's `'h264' | 'h265'` enum. Returns
 *  `undefined` for unrecognized / absent codecs. */
function mapAmcrestCodec(raw: string | null): 'h264' | 'h265' | undefined {
  if (!raw) return undefined
  const normalized = raw.toLowerCase().replace(/[.\s-]/g, '')
  if (normalized === 'h265' || normalized === 'hevc') return 'h265'
  if (normalized === 'h264' || normalized === 'avc') return 'h264'
  return undefined
}

function parseIntOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function parseBoolOrUndefined(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

/**
 * Every `Encode[0].*.AudioEnable` key present in an `Encode` table read
 * — the per-profile microphone flags (`MainFormat[0..2]` +
 * `ExtraFormat[0..2]` on the IP4M-1041B, but the slot count is
 * firmware-defined so the keys are DISCOVERED, never enumerated).
 * Feeds `summarisePrivacyAudio` on the read path and names the exact
 * keys the mute write must cover.
 */
function collectAudioEnableKeys(table: ReadonlyMap<string, string>): readonly string[] {
  const out: string[] = []
  for (const key of table.keys()) {
    if (/^Encode\[0\]\.(?:MainFormat|ExtraFormat)\[\d+\]\.AudioEnable$/.test(key)) out.push(key)
  }
  return out.toSorted()
}

export { AMCREST_ADDON_ID, amcrestCameraSchema } from './schema.js'
