import type {
  CamStreamDescriptor,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  ICameraDevice,
  InferNativeProvider,
  PtzHomePreset,
  RawStateResult,
  RecordingOnboardOptions,
  RecordingOnboardStatus,
  StreamSourceEntry,
  Timezone,
  Weekday,
} from '@camstack/types'
import {
  ACCESSORY_LABEL,
  type AccessoryChildSpec,
  AccessoryKind,
  type AccessoryKindValue,
  type BacklightMode,
  BaseDevice,
  buildDeviceAdminUrl,
  buildStreamParamsConfigSchema,
  createEvent,
  createRuntimeStateBridge,
  type DayNightMode,
  type DayNightOptions,
  type DayNightStatus,
  DeviceFeature,
  DeviceType,
  dayNightCapability,
  describeOnboardClamp,
  describeOnboardRefusal,
  deviceAdminLinkCapability,
  deviceCustomAction,
  EventCategory,
  findTimezone,
  hubMotionNativeProvider,
  hydrateSchema,
  type ImageSettingsOptions,
  type ImageSettingsStatus,
  type IntercomAbility,
  imageSettingsCapability,
  intercomCapability,
  type MaskPoint,
  type MotionZoneOptions,
  type MotionZoneStatus,
  motionCapability,
  motionZonesCapability,
  OPERATOR_WRITTEN_STALE_MS,
  type OsdOverlay,
  type OsdStatus,
  osdCapability,
  type PrivacyMaskOptions,
  type PrivacyMaskRegion,
  type PrivacyMaskShape,
  type PrivacyMaskStatus,
  type PtzAutotrackRuntimeState,
  type PtzAutotrackSettings,
  type PtzAutotrackStatus,
  privacyMaskCapability,
  providerMotionEvent,
  ptzAutotrackCapability,
  ptzCapability,
  type ReachabilityPollHandle,
  RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS,
  rebootCapability,
  recordingOnboardCapability,
  type StreamParamsOptions,
  type StreamParamsStatus,
  type StreamProfile,
  type StreamProfilePatch,
  snapshotCapability,
  startReachabilityPoll,
  streamCatalogCapability,
  streamParamsCapability,
  summarisePrivacyAudio,
  TIMEZONES,
  userError,
} from '@camstack/types'
import { z } from 'zod'
import {
  createAccessoryDevice,
  type HikvisionLightHost,
  type HikvisionSirenHost,
} from './accessories/index.js'
import { findFreePresetSlot, HOME_PRESET_NAME } from './free-preset-slot.js'
import { type AlarmIngressLog, createAlarmIngressLog } from './hikvision-alarm-ingress-log.js'
import { type AlarmTypeTally, createAlarmTypeTally } from './hikvision-alarm-tally.js'
import { resolveProbedFps } from './hikvision-channel-fps.js'
import {
  type HikvisionAlarmEvent,
  HikvisionIsapiClient,
  type HikvisionOverlayConfig,
  type HikvisionPrivacyMaskRegion,
  type HikvisionStreamingChannel,
  type HikvisionStreamingChannelConfig,
  isHikvisionSmartAlarmType,
  subscribeAlarms,
} from './hikvision-isapi-client.js'
import {
  buildSnapshotChannelOptions,
  defaultSnapshotChannelId,
  resolveSnapshotChannelId,
  type SnapshotChannelDescriptor,
} from './hikvision-snapshot-channel.js'
import { classifyAudioWrite } from './hikvision-stream-audio.js'
import { HikvisionIntercomSession } from './intercom/hikvision-intercom-session.js'
import {
  intercomFailureReport,
  REASON_TALK_CODEC_UNSUPPORTED,
  REASON_TALK_EMPTY,
  REASON_TALK_NO_SAMPLE_RATE,
  REASON_TALK_NOT_MONO,
  REASON_TALK_OPUS_FAILED,
  REASON_TALK_OUT_OF_ORDER,
} from './intercom/intercom-failure-report.js'
import {
  type IntercomAudioCodecApi,
  IntercomOrchestrator,
} from './intercom/intercom-orchestrator.js'
import { TalkPcmTranscoder } from './intercom/talk-pcm-transcoder.js'
import { WeriftIntercomPeer } from './intercom/werift-intercom-peer.js'
import { isapiSpeedFor, PTZ_MOVE_IMPULSE_MS } from './isapi-ptz-speed.js'
import { populateHikvisionMetadata } from './metadata-populator.js'
import {
  assertPresetWritable,
  isPresetWritable,
  presetFunctionFor,
} from './ptz-preset-functions.js'
import { buildRawState } from './raw-state.js'
import {
  applyOnboardPatchToTrackXml,
  buildOnboardOptions,
  buildOnboardStatus,
  parseOnboardStorage,
  parseRecordTracks,
} from './recording-onboard-mapping.js'
import {
  DEFAULT_CAMERA_NUMBER,
  HIKVISION_ADDON_ID,
  HIKVISION_AI_CLASS_MAP,
  type HikvisionCameraConfig,
  type HikvisionDeviceCache,
  type HikvisionImageSnapshot,
  type HikvisionLightSnapshot,
  type HikvisionNtpSnapshot,
  hikvisionCameraSchema,
} from './schema.js'

/**
 * Narrow shape of the `audio-codec` cap router off `ctx.api`. We
 * keep the type local so the file doesn't depend on the generated
 * router types — only the four methods the intercom orchestrator
 * actually invokes.
 */
interface AudioCodecRouterShape {
  createDecodeSession: {
    mutate: (input: {
      codec: string
      sourceSampleRate: number
      sourceChannels: number
      targetSampleRate: number
      targetChannels: number
      targetFormat?: 'f32le' | 's16le'
      tag?: string
    }) => Promise<{ sessionId: string; nodeId: string }>
  }
  pushEncodedFrame: {
    mutate: (input: {
      sessionId: string
      nodeId?: string
      data: Uint8Array
      pts?: number
    }) => Promise<void>
  }
  pullPcm: {
    query: (input: {
      sessionId: string
      nodeId?: string
      maxCount: number
    }) => Promise<
      readonly { data: Uint8Array; sampleRate: number; channels: number; pts: number }[]
    >
  }
  closeSession: { mutate: (input: { sessionId: string; nodeId?: string }) => Promise<void> }
}

export {
  HIKVISION_ADDON_ID,
  hikvisionCameraSchema,
} from './schema.js'

/**
 * Bound an ISAPI round-trip so a slow/unreachable camera can't leave a
 * caller (the broker's catalog pull) awaiting forever. Rejects after
 * `ms`; the catalog build's try/catch turns that into an empty catalog +
 * a broker retry next tick instead of a permanent stall. Mirrors the
 * Reolink provider + the broker-side `withCatalogTimeout` guard.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Hikvision's `IrcutFilterType` enumerates the same four values as the
 * `day-night` cap's `DayNightMode` — no value mapping needed, only a
 * type-narrowing guard for the loosely-typed ISAPI response.
 */
const HIKVISION_DAY_NIGHT_MODES: readonly DayNightMode[] = ['auto', 'day', 'night', 'schedule']

function isDayNightMode(mode: string): mode is DayNightMode {
  return mode === 'auto' || mode === 'day' || mode === 'night' || mode === 'schedule'
}

/** Narrow the ISAPI `IrcutFilterType` string to `DayNightMode`, falling
 *  back to `'auto'` for any value outside the known enum (defensive —
 *  firmware is not expected to emit anything else). */
function toDayNightMode(mode: string): DayNightMode {
  return isDayNightMode(mode) ? mode : 'auto'
}

/** One published broker stream for this camera. */
interface PublishedStream {
  readonly camStreamId: string
  readonly channel: HikvisionStreamingChannel
  readonly rtspUrl: string
}

/**
 * Hikvision camera device — ISAPI control channel for snapshot, reboot,
 * and the alarm event stream; RTSP URLs handed to the broker for video
 * pull (the broker handles the actual TCP/UDP RTSP, codec negotiation,
 * and re-broadcast — same model as `RtspCamera`).
 *
 * v0.1 surface:
 *   - `snapshot` cap → ISAPI `/Streaming/channels/{id}/picture`
 *   - `reboot` cap → ISAPI `/System/reboot`
 *   - `motion` cap → emitted from the alarm-stream parser
 *   - Stream broker publish for every channel reported by
 *     `/Streaming/channels` (kind: `pull-rtsp`)
 *
 * Deferred (v0.2+, see plugin README):
 *   - Supplemental light (`/ISAPI/Image/channels/{id}/supplementLight`)
 *   - Siren via GPIO (`/ISAPI/System/IO/inputs/{port}`)
 *   - PTZ (`/ISAPI/PTZCtrl/channels/{id}/...`)
 *   - Two-way audio (intercom) — needs RTP relay support
 */
export class HikvisionCamera
  extends BaseDevice<typeof hikvisionCameraSchema>
  implements ICameraDevice, HikvisionLightHost, HikvisionSirenHost
{
  readonly type = DeviceType.Camera as const

  /**
   * Features derived from the persisted `deviceCache` probe — surfaced
   * via `device-manager.getDevice`. Conservative by default: we only
   * report capabilities the device claimed during the last successful
   * probe (no default-on for accessory caps that may not be wired).
   */
  get features(): readonly DeviceFeature[] {
    const cfg = this.config.get('deviceCache')
    const out: DeviceFeature[] = [DeviceFeature.NativeSnapshot, DeviceFeature.Rebootable]
    if (cfg?.hasPtz === true) out.push(DeviceFeature.PanTiltZoom)
    if (cfg?.hasAutotrack === true) out.push(DeviceFeature.PtzAutotrack)
    if (this.intercomEnabled()) out.push(DeviceFeature.TwoWayAudio)
    return out
  }

  /**
   * Opt-in raw-state surface for the device State panel's "Raw" toggle:
   * the device's cached upstream state as `{ source:'hikvision', data }`,
   * secrets redacted, or `null` when nothing has been cached yet. Reads
   * only the in-memory runtime-state cache — no camera round-trip.
   */
  async getRawState(): Promise<RawStateResult | null> {
    return buildRawState(this.runtimeState)
  }

  /** Resolve the operator-visible intercom mode → enabled bool.
   *  `auto` requires a positive probe (`hasIntercom`), `'isapi'` always
   *  enables (operator override for cameras whose channel list 404s but
   *  accept audioData writes), `'off'` disables outright. `'onvif'` is
   *  reserved for Phase 2 — treated as `'off'` until we land the
   *  backchannel path. */
  private intercomEnabled(): boolean {
    const mode = this.config.get('twoWayAudioMode') ?? 'auto'
    if (mode === 'off' || mode === 'onvif') return false
    if (mode === 'isapi') return true
    // auto: probe-driven
    return this.config.get('deviceCache')?.hasIntercom === true
  }

  /** Idempotent guard for the `ptz-autotrack` cap. */
  private ptzAutotrackRegistered = false
  /** Idempotent guard for the `intercom` cap. */
  private intercomRegistered = false
  /**
   * Active intercom orchestrator. The `intercom` cap is `singleton`-mode
   * device-scoped — at most one talk session is open per camera at a
   * time. Lazy-built on first `startSession`; reused for the device's
   * lifetime (the orchestrator's own single-active-session guard
   * handles repeated starts). `null` when never opened.
   */
  private intercomOrchestrator: IntercomOrchestrator | null = null
  /**
   * Active raw-PCM talk session (opened by `startTalkSession` for
   * non-WebRTC consumers — HomeKit, Alexa raw audio, etc.). Mutually
   * exclusive with the WebRTC orchestrator session above.
   */
  private intercomRawSession: {
    readonly id: string
    readonly session: HikvisionIntercomSession
    lastSequenceNumber: number
    /**
     * Lazy-created `audio-codec` decode session for the encoded-codec
     * (`opus`, future: `aac`) path of `pushTalkAudio`. Null until the
     * first frame arrives that needs decoding. Closed on `endTalkSession`.
     */
    opusDecode: { sessionId: string; nodeId: string } | null
    /**
     * Rate conversion for the RAW-PCM path — same lazy/keyed/torn-down
     * discipline as `opusDecode`, and the reason an 8 kHz camera no longer
     * drops the 22 050 Hz frames HomeKit / Alexa / a TTS engine push at it
     * (D281). Constructed with the talk session so its teardown cannot be
     * forgotten; it opens nothing until a frame actually needs converting.
     */
    readonly pcmTranscode: TalkPcmTranscoder
  } | null = null
  /** Single-flight guard for the autotrack camera refresh. */
  private autotrackRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the stream-params camera refresh. */
  private streamParamsRefreshInFlight: Promise<void> | null = null

  private motionZonesRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the privacy-mask camera refresh. */
  private privacyMaskRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the day-night camera refresh. */
  private dayNightRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the image-settings camera refresh. */
  private imageSettingsRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the onboard-recording camera refresh. */
  private recordingOnboardRefreshInFlight: Promise<void> | null = null

  /**
   * Single-flight guard for the v0.2 capability discovery probe. Reset
   * on settings patches that change credentials (`disconnectAll`) so
   * the next probe runs against the fresh client.
   */
  private accessoryCapsProbed = false

  /** Lazy-built ISAPI client. Recreated on credential / host changes. */
  private isapi: HikvisionIsapiClient | null = null
  /** Active published streams keyed by `camStreamId`. */
  private readonly published = new Map<string, PublishedStream>()
  /** Alarm-stream subscription controller; aborted on disconnect. */
  private alarmController: AbortController | null = null
  /** Reconnect attempt counter — drives exponential backoff for the alarm stream. */
  private alarmReconnectAttempts = 0
  /** Pending alarm-reconnect timer. */
  private alarmReconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Counting reporter for alarm types the camera receives but does not model.
   *
   * Built lazily so it can capture `this.id` / `this.ctx.logger` — every line
   * it emits carries the numeric `deviceId`. It keeps the historical message
   * text (`hikvision: unhandled alarm event`) so existing Loki queries keep
   * working; what changed is that the line now carries `meta.count` and arrives
   * once per window instead of once per event.
   */
  private unhandledAlarmsTally: AlarmTypeTally | null = null
  private get unhandledAlarms(): AlarmTypeTally {
    this.unhandledAlarmsTally ??= createAlarmTypeTally({
      logger: this.ctx.logger,
      deviceId: this.id,
      message: 'hikvision: unhandled alarm event',
      level: 'info',
    })
    return this.unhandledAlarmsTally
  }
  /**
   * Sampled info-level ingress line for the motion-bearing alarms (VMD and
   * smart events): one at each burst's start, one per minute while it lasts,
   * one at its end — never one per ~1 Hz tick. Lazy for the same reason as
   * `unhandledAlarms`.
   */
  private motionIngressLog: AlarmIngressLog | null = null
  private get motionIngress(): AlarmIngressLog {
    this.motionIngressLog ??= createAlarmIngressLog({ logger: this.ctx.logger, deviceId: this.id })
    return this.motionIngressLog
  }
  /** Hysteresis: drop motion-active back to inactive after this many ms with
   *  no fresh `VMD` event. Hikvision fires VMD every ~1s while motion is
   *  active; missing 2 ticks signals the burst is over. */
  private static readonly MOTION_INACTIVE_AFTER_MS = 3_000
  /** Last observed motion timestamp per camStreamId — drives the hysteresis above. */
  private readonly lastMotionAt = new Map<string, number>()
  /** Per-camStreamId timer that flips motion back to inactive. */
  private readonly motionInactiveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Latest in-memory OSD snapshot — populated on connect + on every
   *  osd-cap getStatus call + every 5min poll. Drives the readonly OSD
   *  section in the camera settings UI; null until the first refresh
   *  succeeds. */
  private osdSnapshot: HikvisionOverlayConfig | null = null
  /** Periodic OSD-snapshot poll. Overlays change rarely so 5min is
   *  plenty; the cap's own getStatus refreshes on demand for the
   *  universal overlay UI. */
  private osdPollTimer: ReturnType<typeof setInterval> | null = null
  /** Last snapshot channel we logged, so `resolveSnapshotChannel` emits one
   *  line per CHANGE instead of one per capture. */
  private lastSnapshotChannelLogged: string | null = null
  private static readonly OSD_POLL_INTERVAL_MS = 300_000

  /** Control-plane reachability poll — drives `device.online` from ISAPI
   *  `getDeviceInfo` liveness, decoupled from stream-broker video health.
   *  Started in `onActivate`, stopped in `removeDevice`. */
  private reachabilityPoll: ReachabilityPollHandle | null = null

  constructor(ctx: DeviceContext) {
    super(ctx, hikvisionCameraSchema, { type: DeviceType.Camera })
    this.registerNativeCapabilities()
  }

  /**
   * Register per-device native cap providers. Snapshot + reboot are
   * always registered; motion is registered when the alarm stream
   * subscription succeeds (deferred to `connect()`).
   */
  private registerNativeCapabilities(): void {
    const snapshotProvider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HikvisionCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const isapi = this.ensureClient()
        const channelId = this.resolveSnapshotChannel()
        try {
          const { buffer, contentType } = await isapi.getSnapshot(channelId)
          return {
            base64: buffer.toString('base64'),
            contentType,
          }
        } catch (err) {
          this.ctx.logger.warn('hikvision snapshot failed', {
            tags: { deviceId: this.id },
            meta: { channelId, error: err instanceof Error ? err.message : String(err) },
          })
          return null
        }
      },
      invalidateCache: async () => {
        // No local cache — the snapshot wrapper owns it.
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, snapshotProvider)

    const rebootProvider: InferNativeProvider<typeof rebootCapability> = {
      reboot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HikvisionCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const isapi = this.ensureClient()
        await isapi.reboot()
        return { success: true as const }
      },
    }
    this.ctx.registerNativeCap(rebootCapability, rebootProvider)

    // device-admin-link — the camera's own web console. Hikvision is the exact
    // case: `port` IS the ISAPI port and ISAPI is served by the same HTTP
    // server as the web UI, and `https` is a real per-device flag, so nothing
    // here is assumed. Verified on 1436 (192.168.60.139, port 80, https false)
    // on 2026-09-22: `http://192.168.60.139/` → 200 text/html.
    //
    // The URL carries NO credentials, deliberately — `username`/`password` sit
    // in the very same config object and the camera's page asks for its own
    // login. See the cap docblock and `buildDeviceAdminUrl`.
    const adminLinkProvider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HikvisionCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const host = this.config.get('host') ?? ''
        const https = this.config.get('https') === true
        const built = buildDeviceAdminUrl({
          host,
          port: this.config.get('port') ?? null,
          scheme: https ? 'https' : 'http',
          path: '/',
        })
        if (!built.ok) {
          // A branch that produces nothing says so, per-device.
          this.ctx.logger.debug('hikvision admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return { url: built.url, label: 'Web UI', target: 'device' as const, host }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, adminLinkProvider)

    this.registerMotionCap()

    // Intercom is gated on the persisted probe (`hasIntercom`) +
    // operator setting (`twoWayAudioMode`). On a fresh device the
    // probe hasn't run yet so this no-ops — the post-probe call site
    // (`probeAndPersistAccessoryCaps`) re-invokes once `hasIntercom`
    // lands so the cap appears without a restart.
    this.registerIntercomIfSupported()

    // OSD overlays — every Hikvision channel exposes `/overlays`,
    // including legacy DS-7600 firmwares. The provider proxies the
    // three Hikvision overlay slots (datetime / channel-name / 4-8
    // free-text overlays) into the cap's homogeneous `OsdOverlay[]`
    // shape so the universal admin-ui form renders them with zero
    // per-vendor branching.
    this.registerOsdCap(DEFAULT_CAMERA_NUMBER)

    // Stream-params — every Hikvision channel exposes
    // `/ISAPI/Streaming/channels/{id}` (codec / resolution / bitrate /
    // FPS / GOP). The provider proxies each per-profile channel
    // (`{cam}01` main, `{cam}02` sub, `{cam}03` ext) into the cap's
    // homogeneous per-profile shape. Channels the camera lacks 404 and
    // are simply omitted from status / options.
    this.registerStreamParamsCap(DEFAULT_CAMERA_NUMBER)

    // Motion-zones — the on-camera VMD detection grid. Every Hikvision
    // channel exposes `/motionDetection` with a `<Grid>` resolution and
    // a `<gridMap>` active-cell bitmask. The provider proxies that grid
    // into the cap's row-major `cells[]` shape so the universal admin-ui
    // editor renders it with zero per-vendor branching.
    this.registerMotionZonesCap(DEFAULT_CAMERA_NUMBER)

    // Privacy-mask — the on-camera blacked-out region grid. Hikvision
    // cameras expose `/ISAPI/System/Video/inputs/channels/{id}/privacyMask`
    // with normalized vertex coordinates. We share the motion-grid cell
    // model so the same MotionGridCanvas widget renders both overlays.
    // Needs-hardware-verification: ISAPI shape assumed from firmware docs.
    this.registerPrivacyMaskCap(DEFAULT_CAMERA_NUMBER)

    // Day/night — vendor-neutral IR-cut mode control. Hikvision's
    // `/ISAPI/Image/channels/{cam}/IrcutFilter` `IrcutFilterType` enum
    // (auto/day/night/schedule) matches the cap's `DayNightMode` 1:1.
    this.registerDayNightCap(DEFAULT_CAMERA_NUMBER)

    // Image-settings — vendor-neutral picture-adjustment controls.
    // Brightness/contrast/saturation (`/color`), sharpness (separate
    // `/sharpness` endpoint) and the WDR on/off toggle (`/WDR`, surfaced
    // as `backlightMode` off|wdr) proxy onto Hikvision's existing image
    // ISAPI. Mirror/flip/rotate/white-balance/exposure have no wired
    // ISAPI equivalent yet — see the method doc for the honest TODO list.
    this.registerImageSettingsCap(DEFAULT_CAMERA_NUMBER)

    // Onboard recording + onboard storage — what the CAMERA writes to
    // the CAMERA's own card. Not `recording`, which is our recorder:
    // this one's authority is the firmware, and it stores nothing of its
    // own (D62). Reads `ContentMgmt/Storage` + `record/tracks`, both of
    // which answered on 100 % of the fleet.
    this.registerRecordingOnboardCap()

    // Stream-catalog — the broker PULLS this (on start / reconcile poll /
    // device + stream-params events) to (re)build its cam-stream registry
    // from the authoritative provider state. No provider-side push.
    this.registerStreamCatalogProvider()

    // "Sync time from local" — a device custom action dispatched by the
    // Time / NTP tab's `device-action-button` via
    // deviceManager.runDeviceAction. Sets the camera to `manual` mode with
    // the host's current wall-clock. We attach the CAMERA's own current
    // offset (read fresh from `<localTime>`), not the host's, because
    // Hikvision re-projects any instant onto its own configured offset and
    // observed firmware stays on the standard offset (DST rule ignored) —
    // sending the host offset (`+02:00`) made it re-display one hour behind.
    // Pairing the host wall-clock with the camera's offset makes the camera
    // show exactly the host clock. Falls back to the host offset when the
    // firmware omits `<localTime>`.
    this.registerDeviceAction(
      'syncTimeFromLocal',
      deviceCustomAction(z.object({}), z.object({ success: z.boolean() }), { kind: 'mutation' }),
      async () => {
        try {
          const isapi = this.ensureClient()
          const current = await isapi.getTimeConfig().catch(() => null)
          const cameraOffset = offsetFromZonedIso(current?.localTime ?? null)
          await isapi.setLocalTime(datetimeLocalToZonedIso(hostDatetimeLocalNow(), cameraOffset))
          // Re-read the camera clock and persist it so the re-fetched
          // settings aggregate (the UI invalidates it after the action)
          // seeds the "Manual date & time" picker with the new value.
          await this.refreshNtpSnapshot()
          return { success: true }
        } catch (err) {
          this.ctx.logger.warn('sync time from local failed', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          return { success: false }
        }
      },
    )
  }

  /**
   * The probed streaming channels, as the snapshot-source select needs them.
   * Sourced from `deviceCache.streamSnapshots`, which the connect-time probe
   * fills from `/ISAPI/Streaming/channels` — never a hardcoded main/sub pair.
   * Empty until the first successful probe; the select is then not rendered
   * at all rather than offering a channel we have not confirmed exists.
   */
  private probedSnapshotChannels(): readonly SnapshotChannelDescriptor[] {
    const snapshots = this.config.get('deviceCache')?.streamSnapshots ?? {}
    return Object.entries(snapshots).map(([channelId, snap]) => ({
      channelId,
      channelName: snap.channelName ?? null,
      enabled: snap.enabled,
      codec: snap.videoCodecType ?? null,
      width: snap.resolutionWidth ?? null,
      height: snap.resolutionHeight ?? null,
    }))
  }

  /**
   * The ISAPI channel the next snapshot is taken from.
   *
   * Unset setting → `{cam}01`, the channel the provider used before this
   * setting existed. A stored channel the camera no longer enumerates falls
   * back to that default and WARNS: a snapshot silently coming from a
   * different channel than the operator picked is precisely the kind of
   * substitution that reads as "the setting never worked".
   *
   * The info line fires only when the effective channel CHANGES, so a
   * per-second snapshot poll does not become a log stream.
   */
  private resolveSnapshotChannel(): string {
    const fallback = defaultSnapshotChannelId(DEFAULT_CAMERA_NUMBER)
    const configured = this.config.get('snapshotChannelId') ?? ''
    const available = this.probedSnapshotChannels().map((c) => c.channelId)
    const resolved = resolveSnapshotChannelId(configured, available, fallback)
    if (resolved.source === 'fallback-unknown') {
      this.ctx.logger.warn('hikvision snapshot channel not offered by camera — using default', {
        tags: { deviceId: this.id },
        meta: { configured, fallback, available },
      })
    }
    if (this.lastSnapshotChannelLogged !== resolved.channelId) {
      this.lastSnapshotChannelLogged = resolved.channelId
      this.ctx.logger.info('hikvision snapshot source channel resolved', {
        tags: { deviceId: this.id },
        meta: { channelId: resolved.channelId, source: resolved.source, configured },
      })
    }
    return resolved.channelId
  }

  /**
   * Register the device-scoped `stream-catalog` cap — the broker pulls
   * this to (re)build its cam-stream registry. Sources its descriptors
   * from `buildStreamCatalog`, which also reconciles the local `published`
   * map on every pull.
   */
  private registerStreamCatalogProvider(): void {
    const provider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        return this.buildStreamCatalog()
      },
    }
    this.ctx.registerNativeCap(streamCatalogCapability, provider)
  }

  /**
   * Register the `intercom` cap when the camera advertises two-way
   * audio (or operator forced `'isapi'`). Server-WebRTC-shaped:
   * `startSession` returns an SDP offer, `handleAnswer` applies the
   * browser's response, the orchestrator pumps Opus RTP through the
   * `audio-codec` cap (Opus → PCM s16le @ 8 kHz mono) and feeds the
   * PCM into `HikvisionIntercomSession` for G.711 encode + sticky-PUT
   * onto `/ISAPI/System/TwoWayAudio/channels/{id}/audioData`.
   *
   * The `audio-codec` cap is REQUIRED — without it (no audio-codec
   * addon installed) intercom can't function. We register the cap
   * regardless and surface the missing dep as a clear error from
   * `startSession`; this preserves the "cap visible in bindings/docs"
   * UX without falsely claiming readiness when audio decode isn't
   * available.
   *
   * Idempotent: subsequent calls (e.g. after a probe lands or the
   * operator flips `twoWayAudioMode`) noop once the cap is already
   * registered.
   */
  /**
   * Mirror talk-back into the `intercom` runtime-state slice.
   *
   * The cap's `status` is command-driven and nothing reads it: every consumer
   * outside this process — the admin UI, the Home Assistant export — sees a
   * capability only through the runtime-state slice, via the
   * `device.state-changed` event or the `deviceState.getAllSnapshots`
   * snapshot. Without this write the `intercom` entity Home Assistant
   * publishes would exist and never receive a value, which is exactly the
   * defect that kept the capability out of the export.
   *
   * Called at the four points that open or close a session — and seeded at
   * registration, so the slice says `talking: false` from boot rather than
   * only after the first session.
   *
   * `ability` is STICKY: it is the firmware's negotiated format, learned when a
   * session opens and still true after it closes, so a caller reading between
   * sessions gets the last probed value rather than `null`. Passing it is what
   * changed — it used to be copied forward from `previous` at every one of the
   * four call sites and written by nobody, while `session.sampleRate` and
   * `session.audioCodec` were in hand and only reaching a log line.
   */
  private publishIntercomState(talking: boolean, ability?: IntercomAbility): void {
    const previous = this.getCapSlice(intercomCapability)
    this.setCapSlice(intercomCapability, {
      talking,
      lastSessionAt: talking ? Date.now() : (previous?.lastSessionAt ?? null),
      ability: ability ?? previous?.ability ?? null,
    })
  }

  private registerIntercomIfSupported(): void {
    if (this.intercomRegistered) return
    if (!this.intercomEnabled()) return
    this.intercomRegistered = true

    const provider: InferNativeProvider<typeof intercomCapability> = {
      startSession: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HikvisionCamera: intercom deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        if (this.disabled) {
          throw new Error(
            'Hikvision intercom: device is disabled — re-enable it before opening a talk session',
          )
        }
        const audioCodec = this.resolveAudioCodecApi()
        const isapi = this.ensureClient()
        if (!this.intercomOrchestrator) {
          this.intercomOrchestrator = new IntercomOrchestrator({
            deviceTag: `camera-${this.id}`,
            logger: this.ctx.logger.withTags({ deviceId: this.id, scope: 'intercom' }),
            audioCodec,
            peerFactory: ({ logger }) => new WeriftIntercomPeer({ logger }),
            talkSessionFactory: ({ logger }) =>
              new HikvisionIntercomSession({
                client: isapi,
                logger,
                deviceTag: `camera-${this.id}`,
              }),
          })
        }
        // The slice flips only once the handshake actually opened: a failed
        // start unwinds everything it opened, and reporting `talking` over
        // that would leave Home Assistant showing a talk session nobody has.
        try {
          const opened = await this.intercomOrchestrator.start()
          this.publishIntercomState(true, this.intercomOrchestrator.ability ?? undefined)
          return opened
        } catch (err) {
          this.publishIntercomState(false)
          throw err
        }
      },
      handleAnswer: async ({ deviceId, sessionId, sdpAnswer }) => {
        if (deviceId !== this.id) return
        if (!this.intercomOrchestrator) {
          throw new Error(
            `Hikvision intercom: handleAnswer with no active orchestrator (sessionId=${sessionId})`,
          )
        }
        await this.intercomOrchestrator.handleAnswer(sessionId, sdpAnswer)
      },
      stopSession: async ({ deviceId, sessionId }) => {
        if (deviceId !== this.id) return
        if (!this.intercomOrchestrator) return
        await this.intercomOrchestrator.stop(sessionId)
        this.publishIntercomState(false)
      },
      startTalkSession: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HikvisionCamera: intercom deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        if (this.disabled) {
          throw new Error(
            'Hikvision intercom: device is disabled — re-enable it before opening a talk session',
          )
        }
        // Single-active-session — close any prior raw session first, codec
        // sessions included. Stopping only the camera leg here leaked an
        // `audio-codec` session per superseded talk session until the idle
        // reaper noticed.
        if (this.intercomRawSession) {
          const previous = this.intercomRawSession
          this.intercomRawSession = null
          await previous.pcmTranscode.close()
          await previous.session.stop().catch(() => {
            /* swallow */
          })
        }
        const isapi = this.ensureClient()
        const session = new HikvisionIntercomSession({
          client: isapi,
          logger: this.ctx.logger.withTags({ deviceId: this.id, scope: 'intercom-raw' }),
          deviceTag: `camera-${this.id}`,
        })
        await session.start()
        const id = `intercom-raw-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`
        this.intercomRawSession = {
          id,
          session,
          lastSequenceNumber: -1,
          opusDecode: null,
          // Built with the session so it dies with it. It opens no codec
          // session until a frame actually arrives at the wrong rate.
          pcmTranscode: new TalkPcmTranscoder({
            deviceId: this.id,
            logger: this.ctx.logger,
            resolveAudioCodec: () => this.resolveAudioCodecApi(),
            targetSampleRate: session.sampleRate,
            tag: `hikvision-intercom-pcm:${this.id}:${id}`,
            feed: (pcm) => session.feedPcm(pcm),
          }),
        }
        this.publishIntercomState(true, session.ability)
        this.ctx.logger.info('intercom talk session opened', {
          tags: { deviceId: this.id },
          meta: { sessionId: id, sampleRate: session.sampleRate, codec: session.audioCodec },
        })
        return { sessionId: id }
      },
      pushTalkAudio: async ({
        deviceId,
        audioBase64,
        codec,
        sampleRate,
        channels,
        sequenceNumber,
      }) => {
        if (deviceId !== this.id) return { accepted: false }
        // `codec` absent → caller is using the legacy "provider's native
        // PCM" contract: s16le @ camera rate, mono. Treat as 's16le'.
        // Resolved FIRST so every counted outcome below carries the wire
        // format as its `variant` — "is HomeKit's Opus or Alexa's raw PCM
        // the half that is failing" is one read, not a log grep.
        const wireCodec = codec ?? 's16le'
        const note = (reason?: string): void => {
          intercomFailureReport.noteTalkFrame(this.id, wireCodec, reason)
        }
        const active = this.intercomRawSession
        // No open session is not this camera losing a frame — it is a caller
        // pushing at a session it never opened. Counting it would move the
        // denominator without describing the camera.
        if (!active || !active.session.isOpen) return { accepted: false }
        // Drop out-of-order frames — downstream encoders (G.711 is
        // stateless but the PUT body is order-sensitive on the wire)
        // can't recover from a stale frame after a newer one.
        if (sequenceNumber <= active.lastSequenceNumber) {
          note(REASON_TALK_OUT_OF_ORDER)
          return { accepted: false }
        }
        const buf = Buffer.from(audioBase64, 'base64')
        if (buf.length === 0) {
          note(REASON_TALK_EMPTY)
          return { accepted: false }
        }
        const ch = channels ?? 1
        if (ch !== 1) {
          note(REASON_TALK_NOT_MONO)
          this.ctx.logger.warn('intercom: dropping non-mono talk frame (Hikvision is mono-only)', {
            tags: { deviceId: this.id },
            meta: { channels: ch, codec },
          })
          return { accepted: false }
        }

        if (wireCodec === 'g711ulaw' || wireCodec === 'g711alaw') {
          // Passthrough — caller pre-encoded to the camera's wire format.
          // Only valid when the wire codec matches what the camera
          // negotiated; otherwise we'd need a g711-to-g711 cross-encode
          // (alaw↔ulaw) which is not implemented.
          if (wireCodec !== active.session.audioCodec) {
            note(REASON_TALK_CODEC_UNSUPPORTED)
            this.ctx.logger.warn(
              'intercom: codec mismatch — wire codec is not what the camera negotiated, dropping frame',
              {
                tags: { deviceId: this.id },
                meta: { wireCodec, cameraCodec: active.session.audioCodec },
              },
            )
            return { accepted: false }
          }
          active.lastSequenceNumber = sequenceNumber
          active.session.feedEncoded(buf)
          note()
          return { accepted: true }
        }

        if (wireCodec === 's16le') {
          if (!sampleRate) {
            note(REASON_TALK_NO_SAMPLE_RATE)
            this.ctx.logger.warn(
              'intercom: s16le push with no sampleRate — dropping (rate is ambiguous)',
              {
                tags: { deviceId: this.id },
              },
            )
            return { accepted: false }
          }
          if (sampleRate !== active.session.sampleRate) {
            // Raw PCM at a rate the camera does not speak. This used to be a
            // hard drop with one warn and no counter, which is what silenced
            // HomeKit and Alexa talk-back on this 8 kHz-only firmware. It is
            // now a `pcm_s16le` decode session — pure libswresample, opened
            // lazily, reused for the session, torn down with it and on error.
            // The transcoder feeds the camera itself; a frame it could not
            // convert is still refused, loudly, and nothing is fed (D281).
            const refusal = await active.pcmTranscode.feedResampled({
              pcm: buf,
              sourceSampleRate: sampleRate,
            })
            if (refusal !== null) {
              note(refusal)
              return { accepted: false }
            }
            active.lastSequenceNumber = sequenceNumber
            note()
            return { accepted: true }
          }
          active.lastSequenceNumber = sequenceNumber
          active.session.feedPcm(buf)
          note()
          return { accepted: true }
        }

        if (wireCodec === 'opus') {
          // Opus → s16le decode session, target = camera-native rate.
          // `sourceSampleRate` is the input rate to the *resampler*; the
          // node-av Opus decoder always emits at 48 kHz regardless of
          // what the encoder negotiated, so we pin to 48 kHz here and
          // let the swr stage do the 48→camera-rate downsample. Using
          // the HAP-encoder rate (`sampleRate` arg) here would lie to
          // the resampler, which then interprets the 48 kHz output as
          // if it were lower-rate and silently drops most of the
          // payload — bytes written to the camera stay at zero.
          try {
            if (!active.opusDecode) {
              const codecApi = this.resolveAudioCodecApi()
              const created = await codecApi.createDecodeSession({
                codec: 'opus',
                sourceSampleRate: 48_000,
                sourceChannels: ch,
                targetSampleRate: active.session.sampleRate,
                targetChannels: 1,
                targetFormat: 's16le',
                tag: `hikvision-intercom:${this.id}:${active.id}`,
              })
              active.opusDecode = { sessionId: created.sessionId, nodeId: created.nodeId }
              this.ctx.logger.info('intercom: opus decode session opened', {
                tags: { deviceId: this.id },
                meta: {
                  sessionId: active.id,
                  codecSessionId: created.sessionId,
                  codecNodeId: created.nodeId,
                  encoderRate: sampleRate ?? null,
                  decoderRate: 48_000,
                  targetSampleRate: active.session.sampleRate,
                },
              })
            }
            const codecApi = this.resolveAudioCodecApi()
            await codecApi.pushEncodedFrame({
              sessionId: active.opusDecode.sessionId,
              nodeId: active.opusDecode.nodeId,
              data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
            })
            const chunks = await codecApi.pullPcm({
              sessionId: active.opusDecode.sessionId,
              nodeId: active.opusDecode.nodeId,
              maxCount: 8,
            })
            active.lastSequenceNumber = sequenceNumber
            for (const chunk of chunks) {
              const pcmBuf = Buffer.from(
                chunk.data.buffer,
                chunk.data.byteOffset,
                chunk.data.byteLength,
              )
              if (pcmBuf.length > 0) active.session.feedPcm(pcmBuf)
            }
            note()
            return { accepted: true }
          } catch (err) {
            // Counted, then rethrown: the caller's error handling is
            // unchanged, but a camera whose Opus leg is failing no longer
            // has to be found by grepping for a stack trace.
            note(REASON_TALK_OPUS_FAILED)
            throw err
          }
        }

        note(REASON_TALK_CODEC_UNSUPPORTED)
        this.ctx.logger.warn('intercom: no path onto the talk channel for this wire codec', {
          tags: { deviceId: this.id },
          meta: { wireCodec, cameraCodec: active.session.audioCodec },
        })
        return { accepted: false }
      },
      endTalkSession: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        const active = this.intercomRawSession
        if (!active) return
        this.intercomRawSession = null
        // The PCM resample session dies with the talk session that owns it —
        // same teardown point as `opusDecode`, and idempotent, so a session
        // that never converted a frame costs nothing here.
        await active.pcmTranscode.close()
        if (active.opusDecode) {
          const codecApi = this.resolveAudioCodecApi()
          await codecApi
            .closeSession({
              sessionId: active.opusDecode.sessionId,
              nodeId: active.opusDecode.nodeId,
            })
            .catch((err: unknown) => {
              this.ctx.logger.debug('intercom: opus decode closeSession error (continuing)', {
                tags: { deviceId: this.id },
                meta: {
                  sessionId: active.id,
                  error: err instanceof Error ? err.message : String(err),
                },
              })
            })
        }
        await active.session.stop().catch((err: unknown) => {
          this.ctx.logger.debug('intercom talk session stop error (continuing)', {
            tags: { deviceId: this.id },
            meta: { sessionId: active.id, error: err instanceof Error ? err.message : String(err) },
          })
        })
        this.publishIntercomState(false)
        this.ctx.logger.info('intercom talk session closed', {
          tags: { deviceId: this.id },
          meta: { sessionId: active.id, lastSequenceNumber: active.lastSequenceNumber },
        })
      },
    }
    this.ctx.registerNativeCap(intercomCapability, provider)
    this.publishIntercomState(false)
    this.ctx.logger.info('intercom cap registered (ISAPI two-way audio)', {
      tags: { deviceId: this.id },
    })
  }

  /**
   * Register the `osd` cap. Builds the cap's homogeneous `OsdOverlay[]`
   * snapshot from Hikvision's three overlay slots (datetime, channel
   * name, free-text) on every `getStatus`. `setOverlay` routes the
   * patch to the right per-element ISAPI PUT.
   *
   * Hikvision's overlay positions are normalized pixel coords (X/Y);
   * we don't translate them into the cap's enum positions because the
   * cap's coarse 9-zone grid loses information. The provider declares
   * `availablePositions: []` so the universal UI hides the position
   * field — only `enabled` and `text` are operator-relevant here.
   */
  private registerOsdCap(cameraNumber: number): void {
    const provider: InferNativeProvider<typeof osdCapability> = {
      getStatus: async ({ deviceId }): Promise<OsdStatus> => {
        if (deviceId !== this.id) {
          throw new Error(
            `HikvisionCamera: osd deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const isapi = this.ensureClient()
        const config = await isapi.getOverlayConfig(cameraNumber)
        if (!config) return { overlays: [] }
        // Cache for the readonly OSD section in the camera settings
        // UI — hydrateSchema reads from this.osdSnapshot synchronously.
        this.osdSnapshot = config
        const overlays: OsdOverlay[] = []
        // Date/time — firmware-rendered; operator can only flip
        // visibility, not edit the format.
        overlays.push({
          id: 'dateTime',
          kind: 'timestamp',
          enabled: config.dateTime.enabled,
          availablePositions: [],
          readOnly: true,
        })
        // Channel name — text tracks `deviceName`, owned by the
        // camera-side time/network settings; we expose visibility only.
        overlays.push({
          id: 'channelName',
          kind: 'text',
          enabled: config.channelName.enabled,
          text: this.name,
          availablePositions: [],
          readOnly: true,
        })
        for (const t of config.textOverlays) {
          overlays.push({
            id: `text-${t.id}`,
            kind: 'text',
            enabled: t.enabled,
            text: t.text ?? '',
            availablePositions: [],
            // ISAPI TextOverlay displayText — firmware rejects longer strings.
            maxCharacters: 44,
          })
        }
        return { overlays }
      },
      setOverlay: async ({ deviceId, overlayId, patch }) => {
        if (deviceId !== this.id) return
        const isapi = this.ensureClient()
        if (overlayId === 'dateTime') {
          await isapi.setDateTimeOverlay(cameraNumber, { enabled: patch.enabled })
          return
        }
        if (overlayId === 'channelName') {
          await isapi.setChannelNameOverlay(cameraNumber, { enabled: patch.enabled })
          return
        }
        if (overlayId.startsWith('text-')) {
          const id = overlayId.slice('text-'.length)
          await isapi.setTextOverlay(cameraNumber, id, {
            enabled: patch.enabled,
            text: patch.text,
          })
          return
        }
      },
    }
    this.ctx.registerNativeCap(osdCapability, provider)
  }

  /**
   * Resolve the `audio-codec` cap router off `ctx.api`. Throws a clear
   * error when the cap isn't mounted (no audio-codec addon installed)
   * so the operator gets actionable feedback at session-open time
   * rather than a generic dispatch failure.
   */
  private resolveAudioCodecApi(): IntercomAudioCodecApi {
    const root = this.ctx.api as { audioCodec?: AudioCodecRouterShape }
    const router = root.audioCodec
    if (!router) {
      throw new Error(
        'Hikvision intercom: `audio-codec` capability is not mounted. ' +
          'Install + enable the `addon-audio-codec-ffmpeg` addon (or any other ' +
          'addon that provides the `audio-codec` capability) before opening ' +
          'a talk session.',
      )
    }
    return {
      createDecodeSession: (input) => router.createDecodeSession.mutate(input),
      pushEncodedFrame: (input) => router.pushEncodedFrame.mutate(input),
      pullPcm: (input) => router.pullPcm.query(input),
      closeSession: (input) => router.closeSession.mutate(input),
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────────

  /**
   * Initialise the ISAPI client (lazy — happens on first cap call) and
   * cache it for the lifetime of the credentials. A subsequent
   * `applySettingsPatch` call that mutates host / port / scheme /
   * credentials drops the cache so the next call rebuilds.
   *
   * Exposed publicly because accessory children share the parent's
   * client through the `HikvisionAccessoryHost` contract — there's
   * no separate auth flow per accessory, just one ISAPI session
   * funnelled through the whole device tree.
   */
  /**
   * What the clip path needs to reach this camera: its ISAPI client for the
   * catalog, and its RTSP credentials for the replay.
   *
   * The credentials are handed over IN PROCESS and never leave it — the replay
   * client sends them as a digest header on its own socket, so nothing puts
   * this camera's password in an argv, in a URL a log could hold, or on disk.
   * That is the whole reason the provider owns an RTSP client rather than
   * handing ffmpeg a `rtsp://user:pass@host/...`.
   */
  getClipCamera(): {
    readonly deviceId: number
    readonly host: string
    readonly username: string
    readonly password: string
    readonly client: HikvisionIsapiClient
  } {
    return {
      deviceId: this.id,
      host: this.config.get('host'),
      username: this.config.get('username') ?? 'admin',
      password: this.config.get('password'),
      client: this.ensureClient(),
    }
  }

  ensureClient(): HikvisionIsapiClient {
    if (this.isapi) return this.isapi
    const host = this.config.get('host')
    const port = this.config.get('port') ?? (this.config.get('https') ? 443 : 80)
    this.isapi = new HikvisionIsapiClient(
      {
        host,
        port,
        https: this.config.get('https') ?? false,
        username: this.config.get('username') ?? 'admin',
        password: this.config.get('password'),
      },
      this.ctx.logger.withTags({ deviceId: this.id }),
    )
    return this.isapi
  }

  /**
   * Discover RTSP streams and publish them to the stream-broker. Run
   * after device creation + on broker-ready events. Idempotent — the
   * broker keys entries by `(deviceId, camStreamId)`. Failures fall
   * back to a synthetic `{cam}01`/`{cam}02` channel set so older
   * NVRs (no `/ISAPI/Streaming/channels`) still get streams published.
   */
  /**
   * Phase 3 — probe ISAPI for PTZ / supplemental-light / siren / alarm-IO
   * support and persist into `deviceCache`. Runs BEFORE
   * `getAccessoryChildren()` so the spawn loop sees fresh probe results.
   * Best-effort: failures retain the previous deviceCache values.
   *
   * Also kicks the hardware-metadata populator (model / firmware /
   * serial / mac / ...) on every kernel-driven probe so an addon
   * restart re-syncs the metadata blob with current firmware.
   */
  override async onProbe(): Promise<void> {
    if (!this.accessoryCapsProbed) {
      this.accessoryCapsProbed = true
      try {
        await this.probeAndPersistAccessoryCaps()
      } catch (err) {
        this.ctx.logger.debug('hikvision accessory cap probe failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        this.accessoryCapsProbed = false
      }
    }
    // Hardware-identity metadata refresh — runs on every probe (every
    // addon restart). `populateHikvisionMetadata` is idempotent
    // (`setMetadata` short-circuits no-diff patches).
    try {
      const isapi = this.ensureClient()
      await populateHikvisionMetadata(isapi, {
        id: this.id,
        ctx: this.ctx,
        setDeviceCachePatch: async (cachePatch) => {
          const previous = this.config.get('deviceCache') ?? {}
          await this.config.setAll({ deviceCache: { ...previous, ...cachePatch } })
        },
      })
    } catch (err) {
      this.ctx.logger.debug('hikvision metadata populate failed (non-fatal)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Phase 5 — fired after probe + accessory reconciliation. Primes the
   *  `published` map (so the legacy `getStreamSources()` shim + alarm
   *  channel lookup have data before the broker's first catalog pull) and
   *  opens the alarm control-plane subscription; gated on `disabled`. The
   *  broker PULLS the stream catalog itself via the `stream-catalog` cap —
   *  no provider-side push. */
  override async onActivate(): Promise<void> {
    if (this.disabled) {
      this.ctx.logger.info('Hikvision device disabled — skipping initial stream catalog prime')
      return
    }
    // Prime `this.published` so a `getStreamSources()` / alarm event that
    // races ahead of the broker's first catalog pull still resolves. Best-
    // effort — the broker's pull keeps the map current regardless.
    await this.buildStreamCatalog().catch((err: unknown) => {
      this.ctx.logger.warn('initial stream catalog build failed — broker pull will retry', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    // Open (or re-establish) the alarm subscription once we have a working
    // ISAPI session. Best-effort — failure logs and schedules a retry, the
    // rest of the surface stays usable.
    this.ensureAlarmSubscription()
    // Best-effort initial OSD snapshot for the readonly settings tab —
    // success populates `this.osdSnapshot` for the next form open;
    // failure (camera offline, ISAPI 4xx) just leaves the section
    // showing "—" until the next periodic poll.
    void this.refreshOsdSnapshot()
    if (this.osdPollTimer === null) {
      this.osdPollTimer = setInterval(() => {
        void this.refreshOsdSnapshot()
      }, HikvisionCamera.OSD_POLL_INTERVAL_MS)
    }
    this.startReachabilityPolling()
  }

  /** Start the control-plane reachability poll: an ISAPI `getDeviceInfo`
   *  round-trip every 30s drives `device.online`, with hysteresis. This
   *  replaces the old stream-health→online mirror so an on-demand (idle)
   *  camera that is reachable still reports ONLINE. Idempotent. */
  private startReachabilityPolling(): void {
    if (this.reachabilityPoll) return
    this.reachabilityPoll = startReachabilityPoll({
      probe: async () => {
        const isapi = this.ensureClient()
        await isapi.getDeviceInfo()
        return true
      },
      setOnline: (online) => {
        this.markOnline(online)
      },
      isEnabled: () => !this.disabled,
      logger: this.ctx.logger,
    })
  }

  /** Single-flight OSD config fetch; updates the in-memory snapshot
   *  consumed by the readonly OSD section in `getSettingsUISchema`. */
  private async refreshOsdSnapshot(): Promise<void> {
    try {
      const isapi = this.ensureClient()
      const config = await isapi.getOverlayConfig(DEFAULT_CAMERA_NUMBER)
      if (config) this.osdSnapshot = config
    } catch (err) {
      this.ctx.logger.debug('osd snapshot refresh failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Build the image-tuning snapshot from the camera: color / WDR / IR-cut
   * probed in parallel, each best-effort. Legacy firmwares may 404 on a
   * sub-resource; we record only what we got. Single source of truth for
   * both the on-connect probe and the post-save targeted refresh. Returns
   * `undefined` when nothing could be read.
   */
  private async buildImageSnapshot(): Promise<HikvisionImageSnapshot | undefined> {
    const isapi = this.ensureClient()
    const [color, sharpness, wdr, ircut] = await Promise.all([
      isapi.getImageColor(DEFAULT_CAMERA_NUMBER).catch(() => null),
      // Sharpness lives on its own endpoint — fetch in parallel.
      // Fall back to `color.sharpness` (rare folded firmware) if
      // the dedicated endpoint 404s.
      isapi.getImageSharpness(DEFAULT_CAMERA_NUMBER).catch(() => null),
      isapi.getImageWdr(DEFAULT_CAMERA_NUMBER).catch(() => null),
      isapi.getIrcutFilter(DEFAULT_CAMERA_NUMBER).catch(() => null),
    ])
    const imageSnapshot: HikvisionImageSnapshot = {}
    if (color) {
      if (color.brightness !== null) imageSnapshot.brightness = color.brightness
      if (color.contrast !== null) imageSnapshot.contrast = color.contrast
      if (color.saturation !== null) imageSnapshot.saturation = color.saturation
      if (color.sharpness !== null) imageSnapshot.sharpness = color.sharpness
    }
    if (sharpness !== null) imageSnapshot.sharpness = sharpness
    if (wdr) {
      imageSnapshot.wdrEnabled = wdr.enabled
      if (wdr.level !== null) imageSnapshot.wdrLevel = wdr.level
    }
    if (ircut) imageSnapshot.ircutMode = ircut.mode
    return Object.keys(imageSnapshot).length > 0 ? imageSnapshot : undefined
  }

  /**
   * Build the time / NTP snapshot from `getTimeConfig()` — sync mode +
   * NTP server config. Single source of truth for the on-connect probe
   * and the post-save targeted refresh.
   */
  private async buildNtpSnapshot(): Promise<HikvisionNtpSnapshot> {
    const isapi = this.ensureClient()
    const time = await isapi.getTimeConfig()
    return {
      timeMode: time.timeMode,
      timeZone: time.timeZone,
      localTime: time.localTime,
      ntpServer: time.ntpServer,
      ntpPort: time.ntpPort,
      syncInterval: time.syncInterval,
    }
  }

  /**
   * Build the supplemental-light snapshot from `getSupplementLight()`.
   * Single source of truth for the on-connect probe and the post-save
   * targeted refresh. Returns `undefined` when the camera reports no
   * state (e.g. firmware without the endpoint).
   */
  private async buildLightSnapshot(): Promise<HikvisionLightSnapshot | undefined> {
    const isapi = this.ensureClient()
    const lightState = await isapi.getSupplementLight(DEFAULT_CAMERA_NUMBER)
    if (!lightState) return undefined
    return {
      mode: lightState.mode,
      whiteLightBrightness: lightState.whiteLightBrightness,
      irLightBrightness: lightState.irLightBrightness,
      brightnessRegulatorMode: lightState.brightnessRegulatorMode,
    }
  }

  /** Persist a single slice into `deviceCache` without clobbering the
   *  sibling probe-time fields. `setAll` merges, but we still spread the
   *  current cache so the typed partial only carries the changed slice. */
  private async persistDeviceCacheSlice(
    slice: Partial<NonNullable<HikvisionDeviceCache>>,
  ): Promise<void> {
    const current = this.config.get('deviceCache') ?? {}
    await this.config.setAll({ deviceCache: { ...current, ...slice } })
  }

  /**
   * Which preset `goHome` targets, and who decided it.
   *
   * The operator's pick wins. With none, the FIRMWARE's own home is adopted --
   * Hikvision names id 34 "Back to origin" in its reserved band -- so a camera
   * that already knows where home is needs nothing configured. Only when both
   * are absent is the answer `none`, and `goHome` then refuses rather than
   * moving the head to an arbitrary slot.
   *
   * A failed preset read yields `none`, never a guess: an unreadable camera is
   * not evidence that preset 34 exists (D393).
   */
  private async resolveHomePreset(): Promise<PtzHomePreset> {
    const chosen = this.config.get('homePresetId') ?? ''
    if (chosen !== '') return { presetId: chosen, source: 'operator' }
    try {
      const isapi = this.ensureClient()
      const presets = await isapi.listPtzPresets(DEFAULT_CAMERA_NUMBER)
      const firmwareHome = presets.find((preset) => presetFunctionFor(preset.id) === 'home')
      if (firmwareHome !== undefined) {
        return { presetId: firmwareHome.id, source: 'firmware' }
      }
    } catch (err) {
      this.ctx.logger.warn('hikvision home preset lookup failed — goHome will refuse', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    return { presetId: null, source: 'none' }
  }

  /** Re-read the image-tuning snapshot from the camera and persist it.
   *  Best-effort: a refresh failure is logged and swallowed so a save
   *  never throws. Called after an Image-section push in
   *  `applySettingsPatch` so the form re-hydrates with authoritative
   *  values. */
  private async refreshImageSnapshot(): Promise<void> {
    try {
      const imageSnapshot = await this.buildImageSnapshot()
      if (imageSnapshot) await this.persistDeviceCacheSlice({ imageSnapshot })
    } catch (err) {
      this.ctx.logger.debug('hikvision image snapshot refresh failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Re-read the time / NTP snapshot from the camera and persist it.
   *  Best-effort (see `refreshImageSnapshot`). */
  private async refreshNtpSnapshot(): Promise<void> {
    try {
      const ntpSnapshot = await this.buildNtpSnapshot()
      await this.persistDeviceCacheSlice({ ntpSnapshot })
    } catch (err) {
      this.ctx.logger.debug('hikvision time/ntp snapshot refresh failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Re-read the supplemental-light snapshot from the camera and persist
   *  it. Best-effort (see `refreshImageSnapshot`). */
  private async refreshLightSnapshot(): Promise<void> {
    try {
      const lightSnapshot = await this.buildLightSnapshot()
      if (lightSnapshot) await this.persistDeviceCacheSlice({ lightSnapshot })
    } catch (err) {
      this.ctx.logger.debug('hikvision light snapshot refresh failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Enumerate the camera's enabled streaming channels via ISAPI, falling
   * back to a synthetic main+sub pair when discovery fails (NVRs without
   * `/ISAPI/Streaming/channels`, transient errors). Sole channel source
   * for the `stream-catalog` pull.
   */
  private async enumerateChannels(): Promise<readonly HikvisionStreamingChannel[]> {
    const isapi = this.ensureClient()
    let channels: readonly HikvisionStreamingChannel[]
    try {
      channels = await isapi.listChannels()
      if (channels.length === 0) channels = this.fallbackChannels()
    } catch (err) {
      this.ctx.logger.debug('listChannels failed — using synthetic fallback', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      channels = this.fallbackChannels()
    }
    return channels.filter((ch) => ch.enabled)
  }

  /**
   * Map one enabled streaming channel to its broker descriptor. Single
   * source of truth for the descriptor shape consumed by the
   * `stream-catalog` cap (the broker PULLS it).
   */
  private channelToDescriptor(ch: HikvisionStreamingChannel): CamStreamDescriptor {
    // Normalize Hikvision codec strings (`H.264`/`h264`/`H.265`/`HEVC`) so
    // downstream consumers (broker probedParams card, codec-pick logic) can
    // compare against the canonical `h264`/`h265` set. Anything else is
    // omitted — broker treats absent codec as "unknown" rather than guess.
    const codec = this.mapHikvisionCodec(ch.codec)
    // `maxFrameRate` lives on the per-channel resource and is cached by
    // `probeAndPersistFeatures` into `deviceCache.streamSnapshots` —
    // read it here so the "Source (probed)" widget shows fps alongside
    // codec + resolution without an extra ISAPI roundtrip per pull.
    const probedFps = resolveProbedFps(ch.id, this.config.get('deviceCache'))
    return {
      camStreamId: this.deriveCamStreamId(ch),
      kind: 'pull-rtsp' as const,
      url: this.buildRtspUrl(ch.id),
      ...(codec ? { codec } : {}),
      ...(ch.width && ch.height ? { resolution: { width: ch.width, height: ch.height } } : {}),
      ...(probedFps !== undefined ? { fps: probedFps } : {}),
      label: this.deriveStreamLabel(ch),
    }
  }

  /**
   * Build this camera's pull-able stream catalog — the descriptors the
   * stream-broker needs to dial. The broker PULLS this via the
   * `stream-catalog` cap (on start / reconcile poll / device + stream-params
   * events) so there is no provider-side push. Async because it does an
   * ISAPI channel-discovery round-trip.
   *
   * Side effect: reconciles `this.published` to exactly the current channel
   * set so the legacy `getStreamSources()` shim and the alarm-event channel
   * lookup stay current. Idempotent — called on every pull (~30s): entries
   * are set/overwritten and channels no longer offered are dropped, so the
   * map never goes stale.
   */
  private async buildStreamCatalog(): Promise<CamStreamDescriptor[]> {
    const channels = await withTimeout(this.enumerateChannels(), 10_000, 'enumerateChannels')
    const descriptors = channels.map((ch) => this.channelToDescriptor(ch))

    const seen = new Set<string>()
    channels.forEach((ch, i) => {
      const desc = descriptors[i]
      if (!desc) return
      const camStreamId = desc.camStreamId
      seen.add(camStreamId)
      this.published.set(camStreamId, { camStreamId, channel: ch, rtspUrl: desc.url ?? '' })
    })
    for (const camStreamId of Array.from(this.published.keys())) {
      if (!seen.has(camStreamId)) this.published.delete(camStreamId)
    }

    return descriptors
  }

  /**
   * Probe the camera for PTZ / supplemental-light / alarm-input
   * support and persist the discovery into `deviceCache`. PTZ stays
   * on the parent (vendor-agnostic — Reolink does the same) and is
   * registered as a native cap inline; light + siren turn into child
   * accessory devices spawned by the kernel from `getAccessoryChildren`.
   *
   * Each probe is independent — a missing PTZ doesn't suppress the
   * light probe, etc. Best-effort; failures log at debug and skip
   * that probe path without affecting the rest of the device surface.
   *
   * MUST be awaited from `onCreated` so the kernel's accessory
   * auto-spawn (which reads `deviceCache.hasSupplementalLight` /
   * `hasAlarmIo` via `getAccessoryChildren`) sees the freshest probe
   * results.
   */
  private async probeAndPersistAccessoryCaps(): Promise<void> {
    const isapi = this.ensureClient()
    const cameraNumber = DEFAULT_CAMERA_NUMBER

    const cacheUpdate: Partial<NonNullable<HikvisionDeviceCache>> = {}

    const ptzCaps = await isapi.getPtzCapabilities(cameraNumber)
    if (ptzCaps && (ptzCaps.hasPan || ptzCaps.hasTilt || ptzCaps.hasZoom)) {
      this.registerPtzCap(cameraNumber)
      cacheUpdate.hasPtz = true

      // Autotrack lives under PTZ — only worth probing when the
      // camera has PTZ at all. The smartTracking endpoint exists on
      // every PTZ-capable Hikvision firmware, but capability
      // discovery (`smartTrackingCapabilities`) tells us which
      // optional knobs (`duration`, `smartTrackingType`) the camera
      // accepts.
      const trackingCaps = await isapi.getSmartTrackingCapabilities(cameraNumber)
      if (trackingCaps) {
        cacheUpdate.hasAutotrack = true
        cacheUpdate.autotrackSupportsDuration = trackingCaps.supportsDuration
        cacheUpdate.autotrackSupportsType = trackingCaps.supportsType
        this.registerPtzAutotrackCap(cameraNumber)
      }
    }

    const lightCaps = await isapi.getSupplementLightCapabilities(cameraNumber)
    if (lightCaps && lightCaps.modes.length > 0) {
      // Pick the canonical "on" mode. Hikvision spotlights advertise
      // `colorVuWhiteLight` on newer firmwares + `manual` on older.
      // We default to `colorVuWhiteLight` when present, else fall
      // back to the first non-`close` mode. Persist BOTH the full
      // mode list (so the LightAccessory's settings UI can render
      // the select) and the default (so first-spawn config seeds
      // with the right value).
      const defaultMode = lightCaps.modes.includes('colorVuWhiteLight')
        ? 'colorVuWhiteLight'
        : (lightCaps.modes.find((m) => m !== 'close') ?? null)
      if (defaultMode) {
        cacheUpdate.hasSupplementalLight = true
        cacheUpdate.lightSupportedModes = [...lightCaps.modes]
        cacheUpdate.lightDefaultMode = defaultMode
        // White-light support — anything other than `irLight` / `close`
        // is operator-driven visible illumination. IR-only cameras
        // (`['irLight','close']`) get `false` here → no accessory
        // device spawn, only the parent Light tab.
        const whiteLightModes = ['colorVuWhiteLight', 'whiteLight', 'manual', 'mixed']
        cacheUpdate.lightHasWhiteLight = lightCaps.modes.some((m) => whiteLightModes.includes(m))
      }
      // Snapshot the current state for the parent Light tab. Reuses the
      // same read+map as the post-save `refreshLightSnapshot`.
      const lightSnapshot = await this.buildLightSnapshot()
      if (lightSnapshot) cacheUpdate.lightSnapshot = lightSnapshot
    }

    const alarmInputs = await isapi.getAlarmInputs()
    if (alarmInputs && alarmInputs.length > 0) {
      // ISAPI exposes the port as a numeric string (`"1"`, `"2"`); we
      // persist the numeric form so the SirenAccessory's settings
      // schema (numeric `port` field) doesn't have to coerce on every
      // read. Drop ids that fail to parse — they shouldn't reach us
      // from a healthy camera, but a malformed XML response shouldn't
      // poison the persisted cache.
      const ports = alarmInputs
        .map((a) => Number.parseInt(a.id, 10))
        .filter((n) => Number.isFinite(n) && n > 0)
      if (ports.length > 0) {
        cacheUpdate.hasAlarmIo = true
        cacheUpdate.alarmInputPorts = ports
      }
    }

    // TwoWayAudio probe — best-effort. Older firmwares 404 here; we
    // record `hasIntercom: false` in that case so the auto mode keeps
    // the cap unregistered. Operators on those firmwares can still
    // force the cap by setting `twoWayAudioMode: 'isapi'`.
    try {
      const channels = await isapi.listTwoWayAudioChannels()
      if (channels.length > 0) {
        cacheUpdate.hasIntercom = true
        const channelId = channels[0]!.id
        const codec = channels[0]?.audioCompressionType ?? null
        if (codec) cacheUpdate.intercomAudioCompressionType = codec
        // Audio capabilities for the Audio settings tab — populates
        // the codec / input-type selects + speaker-volume slider
        // bounds. Best-effort: 4xx here just leaves the form on
        // safe defaults.
        const audioCaps = await isapi.getAudioCapabilities(channelId)
        if (audioCaps) {
          cacheUpdate.audioCapabilities = {
            audioCodecs: [...audioCaps.audioCodecs],
            audioInputTypes: [...audioCaps.audioInputTypes],
            speakerVolumeMin: audioCaps.speakerVolumeMin,
            speakerVolumeMax: audioCaps.speakerVolumeMax,
            supportsNoiseReduction: audioCaps.supportsNoiseReduction,
          }
        }
      } else {
        cacheUpdate.hasIntercom = false
      }
    } catch (err) {
      this.ctx.logger.debug('hikvision intercom probe failed (best-effort)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      cacheUpdate.hasIntercom = false
    }

    // Image tuning snapshot — reuses the same read+map as the post-save
    // `refreshImageSnapshot`. Best-effort: legacy firmwares may 404 on a
    // sub-resource; we record only what we got. Drives the Image settings
    // tab's hydrated values.
    try {
      const imageSnapshot = await this.buildImageSnapshot()
      if (imageSnapshot) cacheUpdate.imageSnapshot = imageSnapshot
    } catch (err) {
      this.ctx.logger.debug('hikvision image probe failed (best-effort)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Time / NTP snapshot — reuses the same read+map as the post-save
    // `refreshNtpSnapshot`. Best-effort: `getTimeConfig()` degrades to
    // null NTP fields on firmwares without the `/ntpServers` endpoint.
    // Drives the Time / NTP settings section's hydrated values.
    try {
      cacheUpdate.ntpSnapshot = await this.buildNtpSnapshot()
    } catch (err) {
      this.ctx.logger.debug('hikvision time/ntp probe failed (best-effort)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Streaming channel snapshots — probe every channel the camera
    // enumerates via `/ISAPI/Streaming/channels` (typically main /
    // sub / third on multi-stream firmwares; just main on single-
    // stream models). Drives the Stream settings tab — one sub-tab
    // per detected channel, each with its own firmware-advertised
    // bounds. Best-effort: per-channel failures don't abort the
    // probe of the others, and a complete miss leaves the form
    // empty (no Streaming sub-tab is rendered).
    try {
      const streamingChannels = await isapi
        .listChannels()
        .catch(() => [] as readonly HikvisionStreamingChannel[])
      const snapshots: Record<
        string,
        NonNullable<HikvisionDeviceCache>['streamSnapshots'] extends
          | Record<string, infer V>
          | undefined
          ? V
          : never
      > = {}
      for (const channel of streamingChannels) {
        try {
          // Probe channel config + dynamicCap in parallel — the latter
          // 404s on legacy firmware so the failure path here just
          // omits supportedFrameRates from the snapshot, leaving the
          // FPS field as a free-typed number.
          const [cfg, caps] = await Promise.all([
            isapi.getStreamingChannel(channel.id),
            isapi.getStreamingChannelCapabilities(channel.id).catch(() => null),
          ])
          if (!cfg) continue
          snapshots[channel.id] = {
            channelName: cfg.channelName,
            // Channel-level `<enabled>` (element-scoped — NOT `<Video>`'s or
            // `<Audio>`'s). Persisted so the snapshot-source select can mark a
            // channel the camera has switched off.
            enabled: cfg.enabled,
            videoCodecType: cfg.videoCodecType,
            maxFrameRate: cfg.maxFrameRate,
            videoQualityControlType: cfg.videoQualityControlType,
            vbrUpperCap: cfg.vbrUpperCap.value,
            vbrUpperCapMin: cfg.vbrUpperCap.min,
            vbrUpperCapMax: cfg.vbrUpperCap.max,
            constantBitRate: cfg.constantBitRate.value,
            constantBitRateMin: cfg.constantBitRate.min,
            constantBitRateMax: cfg.constantBitRate.max,
            fixedQuality: cfg.fixedQuality,
            govLength: cfg.govLength.value,
            govLengthMin: cfg.govLength.min,
            govLengthMax: cfg.govLength.max,
            smartCodecEnabled: cfg.smartCodecEnabled,
            resolutionWidth: cfg.resolution.width,
            resolutionHeight: cfg.resolution.height,
            ...(caps && caps.supportedFrameRates.length > 0
              ? { supportedFrameRates: [...caps.supportedFrameRates] }
              : {}),
          }
        } catch (err) {
          this.ctx.logger.debug('hikvision streaming channel probe failed', {
            tags: { deviceId: this.id, channelId: channel.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
      if (Object.keys(snapshots).length > 0) {
        cacheUpdate.streamSnapshots = snapshots
      }
    } catch (err) {
      this.ctx.logger.debug('hikvision streaming probe failed (best-effort)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    if (Object.keys(cacheUpdate).length === 0) return
    // Persist the probe results so next boot can short-circuit the
    // probe (informational only — the caps still re-register at
    // runtime). Spread current cache to avoid clobbering other
    // probe-time fields like model / serial / firmware.
    const current = this.config.get('deviceCache') ?? {}
    try {
      await this.config.setAll({
        deviceCache: { ...current, ...cacheUpdate, probedAt: Date.now() },
      })
    } catch (err) {
      this.ctx.logger.debug('hikvision deviceCache update failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Now that hasIntercom (et al) is persisted, re-evaluate cap
    // registration. The ctor's call no-opped because `hasIntercom`
    // was undefined; this second pass picks it up without restart.
    this.registerIntercomIfSupported()

    // Re-publish the meta blob so probe-driven feature flags
    // (`TwoWayAudio`, `PanTiltZoom`, `PtzAutotrack`) appear in
    // `deviceManager.listAll` immediately — without this they only
    // surface on the next server restart for forked-worker devices.
    void this.refreshFeatures()
  }

  // ── PTZ cap ──────────────────────────────────────────────────────

  private registerPtzCap(cameraNumber: number): void {
    const isapi = this.ensureClient()
    const provider: InferNativeProvider<typeof ptzCapability> = {
      move: async ({ deviceId, pan, tilt, zoom, speed }) => {
        if (deviceId !== this.id) return
        // `move` is treated as a one-shot continuous burst: 500ms
        // of motion, then a zero-magnitude stop. This mirrors how
        // Hikvision PTZ commands behave from their own web UI —
        // there's no "absolute step" endpoint, only continuous.
        //
        // `speed` used to be dropped here and the raw DIRECTION handed to
        // ISAPI, whose <pan> is a percentage: the d-pad's `pan: 1, speed: 0.5`
        // reached the camera as 1, one percent of its speed.
        await isapi.ptzContinuous(cameraNumber, {
          pan: isapiSpeedFor(pan, speed),
          tilt: isapiSpeedFor(tilt, speed),
          zoom: isapiSpeedFor(zoom, speed),
        })
        await new Promise<void>((r) => setTimeout(r, PTZ_MOVE_IMPULSE_MS))
        await isapi.ptzContinuous(cameraNumber, { pan: 0, tilt: 0, zoom: 0 })
      },
      continuousMove: async ({ deviceId, pan, tilt, zoom, speed }) => {
        if (deviceId !== this.id) return
        // Same 1%-crawl bug as `move` — the gesture path had it too.
        await isapi.ptzContinuous(cameraNumber, {
          pan: isapiSpeedFor(pan, speed),
          tilt: isapiSpeedFor(tilt, speed),
          zoom: isapiSpeedFor(zoom, speed),
        })
      },
      stop: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        await isapi.ptzContinuous(cameraNumber, { pan: 0, tilt: 0, zoom: 0 })
      },
      getPresets: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        const presets = await isapi.listPtzPresets(cameraNumber)
        // The camera returns its reserved FUNCTION band alongside the
        // operator's stored positions, indistinguishable by shape. Annotating
        // here is what stops the UI offering "overwrite" on "Back to origin".
        return presets.map((p) => ({
          id: p.id,
          name: p.name ?? `Preset ${p.id}`,
          fn: presetFunctionFor(p.id),
          writable: isPresetWritable(p.id),
        }))
      },
      goToPreset: async ({ deviceId, presetId }) => {
        if (deviceId !== this.id) return
        await isapi.ptzGoToPreset(cameraNumber, presetId)
      },
      savePreset: async ({ deviceId, presetId, name }) => {
        if (deviceId !== this.id) return
        // A reserved id is a firmware FUNCTION, not a slot. Writing one used to
        // reach the camera and come back `HTTP 500`, which surfaced to the
        // operator as `transport-failed` with no hint of the cause. Refuse here
        // and say which function owns the id.
        assertPresetWritable(presetId, 'overwritten')
        // Hikvision snapshots the camera's current head position when
        // a `<PTZPreset>` is PUT under the target id.
        await isapi.savePtzPreset(cameraNumber, presetId, name)
      },
      deletePreset: async ({ deviceId, presetId }) => {
        if (deviceId !== this.id) return
        assertPresetWritable(presetId, 'deleted')
        await isapi.deletePtzPreset(cameraNumber, presetId)
      },
      getOptions: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          return {
            hasPan: false,
            hasTilt: false,
            hasZoom: false,
            supportsPresets: false,
            hasAutofocus: false,
            // ISAPI `/continuous` takes a percentage, clamped to -100..100 and
            // rounded, so the usable scale is 100 steps per direction.
            speedSteps: 100,
            moveImpulseMs: PTZ_MOVE_IMPULSE_MS,
          }
        }
        // Re-read `/PTZCtrl/channels/{cam}/capabilities` — the same
        // probe `registerPtzCap` gated on. `maxPresetNum` drives both
        // `supportsPresets` and `maxPresets`.
        // Autofocus is not driven through this cap on Hikvision (the
        // ISAPI focus endpoints are model-dependent and not probed),
        // so `hasAutofocus` is honestly false — the UI hides the toggle.
        const caps = await isapi.getPtzCapabilities(cameraNumber)
        if (!caps) {
          return {
            hasPan: false,
            hasTilt: false,
            hasZoom: false,
            supportsPresets: false,
            hasAutofocus: false,
            // ISAPI `/continuous` takes a percentage, clamped to -100..100 and
            // rounded, so the usable scale is 100 steps per direction.
            speedSteps: 100,
            moveImpulseMs: PTZ_MOVE_IMPULSE_MS,
          }
        }
        const maxPresets = caps.maxPresetCount ?? undefined
        return {
          hasPan: caps.hasPan,
          hasTilt: caps.hasTilt,
          hasZoom: caps.hasZoom,
          supportsPresets: maxPresets === undefined ? true : maxPresets > 0,
          hasAutofocus: false,
          speedSteps: 100,
          moveImpulseMs: PTZ_MOVE_IMPULSE_MS,
          ...(maxPresets !== undefined ? { maxPresets } : {}),
        }
      },
      goHome: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        // This used to be `ptzGoToPreset(cameraNumber, '1')` on the belief that
        // "convention is preset id 1 is home". On the dispensa camera preset 1
        // is "Credenza" — the operator's own. Resolve it instead, and REFUSE
        // when nothing is configured: a head that did not move must never look
        // like a head that went home.
        const home = await this.resolveHomePreset()
        if (home.source === 'none' || home.presetId === null) {
          throw userError(
            'hikvision.home-preset-missing',
            undefined,
            'No home preset configured for this camera — set one in the PTZ settings',
          )
        }
        await isapi.ptzGoToPreset(cameraNumber, home.presetId)
      },
      getHomePreset: async ({ deviceId }) => {
        if (deviceId !== this.id) return { presetId: null, source: 'none' as const }
        return this.resolveHomePreset()
      },
      captureHomeHere: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        // This camera's home IS a preset, so "set home here" has to claim a
        // slot. Never an operator's, never a reserved function id -- and when
        // there is no room, REFUSE rather than pick a victim.
        const [presets, caps] = await Promise.all([
          isapi.listPtzPresets(cameraNumber),
          isapi.getPtzCapabilities(cameraNumber),
        ])
        const slot = findFreePresetSlot(
          presets.map((p) => ({ id: p.id, writable: isPresetWritable(p.id) })),
          caps?.maxPresetCount ?? undefined,
        )
        if (slot === null) {
          throw new Error(
            'No free preset slot on this camera to store a home position — free one first',
          )
        }
        await isapi.savePtzPreset(cameraNumber, slot, HOME_PRESET_NAME)
        await this.config.setAll({ homePresetId: slot })
        this.ctx.logger.info('hikvision: home pinned to the current position', {
          tags: { deviceId: this.id },
          meta: { presetId: slot },
        })
      },
      getHomeReturn: async () => {
        // ISAPI has a park-time knob on some firmwares; we do not read it, and
        // `null` says exactly that. Reporting 0 would claim the camera never
        // returns, which is a different statement (D393).
        return null
      },
      setHomeReturn: async () => {
        throw new Error('Hikvision: the idle-return timer is not wired on this driver')
      },
      setHomePreset: async ({ deviceId, presetId }) => {
        if (deviceId !== this.id) return
        // `setAll` merges — never spread the snapshot back in (CLAUDE.md).
        await this.config.setAll({ homePresetId: presetId ?? '' })
      },
      getPosition: async () => {
        // Hikvision exposes absolute position via `/PTZCtrl/channels/{id}/status`
        // but the data is firmware-dependent and frequently absent on models
        // that report PTZ capability, and we do not read it. `null` is what
        // that IS -- this used to return zeros, telling every caller the head
        // was perfectly centred (D393).
        //
        // The previous comment here pointed callers at "the position event".
        // No such event exists on this cap; it has been removed rather than
        // left to read as verification.
        return { pan: null, tilt: null, zoom: null }
      },
      getStatus: async () => {
        // Position is a stub (see getPosition); autofocus is not driven
        // through this cap on Hikvision (`hasAutofocus` is false).
        return { pan: null, tilt: null, zoom: null, autofocus: false }
      },
      setAutofocus: async () => {
        // No-op — Hikvision doesn't expose autofocus through the `ptz`
        // cap (`getOptions().hasAutofocus` is false, so the UI never
        // surfaces the toggle that would call this).
      },
    }
    this.ctx.registerNativeCap(ptzCapability, provider)
    this.ctx.logger.info('hikvision: PTZ cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  // ── PTZ autotrack cap ────────────────────────────────────────────

  /**
   * Register the `ptz-autotrack` cap. Hikvision exposes autotrack via
   * `/ISAPI/PTZCtrl/channels/{cam}/smartTracking`; the cap surface
   * (cross-vendor) carries three settings: `targetType`,
   * `stopDelaySeconds`, `disappearDelaySeconds`. Only the first two
   * map onto the firmware (when the model advertises support — see
   * `autotrackSupportsType` / `autotrackSupportsDuration` flags from
   * the probe); `disappearDelaySeconds` is accepted at the cap layer
   * but ignored at push time because Hikvision's firmware-side
   * disappear timer is fixed.
   */
  private registerPtzAutotrackCap(cameraNumber: number): void {
    if (this.ptzAutotrackRegistered) return
    this.ptzAutotrackRegistered = true
    const isapi = this.ensureClient()

    const CAP_NAME = 'ptz-autotrack'
    const STALE_MS = 10_000

    const supportedTargetTypesForCache = (): PtzAutotrackStatus['supportedTargetTypes'] => {
      const cache = this.config.get('deviceCache') ?? {}
      // Hikvision's `<smartTrackingType>` accepts these tokens on
      // models that probe-true for `autotrackSupportsType`. When
      // the firmware reports type-not-supported, return an empty
      // list so the UI hides the selector (auto-only tracking).
      return cache.autotrackSupportsType === true
        ? [
            { value: 'auto', label: 'Auto' },
            { value: 'human', label: 'Human' },
            { value: 'vehicle', label: 'Vehicle' },
          ]
        : []
    }

    const readSlice = (): PtzAutotrackRuntimeState | undefined =>
      this.runtimeState.getCapState<PtzAutotrackRuntimeState>(CAP_NAME)

    const refreshFromCamera = async (): Promise<void> => {
      if (this.autotrackRefreshInFlight) return this.autotrackRefreshInFlight
      const promise = (async () => {
        const state = await isapi.getSmartTracking(cameraNumber).catch(() => null)
        if (state === null) {
          this.ctx.logger.debug('hikvision autotrack refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
          })
          return
        }
        const prev = readSlice()
        // Hikvision's smartTracking GET returns { enabled, duration,
        // trackingType }. `disappearDelaySeconds` is firmware-fixed
        // (Hikvision doesn't expose a disappear timer), so we carry
        // forward whatever the slice already had — the operator's
        // last-set value, or the cap default 10.
        const currentSettings: PtzAutotrackSettings = {
          targetType: state.trackingType ?? '',
          stopDelaySeconds: state.duration ?? prev?.currentSettings?.stopDelaySeconds ?? 30,
          disappearDelaySeconds: prev?.currentSettings?.disappearDelaySeconds ?? 15,
        }
        this.runtimeState.setCapState(CAP_NAME, {
          enabled: state.enabled,
          lastChangedAt: prev?.enabled === state.enabled ? (prev?.lastChangedAt ?? 0) : Date.now(),
          currentSettings,
          supportedTargetTypes: supportedTargetTypesForCache(),
          lastFetchedAt: Date.now(),
        })
      })()
      this.autotrackRefreshInFlight = promise
      try {
        await promise
      } finally {
        this.autotrackRefreshInFlight = null
      }
    }

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: ptzAutotrackCapability,
      ownDeviceId: this.id,
      refresh: refreshFromCamera,
      staleMs: STALE_MS,
      empty: (): PtzAutotrackStatus => ({
        enabled: false,
        lastChangedAt: 0,
        currentSettings: null,
        supportedTargetTypes: supportedTargetTypesForCache(),
      }),
    })

    const provider: InferNativeProvider<typeof ptzAutotrackCapability> = {
      getStatus: bridge.getStatus,
      setEnabled: async ({ deviceId, enabled }) => {
        if (deviceId !== this.id) return
        const cache = this.config.get('deviceCache') ?? {}
        // Carry the slice's current settings forward so toggling on
        // doesn't accidentally reset duration/type — the firmware
        // re-applies whatever was there last.
        const current = readSlice()?.currentSettings ?? {
          targetType: '',
          stopDelaySeconds: 30,
          disappearDelaySeconds: 15,
        }
        const params: { enabled: boolean; duration?: number; trackingType?: string } = { enabled }
        if (cache.autotrackSupportsDuration === true) params.duration = current.stopDelaySeconds
        if (cache.autotrackSupportsType === true && current.targetType.length > 0) {
          params.trackingType = current.targetType
        }
        await isapi.setSmartTracking(cameraNumber, params)
        await refreshFromCamera()
      },
      getSettings: async ({ deviceId }) => {
        if (deviceId !== this.id) return null
        await bridge.ensureFresh()
        return readSlice()?.currentSettings ?? null
      },
      setSettings: async ({ deviceId, settings }) => {
        if (deviceId !== this.id) return
        const current = readSlice()?.currentSettings ?? {
          targetType: '',
          stopDelaySeconds: 30,
          disappearDelaySeconds: 15,
        }
        const merged: PtzAutotrackSettings = {
          targetType: settings.targetType ?? current.targetType,
          stopDelaySeconds: settings.stopDelaySeconds ?? current.stopDelaySeconds,
          disappearDelaySeconds: settings.disappearDelaySeconds ?? current.disappearDelaySeconds,
        }

        // Push to firmware only the knobs the camera actually supports.
        // The cap layer accepts the full cross-vendor schema; we
        // narrow at the push site. `disappearDelaySeconds` is always
        // dropped — Hikvision firmware-side disappear timer is fixed.
        const cache = this.config.get('deviceCache') ?? {}
        const params: { enabled: boolean; duration?: number; trackingType?: string } = {
          enabled: readSlice()?.enabled ?? false,
        }
        if (cache.autotrackSupportsDuration === true) params.duration = merged.stopDelaySeconds
        if (cache.autotrackSupportsType === true && merged.targetType.length > 0) {
          params.trackingType = merged.targetType
        }
        try {
          await isapi.setSmartTracking(cameraNumber, params)
        } catch (err) {
          this.ctx.logger.warn('hikvision autotrack setSettings firmware push failed', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          throw err
        }
        // Re-read the camera so we mirror what was actually accepted
        // (firmwares may clamp duration to a permitted enum).
        await refreshFromCamera()
      },
    }
    this.ctx.registerNativeCap(ptzAutotrackCapability, provider)
    this.ctx.logger.info('hikvision: ptz-autotrack cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  // ── Stream-params cap ─────────────────────────────────────────────

  /**
   * Hikvision channel-id convention for a logical camera: the wire id
   * is `<cameraNumber><profileDigit>` — camera 1 → `101` (main), `102`
   * (sub), `103` (ext/third). Ordered so iteration maps 1:1 onto the
   * cap's `main` / `sub` / `ext` profile keys.
   */
  private static readonly STREAM_PROFILE_SLOTS: ReadonlyArray<{
    readonly profile: StreamProfile
    readonly digit: string
  }> = [
    { profile: 'main', digit: '01' },
    { profile: 'sub', digit: '02' },
    { profile: 'ext', digit: '03' },
  ]

  /** Build the ISAPI streaming channel id for a profile (`101`, `102`, `103`). */
  private streamChannelId(cameraNumber: number, digit: string): string {
    return `${cameraNumber}${digit}`
  }

  /**
   * Normalize Hikvision's codec string (`'H.264'`, `'H.265'`, `'h264'`,
   * `'HEVC'`, …) into the cap's `'h264' | 'h265'` enum. Returns
   * `undefined` for unrecognized / absent codecs so the profile is
   * omitted rather than mislabelled.
   */
  private mapHikvisionCodec(raw: string | null): 'h264' | 'h265' | undefined {
    if (!raw) return undefined
    const normalized = raw.toLowerCase().replace(/[.\s-]/g, '')
    if (normalized === 'h265' || normalized === 'hevc') return 'h265'
    if (normalized === 'h264' || normalized === 'avc') return 'h264'
    return undefined
  }

  /**
   * Map one `HikvisionStreamingChannelConfig` into the cap's per-profile
   * `StreamProfileConfigSchema` shape. Returns `undefined` when the
   * channel is missing mandatory fields (codec / resolution / FPS /
   * bitrate) so the cap omits the profile entirely.
   */
  private mapStreamingChannelToConfig(
    cfg: HikvisionStreamingChannelConfig,
  ): StreamParamsStatus['main'] | undefined {
    const codec = this.mapHikvisionCodec(cfg.videoCodecType)
    const width = cfg.resolution.width ?? undefined
    const height = cfg.resolution.height ?? undefined
    const framerate = cfg.maxFrameRate ?? undefined
    // Bitrate is read from the field matching the active quality mode:
    // VBR → vbrUpperCap, CBR → constantBitRate (both in kbps).
    const bitrate =
      cfg.videoQualityControlType === 'CBR'
        ? (cfg.constantBitRate.value ?? undefined)
        : (cfg.vbrUpperCap.value ?? undefined)

    if (
      codec === undefined ||
      width === undefined ||
      height === undefined ||
      framerate === undefined ||
      bitrate === undefined
    )
      return undefined

    const config: StreamParamsStatus['main'] = { width, height, codec, framerate, bitrate }

    if (cfg.videoQualityControlType === 'VBR') config.bitrateMode = 'vbr'
    else if (cfg.videoQualityControlType === 'CBR') config.bitrateMode = 'cbr'

    // Encoder profile — Hikvision reports it on the codec-specific
    // field (`H264Profile` / `H265Profile`). Map the common tokens.
    const rawProfile = codec === 'h265' ? cfg.h265Profile : cfg.h264Profile
    const encoderProfile = this.mapEncoderProfile(rawProfile)
    if (encoderProfile !== undefined) config.encoderProfile = encoderProfile

    if (cfg.govLength.value !== null) config.gop = cfg.govLength.value

    return config
  }

  /**
   * Map a Hikvision H.26x profile token (`'High'`, `'Main'`,
   * `'Baseline'`, `'Main10Profile'`, …) into the cap's coarse
   * `'high' | 'main' | 'baseline'` enum.
   */
  private mapEncoderProfile(raw: string | null): 'high' | 'main' | 'baseline' | undefined {
    if (!raw) return undefined
    const v = raw.toLowerCase()
    if (v.includes('baseline')) return 'baseline'
    if (v.includes('high')) return 'high'
    if (v.includes('main')) return 'main'
    return undefined
  }

  /**
   * Probe the camera's per-profile encoder OPTION lists and map every
   * advertised stream into the cap's `StreamParamsOptions` shape.
   *
   * Single source of the `getStreamingChannel` /
   * `getStreamingChannelCapabilities` round-trip + mapping — shared by
   * the `stream-params` cap's `getOptions` (live) and `getConfigSchema`
   * (which feeds the result to `buildStreamParamsConfigSchema`).
   *
   * Returns `{}` (no profiles) when nothing is advertised — callers
   * treat that as "no Stream section".
   */
  private async probeStreamParamsOptions(cameraNumber: number): Promise<StreamParamsOptions> {
    const isapi = this.ensureClient()
    const result: StreamParamsOptions = {}
    for (const slot of HikvisionCamera.STREAM_PROFILE_SLOTS) {
      const channelId = this.streamChannelId(cameraNumber, slot.digit)
      try {
        // Current config gives resolution + bitrate bounds + which
        // codecs the firmware advertises a profile for; dynamicCap
        // gives the FPS ladder. Both best-effort — a channel that
        // 404s on the config is simply not advertised.
        const [cfg, caps] = await Promise.all([
          isapi.getStreamingChannel(channelId),
          isapi.getStreamingChannelCapabilities(channelId).catch(() => null),
        ])
        if (!cfg) continue

        // Resolutions — the streaming-channel config carries only the
        // active resolution. Surface that single option rather than an
        // empty list so the UI can render the field.
        const resolutions =
          cfg.resolution.width !== null && cfg.resolution.height !== null
            ? [{ width: cfg.resolution.width, height: cfg.resolution.height }]
            : []

        // Codecs — the firmware advertises a per-codec profile tag
        // (`H264Profile` / `H265Profile`) for each codec it supports.
        const codecs: Array<'h264' | 'h265'> = []
        if (cfg.h264Profile !== null) codecs.push('h264')
        if (cfg.h265Profile !== null) codecs.push('h265')
        // Fall back to the active codec when no profile tags exist.
        if (codecs.length === 0) {
          const active = this.mapHikvisionCodec(cfg.videoCodecType)
          if (active !== undefined) codecs.push(active)
        }

        const framerates = caps ? [...caps.supportedFrameRates].toSorted((a, b) => a - b) : []

        // Bitrate — Hikvision takes a continuous range; surface it as
        // `bitrateRange` from the field matching the active quality
        // mode (the two ranges are normally identical).
        const range = cfg.videoQualityControlType === 'CBR' ? cfg.constantBitRate : cfg.vbrUpperCap

        result[slot.profile] = {
          resolutions,
          codecs,
          framerates,
          bitrates: [],
          bitrateRange: [range.min, range.max],
          // Hikvision always exposes VBR/CBR + a GOP (GovLength) knob on
          // the streaming channel. Encoder profile is present only when
          // a codec profile tag was advertised.
          supportsBitrateMode: true,
          supportsEncoderProfile: cfg.h264Profile !== null || cfg.h265Profile !== null,
          supportsGop: true,
        }
      } catch (err) {
        this.ctx.logger.debug('hikvision stream-params getOptions failed for channel', {
          tags: { deviceId: this.id, channelId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    return result
  }

  /**
   * Register the `stream-params` native cap provider.
   *
   * Uses the trampoline pattern (CLAUDE.md "Provider trampoline
   * pattern"): the source of truth is `runtimeState['stream-params']`,
   * kept fresh via a `createRuntimeStateBridge` whose `refresh`
   * round-trips `getStreamingChannel` for each per-profile channel id.
   *
   * - `getStatus`  — slice-driven via the bridge (stale → refresh).
   * - `getOptions` — on-demand; reads `getStreamingChannelCapabilities`
   *                  (firmware-advertised FPS list) + the current
   *                  channel config (resolution / codec / bitrate
   *                  bounds). Not persisted — options don't change at
   *                  runtime.
   * - `setProfile` — read-modify-write: `getStreamingChannel` → patch →
   *                  `setStreamingChannel`, then refresh the slice.
   */
  private registerStreamParamsCap(cameraNumber: number): void {
    const isapi = this.ensureClient()
    const CAP_NAME = 'stream-params' as const
    const STALE_MS = 10_000

    /** Round-trip every profile channel, map into the cap status, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.streamParamsRefreshInFlight) return this.streamParamsRefreshInFlight
      const promise = (async () => {
        try {
          const next: StreamParamsStatus = { lastFetchedAt: Date.now() }
          for (const slot of HikvisionCamera.STREAM_PROFILE_SLOTS) {
            const channelId = this.streamChannelId(cameraNumber, slot.digit)
            const cfg = await isapi.getStreamingChannel(channelId).catch(() => null)
            // Channel absent (404) — omit the profile entirely.
            if (!cfg) continue
            const mapped = this.mapStreamingChannelToConfig(cfg)
            if (mapped !== undefined) next[slot.profile] = mapped
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('hikvision stream-params refresh failed — keeping last slice', {
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
      empty: (): StreamParamsStatus => ({ lastFetchedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof streamParamsCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<StreamParamsOptions> => {
        if (deviceId !== this.id) return {}
        return this.probeStreamParamsOptions(cameraNumber)
      },

      getConfigSchema: async ({ deviceId }): Promise<ConfigUISchema | null> => {
        if (deviceId !== this.id) return null
        // Server-built form: camera-probed availability + current
        // per-profile config (status slice, refreshed if stale).
        // `buildStreamParamsConfigSchema` is the shared, addon-free
        // schema-shaper in `@camstack/types` — Reolink feeds it the
        // same way so both cameras emit a structurally identical form.
        const opts = await this.probeStreamParamsOptions(cameraNumber)
        await bridge.ensureFresh()
        const status = this.runtimeState.getCapState<StreamParamsStatus>(CAP_NAME) ?? null
        return buildStreamParamsConfigSchema(opts, status)
      },

      setProfile: async ({ deviceId, profile, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        // Shared read-modify-write encoder push — see
        // `applyStreamProfilePatch` (also used by the editable Stream
        // section's `applySettingsPatch`).
        await this.applyStreamProfilePatch(cameraNumber, profile, patch)
        // Re-read so the slice mirrors any clamping the firmware applied.
        await refreshFromCamera()
        // Nudge the stream-broker to re-pull this camera's catalog (codec /
        // resolution may have changed). Lossy by design — the broker's poll
        // reconcile is the backstop.
        this.ctx.eventBus.emit(
          createEvent(EventCategory.StreamParamsChanged, this.eventSource, { deviceId: this.id }),
        )
      },
    }

    this.ctx.registerNativeCap(streamParamsCapability, provider)
    this.ctx.logger.info('hikvision: stream-params cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  /**
   * Register the `motion-zones` native cap provider — the on-camera
   * VMD detection grid.
   *
   * Uses the trampoline pattern (CLAUDE.md "Provider trampoline
   * pattern"): the source of truth is `runtimeState['motion-zones']`,
   * kept fresh via a `createRuntimeStateBridge` whose `refresh`
   * round-trips `getMotionGrid` (single-flight).
   *
   * - `getStatus`  — slice-driven via the bridge (stale → refresh).
   * - `getOptions` — on-demand; reads the grid dimensions + the
   *                  firmware-advertised sensitivity slider bounds.
   *                  Not persisted — they don't change at runtime.
   * - `setZone`    — read-modify-write `setMotionGrid`, then refresh.
   */
  private registerMotionZonesCap(cameraNumber: number): void {
    const isapi = this.ensureClient()
    const CAP_NAME = 'motion-zones' as const
    const STALE_MS = 10_000

    /** Round-trip the VMD grid, map into the cap status, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.motionZonesRefreshInFlight) return this.motionZonesRefreshInFlight
      const promise = (async () => {
        try {
          const grid = await isapi.getMotionGrid(cameraNumber)
          if (!grid) return
          const next: MotionZoneStatus = {
            enabled: grid.enabled,
            sensitivity: grid.sensitivityLevel,
            regions: [
              {
                id: 0,
                enabled: true,
                shape: {
                  kind: 'grid',
                  gridWidth: grid.gridWidth,
                  gridHeight: grid.gridHeight,
                  cells: [...grid.cells],
                },
              },
            ],
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('hikvision motion-zones refresh failed — keeping last slice', {
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
      // Cold-start default — no region until first refresh.
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
        // Cold defaults when the call isn't for this device or the
        // camera doesn't expose motion config at all.
        const cold: MotionZoneOptions = {
          maxRegions: 1,
          supportedShapes: ['grid'],
          grid: { width: 0, height: 0 },
          sensitivity: { min: 0, max: 100, step: 1 },
        }
        if (deviceId !== this.id) return cold
        // Grid dimensions + sensitivity bounds are firmware-fixed —
        // read fresh (cheap, single GET) rather than persisting them.
        const grid = await isapi.getMotionGrid(cameraNumber)
        if (!grid) return cold
        return {
          maxRegions: 1,
          supportedShapes: ['grid'],
          grid: { width: grid.gridWidth, height: grid.gridHeight },
          sensitivity: {
            min: grid.sensitivityMin,
            max: grid.sensitivityMax,
            step: grid.sensitivityStep,
          },
        }
      },

      setZone: async ({ deviceId, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        // Grid cells live in the single `grid` region.
        const gridRegion = patch.regions?.find((r) => r.shape.kind === 'grid')
        const cells =
          gridRegion && gridRegion.shape.kind === 'grid' ? [...gridRegion.shape.cells] : undefined
        await isapi.setMotionGrid(cameraNumber, {
          enabled: patch.enabled,
          sensitivity: patch.sensitivity,
          cells,
        })
        // Re-read so the slice mirrors any clamping the firmware applied.
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(motionZonesCapability, provider)
    this.ctx.logger.info('hikvision: motion-zones cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  // ── Privacy-mask cap ──────────────────────────────────────────────

  /**
   * Register the `privacy-mask` native cap provider.
   *
   * The cap models the mask as a boolean cell grid (shared with the
   * motion-zones overlay so the same MotionGridCanvas widget drives both).
   * Internally the camera stores normalized vertex coordinates; we
   * rasterize them to cells on read and convert cells to rects on write.
   *
   * Grid dimensions are borrowed from the motion-zones grid so both
   * overlays line up pixel-perfectly in the admin UI. When the motion
   * grid is unavailable we fall back to a 22×15 lattice (a common
   * Hikvision resolution that divides most stream resolutions evenly).
   *
   * Needs-hardware-verification: ISAPI response shape + canvas dims from
   * Hikvision firmware docs; real-device capture recommended before GA.
   */
  /**
   * Every streaming channel of this camera that carries a patchable
   * `<Audio><enabled>`, with its current value.
   *
   * A channel whose XML has no `<Audio>` block is OMITTED rather than
   * reported as `false` — the two are different answers, and only the second
   * would justify offering the operator a microphone switch. An empty array
   * is therefore the honest "this camera has no controllable audio input".
   */
  /**
   * Tell the stream-broker this camera just restarted an encoder, so it
   * re-dials every source once the camera has settled.
   *
   * `StreamParamsChanged` rather than a new category because that is exactly
   * what it means — the shape of what the camera emits (its SDP, its audio
   * mux) changed. The event is LOSSY by contract; the cost of losing it is the
   * broker keeping a stale session until something else re-dials, which is the
   * status quo this repairs rather than a regression.
   */
  private signalEncoderRestarted(reason: string): void {
    this.ctx.logger.info('hikvision: encoder restarted — nudging the broker to re-dial', {
      tags: { deviceId: this.id },
      meta: { reason },
    })
    this.ctx.eventBus.emit(
      createEvent(EventCategory.StreamParamsChanged, this.eventSource, { deviceId: this.id }),
    )
  }

  private async readStreamAudioChannels(
    cameraNumber: number,
  ): Promise<ReadonlyArray<{ readonly channelId: string; readonly audioEnabled: boolean }>> {
    const isapi = this.ensureClient()
    const results = await Promise.all(
      HikvisionCamera.STREAM_PROFILE_SLOTS.map(async (slot) => {
        const channelId = this.streamChannelId(cameraNumber, slot.digit)
        const cfg = await isapi.getStreamingChannel(channelId).catch(() => null)
        if (!cfg || cfg.audioEnabled === null) return null
        return { channelId, audioEnabled: cfg.audioEnabled }
      }),
    )
    return results.filter((r): r is { channelId: string; audioEnabled: boolean } => r !== null)
  }

  private registerPrivacyMaskCap(cameraNumber: number): void {
    const isapi = this.ensureClient()
    const CAP_NAME = 'privacy-mask' as const

    /**
     * The per-camera AVAILABILITY facts, as the last successful read saw them.
     *
     * `getOptions` used to make its own pair of ISAPI calls on every
     * invocation — and `getCameraStatuses` calls it once per camera per 5s
     * poll, so on this fleet (20 of 29 cameras are Hikvision) it was the
     * single largest source of camera traffic on the badge path.
     *
     * It is not a second copy of anything: `maxRegions` and the audio-channel
     * census live nowhere else, and they come out of the SAME two reads that
     * build the status slice, so they cannot disagree with it. They are kept in
     * the persisted `deviceCache` rather than only in memory because they must
     * survive an addon restart — the status slice does (`durability:
     * 'restored'`), and an options read that did not would be the one caller
     * still dialling every camera after every deploy.
     */
    const readPersistedOptions = (): PrivacyMaskOptions | null => {
      const stored = this.config.get('deviceCache')?.privacyMaskOptions
      if (!stored) return null
      return {
        maxRegions: stored.maxRegions,
        supportedShapes: ['rect', 'polygon'],
        polygonVertices: { min: 4, max: 4 },
        supportsAudioMute: stored.supportsAudioMute,
      }
    }

    /**
     * Epoch ms until which a COLD options probe is not re-attempted.
     *
     * Only the cold path below can dial, and only on a camera that has never
     * produced a descriptor — but "never" and "unreachable" are the same state,
     * so without this an unreachable camera would be dialled once per poll
     * forever. Same constant, same reasoning as the bridge's own miss cooldown.
     */
    let optionsProbeCooldownUntil = 0

    /** Persist the descriptor, but only when it actually MOVED — this runs on
     *  every refresh and a per-refresh SQLite commit for an unchanged model
     *  capability is pure churn. Best-effort: a failed write costs the next
     *  restart one probe. */
    const persistOptions = async (next: PrivacyMaskOptions): Promise<void> => {
      const stored = this.config.get('deviceCache')?.privacyMaskOptions
      if (
        stored &&
        stored.maxRegions === next.maxRegions &&
        stored.supportsAudioMute === next.supportsAudioMute
      )
        return
      try {
        const previous = this.config.get('deviceCache') ?? {}
        await this.config.setAll({
          deviceCache: {
            ...previous,
            privacyMaskOptions: {
              maxRegions: next.maxRegions,
              supportsAudioMute: next.supportsAudioMute,
              fetchedAt: Date.now(),
            },
          },
        })
      } catch (err) {
        this.ctx.logger.debug('hikvision privacy-mask options persist failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    /** Round-trip the privacy-mask config → cap regions, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.privacyMaskRefreshInFlight) return this.privacyMaskRefreshInFlight
      const promise = (async () => {
        try {
          // Mask and microphone live on different ISAPI sub-trees; fetch
          // them together so one `getStatus` is one round of I/O.
          const [mask, audio] = await Promise.all([
            isapi.getPrivacyMask(cameraNumber),
            this.readStreamAudioChannels(cameraNumber),
          ])
          if (!mask) return
          await persistOptions({
            maxRegions: mask.maxRegions > 0 ? mask.maxRegions : 4,
            supportedShapes: ['rect', 'polygon'],
            polygonVertices: { min: 4, max: 4 },
            // Probed: true only when at least one streaming channel actually
            // emitted an `<Audio><enabled>` we know how to patch.
            supportsAudioMute: audio.length > 0,
          })
          // ISAPI regions are vertex polygons — surface an axis-aligned
          // quad as a 'rect' (nicer handles) and anything else as a free
          // 'polygon'.
          const regions: PrivacyMaskRegion[] = mask.regions.map((region, index) => ({
            id: index,
            enabled: true,
            shape: pointsToPrivacyShape(region.points),
          }))
          const next: PrivacyMaskStatus = {
            enabled: mask.enabled,
            regions,
            audioEnabled: summarisePrivacyAudio(audio),
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('hikvision privacy-mask refresh failed — keeping last slice', {
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
      // The mask and the microphone move only when an operator moves them, and
      // `setMask` / `setAudioEnabled` both re-read the camera into this slice —
      // so a write is its own invalidation and the window only bounds a change
      // made in the camera's own web UI. Served-and-revalidated because the
      // fleet-wide `getCameraStatuses` polls this cap every 5s per camera and
      // must never put an ISAPI round trip on that request path (D221).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      // A refresh that stops landing is otherwise silent here: the catch above
      // keeps the last slice at debug level.
      logger: this.ctx.logger,
      empty: (): PrivacyMaskStatus => ({
        enabled: false,
        // `null`, never `[]` — see the cap's `regions` doc. A cold slice that
        // said "no zones" was one Save away from deleting the operator's mask.
        regions: null,
        // Never `false` on a cold slice: "we have not asked the camera" must
        // not render as "the operator muted it".
        audioEnabled: null,
        lastFetchedAt: 0,
      }),
    })

    const provider: InferNativeProvider<typeof privacyMaskCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<PrivacyMaskOptions> => {
        // Hikvision privacy zones are 4-vertex polygons (axis-aligned =
        // rectangle, otherwise a free quad). Both shape kinds map onto the
        // same 4-corner ISAPI region.
        //
        // A descriptor built without asking THIS camera must not advertise a
        // microphone switch — a control that writes nothing is worse than an
        // absent one — which is why the answer comes from the refresh rather
        // than from a constant.
        if (deviceId !== this.id) {
          return {
            maxRegions: 4,
            supportedShapes: ['rect', 'polygon'],
            polygonVertices: { min: 4, max: 4 },
            supportsAudioMute: false,
          }
        }
        // Same freshness window as the status: these facts come out of the
        // same two ISAPI reads, so asking for them separately would double the
        // per-poll traffic and let the two answers disagree. On a stale slice
        // this returns immediately and refreshes behind us, which is the whole
        // point — the descriptor below is the one the last read persisted.
        await bridge.ensureFresh()
        const warm = readPersistedOptions()
        if (warm !== null) return warm
        // The options half is COLD. It has its own cold path because the two
        // halves have different lifetimes: the status slice is `durability:
        // 'restored'`, so after an addon restart it can come back from the
        // database still INSIDE the freshness window — `ensureFresh` then
        // correctly does nothing, and the descriptor it would have persisted is
        // not there. A cold read awaits, exactly as it does for the status.
        if (Date.now() >= optionsProbeCooldownUntil) {
          optionsProbeCooldownUntil = Date.now() + RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS
          await refreshFromCamera()
          const cold = readPersistedOptions()
          if (cold !== null) return cold
        }
        // Never answered, ever. Unknown is the honest report — a fabricated
        // descriptor would render controls for a camera we have not reached.
        throw new Error(
          `device ${String(this.id)}: privacy-mask options unknown — the camera has not answered`,
        )
      },

      setMask: async ({ deviceId, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        // DEBUG: trace the save payload end-to-end (UI → provider → camera).
        this.ctx.logger.info('hik privacy-mask setMask: PAYLOAD', {
          tags: { deviceId: this.id },
          meta: { patch: JSON.stringify(patch) },
        })
        const ispPatch: { enabled?: boolean; regions?: readonly HikvisionPrivacyMaskRegion[] } = {}

        if (patch.enabled !== undefined) {
          ispPatch.enabled = patch.enabled
        }

        if (patch.regions !== undefined) {
          // Every shape becomes a vertex polygon: a 'rect' expands to its
          // 4 axis-aligned corners; a 'polygon' passes its vertices through.
          ispPatch.regions = patch.regions
            .filter((r) => r.enabled)
            .map((r) => ({ points: privacyShapeToPoints(r.shape) }))
        }

        if (ispPatch.enabled === undefined && ispPatch.regions === undefined) {
          this.ctx.logger.warn(
            'hik privacy-mask setMask: nothing to write (no enable + no regions)',
            {
              tags: { deviceId: this.id },
            },
          )
          return
        }
        this.ctx.logger.info('hik privacy-mask setMask: WRITING ISAPI (setPrivacyMask)', {
          tags: { deviceId: this.id },
          meta: { ispPatch: JSON.stringify(ispPatch) },
        })
        await isapi.setPrivacyMask(cameraNumber, ispPatch)
        // Re-read so the slice mirrors the firmware-accepted state.
        await refreshFromCamera()
        this.ctx.logger.info('hik privacy-mask setMask: CAMERA STATE AFTER', {
          tags: { deviceId: this.id },
          meta: {
            regions: JSON.stringify(
              this.runtimeState.getCapState<PrivacyMaskStatus>(CAP_NAME)?.regions ?? [],
            ),
          },
        })
      },

      setAudioEnabled: async ({ deviceId, enabled }): Promise<void> => {
        if (deviceId !== this.id) return
        const startedAt = Date.now()
        // EVERY channel that has an audio mux, not just the main stream.
        // "Privacy" that leaves the sub-stream carrying sound is not privacy,
        // and a half-muted camera is exactly the state the operator would
        // never be shown.
        const channels = await this.readStreamAudioChannels(cameraNumber)
        if (channels.length === 0) {
          // Refused, not silently swallowed: this is the branch that would
          // otherwise report success for a write the camera never took.
          this.ctx.logger.warn('hik privacy audio: camera exposes NO audio mux — refusing', {
            tags: { deviceId: this.id },
            meta: { cameraNumber },
          })
          throw new Error(
            `device ${String(this.id)}: this camera exposes no controllable audio input`,
          )
        }
        const targets = channels.filter((c) => c.audioEnabled !== enabled).map((c) => c.channelId)
        if (targets.length === 0) {
          // Nothing to write. Do NOT restart anything and do NOT nudge the
          // broker — a no-op that re-dials three RTSP sessions is a worse
          // outcome than the no-op it was asked to perform.
          await refreshFromCamera()
          return
        }

        // PARALLEL, and the measurement is the argument. Sequentially these
        // three PUTs cost 25.5 s wall on 104 (2026-08-07) — the same mutation
        // with every channel already in the target state costs 50-150 ms, so
        // essentially all of it is the camera restarting an encoder per PUT
        // and answering only when it is done. They address three DIFFERENT
        // ISAPI resources (`/Streaming/channels/101|102|103`) with no shared
        // read-modify-write, so there is nothing to serialise; Reolink's
        // `setEnc` is the opposite case and stays sequential on purpose.
        //
        // Parallel also collapses three staggered encoder-restart windows into
        // one, which is what the broker re-dial below has to wait out.
        const writes = await Promise.allSettled(
          targets.map((channelId) =>
            isapi.setStreamingChannel(channelId, { audioEnabled: enabled }),
          ),
        )
        const threw = writes.flatMap((r, i) => (r.status === 'rejected' ? [targets[i] ?? '?'] : []))

        // Verify, per channel — a rejected PUT and an accepted-then-ignored
        // PUT are indistinguishable from here, and only the camera knows.
        const after = await this.readStreamAudioChannels(cameraNumber).catch(
          (): readonly { readonly channelId: string; readonly audioEnabled: boolean }[] => [],
        )
        const { accepted, refused } = classifyAudioWrite(targets, after, enabled)
        if (refused.length > 0) {
          // Put the accepted channels BACK. A privacy control that half-applies
          // is the one outcome worse than an unavailable one (D74) — and this
          // holds in the ENABLE direction too, where a half-restore leaves the
          // operator believing sound is back on a stream that is still silent.
          await Promise.allSettled(
            accepted.map((channelId) =>
              isapi.setStreamingChannel(channelId, { audioEnabled: !enabled }),
            ),
          )
          this.ctx.logger.warn('hik privacy audio: channel REFUSED the write — reverted', {
            tags: { deviceId: this.id },
            meta: {
              enabled,
              refused: refused.join(','),
              reverted: accepted.join(','),
              threw: threw.join(','),
              elapsedMs: Date.now() - startedAt,
            },
          })
          this.signalEncoderRestarted('privacy-audio-revert')
          await refreshFromCamera()
          throw new Error(
            `device ${String(this.id)}: the camera refused to change audio on ${refused.join(', ')} — ` +
              'the change was reverted',
          )
        }
        this.ctx.logger.info('hik privacy audio: microphone written', {
          tags: { deviceId: this.id },
          meta: {
            enabled,
            channels: targets.join(','),
            skipped: channels.length - targets.length,
            elapsedMs: Date.now() - startedAt,
          },
        })
        // The camera just restarted an encoder per channel. Every live RTSP
        // reader dropped and reconnected DURING that window, so each one is
        // holding whatever SDP the camera offered mid-change — on 104 that was
        // a video-only session against a camera whose microphone was on, and
        // nothing re-dialed because the session was perfectly healthy. Tell the
        // broker; it waits for the camera to settle and dials again.
        this.signalEncoderRestarted('privacy-audio')
        // Read back — the slice must mirror what the firmware ACCEPTED, not
        // what we asked for. Deliberately the LAST thing: the mutation has
        // already done everything the device needs.
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(privacyMaskCapability, provider)
    this.ctx.logger.info('hikvision: privacy-mask cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  // ── Day/night cap ─────────────────────────────────────────────────

  /**
   * Register the `day-night` native cap provider — the vendor-neutral
   * IR-cut mode control shared with reolink/amcrest. Hikvision exposes
   * IR-cut switching mode at `/ISAPI/Image/channels/{cam}/IrcutFilter`
   * (`IrcutFilterType`: auto/day/night/schedule) — the enum matches the
   * cap's `DayNightMode` one-for-one, so no value mapping is needed.
   *
   * TODO: photocell `sensitivity` and `switchDelaySec` have no wired
   * ISAPI equivalent in `HikvisionIsapiClient` yet — the existing
   * `IrcutFilter` parser only reads `IrcutFilterType`. Advertised as
   * unsupported (`false`) rather than guessing an undocumented XML tag;
   * revisit once a real-device capture confirms the sensitivity/delay
   * field names.
   */
  /**
   * `recording-onboard` — the camera's own card and the camera's own
   * schedule.
   *
   * The cap's field set is identical on every vendor; what this provider
   * decides is which of those fields THIS camera can write, and it says
   * why for each one it cannot. A write the camera cannot honour is
   * refused by name through `describeOnboardRefusal` — never accepted
   * and dropped, because silence on a recording setting leaves the
   * operator believing the camera is recording the way the form says.
   */
  private registerRecordingOnboardCap(): void {
    const isapi = this.ensureClient()
    const CAP_NAME = 'recording-onboard' as const

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

    const refreshFromCamera = async (): Promise<void> => {
      if (this.recordingOnboardRefreshInFlight) return this.recordingOnboardRefreshInFlight
      const promise = (async () => {
        try {
          const [storageXml, tracksXml] = await Promise.all([
            isapi.getOnboardStorageXml(),
            isapi.getRecordTracksXml(),
          ])
          const storage =
            storageXml === null
              ? ({
                  kind: 'unknown',
                  reason: 'The camera did not answer /ISAPI/ContentMgmt/Storage.',
                } as const)
              : parseOnboardStorage(storageXml)
          const tracks = tracksXml === null ? [] : parseRecordTracks(tracksXml)
          const next = buildOnboardStatus({ storage, tracks, now: Date.now() })
          this.runtimeState.setCapState(CAP_NAME, next)

          if (next.recordingToNowhere) {
            // A camera recording to a card that is not there produces no
            // error of its own — measured on two of this fleet. The only
            // place it can surface is here.
            this.ctx.logger.warn(
              'hikvision onboard recording: camera is scheduled to record and has no usable storage',
              {
                tags: { deviceId: this.id },
                meta: { primaryTrackId: next.primaryTrackId, windows: next.windows.length },
              },
            )
          }
          if (next.unreadableWindows > 0) {
            this.ctx.logger.warn(
              'hikvision onboard recording: some schedule windows could not be read — the schedule shown is incomplete',
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
          this.ctx.logger.debug('hikvision onboard recording refresh failed — keeping last slice', {
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
      // Operator-written config: a long window with a background
      // revalidate, so opening the Config tab never blocks on the camera.
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: emptyStatus,
    })

    const readOptions = (): RecordingOnboardOptions =>
      buildOnboardOptions({
        status: this.runtimeState.getCapState<RecordingOnboardStatus>(CAP_NAME) ?? null,
        writesEnabled: true,
        writeBlockedReason: 'unused',
      })

    const provider: InferNativeProvider<typeof recordingOnboardCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<RecordingOnboardOptions> => {
        if (deviceId !== this.id) {
          return buildOnboardOptions({
            status: null,
            writesEnabled: false,
            writeBlockedReason: 'unused',
          })
        }
        await bridge.ensureFresh()
        return readOptions()
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return

        // Refuse BEFORE touching the camera, against what this camera
        // said it accepts. One vocabulary, shared with every provider.
        await bridge.ensureFresh()
        const options = readOptions()
        const refusal = describeOnboardRefusal(options, settings)
        if (refusal !== null) {
          this.ctx.logger.warn(
            'hikvision onboard recording: refusing a write the camera cannot take',
            {
              tags: { deviceId: this.id },
              meta: { refusal, fields: Object.keys(settings) },
            },
          )
          throw new Error(`device ${String(this.id)}: ${refusal}`)
        }

        const status = this.runtimeState.getCapState<RecordingOnboardStatus>(CAP_NAME) ?? null
        const trackId = status?.primaryTrackId ?? null
        if (trackId === null) {
          throw new Error(
            `device ${String(this.id)}: this camera exposes no enabled video recording track to write to`,
          )
        }

        const current = await isapi.getRecordTrackXml(trackId)
        const outcome = applyOnboardPatchToTrackXml(current, settings)
        if (outcome.missingTags.length > 0) {
          // A PUT of an unchanged document would answer 200 and change
          // nothing — success for a write that never happened.
          throw new Error(
            `device ${String(this.id)}: this camera's track ${trackId} carries no field for ${outcome.missingTags.join(', ')}, so the change was not made`,
          )
        }
        if (!outcome.changed) return

        await isapi.putRecordTrackXml(trackId, outcome.xml)
        this.ctx.logger.info('hikvision onboard recording: wrote the camera track', {
          tags: { deviceId: this.id },
          meta: { trackId, fields: Object.keys(settings) },
        })
        // The camera's answer is the truth, not the patch: firmware
        // clamps, and a form seeded from the patch would show a value
        // the camera never took.
        await refreshFromCamera()
        // And SAY when it clamped. Measured on 1436, 2026-09-22: a PUT of
        // `PreRecordTimeSeconds: 8` answered `200 / statusCode 1 / OK` and
        // stored **5** — neither the asked value nor the previous one. The
        // camera declares no allowed set for this field (its own
        // `/capabilities` returns a plain value, not an `opt=` list), so
        // there is nothing to refuse against beforehand: the only honest
        // moment is after the read-back. Re-reading alone makes the
        // difference visible; it does not make it EXPLAINED, and a silent
        // substitution is what D599 spent a day removing from the clip path.
        const landed = this.runtimeState.getCapState<RecordingOnboardStatus>(CAP_NAME) ?? null
        const clamped = describeOnboardClamp(settings, landed)
        if (clamped.length > 0) {
          this.ctx.logger.warn(
            'hikvision onboard recording: the camera stored a different value than asked',
            { tags: { deviceId: this.id }, meta: { trackId, clamped } },
          )
        }
      },
    }

    this.ctx.registerNativeCap(recordingOnboardCapability, provider)
    this.ctx.logger.info('hikvision: recording-onboard cap registered', {
      tags: { deviceId: this.id },
    })
  }

  private registerDayNightCap(cameraNumber: number): void {
    const isapi = this.ensureClient()
    const CAP_NAME = 'day-night' as const
    const STALE_MS = 10_000

    /** Round-trip the IR-cut filter mode, map into the cap status, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.dayNightRefreshInFlight) return this.dayNightRefreshInFlight
      const promise = (async () => {
        try {
          const filter = await isapi.getIrcutFilter(cameraNumber)
          if (!filter) return
          const next: DayNightStatus = {
            mode: toDayNightMode(filter.mode),
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('hikvision day-night refresh failed — keeping last slice', {
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
      // Cold-start default — no camera round-trip has landed yet.
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
        // Firmware-fixed enum — probe the endpoint once to confirm this
        // camera exposes IR-cut control at all; the mode set itself
        // doesn't vary firmware-to-firmware.
        const filter = await isapi.getIrcutFilter(cameraNumber)
        if (!filter) return cold
        return {
          modes: [...HIKVISION_DAY_NIGHT_MODES],
          supportsSensitivity: false,
          supportsSwitchDelay: false,
        }
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        if (settings.mode !== undefined) {
          await isapi.setIrcutFilter(cameraNumber, { mode: settings.mode })
        }
        // sensitivity / switchDelaySec: no wired ISAPI field yet — ignored.
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(dayNightCapability, provider)
    this.ctx.logger.info('hikvision: day-night cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  // ── Image-settings cap ────────────────────────────────────────────

  /**
   * Register the `image-settings` native cap provider — vendor-neutral
   * picture-adjustment controls shared with reolink/amcrest. Hikvision's
   * `/ISAPI/Image/channels/{cam}` sub-resources map cleanly onto FOUR
   * of the cap's fields:
   *   - brightness/contrast/saturation ← `/color` (`getImageColor`/`setImageColor`)
   *   - sharpness                      ← `/sharpness` (separate endpoint)
   *   - backlightMode `'off'`/`'wdr'`  ← `/WDR` (`getImageWdr`/`setImageWdr`, open/close)
   * All four are ALREADY normalized 0..100 on the wire (the ISAPI
   * client's `setImageColor`/`setImageSharpness` clamp to that range),
   * so no unit conversion is needed for the cap's normalized-0-100
   * contract — the range descriptor is the identity `{0,100,1}`.
   *
   * TODO — no wired ISAPI equivalent in `HikvisionIsapiClient` yet, left
   * unsupported (honest `false`/`[]` in `getOptions`) rather than
   * guessing undocumented XML tags:
   *   - mirror / flip / rotate
   *   - white-balance mode + manual warmth
   *   - exposure mode
   *   - backlightMode `'blc'` / `'hlc'` (only the WDR on/off toggle is wired)
   */
  private registerImageSettingsCap(cameraNumber: number): void {
    const isapi = this.ensureClient()
    const CAP_NAME = 'image-settings' as const
    const STALE_MS = 10_000
    const NORMALIZED_RANGE = { min: 0, max: 100, step: 1 } as const

    /** Round-trip color + sharpness + WDR, map into the cap status, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.imageSettingsRefreshInFlight) return this.imageSettingsRefreshInFlight
      const promise = (async () => {
        try {
          const [color, sharpness, wdr] = await Promise.all([
            isapi.getImageColor(cameraNumber),
            isapi.getImageSharpness(cameraNumber),
            isapi.getImageWdr(cameraNumber),
          ])
          if (!color && sharpness === null && !wdr) return
          const next: ImageSettingsStatus = {
            brightness: color?.brightness ?? undefined,
            contrast: color?.contrast ?? undefined,
            saturation: color?.saturation ?? undefined,
            sharpness: sharpness ?? color?.sharpness ?? undefined,
            backlightMode: wdr ? (wdr.enabled ? 'wdr' : 'off') : undefined,
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('hikvision image-settings refresh failed — keeping last slice', {
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
      // Cold-start default — no camera round-trip has landed yet.
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
        const [color, sharpness, wdr] = await Promise.all([
          isapi.getImageColor(cameraNumber),
          isapi.getImageSharpness(cameraNumber),
          isapi.getImageWdr(cameraNumber),
        ])
        const hasBrightness = color?.brightness !== null && color?.brightness !== undefined
        const hasContrast = color?.contrast !== null && color?.contrast !== undefined
        const hasSaturation = color?.saturation !== null && color?.saturation !== undefined
        const hasSharpness = sharpness !== null
        const backlightModes: BacklightMode[] = wdr ? ['off', 'wdr'] : []
        return {
          supportsBrightness: hasBrightness,
          brightness: hasBrightness ? NORMALIZED_RANGE : undefined,
          supportsContrast: hasContrast,
          contrast: hasContrast ? NORMALIZED_RANGE : undefined,
          supportsSaturation: hasSaturation,
          saturation: hasSaturation ? NORMALIZED_RANGE : undefined,
          supportsSharpness: hasSharpness,
          sharpness: hasSharpness ? NORMALIZED_RANGE : undefined,
          supportsMirror: false,
          supportsFlip: false,
          rotateOptions: [],
          whiteBalanceModes: [],
          supportsWarmth: false,
          exposureModes: [],
          backlightModes,
        }
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        if (
          settings.brightness !== undefined ||
          settings.contrast !== undefined ||
          settings.saturation !== undefined
        ) {
          await isapi.setImageColor(cameraNumber, {
            brightness: settings.brightness,
            contrast: settings.contrast,
            saturation: settings.saturation,
          })
        }
        if (settings.sharpness !== undefined) {
          await isapi.setImageSharpness(cameraNumber, settings.sharpness)
        }
        if (settings.backlightMode === 'wdr') {
          await isapi.setImageWdr(cameraNumber, { enabled: true })
        } else if (settings.backlightMode === 'off') {
          await isapi.setImageWdr(cameraNumber, { enabled: false })
        }
        // 'blc' / 'hlc' backlightMode, mirror / flip / rotate /
        // whiteBalance / warmth / exposureMode: no wired ISAPI
        // equivalent yet — ignored (provider skips unsupported fields).
        await refreshFromCamera()
      },
    }

    this.ctx.registerNativeCap(imageSettingsCapability, provider)
    this.ctx.logger.info('hikvision: image-settings cap registered', {
      tags: { deviceId: this.id },
      meta: { cameraNumber },
    })
  }

  /**
   * Translate a cap-layer `StreamProfilePatch` into the field set
   * `setStreamingChannel` accepts. `current` is the freshly-read
   * channel config — used to resolve which quality-mode field a
   * `bitrate` patch targets and to skip fields the firmware ignores.
   *
   * `width` / `height` carry no `setStreamingChannel` field today
   * (resolution is a paired write Hikvision quirk) — they are silently
   * dropped, which the cap contract explicitly permits.
   *
   * `audio` is NOT in `StreamProfilePatch` at all any more: the camera's
   * microphone is a whole-device fact with one writer,
   * `privacyMask.setAudioEnabled`, which patches every channel's
   * `<Audio><enabled>` together.
   */
  private buildStreamingChannelPatch(
    patch: StreamProfilePatch,
    current: HikvisionStreamingChannelConfig,
  ): Parameters<HikvisionIsapiClient['setStreamingChannel']>[1] {
    const out: Parameters<HikvisionIsapiClient['setStreamingChannel']>[1] = {}

    if (patch.codec !== undefined) {
      out.videoCodecType = patch.codec === 'h265' ? 'H.265' : 'H.264'
    }
    if (patch.framerate !== undefined) {
      out.maxFrameRate = patch.framerate
    }
    if (patch.gop !== undefined) {
      out.govLength = patch.gop
    }
    // The quality mode either comes from the patch or, when only a
    // bitrate is supplied, is inferred from the channel's current mode.
    const mode = patch.bitrateMode ?? (current.videoQualityControlType === 'CBR' ? 'cbr' : 'vbr')
    if (patch.bitrateMode !== undefined) {
      out.videoQualityControlType = patch.bitrateMode === 'cbr' ? 'CBR' : 'VBR'
    }
    if (patch.bitrate !== undefined) {
      // Route the bitrate to the field the (resolved) quality mode reads.
      if (mode === 'cbr') out.constantBitRate = patch.bitrate
      else out.vbrUpperCap = patch.bitrate
    }
    return out
  }

  /**
   * Read-modify-write one streaming channel from a `StreamProfilePatch`.
   *
   * Single source of the `getStreamingChannel` → `buildStreamingChannelPatch`
   * → `setStreamingChannel` round-trip — shared by the `stream-params`
   * cap's `setProfile` and the editable Stream section's
   * `applySettingsPatch`, so there is exactly one ISAPI path for
   * encoder writes.
   */
  private async applyStreamProfilePatch(
    cameraNumber: number,
    profile: StreamProfile,
    patch: StreamProfilePatch,
  ): Promise<void> {
    const slot = HikvisionCamera.STREAM_PROFILE_SLOTS.find((s) => s.profile === profile)
    if (!slot) return
    const isapi = this.ensureClient()
    const channelId = this.streamChannelId(cameraNumber, slot.digit)

    // Read the current channel so the patch resolves the right
    // quality-mode bitrate field and so we know the active codec.
    const current = await isapi.getStreamingChannel(channelId)
    if (!current) {
      throw new Error(`Hikvision stream-params: channel ${channelId} not available on this camera`)
    }
    const channelPatch = this.buildStreamingChannelPatch(patch, current)
    if (Object.keys(channelPatch).length === 0) return

    // `setStreamingChannel` is itself read-modify-write — it GETs
    // the channel XML, splices our fields, and PUTs the whole tree.
    await isapi.setStreamingChannel(channelId, channelPatch)
  }

  // ── Accessory child auto-spawn ───────────────────────────────────
  //
  // Supplemental light + siren land as child accessories (one device
  // per kind, each with its own `switch` cap, settings UI, and per-
  // accessory state). The parent's `getAccessoryChildren` is called
  // by the kernel after `onCreated` resolves; the kernel handles
  // allocate-id / persist-meta / persist-config / construct / register
  // for each spec via the same `kernel.devices.*` API it uses for
  // top-level devices (see `spawnAccessoryChild` in the device-cap
  // proxy). Restoring an existing accessory is automatic: the kernel
  // detects the persisted row by the deterministic stableId
  // (`{parent.stableId}-acc-{kind}`) and skips the pre-persist step.
  //
  // The `parent: this` capture is intentional — accessories receive
  // the parent through the closure so they can call `ensureClient()`
  // / `lightSupportedModes()` / `alarmInputPorts()` without a
  // circular import.
  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const cache = this.config.get('deviceCache')
    if (!cache) return []
    const out: AccessoryChildSpec[] = []
    const push = (
      kind: AccessoryKindValue,
      type: DeviceType,
      label: string,
      config: Record<string, unknown>,
    ): void => {
      out.push({
        stableIdSuffix: `acc-${kind}`,
        meta: {
          type,
          name: `${this.name} ${label}`,
        },
        config,
        factory: (ctx) => createAccessoryDevice(kind, ctx, this),
      })
    }
    // Spawn the LightAccessory ONLY when the camera has at least one
    // operator-driven white-light mode. IR-only models advertise just
    // `irLight,close` — the IR LEDs are auto-driven by the light sensor
    // and a separate Switch/Light child device would be misleading
    // (operator can't really "turn them off" — they fire on darkness).
    // For those models, the supplemental light tunes via the parent's
    // Light settings tab instead. See `probeAndPersistAccessoryCaps`
    // for `lightHasWhiteLight` derivation.
    if (cache.hasSupplementalLight === true && cache.lightHasWhiteLight === true) {
      const defaultMode = cache.lightDefaultMode ?? 'colorVuWhiteLight'
      push(AccessoryKind.Floodlight, DeviceType.Light, ACCESSORY_LABEL[AccessoryKind.Floodlight], {
        kind: AccessoryKind.Floodlight,
        cameraNumber: DEFAULT_CAMERA_NUMBER,
        mode: defaultMode,
        defaultBrightness: 100,
      })
    }
    if (cache.hasAlarmIo === true) {
      // Seed the SirenAccessory with the first probed port so the
      // built-in siren (commonly port 1) flips out of the box on
      // single-input cameras.
      const firstPort = cache.alarmInputPorts?.[0] ?? 1
      push(AccessoryKind.Siren, DeviceType.Siren, ACCESSORY_LABEL[AccessoryKind.Siren], {
        kind: AccessoryKind.Siren,
        cameraNumber: DEFAULT_CAMERA_NUMBER,
        port: firstPort,
        pulseDurationMs: 5_000,
      })
    }
    return out
  }

  // Accessor methods exposed via `HikvisionLightHost` /
  // `HikvisionSirenHost`. Kept thin — they just unwrap the persisted
  // probe results from `deviceCache`. Empty defaults on cameras that
  // didn't expose the corresponding capability (the schema's `?:`
  // markers + the runtime `?? []` keep the shape ergonomic).
  lightSupportedModes(): readonly string[] {
    return this.config.get('deviceCache')?.lightSupportedModes ?? []
  }
  alarmInputPorts(): readonly number[] {
    return this.config.get('deviceCache')?.alarmInputPorts ?? []
  }

  private deriveCamStreamId(ch: HikvisionStreamingChannel): string {
    // Single-camera devices: `main` / `sub` / `third` for parity with
    // the well-known stream-broker labels. Multi-channel devices
    // disambiguate with the camera number prefix (`ch2-main`, ...).
    const slot =
      ch.streamSlot === 1 ? 'main' : ch.streamSlot === 2 ? 'sub' : `slot-${ch.streamSlot}`
    return ch.cameraNumber === 1 ? `native:${slot}` : `ch${ch.cameraNumber}-${slot}`
  }

  private deriveStreamLabel(ch: HikvisionStreamingChannel): string {
    const slot =
      ch.streamSlot === 1 ? 'Main' : ch.streamSlot === 2 ? 'Sub' : `Slot ${ch.streamSlot}`
    return ch.cameraNumber === 1 ? slot : `Cam ${ch.cameraNumber} — ${slot}`
  }

  private fallbackChannels(): readonly HikvisionStreamingChannel[] {
    // No discovery worked — assume single camera with main + sub.
    return [
      {
        id: '101',
        cameraNumber: 1,
        streamSlot: 1,
        enabled: true,
        codec: null,
        width: null,
        height: null,
        maxBitrateKbps: null,
      },
      {
        id: '102',
        cameraNumber: 1,
        streamSlot: 2,
        enabled: true,
        codec: null,
        width: null,
        height: null,
        maxBitrateKbps: null,
      },
    ]
  }

  private buildRtspUrl(channelId: string): string {
    const username = encodeURIComponent(this.config.get('username') ?? 'admin')
    const password = encodeURIComponent(this.config.get('password'))
    const host = this.config.get('host')
    const transport = this.config.get('rtspTransport') ?? 'unicast'
    // Hikvision's canonical RTSP URL — port 554 is the firmware default
    // and is independent of the ISAPI port. Surfacing it as a separate
    // field would let installations behind a NAT remap; deferred until
    // a real user reports the need.
    return `rtsp://${username}:${password}@${host}:554/Streaming/Channels/${channelId}?transportmode=${transport}`
  }

  /**
   * Compat shim for legacy `ICameraDevice.getStreamSources()` consumers.
   * The broker PULLS the real catalog via the `stream-catalog` cap; this
   * just reflects the `published` map (reconciled on every `buildStreamCatalog`
   * pull) into the legacy shape.
   */
  async getStreamSources(): Promise<readonly StreamSourceEntry[]> {
    const out: StreamSourceEntry[] = []
    for (const p of this.published.values()) {
      const profileHint =
        p.channel.streamSlot === 1 ? 'high' : p.channel.streamSlot === 2 ? 'low' : undefined
      out.push({
        id: p.camStreamId,
        label: this.deriveStreamLabel(p.channel),
        protocol: 'rtsp' as const,
        url: p.rtspUrl,
        ...(profileHint ? { profileHint } : {}),
        ...(p.channel.width && p.channel.height
          ? { resolution: { width: p.channel.width, height: p.channel.height } }
          : {}),
      })
    }
    return out
  }

  // ── Alarm stream subscription ────────────────────────────────────

  private ensureAlarmSubscription(): void {
    if (this.alarmController) return
    const isapi = this.ensureClient()
    this.alarmController = subscribeAlarms(
      isapi,
      {
        onConnected: () => {
          this.alarmReconnectAttempts = 0
          this.markOnline(true)
          this.ctx.logger.info('alarm stream connected', { tags: { deviceId: this.id } })
        },
        onEvent: (ev) => this.handleAlarmEvent(ev),
        onError: (err) => {
          this.ctx.logger.warn('alarm stream error — will reconnect', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          this.alarmController = null
          this.scheduleAlarmReconnect()
        },
        // Every parser drop path logs through this logger, tagged with the
        // device — a camera that never produces motion is diagnosed per-camera
        // or not at all.
      },
      { logger: this.ctx.logger, deviceId: this.id },
    )
  }

  private scheduleAlarmReconnect(): void {
    if (this.alarmReconnectTimer) return
    const attempts = ++this.alarmReconnectAttempts
    // Exponential backoff capped at 60s — same shape as Reolink.
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
    this.alarmReconnectTimer = setTimeout(() => {
      this.alarmReconnectTimer = null
      this.ensureAlarmSubscription()
    }, delayMs)
  }

  private handleAlarmEvent(ev: HikvisionAlarmEvent): void {
    // Resolve the channel id reported by the camera back to one of OUR
    // camStream ids so downstream consumers (analytics, motion-overlay)
    // see consistent identifiers. Fall back to `native:main` when the
    // camera doesn't report a channel (single-camera devices often
    // omit the field entirely).
    const camStreamId = this.resolveAlarmCamStreamId(ev.channelId)

    const isMotion = ev.type === 'vmd' || ev.type === 'motiondetection'
    const isSmart = isHikvisionSmartAlarmType(ev.type)

    if (isMotion) {
      this.handleMotionEvent(ev, camStreamId)
      return
    }
    if (isSmart) {
      this.emitSmartDetection(ev, camStreamId)
      // Smart detection events also imply motion — surface both so a
      // pipeline gating on `motion-active` doesn't miss the burst.
      this.handleMotionEvent(ev, camStreamId)
      return
    }
    // `videoloss` reaching us at all now means the ACTIVE edge: the camera has
    // lost its video signal. The `inactive` keep-alive (83 200 events / 12 h,
    // all identical) is dropped by declared policy in the parser and counted
    // there — see `hikvision-alarm-ignore.ts`.
    //
    // Both used to land on the same `debug` line, which is why this one was
    // invisible: a real signal loss looked exactly like the 116/min heartbeat.
    // It is a fault, so it is a `warn`, and it says what happened rather than
    // "unhandled".
    if (ev.type === 'videoloss') {
      this.ctx.logger.warn('hikvision: camera reports video signal loss', {
        tags: { deviceId: this.id },
        meta: { type: ev.type, state: ev.state, camStreamId },
      })
      return
    }

    // An event type we do not model is information — the camera is telling us
    // something we cannot read — so it is never dropped silently. But it is
    // reported as a COUNT: the first occurrence of each `(type, state)` lands
    // immediately (a rare `io`/`active` must not wait behind a window), and
    // repeats fold into a periodic line. That is the guard against the next
    // firmware that invents a 2/s type nobody handles.
    this.unhandledAlarms.note(ev.type, ev.state)
  }

  private resolveAlarmCamStreamId(channelId: string | null): string {
    if (!channelId) return 'native:main'
    // Look up by reported channel id against our published map. Hikvision
    // alarm events emit the parent camera channel (`1`, `2`, ...) on
    // some firmwares and the full encoded id (`101`) on others — accept
    // both.
    for (const p of this.published.values()) {
      if (p.channel.id === channelId) return p.camStreamId
      if (String(p.channel.cameraNumber) === channelId) return p.camStreamId
    }
    return 'native:main'
  }

  /** EventSource tag used on every emit — declared once so `tags`
   *  on consumers stay consistent (alert-center correlates events back
   *  to the originating addon via this `addonId`). */
  private get eventSource(): { type: string; id: number; addonId: string; deviceId: number } {
    return { type: 'device', id: this.id, addonId: HIKVISION_ADDON_ID, deviceId: this.id }
  }

  /**
   * The native `motion` cap. Its presence is what defaults the camera to
   * `motionSources: ['onboard']`. This provider writes NO `motion` slice (D696):
   * the orchestrator is its only writer, with the EFFECTIVE motion, on the hub.
   * `isDetected` AND `getStatus` therefore answer from the hub's slice
   * (`hubMotionNativeProvider`; without its own `getStatus` the framework's
   * default reads this process's empty local state and answers `null`). An
   * unreadable hub fails both; never `false` for "unknown" (D49, D393).
   */
  private registerMotionCap(): void {
    const motionProvider = hubMotionNativeProvider(
      this.ctx.api.deviceState,
      this.id,
      'HikvisionCamera',
    )
    this.ctx.registerNativeCap(motionCapability, motionProvider)
  }

  private handleMotionEvent(ev: HikvisionAlarmEvent, camStreamId: string): void {
    const now = ev.observedAt
    this.lastMotionAt.set(camStreamId, now)
    this.motionIngress.received({
      type: ev.type,
      state: ev.state,
      aiClass: ev.aiClass,
      camStreamId,
      at: now,
    })

    // Emit the motion heartbeat on EVERY VMD tick, not just the rising edge.
    // The pipeline-runner phase machine is keepalive-driven: each
    // `detected:true` re-arms a `motionCooldownMs` (30s default) timer and only
    // a fresh event before expiry holds `phase=active`. Hikvision fires VMD
    // ~every 1s during sustained motion, so re-emitting per tick keeps the gate
    // open — mirroring Reolink's per-push emit. Without this, a single rising
    // edge armed the cooldown and the camera fell back to `watching` after 30s
    // despite ongoing motion (no detection ran). This is the camera's RAW
    // push (D673): the orchestrator's camera-sensors bridge decides what
    // reaches the bus as `MotionOnMotionChanged` (verbatim for a camera with
    // no attached sensor) and the runner's phase machine subscribes to that.
    // ~1Hz is bounded and identical in shape to reolink, not a flood.
    this.ctx.eventBus.emit(
      providerMotionEvent(this.eventSource, {
        deviceId: this.id,
        detected: true,
        timestamp: now,
        source: 'onboard',
      }),
    )

    // Reset the inactivity timer.
    const existing = this.motionInactiveTimers.get(camStreamId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      const clearedAt = Date.now()
      this.lastMotionAt.set(camStreamId, 0)
      this.motionInactiveTimers.delete(camStreamId)
      this.motionIngress.ended(camStreamId, clearedAt)
      this.ctx.eventBus.emit(
        providerMotionEvent(this.eventSource, {
          deviceId: this.id,
          detected: false,
          timestamp: clearedAt,
          source: 'onboard',
        }),
      )
    }, HikvisionCamera.MOTION_INACTIVE_AFTER_MS)
    this.motionInactiveTimers.set(camStreamId, timer)
  }

  private emitSmartDetection(ev: HikvisionAlarmEvent, _camStreamId: string): void {
    // `_camStreamId` is currently advisory — the canonical
    // `detection.camera-native` payload is camera-scoped, not
    // stream-scoped, mirroring how Reolink emits AI pushes. We pass
    // it in so future per-stream detection routing can drop in
    // without re-threading the call site.
    const className = ev.aiClass
      ? (HIKVISION_AI_CLASS_MAP[ev.aiClass.toLowerCase()] ?? ev.aiClass.toLowerCase())
      : null
    if (!className) return
    this.ctx.eventBus.emit(
      createEvent(EventCategory.DetectionCameraNative, this.eventSource, {
        cameraId: this.id,
        source: 'onboard',
        detections: [{ class: className, timestamp: ev.observedAt }],
      }),
    )
  }

  // ── Driver-authored settings UI ──────────────────────────────────

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    // Tab/section taxonomy is shared with the Reolink driver — see
    // `addon-provider-reolink/src/reolink-camera.ts`. Section order
    // and ids are kept identical so the operator sees the same layout
    // regardless of which vendor a given camera uses. Vendor-specific
    // fields live inside their respective sections; sections that
    // don't apply to a vendor (e.g. VCA on Reolink) are simply
    // omitted on that side.
    const osdValues = this.osdSnapshotForUi()
    // Probed once per render — the snapshot-source select's options and its
    // presence both derive from it (D14's getOptions-honesty convention
    // applied to a driver-owned section).
    const snapshotChannelOptions = buildSnapshotChannelOptions(this.probedSnapshotChannels())
    const schema: ConfigUISchema = {
      sections: [
        // ── Connection (lives under the General tab) ────────────────
        //
        // The driver-authored Connection card stays on the well-known
        // `general` tab (alongside the device-manager identity card and
        // any other addon contributions targeting `general`). We don't
        // promote it to its own top-level tab — connection settings are
        // edited rarely and pairing them with the always-visible General
        // tab keeps the camera-detail nav lean.
        {
          id: 'connection',
          tab: 'general',
          title: 'Connection',
          titleKey: 'provider-hikvision:schema.s_connection.title',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'Camera IP',
              labelKey: 'provider-hikvision:schema.s_connection.host.label',
              required: true,
              placeholder: '192.168.10.100',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              labelKey: 'provider-hikvision:schema.s_connection.port.label',
              default: 80,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'https',
              label: 'Use HTTPS',
              labelKey: 'provider-hikvision:schema.s_connection.https.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'select',
              key: 'rtspTransport',
              label: 'RTSP transport',
              labelKey: 'provider-hikvision:schema.s_connection.rtspTransport.label',
              default: 'unicast',
              options: [
                {
                  value: 'unicast',
                  label: 'Unicast (default)',
                  labelKey: 'provider-hikvision:schema.s_connection.rtspTransport.o_unicast.label',
                },
                {
                  value: 'multicast',
                  label: 'Multicast (rare)',
                  labelKey:
                    'provider-hikvision:schema.s_connection.rtspTransport.o_multicast.label',
                },
              ],
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'provider-hikvision:schema.s_connection.username.label',
              default: 'admin',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'provider-hikvision:schema.s_connection.password.label',
              required: true,
              showToggle: true,
            },
          ],
        },
        // ── Motion ──────────────────────────────────────────────────
        {
          id: 'motion',
          tab: 'motion',
          title: 'On-camera motion (VMD)',
          titleKey: 'provider-hikvision:schema.s_motion.title',
          columns: 2,
          fields: [
            {
              type: 'boolean',
              key: 'motionEnabled',
              label: 'Motion detection',
              labelKey: 'provider-hikvision:schema.s_motion.motionEnabled.label',
              default: true,
              style: 'switch',
              span: 2,
            },
            {
              type: 'slider',
              key: 'motionSensitivity',
              label: 'Sensitivity',
              labelKey: 'provider-hikvision:schema.s_motion.motionSensitivity.label',
              min: 0,
              max: 100,
              // Discrete step matches Hikvision firmware grid; the
              // slider thumb + number-input + stepper buttons all
              // snap to multiples of 20.
              step: 20,
              default: 60,
              showValue: true,
              showStepper: true,
              span: 2,
            },
          ],
        },
        // ── Image tuning (color / WDR / IR-cut) ─────────────────────
        ...(this.config.get('deviceCache')?.imageSnapshot
          ? [
              (() => {
                const snap = this.config.get('deviceCache')!.imageSnapshot!
                return {
                  id: 'image',
                  tab: 'image' as const,
                  title: 'Image',
                  titleKey: 'provider-hikvision:schema.s_image.title',
                  columns: 2 as const,
                  fields: [
                    {
                      type: 'slider' as const,
                      key: 'imageBrightness',
                      label: 'Brightness',
                      labelKey: 'provider-hikvision:schema.s_image.imageBrightness.label',
                      min: 0,
                      max: 100,
                      step: 5,
                      default: snap.brightness ?? 50,
                      showValue: true,
                      showStepper: true,
                    },
                    {
                      type: 'slider' as const,
                      key: 'imageContrast',
                      label: 'Contrast',
                      labelKey: 'provider-hikvision:schema.s_image.imageContrast.label',
                      min: 0,
                      max: 100,
                      step: 5,
                      default: snap.contrast ?? 50,
                      showValue: true,
                      showStepper: true,
                    },
                    {
                      type: 'slider' as const,
                      key: 'imageSaturation',
                      label: 'Saturation',
                      labelKey: 'provider-hikvision:schema.s_image.imageSaturation.label',
                      min: 0,
                      max: 100,
                      step: 5,
                      default: snap.saturation ?? 50,
                      showValue: true,
                      showStepper: true,
                    },
                    {
                      type: 'slider' as const,
                      key: 'imageSharpness',
                      label: 'Sharpness',
                      labelKey: 'provider-hikvision:schema.s_image.imageSharpness.label',
                      min: 0,
                      max: 100,
                      step: 5,
                      default: snap.sharpness ?? 50,
                      showValue: true,
                      showStepper: true,
                    },
                    {
                      type: 'boolean' as const,
                      key: 'imageWdrEnabled',
                      label: 'WDR',
                      labelKey: 'provider-hikvision:schema.s_image.imageWdrEnabled.label',
                      default: snap.wdrEnabled ?? false,
                      style: 'switch' as const,
                      span: 2 as const,
                    },
                    {
                      type: 'slider' as const,
                      key: 'imageWdrLevel',
                      label: 'WDR level',
                      labelKey: 'provider-hikvision:schema.s_image.imageWdrLevel.label',
                      min: 0,
                      max: 100,
                      step: 10,
                      default: snap.wdrLevel ?? 50,
                      showValue: true,
                      showStepper: true,
                      span: 2 as const,
                      showWhen: { field: 'imageWdrEnabled', equals: true },
                    },
                    {
                      type: 'select' as const,
                      key: 'imageIrcutMode',
                      label: 'Day/Night',
                      labelKey: 'provider-hikvision:schema.s_image.imageIrcutMode.label',
                      description: '`schedule` uses the schedule configured on the camera.',
                      descriptionKey:
                        'provider-hikvision:schema.s_image.imageIrcutMode.description',
                      default: snap.ircutMode ?? 'auto',
                      options: [
                        {
                          value: 'auto',
                          label: 'Auto (light-driven)',
                          labelKey: 'provider-hikvision:schema.s_image.imageIrcutMode.o_auto.label',
                        },
                        {
                          value: 'day',
                          label: 'Day (force colour)',
                          labelKey: 'provider-hikvision:schema.s_image.imageIrcutMode.o_day.label',
                        },
                        {
                          value: 'night',
                          label: 'Night (force B&W + IR)',
                          labelKey:
                            'provider-hikvision:schema.s_image.imageIrcutMode.o_night.label',
                        },
                        {
                          value: 'schedule',
                          label: 'Schedule (camera-side)',
                          labelKey:
                            'provider-hikvision:schema.s_image.imageIrcutMode.o_schedule.label',
                        },
                      ],
                      span: 2 as const,
                    },
                  ],
                }
              })(),
            ]
          : []),
        // ── Time / NTP ──────────────────────────────────────────────
        //
        // Network time-sync config. `setTimeConfig()` pushes the
        // touched fields to `/ISAPI/System/time` (mode, timezone
        // preserved) and `/ISAPI/System/time/ntpServers/1` (server /
        // port / interval). Hydrated from the on-connect `ntpSnapshot`
        // probe; rendered even before the first probe (defaults apply).
        (() => {
          const snap = this.config.get('deviceCache')?.ntpSnapshot ?? {}
          return {
            id: 'time-ntp',
            tab: 'network' as const,
            title: 'Time / NTP',
            titleKey: 'provider-hikvision:schema.s_time-ntp.title',
            columns: 2 as const,
            fields: [
              {
                type: 'timezone' as const,
                key: 'timeZoneId',
                label: 'Timezone',
                labelKey: 'provider-hikvision:schema.s_time-ntp.timeZoneId.label',
                span: 2 as const,
              },
              {
                type: 'select' as const,
                key: 'timeMode',
                label: 'Time sync',
                labelKey: 'provider-hikvision:schema.s_time-ntp.timeMode.label',
                default: snap.timeMode === 'manual' ? 'manual' : 'NTP',
                options: [
                  {
                    value: 'NTP',
                    label: 'NTP (network sync)',
                    labelKey: 'provider-hikvision:schema.s_time-ntp.timeMode.o_NTP.label',
                  },
                  {
                    value: 'manual',
                    label: 'Manual (operator-set)',
                    labelKey: 'provider-hikvision:schema.s_time-ntp.timeMode.o_manual.label',
                  },
                ],
                span: 2 as const,
              },
              {
                type: 'text' as const,
                key: 'ntpServer',
                label: 'NTP server',
                labelKey: 'provider-hikvision:schema.s_time-ntp.ntpServer.label',
                default: snap.ntpServer ?? 'pool.ntp.org',
                placeholder: 'pool.ntp.org',
                span: 2 as const,
                showWhen: { field: 'timeMode', equals: 'NTP' },
              },
              {
                type: 'number' as const,
                key: 'ntpPort',
                label: 'NTP port',
                labelKey: 'provider-hikvision:schema.s_time-ntp.ntpPort.label',
                default: snap.ntpPort ?? 123,
                min: 1,
                max: 65535,
                step: 1,
                showWhen: { field: 'timeMode', equals: 'NTP' },
              },
              {
                type: 'number' as const,
                key: 'ntpSyncInterval',
                label: 'Sync interval (min)',
                labelKey: 'provider-hikvision:schema.s_time-ntp.ntpSyncInterval.label',
                default: snap.syncInterval ?? 1440,
                min: 1,
                max: 10080,
                step: 1,
                showWhen: { field: 'timeMode', equals: 'NTP' },
              },
              // Manual-clock controls — only shown when the camera is in
              // operator-managed mode. An editable date-time field (applies
              // on save) plus a one-click "sync to current server time".
              {
                type: 'datetime' as const,
                key: 'manualTime',
                label: 'Manual date & time',
                labelKey: 'provider-hikvision:schema.s_time-ntp.manualTime.label',
                // Pre-fill with the camera's CURRENT displayed wall-clock
                // (from the `<localTime>` probe) so the picker reflects the
                // live clock instead of an empty field. The live reading wins
                // over any persisted `manualTime`: that saved value is a
                // one-shot wall-clock captured at submit time and goes stale
                // immediately as the clock ticks, so it's never the right
                // default. Falls back to the saved value (then empty) only
                // when the firmware omits `<localTime>` (some NTP modes).
                default:
                  hikvisionLocalTimeToDatetimeLocal(snap.localTime) ??
                  this.config.get('manualTime') ??
                  '',
                span: 2 as const,
                showWhen: { field: 'timeMode', equals: 'manual' },
              },
              {
                type: 'device-action-button' as const,
                key: '_syncTimeNow',
                label: 'Sync time',
                labelKey: 'provider-hikvision:schema.s_time-ntp._syncTimeNow.label',
                buttonLabel: 'Set to current time',
                action: 'syncTimeFromLocal',
                variant: 'default' as const,
                showWhen: { field: 'timeMode', equals: 'manual' },
              },
            ],
          }
        })(),
        // ── Light (supplemental IR / white) ─────────────────────────
        ...(this.config.get('deviceCache')?.hasSupplementalLight === true
          ? [
              (() => {
                const cache = this.config.get('deviceCache')!
                const modes = cache.lightSupportedModes ?? []
                const snap = cache.lightSnapshot ?? {}
                const hasWhite = cache.lightHasWhiteLight === true
                const supportsRegulator = (snap.brightnessRegulatorMode ?? null) !== null
                return {
                  id: 'light',
                  tab: 'light' as const,
                  title: hasWhite ? 'Supplemental light' : 'IR illuminator',
                  description: hasWhite
                    ? 'The Switch / Light child device toggles the light on and off.'
                    : 'Auto lets the camera drive brightness from its light sensor; manual pins it to the slider.',
                  columns: 2 as const,
                  fields: [
                    {
                      type: 'select' as const,
                      key: 'lightMode',
                      label: 'Mode',
                      labelKey: 'provider-hikvision:schema.s_light.lightMode.label',
                      default: snap.mode ?? cache.lightDefaultMode ?? 'irLight',
                      options: modes.map((m) => ({
                        value: m,
                        label: friendlyHikvisionLightMode(m),
                      })),
                    },
                    ...(supportsRegulator
                      ? [
                          {
                            type: 'select' as const,
                            key: 'lightBrightnessRegulator',
                            label: 'Brightness regulator',
                            labelKey:
                              'provider-hikvision:schema.s_light.lightBrightnessRegulator.label',
                            default: snap.brightnessRegulatorMode ?? 'auto',
                            options: [
                              {
                                value: 'auto',
                                label: 'Auto (sensor-driven)',
                                labelKey:
                                  'provider-hikvision:schema.s_light.lightBrightnessRegulator.o_auto.label',
                              },
                              {
                                value: 'manual',
                                label: 'Manual (operator-set)',
                                labelKey:
                                  'provider-hikvision:schema.s_light.lightBrightnessRegulator.o_manual.label',
                              },
                            ],
                          },
                        ]
                      : []),
                    ...(modes.includes('irLight')
                      ? [
                          {
                            type: 'slider' as const,
                            key: 'lightIrBrightness',
                            label: 'IR brightness',
                            labelKey: 'provider-hikvision:schema.s_light.lightIrBrightness.label',
                            description:
                              'Only honoured when mode is `irLight` and the regulator is `manual`.',
                            descriptionKey:
                              'provider-hikvision:schema.s_light.lightIrBrightness.description',
                            min: 0,
                            max: 100,
                            step: 5,
                            default: snap.irLightBrightness ?? 100,
                            showValue: true,
                            showStepper: true,
                            span: 2 as const,
                          },
                        ]
                      : []),
                    ...(hasWhite
                      ? [
                          {
                            type: 'slider' as const,
                            key: 'lightWhiteBrightness',
                            label: 'White-light brightness',
                            labelKey:
                              'provider-hikvision:schema.s_light.lightWhiteBrightness.label',
                            description: 'Only honoured in a white-light mode.',
                            descriptionKey:
                              'provider-hikvision:schema.s_light.lightWhiteBrightness.description',
                            min: 0,
                            max: 100,
                            step: 5,
                            default: snap.whiteLightBrightness ?? 100,
                            showValue: true,
                            showStepper: true,
                            span: 2 as const,
                          },
                        ]
                      : []),
                  ],
                }
              })(),
            ]
          : []),
        // ── Two-way audio mode (always visible) ─────────────────────
        // `auto` | `isapi` | `onvif` | `off`. Drives `intercomEnabled()`
        // → cap registration + `DeviceFeature.TwoWayAudio` advertisement.
        // Always rendered (independent of `audioCapabilities`) so the
        // operator can disable intercom on cameras whose probe failed
        // or force the ISAPI path on cameras whose channel list 404s.
        {
          id: 'two-way-audio-mode',
          tab: 'audio' as const,
          title: 'Two-way audio',
          titleKey: 'provider-hikvision:schema.s_two-way-audio-mode.title',
          description:
            '`auto` probes for a channel; use `isapi` if the probe fails but the camera accepts audio, `off` to disable.',
          descriptionKey: 'provider-hikvision:schema.s_two-way-audio-mode.description',
          columns: 1 as const,
          fields: [
            {
              type: 'select' as const,
              key: 'twoWayAudioMode',
              label: 'Mode',
              labelKey: 'provider-hikvision:schema.s_two-way-audio-mode.twoWayAudioMode.label',
              default: 'auto',
              options: [
                {
                  value: 'auto',
                  label: `Auto${this.config.get('deviceCache')?.hasIntercom === true ? ' (probe: enabled)' : ' (probe: disabled)'}`,
                },
                {
                  value: 'isapi',
                  label: 'Hikvision (ISAPI, force-on)',
                  labelKey:
                    'provider-hikvision:schema.s_two-way-audio-mode.twoWayAudioMode.o_isapi.label',
                },
                {
                  value: 'onvif',
                  label: 'ONVIF (Profile-T, not yet implemented)',
                  labelKey:
                    'provider-hikvision:schema.s_two-way-audio-mode.twoWayAudioMode.o_onvif.label',
                },
                {
                  value: 'off',
                  label: 'Off',
                  labelKey:
                    'provider-hikvision:schema.s_two-way-audio-mode.twoWayAudioMode.o_off.label',
                },
              ],
            },
          ],
        },
        // ── Audio ───────────────────────────────────────────────────
        ...(this.config.get('deviceCache')?.audioCapabilities
          ? [
              {
                id: 'audio',
                tab: 'audio' as const,
                title: 'Two-way audio channel',
                titleKey: 'provider-hikvision:schema.s_audio.title',
                columns: 2 as const,
                fields: [
                  {
                    type: 'select' as const,
                    key: 'audioCompressionType',
                    label: 'Audio codec',
                    labelKey: 'provider-hikvision:schema.s_audio.audioCompressionType.label',
                    description: 'G.711 µ-law has the broadest compatibility.',
                    descriptionKey:
                      'provider-hikvision:schema.s_audio.audioCompressionType.description',
                    default: '',
                    options: [
                      {
                        value: '',
                        label: 'Firmware default',
                        labelKey: 'provider-hikvision:schema.s_audio.audioCompressionType.o_.label',
                      },
                      ...(this.config.get('deviceCache')?.audioCapabilities?.audioCodecs ?? []).map(
                        (v) => ({ value: v, label: v }),
                      ),
                    ],
                  },
                  {
                    type: 'select' as const,
                    key: 'audioInputType',
                    label: 'Input source',
                    labelKey: 'provider-hikvision:schema.s_audio.audioInputType.label',
                    default: '',
                    options: [
                      {
                        value: '',
                        label: 'Firmware default',
                        labelKey: 'provider-hikvision:schema.s_audio.audioInputType.o_.label',
                      },
                      ...(
                        this.config.get('deviceCache')?.audioCapabilities?.audioInputTypes ?? []
                      ).map((v) => ({ value: v, label: v })),
                    ],
                  },
                  {
                    type: 'slider' as const,
                    key: 'audioSpeakerVolume',
                    label: 'Speaker volume',
                    labelKey: 'provider-hikvision:schema.s_audio.audioSpeakerVolume.label',
                    min: this.config.get('deviceCache')?.audioCapabilities?.speakerVolumeMin ?? 0,
                    max: this.config.get('deviceCache')?.audioCapabilities?.speakerVolumeMax ?? 100,
                    step: 5,
                    default: 80,
                    showValue: true,
                    showStepper: true,
                    span: 2 as const,
                  },
                  ...(this.config.get('deviceCache')?.audioCapabilities?.supportsNoiseReduction
                    ? [
                        {
                          type: 'boolean' as const,
                          key: 'audioNoiseReduction',
                          label: 'Noise reduction',
                          labelKey: 'provider-hikvision:schema.s_audio.audioNoiseReduction.label',
                          default: true,
                          style: 'switch' as const,
                          span: 2 as const,
                        },
                      ]
                    : []),
                ],
              },
            ]
          : []),
        // Stream / encoder parameters are no longer a hand-rolled
        // section here — the `stream-params` cap declares a `ui` block,
        // so its config UI is surfaced automatically by the cap-UI
        // contribution mechanism. The cap registration stays as the
        // programmatic contract.
        // ── Snapshot source channel ─────────────────────────────────
        //
        // Rendered ONLY once the connect-time probe has enumerated
        // `/ISAPI/Streaming/channels`: the option list is the probed
        // channels and nothing else. A camera we have not looked at yet
        // gets no control rather than a hardcoded main/sub pair that may
        // not exist — a select that offers a channel the camera refuses
        // is the dead control this convention exists to prevent.
        ...(snapshotChannelOptions.length > 0
          ? [
              {
                id: 'snapshot-source',
                tab: 'streaming' as const,
                title: 'Snapshot source',
                titleKey: 'provider-hikvision:schema.s_snapshot-source.title',
                description:
                  'Pick the sub stream when the main stream is 4K and snapshots only feed thumbnails.',
                descriptionKey: 'provider-hikvision:schema.s_snapshot-source.description',
                columns: 1 as const,
                fields: [
                  {
                    type: 'select' as const,
                    key: 'snapshotChannelId',
                    label: 'Snapshot channel',
                    labelKey: 'provider-hikvision:schema.s_snapshot-source.snapshotChannelId.label',
                    default: defaultSnapshotChannelId(DEFAULT_CAMERA_NUMBER),
                    options: [...snapshotChannelOptions],
                  },
                ],
              },
            ]
          : []),
        // ── Alarms (motion-event linkage outputs) ──────────────────
        {
          id: 'alarms',
          tab: 'alarms',
          title: 'Motion linkage',
          titleKey: 'provider-hikvision:schema.s_alarms.title',
          description: 'Methods not listed here (record, email, ftp) are preserved.',
          descriptionKey: 'provider-hikvision:schema.s_alarms.description',
          columns: 2,
          fields: [
            {
              type: 'boolean',
              key: 'alarmBeep',
              label: 'Audio beep',
              labelKey: 'provider-hikvision:schema.s_alarms.alarmBeep.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'boolean',
              key: 'alarmWhiteLight',
              label: 'White-light flash',
              labelKey: 'provider-hikvision:schema.s_alarms.alarmWhiteLight.label',
              description: 'Only effective on cameras with a controllable white-light LED.',
              descriptionKey: 'provider-hikvision:schema.s_alarms.alarmWhiteLight.description',
              default: false,
              style: 'switch',
            },
            {
              type: 'boolean',
              key: 'alarmIoOutput',
              label: 'IO relay',
              labelKey: 'provider-hikvision:schema.s_alarms.alarmIoOutput.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'boolean',
              key: 'alarmCenter',
              label: 'Notification center',
              labelKey: 'provider-hikvision:schema.s_alarms.alarmCenter.label',
              default: false,
              style: 'switch',
            },
          ],
        },
        // ── OSD (editable overlay state) ───────────────────────────
        {
          id: 'osd',
          tab: 'osd',
          title: 'OSD overlays',
          titleKey: 'provider-hikvision:schema.s_osd.title',
          columns: 2,
          fields: [
            {
              type: 'boolean',
              key: '_osdDateTimeEnabled',
              label: 'Date/time visible',
              labelKey: 'provider-hikvision:schema.s_osd._osdDateTimeEnabled.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'boolean',
              key: '_osdChannelNameEnabled',
              label: 'Channel name visible',
              labelKey: 'provider-hikvision:schema.s_osd._osdChannelNameEnabled.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'text',
              key: '_osdTextOverlay1',
              label: 'Text overlay #1',
              labelKey: 'provider-hikvision:schema.s_osd._osdTextOverlay1.label',
              span: 2,
            },
            {
              type: 'text',
              key: '_osdTextOverlay2',
              label: 'Text overlay #2',
              labelKey: 'provider-hikvision:schema.s_osd._osdTextOverlay2.label',
              span: 2,
            },
            {
              type: 'text',
              key: '_osdTextOverlay3',
              label: 'Text overlay #3',
              labelKey: 'provider-hikvision:schema.s_osd._osdTextOverlay3.label',
              span: 2,
            },
            {
              type: 'text',
              key: '_osdTextOverlay4',
              label: 'Text overlay #4',
              labelKey: 'provider-hikvision:schema.s_osd._osdTextOverlay4.label',
              span: 2,
            },
          ],
        },
        // ── Advanced (VCA + debug) ──────────────────────────────────
        {
          id: 'advanced',
          tab: 'advanced',
          title: 'Advanced',
          titleKey: 'provider-hikvision:schema.s_advanced.title',
          description: 'Debug flags add log volume; VCA changes require a camera reboot.',
          descriptionKey: 'provider-hikvision:schema.s_advanced.description',
          columns: 1,
          fields: [
            {
              type: 'select',
              key: 'vcaResource',
              label: 'VCA resource',
              labelKey: 'provider-hikvision:schema.s_advanced.vcaResource.label',
              description:
                '`Smart` and `Face snap` disable the third stream; `Close` turns off on-camera AI. Switching reboots the camera.',
              descriptionKey: 'provider-hikvision:schema.s_advanced.vcaResource.description',
              default: 'smart',
              options: [
                {
                  value: 'smart',
                  label: 'Smart detection (default)',
                  labelKey: 'provider-hikvision:schema.s_advanced.vcaResource.o_smart.label',
                },
                {
                  value: 'facesnap',
                  label: 'Face snap',
                  labelKey: 'provider-hikvision:schema.s_advanced.vcaResource.o_facesnap.label',
                },
                {
                  value: 'close',
                  label: 'Closed (third stream available)',
                  labelKey: 'provider-hikvision:schema.s_advanced.vcaResource.o_close.label',
                },
              ],
            },
            {
              type: 'boolean',
              key: 'debugGeneral',
              label: 'General ISAPI logs',
              labelKey: 'provider-hikvision:schema.s_advanced.debugGeneral.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'multiselect',
              key: 'debugFlags',
              label: 'Trace categories',
              labelKey: 'provider-hikvision:schema.s_advanced.debugFlags.label',
              default: [],
              options: [
                {
                  value: 'debugIsapi',
                  label: 'ISAPI request/response bodies',
                  labelKey: 'provider-hikvision:schema.s_advanced.debugFlags.o_debugIsapi.label',
                },
                {
                  value: 'traceAlarmStream',
                  label: 'Alarm stream parser (per-block)',
                  labelKey:
                    'provider-hikvision:schema.s_advanced.debugFlags.o_traceAlarmStream.label',
                },
                {
                  value: 'traceSnapshot',
                  label: 'Snapshot timing + bytes',
                  labelKey: 'provider-hikvision:schema.s_advanced.debugFlags.o_traceSnapshot.label',
                },
              ],
            },
          ],
        },
      ],
    }
    const values: Record<string, unknown> = {
      host: this.config.get('host'),
      port: this.config.get('port'),
      https: this.config.get('https') ?? false,
      username: this.config.get('username'),
      password: this.config.get('password'),
      rtspTransport: this.config.get('rtspTransport') ?? 'unicast',
      // The stored value is `''` until the operator picks one; the form must
      // show the channel actually IN USE, which is what the resolver answers.
      snapshotChannelId: this.resolveSnapshotChannel(),
      motionEnabled: this.config.get('motionEnabled') ?? true,
      motionSensitivity: this.config.get('motionSensitivity') ?? 60,
      vcaResource: this.config.get('vcaResource') ?? 'smart',
      audioCompressionType: this.config.get('audioCompressionType') ?? '',
      audioSpeakerVolume: this.config.get('audioSpeakerVolume') ?? 80,
      audioNoiseReduction: this.config.get('audioNoiseReduction') ?? true,
      audioInputType: this.config.get('audioInputType') ?? '',
      alarmBeep: this.config.get('alarmBeep') ?? false,
      alarmWhiteLight: this.config.get('alarmWhiteLight') ?? false,
      alarmIoOutput: this.config.get('alarmIoOutput') ?? false,
      alarmCenter: this.config.get('alarmCenter') ?? false,
      imageBrightness:
        this.config.get('imageBrightness') ??
        this.config.get('deviceCache')?.imageSnapshot?.brightness ??
        50,
      imageContrast:
        this.config.get('imageContrast') ??
        this.config.get('deviceCache')?.imageSnapshot?.contrast ??
        50,
      imageSaturation:
        this.config.get('imageSaturation') ??
        this.config.get('deviceCache')?.imageSnapshot?.saturation ??
        50,
      imageSharpness:
        this.config.get('imageSharpness') ??
        this.config.get('deviceCache')?.imageSnapshot?.sharpness ??
        50,
      imageWdrEnabled:
        this.config.get('imageWdrEnabled') ??
        this.config.get('deviceCache')?.imageSnapshot?.wdrEnabled ??
        false,
      imageWdrLevel:
        this.config.get('imageWdrLevel') ??
        this.config.get('deviceCache')?.imageSnapshot?.wdrLevel ??
        50,
      imageIrcutMode:
        this.config.get('imageIrcutMode') ??
        this.config.get('deviceCache')?.imageSnapshot?.ircutMode ??
        'auto',
      timeMode:
        this.config.get('timeMode') ??
        (this.config.get('deviceCache')?.ntpSnapshot?.timeMode === 'manual' ? 'manual' : 'NTP'),
      ntpServer:
        this.config.get('ntpServer') ??
        this.config.get('deviceCache')?.ntpSnapshot?.ntpServer ??
        'pool.ntp.org',
      ntpPort:
        this.config.get('ntpPort') ?? this.config.get('deviceCache')?.ntpSnapshot?.ntpPort ?? 123,
      ntpSyncInterval:
        this.config.get('ntpSyncInterval') ??
        this.config.get('deviceCache')?.ntpSnapshot?.syncInterval ??
        1440,
      // Selected timezone: the operator's explicit pick (persisted config)
      // wins; otherwise SEED the picker from the camera's CURRENT timezone
      // (read into `ntpSnapshot.timeZone` on connect) by reverse-matching its
      // POSIX offset against the catalogue. Without this seed a never-edited
      // camera shows a blank selector even though the camera HAS a timezone.
      timeZoneId:
        this.config.get('timeZoneId') ??
        hikvisionTimeZoneToIana(this.config.get('deviceCache')?.ntpSnapshot?.timeZone) ??
        '',
      lightMode:
        this.config.get('lightMode') ??
        this.config.get('deviceCache')?.lightSnapshot?.mode ??
        this.config.get('deviceCache')?.lightDefaultMode ??
        'irLight',
      lightIrBrightness:
        this.config.get('lightIrBrightness') ??
        this.config.get('deviceCache')?.lightSnapshot?.irLightBrightness ??
        100,
      lightWhiteBrightness:
        this.config.get('lightWhiteBrightness') ??
        this.config.get('deviceCache')?.lightSnapshot?.whiteLightBrightness ??
        100,
      lightBrightnessRegulator:
        this.config.get('lightBrightnessRegulator') ??
        this.config.get('deviceCache')?.lightSnapshot?.brightnessRegulatorMode ??
        'auto',
      debugGeneral: this.config.get('debugGeneral') ?? false,
      debugFlags: this.config.get('debugFlags') ?? [],
      ...osdValues,
    }
    return hydrateSchema(schema, values)
  }

  /** Project the in-memory OSD snapshot into the readonly fields the
   *  `osd` section displays. Returns sentinel values (`false` /
   *  empty string) until the first refresh succeeds — drives the
   *  "—" placeholder in the readonly form widget. */
  private osdSnapshotForUi(): Record<string, unknown> {
    const snap = this.osdSnapshot
    const out: Record<string, unknown> = {
      _osdDateTimeEnabled: snap?.dateTime.enabled ?? false,
      _osdChannelNameEnabled: snap?.channelName.enabled ?? false,
    }
    const slots = ['1', '2', '3', '4']
    for (let i = 0; i < slots.length; i++) {
      const slotId = slots[i]!
      const item = snap?.textOverlays.find((t) => t.id === slotId)
      const text = item?.enabled ? (item.text ?? '') : ''
      out[`_osdTextOverlay${i + 1}`] = text
    }
    return out
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    // Strip readonly OSD shadow fields before persisting (they're
    // populated from `this.osdSnapshot`, not from the operator).
    // The `stream{Main,Sub,Ext}_*` encoder keys aren't in the config
    // schema either — `setAll` strips them; the encoder truth lives on
    // the camera + the `stream-params` runtime-state slice. They're
    // dispatched separately below via `applyStreamProfilePatch`.
    const cleaned = stripOsdShadowFields(patch)
    // Captured BEFORE the write so the snapshot-channel branch below can tell
    // "the operator moved it" from "the form echoed back what was already
    // there" — the cache flush must not fire on every unrelated Save.
    const previousSnapshotChannel = this.resolveSnapshotChannel()
    await this.config.setAll(cleaned)
    const typed = cleaned as Partial<HikvisionCameraConfig>

    // ── Connection-shape change → reconnect ─────────────────────
    if (
      typed.host !== undefined ||
      typed.port !== undefined ||
      typed.https !== undefined ||
      typed.username !== undefined ||
      typed.password !== undefined
    ) {
      await this.disconnectAll()
      // Re-prime the catalog against the fresh client + re-open the alarm
      // subscription `disconnectAll` just tore down. The broker re-pulls
      // the catalog on its own cadence; we only need the local map +
      // control-plane back up.
      await this.buildStreamCatalog().catch((err) => {
        this.ctx.logger.warn('stream catalog build after settings patch failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      this.ensureAlarmSubscription()
    }

    // ── Snapshot source channel change → flush the wrapper cache ────
    //
    // The channel is a LOCAL setting (nothing is written to the camera), but
    // the snapshot wrapper owns a per-device image cache. Without this flush
    // the operator picks a new channel and keeps seeing the old channel's
    // frame until the cache TTL lapses, which reads as "the setting did
    // nothing".
    if (typed.snapshotChannelId !== undefined) {
      const nextSnapshotChannel = this.resolveSnapshotChannel()
      if (nextSnapshotChannel !== previousSnapshotChannel) {
        this.ctx.logger.info('hikvision snapshot channel changed', {
          tags: { deviceId: this.id },
          meta: { from: previousSnapshotChannel, to: nextSnapshotChannel },
        })
        try {
          const proxy = await this.ctx.fetchDevice(this.id)
          // `snapshot` is optional on the proxy — the wrapper addon may not be
          // installed. No wrapper means no cache to flush, so the absence is
          // not a failure; it is still logged so a stale image never looks
          // like the setting was ignored.
          if (proxy.snapshot === undefined) {
            this.ctx.logger.info('no snapshot wrapper bound — nothing to flush', {
              tags: { deviceId: this.id },
              meta: { to: nextSnapshotChannel },
            })
          } else {
            await proxy.snapshot.invalidateCache({})
          }
        } catch (err) {
          this.ctx.logger.warn('snapshot cache flush after channel change failed', {
            tags: { deviceId: this.id },
            meta: {
              from: previousSnapshotChannel,
              to: nextSnapshotChannel,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
    }

    // ── Motion detection push ───────────────────────────────────
    if (typed.motionEnabled !== undefined || typed.motionSensitivity !== undefined) {
      try {
        const isapi = this.ensureClient()
        await isapi.setMotionDetection(DEFAULT_CAMERA_NUMBER, {
          enabled: typed.motionEnabled,
          sensitivityLevel: typed.motionSensitivity,
        })
      } catch (err) {
        this.ctx.logger.warn('motion detection settings push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── Audio settings push (TwoWayAudio channel 1) ─────────────
    if (
      typed.audioCompressionType !== undefined ||
      typed.audioSpeakerVolume !== undefined ||
      typed.audioNoiseReduction !== undefined ||
      typed.audioInputType !== undefined
    ) {
      try {
        const isapi = this.ensureClient()
        // Drop empty-string sentinel from select fields — they mean
        // "use firmware default" → don't push the tag at all so the
        // camera keeps its current value.
        const audioPatch: {
          audioCompressionType?: string
          speakerVolume?: number
          noiseReduction?: boolean
          audioInputType?: string
        } = {}
        if (
          typeof typed.audioCompressionType === 'string' &&
          typed.audioCompressionType.length > 0
        ) {
          audioPatch.audioCompressionType = typed.audioCompressionType
        }
        if (typeof typed.audioSpeakerVolume === 'number') {
          audioPatch.speakerVolume = typed.audioSpeakerVolume
        }
        if (typeof typed.audioNoiseReduction === 'boolean') {
          audioPatch.noiseReduction = typed.audioNoiseReduction
        }
        if (typeof typed.audioInputType === 'string' && typed.audioInputType.length > 0) {
          audioPatch.audioInputType = typed.audioInputType
        }
        if (Object.keys(audioPatch).length > 0) {
          await isapi.setAudioSettings('1', audioPatch)
        }
      } catch (err) {
        this.ctx.logger.warn('audio settings push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── Image tuning push (color + sharpness + WDR + IR-cut) ───
    if (
      typed.imageBrightness !== undefined ||
      typed.imageContrast !== undefined ||
      typed.imageSaturation !== undefined
    ) {
      try {
        const isapi = this.ensureClient()
        await isapi.setImageColor(DEFAULT_CAMERA_NUMBER, {
          brightness: typed.imageBrightness,
          contrast: typed.imageContrast,
          saturation: typed.imageSaturation,
        })
      } catch (err) {
        this.ctx.logger.warn('image color push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    if (typed.imageSharpness !== undefined) {
      try {
        const isapi = this.ensureClient()
        await isapi.setImageSharpness(DEFAULT_CAMERA_NUMBER, typed.imageSharpness)
      } catch (err) {
        this.ctx.logger.warn('image sharpness push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    if (typed.imageWdrEnabled !== undefined || typed.imageWdrLevel !== undefined) {
      try {
        const isapi = this.ensureClient()
        await isapi.setImageWdr(DEFAULT_CAMERA_NUMBER, {
          enabled: typed.imageWdrEnabled,
          level: typed.imageWdrLevel,
        })
      } catch (err) {
        this.ctx.logger.warn('image WDR push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    // ── Supplemental light push ────────────────────────────────
    if (
      typed.lightMode !== undefined ||
      typed.lightIrBrightness !== undefined ||
      typed.lightWhiteBrightness !== undefined ||
      typed.lightBrightnessRegulator !== undefined
    ) {
      try {
        const isapi = this.ensureClient()
        await isapi.setSupplementLight(DEFAULT_CAMERA_NUMBER, {
          mode: typed.lightMode,
          irLightBrightness: typed.lightIrBrightness,
          whiteLightBrightness: typed.lightWhiteBrightness,
          brightnessRegulatorMode: typed.lightBrightnessRegulator,
        })
      } catch (err) {
        this.ctx.logger.warn('supplemental light push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    if (typed.imageIrcutMode !== undefined) {
      try {
        const isapi = this.ensureClient()
        await isapi.setIrcutFilter(DEFAULT_CAMERA_NUMBER, { mode: typed.imageIrcutMode })
      } catch (err) {
        this.ctx.logger.warn('image IR-cut push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── Time / NTP push ────────────────────────────────────────
    if (
      typed.timeMode !== undefined ||
      typed.ntpServer !== undefined ||
      typed.ntpPort !== undefined ||
      typed.ntpSyncInterval !== undefined
    ) {
      try {
        const isapi = this.ensureClient()
        // `setTimeConfig` only round-trips the endpoint a given field
        // belongs to — drop empty / unset keys so a mode-only change
        // never rewrites the NTP server list.
        const timePatch: {
          timeMode?: 'NTP' | 'manual'
          ntpServer?: string
          ntpPort?: number
          syncInterval?: number
        } = {}
        if (typed.timeMode !== undefined) timePatch.timeMode = typed.timeMode
        if (typeof typed.ntpServer === 'string' && typed.ntpServer.length > 0) {
          timePatch.ntpServer = typed.ntpServer
        }
        if (typeof typed.ntpPort === 'number') timePatch.ntpPort = typed.ntpPort
        if (typeof typed.ntpSyncInterval === 'number')
          timePatch.syncInterval = typed.ntpSyncInterval
        if (Object.keys(timePatch).length > 0) {
          await isapi.setTimeConfig(timePatch)
        }
      } catch (err) {
        this.ctx.logger.warn('time/ntp settings push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── Timezone push ──────────────────────────────────────────
    // The friendly `timeZoneId` picker resolves to a `Timezone` entry;
    // we convert it to Hikvision's POSIX-style `<timeZone>` string and
    // PUT it to `/ISAPI/System/time`. DST is implicit in the chosen
    // zone — no separate toggle. The id itself persists via the
    // top-level `config.setAll(cleaned)` above.
    if (typeof typed.timeZoneId === 'string' && typed.timeZoneId.length > 0) {
      const tz = findTimezone(typed.timeZoneId)
      if (tz) {
        try {
          const isapi = this.ensureClient()
          await isapi.setTimeConfig({ timeZone: ianaToHikvisionTimeZone(tz) })
        } catch (err) {
          this.ctx.logger.warn('timezone settings push failed', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    // ── Manual clock push ──────────────────────────────────────
    // The `datetime-local` field yields a naked local wall-clock string
    // `YYYY-MM-DDTHH:MM` (no seconds, no zone). Hikvision's `<localTime>`
    // requires a zoned ISO-8601 timestamp. We attach the CAMERA's current
    // offset (from the last `<localTime>` probe) so the camera displays the
    // typed wall-clock verbatim — Hikvision re-projects the instant onto its
    // own offset and observed firmware ignores the DST rule, so the host
    // offset would land an hour off. Falls back to the host offset when the
    // snapshot has no `<localTime>`. `setLocalTime` also flips the camera to
    // `manual` mode and preserves its configured `<timeZone>`.
    if (typeof typed.manualTime === 'string' && typed.manualTime.length > 0) {
      try {
        const isapi = this.ensureClient()
        const cameraOffset = offsetFromZonedIso(
          this.config.get('deviceCache')?.ntpSnapshot?.localTime ?? null,
        )
        await isapi.setLocalTime(datetimeLocalToZonedIso(typed.manualTime, cameraOffset))
      } catch (err) {
        this.ctx.logger.warn('manual time push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── Motion linkage (VMD-{cam}) push ────────────────────────
    if (
      typed.alarmBeep !== undefined ||
      typed.alarmWhiteLight !== undefined ||
      typed.alarmIoOutput !== undefined ||
      typed.alarmCenter !== undefined
    ) {
      try {
        const isapi = this.ensureClient()
        const linkagePatch: Parameters<typeof isapi.setMotionTriggerLinkage>[1] = {}
        if (typeof typed.alarmBeep === 'boolean') linkagePatch.beep = typed.alarmBeep
        if (typeof typed.alarmWhiteLight === 'boolean')
          linkagePatch.whiteLight = typed.alarmWhiteLight
        if (typeof typed.alarmIoOutput === 'boolean') linkagePatch.ioOutput = typed.alarmIoOutput
        if (typeof typed.alarmCenter === 'boolean') linkagePatch.center = typed.alarmCenter
        if (Object.keys(linkagePatch).length > 0) {
          await isapi.setMotionTriggerLinkage(DEFAULT_CAMERA_NUMBER, linkagePatch)
        }
      } catch (err) {
        this.ctx.logger.warn('motion linkage push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── VCA resource → triggers reboot when changed ─────────────
    if (typed.vcaResource !== undefined) {
      try {
        const isapi = this.ensureClient()
        const changed = await isapi.setVcaResource(DEFAULT_CAMERA_NUMBER, typed.vcaResource)
        if (changed) {
          this.ctx.logger.info('VCA resource mode changed — rebooting camera to apply', {
            tags: { deviceId: this.id },
            meta: { vcaResource: typed.vcaResource },
          })
          // Hikvision firmware needs a reboot for the new VCA
          // allocation to take effect. The lib's reboot endpoint
          // ACKs immediately and the camera reconnects on its own
          // alarm-stream backoff.
          await isapi.reboot().catch((err) => {
            this.ctx.logger.warn('VCA-triggered reboot failed', {
              tags: { deviceId: this.id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
        }
      } catch (err) {
        this.ctx.logger.warn('VCA resource push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ── OSD overlay push ───────────────────────────────────────
    // The `_osd*` shadow keys are NON-config (stripped from `cleaned`
    // by `stripOsdShadowFields`), so read them from the RAW `patch`.
    // Visibility toggles map to the datetime / channel-name overlay
    // setters; each text slot (`_osdTextOverlay1..4` → slot ids `1..4`)
    // maps to `setTextOverlay` — a blank value hides the slot (enabled
    // false), a non-empty value shows it with that text. After pushing
    // we re-read the snapshot so the form re-hydrates from the camera.
    const osdTextSlots: ReadonlyArray<{ field: string; id: string }> = [
      { field: '_osdTextOverlay1', id: '1' },
      { field: '_osdTextOverlay2', id: '2' },
      { field: '_osdTextOverlay3', id: '3' },
      { field: '_osdTextOverlay4', id: '4' },
    ]
    const touchesOsd = Object.keys(patch).some((k) => k.startsWith('_osd'))
    if (touchesOsd) {
      try {
        const isapi = this.ensureClient()
        if (typeof patch._osdDateTimeEnabled === 'boolean') {
          await isapi.setDateTimeOverlay(DEFAULT_CAMERA_NUMBER, {
            enabled: patch._osdDateTimeEnabled,
          })
        }
        if (typeof patch._osdChannelNameEnabled === 'boolean') {
          await isapi.setChannelNameOverlay(DEFAULT_CAMERA_NUMBER, {
            enabled: patch._osdChannelNameEnabled,
          })
        }
        for (const slot of osdTextSlots) {
          const raw = patch[slot.field]
          if (typeof raw !== 'string') continue
          const text = raw.trim()
          await isapi.setTextOverlay(DEFAULT_CAMERA_NUMBER, slot.id, {
            enabled: text.length > 0,
            text,
          })
        }
        // Re-hydrate the snapshot the OSD section reads from.
        await this.refreshOsdSnapshot()
      } catch (err) {
        this.ctx.logger.warn('osd overlay push failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Stream / encoder parameters are no longer applied here — the
    // hand-rolled Stream section was removed. The `stream-params` cap
    // (declares a `ui` block) is now the single UI + write path; its
    // `setProfile` calls `applyStreamProfilePatch` directly.

    // ── Re-read changed snapshot slices from the camera ─────────────
    // The Settings form hydrates its defaults from the persisted
    // `deviceCache.{image,ntp,light}Snapshot` blobs (see
    // `getSettingsUISchema`/`hydrateSchema`). Without a re-read, a Save
    // leaves the form showing the STALE snapshot until the next reconnect
    // / probe. Re-read ONLY the slices whose settings actually changed —
    // each reader runs once even when several sub-fields of a section
    // changed — and AWAIT them before returning so the form re-hydrates
    // with the camera's authoritative values. Wrapped per-reader in
    // best-effort try/catch already; we never let a refresh failure throw
    // out of the save.
    const imageChanged =
      typed.imageBrightness !== undefined ||
      typed.imageContrast !== undefined ||
      typed.imageSaturation !== undefined ||
      typed.imageSharpness !== undefined ||
      typed.imageWdrEnabled !== undefined ||
      typed.imageWdrLevel !== undefined ||
      typed.imageIrcutMode !== undefined
    const ntpChanged =
      typed.timeMode !== undefined ||
      typed.ntpServer !== undefined ||
      typed.ntpPort !== undefined ||
      typed.ntpSyncInterval !== undefined
    const lightChanged =
      typed.lightMode !== undefined ||
      typed.lightIrBrightness !== undefined ||
      typed.lightWhiteBrightness !== undefined ||
      typed.lightBrightnessRegulator !== undefined

    if (imageChanged) await this.refreshImageSnapshot()
    if (ntpChanged) await this.refreshNtpSnapshot()
    if (lightChanged) await this.refreshLightSnapshot()
  }

  // ── Teardown ─────────────────────────────────────────────────────

  override async removeDevice(): Promise<void> {
    this.ctx.logger.info('Removing Hikvision camera', { tags: { deviceId: this.id } })
    if (this.osdPollTimer) {
      clearInterval(this.osdPollTimer)
      this.osdPollTimer = null
    }
    this.reachabilityPoll?.stop()
    this.reachabilityPoll = null
    await this.disconnectAll()
    // NO stream retraction here (D685). This hook fires on a runner RESTART
    // too — `BaseDeviceProvider.onShutdown` decommissions every device — and
    // the broker dials a Hikvision camera directly (`pull-rtsp`): this
    // provider is not on the byte path. Retracting tore the brokers down for
    // the ~25 s the next runner took to boot, and every recording writer was
    // refused `404` six times meanwhile. A camera the operator REMOVED is
    // retracted by the broker itself, on `DeviceUnregistered`
    // (`handleDeviceRemoved` → `retractDevice`).
    this.published.clear()
  }

  private async disconnectAll(): Promise<void> {
    if (this.alarmReconnectTimer) {
      clearTimeout(this.alarmReconnectTimer)
      this.alarmReconnectTimer = null
    }
    if (this.alarmController) {
      try {
        this.alarmController.abort()
      } catch {
        /* swallow */
      }
      this.alarmController = null
    }
    for (const t of this.motionInactiveTimers.values()) clearTimeout(t)
    this.motionInactiveTimers.clear()
    this.lastMotionAt.clear()
    this.isapi = null
    this.markOnline(false)
  }
}

/**
 * Drop the underscore-prefixed OSD shadow fields a settings save
 * round-trips back. The form controller submits every displayed field
 * regardless of `readonlyField`, so the camera-driver `applySettings`
 * gets `_osdDateTimeEnabled` etc. mixed in with the real keys. The
 * schema doesn't define those keys → `config.setAll` would reject the
 * patch on Zod parse. Stripping them here keeps the form layer
 * unchanged at the cost of a tiny per-save filter.
 */
/**
 * Expand a privacy-mask shape into the 4-corner vertex list Hikvision's
 * ISAPI `<RegionCoordinatesList>` expects. A 'rect' becomes its axis-aligned
 * corners (TL, TR, BR, BL); a 'polygon' passes its vertices through.
 */
function privacyShapeToPoints(shape: PrivacyMaskShape): MaskPoint[] {
  if (shape.kind === 'polygon') {
    return shape.points.map((p) => ({ x: p.x, y: p.y }))
  }
  const { x, y, width, height } = shape
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ]
}

/** True when 4 vertices form an axis-aligned rectangle (exactly 2 distinct
 *  x and 2 distinct y values, within a small normalized tolerance). */
function isAxisAlignedRect(points: readonly MaskPoint[]): boolean {
  if (points.length !== 4) return false
  const QUANTUM = 0.004 // ~2px on a 500px canvas — tolerate firmware rounding
  const distinct = (vals: readonly number[]): number =>
    new Set(vals.map((v) => Math.round(v / QUANTUM))).size
  return distinct(points.map((p) => p.x)) === 2 && distinct(points.map((p) => p.y)) === 2
}

/** Map ISAPI region vertices onto a cap shape — axis-aligned quad → 'rect'
 *  (nicer drag/resize handles), anything else → free 'polygon'. */
function pointsToPrivacyShape(points: readonly MaskPoint[]): PrivacyMaskShape {
  if (isAxisAlignedRect(points)) {
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return {
      kind: 'rect',
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
    }
  }
  return { kind: 'polygon', points: points.map((p) => ({ x: p.x, y: p.y })) }
}

/** Render Hikvision's terse `supplementLightMode` tokens into operator-
 *  friendly labels. Unknown modes pass through verbatim. */
function friendlyHikvisionLightMode(mode: string): string {
  switch (mode) {
    case 'close':
      return 'Off'
    case 'irLight':
      return 'IR only (night-vision)'
    case 'whiteLight':
      return 'White light'
    case 'colorVuWhiteLight':
      return 'ColorVu White Light'
    case 'manual':
      return 'Manual (operator-driven)'
    case 'mixed':
      return 'Mixed (IR + white)'
    case 'auto':
      return 'Auto'
    case 'schedule':
      return 'Scheduled'
    case 'eventTrigger':
      return 'Event-triggered'
    default:
      return mode
  }
}

/** Map a `Weekday` name onto its POSIX `M` rule weekday index
 *  (0 = Sunday … 6 = Saturday). */
function weekdayToPosixIndex(day: Weekday): number {
  switch (day) {
    case 'Sunday':
      return 0
    case 'Monday':
      return 1
    case 'Tuesday':
      return 2
    case 'Wednesday':
      return 3
    case 'Thursday':
      return 4
    case 'Friday':
      return 5
    case 'Saturday':
      return 6
  }
}

/** A short, readable alpha abbreviation derived from the IANA id's last
 *  path segment (e.g. `Europe/Rome` → `ROME`, `UTC` → `GMT`). Hikvision
 *  accepts any alpha prefix in the POSIX `<timeZone>` string; this is
 *  purely cosmetic. */
function timezoneAbbrev(tz: Timezone): string {
  const segment = tz.id.split('/').pop() ?? tz.id
  const alpha = segment.replace(/[^A-Za-z]/g, '').toUpperCase()
  return alpha.length > 0 ? alpha : 'GMT'
}

/** Format an east-positive minute offset into a POSIX `H:MM:SS` string
 *  with the INVERTED sign POSIX `TZ` uses (UTC+1 → `-1:00:00`). */
function posixOffsetString(eastMinutes: number): string {
  // POSIX TZ offsets are west-positive: the value is what you ADD to
  // local time to reach UTC, i.e. the negation of the east-positive
  // convention used throughout `@camstack/types`.
  const posixMinutes = -eastMinutes
  const sign = posixMinutes < 0 ? '-' : ''
  const abs = Math.abs(posixMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  const mm = String(minutes).padStart(2, '0')
  return `${sign}${hours}:${mm}:00`
}

/**
 * Convert a `Timezone` entry into Hikvision's POSIX-style `<timeZone>`
 * string for `/ISAPI/System/time`. The format is POSIX
 * `std offset[dst[,startrule,endrule]]` with the offset sign INVERTED
 * relative to the east-positive convention (UTC+1 → `-1:00:00`), e.g.
 * `CET-1:00:00CEST-2:00:00,M3.5.0/2:00:00,M10.5.0/3:00:00`.
 *
 * The `M<month>.<week>.<weekday>` DST rule uses 1-based month, 1..5 week
 * (5 = last, matching our `startWeekIndex`), and 0..6 weekday (0 = Sunday).
 *
 * NOTE: the exact string Hikvision firmware accepts is best-effort here —
 * there is no Hikvision device available to validate against, so the
 * abbreviation prefix and rule formatting may need on-device tweaking.
 */
/**
 * Reverse of {@link ianaToHikvisionTimeZone}: map the camera's raw POSIX
 * `<timeZone>` string (e.g. `CST-1:00:00DST01:00:00,M3.5.0/02:00:00,...`)
 * back to a catalogue `Timezone.id`, so the picker can SEED from the camera's
 * current zone when the operator hasn't explicitly chosen one.
 *
 * Matches by the STANDARD UTC offset (parsed from the first signed `H:MM:SS`
 * after the leading alpha abbreviation; POSIX sign is inverted, so `-1:00:00`
 * → UTC+1 → +60 min), preferring an entry whose DST-presence matches the
 * string's (a `,M…` rule means DST). Offset-matching is robust to the exact
 * abbreviation / DST-rule formatting (which is firmware-specific). Returns
 * `undefined` when the string is empty/unparseable or no offset matches.
 */
function hikvisionTimeZoneToIana(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  // Leading alpha abbreviation, then a signed hours[:mm[:ss]] offset.
  const m = /^[A-Za-z]+\s*([+-]?\d{1,2})(?::(\d{2}))?/.exec(raw.trim())
  const hoursRaw = m?.[1]
  if (hoursRaw === undefined) return undefined
  const posixHours = Number(hoursRaw)
  const posixMins = m?.[2] ? Number(m[2]) : 0
  if (!Number.isFinite(posixHours)) return undefined
  // POSIX sign is inverted vs the east-positive convention used in the catalogue.
  const sign = hoursRaw.startsWith('-') ? -1 : 1
  const eastMinutes = -sign * (Math.abs(posixHours) * 60 + posixMins)
  const hasDst = /,M\d/.test(raw)
  const match =
    TIMEZONES.find(
      (t) => t.stdOffsetMinutes === eastMinutes && (hasDst ? t.dst !== null : t.dst === null),
    ) ?? TIMEZONES.find((t) => t.stdOffsetMinutes === eastMinutes)
  return match?.id
}

function ianaToHikvisionTimeZone(tz: Timezone): string {
  const abbrev = timezoneAbbrev(tz)
  const stdOffset = posixOffsetString(tz.stdOffsetMinutes)
  if (!tz.dst) {
    return `${abbrev}${stdOffset}`
  }
  // DST-active offset = standard east-positive offset + the forward
  // shift; re-inverted for POSIX by `posixOffsetString`.
  const dstEastMinutes = tz.stdOffsetMinutes + tz.dst.offsetHours * 60
  const dstOffset = posixOffsetString(dstEastMinutes)
  const startRule =
    `M${tz.dst.startMonth}.${tz.dst.startWeekIndex}.${weekdayToPosixIndex(tz.dst.startWeekday)}` +
    `/${tz.dst.startHour}:00:00`
  const endRule =
    `M${tz.dst.endMonth}.${tz.dst.endWeekIndex}.${weekdayToPosixIndex(tz.dst.endWeekday)}` +
    `/${tz.dst.endHour}:00:00`
  // DST abbreviation: append `DT` (daylight) to the std abbreviation for
  // a readable, arbitrary alpha token.
  return `${abbrev}${stdOffset}${abbrev}DT${dstOffset},${startRule},${endRule}`
}

/**
 * Convert a `datetime-local` form value (`YYYY-MM-DDTHH:MM`, local
 * wall-clock, no seconds / zone) into the zoned ISO-8601 string Hikvision's
 * `<localTime>` requires (`YYYY-MM-DDTHH:MM:SS±HH:MM`).
 *
 * The DISPLAYED wall-clock the camera ends up showing is the one we send
 * ONLY when the offset we attach matches the offset the camera itself uses
 * to re-render `<localTime>`. Hikvision re-projects any instant we PUT onto
 * its OWN configured offset, and observed firmware ignores the DST rule in
 * `<timeZone>` (it stays on the standard offset, e.g. `+01:00` year-round).
 * So the caller passes `offset` = the camera's CURRENT `<localTime>` offset
 * (`offsetFromZonedIso`), guaranteeing the camera displays exactly the
 * supplied wall-clock regardless of how it (mis)handles DST.
 *
 * When `offset` is null (firmware omits `<localTime>`, e.g. some NTP modes)
 * we fall back to the host's current DST-aware UTC offset. Falls back to a
 * bare `:00` suffix when the wall-clock shape is unrecognised.
 */
function datetimeLocalToZonedIso(local: string, offset: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!m) return `${local}:00`
  const [, y, mo, d, h, mi] = m
  const zone = offset ?? hostUtcOffset(Number(y), Number(mo), Number(d), Number(h), Number(mi))
  return `${y}-${mo}-${d}T${h}:${mi}:00${zone}`
}

/** The host's UTC offset (`±HH:MM`) for a given local wall-clock instant,
 *  DST-aware via `Date#getTimezoneOffset`. */
function hostUtcOffset(y: number, mo: number, d: number, h: number, mi: number): string {
  const date = new Date(y, mo - 1, d, h, mi, 0)
  // getTimezoneOffset() is minutes BEHIND UTC (positive west of UTC), so
  // the ISO sign is inverted.
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** Extract the UTC offset designator (`+01:00`, `-05:00`, or `Z`) from the
 *  tail of a zoned ISO-8601 string; null when absent / unparseable. */
function offsetFromZonedIso(iso: string | null | undefined): string | null {
  if (!iso) return null
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(iso.trim())
  return m?.[1] ?? null
}

/**
 * Convert the camera's `<localTime>` (zoned ISO-8601,
 * `YYYY-MM-DDTHH:MM:SS±HH:MM` or `…Z`) into the `datetime-local` form value
 * the "Manual date & time" picker expects (`YYYY-MM-DDTHH:MM`).
 *
 * We take the wall-clock components VERBATIM (date + hours + minutes) and
 * drop the seconds and zone designator — that string IS what the camera is
 * displaying on its OSD, so the picker pre-fills with the time the operator
 * sees. No timezone math: re-interpreting through the host zone would shift
 * the shown value when the host and camera zones differ.
 */
/**
 * The host's current wall-clock as a `datetime-local` string
 * (`YYYY-MM-DDTHH:MM`), ready to feed `datetimeLocalToZonedIso`. Used by the
 * "Sync time" action so it shares the manual path's exact formatting.
 */
function hostDatetimeLocalNow(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function hikvisionLocalTimeToDatetimeLocal(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return undefined
  const [, y, mo, d, h, mi] = m
  return `${y}-${mo}-${d}T${h}:${mi}`
}

function stripOsdShadowFields(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('_osd')) continue
    out[k] = v
  }
  return out
}
