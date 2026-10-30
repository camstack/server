import type { EncStreamPatch } from '@apocaliss92/nodelink-js'
import { shouldAcceptSleepPushSource } from '@apocaliss92/nodelink-js'
import {
  ACCESSORY_LABEL,
  AccessoryKind,
  type AccessoryKindValue,
  BaseDevice,
  type BatteryStatus,
  batteryCapability,
  buildDeviceAdminUrl,
  buildStreamParamsConfigSchema,
  createEvent,
  createRuntimeStateBridge,
  type DayNightMode,
  type DayNightOptions,
  DayNightOptionsSchema,
  type DayNightStatus,
  DeviceFeature,
  DeviceType,
  dayNightCapability,
  describeOnboardRefusal,
  deviceAdminLinkCapability,
  deviceCustomAction,
  doorbellCapability,
  EventCategory,
  type ExposureMode,
  findTimezone,
  hubMotionNativeProvider,
  hydrateSchema,
  type ImageSettingsOptions,
  ImageSettingsOptionsSchema,
  type ImageSettingsStatus,
  type IntercomAbility,
  imageSettingsCapability,
  intercomCapability,
  type MotionZoneOptions,
  MotionZoneOptionsSchema,
  type MotionZoneStatus,
  motionCapability,
  motionZonesCapability,
  type NativeObjectClass,
  NativeObjectClassEnum,
  type NativeObjectDetectionRuntimeState,
  NETWORK_LINK_UNKNOWN,
  nativeObjectDetectionCapability,
  networkLinkCapability,
  OPERATOR_WRITTEN_STALE_MS,
  type OsdStatus,
  osdCapability,
  type PrivacyMaskOptions,
  PrivacyMaskOptionsSchema,
  type PrivacyMaskRegion,
  type PrivacyMaskShape,
  type PrivacyMaskStatus,
  type PtzAutotrackRuntimeState,
  type PtzAutotrackSettings,
  type PtzAutotrackStatus,
  type PtzOptions,
  PtzOptionsSchema,
  privacyMaskCapability,
  providerMotionEvent,
  ptzAutotrackCapability,
  ptzCapability,
  type RawStateResult,
  type RecordingOnboardOptions,
  type RecordingOnboardStatus,
  RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS,
  rebootCapability,
  recordingOnboardCapability,
  type StreamParamsOptions,
  StreamParamsOptionsSchema,
  type StreamParamsStatus,
  type StreamProfile,
  type StreamProfilePatch,
  type StreamSignal,
  sleep,
  snapshotCapability,
  streamCatalogCapability,
  streamParamsCapability,
  streamSignalsCapability,
  summarisePrivacyAudio,
  TIMEZONES,
  userError,
} from '@camstack/types'
import type { BaichuanWebhookParamsResolver } from './baichuan-webhook-shared.js'
import { deriveChargingSource, reportsPowerSource } from './battery-charging.js'
import {
  BATTERY_REFRESH_TICK_MS,
  BatteryHourlyRefresh,
  type BatteryRefreshOutcome,
  resolveBatteryRefreshIntervalMs,
} from './battery-hourly-refresh.js'
import { buildBatteryRefreshDeviceSection } from './battery-refresh-settings.js'
import { refreshSnapshotCacheOnce } from './battery-snapshot-refresh.js'
import { resolveCameraUid } from './clips/clip-addressing.js'
import { buildClipRefreshDeviceSection } from './clips/clip-refresh-settings.js'
import type { ClipDeviceRef } from './clips/reolink-videoclips-provider.js'
import { capDayNightModeToReolink, reolinkDayNightModeToCap } from './day-night-mapping.js'
import { deriveReolinkCameraFeatures, type ReolinkProbeFlags } from './device-features.js'
import type { EmailPushParamsResolver } from './email-push-shared.js'
import { reolinkExposureModeToCap } from './image-settings-mapping.js'
import { denormalizeFromPercent, normalizeToPercent } from './image-value-normalization.js'
import { CH_BAICHUAN, CH_HANDSHAKE } from './log-channels.js'
import { type LiveRfc4571Endpoint, overlayLiveNativeRfc4571Sdp } from './native-sdp-overlay.js'
import {
  buildOsdCapOverlayPatch,
  buildOsdPatch,
  osdStatusFromSnapshot,
  projectOsdSnapshot,
} from './osd-mapping.js'
import { buildOsdSection, isOsdSnapshotStale, resolveOsdValues } from './osd-settings-section.js'
import { performRawRead, type RawReadResult, type RawReadSlice } from './raw-read.js'
import { buildRawState } from './raw-state.js'
import {
  buildOnboardOptions,
  buildOnboardStatus,
  buildOnboardWrites,
  parseOnboardStorage,
  type ReolinkRecordCfgLike,
  type ReolinkRecordLimitsLike,
  type ReolinkRecordScheduleLike,
} from './recording-onboard-mapping.js'
import { decideSleepCommit, type SleepCommitSource } from './sleep-state-decision.js'
import { buildSnapshotFreshnessSection, stampSnapshotFreshness } from './snapshot-freshness.js'
import { decideSnapshotCameraAccess } from './snapshot-wake-gate.js'

/**
 * The `<Compression>` stream blocks that can carry an audio flag, in the
 * order the camera reports them. Named once so the read
 * (`readStreamAudioProfiles`) and the write (`setAudioEnabled`) cannot cover
 * different sets — a mute that skipped a stream would leave the camera
 * audible while reporting itself silent.
 */
const REOLINK_AUDIO_STREAM_KEYS = ['mainStream', 'subStream', 'thirdStream'] as const
type ReolinkAudioStreamKey = (typeof REOLINK_AUDIO_STREAM_KEYS)[number]

import { randomBytes } from 'node:crypto'
import {
  type AiConfig,
  type AiDetectCfgZone,
  type CompressionStream,
  createRfc4571TcpServer,
  decodeMotionScopeBitmap,
  type EncStreamOptions,
  encodeMotionScopeBitmap,
  fullCoverageScope,
  type MotionZoneScope,
  ReolinkBaichuanApi,
  type Rfc4571TcpServer,
  type ShelterRect,
} from '@apocaliss92/nodelink-js'
import type {
  CamProfile,
  CamStreamDescriptor,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  FeatureProbeStatus,
  ICameraDevice,
  InferNativeProvider,
  StreamCatalogState,
  StreamSourceEntry,
} from '@camstack/types'
import { z } from 'zod'
import { createAccessoryDevice } from './accessories/index.js'
import {
  accessoryKindsFor,
  effectiveProbeFlags,
  withPersistedProbe,
} from './accessory-probe-flags.js'
import { populateReolinkMetadata } from './metadata-populator.js'
import { isWirelessLabel, mapNetworkReadout } from './network-link-mapping.js'

/** Generate a short random hex token for per-stream RTSP-style credentials. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * Bound a camera round-trip so a wedged Baichuan request can't hang a
 * caller forever. Rejects after `ms` if the underlying promise hasn't
 * settled — the camera's session table is finite (Reolink caps live
 * sessions ~5), so a session-exhausted device can leave a request with
 * no response indefinitely. Wrapping the catalog-build round-trips with
 * this turns "hang forever" into a normal rejection the existing
 * try/catch handles (returns an empty catalog → the broker re-pulls on
 * its next reconcile tick instead of stalling).
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
 * Reduce a privacy-mask shape to a normalized rectangle. Reolink shelter
 * zones are rectangles only; a polygon (which the UI won't produce for a
 * reolink camera, since it advertises `supportedShapes: ['rect']`) is
 * defensively reduced to its axis-aligned bounding box.
 */
function privacyShapeToRect(shape: PrivacyMaskShape): {
  x: number
  y: number
  width: number
  height: number
} {
  if (shape.kind === 'rect') {
    return { x: shape.x, y: shape.y, width: shape.width, height: shape.height }
  }
  const xs = shape.points.map((p) => p.x)
  const ys = shape.points.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

/**
 * Coerce the lib-reported codec string to the canonical broker form.
 * Reolink firmwares vary: some report `"H.265"` (with dot), some
 * `"H265"`, some `"hevc"`, some `"H.264"`. The broker registry and
 * WebRTC session-negotiation expect strict `"h265"` / `"h264"` —
 * anything else falls through to the H.264 branch and the dotted
 * `h.265` was opening Chrome with the wrong decoder. Strip every
 * non-alphanumeric and lowercase, then map the known synonyms.
 *
 * Returns `undefined` when the input is empty so callers can fall
 * back to their own default branch (e.g. `server.videoType`).
 */
function normalizeCodecName(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  const collapsed = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!collapsed) return undefined
  if (collapsed === 'hevc') return 'h265'
  if (collapsed === 'avc') return 'h264'
  return collapsed
}
/**
 * Reolink motion-detection grid geometry, extracted from a `getMotionAlarm`
 * response. The camera carries TWO dimension pairs:
 *  - `columns`/`rows` — the bitmap canvas the base64 `valueTable` packs.
 *  - `width`/`height` — the smaller EFFECTIVE editable region; the cap's
 *    `gridWidth`/`gridHeight` and `cells` array map to this pair.
 */
interface MotionZoneGrid {
  columns: number
  rows: number
  width: number
  height: number
}

/**
 * Reolink user-facing motion sensitivity is 1..50 but the raw camera
 * value is INVERTED — a higher user value means a lower raw value.
 * `@apocaliss92/nodelink-js`'s `setMotionAlarmFull` writes the raw value
 * straight into `<sensitivityDefault>` with no inversion, and
 * `getMotionAlarm` returns the raw value verbatim, so the provider owns
 * the conversion in both directions. The transform is its own inverse:
 * `51 - x` maps 1↔50 and round-trips cleanly.
 */
function invertReolinkSensitivity(value: number): number {
  return 51 - value
}

/** Narrow an unknown value to a plain record for safe field traversal. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Depth-first search for the first record under `root` that carries a
 * given key. The Baichuan `getMotionAlarm` (cmd_id 46) response is parsed
 * XML whose exact nesting (`body.MdAlarm` vs a bare `MD` element) varies
 * across firmwares and isn't fully captured by the lib's types — so the
 * provider locates the motion-detection node structurally rather than by
 * a fixed path.
 */
function findRecordWithKey(root: unknown, key: string): Record<string, unknown> | null {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findRecordWithKey(item, key)
      if (found) return found
    }
    return null
  }
  if (!isRecord(root)) return null
  if (key in root) return root
  for (const value of Object.values(root)) {
    const found = findRecordWithKey(value, key)
    if (found) return found
  }
  return null
}

/** Coerce a parsed-XML value (number or numeric string) to a finite number. */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

import type { PtzGuardStatus } from '@apocaliss92/nodelink-js'
import type { PtzHomePreset } from '@camstack/types'
import { isRecoverableBaichuanError } from './error-classifier.js'
import {
  intercomFailureReport,
  REASON_TALK_CODEC_UNSUPPORTED,
  REASON_TALK_EMPTY,
  REASON_TALK_NO_SAMPLE_RATE,
  REASON_TALK_NOT_MONO,
  REASON_TALK_OPUS_FAILED,
  REASON_TALK_OUT_OF_ORDER,
} from './intercom-failure-report.js'
import { type IntercomAudioCodecApi, IntercomOrchestrator } from './intercom-orchestrator.js'
import { ReolinkIntercomSession } from './intercom-session.js'
import { WeriftIntercomPeer } from './intercom-webrtc-peer.js'
import {
  createMotionSensorTracker,
  motionSensorOnSimpleEvent,
  type ReolinkMotionSensor,
} from './motion-sensor-source.js'
import {
  buildSupportedNativeClasses,
  isNativeObjectForwardingEnabled,
  mapDetectionEvent,
  NATIVE_DETECTION_SUPPRESSED_LOG_MS,
} from './native-detection-mapping.js'
import { DEFAULT_GUARD_TIMEOUT_SECONDS } from './ptz-guard.js'
import {
  resolveZoomStep,
  ZOOM_FACTOR_SCALE,
  ZOOM_SET_ATTEMPTS,
  ZOOM_SET_RETRY_MS,
} from './ptz-zoom.js'
import {
  isConnectivityFailure,
  type ReachabilityOfflineInfo,
  ReachabilityOfflineTracker,
  type ReachabilityOnlineInfo,
  type ReachabilityProbeResult,
} from './reachability-offline.js'
import {
  AI_CLASS_MAP,
  DEFAULT_CHANNEL,
  REOLINK_ADDON_ID,
  type ReolinkCameraConfig,
  type ReolinkSocketDebugFlag,
  reolinkCameraSchema,
} from './schema.js'
import {
  buildSessionsTabSections as buildSessionsTabSectionsShared,
  captureSessionsSnapshot,
  SESSIONS_SNAPSHOT_MAX_AGE_MS,
  type SessionsSnapshot,
} from './sessions-snapshot.js'
import {
  buildCamStreamId,
  buildStreamIds,
  parseCamStreamId,
  type ReolinkStreamProfile,
  streamLabel,
} from './stream-routing.js'
import { buildLazyRfc4571Url, buildSyntheticRfc4571Sdp } from './synthetic-sdp.js'
import { TalkPcmTranscoder } from './talk-pcm-transcoder.js'

/**
 * Baichuan's native PTZ speed scale is 1..63; `runPtz` maps the cap's
 * normalized 0..1 onto it. Named because the autotrack loop has to know the
 * GRANULARITY of the knob it turns -- a normalized 0.37 means something very
 * different on 63 steps than on amcrest's 8.
 */
const BAICHUAN_SPEED_STEPS = 63

/**
 * How long one `ptz.move` pulse runs, ms -- the `autoStopMs` handed to
 * Baichuan. It is the DENOMINATOR of "how far did the head travel per pulse",
 * so it is exported through `getOptions` rather than left a literal no caller
 * could read.
 */
const PTZ_MOVE_IMPULSE_MS = 200

/**
 * Narrow shape of the `audio-codec` cap router on `ctx.api`. We type
 * only the four methods the intercom orchestrator drives (decode +
 * push + pull + close) — the full router carries encode + listing
 * methods we don't need here. Mirrors the broker's
 * `audio-codec-proxy.ts` pattern: keep the consumer-facing surface
 * narrow rather than coupling to the generated tRPC router type.
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
  REOLINK_ADDON_ID,
  ReolinkDeviceTypeSchema,
  ReolinkUdpDiscoveryMethodSchema,
  reolinkCameraSchema,
} from './schema.js'

/**
 * One running RFC 4571 TCP server per native (channel, profile) tuple,
 * keyed by camStreamId (e.g. `native:main`). The lib spins up a loopback
 * TCP server that emits framed RTP; the broker pulls from it as a
 * `pull-rfc4571` source. The lib internally manages the underlying
 * Baichuan socket — opening it on first client connect, closing on
 * idle — so battery cams stay asleep when nobody's watching.
 */
interface ActiveStream {
  readonly camStreamId: string
  readonly profile: CamProfile
  readonly server: Rfc4571TcpServer
}

/**
 * Per-device transient diagnostics blob populated from the lib's
 * `getOnlineUserSessionsForUi` + `getSocketPoolSummary` +
 * `getSocketPoolCooldownStatus` calls. NOT persisted — recomputed on
 * demand and shown in the device's "Sessions" tab. The aggregator UI
 * polls the device aggregate every ~2.5s and a stale snapshot triggers
 * a background refresh; the operator can also force one via the
 * tab's Refresh button (`_refreshSessions` patch sentinel).
 */
// Sessions diagnostic types + helpers live in `sessions-snapshot.ts`
// (shared with `ReolinkHub`).

// `ReolinkProbeFlags` and the feature derivation live in `device-features.ts`
// so the "which features does this camera have" rule is testable without
// constructing a whole `ReolinkCamera` + `DeviceContext`.

/**
 * Reolink camera device — connects via Baichuan protocol and pushes
 * Annex-B H.264/H.265 directly to the stream broker.
 *
 * Lifecycle (Slice 1):
 *   1. The broker PULLS the `stream-catalog` cap and dials each
 *      cam stream on demand.
 *   2. The owning addon listens for `stream-broker.onCamStreamDemand`
 *      events and forwards them to `onCamStreamDemand()` here.
 *   3. We login (lazy), open a `BaichuanVideoStream` for the requested
 *      stream, fetch the broker handle, and forward every
 *      `videoAccessUnit` event as `pushEncodedPacket`.
 *   4. On `onCamStreamIdle()` we stop the stream. The Baichuan socket
 *      stays alive while at least one stream is active — battery-aware
 *      sleep handling lands in Slice 3.
 */
/**
 * Type guard: narrows a Baichuan-mapped class string to a cap-facing
 * `NativeObjectClass` via the enum's own validation (no `as` cast).
 */
function isNativeObjectClass(value: string): value is NativeObjectClass {
  return NativeObjectClassEnum.safeParse(value).success
}

/** Raw `getNetPort` (cmd_id 37) readout shape. */
type NetPortReadout = Awaited<ReturnType<ReolinkBaichuanApi['getNetPort']>>

/**
 * Parse a `getNetPort` readout into the persisted `netPortSnapshot` shape
 * (lowercase proto → `{ enable?, port }`, plus the Baichuan control `server`
 * port). Shared by the full settings re-probe and the targeted post-save
 * refresh so both produce an identical snapshot. Returns a loose `Record`
 * (mirrors the deviceCache batched-write style) — empty when nothing parsed.
 */
function parseNetPortSnapshot(ports: NetPortReadout): Record<string, unknown> {
  const readEntry = (proto: string): { enable?: boolean; port: number | null } | undefined => {
    const raw = ports[proto]
    if (!raw) return undefined
    const portVal = raw[`${proto}port`]
    const entry: { enable?: boolean; port: number | null } = {
      port: typeof portVal === 'number' ? portVal : null,
    }
    if (typeof raw.enable === 'number') entry.enable = raw.enable === 1
    return entry
  }
  const snap: Record<string, unknown> = {}
  for (const proto of ['http', 'https', 'rtsp', 'rtmp', 'onvif'] as const) {
    const entry = readEntry(proto)
    if (entry) snap[proto] = entry
  }
  const server = readEntry('server')
  if (server) snap.server = { port: server.port }
  return snap
}

type SnapshotSlice =
  | 'image'
  | 'motion'
  | 'ai'
  | 'enc'
  | 'mask'
  | 'audioNoise'
  | 'autofocus'
  | 'netPort'
  | 'ntp'
  | 'osd'
  | 'led'
  | 'pir'
  | 'autoReboot'
  | 'systemGeneral'

/**
 * Reverse of the timezone WRITE path: map the camera's numeric POSIX timezone
 * offset (from `getSystemGeneral().timeZone`, seconds, sign-inverted vs
 * east-positive: UTC+1 → -3600) back to a catalogue `Timezone.id`, so the
 * picker seeds from the camera's current zone when the operator hasn't picked
 * one. Matches by standard offset, preferring a DST-observing entry. Returns
 * undefined when no offset matches. */
function reolinkTimeZoneToIana(posixSeconds: number | undefined): string | undefined {
  if (typeof posixSeconds !== 'number' || !Number.isFinite(posixSeconds)) return undefined
  const eastMinutes = -(posixSeconds / 60)
  return (
    TIMEZONES.find((t) => t.stdOffsetMinutes === eastMinutes && t.dst !== null)?.id ??
    TIMEZONES.find((t) => t.stdOffsetMinutes === eastMinutes)?.id
  )
}

/** Map a settings patch to the snapshot slices it changed, so the post-save
 *  refresh re-reads ONLY those from the camera. AI keys are class-prefixed
 *  (`aiPerson*`/`aiVehicle*`/`aiAnimal*`/`aiFace*`/`aiPackage*`). */
function slicesForPatch(patch: Record<string, unknown>): Set<SnapshotSlice> {
  const has = (...keys: readonly string[]): boolean => keys.some((k) => k in patch)
  const out = new Set<SnapshotSlice>()
  if (
    has(
      'imgBright',
      'imgContrast',
      'imgSaturation',
      'imgHue',
      'imgSharpen',
      'ispDayNight',
      'ispExposure',
      'ispBinningMode',
      'ispHdr',
      'ispDayNightThreshold',
    )
  )
    out.add('image')
  if (has('motionEnabled', 'motionSensitivity')) out.add('motion')
  if (Object.keys(patch).some((k) => /^ai(Person|Vehicle|Animal|Face|Package)/.test(k)))
    out.add('ai')
  if (has('gop')) out.add('enc')
  if (has('audioNoiseLevel')) out.add('audioNoise')
  if (has('autoFocusEnabled')) out.add('autofocus')
  if (
    has(
      'netHttpEnable',
      'netHttpPort',
      'netHttpsEnable',
      'netHttpsPort',
      'netRtspEnable',
      'netRtspPort',
      'netRtmpEnable',
      'netRtmpPort',
      'netOnvifEnable',
      'netOnvifPort',
    )
  )
    out.add('netPort')
  if (has('ntpEnabled', 'ntpServer', 'ntpPort', 'ntpInterval')) out.add('ntp')
  if (
    has(
      'osdChannelEnabled',
      'osdChannelName',
      'osdChannelPosition',
      'osdTimeEnabled',
      'osdTimePosition',
      'osdWatermark',
    )
  )
    out.add('osd')
  if (has('irLightsState', 'irLightsBrightness', 'statusLedEnabled', 'doorbellLedEnabled'))
    out.add('led')
  if (has('pirReduceFalseAlarm')) out.add('pir')
  if (has('autoRebootEnabled', 'autoRebootWeekDay', 'autoRebootHour', 'autoRebootMinute'))
    out.add('autoReboot')
  if (has('timeZoneId')) out.add('systemGeneral')
  return out
}

/**
 * WHY a settings snapshot is being re-read. Only `post-write` bypasses the
 * battery sleep gate, and it does so because the write it follows is fresher
 * evidence than the mirror the gate consults.
 */
type SettingsRefreshReason = 'background' | 'post-write' | 'operator' | 'scheduled'

/** How a cap-slice warm-up should treat what it already believes. */
interface CapWarmOptions {
  /**
   * Ignore the freshness skip. Only the operator's "Refresh from camera" sets
   * it: that button exists precisely to distrust the slices we already have,
   * while an automatic wake should not re-read what it read a minute ago.
   */
  readonly force?: boolean
}

/** What a warm-up managed, for the line it logs and the answer it returns. */
interface CapWarmOutcome {
  readonly warmed: number
  readonly skipped: number
}

/**
 * What the operator's "Refresh from camera" actually managed.
 *
 * Returned rather than logged, because the button is the one place a person
 * asks "is what I am looking at true right now" — and an answer of `void`
 * cannot distinguish a full re-read from a camera that never woke.
 */
const RefreshSettingsResultSchema = z.object({
  /** False when a battery camera did not come up — everything below is then stale. */
  awake: z.boolean(),
  snapshotRefreshed: z.boolean(),
  capsWarmed: z.number(),
  capsTotal: z.number(),
})

/** The uid out of a device's metadata bag, or nothing. Never a cast. */
function metaUid(metadata: Record<string, unknown> | null): string | undefined {
  if (metadata === null) return undefined
  const uid = metadata['uid']
  return typeof uid === 'string' ? uid : undefined
}

export class ReolinkCamera extends BaseDevice<typeof reolinkCameraSchema> implements ICameraDevice {
  readonly type = DeviceType.Camera as const

  /**
   * Features derived from the `feature-probe` runtime-state slice AND the
   * driver's own `isBattery` discriminator. Surfaced via
   * `device-manager.getDevice` so any service in the cluster (stream-broker,
   * snapshot orchestrator, pipeline-runner) can derive policy from a single
   * source.
   *
   * The rule itself lives in `deriveReolinkCameraFeatures` — see that
   * function for why `battery-operated` must NOT wait for a probe.
   *
   * Returns a fresh array on each read so consumers can't mutate the
   * underlying state. The set is small (≤6 entries) so allocation cost
   * is negligible vs the staleness of caching.
   */
  /**
   * Probe flags with the persisted fallback: until this session has probed
   * (a battery camera asleep at boot skips `onProbe`), the flags of the last
   * successful probe stored in `deviceCache` stand in for the empty
   * `feature-probe` slice. Every probe-gated read — PTZ / intercom /
   * doorbell / autotrack registration, `features`, accessory children —
   * goes through here, so a sleeping camera keeps those caps across a
   * provider restart. `config` is read defensively: the base constructor
   * may read flags before this class's fields exist.
   */
  protected override getProbeFlags<
    F extends Record<string, unknown> = Record<string, unknown>,
  >(): F {
    return effectiveProbeFlags(
      this.hasProbed(),
      super.getProbeFlags<F>(),
      this.config?.get('deviceCache'),
    )
  }

  get features(): readonly DeviceFeature[] {
    return deriveReolinkCameraFeatures({
      probe: this.getProbeFlags<ReolinkProbeFlags>(),
      isBattery: this.isBattery,
    })
  }

  /** Lazy-connected Baichuan API. Spans the lifetime of every active stream. */
  private api: ReolinkBaichuanApi | null = null
  /**
   * Stable bound handler for `api.onSimpleEvent` — created ONCE in
   * the class so every `onSimpleEvent` / `offSimpleEvent` call uses
   * the SAME function reference. The lib's `simpleEventListeners`
   * is a `Set` and dedupes by reference, so passing inline arrows
   * `(e) => this.handleSimpleEvent(e)` on each subscribe call (as
   * the previous code did across login / adoptApi / watchdog
   * paths) silently accumulated multiple listeners — same event
   * dispatched N times on the camstack side, and `offSimpleEvent`
   * couldn't remove the old one without the original ref. Net
   * effect was that subscriptions drifted out of sync with the
   * camera's TCP push channel: device 15 (Carol) went silent for
   * 2+ hours while device 8 (battery doorbell) kept pushing
   * normally because its short connection lifecycle naturally
   * reset the listener set.
   */
  private readonly handleSimpleEventBound = (
    event: import('@apocaliss92/nodelink-js').ReolinkSimpleEvent,
  ): void => {
    this.handleSimpleEvent(event)
  }
  /**
   * MD vs PIR of this camera's own motion pushes. The lib's simple event drops
   * it, so the raw client `event` is observed — PREPENDED, so the sensor is
   * recorded before the API maps the same emit into the simple event
   * (`motion-sensor-source.ts`). Hub children get theirs from the hub.
   */
  private readonly motionSensors = createMotionSensorTracker()
  private readonly observeRawEventBound = (
    event: import('@apocaliss92/nodelink-js').ReolinkEvent,
  ): void => {
    this.motionSensors.observe(event)
  }
  /**
   * Stable bound handler for `api.onObjectDetections` — created ONCE so
   * every `onObjectDetections` / `offObjectDetections` call uses the
   * SAME function reference (same listener-Set dedup rationale as
   * `handleSimpleEventBound`).
   *
   * This is the BOXED detection channel: the lib decodes per-frame AI
   * bounding boxes off the streaming side-channel (BcMedia
   * `additionalHeader`) and forwards them here. Mapped to
   * `DetectionCameraNative` WITH bbox/confidence so the analyzer can
   * zone/track them — the richer counterpart to the flag-only
   * `handleSimpleEvent` AI path (which we keep for the motion heartbeat).
   */
  private readonly handleObjectDetectionsBound = (
    event: import('@apocaliss92/nodelink-js').ReolinkDetectionEvent,
  ): void => {
    this.handleObjectDetections(event)
  }
  /**
   * True once we've successfully subscribed `onObjectDetections` on the
   * current api, so the teardown path (`unsubscribeObjectDetections`)
   * only calls `offObjectDetections` (which closes the auto-managed
   * substream) when there's actually something to remove. Reset on api
   * close.
   */
  private objectDetectionsSubscribed = false
  /**
   * Plugin-level event-health interval — fallback layer over the
   * lib's internal 5-minute watchdog. The rule: every 60 s,
   * if `eventSubscriptionActive` is false on a live socket OR no
   * event has arrived in 10 min, force a full unsub/resub cycle.
   */
  private eventHealthCheckTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Counter of consecutive event-health re-subscribes that did NOT
   * recover an event. Drives the log-level degradation (first one is
   * `info` so operators see something; the long tail drops to
   * `debug`) and the polling backoff (60s → 5min → 15min so a
   * chronically-silent camera doesn't spam the logs every minute).
   * Reset to 0 the moment a simpleEvent arrives.
   */
  private consecutiveStaleHealthChecks = 0
  /** Wall-clock ms when the next health check is allowed to fire.
   *  Used by `runEventHealthCheckTick` to short-circuit between
   *  backoff windows without changing the underlying interval. */
  private nextEventHealthCheckAt = 0
  /** Active video streams keyed by camStreamId. */
  private readonly active = new Map<string, ActiveStream>()
  /** Login lock — concurrent demand events must not race the login flow. */
  private loginPromise: Promise<ReolinkBaichuanApi> | null = null
  /** True once we've discovered (via getBatteryInfo) that this is a battery cam. */
  private isBattery = false
  /**
   * When each AI class last had its suppression reported, so the gate's drop is
   * on the record without one line per push. Per class because the vocabulary
   * is five values and the finding is WHICH class the camera is pushing that
   * nothing downstream receives.
   */
  private readonly nativeDetectionSuppressedAt = new Map<string, number>()
  /** Reconnect attempt counter — drives exponential backoff. */
  private reconnectAttempts = 0
  /** Pending reconnect timer; cleared on successful reconnect or removeDevice. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * D904: offline from SUSTAINED unreachability on a mains camera that owns its
   * socket. Fed by socket loss and network-level login failures; its verdicts
   * are the normal DeviceOffline / DeviceOnline. Never fed for a battery camera
   * (asleep is not gone, D173) nor for a hub child (the Hub owns that socket).
   */
  private readonly reachability = new ReachabilityOfflineTracker({
    probe: () => this.probeReachability(),
    onOffline: (info) => this.onReachabilityOffline(info),
    onOnline: (info) => this.onReachabilityOnline(info),
  })
  /**
   * Read-through to the `battery.sleeping` runtime-state slice with
   * a `false` default for non-battery cams (no slice). Internal
   * shorthand — driver code uses `this.state.battery.sleeping = b` to write
   * (proxy on `BaseDevice`); reads via this getter to avoid sprinkling
   * `?? false` everywhere conditional logic checks the flag.
   */
  private get sleeping(): boolean {
    return this.state.battery.sleeping ?? false
  }
  /**
   * Wall-clock ms when a FIRST-HAND observation last moved `this.sleeping`.
   *
   * It drives two windows — the anti-flap hysteresis that filters the lib's
   * UDP sleep inference, and the grace that stops the parent's LAGGING
   * summary from clobbering a fresher verdict. Both want the same thing:
   * "when did something that was actually looking at the camera last speak".
   *
   * The parent's periodic summary sweep (`hub-reconcile`) therefore never
   * stamps this. It is firmware truth, but it is minutes old, and stamping
   * it armed the 30 s wake window against the camera's own wake push — see
   * `sleep-state-decision.ts` for the measurement (D603).
   */
  private sleepStateChangedAt = 0
  /**
   * Wall-clock ms of the last PROACTIVE wake — one we issued on our own
   * initiative (background snapshot refresh), not because the operator
   * or a stream consumer asked for the camera. Drives
   * `canProactivelyWake` below.
   */
  private lastProactiveWakeAt = 0
  /**
   * Minimum gap between two proactive wakes. Demand-driven wakes
   * (`wakeForStream` from the broker, `wakeIfSleeping` behind an
   * operator action, the intercom pre-wake) bypass this entirely —
   * the operator asked, the operator gets the camera. Only
   * self-initiated wakes are rate-limited, so a thumbnail cache miss
   * can't wake a doorbell every few minutes.
   */
  private static readonly PROACTIVE_WAKE_COOLDOWN_MS = 10 * 60_000
  /** Background timer that runs the passive sleep poll (battery cams only). */
  private sleepPollTimer: ReturnType<typeof setInterval> | null = null

  /** Periodic timer driving `alignAuxDevicesState()` on wired cams.
   *  Battery cams use the wake transition path instead. */
  private alignAuxTimer: ReturnType<typeof setInterval> | null = null

  /** Periodic timer driving the battery-cam force-refresh cycle.
   *  Mirrors the reference's `batteryUpdateTimer`: fires every hour,
   *  passively checks sleep state, and short-circuits if sleeping. */
  private batteryUpdateTimer: ReturnType<typeof setInterval> | null = null
  /** Single-flight gate so two interval fires can't overlap. */

  /** Aux accessory references registered by spawned children
   *  (siren / floodlight / pir). The parent's centralised align
   *  method iterates these to refresh their slices on a single
   *  cadence — replaces the old per-accessory setInterval. */
  private readonly auxAccessoryRefs = new Map<
    string,
    import('./accessories/base.js').ReolinkAccessoryRef
  >()
  /**
   * Reliability watchdogs (Slice 10). Both timers are armed after a
   * successful login (`ensureApi` / `adoptApi`) and torn down on
   * `disconnectAll` / `removeDevice`.
   *
   * - `pingWatchdogTimer` — every 30s `api.ping()`s the live socket;
   *   3 consecutive failures tear down the api so the next demand
   *   triggers a fresh login (recovers from D2C_DISC / ECONNRESET
   *   storms that would otherwise leave a half-open socket).
   * - `eventWatchdogTimer` — every 60s checks how long since the last
   *   simple event; 10 minutes silent → unsubscribe + resubscribe
   *   (plugin-level fallback to the library's own watchdog).
   */
  private pingWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private consecutivePingFailures = 0
  private eventWatchdogTimer: ReturnType<typeof setInterval> | null = null
  /** Wall-clock ms when the most-recent simple event arrived; 0 = none yet. */
  private lastEventAt = 0
  /** Wall-clock ms when the watchdogs first armed (used as the no-event baseline). */
  private watchdogStartedAt = 0
  /** True once we've registered the battery capability provider. */
  private batteryRegistered = false
  /**
   * Cam-stream ids we've materialized a resolved rfc4571 URL for on the
   * broker (via `materializeStreamSocket` → `publishOne`). Used by
   * `removeDevice` to retract them exhaustively (instead of guessing
   * from a synthetic id list).
   */
  private readonly publishedStreamIds = new Set<string>()
  /**
   * Transient diagnostics for the device's "Sessions" settings tab.
   * `null` until the first refresh completes. Re-populated ONLY by
   * `refreshSessionsSnapshot()` triggered by the operator clicking
   * the tab's Refresh button (`_refreshSessions` sentinel patch in
   * `applySettingsPatch`). The earlier auto-fetch on stale was
   * removed because `getOnlineUserList` (cmd 120) wakes a sleeping
   * battery cam — and the Settings panel polls every ~2.5s, which
   * was keeping the doorbell awake just by leaving the tab open.
   */
  private sessionsSnapshot: SessionsSnapshot | null = null
  /** Single-flight guard so concurrent reads share one round-trip. */
  private sessionsRefreshInFlight: Promise<void> | null = null
  // Snapshot caching, rate-limiting, and sleep-aware fallback live in the
  // builtin `snapshot.addon.ts` wrapper (`packages/system/src/builtins/
  // snapshot`). Its gate reads the device's `battery` runtime-state slice —
  // which exists because `registerBatteryIfSupported` registers the native cap
  // (and therefore the slice schema) for every battery-flagged device. The
  // provider here only exposes a raw JPEG fetch — no duplication of cache or
  // rate-limit logic at the device level.

  constructor(ctx: DeviceContext) {
    super(ctx, reolinkCameraSchema, { type: DeviceType.Camera })
    // BaseDevice constructor seeds `device-status` slice with online=false;
    // no need to re-set here.
    this.registerNativeCapabilities()
  }

  /**
   * Resolved Baichuan channel for per-channel cmd_ids. Children
   * under a Hub carry their channel in the persisted config (set
   * during `adoptDevice`). Standalone cameras default to 0 so the
   * pre-Hub behavior is preserved verbatim.
   */
  /**
   * Which preset `goHome` targets, and who decided it.
   *
   * Baichuan names no home of its own, so the operator's pick is the only
   * answer there can be. With none, `none` -- and `goHome` refuses rather than
   * moving the head to whatever happens to sit in slot 0.
   */
  private async resolveHomePreset(): Promise<PtzHomePreset> {
    // The operator's explicit pick always wins over the camera's own idea.
    const chosen = this.config.get('homePresetId') ?? ''
    if (chosen !== '') return { presetId: chosen, source: 'operator' }
    // Reolink DOES have a native home: the guard point ("punto di
    // monitoraggio"), which the camera both returns to on its own and can be
    // sent to on command. nodelink declares the ability leaf and never mapped
    // the commands, which is why this looked for months like a vendor with no
    // home at all.
    const guard = await this.readGuardStatus()
    if (guard?.valid === true) return { presetId: null, source: 'native' }
    return { presetId: null, source: 'none' }
  }

  /**
   * The camera's guard-point configuration, or `null` when it cannot be read.
   *
   * Never a fabricated "no guard configured": that answer decides whether
   * `goHome` moves the head, and an unreadable camera is not evidence that no
   * guard point exists (D393).
   */
  private async readGuardStatus(): Promise<PtzGuardStatus | null> {
    try {
      const api = await this.ensureApi()
      const channel = this.getChannel()
      return await api.getPtzGuard(channel)
    } catch (err) {
      this.ctx.logger.warn('reolink guard point unreadable — goHome will fall back', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private getChannel(): number {
    const ch = this.config.get('channel')
    if (typeof ch === 'number' && ch >= 0) return ch
    return DEFAULT_CHANNEL
  }

  /**
   * `true` iff this camera is a child of a Hub. Drives the
   * connection delegation in `ensureApi` and gates the standalone
   * lifecycle (own subscription, watchdog, reconnect loop). The
   * persisted `channel` field is the discriminator — adoption sets
   * it; standalone autodetect never touches it.
   */
  private isHubChild(): boolean {
    return this.parentDeviceId !== null && typeof this.config.get('channel') === 'number'
  }

  /**
   * `true` iff this camera can run its own email/SMTP push path. Hub
   * children are excluded: they share the parent's TCP socket and have
   * no independent email config, so the NVR/Hub handles email centrally.
   * Consumed by the provider-level SMTP intake (`email-push-server.ts`)
   * to decide which cameras accept inbound mail + can be auto-configured.
   */
  get isEmailPushEligible(): boolean {
    return !this.isHubChild()
  }

  /**
   * Baichuan channel to stamp on email-push-derived simple events.
   * Standalone cameras are channel 0; the accessor mirrors
   * `getChannel()` for the email-push module which has no access to
   * the private helper.
   */
  get emailPushChannel(): number {
    return this.getChannel()
  }

  /**
   * Resolve the parent Hub via the addon's device manager. Cached
   * lazily — the lookup is async but cheap, and the parent device
   * doesn't change over the camera's lifetime. Returns `null` for
   * standalone cameras.
   */
  private async getParentHub(): Promise<ReolinkHubLike | null> {
    if (!this.isHubChild()) return null
    if (this.cachedParentHub !== undefined) return this.cachedParentHub
    const all = await this.ctx.devices.getAll()
    const parent = all.find((d: { id: number }) => d.id === this.parentDeviceId)
    this.cachedParentHub = isHubLike(parent) ? parent : null
    return this.cachedParentHub
  }
  private cachedParentHub: ReolinkHubLike | null | undefined = undefined

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Phase 3 (kernel-driven) — populate the `feature-probe` runtime
   * state slice. Runs ONCE after `register` and BEFORE
   * `getAccessoryChildren()`, so siren / floodlight / PIR accessory
   * spawn sees the post-probe firmware truth. Failures are swallowed
   * (transient login race / battery cam asleep); next `reprobe()` call
   * retries.
   */
  override async onProbe(): Promise<void> {
    // Battery cam sleep gate (D173). `ensureApi()` on a sleeping UDP battery
    // camera IS a wake — and this method is not a one-shot: the kernel
    // re-runs it on every addon restart AND retries it on the boot-recovery
    // backoff (`device-cap-proxy.ts` → `BOOT_RECOVERY_BACKOFF_MS`: 15s, 60s,
    // 5m, 15m, 30m, 60m, 90m) until the `feature-probe` slice is seeded. A
    // camera that is asleep at boot therefore paid up to seven logins in the
    // first three hours, each one a wake, none of them asked for by anybody.
    //
    // Gating here is only safe because `isBattery` no longer depends on this
    // probe: it is set in the constructor from `deviceCache.deviceType` /
    // `hasBattery`, and `sleeping` reads the RESTORED `battery` slice — both
    // are already true before the first probe attempt. The probe is re-run
    // for free by `onWakeTransition` the next time the camera comes up on its
    // own, which is the only moment it costs nothing.
    if (this.isBattery && this.sleeping) {
      this.ctx.logger.info('onProbe skipped — battery cam is sleeping (no login, no wake)', {
        tags: { deviceId: this.id },
        meta: { probeRetriesAvoided: true },
      })
      return
    }
    let api: ReolinkBaichuanApi
    try {
      api = await this.ensureApi()
    } catch (err) {
      this.ctx.logger.debug('onProbe: ensureApi failed — leaving feature-probe slice unseeded', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    await this.probeAndPersistFeatures(api)
    // Hardware metadata refresh — runs once per kernel-driven probe
    // (every addon startup / restart). Covers BOTH top-level cameras
    // and hub-adopted children: the latter's `ensureApi()` short-
    // circuits to the parent hub's socket so the metadata refresh
    // wired into `ensureApi`'s post-login branch never fires for them.
    // Doing it here at the lifecycle entry point makes the refresh
    // contract uniform across both paths.
    await this.populateMetadataFromFirmware(api).catch((err: unknown) => {
      this.ctx.logger.debug('Reolink metadata populate (onProbe) failed (non-fatal)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    await this.refreshNetworkLinkFromApi(api, 'probe')
  }

  /**
   * Register the `network-link` cap: the read path serves the slice, the
   * writers are {@link refreshNetworkLinkFromApi}. Seeded unknown so the
   * restored slice (if any) stays valid and a fresh device draws no link.
   */
  /**
   * The native `motion` cap. This provider writes NO `motion` slice (D696):
   * `handleSimpleEvent` emits its raw push as `ProviderMotion` (`source:
   * 'onboard'`, D673), the orchestrator's camera-sensors bridge turns it into
   * the effective `MotionOnMotionChanged`, and the orchestrator is the slice's
   * only writer, with that effective value, on the hub. `isDetected` AND
   * `getStatus` therefore answer from the HUB's slice
   * (`hubMotionNativeProvider`); an unreadable hub fails both. Never `false`
   * for "unknown" (D49, D393).
   */
  private registerMotionCap(): void {
    const motionProvider = hubMotionNativeProvider(
      this.ctx.api.deviceState,
      this.id,
      'ReolinkCamera',
    )
    this.ctx.registerNativeCap(motionCapability, motionProvider)
  }

  private registerNetworkLink(): void {
    const provider: InferNativeProvider<typeof networkLinkCapability> = {
      getStatus: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        return this.state.networkLink
      },
    }
    this.ctx.registerNativeCap(networkLinkCapability, provider)
    if (this.getCapSlice(networkLinkCapability) === null) {
      this.setCapSlice(networkLinkCapability, NETWORK_LINK_UNKNOWN)
    }
  }

  /**
   * `osd` device cap — channel name is writable (short firmware limit);
   * time / watermark stay firmware-owned (`readOnly` on the overlay).
   *
   * Reads answer from the persisted `osdSnapshot` (filled by the getOsd
   * probe). A live getOsd here would wake battery cams on every OSD-manager
   * poll. Writes go through `setOsd` and re-read into the same snapshot so
   * intent is never stamped as fact (D224).
   */
  private registerOsdCap(): void {
    const provider: InferNativeProvider<typeof osdCapability> = {
      getStatus: async ({ deviceId }): Promise<OsdStatus> => {
        if (deviceId !== this.id) {
          throw new Error(
            `ReolinkCamera: osd deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        return osdStatusFromSnapshot(this.config.get('deviceCache')?.osdSnapshot)
      },
      setOverlay: async ({ deviceId, overlayId, patch }) => {
        if (deviceId !== this.id) return
        const osdPatch = buildOsdCapOverlayPatch(overlayId, {
          ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
          ...(typeof patch.text === 'string' ? { text: patch.text } : {}),
          ...(typeof patch.position === 'string' ? { position: patch.position } : {}),
        })
        if (osdPatch === null) return
        const api = await this.ensureApi()
        await api.setOsd(this.getChannel(), osdPatch)
        try {
          const osd = await api.getOsd(this.getChannel(), { timeoutMs: 4000 })
          const snapshot = projectOsdSnapshot(osd, Date.now())
          const previous = this.config.get('deviceCache') ?? {}
          await this.config.setAll({ deviceCache: { ...previous, osdSnapshot: snapshot } })
        } catch (err) {
          this.ctx.logger.info('reolink osd setOverlay: post-write re-read failed', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      },
    }
    this.ctx.registerNativeCap(osdCapability, provider)
  }

  /**
   * Read the active link and, on a wireless one, its signal and network name
   * over a socket that is ALREADY up. Called post-login and after a
   * successful battery read — never on its own timer, so a sleeping battery
   * camera is never woken for a bar count. Each read is best-effort with its
   * own bound; a failure keeps the last slice and says so at debug level.
   */
  private async refreshNetworkLinkFromApi(
    api: ReolinkBaichuanApi,
    reason: 'probe' | 'battery',
  ): Promise<void> {
    const channel = this.getChannel()
    const timeoutMs = ReolinkCamera.NETWORK_LINK_READ_TIMEOUT_MS
    try {
      const info = await api.getNetworkInfo(channel, { timeoutMs })
      const activeLink = info?.activeLink
      // A signal read is asked only of a link that can have one — or of a
      // camera whose firmware gave no label at all, where a wifi answer is
      // the only way to learn the link.
      const askWireless = activeLink === undefined || isWirelessLabel(activeLink)
      const wifiSignal = askWireless
        ? (await api.getWifiSignal(channel, { timeoutMs }).catch(() => ({ signal: undefined })))
            .signal
        : undefined
      // The SSID is what tells a joined wifi link from a wired camera that
      // still answers a signal number (an E1 Outdoor PoE answered -10 with
      // no SSID), so it is asked whenever the signal was.
      const ssid =
        askWireless && wifiSignal !== undefined
          ? (await api.getWifi(channel, { timeoutMs }).catch(() => ({ ssid: undefined }))).ssid
          : undefined
      const mapped = mapNetworkReadout({ activeLink, wifiSignal, ssid }, Date.now())
      // The first read per device (and any change of link) is said at INFO
      // with the RAW values: the wifi signal's scale is undocumented and only
      // real firmwares can settle it — a wrong scale must show as a number.
      const previous = this.state.networkLink
      const changed = previous.type !== mapped.type || !this.networkLinkReported
      this.ctx.logger[changed ? 'info' : 'debug']('network link read', {
        tags: { deviceId: this.id },
        meta: { reason, activeLink, rawSignal: wifiSignal, ...mapped },
      })
      this.networkLinkReported = true
      this.setCapSlice(networkLinkCapability, mapped)
    } catch (err) {
      // Once per device at WARN — a camera that never answers is a fact worth
      // one line; every retry after that is noise.
      const level = this.networkLinkFailureWarned ? 'debug' : 'warn'
      this.networkLinkFailureWarned = true
      this.ctx.logger[level]('network link read failed — keeping the last slice', {
        tags: { deviceId: this.id },
        meta: { reason, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Phase 5 (kernel-driven) — fired after `onProbe()` + accessory
   * reconciliation. The stream catalog is no longer pushed here: the
   * stream-broker PULLS each camera's `stream-catalog` cap (see
   * `registerStreamCatalogProvider`), so activation only refreshes the
   * parent settings snapshot. Skipped when the device is soft-disabled.
   */
  override async onActivate(): Promise<void> {
    if (this.disabled) {
      this.ctx.logger.info('Reolink camera disabled — skipping activation snapshot')
      return
    }
    // Best-effort image + motion snapshot for the parent settings
    // tabs. Each lib call is gated on a live Baichuan login; failure
    // (camera offline / 4xx) leaves the snapshot empty and the form
    // hydrates from defaults.
    void this.refreshParentSettingsSnapshot()
  }

  /** Debounce timestamp for the on-demand snapshot retry kicked from
   *  `getSettingsUISchema`. Prevents the form open from spamming
   *  refresh calls on incomplete caches (battery cam still sleeping,
   *  legacy firmware that doesn't support some endpoints). */
  private lastSettingsSnapshotRetryAt = 0
  private static readonly SETTINGS_SNAPSHOT_RETRY_MIN_MS = 60_000

  /** Debounce timestamp for the OSD serve-and-revalidate kick from
   *  `getSettingsUISchema` (D224). Separate from
   *  `lastSettingsSnapshotRetryAt` so an incomplete-cache retry and an
   *  OSD staleness revalidate never suppress each other. */
  private lastOsdRevalidateKickAt = 0

  /** True when any settings-snapshot field that drives a UI section
   *  is missing from the persisted cache. Drives the on-demand retry
   *  in `getSettingsUISchema`. */
  private hasIncompleteSettingsCache(): boolean {
    const cache = this.config.get('deviceCache')
    if (!cache) return true
    return (
      cache.encSnapshot === undefined ||
      cache.encOptionsSnapshot === undefined ||
      cache.maskSnapshot === undefined ||
      cache.audioNoiseSnapshot === undefined ||
      cache.autoFocusSnapshot === undefined
    )
  }

  /**
   * Probe the parent-settings endpoints (`getVideoInput`, `getMotionAlarm`,
   * `getOsd`, …) and persist into the `deviceCache` snapshots. Runs on
   * activation, on battery wake transitions, after a settings save (scoped
   * to the changed slices), via the manual "Refresh from camera" action,
   * and from `getSettingsUISchema`'s serve-and-revalidate kicks — settings
   * opens serve the persisted snapshot immediately and revalidate stale
   * slices behind the form (D224). Image is readonly in the UI (lib lacks
   * `setVideoInput`); motion is writable via `setMotionAlarm` so its
   * snapshot also drives the dispatch's known-good baseline.
   */
  private async refreshParentSettingsSnapshot(
    slices?: ReadonlySet<SnapshotSlice>,
    reason: SettingsRefreshReason = 'background',
  ): Promise<void> {
    // Battery cam sleep gate — refusing to call `ensureApi()` while
    // the cam is asleep is the difference between observing the
    // natural wake/idle cycle and forcibly waking it ourselves. Login
    // on a sleeping UDP/battery cam is itself a wake event (the lib's
    // discovery + handshake flow nudges the cam awake), so a settings
    // probe on a known-sleeping cam triggers the exact "wake → fetch
    // → fail-some-probes → idle_disconnect → reconnect 25s later"
    // loop seen on the doorbell. The wake-transition path
    // (`handleSimpleEvent('awake')` → `onWakeTransition`) re-runs
    // this method as soon as the cam comes up naturally.
    // A POST-WRITE re-read is never gated. The write that just ran used the
    // socket; a mirror saying "asleep" is OLDER evidence than the write
    // itself, and letting it decide is what served the operator the
    // pre-write snapshot on device 3825 (logged `skipped` at 12:49:32.683
    // and 12:51:02.777 on 2026-09-19, both immediately after a save). Note
    // this does NOT commit `sleeping: false` — on a hub child a successful
    // NVR write is not evidence the camera is awake.
    if (this.isBattery && this.sleeping && reason !== 'post-write' && reason !== 'scheduled') {
      // Info, not debug: every settings snapshot the operator is served
      // after this line is a pre-sleep reading, and a silent skip makes
      // stale look current. One line per refresh attempt (attempts are
      // event-driven — activation, wake, settings open, post-save — never
      // a poll), tagged so it can be grouped per camera.
      this.ctx.logger.info('refreshParentSettingsSnapshot skipped — battery cam is sleeping', {
        tags: { deviceId: this.id, reason },
      })
      return
    }
    let api: ReolinkBaichuanApi
    try {
      api = await this.ensureApi()
    } catch {
      return
    }
    const channel = this.getChannel()
    const cacheUpdate: Record<string, unknown> = {}
    const want = (slice: SnapshotSlice): boolean => slices === undefined || slices.has(slice)
    if (want('image')) {
      try {
        const video = await api.getVideoInput(channel)
        const vi = video?.body?.VideoInput
        if (vi) {
          cacheUpdate.imageSnapshot = {
            bright: typeof vi.bright === 'number' ? vi.bright : null,
            contrast: typeof vi.contrast === 'number' ? vi.contrast : null,
            saturation: typeof vi.saturation === 'number' ? vi.saturation : null,
            hue: typeof vi.hue === 'number' ? vi.hue : null,
            irCutSwap: typeof vi.irCutSwap === 'number' ? vi.irCutSwap : null,
            dayNight: typeof vi.dayNight === 'string' ? vi.dayNight : undefined,
          }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getVideoInput probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    if (want('motion')) {
      try {
        const motion = await api.getMotionAlarm(channel)
        const md = motion?.body?.MdAlarm?.sensInfoNew
        if (md) {
          // The camera-side `sensitivity` in MdAlarm is the INVERSE
          // of the user-facing slider (Reolink mobile app + web UI
          // show 1..50; camera stores `51 - userValue`). Same as
          // reolink_aio's `set_md_sensitivity` comment. Convert
          // here so the UI slider and the persisted field always
          // hold the user-facing value.
          const rawSens = typeof md.sensitivity === 'number' ? md.sensitivity : null
          cacheUpdate.motionSnapshot = {
            enabled: md.enable === 1,
            sensitivity: rawSens != null ? 51 - rawSens : null,
          }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getMotionAlarm probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Per-AI-class sensitivity snapshot. Probes the supported
    // detect types via `getAiDetectTypes` once, then fans out
    // `getAiDetectionFull` per type (cmdId=342, typed `AiDetectCfgZone`)
    // to read the current sensitivity, stayTime AND min/max target-size
    // gates. Each call is scoped so one missing type doesn't take down
    // the whole probe.
    if (want('ai')) {
      try {
        const detectTypes = await api.getAiDetectTypes(channel, { timeoutMs: 1500 })
        if (detectTypes && detectTypes.length > 0) {
          cacheUpdate.aiDetectTypes = detectTypes
          const aiSnap: Record<
            string,
            {
              sensitivity?: number | null
              stayTime?: number | null
              minTargetWidth?: number | null
              minTargetHeight?: number | null
              maxTargetWidth?: number | null
              maxTargetHeight?: number | null
            }
          > = {}
          for (const aiType of detectTypes) {
            try {
              const cfg: AiDetectCfgZone = await api.getAiDetectionFull(channel, aiType)
              aiSnap[aiType] = {
                sensitivity: typeof cfg.sensitivity === 'number' ? cfg.sensitivity : null,
                stayTime: typeof cfg.stayTime === 'number' ? cfg.stayTime : null,
                minTargetWidth: typeof cfg.minTargetWidth === 'number' ? cfg.minTargetWidth : null,
                minTargetHeight:
                  typeof cfg.minTargetHeight === 'number' ? cfg.minTargetHeight : null,
                maxTargetWidth: typeof cfg.maxTargetWidth === 'number' ? cfg.maxTargetWidth : null,
                maxTargetHeight:
                  typeof cfg.maxTargetHeight === 'number' ? cfg.maxTargetHeight : null,
              }
            } catch {
              // Type not actually supported on this firmware — skip.
            }
          }
          if (Object.keys(aiSnap).length > 0) cacheUpdate.aiSensitivitySnapshot = aiSnap
        }
      } catch (err) {
        this.ctx.logger.debug('reolink AI sensitivity probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    if (want('enc')) {
      // Stream/Encoder snapshot (cmd_id 56). Drives Stream tab
      // defaults so the operator sees current bitrate/framerate
      // when first opening the form.
      //
      // Wire shape (verified live): `{body: {Compression: {channelId,
      // mainStream, subStream, thirdStream, ...}}}`. Each stream entry
      // carries `audio` (0/1), `width`, `height`, `frame` (NOT
      // `frameRate`), `bitRate`, `videoEncType` (0=h264, 1=h265),
      // `encoderProfile`, `gop`. The `audio` toggle is per-stream,
      // not a root-level flag — we read it from `mainStream` since
      // that's the canonical capture stream.
      try {
        const enc = await api.getEnc(channel)
        const compression = enc?.body?.Compression
        if (compression) {
          const pickStream = (
            s?: NonNullable<typeof compression.mainStream>,
          ):
            | {
                bitRate: number | null
                frameRate: number | null
                videoEncType: string | null
                width: number | null
                height: number | null
                gop?: number | null
              }
            | undefined => {
            if (!s) return undefined
            // `videoEncType` is a numeric enum on Reolink Baichuan
            // (0 = h264, 1 = h265). Map to the lowercase strings the
            // UI labels expect.
            let codec: string | null = null
            if (typeof s.videoEncType === 'number') {
              codec = s.videoEncType === 1 ? 'h265' : 'h264'
            } else if (typeof s.videoEncType === 'string') {
              codec = s.videoEncType
            }
            return {
              bitRate: typeof s.bitRate === 'number' ? s.bitRate : null,
              // Wire field is `frame`, not `frameRate`.
              frameRate: typeof s.frame === 'number' ? s.frame : null,
              videoEncType: codec,
              width: typeof s.width === 'number' ? s.width : null,
              height: typeof s.height === 'number' ? s.height : null,
            }
          }
          const mainStream = pickStream(compression.mainStream)
          const subStream = pickStream(compression.subStream)
          // Keyframe interval (GOP) only on the main stream — the wire
          // carries it as `<gop><cur>` (an object `{cur,max,min}`), so
          // narrow to the `cur` number. Schema only holds gop on
          // `mainStream`; sub/third are owned by the `stream-params` cap.
          if (mainStream) {
            const mainGop = compression.mainStream?.gop
            mainStream.gop = typeof mainGop?.cur === 'number' ? mainGop.cur : null
          }
          // Audio capture flag is per-stream on this firmware (carried on
          // each `mainStream` / `subStream` entry rather than at the
          // Compression root). Treat the main stream's flag as the
          // device-level toggle for the Settings UI.
          const audioFlag =
            typeof compression.mainStream?.audio === 'number' ? compression.mainStream.audio : null
          cacheUpdate.encSnapshot = {
            audio: audioFlag,
            mainStream,
            subStream,
          }
        } else {
          this.ctx.logger.warn(
            'reolink getEnc returned no Compression block — Streams tab will hide',
            {
              tags: { deviceId: this.id },
            },
          )
        }
      } catch (err) {
        this.ctx.logger.warn('reolink getEnc probe failed — Streams tab will hide', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }

      // Encoder OPTION lists (`getEncOptions`). Persisted so the
      // editable Stream section in `getSettingsUISchema()` can render
      // the resolution / codec / framerate / bitrate selects
      // synchronously. Uses the SAME `probeStreamParamsOptions` helper
      // that backs the `stream-params` cap's `getOptions` — one
      // `getEncOptions` round-trip + mapping, two surfaces.
      const encOptions = await this.probeStreamParamsOptions()
      if (Object.keys(encOptions).length > 0) {
        cacheUpdate.encOptionsSnapshot = encOptions
      }
    }

    // Privacy mask snapshot (cmd_id 52). Master enable only.
    if (want('mask')) {
      try {
        const mask = await api.getMask(channel)
        const m = mask?.body?.Shelter
        if (m) {
          cacheUpdate.maskSnapshot = {
            enabled: typeof m.enable === 'number' ? m.enable === 1 : null,
          }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getMask probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Audio noise reduction snapshot (cmd_id 439). Drives the
    // Audio noise slider default — camera reports current level.
    // Wire tag is lowercase `aiDenoise` (cf. types `AudioNoiseConfig`).
    if (want('audioNoise')) {
      try {
        const noise = await api.getAudioNoise(channel)
        const n = noise?.body?.aiDenoise
        if (n) {
          cacheUpdate.audioNoiseSnapshot = {
            enabled: typeof n.enable === 'number' ? n.enable === 1 : null,
            level: typeof n.level === 'number' ? n.level : null,
          }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getAudioNoise probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    if (want('autofocus')) {
      // Auto-focus snapshot (cmd_id 224). Failure marks
      // `supported=false` so the UI section is hidden on cams
      // without focus controls. The camera-side field is `disable`
      // — invert here so the snapshot stores user-facing
      // "enabled" semantics.
      //
      // Sticky-skip: once a probe attempt has resolved `supported=false`
      // (fixed-focus cams like doorbells / battery bullets always 400
      // on cmd 224), don't re-issue the call on every wake. The snapshot
      // is already correct, the firmware behaviour won't change without
      // a model swap, and the firmware-400 stamp re-emits a debug log
      // every cycle. Cams that may have AF added by future firmware
      // would need an explicit re-probe trigger anyway.
      const afPrev = this.config.get('deviceCache')?.autoFocusSnapshot
      if (afPrev?.supported === false) {
        this.ctx.logger.debug(
          'reolink getAutoFocus probe skipped — cam advertised supported=false on prior probe',
          {
            tags: { deviceId: this.id },
          },
        )
      } else {
        try {
          const af = await api.getAutoFocus(channel, { timeoutMs: 1500 })
          const a = af?.body?.AutoFocus
          if (a) {
            cacheUpdate.autoFocusSnapshot = {
              enabled: typeof a.disable === 'number' ? a.disable === 0 : null,
              supported: true,
            }
          }
        } catch (err) {
          this.ctx.logger.debug('reolink getAutoFocus probe failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          // Persist `supported=false` on the FIRST probe failure so
          // future calls take the sticky-skip path above. The previous
          // value is preserved on subsequent transient failures.
          if (!afPrev) {
            cacheUpdate.autoFocusSnapshot = { enabled: null, supported: false }
          }
        }
      }
    }

    // Network service ports snapshot (cmd_id 37). Drives the Network
    // ports section's hydrated defaults. `getNetPort` returns lowercased
    // proto keys, each with a `<proto>port` number + an `enable` flag.
    if (want('netPort')) {
      try {
        const ports = await api.getNetPort()
        const snap = parseNetPortSnapshot(ports)
        if (Object.keys(snap).length > 0) cacheUpdate.netPortSnapshot = snap
      } catch (err) {
        this.ctx.logger.debug('reolink getNetPort probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // NTP / time-sync snapshot (cmd_id 38 via getNtp). Drives the
    // Time / NTP section's hydrated defaults — mirror the `getNetPort`
    // block above. `NtpConfig.enable` is a 0|1 int; the form key is a
    // boolean, and the sync interval is `synchronizeInterval` minutes.
    if (want('ntp')) {
      try {
        const ntp = await api.getNtp()
        cacheUpdate.ntpSnapshot = {
          enabled: ntp.enable === 1,
          server: ntp.server,
          port: ntp.port,
          interval: ntp.synchronizeInterval,
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getNtp probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // SystemGeneral snapshot (cmd_id 104 via getSystemGeneral). We only keep
    // the numeric `timeZone` offset — it SEEDS the Timezone picker from the
    // camera's current zone when the operator hasn't explicitly chosen one.
    if (want('systemGeneral')) {
      try {
        const sysGeneral = await api.getSystemGeneral()
        if (typeof sysGeneral.timeZone === 'number') {
          cacheUpdate.systemGeneralSnapshot = { timeZone: sysGeneral.timeZone }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getSystemGeneral probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // OSD overlay snapshot (cmd_id 44). Drives the "OSD overlay" section
    // defaults.
    //
    // `getOsd` is the OSD read again as of `@apocaliss92/nodelink-js` 0.7.0.
    // Before that it was a placeholder: it issued cmd_id 26 (GetImage - the
    // ISP block) and text-grepped the reply for `enable` / `name` / `pos` /
    // `timeEnable` / `watermark`, tags GetImage does not carry, so every
    // camera answered with the same fabricated tuple no matter what it held.
    // It now delegates to cmd_id 44 and returns the real `<OsdDatetime>` +
    // `<OsdChannelName>` overlays - including the anchors, which is what
    // makes the position control possible - with unreported fields `null`.
    if (want('osd')) {
      try {
        const osd = await api.getOsd(channel, { timeoutMs: 4000 })
        cacheUpdate.osdSnapshot = projectOsdSnapshot(osd, Date.now())
      } catch (err) {
        // Info, not debug: a miss here means the Settings UI keeps serving
        // the previous snapshot as if it were current - a dropped read must
        // be visible, per-camera.
        this.ctx.logger.info('reolink getOsd probe failed - OSD snapshot left stale', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Status + doorbell LED snapshot (cmd_id 208 via getIrLights). The
    // IR LED itself is already covered by the Image tab's IR section
    // (state/brightness). Here we read the separate `<lightState>`
    // (status/power LED) + `<doorbellLightState>` fields. The camera-
    // side strings are `open`/`close` (and friendly `On`/`Off`); treat
    // anything but an explicit closed/off value as enabled.
    // `doorbellAbility` (>0) gates the doorbell-LED toggle.
    if (want('led')) {
      try {
        const led = await api.getIrLights(channel)
        const ledState = led?.body?.LedState
        if (ledState) {
          const isOn = (v: unknown): boolean | null => {
            if (typeof v !== 'string') return null
            const norm = v.toLowerCase()
            if (norm === 'close' || norm === 'off') return false
            if (norm === 'open' || norm === 'on') return true
            return null
          }
          const doorbellRaw = Reflect.get(ledState, 'doorbellLightState')
          const doorbellAbilityRaw = Reflect.get(ledState, 'doorbellAbility')
          cacheUpdate.ledSnapshot = {
            statusEnabled: isOn(ledState.lightState),
            doorbellEnabled: isOn(doorbellRaw),
            doorbellSupported:
              typeof doorbellAbilityRaw === 'number'
                ? doorbellAbilityRaw > 0
                : typeof doorbellRaw === 'string',
          }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getIrLights (LED) probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // PIR reduce-false-alarm snapshot (cmd_id 212 via getPirInfo).
    // `getPirInfo` returns `{ enabled, state: { reduceAlarm, ... } }`;
    // we only surface the `reduceAlarm` toggle here (sensitivity /
    // interval live on the PIR accessory child). `supported=false`
    // when the camera carries no PIR state — gates the section.
    if (want('pir')) {
      try {
        const pir = await api.getPirInfo(channel)
        const reduceRaw = pir.state?.reduceAlarm
        if (pir.state) {
          cacheUpdate.pirSnapshot = {
            reduceFalseAlarm: typeof reduceRaw === 'number' ? reduceRaw === 1 : null,
            supported: true,
          }
        } else {
          cacheUpdate.pirSnapshot = { reduceFalseAlarm: null, supported: false }
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getPirInfo probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Auto-reboot schedule snapshot (cmd_id 101 via getAutoReboot).
    // Drives the Advanced tab's "Auto reboot" section defaults. Device-
    // global (no channel). `supported=false` on probe error so models
    // without a maintenance schedule hide the section.
    if (want('autoReboot')) {
      try {
        const reboot = await api.getAutoReboot()
        cacheUpdate.autoRebootSnapshot = {
          enabled: reboot.enable === 1,
          weekDay: reboot.weekDay,
          hour: typeof reboot.hour === 'number' ? reboot.hour : null,
          minute: typeof reboot.minute === 'number' ? reboot.minute : null,
          supported: true,
        }
      } catch (err) {
        this.ctx.logger.debug('reolink getAutoReboot probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        const rebootPrev = this.config.get('deviceCache')?.autoRebootSnapshot
        if (!rebootPrev) {
          cacheUpdate.autoRebootSnapshot = {
            enabled: null,
            hour: null,
            minute: null,
            supported: false,
          }
        }
      }
    }

    if (Object.keys(cacheUpdate).length === 0) return
    const current = this.config.get('deviceCache') ?? {}
    // Per-snapshot freshness (D224 generalised, D346): stamp exactly the
    // groups this pass actually WROTE — a probe that failed above never
    // reached `cacheUpdate`, so its group keeps its previous stamp and its
    // staleness stays visible. `aiDetectTypes` is a scalar rider, not a
    // snapshot group; the `*Snapshot` suffix is the group contract.
    const writtenSnapshotKeys = Object.keys(cacheUpdate).filter((k) => k.endsWith('Snapshot'))
    if (writtenSnapshotKeys.length > 0) {
      cacheUpdate.snapshotFetchedAt = stampSnapshotFreshness(
        current.snapshotFetchedAt,
        writtenSnapshotKeys,
        Date.now(),
      )
    }
    try {
      // NOTE: do NOT touch `probedAt` here. This helper persists
      // settings-tab snapshots (image, motion, AI, enc, mask,
      // audioNoise, AF) — none of which constitute the features
      // probe (`hasPtz` / `hasIntercom` / etc). Conflating the two
      // would lock out `ensureFeaturesProbed()` after the first
      // settings refresh and leave hub-children with empty feature
      // sets.
      await this.config.setAll({
        deviceCache: { ...current, ...cacheUpdate },
      })
    } catch (err) {
      this.ctx.logger.debug('reolink deviceCache snapshot persist failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Email/SMTP config — read on the SAME wake/refresh as every other
    // setting so the Email Push section shows the camera's current on-device
    // config without a dedicated "read from camera" button. Battery-cam +
    // email-push-eligible only (the section is hidden otherwise); persists its
    // own `emailConfigSnapshot` via `setAll`. Best-effort: a failure just
    // leaves the prior snapshot. The cam is awake here (caller gates on it).
    if (slices === undefined && this.isBattery && this.isEmailPushEligible) {
      await this.refreshCameraEmailConfig().catch((err: unknown) => {
        this.ctx.logger.debug('reolink email config probe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
  }

  /**
   * Admin-only raw-read debug surface (D346): return the library's response
   * for one snapshot slice UNPROJECTED, next to the persisted snapshot and
   * its freshness, so "what does the camera report vs what does CamStack
   * believe" is answerable without Baichuan tracing. Read-only by
   * construction (the slice enum maps onto an allow-list of lib `get*`
   * calls — see `raw-read.ts`), writes nothing back to the cache, and the
   * sleep gate runs BEFORE any login: a sleeping battery cam refuses loudly
   * (logging in IS the wake) and still reports the believed state.
   * Dispatched by the provider's `debugRawRead` custom action.
   */
  async debugRawRead(slice: RawReadSlice): Promise<RawReadResult> {
    return performRawRead(slice, {
      deviceId: this.id,
      channel: this.getChannel(),
      sleeping: this.isBattery && this.sleeping,
      // A hub child borrows the parent's mains-powered socket rather than
      // logging itself in — which is what lets the hub-answered `battery`
      // slice stay readable while the camera sleeps (see `raw-read.ts`,
      // `servedByParentHub`). A standalone camera gets no such exemption.
      hubChild: this.isHubChild(),
      // A focus motor is a PTZ camera's part — answered from the feature
      // probe this device already ran, never by asking the camera.
      hasPtz: this.getProbeFlags<ReolinkProbeFlags>().hasPtz === true,
      getApi: () => this.ensureApi(),
      cache: this.config.get('deviceCache'),
      // The battery belief has no deviceCache home: it IS the cap runtime
      // state `battery.getStatus` serves. `undefined` when nothing was ever
      // written — never the schema's `empty` seed, which reads as 0%.
      batteryState: this.runtimeState.getCapState('battery'),
      logger: this.ctx.logger,
      now: Date.now(),
    })
  }

  /**
   * Everything the CLIP path needs to know about this camera, in one object
   * resolved by the device itself.
   *
   * It lives here because every fact in it is the device's own and three of
   * them are dangerous to guess:
   *
   * - `getApi` is the ONE session. A hub child borrows the parent's
   *   mains-powered socket (`parent.getApi()` — `ensureApi` already delegates
   *   for a child), and the clip path constructs nothing: a second Baichuan
   *   session to this Home Hub produced 27 `ECONNRESET`s (D549 17).
   * - `sleeping` is the gate the provider evaluates BEFORE calling `getApi`.
   *   On a standalone UDP battery camera the login IS the wake, so a gate
   *   after it gates nothing.
   * - `uid` is the CHILD's uid, not the hub's. On a hub the uid is what
   *   selects the camera; the hub's own uid addresses no catalog at all
   *   (measured: empty month over 24 months, zero files, zero rows).
   *
   * `null` is never returned — a `ReolinkCamera` always has these — but the
   * provider still treats a missing `uid` as a dropped branch rather than as
   * an empty catalog.
   */
  /**
   * Re-read this camera's clip catalog. Set by the addon for every camera it
   * owns; `null` until it is wired (a redeploy re-registers the device, and
   * the addon re-wires on `DeviceRegistered` AND `DeviceMetaChanged` — the
   * same fan-out the email-push resolver needed, for the same reason).
   */
  private clipCatalogRefresher: (() => Promise<void>) | null = null

  setClipCatalogRefresher(refresh: () => Promise<void>): void {
    this.clipCatalogRefresher = refresh
  }

  /**
   * This camera's OVERRIDE of the clip-refresh interval, or `undefined` when
   * it overrides nothing — which is what a reset leaves behind too, and is
   * why the resolver takes `unknown` rather than a number (D562).
   */
  getClipCatalogRefreshMinutes(): unknown {
    return this.config.get('clipCatalogRefreshMinutes')
  }

  /** Whether the operator authorised the clip timer to wake this camera. */
  getClipCatalogForcedWake(): unknown {
    return this.config.get('clipCatalogForcedWake')
  }

  /**
   * The clip refresh the TIMER cannot do.
   *
   * On a standalone battery camera a catalog read is a login and a login is
   * the wake, so the periodic refresh only marks the catalog stale (D562).
   * This is the other half: the moment the camera confirmed itself awake for
   * its own reasons — a camera event, a stream, an operator action — is a free
   * read, and it is the same moment that already warms the stream catalog and
   * every settings slice. Called from `onWakeTransition`, best-effort, last:
   * a clip listing must never delay the live-stream catalog the operator is
   * waiting for.
   */
  private async refreshClipCatalogOnWake(): Promise<void> {
    const refresh = this.clipCatalogRefresher
    if (refresh === null) {
      this.ctx.logger.debug('onWakeTransition: no clip catalog refresher wired', {
        tags: { deviceId: this.id },
        meta: { branch: 'clip-refresher-unwired' },
      })
      return
    }
    try {
      await refresh()
    } catch (err: unknown) {
      // Never fatal to the wake fan-out, and never silent: a catalog that
      // stays old because this failed is a question somebody asks later.
      this.ctx.logger.warn('onWakeTransition: the clip catalog refresh failed', {
        tags: { deviceId: this.id },
        meta: {
          branch: 'clip-refresh-failed',
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  /**
   * Wake this camera because the OPERATOR authorised the clip timer to
   * (`clipCatalogForcedWake`, off by default — D562).
   *
   * The only path from the timer to a battery camera's radio, and it is the
   * same forced wake `wakeIfSleeping` already drives for a config button.
   * Throws when the camera did not come up, so the scheduler can say so and
   * leave the catalog stale rather than stamping it fresh.
   */
  async wakeForClipCatalogRefresh(): Promise<void> {
    const awake = await this.wakeIfSleeping()
    if (!awake) {
      throw new Error(
        `ReolinkCamera ${this.id}: the authorised clip-refresh wake did not bring the camera up`,
      )
    }
  }

  getClipDeviceRef(): ClipDeviceRef {
    const configUid = this.config.get('uid')
    return {
      deviceId: this.id,
      channel: this.getChannel(),
      // BOTH copies, because one of them is frozen at adoption and can be
      // empty for ever. 3825 held `9527000MSU931AUT` in its metadata and
      // answered `uid-missing` for want of this. The branded return type is
      // what stops a future reader reaching for one of them (D224).
      uid: resolveCameraUid({
        // Synchronous, from the meta the kernel already handed this device.
        // It was an RPC through `ctx.api.deviceManager.getDevice` until
        // 2026-09-21, wired into `onProbe` — and it returned `no-route` on
        // every camera: the generated router type says the call exists, the
        // addon's runtime `ctx.api` does not carry it. The type-vs-runtime
        // trap, on the server side. `ctx.deviceMeta` was one property away
        // the whole time.
        // `DeviceMetadata` is `Record<string, unknown>`, so the uid is
        // narrowed here rather than cast: a non-string is ABSENT, which is
        // what `resolveCameraUid` already means by it.
        metadataUid: metaUid(this.ctx.deviceMeta.metadata),
        configUid: typeof configUid === 'string' ? configUid : undefined,
      }),
      isHubChild: this.isHubChild(),
      isBattery: this.isBattery,
      sleeping: this.sleeping,
      // The camera's wall clock, NAMED rather than inherited. The container's
      // zone is the default because it is what the library would use anyway;
      // naming it is what makes the boot-time assert meaningful (D549 7).
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // A hub child's stills go through the HUB's host, which is what makes
      // one lane per hub the right bound: the hub refuses concurrent
      // CoverPreviews across its children, not per channel.
      hostKey: String(this.config.get('host') ?? `device-${this.id}`),
      getApi: () => this.ensureApi(),
    }
  }

  /**
   * Declare on-camera accessory child devices the kernel should
   * auto-spawn after `onCreated`. Each entry maps directly to a
   * concrete accessory class via the existing `createAccessoryDevice`
   * factory; the closure captures `this` for the child's
   * `(ctx, parent)` constructor — accessories share the parent's
   * Baichuan socket via `parent.ensureApi()`.
   *
   * Restoring an existing accessory is automatic: the kernel detects
   * the persisted row by the deterministic stableId and skips the
   * pre-persist step. Adding a new accessory between boots (operator
   * enabled `hasFloodlight` via re-detection) appears on the next
   * parent register.
   */
  override getAccessoryChildren(): readonly import('@camstack/types').AccessoryChildSpec[] {
    // Pre-probe → no accessory specs. Spawning before the firmware's
    // ability table is read (live slice OR persisted deviceCache) would
    // land orphans on a re-probe that drops a flag (e.g. a firmware
    // downgrade that removes siren).
    //
    // The fallback to the persisted `deviceCache` flags matters for
    // cameras whose live Baichuan probe is slow/flaky: they restore with
    // an empty `feature-probe` slice (`lastProbedAt === 0`) every boot,
    // so a slice-only gate would leave their persisted accessory rows
    // un-spawned — and therefore without the kernel-mounted `device-ops`
    // provider ("device-ops not registered for device N"). See
    // `accessory-probe-flags.ts` for the slice-vs-cache precedence.
    const kinds = accessoryKindsFor(
      this.hasProbed(),
      this.getProbeFlags<ReolinkProbeFlags>(),
      this.config.get('deviceCache'),
    )
    const out: import('@camstack/types').AccessoryChildSpec[] = []
    const push = (kind: AccessoryKindValue, type: DeviceType, label: string): void => {
      out.push({
        stableIdSuffix: `acc-${kind}`,
        meta: {
          type,
          name: `${this.name} ${label}`,
        },
        config: { kind, channel: 0 },
        factory: (ctx) => createAccessoryDevice(kind, ctx, this),
      })
    }
    if (kinds.includes(AccessoryKind.Siren))
      push(AccessoryKind.Siren, DeviceType.Siren, ACCESSORY_LABEL[AccessoryKind.Siren])
    if (kinds.includes(AccessoryKind.Floodlight))
      push(AccessoryKind.Floodlight, DeviceType.Light, ACCESSORY_LABEL[AccessoryKind.Floodlight])
    if (kinds.includes(AccessoryKind.PirSensor))
      push(AccessoryKind.PirSensor, DeviceType.Switch, ACCESSORY_LABEL[AccessoryKind.PirSensor])
    // Autotrack is NOT a child accessory — it's an extension of PTZ
    // exposed via the `ptz-autotrack` cap on the parent camera.
    return out
  }

  /**
   * Resolver injected by the provider (`setEmailPushParamsResolver`) so
   * the Auto-configure action can fetch the live manager-side SMTP
   * params (host/port/domain/credentials) without holding a direct
   * provider reference. `undefined` until the provider wires it.
   */
  private emailPushParamsResolver: EmailPushParamsResolver | undefined
  private baichuanWebhookParamsResolver: BaichuanWebhookParamsResolver | undefined
  /** Cached HaCfg probe — refreshed on Auto-configure / status refresh. */
  private baichuanWebhookSupportedCached: boolean | undefined

  /**
   * Provider hook: inject the manager-side email-push params resolver.
   * Called when the provider sees this camera (adopt / restore). Lets
   * the camera's `autoConfigureEmailPush` reach the provider-owned
   * addon settings + SMTP server config without a class-level coupling.
   */
  setEmailPushParamsResolver(resolver: EmailPushParamsResolver): void {
    this.emailPushParamsResolver = resolver
  }

  /**
   * Provider hook: inject the manager-side HaCfg webhook URL resolver.
   */
  setBaichuanWebhookParamsResolver(resolver: BaichuanWebhookParamsResolver): void {
    this.baichuanWebhookParamsResolver = resolver
  }

  /**
   * Wake a sleeping battery camera before an operator-initiated action
   * (proactive config buttons such as Auto-configure email push). A
   * sleeping battery cam ignores Baichuan config round-trips, so clicking
   * "configure" would otherwise silently fail; this drives the same forced
   * wake `wakeForStream` uses, then lets the caller proceed against a live
   * camera. No-op for non-battery or already-awake cams. Best-effort:
   * returns whether the camera is (now) reachable/awake.
   */
  private async wakeIfSleeping(timeoutMs = 15_000): Promise<boolean> {
    if (!this.isBattery || !this.sleeping) return true
    let api: ReolinkBaichuanApi
    try {
      api = await this.ensureApi()
    } catch {
      return false
    }
    // OPERATOR-driven: bypasses the proactive-wake cooldown by design
    // (they clicked something and expect it to reach the camera), but
    // still stamps it so a background wake doesn't pile on right after.
    this.markWakeIssued()
    this.ctx.logger.info('proactive action: waking sleeping battery cam', {
      tags: { deviceId: this.id },
      meta: { timeoutMs },
    })
    this.ctx.eventBus.emit(
      createEvent(EventCategory.BatteryOnWakeStarted, this.eventSource(), { deviceId: this.id }),
    )
    const channel = this.getChannel()
    try {
      await Promise.race([
        (async () => {
          await api.wakeUp(channel, { waitAfterWakeMs: 2500, attempts: 2 })
          await sleep(1500)
        })(),
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('wakeIfSleeping timeout')), timeoutMs),
        ),
      ])
      // What we tell the caller, we believe ourselves.
      //
      // This answers `true`, and everything downstream reads the MIRROR: the
      // broker's placeholder composes from the battery slice, so a camera
      // that woke but whose slice still says "sleeping" keeps showing the
      // sleeping tile. Measured 2026-09-19 21:29 — "Refresh from camera"
      // reported `awake=true` and re-read 5 of 5 slices off the camera, and
      // thirteen seconds later the broker was still composing
      // `reason=sleeping`. The same split `wakeForStream` had, in its
      // sibling, found by the operator noticing the picture never changed.
      if (this.commitSleepState(false, 'confirmed-wake')) {
        this.ctx.logger.info('proactive action: camera is up — committing the mirror', {
          tags: { deviceId: this.id },
        })
        void this.onWakeTransition('confirmed-wake').catch(() => {
          /* best-effort */
        })
      }
      return true
    } catch (err) {
      this.ctx.logger.warn('proactive action: wake did not complete in time', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
  }

  /**
   * Push the provider-level Email Push Server's manager-side SMTP config
   * down to THIS camera, so a battery camera sends a motion email to the
   * SMTP intake while asleep. Wired to the `_autoConfigureEmailPush`
   * action sentinel in `applySettingsPatch`.
   *
   * Manager-side host/port/domain/credentials live in the provider's
   * addon store; the provider resolves them via the injected
   * `emailPushParamsResolver`. We then drive the camera's Baichuan
   * `setEmail` / `setEmailTask` round-trip via `setupEmailPushToManager`.
   * The recipient is `cam-<stableId>@<domain>` — the exact value the
   * provider's `cameraResolver` matches when routing inbound mail.
   *
   * Hub-attached children throw: they share the parent's socket + the
   * NVR/Hub owns email centrally (see `isEmailPushEligible`).
   */
  async autoConfigureEmailPush(): Promise<void> {
    // Always log the click so the action is observable even when it
    // short-circuits below (the operator reported "nothing happens, not
    // even a log" — the early throws fired before any logging).
    this.ctx.logger.info('email-push: auto-configure requested', {
      tags: { deviceId: this.id },
      meta: {
        isBattery: this.isBattery,
        eligible: this.isEmailPushEligible,
        resolverWired: this.emailPushParamsResolver !== undefined,
      },
    })
    if (!this.isEmailPushEligible) {
      this.ctx.logger.warn('email-push: not eligible (hub-attached camera)', {
        tags: { deviceId: this.id },
      })
      throw userError(
        'reolink.email-push-hub-attached',
        undefined,
        'Email push is not available for hub-attached cameras',
      )
    }
    if (!this.emailPushParamsResolver) {
      this.ctx.logger.warn('email-push: resolver not wired — restart the Reolink addon', {
        tags: { deviceId: this.id },
      })
      throw userError(
        'reolink.email-push-not-wired',
        undefined,
        'Email Push Server is not wired — restart the Reolink addon',
      )
    }
    const params = await this.emailPushParamsResolver()
    if (!params) {
      this.ctx.logger.warn(
        'email-push: no manager params — enable the server + reachable LAN host',
        { tags: { deviceId: this.id } },
      )
      throw new Error(
        'Enable the Email Push Server in the Reolink addon settings, and ensure this host has a reachable LAN address.',
      )
    }

    const triggers = this.config.get('emailPushTriggers') ?? ['MD', 'people', 'vehicle']
    const attachmentType = this.config.get('emailPushAttachment') ?? 'picture'

    // Operator-initiated action on a battery cam: wake it first so the
    // Baichuan round-trip below reaches a live camera instead of failing
    // against a sleeping one. No-op for non-battery / already-awake cams.
    await this.wakeIfSleeping()

    const api = await this.ensureApi()
    this.ctx.logger.info('email-push: auto-configuring camera', {
      tags: { deviceId: this.id },
      meta: {
        managerHost: params.managerHost,
        port: params.managerPort,
        domain: params.domain,
        recipientLocalPart: params.recipientLocalPart,
      },
    })
    await api.setupEmailPushToManager(
      {
        managerHost: params.managerHost,
        managerPort: params.managerPort,
        domain: params.domain,
        recipientLocalPart: params.recipientLocalPart,
        sendNickname: this.name,
        attachmentType,
        triggerTypes: triggers,
        ...(params.authUsername !== undefined && params.authPassword !== undefined
          ? { authUsername: params.authUsername, authPassword: params.authPassword }
          : {}),
        runTest: false,
      },
      this.getChannel(),
    )
    this.ctx.logger.info('email-push: camera auto-configure applied', {
      tags: { deviceId: this.id },
    })
    // Re-read the camera's own config so the settings section reflects what we
    // just wrote (best-effort — the cam is awake here).
    await this.refreshCameraEmailConfig().catch(() => {
      /* best-effort */
    })
  }

  /**
   * Arm Baichuan HaCfg (cmd 807) so this battery camera POSTs wake/sleep
   * events to the provider's HTTP intake. Mirrors plugin catalog's
   * `autoConfigureBaichuanWebhook` — never called from init.
   */
  async autoConfigureBaichuanWebhook(): Promise<void> {
    this.ctx.logger.info('baichuan-webhook: auto-configure requested', {
      tags: { deviceId: this.id },
      meta: {
        isBattery: this.isBattery,
        eligible: this.isEmailPushEligible,
        resolverWired: this.baichuanWebhookParamsResolver !== undefined,
      },
    })
    if (!this.isBattery || !this.isEmailPushEligible) {
      this.ctx.logger.warn('baichuan-webhook: not eligible', {
        tags: { deviceId: this.id },
      })
      throw new Error(
        'HaCfg webhook Auto-configure is only available on standalone battery cameras',
      )
    }
    if (!this.baichuanWebhookParamsResolver) {
      throw userError(
        'reolink.webhook-not-wired',
        undefined,
        'HaCfg Webhook Server is not wired — restart the Reolink addon',
      )
    }
    const params = await this.baichuanWebhookParamsResolver()
    if (!params) {
      throw new Error(
        'Enable the HaCfg Webhook Server in the Reolink addon settings, and ensure this host has a reachable LAN address.',
      )
    }

    await this.wakeIfSleeping()
    const api = await this.ensureApi()
    const supported = await api.probeBaichuanWebhookSupport()
    this.baichuanWebhookSupportedCached = supported
    if (!supported) {
      throw userError(
        'reolink.webhook-unsupported',
        undefined,
        'Camera firmware does not support Baichuan HaCfg webhook (cmd 806)',
      )
    }

    this.ctx.logger.info('baichuan-webhook: auto-configuring camera', {
      tags: { deviceId: this.id },
      meta: { url: params.url },
    })
    await api.setupBaichuanWebhookToManager({
      url: params.url,
      verifyCert: params.verifyCert,
    })
    try {
      await api.subscribeEvents()
    } catch {
      /* best-effort — same as reolink_aio after SET */
    }
    this.ctx.logger.info('baichuan-webhook: camera auto-configure applied', {
      tags: { deviceId: this.id },
      meta: { url: params.url },
    })
  }

  /**
   * Read the camera's OWN email/SMTP config (`getEmail` cmd 42 + `getEmailTask`
   * cmd 216) and persist a snapshot into `deviceCache.emailConfigSnapshot` so
   * the Email Push settings section can show the camera's CURRENT mail config
   * synchronously. The read wakes a sleeping battery cam, so it is only
   * triggered on demand (the section's "Read from camera" button / after an
   * auto-configure), never automatically. Mirrors the manager app's Email
   * Push tab read.
   */
  async refreshCameraEmailConfig(): Promise<void> {
    await this.wakeIfSleeping()
    const api = await this.ensureApi()
    const channel = this.getChannel()
    const [email, task] = await Promise.all([
      api.getEmail(),
      api.getEmailTask(channel).catch(() => null),
    ])
    const recipients = [email.address1, email.address2, email.address3].filter((a) => a.length > 0)
    const current = this.config.get('deviceCache') ?? {}
    await this.config.setAll({
      deviceCache: {
        ...current,
        emailConfigSnapshot: {
          smtpServer: email.smtpServer,
          smtpPort: email.smtpPort,
          userName: email.userName,
          recipients,
          ssl: email.ssl === 1,
          attachmentType: email.attachmentType,
          sendNickname: email.sendNickname,
          ...(task ? { taskEnabled: task.enable === 1 } : {}),
          lastReadAt: Date.now(),
        },
        // Same instant as `lastReadAt` above — the generic per-snapshot
        // stamp map (D346) so the freshness panel reads every group the
        // same way.
        snapshotFetchedAt: stampSnapshotFreshness(
          current.snapshotFetchedAt,
          ['emailConfigSnapshot'],
          Date.now(),
        ),
      },
    })
    this.ctx.logger.info('email-push: read camera email config', {
      tags: { deviceId: this.id },
      meta: {
        smtpServer: email.smtpServer,
        smtpPort: email.smtpPort,
        recipients: recipients.length,
      },
    })
  }

  /**
   * Register per-device native capability providers (Slice 5+).
   * Currently exposes `snapshot` via the Baichuan getSnapshot command;
   * PTZ + intercom land in Slices 7 + 9 once we know the camera's
   * abilities (see `config.features`).
   */
  /**
   * Return this camera's RAW upstream state as a display-safe
   * `{ source:'reolink', data }` blob built from the CACHED runtime-state
   * slices (no camera round-trip). Credential-bearing fields are redacted.
   * `null` when no slice has been written yet.
   */
  async getRawState(): Promise<RawStateResult | null> {
    return buildRawState(this.runtimeState)
  }

  private registerNativeCapabilities(): void {
    const snapshotProvider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId, force }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        // `force` is carried all the way down: it is the operator signal and
        // the ONLY thing allowed to wake a sleeping battery camera
        // (`snapshot.cap.ts`). Dropping it here is what made a background
        // sentry read indistinguishable from a refresh button.
        return this.fetchSnapshotWithSingleFlight(force === true)
      },
      invalidateCache: async () => {
        // No local cache — the snapshot wrapper owns it.
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, snapshotProvider)

    // Reboot — Baichuan exposes `cmd_id 23` on every Reolink device, so
    // the cap is registered unconditionally. The lib forwards the
    // request and returns once the camera ACKs (camera goes offline
    // shortly after; the device-online indicator drives the UI state,
    // not this method's resolution).
    const rebootProvider: InferNativeProvider<typeof rebootCapability> = {
      reboot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const api = await this.ensureApi()
        await api.reboot(this.getChannel())
        return { success: true as const }
      },
    }
    this.ctx.registerNativeCap(rebootCapability, rebootProvider)

    // device-admin-link — the camera's own web console.
    //
    // ⚠ `config.port` is the BAICHUAN port (default 9000), NOT an HTTP port.
    // Verified on 592 (192.168.60.226) on 2026-09-22: `http://…:9000/` refuses
    // the connection outright, `http://…/` (port 80) answers 200 text/html.
    // Reolink has no per-device HTTPS flag either, so the scheme is the one
    // every unit ships with. Passing `port: null` here means "the scheme
    // default" — the alternative, reading the field that exists, produces a
    // button that opens a browser error.
    //
    // A UDP/battery camera adopted by `uid` has a blank `host`: that is a
    // device this provider knows has no reachable page, and it answers null.
    const adminLinkProvider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const host = this.config.get('host') ?? ''
        const built = buildDeviceAdminUrl({ host, port: null, scheme: 'http', path: '/' })
        if (!built.ok) {
          this.ctx.logger.debug('reolink admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason, transport: this.config.get('transport') ?? 'tcp' },
          })
          return null
        }
        return { url: built.url, label: 'Web UI', target: 'device' as const, host }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, adminLinkProvider)

    // OSD overlays (channel name writable for the OSD manager — short firmware
    // limit, but usable). Time / watermark stay read-only.
    this.registerOsdCap()

    // Network link — every Reolink device answers `getLocalLink`, so the cap
    // is registered unconditionally and seeded UNKNOWN (D315: not read yet is
    // not a wire). Real values land post-login and on every battery refresh,
    // both moments the camera is awake by construction — a link read must
    // never be the thing that wakes a battery camera.
    this.registerNetworkLink()

    // Motion — every Reolink camera has firmware motion (Baichuan push events).
    this.registerMotionCap()

    // Doorbell — registered only when the abilities probe flagged
    // `hasDoorbell`. Push events arrive via `handleSimpleEvent` and
    // emit on the cap event bus + bridge to `EventCategory.DoorbellOnPressed`.
    this.registerDoorbellIfSupported()

    // PTZ — registered only when abilities probe (Slice 4) discovered
    // PTZ support. On first boot before the probe completes, the
    // persisted `deviceCache` may be missing — in that case the
    // post-login `probeAndPersistFeatures()` will call
    // `registerPtzIfSupported()` to wire PTZ retroactively.
    this.registerPtzIfSupported()

    // Autotrack — sibling cap of PTZ, registered only when the
    // probe flagged `hasAutotrack`. Autotrack used to be a child
    // accessory device with a `switch` cap; it now lives on the
    // parent as a typed `ptz-autotrack` cap (status + settings) so
    // automations can address it directly without a child-device
    // lookup. Same retroactive-registration story as PTZ.
    this.registerPtzAutotrackIfSupported()

    // Intercom — registered only when the abilities probe flagged
    // `hasIntercom`. v0.1 ships the cap binding + the lib bridge layer
    // (PCM-in / ADPCM-out via `ReolinkIntercomSession`); the WebRTC
    // server-side path (Opus RTP receive + ffmpeg decode → PCM →
    // session.feedPcm) is scaffolded as a stub that throws
    // NotImplemented on `startSession`. Operators see the cap in the
    // bindings table and the `audioConfig` ability is reported via the
    // status surface; the actual mic-to-camera flow lands when the
    // werift audio session is wired in (planned next iteration).
    this.registerIntercomIfSupported()

    // Stream-params — exposes live stream configuration (resolution,
    // codec, framerate, bitrate, encoder profile, GOP) via the
    // `stream-params` cap so the UI can drive it via typed tRPC
    // mutations rather than the legacy settings-form blob.
    this.registerStreamParamsCap()

    // Email-push Auto-configure as a typed device custom action (dispatched by
    // the Motion-tab `device-action-button` via deviceManager.runDeviceAction).
    this.registerDeviceAction(
      'auto-configure-email-push',
      deviceCustomAction(z.unknown(), z.void(), { kind: 'mutation' }),
      async () => {
        await this.autoConfigureEmailPush()
      },
    )
    this.registerDeviceAction(
      'auto-configure-baichuan-webhook',
      deviceCustomAction(z.unknown(), z.void(), { kind: 'mutation' }),
      async () => {
        await this.autoConfigureBaichuanWebhook()
      },
    )

    // "Refresh from camera" (General tab) and "Refresh sessions" (Sessions
    // tab) as typed device custom actions — the device twin of the addon
    // `customAction` hook. This replaces the legacy `refresh-driver-data`
    // settings-sentinel path (dispatched via a fake batch-mutation write);
    // every "click button → run side-effect" UI now goes through
    // deviceManager.runDeviceAction, with no special-cased keys in
    // `applySettingsPatch`.
    this.registerDeviceAction(
      'refresh-settings',
      deviceCustomAction(z.unknown(), RefreshSettingsResultSchema, { kind: 'mutation' }),
      async () => {
        // The operator's "go and ask it now".
        //
        // Every READ this provider performs is deliberately cheap about the
        // battery: a stale slice is served as-is and revalidated behind the
        // answer, and on a sleeping camera the revalidation does nothing.
        // That is right — waking a camera because somebody opened a settings
        // tab kept a doorbell awake for as long as its tab was open. The cost
        // is that a camera can be believed for a long time on evidence nobody
        // refreshed, and THIS is where the operator buys the truth back.
        //
        // So all three things a background refresh must not do, this does:
        // it WAKES, it ignores the sleep mirror, and it forces every cap
        // slice past its freshness skip. And it reports what it got — a
        // rehydrate that silently declines is the defect it exists to cure
        // (measured on 3825, 2026-09-19: the old handler hit the sleep gate,
        // warmed one slice of six, and returned `void` either way).
        const awake = await this.wakeIfSleeping()
        const [snapshot, warm] = await Promise.allSettled([
          this.refreshParentSettingsSnapshot(undefined, 'operator'),
          this.warmCapSlicesOnWake({ force: true }),
        ])
        const warmed = warm.status === 'fulfilled' ? warm.value.warmed : 0
        const capsTotal = this.capWarmers.size
        this.ctx.logger.info('refresh from camera: operator rehydrate', {
          tags: { deviceId: this.id },
          meta: {
            awake,
            snapshot: snapshot.status,
            warmed,
            capsTotal,
          },
        })
        return {
          awake,
          snapshotRefreshed: snapshot.status === 'fulfilled',
          capsWarmed: warmed,
          capsTotal,
        }
      },
    )
    this.registerDeviceAction(
      'refresh-sessions',
      deviceCustomAction(z.unknown(), z.void(), { kind: 'mutation' }),
      async () => {
        await this.refreshSessionsSnapshot()
      },
    )

    // Motion-zones — exposes the on-camera motion-detection grid (master
    // enable, sensitivity, per-cell region bitmap) via the `motion-zones`
    // cap so the UI can drive the zone editor with typed tRPC mutations.
    this.registerMotionZonesCap()

    // Privacy-mask — exposes the on-camera mask regions via the
    // `privacy-mask` cap (read + master enable + zone write via
    // `setMaskZones`, nodelink-js >= 0.4.23).
    this.registerPrivacyMaskCap()

    // Day/night (IR-cut) — vendor-neutral wrapper over `setIsp`/
    // `getVideoInput` (mode) + `getDayNightThreshold`/`setIsp`
    // (sensitivity threshold). Lets the shared derived-form UI drive
    // IR-cut switching without a Reolink-specific settings section.
    this.registerDayNightCap()

    // Image settings — vendor-neutral wrapper over `setImage`/`getIsp`
    // (brightness/contrast/saturation/sharpness) + `setIsp` (exposure
    // mode). Reolink has no mirror/flip/rotate/white-balance/backlight
    // write path in the Baichuan API surface — `getOptions` honestly
    // omits those controls.
    this.registerImageSettingsCap()

    // Onboard recording + onboard storage — the camera's OWN card and
    // the camera's OWN schedule, not our recorder. Writable since
    // `@apocaliss92/nodelink-js` 0.10.0 (`setRecordCfg` cmd 55,
    // `setRecordSchedule` cmd 82). These two commands answer 200 to a
    // value they then discard, so a write is followed by a read-back
    // and reports what LANDED, never the absence of a throw.
    this.registerRecordingOnboardCap()

    // Stream-catalog — the broker PULLS this cap (on start / reconcile
    // poll / device + stream-params events) to (re)build its cam-stream
    // registry from the authoritative provider state, sourcing the
    // descriptors from `buildStreamCatalog`.
    this.registerStreamCatalogProvider()

    // Native object detection — registers the cap so the UI can query
    // the supported AI classes and the last-seen detection per class.
    // Also persists the `enabled` flag in runtimeState so the operator
    // can suppress forwarding via the orchestrator toggle without losing
    // the onboard-motion heartbeat path.
    this.registerNativeObjectDetectionCap()

    // Battery cap — register eagerly when autodetect already flagged
    // the device as battery-operated. Without this the cap is only
    // registered AFTER the first successful login (`ensureApi` /
    // `adoptApi`), which means a freshly-added (or briefly-offline)
    // battery camera has `DeviceFeature.BatteryOperated` in its
    // `features` (so the UI thinks it's battery-aware) but no
    // `battery.getStatus` provider — `useDeviceBattery` returns null
    // and the BatteryBadge stays invisible. Registering now lets the
    // provider serve the cached snapshot (and a conservative
    // fallback) until `refreshBatteryFromApi` populates real data.
    //
    // Two flag paths to consider:
    //   - Standalone autodetect → `deviceType === 'battery-cam'` (the
    //     transport-discriminator field; battery cams require UDP).
    //   - Hub-adopted discovery → `deviceType === 'camera'` plus
    //     `hasBattery: true` from the NVR's GetChannelstatus payload.
    //     Hub children always go through the parent's TCP socket so
    //     `deviceType` stays `'camera'` even for batteries; the
    //     dedicated `hasBattery` flag is the right discriminator here.
    const cache = this.config.get('deviceCache')
    if (cache?.deviceType === 'battery-cam' || cache?.hasBattery === true) {
      this.isBattery = true
      // Register the battery cap so its `runtimeState` schema
      // attaches to `this.runtimeState` and the persisted slice
      // (loaded from the kernel's `__device-state` namespace before
      // the device was constructed) becomes valid. The `sleeping`
      // getter reads straight off that slice — no shadow field
      // to hydrate.
      this.registerBatteryIfSupported()
      // Arm the periodic battery-cam refresh here so hub-child
      // battery cams (which never go through `adoptApi`/`login` —
      // they borrow the parent Hub's socket) still get the same
      // 60-minute force-refresh as standalones. Idempotent: the
      // standalone paths re-call this after login and it no-ops
      // (timer already armed).
      this.startBatteryUpdatePolling()
    }
  }

  // Battery slice access goes through `this.state.battery` (proxy from
  // BaseDevice). Field-level reads/writes route through the runtime
  // state; see `registerBatteryIfSupported` for the seed that lets
  // partial writes succeed for battery cams.

  /**
   * Idempotent guard for the PTZ provider — registered once per device
   * instance lifetime. `removeDevice` tears down the instance, so a
   * fresh device wires PTZ from scratch. `disconnectAll` does NOT
   * change `hasPtz`, so we don't have to unregister/reregister around
   * the api lifecycle.
   */
  private ptzRegistered = false
  /** Idempotent guard for the `ptz-autotrack` cap. Registered once
   *  per device instance once the abilities probe flagged
   *  `hasAutotrack`. */
  private ptzAutotrackRegistered = false
  /** Single-flight guard for the autotrack camera refresh — back-to-back
   *  `getStatus`/`getSettings` calls within the same tick fold into one
   *  Baichuan round-trip. */
  private autotrackRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the stream-params cap refresh. */
  private streamParamsRefreshInFlight: Promise<void> | null = null
  /** Bound `refreshFromCamera` of the stream-params cap, captured at
   *  registration so the general "Refresh from camera" button can warm
   *  the `stream-params` runtime-state slice (the editable Stream
   *  section's current values read from it). */
  /** Single-flight guard for the motion-zones cap refresh. */
  private motionZonesRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the privacy-mask cap refresh. */
  private privacyMaskRefreshInFlight: Promise<void> | null = null
  /** Last-seen camera grid geometry (bitmap canvas + effective region),
   *  cached from `getMotionAlarm` so `setZone` can re-encode a patch's
   *  `cells` without an extra GET round-trip. */
  private motionZonesGrid: MotionZoneGrid | null = null
  /** Single-flight guard for the `day-night` cap refresh. */
  private dayNightRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `image-settings` cap refresh. */
  private imageSettingsRefreshInFlight: Promise<void> | null = null
  /** Single-flight guard for the `recording-onboard` cap refresh. */
  private recordingOnboardRefreshInFlight: Promise<void> | null = null

  /**
   * Single-flight guard for snapshot fetches (Slice 10). When two
   * consumers hit `getSnapshot` concurrently we issue ONE Baichuan
   * request and let both await its result — saves a doubled wake on
   * battery cams and halves load for regular ones.
   */
  private snapshotInFlight: Promise<{ base64: string; contentType: string } | null> | null = null

  /**
   * Map a nodelink `BatteryInfo` push payload into the camstack
   * `BatteryStatus` shape (Slice 13). `sleeping` honours the runtime
   * `this.sleeping` flag — the BatteryInfo's own `sleeping` field is
   * present on some firmwares but absent on others, so the runtime
   * tracker is more reliable.
   */
  private mapBatteryInfo(info: import('@apocaliss92/nodelink-js').BatteryInfo): BatteryStatus {
    const level =
      typeof info.batteryPercent === 'number'
        ? Math.max(0, Math.min(100, Math.round(info.batteryPercent)))
        : // A push with no numeric level says nothing about the level. Keep the
          // last real reading; when there is none the answer is `null`, never 0.
          (this.state.battery.level ?? null)
    // A push that says nothing about power keeps the previous belief — the
    // same rule `percentage` applies to a push with no numeric level.
    const charging = reportsPowerSource(info)
      ? deriveChargingSource(info.adapterStatus, info.chargeStatus)
      : (this.state.battery.charging ?? 'unknown')
    const sleeping = info.sleeping === true || this.sleeping
    return {
      level,
      charging,
      sleeping,
      lastUpdated: Date.now(),
    }
  }

  /**
   * Register the battery cap provider on battery-flagged devices
   * (Slice 13). The wrapper `snapshot.addon.ts` calls
   * `batteryCapability.getStatus({deviceId})` to decide whether to
   * serve cached frames instead of waking the camera; without this
   * provider the wrapper assumes "awake" and would wake the cam.
   */
  private registerBatteryIfSupported(): void {
    if (this.batteryRegistered) return
    if (!this.isBattery) return
    this.batteryRegistered = true

    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        // Always serve the slice — the post-registration seed below
        // guarantees a populated value from this point on. Re-issuing
        // a Baichuan command from the snapshot wrapper's sleep gate
        // would defeat the purpose (and wake the camera).
        return this.state.battery
      },
      wakeForStream: async ({ deviceId, timeoutMs }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const startedAt = Date.now()
        // Wide-awake cams: no work to do, signal success immediately.
        if (!this.sleeping) {
          return { awoke: true, durationMs: 0 }
        }
        let api: ReolinkBaichuanApi
        try {
          api = await this.ensureApi()
        } catch {
          return { awoke: false, durationMs: Date.now() - startedAt }
        }
        // CONSUMER-driven (the broker has a viewer waiting): bypasses the
        // proactive-wake cooldown, stamps it so background paths back off.
        this.markWakeIssued()
        this.ctx.logger.info('battery wakeForStream: cam sleeping — issuing wake', {
          tags: { deviceId: this.id },
          meta: { timeoutMs },
        })
        // Signal the wake-up window to the broker so its placeholder
        // reason flips from 'sleeping' to 'waking' — encoded-path
        // subscribers (H.264 sessions, derived-broker pipelines) get a
        // labelled "WAKING UP" tile while we drive the Baichuan wake.
        // The reason resets via the subsequent `BatteryOnStatusChanged`
        // event when `sleeping` flips false (or implicitly once real
        // RTP starts flowing).
        this.ctx.eventBus.emit(
          createEvent(EventCategory.BatteryOnWakeStarted, this.eventSource(), {
            deviceId: this.id,
          }),
        )
        const channel = this.getChannel()
        try {
          await Promise.race([
            (async () => {
              // Unconditional forced wake: do NOT consult api.getSleepStatus
              // (the path wakeForIntercom takes) — that state races with
              // this.sleeping and can early-out without actually waking
              // the cam. The intercom path is fine because the talk
              // session itself opens the UDP socket; the streaming
              // pre-wake has no such side effect, so we MUST drive the
              // wake unconditionally.
              await api.wakeUp(channel, { waitAfterWakeMs: 2500, attempts: 2 })
              // Argus / battery doorbell firmwares lag the wakeUp ack by
              // ~1s before the media socket actually starts pushing.
              // Skipping this settle produces a "DTLS connected but no
              // video" window that Echo can't tolerate.
              await sleep(1500)
            })(),
            new Promise<void>((_, rej) =>
              setTimeout(() => rej(new Error('wakeForStream timeout')), timeoutMs),
            ),
          ])
          // The ACK is not the wake. After a DEMANDED wake we confirm the
          // transition ACTIVELY instead of waiting on a push event that may
          // never arrive (live hub, 2026-08-15: ACK'd wakes, zero `awake`
          // events, zero streams — the subscription was idle).
          //
          // Two confirmations, one per topology:
          //  - hub child: its wake is the CONSUMER's relay dial (the
          //    `pull-rtsp` catalog the child now publishes while asleep),
          //    not the nudge — so "confirmed" cannot mean "already awake".
          //    It means REACHABLE: the parent's summary lists the channel
          //    and does not mark it offline. The dial then raises the camera
          //    over RF (verified live, 2026-08-15: relay dial → frames in
          //    ~10 s → natural re-sleep). A channel absent/offline in the
          //    summary is the honest failure.
          //  - standalone: the lib's passive sleep inference (socket I/O
          //    inspection — no traffic, no re-wake risk).
          const CONFIRM_TIMEOUT_MS = 10_000
          const CONFIRM_POLL_MS = 1_000
          const confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS
          const parent = await this.getParentHub()
          let confirmed = false
          // True only when the camera is OBSERVED awake — a merely reachable
          // hub child (its wake happens on the consumer's dial) must not flip
          // the slice, or the state would claim awake while it sleeps.
          let observedAwake = false
          while (Date.now() < confirmDeadline) {
            if (parent !== null) {
              try {
                const parentApi = await parent.getApi()
                const summary = await parentApi.getNvrChannelsSummary({
                  channels: [this.getChannel()],
                })
                const entry = summary.devices.find((d) => d.channel === this.getChannel())
                // Awake is confirmed; merely-present-and-not-offline is the
                // hub-child success answer (the dial wakes it on demand).
                if (entry !== undefined && entry.online !== false) {
                  confirmed = true
                  observedAwake = entry.sleeping === false
                  break
                }
              } catch {
                // A summary hiccup is not "still asleep" — keep waiting.
              }
            } else {
              let state: string | null = null
              try {
                state = api.getSleepStatus({ channel: this.getChannel() }).state
              } catch {
                state = null
              }
              if (state === 'awake') {
                confirmed = true
                observedAwake = true
                break
              }
            }
            await sleep(CONFIRM_POLL_MS)
          }
          // The commit source follows the evidence: a hub-child confirmation
          // is the parent's firmware-reported summary — the AUTHORITATIVE
          // writer, which also bypasses the wake hysteresis (a child that was
          // put to sleep seconds ago by an eager inference must not have its
          // confirmed wake gated out).
          const confirmSource = parent !== null ? 'hub-summary' : 'sleep-poll'
          if (observedAwake && this.commitSleepState(false, confirmSource)) {
            this.ctx.logger.info(
              'battery wakeForStream: wake confirmed — driving wake transition',
              {
                tags: { deviceId: this.id },
                meta: { confirmMs: Date.now() - startedAt, source: confirmSource },
              },
            )
            void this.onWakeTransition(confirmSource).catch(() => {
              /* best-effort */
            })
          } else if (!confirmed) {
            // The ACK arrived but nothing observable woke. Say so —
            // `awoke:false` makes the broker answer "sleeping, try
            // again" instead of parking the client in a 20 s "waking"
            // window we already know will not produce a stream.
            this.ctx.logger.warn(
              'battery wakeForStream: ACK received but no awake evidence inside the confirm window',
              { tags: { deviceId: this.id }, meta: { confirmTimeoutMs: CONFIRM_TIMEOUT_MS } },
            )
            this.emitWakeSettled()
            return { awoke: false, durationMs: Date.now() - startedAt }
          }
          // A reachable hub child wakes on the consumer's dial, seconds
          // AFTER this answer — nobody is left to flip its slice when the
          // push channel misses the transition (the whole reason this
          // confirm exists). Watch the parent's summary briefly and commit
          // the flip when it lands, so the overlay/icon catch the stream
          // instead of saying "sleeping" over a playing video.
          if (confirmed && !observedAwake && parent !== null) {
            void this.watchHubChildAwake(parent).catch(() => {
              /* best-effort */
            })
          }
          // Whatever makes this answer `true` must also make the MIRROR say
          // awake. For a hub child `confirmed` is "the channel is present and
          // not offline — the dial wakes it on demand", and that is the
          // evidence this answer rests on; the parent's summary, which
          // `observedAwake` reads, lags real state by more than 75 s and is
          // therefore still saying "sleeping" at this point almost every
          // time. Committing only on the summary is what split one wake into
          // two contradictory answers.
          if (this.commitSleepState(false, 'confirmed-wake')) {
            this.ctx.logger.info('battery wakeForStream: answering awake — committing the mirror', {
              tags: { deviceId: this.id },
              meta: { confirmedMs: Date.now() - startedAt, observedAwake },
            })
            void this.onWakeTransition('confirmed-wake').catch(() => {
              /* best-effort */
            })
          }
          return { awoke: true, durationMs: Date.now() - startedAt }
        } catch (err) {
          this.ctx.logger.warn('battery wakeForStream: wake did not complete in time', {
            tags: { deviceId: this.id },
            meta: {
              timeoutMs,
              error: err instanceof Error ? err.message : String(err),
            },
          })
          this.emitWakeSettled()
          return { awoke: false, durationMs: Date.now() - startedAt }
        }
      },
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    // Seed the slice once so subsequent field-level proxy writes
    // (e.g. `this.state.battery.sleeping = true`) merge cleanly through
    // `patchCapState` without tripping the schema's required-fields
    // check. Real values land via `battery` push events / post-login
    // `getBatteryInfo`.
    if (this.getCapSlice(batteryCapability) === null) {
      this.setCapSlice(batteryCapability, {
        // NOT YET KNOWN, not empty. Seeding 0 made every battery camera behind
        // an NVR announce a flat battery on each start and correct itself a
        // moment later — long enough to fire the low-battery alert.
        level: null,
        charging: 'none',
        sleeping: false,
        lastUpdated: Date.now(),
      })
    }

    // Bridge runtime-state writes to the cap event bus automatically.
    // Any write that touches the `battery` slice (proxy field-level
    // writes via `this.state.battery.<field>`, full-slice writes via
    // `setCapSlice(batteryCapability, …)`, future paths) re-emits
    // `battery.onStatusChanged` once — no manual `emit` calls scattered
    // across the writers.
    this.runtimeState.subscribeCap<BatteryStatus>('battery', (slice) => {
      if (!slice) return
      this.ctx.eventBus.emit(
        createEvent(EventCategory.BatteryOnStatusChanged, this.eventSource(), {
          deviceId: this.id,
          status: slice,
        }),
      )
    })

    // Seed the cache with a one-shot `getBatteryInfo` after registration.
    //
    // NOT while it sleeps (D173). The comment this replaces claimed "same
    // call as the legacy battery probe, so no extra wake event" — true of the
    // COMMAND and false of the CONNECTION: `refreshBatteryFromApi` resolves
    // through `ensureApi()`, and on a sleeping battery cam the Baichuan login
    // is itself the wake. This runs in the constructor, so every addon
    // restart woke every sleeping battery camera to ask a question whose
    // answer the RESTORED slice already holds.
    //
    // Steady-state updates arrive via the firmware's `battery` simpleEvent
    // push (handled in `handleSimpleEvent`), routed for hub children by
    // `ReolinkHub.routeSimpleEvent`, and the cold-start value comes from the
    // restored slice — no poll, no wake.
    void this.refreshBatteryFromApi('register')
  }

  /**
   * @param reason - `'register'` and `'periodic'` are OUR initiative and are
   *   refused while the camera sleeps; `'wake'` and `'demand'` run because
   *   something already has the camera awake or is entitled to wake it.
   */
  private async refreshBatteryFromApi(
    reason: 'register' | 'periodic' | 'wake' | 'demand',
  ): Promise<boolean> {
    if (this.isBattery && this.sleeping && (reason === 'register' || reason === 'periodic')) {
      this.ctx.logger.debug('battery refresh skipped — cam sleeping, reading restored slice', {
        tags: { deviceId: this.id },
        meta: { reason },
      })
      return false
    }
    // Resolve the api through `ensureApi()` rather than reading
    // `this.api` directly — hub-adopted children never own a socket
    // (they delegate to the parent Hub's long-lived connection), so
    // `this.api` stays null for them and the previous early-return
    // silently skipped every refresh. `ensureApi()` returns the
    // parent's api in that case (no extra wake, no extra login).
    let api: ReolinkBaichuanApi
    try {
      api = await this.ensureApi()
    } catch (err) {
      this.ctx.logger.debug('battery refresh: ensureApi failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
    try {
      const info = await api.getBatteryInfo(this.getChannel())
      this.updateBatteryCache(info)
      // The firmware just answered: the socket is up, the camera is awake.
      await this.refreshNetworkLinkFromApi(api, 'battery')
      return true
    } catch (err) {
      this.ctx.logger.debug('battery refresh failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
  }

  /**
   * THE single writer of the `battery.sleeping` slice.
   *
   * Before this existed the state had three independent writers with
   * three different rules: the `awake`/`sleeping` simpleEvent handlers
   * (hysteresis-gated) and the sleep poll (which wrote the slice
   * directly, bypassing the hysteresis AND leaving
   * `sleepStateChangedAt` stale so the NEXT event compared against an
   * ancient timestamp). Funnelling every writer through here keeps one
   * rule set and one timestamp.
   *
   * The rule itself lives in `sleep-state-decision.ts`, pure, so it can be
   * driven by a test instead of asserted from this file's source text. Read
   * that module for why `hub-reconcile` — the parent's periodic summary
   * sweep — stamps nothing: it lags real state by more than a minute, and
   * arming the anti-flap window from it threw away the camera's real wake
   * for up to 2 min 26 s on the live hub (D603).
   *
   * @returns `true` when the slice actually changed.
   */
  private commitSleepState(next: boolean, source: SleepCommitSource): boolean {
    if (!this.isBattery) return false
    const decision = decideSleepCommit({
      current: this.sleeping,
      next,
      source,
      lastFirstHandCommitAt: this.sleepStateChangedAt,
      nowMs: Date.now(),
    })
    if (decision.kind === 'unchanged') return false
    if (decision.kind === 'refused') {
      // Both refusals are logged, and both name the source — a refusal that
      // does not say WHO was refused cannot be told from one that says the
      // camera never spoke.
      this.ctx.logger.debug(
        decision.reason === 'hysteresis'
          ? 'ignoring sleep inference flap within hysteresis window'
          : 'hub-summary sleep flip refused — fresher first-hand state inside grace',
        {
          tags: { deviceId: this.id },
          meta: {
            next,
            source,
            windowMs: decision.windowMs,
            sinceLastChangeMs: decision.sinceLastChangeMs,
          },
        },
      )
      return false
    }
    if (decision.stampFirstHand) this.sleepStateChangedAt = Date.now()
    this.state.battery.sleeping = next
    this.ctx.logger.info('battery sleep state committed', {
      tags: { deviceId: this.id },
      meta: { sleeping: next, source },
    })
    return true
  }

  /**
   * Hub-driven sleep reconcile. The NVR's `getNvrChannelsSummary`
   * carries a per-channel `sleeping` flag that the parent Hub already
   * pulls on every discovery refresh — firmware truth, obtained over
   * the Hub's own mains-powered socket, costing the battery channel
   * nothing. Before this the flag died inside the Hub's
   * `device-discovery` slice and the adopted child's sleep state
   * depended entirely on routed simpleEvents; a child that missed a
   * transition (or whose channel dropped out of the routing map while
   * deep-asleep) kept serving a stale value indefinitely.
   *
   * No-op for non-battery children. Called by `ReolinkHub` after each
   * successful discovery refresh.
   */
  applyHubSleepState(sleeping: boolean): void {
    if (!this.isBattery) return
    // `hub-reconcile`, not `hub-summary`: this is the PERIODIC sweep, minutes
    // behind real state. It may still correct a stuck slice, but it must not
    // arm the anti-flap window against the camera's own wake push (D603).
    if (this.commitSleepState(sleeping, 'hub-reconcile') && !sleeping) {
      // Same post-wake contract as the simpleEvent / sleep-poll paths.
      void this.onWakeTransition('hub-reconcile').catch(() => {
        /* best-effort */
      })
    }
  }

  /**
   * Rate-limit for wakes we issue on our OWN initiative. Returns
   * `false` when a proactive wake happened less than
   * `PROACTIVE_WAKE_COOLDOWN_MS` ago — the caller must then serve
   * whatever it has cached instead of reaching for the radio.
   *
   * Demand-driven paths never call this: `wakeForStream` (a consumer
   * wants live video), `wakeIfSleeping` (an operator clicked
   * something) and the intercom pre-wake all wake unconditionally.
   */
  private canProactivelyWake(reason: string): boolean {
    if (this.lastProactiveWakeAt === 0) return true
    const sinceMs = Date.now() - this.lastProactiveWakeAt
    if (sinceMs >= ReolinkCamera.PROACTIVE_WAKE_COOLDOWN_MS) return true
    this.ctx.logger.debug('proactive wake suppressed by cooldown', {
      tags: { deviceId: this.id },
      meta: {
        reason,
        sinceMs,
        cooldownMs: ReolinkCamera.PROACTIVE_WAKE_COOLDOWN_MS,
      },
    })
    return false
  }

  /** Stamp the proactive-wake cooldown. Called by every path that
   *  actually issues a wake — demand-driven ones included, so an
   *  operator-triggered wake also postpones the next proactive one. */
  private markWakeIssued(): void {
    this.lastProactiveWakeAt = Date.now()
  }

  /**
   * Post-confirm watch for a hub child whose wake lands on the consumer's
   * relay dial: re-read the parent's channel summary a few times over the
   * dial's wake window and commit `sleeping: false` the moment the firmware
   * reports it. Ends EARLY once committed; bounded hard so a dead link can't
   * leak a timer. Costs the camera nothing — the summary is the hub's own
   * mains-powered read.
   */
  private async watchHubChildAwake(parent: ReolinkHubLike): Promise<void> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      await sleep(5_000)
      try {
        const parentApi = await parent.getApi()
        const summary = await parentApi.getNvrChannelsSummary({ channels: [this.getChannel()] })
        const entry = summary.devices.find((d) => d.channel === this.getChannel())
        if (entry?.sleeping === false) {
          if (this.commitSleepState(false, 'hub-summary')) {
            this.ctx.logger.info('battery wakeForStream: hub child observed awake after the dial', {
              tags: { deviceId: this.id },
            })
            void this.onWakeTransition('hub-summary').catch(() => {
              /* best-effort */
            })
          }
          return
        }
      } catch {
        // A summary hiccup is not a verdict — the window keeps running.
      }
    }
  }

  /**
   * Close the transient "waking" window on a wake that did NOT produce a
   * committed transition (ACK with no awake evidence, or a timeout).
   * `BatteryOnWakeStarted` opens it; normally the `sleeping: false` commit
   * closes it via `BatteryOnStatusChanged` — but a failed wake changes no
   * state, so nothing ever closes it, and listeners (the snapshot overlay,
   * the broker's "WAKING UP" placeholder) kept showing WAKING for the whole
   * 35 s TTL after the answer was already known (2026-08-15: the overlay
   * flapped sleeping↔waking on every retry — read as "random"). Re-asserting
   * the unchanged slice still emits the event (the runtime-state bridge
   * re-emits per WRITE), which is exactly the "wake is over, nothing came of
   * it" signal those windows listen for.
   */
  private emitWakeSettled(): void {
    if (!this.isBattery) return
    this.ctx.eventBus.emit(
      createEvent(EventCategory.BatteryOnStatusChanged, this.eventSource(), {
        deviceId: this.id,
        status: this.state.battery,
      }),
    )
  }

  private updateBatteryCache(info: import('@apocaliss92/nodelink-js').BatteryInfo): void {
    // Single write through the cap-keyed runtime state — the kernel
    // layer debounces persistence to disk and the
    // `subscribeCap('battery')` bridge in `registerBatteryIfSupported`
    // re-emits `battery.onStatusChanged` automatically. No more
    // shadow `batteryStatusCache` field; no more manual cap event
    // emission scattered across writers.
    // The firmware answered — passive proof of reachability, folded into the
    // SAME write so it costs no extra commit (D173).
    const mapped = this.mapBatteryInfo(info)
    const now = Date.now()
    const quantised = now - (now % ReolinkCamera.CONTACT_WRITE_QUANTUM_MS)
    const previousContact = this.state.battery.lastContactAt ?? 0
    this.setCapSlice(batteryCapability, {
      ...mapped,
      lastContactAt: Math.max(previousContact, quantised),
    })
  }

  /**
   * Hub-fed battery refresh for an adopted child. The parent's
   * `getAllChannelsBatteryInfo` CGI carries per-channel percent/charge
   * state over the hub's own mains-powered socket, so it costs the
   * battery channel nothing — this is how a hub child's
   * percentage/charging ever moves (a sleeping child answers no poll of
   * its own, and its pushes only arrive on firmware transitions).
   *
   * Deliberately does NOT stamp `lastContactAt`: the value is the HUB's
   * cached read of the channel, not proof the camera itself answered —
   * folding it into contact would mask a genuinely gone camera from the
   * unreachable derivation (that is what pushes and streams are for).
   * `sleeping` is likewise untouched — sleep state has its own writers
   * (pushes + the guarded hub-summary reconcile).
   */
  applyHubBatteryInfo(info: {
    readonly batteryPercent?: number
    readonly chargeStatus?: string
    readonly adapterStatus?: string
  }): void {
    if (!this.isBattery) return
    const mapped = this.mapBatteryInfo({
      ...(info.batteryPercent !== undefined ? { batteryPercent: info.batteryPercent } : {}),
      ...(info.chargeStatus !== undefined ? { chargeStatus: info.chargeStatus } : {}),
      ...(info.adapterStatus !== undefined ? { adapterStatus: info.adapterStatus } : {}),
    })
    this.setCapSlice(batteryCapability, {
      ...this.state.battery,
      level: mapped.level,
      charging: mapped.charging,
      lastUpdated: Date.now(),
    })
  }

  /**
   * Battery cams require an explicit wake before cmd_id 109 will
   * answer reliably. The lib documents this pattern in
   * `predownloadRecordingMp3`/`predownloadRecordingMp4` (`ensureAwake`
   * → `wakeUp` → operation → retry with longer wait on failure).
   * `getSnapshot` itself only re-`login()`s, which over BCUDP can
   * complete before the camera firmware is fully up — the snapshot then
   * times out because the video subsystem isn't ready yet.
   *
   * Probe live testing (scripts/probe-reolink-snapshot.mts) confirmed:
   *   awake state: getSnapshot in ~1s
   *   wakeUp + getSnapshot: ~2.7s total (wakeUp 1.7s + snapshot 1s)
   * The added latency is the cost we pay to actually return a frame
   * instead of timing out.
   */
  /**
   * Refresh the diagnostic Sessions snapshot from the live Baichuan
   * api: who's currently logged into the camera, how many sockets we
   * hold open, and whether the camera is currently rate-limiting our
   * reconnect attempts. Single-flight (concurrent calls reuse the same
   * round-trip) and tolerant of partial failures — each lib call's
   * error is recorded but does not poison the rest of the snapshot.
   *
   * Side-effect: writes `this.sessionsSnapshot`. Best-effort: when
   * `ensureApi()` fails (camera offline, sleeping battery cam) the
   * snapshot still updates with a populated `error` field plus a
   * fallback `socketPool` block so the operator sees the failure
   * surface instead of stale data.
   */
  private async refreshSessionsSnapshot(): Promise<void> {
    if (this.sessionsRefreshInFlight) return this.sessionsRefreshInFlight
    const promise = (async (): Promise<void> => {
      let api: ReolinkBaichuanApi
      try {
        api = await this.ensureApi()
      } catch (err) {
        this.sessionsSnapshot = {
          ts: Date.now(),
          onlineUsers: null,
          socketPool: [],
          dedicatedSessions: [],
          cooldown: null,
          error: err instanceof Error ? err.message : String(err),
        }
        return
      }
      this.sessionsSnapshot = await captureSessionsSnapshot(api, {
        logger: this.ctx.logger,
        deviceId: this.id,
      })
    })().finally(() => {
      this.sessionsRefreshInFlight = null
    })
    this.sessionsRefreshInFlight = promise
    return promise
  }

  /**
   * Build the contents of the "Sessions" tab from `this.sessionsSnapshot`.
   * Always returns at least the Refresh button so the operator can force
   * a fetch when the snapshot is empty (cold start) or stale beyond the
   * displayed timestamp. Section + tab layout details mirror the rest
   * of the device-settings UI (one card per logical block).
   *
   * NO auto-fetch. `getOnlineUserList` (cmd 120) wakes a sleeping
   * battery cam, and the Settings panel polls every ~2.5s — auto-
   * triggering on stale would keep the doorbell awake indefinitely
   * just because the operator left the tab open. The operator's
   * explicit "Refresh" click is the sole trigger; it dispatches the
   * `refresh-sessions` device custom action via runDeviceAction.
   */
  private buildSessionsTabSections(): readonly ConfigUISchema['sections'][number][] {
    return buildSessionsTabSectionsShared(this.sessionsSnapshot, {
      tabId: 'sessions',
      title: 'Camera Sessions',
      autoRefreshes: !this.isBattery,
    })
  }

  /**
   * Battery-cam Email Push auto-configure section. Returns `[]` for any
   * camera that wouldn't benefit (wired cams keep a live socket for
   * native push; hub children have no independent email path). The
   * button dispatches via the device custom-action mechanism
   * (runDeviceAction → `auto-configure-email-push` registered in
   * `registerNativeCapabilities`), not the legacy refresh-driver-data sentinel.
   */
  private buildEmailPushSection(): readonly ConfigUISchema['sections'][number][] {
    if (!this.isBattery || !this.isEmailPushEligible) return []
    return [
      {
        id: 'sleep-push',
        tab: 'motion',
        title: 'Battery motion (sleep push)',
        titleKey: 'provider-reolink:emailPushSection.s_sleep-push.title',
        description: 'Prefer the HaCfg webhook when the firmware supports it; arm only one path.',
        descriptionKey: 'provider-reolink:emailPushSection.s_sleep-push.description',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'batterySleepPushMethod',
            label: 'Preferred sleep-push path',
            labelKey: 'provider-reolink:emailPushSection.s_sleep-push.batterySleepPushMethod.label',
            default: 'auto',
            options: [
              {
                value: 'auto',
                label: 'Auto (webhook if supported, else email)',
                labelKey:
                  'provider-reolink:emailPushSection.s_sleep-push.batterySleepPushMethod.o_auto.label',
              },
              {
                value: 'webhook',
                label: 'HaCfg webhook only',
                labelKey:
                  'provider-reolink:emailPushSection.s_sleep-push.batterySleepPushMethod.o_webhook.label',
              },
              {
                value: 'email',
                label: 'Email/SMTP only',
                labelKey:
                  'provider-reolink:emailPushSection.s_sleep-push.batterySleepPushMethod.o_email.label',
              },
            ],
          },
          {
            type: 'device-action-button',
            key: '_autoConfigureBaichuanWebhook',
            label: 'HaCfg webhook',
            labelKey:
              'provider-reolink:emailPushSection.s_sleep-push._autoConfigureBaichuanWebhook.label',
            buttonLabel: 'Auto-configure HaCfg webhook',
            action: 'auto-configure-baichuan-webhook',
            variant: 'default',
          },
          {
            type: 'device-action-button',
            key: '_autoConfigureEmailPush',
            label: 'Email push',
            labelKey:
              'provider-reolink:emailPushSection.s_sleep-push._autoConfigureEmailPush.label',
            buttonLabel: 'Auto-configure email push',
            action: 'auto-configure-email-push',
            variant: 'default',
          },
        ],
      },
    ]
  }

  /**
   * Editable on-camera email/SMTP config — its own "Email" tab, built exactly
   * like the other camera-settings sections (Connection / NTP / Audio):
   * editable fields seeded from `deviceCache.emailConfigSnapshot` (read by the
   * standard refresh + every wake), written back to the camera in
   * `applySettingsPatch` via `applyEmailConfigPatch` (Baichuan `setEmail` /
   * `setEmailTask`). Gated identically to the Email-push button. The values
   * live in the `values` map (see `getSettingsUISchema`).
   */
  private buildEmailTabSections(): readonly ConfigUISchema['sections'][number][] {
    if (!this.isBattery || !this.isEmailPushEligible) return []
    return [
      {
        id: 'email-smtp',
        tab: 'email',
        title: 'SMTP server',
        titleKey: 'provider-reolink:emailTabSections.s_email-smtp.title',
        description: 'Leave the password blank to keep the current one.',
        descriptionKey: 'provider-reolink:emailTabSections.s_email-smtp.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'emailSmtpServer',
            label: 'SMTP server',
            labelKey: 'provider-reolink:emailTabSections.s_email-smtp.emailSmtpServer.label',
            placeholder: 'smtp.example.com',
          },
          {
            type: 'number',
            key: 'emailSmtpPort',
            label: 'SMTP port',
            labelKey: 'provider-reolink:emailTabSections.s_email-smtp.emailSmtpPort.label',
            min: 1,
            max: 65535,
            step: 1,
          },
          {
            type: 'text',
            key: 'emailUserName',
            label: 'Username / sender',
            labelKey: 'provider-reolink:emailTabSections.s_email-smtp.emailUserName.label',
            placeholder: 'cam@example.com',
          },
          {
            type: 'password',
            key: 'emailPassword',
            label: 'Password',
            labelKey: 'provider-reolink:emailTabSections.s_email-smtp.emailPassword.label',
            showToggle: true,
            placeholder: 'leave blank to keep',
          },
          {
            type: 'boolean',
            key: 'emailSsl',
            label: 'SSL/TLS',
            labelKey: 'provider-reolink:emailTabSections.s_email-smtp.emailSsl.label',
            style: 'switch',
          },
          {
            type: 'text',
            key: 'emailSendNickname',
            label: 'Sender name',
            labelKey: 'provider-reolink:emailTabSections.s_email-smtp.emailSendNickname.label',
          },
        ],
      },
      {
        id: 'email-recipients',
        tab: 'email',
        title: 'Recipients',
        titleKey: 'provider-reolink:emailTabSections.s_email-recipients.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'emailRecipient1',
            label: 'Recipient 1',
            labelKey: 'provider-reolink:emailTabSections.s_email-recipients.emailRecipient1.label',
            placeholder: 'alerts@example.com',
          },
          {
            type: 'text',
            key: 'emailRecipient2',
            label: 'Recipient 2',
            labelKey: 'provider-reolink:emailTabSections.s_email-recipients.emailRecipient2.label',
          },
          {
            type: 'text',
            key: 'emailRecipient3',
            label: 'Recipient 3',
            labelKey: 'provider-reolink:emailTabSections.s_email-recipients.emailRecipient3.label',
          },
        ],
      },
      {
        id: 'email-schedule',
        tab: 'email',
        title: 'Alarm schedule',
        titleKey: 'provider-reolink:emailTabSections.s_email-schedule.title',
        columns: 1,
        fields: [
          {
            type: 'boolean',
            key: 'emailScheduleEnabled',
            label: 'Email alarm schedule enabled',
            labelKey:
              'provider-reolink:emailTabSections.s_email-schedule.emailScheduleEnabled.label',
            style: 'switch',
          },
        ],
      },
    ]
  }

  /**
   * Write the editable Email-tab fields to the camera: merge the supplied
   * fields into a Baichuan `setEmail` patch (password omitted when blank), flip
   * the EmailTask master enable when changed (read-modify-write to preserve the
   * schedule), then re-read so the snapshot — and the form — realign with the
   * camera. Only ever called from `applySettingsPatch` when an `email*` field
   * changed.
   */
  private async applyEmailConfigPatch(fields: {
    emailSmtpServer?: unknown
    emailSmtpPort?: unknown
    emailUserName?: unknown
    emailPassword?: unknown
    emailSsl?: unknown
    emailRecipient1?: unknown
    emailRecipient2?: unknown
    emailRecipient3?: unknown
    emailSendNickname?: unknown
    emailScheduleEnabled?: unknown
  }): Promise<void> {
    await this.wakeIfSleeping()
    const api = await this.ensureApi()
    const channel = this.getChannel()
    const patch: import('@apocaliss92/nodelink-js').EmailConfigPatch = {}
    if (typeof fields.emailSmtpServer === 'string') patch.smtpServer = fields.emailSmtpServer
    if (typeof fields.emailSmtpPort === 'number') patch.smtpPort = fields.emailSmtpPort
    if (typeof fields.emailUserName === 'string') patch.userName = fields.emailUserName
    if (typeof fields.emailPassword === 'string' && fields.emailPassword.length > 0)
      patch.password = fields.emailPassword
    if (typeof fields.emailSsl === 'boolean') patch.ssl = fields.emailSsl ? 1 : 0
    if (typeof fields.emailRecipient1 === 'string') patch.address1 = fields.emailRecipient1
    if (typeof fields.emailRecipient2 === 'string') patch.address2 = fields.emailRecipient2
    if (typeof fields.emailRecipient3 === 'string') patch.address3 = fields.emailRecipient3
    if (typeof fields.emailSendNickname === 'string') patch.sendNickname = fields.emailSendNickname
    if (Object.keys(patch).length > 0) {
      this.ctx.logger.info('email-push: writing SMTP config to camera', {
        tags: { deviceId: this.id },
        meta: { keys: Object.keys(patch) },
      })
      await api.setEmail(patch)
    }
    if (typeof fields.emailScheduleEnabled === 'boolean') {
      // Read-modify-write so only the master enable flips; the per-type
      // schedule slots are preserved (Reolink drops slots not sent back).
      const task = await api.getEmailTask(channel).catch(() => null)
      if (task) {
        await api.setEmailTask(channel, { ...task, enable: fields.emailScheduleEnabled ? 1 : 0 })
      }
    }
    // Realign the snapshot (and therefore the form) with the camera.
    await this.refreshCameraEmailConfig().catch(() => {
      /* best-effort */
    })
  }

  /**
   * @param force - the caller's `snapshot.getSnapshot({ force })`. THE gate:
   *   without it a sleeping battery camera is never touched, whatever the
   *   cache holds. See `snapshot-wake-gate.ts` for why the flag — and not a
   *   cooldown — is what decides.
   */
  private async fetchSnapshotWithSingleFlight(force: boolean): Promise<{
    base64: string
    contentType: string
  } | null> {
    // Joining a capture already in flight wakes nothing, so it needs no gate:
    // whoever started it has already paid for the socket.
    if (this.snapshotInFlight) return this.snapshotInFlight
    // Gate BEFORE `ensureApi` — the login is itself the wake, so anything
    // downstream of it is cosmetic. Returning null hands the decision back to
    // the snapshot wrapper, whose whole design is to serve the cached frame
    // for a battery device (`BATTERY_DEFAULT_MAX_AGE_S`) and to paint
    // `sleeping: true` when it has none; it also skips the 25 s getSnapshot
    // timeout we would otherwise burn on a sleeping camera.
    const access = decideSnapshotCameraAccess({
      isBattery: this.isBattery,
      sleeping: this.sleeping,
      force,
    })
    if (access.kind === 'refuse') {
      // INFO, not debug: this is a request we deliberately drop, and the
      // operator's question is always "why is THIS camera's tile stale?".
      this.ctx.logger.info('snapshot: refused — battery cam asleep and no operator force', {
        tags: { deviceId: this.id },
        meta: { reason: access.reason },
      })
      return null
    }
    // Operator demand. Stamp the SHARED proactive cooldown so background
    // paths (contact-expiry, aux align) back off behind this wake — the
    // cooldown never gates this path, it only records it.
    if (access.stampCooldown) this.markWakeIssued()
    const promise = (async (): Promise<{ base64: string; contentType: string } | null> => {
      let api: ReolinkBaichuanApi
      try {
        api = await this.ensureApi()
      } catch (err) {
        this.ctx.logger.warn('snapshot: ensureApi failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }

      // Battery-cam pre-wake. `getSleepStatus` is purely passive —
      // inspects the lib's internal command-traffic cache, no network
      // I/O — so it costs nothing and never wakes the camera by
      // itself. We treat anything other than confirmed-awake as
      // "probably sleeping" because the user-facing cost of an
      // unnecessary wake (a couple of seconds + a small battery hit)
      // is much smaller than the cost of returning null when a frame
      // was wanted.
      const isSleepingSuspected =
        this.isBattery &&
        (() => {
          try {
            const status = api.getSleepStatus({ channel: this.getChannel() })
            return status.state !== 'awake'
          } catch {
            return true
          }
        })()
      if (isSleepingSuspected) {
        // The sleep gate was already consulted BEFORE `ensureApi` above —
        // reaching here means the caller passed `force` (or the camera was
        // believed awake), so drive the explicit wake: the login alone does
        // not reliably bring the video subsystem up.
        try {
          await api.wakeUp(this.getChannel(), { waitAfterWakeMs: 1500, attempts: 2 })
        } catch (err) {
          this.ctx.logger.debug('snapshot: pre-wake failed (will still try getSnapshot)', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }

      const tryOnce = async (timeoutMs: number): Promise<Buffer | null> => {
        const buf = await api.getSnapshot(this.getChannel(), { streamType: 'main', timeoutMs })
        return buf && buf.length > 0 ? buf : null
      }

      const formatResult = (buf: Buffer): { base64: string; contentType: string } => ({
        base64: buf.toString('base64'),
        contentType: 'image/jpeg',
      })

      // Battery cams: 25 s on the first attempt to absorb wake-up
      // latency variance; non-battery cams keep the lib's 15 s default.
      const firstTimeout = this.isBattery ? 25_000 : 15_000
      try {
        const buf = await tryOnce(firstTimeout)
        if (buf) return formatResult(buf)
      } catch (err) {
        const recoverable = isRecoverableBaichuanError(err)
        const meta = {
          channel: this.getChannel(),
          recoverable,
          attempt: 1,
          error: err instanceof Error ? err.message : String(err),
        }
        if (recoverable) {
          this.ctx.logger.debug('snapshot: getSnapshot transient error', {
            tags: { deviceId: this.id },
            meta,
          })
        } else {
          this.ctx.logger.warn('snapshot: getSnapshot failed (attempt 1)', {
            tags: { deviceId: this.id },
            meta,
          })
        }
        // Battery cams get one explicit wake-up + retry. Mirrors the
        // lib's `predownloadRecordingMp4` retry pattern. Skip the
        // retry for non-battery cams — there the failure is genuinely
        // a network/auth issue and re-trying the same call yields the
        // same result.
        if (this.isBattery) {
          try {
            await api.wakeUp(this.getChannel(), {
              waitAfterWakeMs: 3000,
              attempts: 3,
              reconnect: true,
            })
            const buf = await tryOnce(25_000)
            if (buf) return formatResult(buf)
          } catch (retryErr) {
            this.ctx.logger.warn('snapshot: getSnapshot failed (attempt 2 after wake)', {
              tags: { deviceId: this.id },
              meta: {
                channel: this.getChannel(),
                error: retryErr instanceof Error ? retryErr.message : String(retryErr),
              },
            })
          }
        }
      }
      return null
    })()
    this.snapshotInFlight = promise
    try {
      return await promise
    } finally {
      this.snapshotInFlight = null
    }
  }

  /**
   * Idempotency for the doorbell provider. The cap is registered once
   * per device-instance lifetime — `removeDevice` rebuilds the device
   * from scratch.
   */
  private doorbellRegistered = false

  /** Push counter mirrored into the doorbell cap status. */
  private doorbellPressCountSinceStart = 0
  private doorbellLastPressedAt: number | null = null

  private registerDoorbellIfSupported(): void {
    if (this.doorbellRegistered) return
    const probe = this.getProbeFlags<ReolinkProbeFlags>()
    if (!probe.hasDoorbell) return
    this.doorbellRegistered = true
    const doorbellProvider: InferNativeProvider<typeof doorbellCapability> = {
      getStatus: async () => ({
        lastPressedAt: this.doorbellLastPressedAt,
        pressCountSinceStart: this.doorbellPressCountSinceStart,
      }),
    }
    this.ctx.registerNativeCap(doorbellCapability, doorbellProvider)
  }

  /** One-time registration guard for `intercom` cap. */
  private intercomRegistered = false
  /**
   * Active intercom orchestrator. The `intercom` cap is
   * `singleton`-mode device-scoped — at most one talk session is
   * open at a time per camera (mirrors how Reolink's own UI
   * behaves). The orchestrator owns the WebRTC peer + audio-codec
   * decode session + Reolink talk channel for that one active
   * session; `null` when idle.
   */
  private intercomOrchestrator: IntercomOrchestrator | null = null

  /**
   * Active talk session for the non-WebRTC `pushTalkAudio` data plane
   * (opened by `startTalkSession`). Mutually exclusive with the
   * WebRTC orchestrator session above — non-WebRTC consumers (HomeKit
   * export, Alexa raw audio) push talk-back audio through this session
   * and the provider decides whether to passthrough or transcode based
   * on the caller's declared wire codec.
   */
  private intercomRawSession: {
    readonly id: string
    readonly session: ReolinkIntercomSession
    lastSequenceNumber: number
    /**
     * Lazy-created `audio-codec` decode session for the encoded-codec
     * (`opus`, future: `aac`) path of `pushTalkAudio`. Null until the
     * first frame arrives that needs decoding. Closed on `endTalkSession`.
     */
    opusDecode: { sessionId: string; nodeId: string } | null
    /**
     * Rate conversion for the RAW-PCM path — same lazy/keyed/torn-down
     * discipline as `opusDecode`, and the reason a 16 kHz talk channel no
     * longer drops the 22 050 Hz frames HomeKit / Alexa / a TTS engine push
     * at it (D281). Constructed with the talk session so its teardown cannot
     * be forgotten; it opens nothing until a frame needs converting.
     */
    readonly pcmTranscode: TalkPcmTranscoder
  } | null = null

  /**
   * Register the `intercom` cap when the camera advertises two-way
   * audio support. Server-WebRTC-shaped: `startSession` returns an
   * SDP offer, `handleAnswer` applies the browser's response, the
   * orchestrator pumps Opus RTP through the `audio-codec` cap (Opus
   * → PCM s16le @ camera rate, with resampling) and feeds the PCM
   * into `ReolinkIntercomSession` for IMA ADPCM encoding + transport
   * onto the camera's dedicated talk channel.
   *
   * The `audio-codec` cap is REQUIRED — without it (no audio-codec
   * addon installed) intercom can't function. We register the cap
   * regardless and surface the missing dep as a clear error from
   * `startSession`; this preserves the "cap visible in bindings/docs"
   * UX without falsely claiming readiness when audio decode isn't
   * available.
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
   * four call sites and written by nobody, while `session.sampleRate` was in
   * hand and only reaching a log line (D281).
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
    // `getProbeFlags<ReolinkProbeFlags>()` reads the `feature-probe` slice,
    // falling back to the flags the last successful probe persisted in
    // `deviceCache` until this session probes — same helper the `features`
    // getter uses.
    const probe = this.getProbeFlags<ReolinkProbeFlags>()
    if (probe.hasIntercom !== true) {
      // Diagnostic: make the silent early-return visible. This is the path
      // that hid the "intercom closes immediately" bug — on a fresh boot the
      // probe slice is empty here, so the cap was never registered and the UI
      // got a routing-layer failure with zero provider-side logs. The
      // retroactive call in `probeAndPersistFeatures()` re-enters this method
      // once `hasIntercom` is known; this debug line distinguishes
      // "not-yet-probed" from "probed-and-genuinely-unsupported".
      this.ctx.logger.debug(
        'intercom cap NOT registered — hasIntercom flag not set in probe slice (yet)',
        {
          tags: { deviceId: this.id },
          meta: { hasIntercom: probe.hasIntercom ?? null },
        },
      )
      return
    }
    this.intercomRegistered = true

    const provider: InferNativeProvider<typeof intercomCapability> = {
      startSession: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `ReolinkCamera: intercom deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        if (this.disabled) {
          throw new Error(
            'Reolink intercom: device is disabled — re-enable it before opening a talk session',
          )
        }
        const audioCodec = this.resolveAudioCodecApi()
        const api = await this.ensureApi()
        // Lazy-create the orchestrator on first session and keep it
        // around for the device's lifetime. The orchestrator's own
        // single-active-session guard handles repeated
        // `startSession` calls (closes the stale one first).
        //
        // Per-session settings are read fresh at start time so the
        // operator can tweak them between sessions without restarting
        // the device — the new orchestrator instance picks them up
        // (or, on subsequent starts on the same orchestrator, the
        // talkSession opened inside `start()` reads the live opts via
        // closure).
        if (!this.intercomOrchestrator) {
          this.intercomOrchestrator = new IntercomOrchestrator({
            deviceTag: `camera-${this.id}`,
            channel: this.getChannel(),
            api,
            logger: this.ctx.logger.withTags({ deviceId: this.id, scope: 'intercom' }),
            audioCodec,
            peerFactory: ({ logger }) => new WeriftIntercomPeer({ logger }),
            // Battery-cam pre-wake. Skip the wake on
            // wired cams so the handshake doesn't pay an extra
            // `getSleepStatus` round-trip for nothing.
            wakeBeforeStart: this.isBattery
              ? async () => {
                  await this.wakeForIntercom(api)
                }
              : undefined,
            ...(this.config.get('intercomBlocksPerPayload') !== undefined
              ? { blocksPerPayload: this.config.get('intercomBlocksPerPayload') }
              : {}),
            ...(this.config.get('intercomMaxBacklogMs') !== undefined
              ? { maxBacklogMs: this.config.get('intercomMaxBacklogMs') }
              : {}),
            ...(this.config.get('intercomGain') !== undefined
              ? { outputGain: this.config.get('intercomGain') }
              : {}),
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
            `Reolink intercom: handleAnswer with no active orchestrator (sessionId=${sessionId})`,
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
            `ReolinkCamera: intercom deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        if (this.disabled) {
          throw new Error(
            'Reolink intercom: device is disabled — re-enable it before opening a talk session',
          )
        }
        // Tear down any prior raw session before opening a fresh one —
        // single-active-session semantics mirror `IntercomOrchestrator.start`.
        // Codec sessions included: stopping only the camera leg here leaked an
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
        const api = await this.ensureApi()
        // Battery-cam pre-wake. Wired cams skip this.
        if (this.isBattery) {
          await this.wakeForIntercom(api)
        }
        const session = new ReolinkIntercomSession({
          channel: this.getChannel(),
          api,
          logger: this.ctx.logger.withTags({ deviceId: this.id, scope: 'intercom-raw' }),
          deviceTag: `camera-${this.id}`,
          ...(this.config.get('intercomBlocksPerPayload') !== undefined
            ? { blocksPerPayload: this.config.get('intercomBlocksPerPayload') }
            : {}),
          ...(this.config.get('intercomMaxBacklogMs') !== undefined
            ? { maxBacklogMs: this.config.get('intercomMaxBacklogMs') }
            : {}),
          ...(this.config.get('intercomGain') !== undefined
            ? { outputGain: this.config.get('intercomGain') }
            : {}),
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
            tag: `reolink-intercom-pcm:${this.id}:${id}`,
            feed: (pcm) => session.feedPcm(pcm),
          }),
        }
        this.publishIntercomState(true, session.ability)
        this.ctx.logger.info('intercom talk session opened', {
          tags: { deviceId: this.id },
          meta: { sessionId: id, sampleRate: session.sampleRate },
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
        // Drop out-of-order frames — the IMA ADPCM block predictor
        // would smear if a stale frame arrived after a newer one.
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
          this.ctx.logger.warn('intercom: dropping non-mono talk frame (Reolink is mono-only)', {
            tags: { deviceId: this.id },
            meta: { channels: ch, codec },
          })
          return { accepted: false }
        }

        if (wireCodec === 'g711ulaw' || wireCodec === 'g711alaw') {
          // Reolink's talk channel uses IMA ADPCM @ camera rate, not
          // G.711 — passthrough at this codec family would need a
          // cross-format transcode we don't implement.
          note(REASON_TALK_CODEC_UNSUPPORTED)
          this.ctx.logger.warn(
            'intercom: g711 passthrough not supported on Reolink (camera codec is ADPCM) — dropping frame',
            { tags: { deviceId: this.id }, meta: { wireCodec } },
          )
          return { accepted: false }
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
            // HomeKit and Alexa talk-back whenever the caller's rate differed
            // from the talk channel's. It is now a `pcm_s16le` decode session
            // — pure libswresample, opened lazily, reused for the session,
            // torn down with it and on error. The transcoder feeds the camera
            // itself; a frame it could not convert is still refused, loudly,
            // and nothing is fed (D281).
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
          // `sourceSampleRate` configures the resampler's input rate;
          // the node-av Opus decoder always emits at 48 kHz regardless
          // of the HAP-negotiated encoder rate, so we pin to 48 kHz
          // and let swr handle the 48→camera-rate downsample.
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
                tag: `reolink-intercom:${this.id}:${active.id}`,
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
          meta: { wireCodec },
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
    this.ctx.logger.info('intercom cap registered (WebRTC + audio-codec wiring active)', {
      tags: { deviceId: this.id },
    })
  }

  // ── Helpers for EncConfig ↔ StreamParamsStatus mapping ────────────────

  /**
   * Map one `CompressionStream` entry from the Baichuan `getEnc` reply
   * into the cap's `StreamProfileConfigSchema` shape.
   *
   * Returns `undefined` when the stream entry is absent or missing
   * mandatory fields — the cap omits the key rather than emitting
   * empty/zero data, which the UI treats as "profile not available".
   */
  private mapCompressionStreamToConfig(
    s: CompressionStream | undefined,
  ): StreamParamsStatus['main'] | undefined {
    if (!s) return undefined
    const width = typeof s.width === 'number' ? s.width : undefined
    const height = typeof s.height === 'number' ? s.height : undefined
    const framerate = typeof s.frame === 'number' ? s.frame : undefined
    const bitrate = typeof s.bitRate === 'number' ? s.bitRate : undefined
    // Wire field is a numeric enum: 0 = h264, 1 = h265. Some firmwares
    // also send string values (same normalizer used by the stream-broker).
    let codec: 'h264' | 'h265' | undefined
    if (typeof s.videoEncType === 'number') {
      codec = s.videoEncType === 1 ? 'h265' : 'h264'
    }
    // Missing mandatory fields → omit the profile from status.
    if (
      width === undefined ||
      height === undefined ||
      framerate === undefined ||
      bitrate === undefined ||
      codec === undefined
    )
      return undefined

    const config: StreamParamsStatus['main'] = { width, height, codec, framerate, bitrate }

    // Optional fields — present only on firmwares that report them.
    const rawEncoderProfile = typeof s.encoderProfile === 'string' ? s.encoderProfile : undefined
    if (
      rawEncoderProfile === 'high' ||
      rawEncoderProfile === 'main' ||
      rawEncoderProfile === 'baseline'
    ) {
      config.encoderProfile = rawEncoderProfile
    }
    const gopCur =
      typeof s.gop === 'object' && s.gop !== null && typeof s.gop.cur === 'number'
        ? s.gop.cur
        : undefined
    if (gopCur !== undefined) config.gop = gopCur

    const rawEncoderType = typeof s.encoderType === 'string' ? s.encoderType : undefined
    if (rawEncoderType === 'vbr' || rawEncoderType === 'cbr') {
      config.bitrateMode = rawEncoderType
    }

    if (typeof s.audio === 'number') config.audio = s.audio !== 0

    return config
  }

  /**
   * Map one `EncStreamOptions` entry from `getEncOptions` into the cap's
   * `StreamProfileOptionsSchema` shape.
   *
   * Returns `undefined` when the stream options are absent or carry no
   * resolutions — the cap omits the profile rather than emitting an
   * empty options block.
   */
  private mapEncStreamOptionsToProfileOptions(
    s: EncStreamOptions | undefined,
  ): StreamParamsOptions['main'] | undefined {
    if (!s || s.resolutions.length === 0) return undefined

    // Collect de-duped codecs / framerates / bitrates across all resolutions.
    const codecSet = new Set<'h264' | 'h265'>()
    const framerateSet = new Set<number>()
    const bitrateSet = new Set<number>()

    for (const res of s.resolutions) {
      for (const c of res.videoEncTypes) codecSet.add(c)
      for (const f of res.framerateOptions) framerateSet.add(f)
      for (const b of res.bitrateOptions) bitrateSet.add(b)
    }

    const resolutions = s.resolutions.map((r) => ({ width: r.width, height: r.height }))
    const codecs = Array.from(codecSet)
    const framerates = Array.from(framerateSet).toSorted((a, b) => a - b)
    const bitrates = Array.from(bitrateSet).toSorted((a, b) => a - b)

    // GOP range — `getEncOptions` (nodelink-js 0.4.14+) merges the live
    // `<gop>` block from `getEnc` and surfaces `{ cur, min, max }`. Map
    // it to the cap's `{ min, max, step }` descriptor so the UI renders
    // the I-frame interval as a selector. `step` is 1 — Reolink GOP is a
    // whole-second keyframe interval.
    const gr = s.gopRange
    const gop =
      gr && typeof gr.min === 'number' && typeof gr.max === 'number' && gr.max >= gr.min
        ? { min: gr.min, max: gr.max, step: 1 }
        : undefined

    return {
      resolutions,
      codecs: codecs as Array<'h264' | 'h265'>,
      framerates,
      bitrates,
      supportsBitrateMode: s.encoderTypes.length > 0,
      supportsEncoderProfile: s.encoderProfiles.length > 0,
      // Supported when the camera advertises a concrete range OR a
      // per-resolution `defaultGop` (the free-number fallback path).
      supportsGop: gop !== undefined || s.resolutions.some((r) => r.defaultGop !== undefined),
      ...(gop ? { gop } : {}),
    }
  }

  /**
   * Probe the camera's per-profile encoder OPTION lists
   * (`getEncOptions`, cmd_id 56-options) and map every advertised
   * stream into the cap's `StreamParamsOptions` shape.
   *
   * Single source of the `getEncOptions` round-trip + mapping —
   * shared by:
   *   - the `stream-params` cap's `getOptions` (live, on-demand);
   *   - `refreshParentSettingsSnapshot()`, which persists the result
   *     into `deviceCache.encOptionsSnapshot` so the editable Stream
   *     section in `getSettingsUISchema()` can render synchronously.
   *
   * Returns `{}` (no profiles) when the probe fails or the firmware
   * advertises nothing — callers treat that as "no Stream section".
   */
  private async probeStreamParamsOptions(): Promise<StreamParamsOptions> {
    const channel = this.getChannel()
    try {
      const api = await this.ensureApi()
      const encOptions = await api.getEncOptions(channel)
      const result: StreamParamsOptions = {}
      const main = this.mapEncStreamOptionsToProfileOptions(encOptions.mainStream)
      if (main !== undefined) result.main = main
      const sub = this.mapEncStreamOptionsToProfileOptions(encOptions.subStream)
      if (sub !== undefined) result.sub = sub
      const ext = this.mapEncStreamOptionsToProfileOptions(encOptions.thirdStream)
      if (ext !== undefined) result.ext = ext
      return result
    } catch (err) {
      this.ctx.logger.warn('stream-params: getEncOptions failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return {}
    }
  }

  /**
   * Push a `StreamProfilePatch` to one profile via `setEnc` (cmd_id 57).
   *
   * Single source of the cap-patch → `EncStreamPatch` translation +
   * `setEnc` write — shared by the `stream-params` cap's `setProfile`
   * and the editable Stream section's `applySettingsPatch` path so
   * there is exactly one place that talks to the encoder API.
   */
  private async applyStreamProfilePatch(
    profile: StreamProfile,
    patch: StreamProfilePatch,
  ): Promise<void> {
    const encPatch = buildEncStreamPatch(patch)
    if (Object.keys(encPatch).length === 0) return
    // Map cap profile name → Baichuan stream key.
    const streamKey =
      profile === 'main' ? 'mainStream' : profile === 'sub' ? 'subStream' : 'thirdStream'
    const api = await this.ensureApi()
    await api.setEnc(this.getChannel(), { [streamKey]: encPatch })
    // Encoder profile changed → codec/resolution in the cached catalog may be
    // stale. Drop it so the next pull rebuilds from the camera.
    this.cachedStreamDescriptors = undefined
  }

  // ── Device-config cap read discipline ────────────────────────────────
  //
  // The device-detail page drives `deviceManager.getDeviceAggregate`,
  // which calls `getOptions` + `getStatus` on EVERY bound device-config
  // cap (`stream-params`, `motion-zones`, `privacy-mask`, `day-night`,
  // `image-settings`, `ptz`) — and the admin UI re-polls that aggregate
  // every 2.5s while the Config tab is open. Naively that is ~7 Baichuan
  // round-trips every 2.5s per camera: enough to wake a sleeping battery
  // camera just by visiting the page, and to keep it awake for as long as
  // the tab stays open. The two helpers below are the discipline that the
  // rest of the driver already applies to snapshots, the sessions tab and
  // the stream catalog, finally applied to the cap surface:
  //
  //   `resolveCapOptions` — options are STATIC per camera model, so read
  //     them once, persist them, and serve the blob (never the radio)
  //     until the TTL expires. A sleeping battery cam is never probed.
  //   `sleepGatedRefresh`  — wraps a status refresh so a READ never wakes
  //     a sleeping battery cam; the bridge then projects the last known
  //     slice. Write paths keep calling the raw refresh (an operator
  //     write already woke the camera and must observe firmware clamping).

  /** How long a persisted `getOptions` descriptor stays authoritative.
   *  These describe model capabilities (advertised ranges, codec sets,
   *  supported axes), not runtime state — they change on a firmware
   *  update, not during operation. 6h keeps a firmware upgrade visible
   *  within a day while removing the per-poll round-trip entirely. */
  private static readonly CAP_OPTIONS_TTL_MS = 6 * 60 * 60_000

  /**
   * Per-cap epoch-ms until which a FAILED options probe is not re-attempted.
   *
   * The same discipline `createRuntimeStateBridge` applies to a refresh that
   * did not land, for the same reason and against the same measurement. A probe
   * that fails persists nothing, so without this the next caller probes again —
   * and on a camera that is merely unreachable each attempt burns the full
   * connect give-up. Measured on the live hub (2026-08-21, device 3629, a
   * battery Reolink the registry already calls offline): `getOptions` took
   * **23.1s on every single call**, while its `getStatus` sibling answered in
   * 8ms because the bridge had already opened its cooldown. The status side was
   * bounded and the options side was not, and only one of them was visible.
   */
  private readonly capOptionsMissCooldownUntil = new Map<string, number>()

  /**
   * Per-cap in-flight options probe, so concurrent callers share ONE.
   *
   * The cooldown above only opens once a probe has FAILED — and on an
   * unreachable camera that takes the full connect give-up (23.1s measured on
   * device 3629). Every poll arriving inside that window used to start its own
   * probe, so the cooldown never got a chance to bound anything: the fix for
   * "one dial per poll" has to cover the dial that is still in the air.
   *
   * A caller that finds one here is SERVED, not queued behind it — this method
   * sits on a polled path, and waiting for a probe that is not coming back is
   * how one unreachable camera stalls every poll it overlaps.
   */
  private readonly capOptionsInFlight = new Map<string, Promise<unknown>>()

  /**
   * Read a persisted `getOptions` descriptor, validated with the cap's
   * OWN Zod schema. Validation (not a cast) is what makes the
   * `z.unknown()` blob type-safe: an entry written by an older addon
   * whose shape no longer parses is simply discarded, and the caller
   * re-probes.
   */
  private readCapOptionsCache<T>(
    capName: string,
    schema: z.ZodType<T>,
  ): { value: T; fetchedAt: number } | null {
    const entry = this.config.get('deviceCache')?.capOptionsSnapshot?.[capName]
    if (!entry) return null
    const parsed = schema.safeParse(entry.value)
    if (!parsed.success) return null
    return { value: parsed.data, fetchedAt: entry.fetchedAt }
  }

  /** Persist a freshly-probed descriptor. Best-effort — a failed write
   *  only costs the next caller another probe. */
  private async persistCapOptions(capName: string, value: unknown): Promise<void> {
    try {
      const current = this.config.get('deviceCache') ?? {}
      await this.config.setAll({
        deviceCache: {
          ...current,
          capOptionsSnapshot: {
            ...current.capOptionsSnapshot,
            [capName]: { value, fetchedAt: Date.now() },
          },
          // Group-level stamp (D346) alongside the per-cap `fetchedAt`
          // above, so the freshness panel reads every group the same way.
          snapshotFetchedAt: stampSnapshotFreshness(
            current.snapshotFetchedAt,
            ['capOptionsSnapshot'],
            Date.now(),
          ),
        },
      })
    } catch (err) {
      this.ctx.logger.debug('cap options persist failed', {
        tags: { deviceId: this.id },
        meta: { capName, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Resolve a device-config cap's `getOptions` descriptor without
   * touching a sleeping camera and without re-probing on every
   * aggregate poll.
   *
   * Order of resolution:
   *   1. fresh persisted entry (within `CAP_OPTIONS_TTL_MS`) → serve it;
   *   2. battery cam believed asleep → serve the stale persisted entry
   *      if we have one, otherwise `fallback()`. NEVER probes: this is
   *      the path a page visit takes on a sleeping doorbell.
   *   3. otherwise probe the camera, persist, serve.
   * A probe failure falls back to the stale entry, then `fallback()`.
   */
  private async resolveCapOptions<T>(params: {
    readonly capName: string
    readonly schema: z.ZodType<T>
    readonly probe: () => Promise<T>
    readonly fallback: () => T
  }): Promise<T> {
    const { capName, schema, probe, fallback } = params
    // A probe for this cap is already in the air. Do not start a second dial at
    // the same camera, and do not JOIN the first either — answer with what we
    // have. On an unreachable camera that probe costs the full connect give-up
    // (23.1s, measured on device 3629) and a cooldown that only opens once it
    // has FAILED cannot bound what is still outstanding: every 5s poll landing
    // inside those 23s spent the caller's whole 1.2s source budget waiting for
    // an answer that was never coming.
    const cached = this.readCapOptionsCache(capName, schema)
    if (this.capOptionsInFlight.has(capName)) return cached?.value ?? fallback()
    if (cached && Date.now() - cached.fetchedAt < ReolinkCamera.CAP_OPTIONS_TTL_MS) {
      this.capOptionsMissCooldownUntil.delete(capName)
      return cached.value
    }
    if (this.isBattery && this.sleeping) {
      this.ctx.logger.debug('cap options: battery cam sleeping — serving cache, not probing', {
        tags: { deviceId: this.id },
        meta: { capName, hasCache: cached !== null },
      })
      return cached?.value ?? fallback()
    }
    // A probe that already failed inside the cooldown must not be paid for
    // again: this method is on a POLLED path (`getCameraStatuses` reads
    // `privacyMask.getOptions` per camera every 5s), and an unreachable camera
    // costs the full connect give-up every time.
    const cooldownUntil = this.capOptionsMissCooldownUntil.get(capName) ?? 0
    if (Date.now() < cooldownUntil) return cached?.value ?? fallback()

    const started = probe()
    this.capOptionsInFlight.set(capName, started)
    try {
      const value = await started
      await this.persistCapOptions(capName, value)
      this.capOptionsMissCooldownUntil.delete(capName)
      return value
    } catch (err) {
      this.capOptionsMissCooldownUntil.set(
        capName,
        Date.now() + RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS,
      )
      // WARN, not debug: a cap that has been answering `fallback()` for an hour
      // is exactly the silence that makes an unreachable camera look configured.
      this.ctx.logger.warn(
        'cap options probe failed — serving cache/fallback and not re-probing for a minute',
        {
          tags: { deviceId: this.id },
          meta: {
            capName,
            cooldownMs: RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS,
            hasCache: cached !== null,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
      return cached?.value ?? fallback()
    } finally {
      if (this.capOptionsInFlight.get(capName) === started) this.capOptionsInFlight.delete(capName)
    }
  }

  /**
   * Per-cap "warm the cache while the camera is up" closures, registered
   * by each device-config cap alongside its provider and run by
   * `onWakeTransition`.
   *
   * This is the OTHER half of the read discipline. Gating reads stops us
   * waking the camera, but on its own it leaves the caches empty — and an
   * empty cache is what the operator actually sees: the State panel reads
   * the runtime-state slices (`deviceState.getAllSnapshots`), so a
   * sleeping camera whose slices were never written shows null for
   * everything. Before the gate, the admin UI's 2.5s aggregate poll kept
   * those slices warm by waking the camera every time — the very bug we
   * fixed. So the refresh has to move to the moment the camera is
   * ALREADY up, which is exactly the wake transition.
   */
  private readonly capWarmers = new Map<string, () => Promise<void>>()

  /** How fresh a slice must be for the wake warm-up to skip it. A battery
   *  cam can wake many times an hour on motion; re-probing every cap on
   *  every wake would spend the (~14s) window on data we already have. */
  private static readonly WAKE_WARM_MAX_AGE_MS = 10 * 60_000

  private registerCapWarmer(capName: string, warm: () => Promise<void>): void {
    this.capWarmers.set(capName, warm)
  }

  /**
   * Refresh the device-config cap caches during a wake window.
   *
   * SERIALIZED, like every other wake-path refresh — concurrent Baichuan
   * traffic on the single BCUDP stream starves the heavy reads. Each cap
   * is skipped when its slice is still fresh, and each failure is
   * swallowed: the window is short, partial progress accumulates across
   * wakes because the slices persist.
   */
  private async warmCapSlicesOnWake(opts?: CapWarmOptions): Promise<CapWarmOutcome> {
    const now = Date.now()
    let warmed = 0
    let skipped = 0
    for (const [capName, warm] of this.capWarmers) {
      const slice = this.runtimeState.getCapState<{ lastFetchedAt?: number }>(capName)
      const fetchedAt = typeof slice?.lastFetchedAt === 'number' ? slice.lastFetchedAt : 0
      // `force` is the operator's button. The freshness skip is right for an
      // automatic warm — the camera just woke and most slices are minutes old
      // — and wrong for a request whose entire purpose is to distrust what we
      // already believe.
      if (
        opts?.force !== true &&
        fetchedAt > 0 &&
        now - fetchedAt < ReolinkCamera.WAKE_WARM_MAX_AGE_MS
      ) {
        skipped += 1
        continue
      }
      try {
        await warm()
        warmed += 1
      } catch (err) {
        this.ctx.logger.debug('wake warm-up: cap refresh failed — retrying on next wake', {
          tags: { deviceId: this.id },
          meta: { capName, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    this.ctx.logger.info('wake warm-up: cap caches refreshed', {
      tags: { deviceId: this.id },
      meta: { warmed, skipped, total: this.capWarmers.size },
    })
    return { warmed, skipped }
  }

  /**
   * Ask the snapshot wrapper for a frame while the camera is up, so its
   * cache holds something recent to serve for the whole sleep window.
   *
   * The wrapper already does the right thing on a miss — `resolveOutcome`
   * falls back to the stale frame rather than blanking the UI — but only
   * if a frame was ever captured. With reads gated, nothing captures one
   * any more: the tile stayed empty for as long as the camera slept.
   * `force: true` bypasses the wrapper's freshness gate; our own
   * proactive gate lets it through because `sleeping` is false here.
   * Mirrors the reference's `updateBatteryAndSnapshot`.
   */
  /** The scheduled refresh's snapshot step: true only when the cache really moved. */
  private refreshSnapshotCache(): Promise<boolean> {
    return refreshSnapshotCacheOnce({
      deviceId: this.id,
      logger: this.ctx.logger,
      now: () => Date.now(),
      api: {
        getSnapshot: (input) => this.ctx.api.snapshot.getSnapshot.query(input),
        getSnapshotOverview: (input) =>
          this.ctx.api.snapshot.getSnapshotOverview.query({ deviceIds: [...input.deviceIds] }),
      },
    })
  }

  private async warmSnapshotOnWake(): Promise<void> {
    try {
      await this.ctx.api.snapshot.getSnapshot.query({ deviceId: this.id, force: true })
      this.ctx.logger.debug('wake warm-up: snapshot cache refreshed', {
        tags: { deviceId: this.id },
      })
    } catch (err) {
      this.ctx.logger.debug('wake warm-up: snapshot refresh failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Wrap a cap's `refreshFromCamera` so the READ side (the bridge's
   * stale-check behind `getStatus`) never wakes a sleeping battery cam.
   * The bridge then projects whatever the slice last held — which is
   * exactly what the operator should see for a camera that is asleep.
   *
   * Only the bridge gets the wrapped version; `setX` mutations keep the
   * raw refresh so a write still re-reads the firmware's clamped result.
   */
  private sleepGatedRefresh(capName: string, refresh: () => Promise<void>): () => Promise<void> {
    return async (): Promise<void> => {
      if (this.isBattery && this.sleeping) {
        this.ctx.logger.debug('cap status refresh skipped — battery cam is sleeping', {
          tags: { deviceId: this.id },
          meta: { capName },
        })
        return
      }
      await refresh()
    }
  }

  /**
   * Register the `stream-params` native cap provider.
   *
   * Uses the trampoline pattern (CLAUDE.md "Provider trampoline pattern"):
   * source of truth is `runtimeState['stream-params']`, kept fresh via a
   * `createRuntimeStateBridge` with a `refresh` that round-trips `getEnc`.
   *
   * - `getStatus`  — slice-driven via bridge (stale → refresh from camera,
   *                  sleep-gated so a read never wakes a battery cam).
   * - `getOptions` — persisted descriptor via `resolveCapOptions`; the
   *                  `getEncOptions` round-trip runs at most once per TTL.
   * - `setProfile` — translates cap patch → `EncStreamPatch`, calls
   *                  `setEnc`, then refreshes the slice.
   */
  private registerStreamParamsCap(): void {
    const channel = this.getChannel()
    const CAP_NAME = 'stream-params' as const

    /** Round-trip `getEnc`, map into the cap status schema, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.streamParamsRefreshInFlight) return this.streamParamsRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          const enc = await api.getEnc(channel)
          const compression = enc?.body?.Compression
          if (!compression) {
            this.ctx.logger.debug('stream-params: getEnc returned no Compression block', {
              tags: { deviceId: this.id },
            })
            return
          }
          const next: StreamParamsStatus = { lastFetchedAt: Date.now() }
          const main = this.mapCompressionStreamToConfig(compression.mainStream)
          if (main !== undefined) next.main = main
          const sub = this.mapCompressionStreamToConfig(compression.subStream)
          if (sub !== undefined) next.sub = sub
          const ext = this.mapCompressionStreamToConfig(compression.thirdStream)
          if (ext !== undefined) next.ext = ext
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('stream-params refresh failed — keeping last slice', {
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
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      // The Config tab must never WAIT on a camera. `getDeviceAggregate` calls
      // this bridge's `getStatus` on a 2.5 s poll and the derived-form
      // contributions carry no deadline, so `await-refresh` here IS the tab's
      // spinner — on 3825 it sat on "Loading device aggregate…" until
      // something else woke the camera. These values move only when an
      // operator moves them, and every `set*` below re-reads the camera, so a
      // CamStack write is its own invalidation and the window bounds only a
      // change made in the Reolink app (D224, the shape `privacy-mask`
      // already uses).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: (): StreamParamsStatus => ({ lastFetchedAt: 0 }),
    })

    const resolveOptions = async (): Promise<StreamParamsOptions> =>
      this.resolveCapOptions({
        capName: CAP_NAME,
        schema: StreamParamsOptionsSchema,
        // Shared `getEncOptions` round-trip + mapping — see
        // `probeStreamParamsOptions` (also feeds `encOptionsSnapshot`).
        probe: () => this.probeStreamParamsOptions(),
        fallback: (): StreamParamsOptions => ({}),
      })

    const provider: InferNativeProvider<typeof streamParamsCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<StreamParamsOptions> => {
        if (deviceId !== this.id) return {}
        return resolveOptions()
      },

      getConfigSchema: async ({ deviceId }): Promise<ConfigUISchema | null> => {
        if (deviceId !== this.id) return null
        // Server-built form: camera-probed availability (`getOptions`) +
        // current per-profile config (status slice, refreshed if stale).
        // `buildStreamParamsConfigSchema` is the shared, addon-free
        // schema-shaper in `@camstack/types` — Hikvision feeds it the
        // same way so both cameras emit a structurally identical form.
        const opts = await resolveOptions()
        await bridge.ensureFresh()
        const status = this.runtimeState.getCapState<StreamParamsStatus>(CAP_NAME) ?? null
        return buildStreamParamsConfigSchema(opts, status)
      },

      setProfile: async ({ deviceId, profile, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        // Shared cap-patch → `setEnc` write — see `applyStreamProfilePatch`
        // (also used by the editable Stream section's `applySettingsPatch`).
        await this.applyStreamProfilePatch(profile, patch)
        // Re-read so the slice reflects any clamping the firmware applied.
        await refreshFromCamera()
        // Nudge the stream-broker to re-pull this camera's catalog (codec /
        // resolution may have changed). Lossy by design — the broker's poll
        // reconcile is the backstop.
        this.ctx.eventBus.emit(
          createEvent(EventCategory.StreamParamsChanged, this.eventSource(), { deviceId: this.id }),
        )
      },
    }

    // Warm this cap's cache during a wake window (see `capWarmers`):
    // options first (persisted, probed at most once per TTL), then the
    // status slice — so a sleeping camera always has something real to
    // serve instead of a cold-start default.
    this.registerCapWarmer(CAP_NAME, async () => {
      await provider.getOptions({ deviceId: this.id })
      await refreshFromCamera()
    })
    this.ctx.registerNativeCap(streamParamsCapability, provider)
    this.ctx.logger.info('Reolink stream-params cap registered', {
      tags: { deviceId: this.id },
    })
  }

  /**
   * Parse a `getMotionAlarm` (cmd_id 46) response into a `MotionZoneScope`
   * plus the cap-facing `enabled` / `sensitivity` (user-facing 1..50).
   *
   * The Baichuan motion-detection node carries `enable`, `sensitivityDefault`,
   * the effective region `width`/`height`, and a `scope` with the bitmap
   * `columns`/`rows`/`valueTable`. Geometry is located structurally — see
   * `findRecordWithKey` — because the response nesting varies by firmware.
   * When the camera reports no `valueTable` (cold start) the scope falls
   * back to `fullCoverageScope` so the grid is never empty.
   */
  private parseMotionAlarm(raw: unknown): {
    enabled: boolean
    sensitivity: number
    scope: MotionZoneScope
  } {
    const scopeNode = findRecordWithKey(raw, 'columns')
    const columns = coerceNumber(scopeNode?.['columns']) ?? 0
    const rows = coerceNumber(scopeNode?.['rows']) ?? 0

    // The effective-region node carries `width`/`height`; it usually sits
    // one level above `scope`. Search the whole tree so a deeper nesting
    // still resolves.
    const regionNode = findRecordWithKey(raw, 'width')
    const width = coerceNumber(regionNode?.['width']) ?? columns
    const height = coerceNumber(regionNode?.['height']) ?? rows

    const enableNode = findRecordWithKey(raw, 'enable')
    const enabled = coerceNumber(enableNode?.['enable']) === 1

    const sensNode = findRecordWithKey(raw, 'sensitivityDefault')
    const rawSensitivity = coerceNumber(sensNode?.['sensitivityDefault'])

    const valueTableRaw = scopeNode?.['valueTable']
    const valueTable = typeof valueTableRaw === 'string' ? valueTableRaw : ''

    let scope: MotionZoneScope
    if (valueTable.trim() !== '' && columns > 0 && rows > 0) {
      scope = decodeMotionScopeBitmap(valueTable, columns, rows, width, height)
    } else {
      // Cold start / no zone configured — treat the whole region as active.
      scope = fullCoverageScope(
        columns > 0 ? columns : width,
        rows > 0 ? rows : height,
        width,
        height,
      )
    }

    return {
      enabled,
      sensitivity: rawSensitivity !== null ? invertReolinkSensitivity(rawSensitivity) : 1,
      scope,
    }
  }

  /**
   * Register the `motion-zones` native cap provider.
   *
   * Mirrors `registerStreamParamsCap`: the trampoline pattern over
   * `createRuntimeStateBridge`, with a single-flight `refresh` that
   * round-trips `getMotionAlarm`. The camera's grid geometry is cached
   * (`motionZonesGrid`) so `setZone` can re-encode a `cells` patch
   * without an extra GET.
   *
   * - `getStatus`  — slice-driven via bridge (stale → refresh).
   * - `getOptions` — on-demand `getMotionAlarm`; reports the EFFECTIVE
   *                  region (`width`/`height`), not the bitmap canvas.
   * - `setZone`    — read-modify-write via `setMotionAlarmFull`; only
   *                  the patch's present fields are written. A `cells`
   *                  patch is encoded into a fresh `valueTable`.
   */
  private registerMotionZonesCap(): void {
    const channel = this.getChannel()
    const CAP_NAME = 'motion-zones' as const

    /** Round-trip `getMotionAlarm`, map into the cap status schema, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.motionZonesRefreshInFlight) return this.motionZonesRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          const raw = await api.getMotionAlarm(channel)
          const { enabled, sensitivity, scope } = this.parseMotionAlarm(raw)
          this.motionZonesGrid = {
            columns: scope.columns,
            rows: scope.rows,
            width: scope.width,
            height: scope.height,
          }
          const next: MotionZoneStatus = {
            enabled,
            sensitivity,
            regions: [
              {
                id: 0,
                enabled: true,
                shape: {
                  kind: 'grid',
                  gridWidth: scope.width,
                  gridHeight: scope.height,
                  cells: scope.cells,
                },
              },
            ],
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('motion-zones refresh failed — keeping last slice', {
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
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      // The Config tab must never WAIT on a camera. `getDeviceAggregate` calls
      // this bridge's `getStatus` on a 2.5 s poll and the derived-form
      // contributions carry no deadline, so `await-refresh` here IS the tab's
      // spinner — on 3825 it sat on "Loading device aggregate…" until
      // something else woke the camera. These values move only when an
      // operator moves them, and every `set*` below re-reads the camera, so a
      // CamStack write is its own invalidation and the window bounds only a
      // change made in the Reolink app (D224, the shape `privacy-mask`
      // already uses).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: (): MotionZoneStatus => ({
        enabled: false,
        sensitivity: 1,
        regions: [],
        lastFetchedAt: 0,
      }),
    })

    const provider: InferNativeProvider<typeof motionZonesCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<MotionZoneOptions> => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        return this.resolveCapOptions({
          capName: CAP_NAME,
          schema: MotionZoneOptionsSchema,
          probe: async (): Promise<MotionZoneOptions> => {
            const api = await this.ensureApi()
            const raw = await api.getMotionAlarm(channel)
            const { scope } = this.parseMotionAlarm(raw)
            this.motionZonesGrid = {
              columns: scope.columns,
              rows: scope.rows,
              width: scope.width,
              height: scope.height,
            }
            // The editor sizes itself from the EFFECTIVE region, not the
            // bitmap canvas (`columns`/`rows`).
            return {
              maxRegions: 1,
              supportedShapes: ['grid'],
              grid: { width: scope.width, height: scope.height },
              sensitivity: { min: 1, max: 50, step: 1 },
            }
          },
          // No grid geometry known yet (cold cache + sleeping cam).
          // Advertise NO shapes — same convention as `privacy-mask`'s
          // `maxNum === 0` branch — so the editor renders its
          // "not available" state instead of an invented canvas whose
          // cell count the camera would reject on save.
          fallback: (): MotionZoneOptions => ({
            maxRegions: 1,
            supportedShapes: [],
            grid: { width: 0, height: 0 },
            sensitivity: { min: 1, max: 50, step: 1 },
          }),
        })
      },

      setZone: async ({ deviceId, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        const api = await this.ensureApi()

        // The grid cells live in the single `grid` region. Re-encoding the
        // bitmap needs the camera's grid geometry — read it fresh if not cached.
        const gridRegion = patch.regions?.find((r) => r.shape.kind === 'grid')
        const cells =
          gridRegion && gridRegion.shape.kind === 'grid' ? gridRegion.shape.cells : undefined

        let valueTable: string | undefined
        if (cells !== undefined) {
          let grid = this.motionZonesGrid
          if (!grid) {
            const probed = this.parseMotionAlarm(await api.getMotionAlarm(channel))
            grid = {
              columns: probed.scope.columns,
              rows: probed.scope.rows,
              width: probed.scope.width,
              height: probed.scope.height,
            }
            this.motionZonesGrid = grid
          }
          const expected = grid.width * grid.height
          if (cells.length !== expected) {
            throw new Error(
              `motion-zones: cells length ${cells.length} does not match ` +
                `grid ${grid.width}×${grid.height} (${expected})`,
            )
          }
          const scope: MotionZoneScope = {
            columns: grid.columns,
            rows: grid.rows,
            width: grid.width,
            height: grid.height,
            cells,
          }
          valueTable = encodeMotionScopeBitmap(scope)
        }

        // Read-modify-write — pass only the fields the patch carries so
        // `setMotionAlarmFull` leaves the rest untouched.
        const opts: {
          channel: number
          enabled?: boolean
          sensitivity?: number
          valueTable?: string
        } = { channel }
        if (patch.enabled !== undefined) opts.enabled = patch.enabled
        if (patch.sensitivity !== undefined) {
          // Cap value is user-facing 1..50; the camera wants the raw
          // inverted value.
          opts.sensitivity = invertReolinkSensitivity(patch.sensitivity)
        }
        if (valueTable !== undefined) opts.valueTable = valueTable

        await api.setMotionAlarmFull(opts)
        // Re-read so the slice reflects any clamping the firmware applied.
        await refreshFromCamera()
      },
    }

    // Warm this cap's cache during a wake window (see `capWarmers`):
    // options first (persisted, probed at most once per TTL), then the
    // status slice — so a sleeping camera always has something real to
    // serve instead of a cold-start default.
    this.registerCapWarmer(CAP_NAME, async () => {
      await provider.getOptions({ deviceId: this.id })
      await refreshFromCamera()
    })
    this.ctx.registerNativeCap(motionZonesCapability, provider)
    this.ctx.logger.info('Reolink motion-zones cap registered', {
      tags: { deviceId: this.id },
    })
  }

  // ── Privacy-mask cap ──────────────────────────────────────────────

  /**
   * Register the `privacy-mask` cap (rectangle-native).
   *
   * READ: `api.getMaskZones(channel)` (cmd 52) returns the master `enable`
   * flag plus a normalized `shelterList` of up to `maxNum` rectangles
   * (0..1 coords). Each enabled rect maps 1:1 onto a cap `PrivacyMaskRegion`.
   *
   * WRITE: `api.setMaskZones(channel, { enable?, shelterList? })` (cmd 53,
   * read-modify-write of cmd 52). The cap models privacy as ≤ `maxRegions`
   * rectangles, so we forward the enabled regions straight through — the lib
   * pads to the camera's maxNum with disabled zero-rects and re-encodes each
   * 0..1 rect into the firmware-specific packed-int `(pixel << 16) | canvas`
   * coords. The master `enable` flag rides the same call.
   */
  /**
   * Every `<Compression>` stream block of this camera that reports an audio
   * flag, with its current value.
   *
   * A block whose `audio` field is absent is OMITTED, not reported as `false`
   * — "this firmware does not expose an audio flag" and "the microphone is
   * off" are different answers, and only the second justifies offering the
   * operator a switch. An empty array is the honest "no controllable audio
   * input here".
   */
  private async readStreamAudioProfiles(): Promise<
    ReadonlyArray<{ readonly streamKey: ReolinkAudioStreamKey; readonly audioEnabled: boolean }>
  > {
    const api = await this.ensureApi()
    const compression = (await api.getEnc(this.getChannel()))?.body?.Compression
    if (!compression) return []
    const out: Array<{ streamKey: ReolinkAudioStreamKey; audioEnabled: boolean }> = []
    for (const streamKey of REOLINK_AUDIO_STREAM_KEYS) {
      const raw = compression[streamKey]?.audio
      if (typeof raw !== 'number') continue
      out.push({ streamKey, audioEnabled: raw !== 0 })
    }
    return out
  }

  private registerPrivacyMaskCap(): void {
    const channel = this.getChannel()
    const CAP_NAME = 'privacy-mask' as const

    const refreshFromCamera = async (): Promise<void> => {
      if (this.privacyMaskRefreshInFlight) return this.privacyMaskRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          // Normalized read: the lib decodes the packed-int `<shelterList>`
          // (cmd 52) into 0..1 rectangles + the master enable flag.
          // The microphone lives on a different command (cmd 56) — fetched
          // alongside so one `getStatus` costs one round of I/O, and
          // best-effort so a firmware that rejects `getEnc` still yields a
          // usable mask read.
          const [zones, audioProfiles] = await Promise.all([
            api.getMaskZones(channel),
            this.readStreamAudioProfiles().catch((): readonly [] => []),
          ])
          // A camera reporting maxNum=0 cannot store privacy masks —
          // setMaskZones writes an empty <shelterList/> and the read comes back
          // empty. (debug — fires on every refresh.)
          this.ctx.logger.debug('reolink privacy-mask getMaskZones', {
            tags: { deviceId: this.id },
            meta: {
              maxNum: zones.maxNum,
              shelters: zones.shelterList.length,
              enabled: zones.shelterList.filter((r) => r.enable).length,
            },
          })
          const regions: PrivacyMaskRegion[] = zones.shelterList
            .filter((r) => r.enable)
            .map((r) => ({
              id: r.id,
              enabled: true,
              shape: { kind: 'rect', x: r.x, y: r.y, width: r.width, height: r.height },
            }))
          const next: PrivacyMaskStatus = {
            enabled: zones.enable,
            regions,
            audioEnabled: summarisePrivacyAudio(audioProfiles),
            lastFetchedAt: Date.now(),
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('reolink privacy-mask refresh failed — keeping last slice', {
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
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      // The mask and the microphone move only when an operator moves them, and
      // `setMask` / `setAudioEnabled` below both re-read the camera into this
      // slice — so a write is its own invalidation and the window only bounds a
      // change made in the Reolink app. Served-and-revalidated because the
      // fleet-wide `getCameraStatuses` polls this cap every 5s per camera and
      // must never put a camera round trip on that request path (D221).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      // Deliberately NO bridge logger, unlike the other providers: this
      // provider's refresh is `sleepGatedRefresh`, so on a sleeping battery
      // camera it does nothing BY DESIGN and `lastFetchedAt` never advances.
      // The bridge cannot tell that apart from a camera that stopped answering,
      // so its miss line would be a permanent false alarm — measured at 4 lines
      // per 5 minutes per sleeping camera, on cameras that are perfectly fine.
      // A real Reolink failure is not silent: `resolveCapOptions` warns with the
      // firmware's own error, tagged with the same deviceId.
      empty: (): PrivacyMaskStatus => ({
        enabled: false,
        // `null`, never `[]` — see the cap's `regions` doc. This provider is
        // the one that PROVES it matters: `sleepGatedRefresh` does nothing on
        // a sleeping battery camera BY DESIGN, so its slice can stay cold for
        // days and every reader was told "no zones are configured".
        regions: null,
        // Never `false` on a cold slice — a sleeping battery camera we have
        // not asked yet must not render as "the operator muted this".
        audioEnabled: null,
        lastFetchedAt: 0,
      }),
    })

    const provider: InferNativeProvider<typeof privacyMaskCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<PrivacyMaskOptions> => {
        // Reolink shelter zones are rectangles only.
        // A descriptor built WITHOUT asking this camera never advertises a
        // microphone switch — the group would render a control that writes
        // nothing.
        if (deviceId !== this.id)
          return { maxRegions: 4, supportedShapes: ['rect'], supportsAudioMute: false }
        return this.resolveCapOptions({
          capName: CAP_NAME,
          schema: PrivacyMaskOptionsSchema,
          probe: async (): Promise<PrivacyMaskOptions> => {
            const api = await this.ensureApi()
            const [zones, audioProfiles] = await Promise.all([
              api.getMaskZones(channel),
              this.readStreamAudioProfiles().catch((): readonly [] => []),
            ])
            // Report the camera's REAL capacity. maxNum=0 → this model can't
            // store privacy masks; advertise 0 supported shapes so the UI shows
            // "not supported" instead of letting the operator draw a mask the
            // camera silently drops. Only a failed READ falls back to 4.
            // (nodelink-js >= 0.4.24 derives maxNum from maxTrackShelterNum when
            // the camera firmware omits the <maxNum> tag — e.g. E1 Outdoor PoE.)
            return {
              maxRegions: zones.maxNum,
              supportedShapes: zones.maxNum > 0 ? ['rect'] : [],
              // Probed: true only when at least one stream block actually
              // reported an `audio` flag we know how to write back.
              supportsAudioMute: audioProfiles.length > 0,
            }
          },
          // READ unavailable (transient failure, or a sleeping battery cam
          // with a cold cache) — assume the common Reolink default so the
          // editor stays usable; a real maxNum=0 is reported by the probe.
          // `supportsAudioMute` gets the OPPOSITE treatment: a fallback that
          // guessed `true` would render a microphone switch on a camera we
          // never reached, which is the one thing the switch group must not
          // do.
          fallback: (): PrivacyMaskOptions => ({
            maxRegions: 4,
            supportedShapes: ['rect'],
            supportsAudioMute: false,
          }),
        })
      },

      setMask: async ({ deviceId, patch }): Promise<void> => {
        if (deviceId !== this.id) return
        // DEBUG: trace the save payload end-to-end (UI → provider → camera).
        this.ctx.logger.info('reolink privacy-mask setMask: PAYLOAD', {
          tags: { deviceId: this.id },
          meta: { patch: JSON.stringify(patch) },
        })

        const api = await this.ensureApi()

        // Single read-modify-write (cmd 53): the master `enable` flag and the
        // rectangular `shelterList` ship together. Only enabled regions are
        // sent; the lib pads to the camera's maxNum with disabled zero-rects
        // and re-encodes each 0..1 rect into the firmware-specific packed-int
        // `(pixel << 16) | canvas` coords.
        const setPatch: { enable?: boolean; shelterList?: ShelterRect[] } = {}
        if (patch.enabled !== undefined) setPatch.enable = patch.enabled
        if (patch.regions !== undefined) {
          setPatch.shelterList = patch.regions
            .filter((r) => r.enabled)
            .map((r) => {
              const rect = privacyShapeToRect(r.shape)
              return {
                id: r.id,
                enable: true,
                layer: 0,
                color: 0,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              }
            })
        }
        if (setPatch.enable !== undefined || setPatch.shelterList !== undefined) {
          this.ctx.logger.info('reolink privacy-mask setMask: WRITING to camera (setMaskZones)', {
            tags: { deviceId: this.id },
            meta: { setPatch: JSON.stringify(setPatch) },
          })
          await api.setMaskZones(channel, setPatch)
        } else {
          this.ctx.logger.warn(
            'reolink privacy-mask setMask: nothing to write (no enable + no regions)',
            {
              tags: { deviceId: this.id },
            },
          )
        }

        // Refresh so the slice reflects the accepted camera state.
        await refreshFromCamera()
        this.ctx.logger.info('reolink privacy-mask setMask: CAMERA STATE AFTER', {
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
        // EVERY stream block, in ONE `setEnc`. Reolink stores the flag per
        // stream and lets them disagree; leaving the sub stream audible while
        // reporting the microphone off would be a lie the operator could not
        // see. One call because `setEnc` is a whole-config read-modify-write
        // — three sequential ones would each re-read and re-write the encoder.
        const profiles = await this.readStreamAudioProfiles()
        if (profiles.length === 0) {
          // Refused, and said out loud: a silent no-op here is a switch that
          // reports success for a write the camera never took.
          this.ctx.logger.warn('reolink privacy audio: camera reports NO audio flag — refusing', {
            tags: { deviceId: this.id },
          })
          throw new Error(
            `device ${String(this.id)}: this camera exposes no controllable audio input`,
          )
        }
        const value = enabled ? 1 : 0
        const api = await this.ensureApi()
        // ONE `setEnc` per stream, not one carrying all three.
        //
        // Measured on a live RLC (592, 2026-08-07): a single call carrying
        // `{mainStream, subStream, thirdStream}` moved main and sub and left
        // third at 1 — the camera applied what it liked and said nothing. One
        // call per stream makes each write its own success or failure, and the
        // read-back below names any that refused instead of averaging them
        // into a silent half-mute.
        for (const profile of profiles) {
          const patch: {
            mainStream?: EncStreamPatch
            subStream?: EncStreamPatch
            thirdStream?: EncStreamPatch
          } = { [profile.streamKey]: { audio: value } }
          await api.setEnc(channel, patch)
        }

        // Verify, per stream. A camera that silently ignores one stream is the
        // difference between "the microphone is off" and "the microphone is
        // off on the streams that would take it" — and only one of those is
        // privacy.
        //
        // Measured on 592 (RLC, 2026-08-07): `thirdStream` accepts the call
        // and does not move, and its published SDP keeps its `m=audio` line.
        // So a partial success here is a camera that is STILL AUDIBLE while
        // the operator believes they silenced it. Put the camera back the way
        // we found it and fail loudly — a half-applied privacy control is the
        // one outcome worse than an unavailable one.
        const after = await this.readStreamAudioProfiles().catch((): readonly [] => [])
        const refused = after.filter((p) => p.audioEnabled !== enabled).map((p) => p.streamKey)
        if (refused.length > 0) {
          const revert = enabled ? 0 : 1
          for (const profile of profiles) {
            if (refused.includes(profile.streamKey)) continue
            await api
              .setEnc(channel, { [profile.streamKey]: { audio: revert } })
              .catch((): void => undefined)
          }
          this.ctx.logger.warn(
            'reolink privacy audio: stream REFUSED the write — reverted, camera still audible',
            {
              tags: { deviceId: this.id },
              meta: { enabled, refused: refused.join(','), asked: profiles.length },
            },
          )
          this.cachedStreamDescriptors = undefined
          await refreshFromCamera()
          throw new Error(
            `device ${String(this.id)}: the camera refused to change audio on ${refused.join(', ')} — ` +
              'it would still carry sound, so the change was reverted',
          )
        }
        this.ctx.logger.info('reolink privacy audio: microphone written', {
          tags: { deviceId: this.id },
          meta: { enabled, streams: profiles.map((p) => p.streamKey).join(',') },
        })
        // The encoder config just changed — the cached stream descriptors
        // carry the audio presence used to build the synthetic SDP.
        this.cachedStreamDescriptors = undefined
        // …and every LIVE reader dropped and reconnected while `setEnc` was
        // still walking the streams, so each one holds whatever the camera
        // offered mid-change. Measured on Hikvision 104 (2026-08-07): the
        // reconnect wins that race, negotiates a video-only session, and never
        // re-dials because the session is healthy. Reolink restarts the same
        // encoders for the same reason, so it gets the same nudge.
        this.ctx.eventBus.emit(
          createEvent(EventCategory.StreamParamsChanged, this.eventSource(), {
            deviceId: this.id,
          }),
        )
        // Read back: the slice must mirror what the firmware ACCEPTED.
        await refreshFromCamera()
      },
    }

    // Warm this cap's cache during a wake window (see `capWarmers`):
    // options first (persisted, probed at most once per TTL), then the
    // status slice — so a sleeping camera always has something real to
    // serve instead of a cold-start default.
    this.registerCapWarmer(CAP_NAME, async () => {
      await provider.getOptions({ deviceId: this.id })
      await refreshFromCamera()
    })
    this.ctx.registerNativeCap(privacyMaskCapability, provider)
    this.ctx.logger.info('Reolink privacy-mask cap registered (read + enable + zone write)', {
      tags: { deviceId: this.id },
    })
  }

  /**
   * Register the vendor-neutral `day-night` cap.
   *
   * Mirrors `registerMotionZonesCap`: the trampoline pattern over
   * `createRuntimeStateBridge`, with a single-flight `refresh` that
   * round-trips `getVideoInput` (mode) + `getDayNightThreshold`
   * (sensitivity). Both are Baichuan cmdId 25/26/297 reads already used
   * elsewhere in this file (`refreshParentSettingsSnapshot`,
   * `applySettingsPatch`'s ISP section) — this cap just wraps them
   * behind the shared `getOptions`/`getStatus`/`setSettings` surface
   * instead of the legacy settings-form blob.
   *
   * - `getStatus`  — slice-driven via bridge (stale → refresh).
   * - `getOptions` — on-demand probe; `modes` is gated on the camera
   *   actually reporting a `dayNight` value, `supportsSensitivity` on a
   *   successful `getDayNightThreshold` probe. Reolink has no
   *   switch-delay knob, so `supportsSwitchDelay` is always `false`.
   * - `setSettings` — read-modify-write via `setIsp`; `sensitivity` is
   *   denormalized against the camera's OWN probed threshold range
   *   (never a hardcoded 0..255 guess).
   */
  /**
   * Register the vendor-neutral `recording-onboard` cap.
   *
   * READ-ONLY on Reolink, and it says so per field. `@apocaliss92/
   * nodelink-js` exposes a reader for the record config and the record
   * schedule and no writer; the Baichuan SET command ids exist but
   * nothing in this repo has ever sent them, and the only route is
   * hand-built XML through the generic passthrough. So `getOptions`
   * reports every field `writable: false` with
   * {@link REOLINK_NO_WRITE_REASON}, the UI renders each control
   * disabled WITH that sentence — disabled must not look like broken —
   * and `setSettings` refuses by name instead of accepting a write and
   * dropping it.
   *
   * The cap's FIELD SET is identical to Hikvision's. Only the answers
   * differ.
   */
  private registerRecordingOnboardCap(): void {
    const channel = this.getChannel()
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

    /** Last `getRecordCfg` reply. */
    let lastCfg: ReolinkRecordCfgLike | null = null
    /** Last `getRecordCfgLimits` — what the camera says it accepts. */
    let lastLimits: ReolinkRecordLimitsLike | null = null
    /** Last schedule read — which trigger rows this camera actually has. */
    let lastSchedule: ReolinkRecordScheduleLike | null = null

    const refreshFromCamera = async (): Promise<void> => {
      if (this.recordingOnboardRefreshInFlight) return this.recordingOnboardRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          const [cfg, limits, schedule, hdd] = await Promise.all([
            api.getRecordCfg(channel).catch(() => null),
            // The camera's OWN statement of what it accepts. Without it
            // every field is reported unwritable — a limit we did not
            // read is not a limit of none.
            api.getRecordCfgLimits(channel).catch(() => null),
            api.getRecordSchedule(channel).catch(() => null),
            // Device-global: on a Hub child this is the PARENT's disk,
            // and the child's own answer would describe someone else's
            // card. Only a standalone camera's answer is about itself.
            this.isHubChild() ? Promise.resolve(null) : api.getHddInfoList().catch(() => null),
          ])
          lastCfg = cfg
          lastLimits = limits
          lastSchedule = schedule
          const storage = this.isHubChild()
            ? ({
                kind: 'unknown',
                reason:
                  'This camera hangs off a Reolink Hub, so its footage lives on the Hub\u2019s disk, not on a card of its own.',
              } as const)
            : hdd === null
              ? ({
                  kind: 'unknown',
                  reason: 'The camera did not answer the storage read.',
                } as const)
              : parseOnboardStorage(hdd)

          const next = buildOnboardStatus({ storage, cfg, schedule, now: Date.now() })
          this.runtimeState.setCapState(CAP_NAME, next)

          if (next.recordingToNowhere) {
            this.ctx.logger.warn(
              'reolink onboard recording: camera is scheduled to record and has no usable storage',
              {
                tags: { deviceId: this.id },
                meta: { windows: next.windows.length },
              },
            )
          }
          if (next.unreadableWindows > 0) {
            this.ctx.logger.warn(
              'reolink onboard recording: some schedule tables could not be read — the schedule shown is incomplete',
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
          this.ctx.logger.debug('reolink onboard recording refresh failed — keeping last slice', {
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
      // Sleep-gated: reading a battery camera's record config is not
      // worth a wake, and a login IS the wake.
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: emptyStatus,
    })

    const readOptions = (): RecordingOnboardOptions =>
      buildOnboardOptions({
        status: this.runtimeState.getCapState<RecordingOnboardStatus>(CAP_NAME) ?? null,
        cfg: lastCfg,
        limits: lastLimits,
        schedule: lastSchedule,
      })

    const provider: InferNativeProvider<typeof recordingOnboardCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<RecordingOnboardOptions> => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
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
        // simply cold, so the read comes first.
        await bridge.ensureFresh()
        const refusal = describeOnboardRefusal(readOptions(), settings)
        if (refusal !== null) {
          this.ctx.logger.warn(
            'reolink onboard recording: refusing a write this camera cannot take',
            {
              tags: { deviceId: this.id },
              meta: { refusal, fields: Object.keys(settings) },
            },
          )
          throw new Error(`device ${String(this.id)}: ${refusal}`)
        }

        const writes = buildOnboardWrites(settings, lastSchedule)
        const api = await this.ensureApi()
        // Two commands, and the camera merges each into its own
        // document, so there is no atomic pair to be had. They run in
        // order and BOTH verdicts are collected: a cfg write that
        // landed must not be hidden by a schedule write that did not.
        const ignored: string[] = []
        if (writes.cfg !== null) {
          const result = await api.setRecordCfg(channel, writes.cfg)
          for (const outcome of result.outcomes) {
            if (outcome.status === 'ignored') {
              ignored.push(
                `${outcome.field}: asked ${outcome.requested}, camera kept ${outcome.actual}`,
              )
            }
          }
        }
        if (writes.schedule !== null) {
          const result = await api.setRecordSchedule(channel, writes.schedule)
          for (const outcome of result.outcomes) {
            if (outcome.status === 'ignored') {
              ignored.push(`schedule ${outcome.field}: the camera kept its own value`)
            }
          }
        }

        // The write changed the camera, so the slice is stale whatever
        // the verdict was — including a PARTIAL one, which is the case
        // that most needs the UI to show what really landed.
        await refreshFromCamera()

        if (ignored.length > 0) {
          this.ctx.logger.warn(
            'reolink onboard recording: the camera answered 200 and discarded part of the write',
            {
              tags: { deviceId: this.id },
              meta: { ignored, fields: Object.keys(settings) },
            },
          )
          throw new Error(
            `device ${String(this.id)}: the camera accepted the request and kept its own values — ${ignored.join('; ')}`,
          )
        }
        this.ctx.logger.info('reolink onboard recording: write applied', {
          tags: { deviceId: this.id },
          meta: { fields: Object.keys(settings) },
        })
      },
    }

    this.registerCapWarmer(CAP_NAME, async () => {
      await provider.getOptions({ deviceId: this.id })
      await refreshFromCamera()
    })
    this.ctx.registerNativeCap(recordingOnboardCapability, provider)
    this.ctx.logger.info('Reolink recording-onboard cap registered', {
      tags: { deviceId: this.id },
    })
  }

  private registerDayNightCap(): void {
    const channel = this.getChannel()
    const CAP_NAME = 'day-night' as const

    /** Round-trip `getVideoInput` + `getDayNightThreshold`, map into the
     *  cap status schema, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.dayNightRefreshInFlight) return this.dayNightRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          const video = await api.getVideoInput(channel)
          const vi = video?.body?.VideoInput
          const next: DayNightStatus = {
            mode: reolinkDayNightModeToCap(vi?.dayNight),
            lastFetchedAt: Date.now(),
          }
          try {
            const threshold = await api.getDayNightThreshold(channel)
            const range = threshold?.body?.DayNightThreshold?.thresholdval
            if (
              typeof range?.min === 'number' &&
              typeof range?.max === 'number' &&
              typeof range?.cur === 'number'
            ) {
              next.sensitivity = normalizeToPercent(range.cur, range.min, range.max)
            }
          } catch (err) {
            this.ctx.logger.debug('day-night threshold probe failed', {
              tags: { deviceId: this.id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          }
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('day-night refresh failed — keeping last slice', {
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
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      // The Config tab must never WAIT on a camera. `getDeviceAggregate` calls
      // this bridge's `getStatus` on a 2.5 s poll and the derived-form
      // contributions carry no deadline, so `await-refresh` here IS the tab's
      // spinner — on 3825 it sat on "Loading device aggregate…" until
      // something else woke the camera. These values move only when an
      // operator moves them, and every `set*` below re-reads the camera, so a
      // CamStack write is its own invalidation and the window bounds only a
      // change made in the Reolink app (D224, the shape `privacy-mask`
      // already uses).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: (): DayNightStatus => ({ mode: 'auto', lastFetchedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof dayNightCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<DayNightOptions> => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        return this.resolveCapOptions({
          capName: CAP_NAME,
          schema: DayNightOptionsSchema,
          probe: async (): Promise<DayNightOptions> => {
            const api = await this.ensureApi()
            const video = await api.getVideoInput(channel)
            const vi = video?.body?.VideoInput
            const modes: DayNightMode[] = vi?.dayNight !== undefined ? ['auto', 'day', 'night'] : []

            let supportsSensitivity = false
            let sensitivityRange: { min: number; max: number; step: number } | undefined
            try {
              const threshold = await api.getDayNightThreshold(channel)
              const range = threshold?.body?.DayNightThreshold?.thresholdval
              if (typeof range?.min === 'number' && typeof range?.max === 'number') {
                supportsSensitivity = true
                sensitivityRange = { min: 0, max: 100, step: 1 }
              }
            } catch (err) {
              this.ctx.logger.debug('day-night threshold options probe failed', {
                tags: { deviceId: this.id },
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            }

            return {
              modes,
              supportsSensitivity,
              ...(sensitivityRange !== undefined ? { sensitivity: sensitivityRange } : {}),
              // Baichuan exposes no switch-delay knob alongside the day/night
              // threshold — TODO if a future nodelink-js version adds one.
              supportsSwitchDelay: false,
            }
          },
          // Never probed (cold cache + sleeping cam): advertise nothing
          // rather than controls the camera may not honour.
          fallback: (): DayNightOptions => ({
            modes: [],
            supportsSensitivity: false,
            supportsSwitchDelay: false,
          }),
        })
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        const api = await this.ensureApi()
        const ispPatch: Parameters<typeof api.setIsp>[1] = {}
        if (settings.mode !== undefined) {
          ispPatch.dayNight = capDayNightModeToReolink(settings.mode)
        }
        if (settings.sensitivity !== undefined) {
          const threshold = await api.getDayNightThreshold(channel)
          const range = threshold?.body?.DayNightThreshold?.thresholdval
          const min = typeof range?.min === 'number' ? range.min : 0
          const max = typeof range?.max === 'number' ? range.max : 100
          ispPatch.dayNightThreshold = denormalizeFromPercent(settings.sensitivity, min, max)
        }
        if (Object.keys(ispPatch).length > 0) {
          await api.setIsp(channel, ispPatch)
        }
        await refreshFromCamera()
      },
    }

    // Warm this cap's cache during a wake window (see `capWarmers`):
    // options first (persisted, probed at most once per TTL), then the
    // status slice — so a sleeping camera always has something real to
    // serve instead of a cold-start default.
    this.registerCapWarmer(CAP_NAME, async () => {
      await provider.getOptions({ deviceId: this.id })
      await refreshFromCamera()
    })
    this.ctx.registerNativeCap(dayNightCapability, provider)
    this.ctx.logger.info('Reolink day-night cap registered', {
      tags: { deviceId: this.id },
    })
  }

  /**
   * Register the vendor-neutral `image-settings` cap.
   *
   * Mirrors `registerDayNightCap` / `registerMotionZonesCap`: the
   * trampoline pattern over `createRuntimeStateBridge`, with a
   * single-flight `refresh` that round-trips `getIsp` (cmdId 26 — the
   * merged `VideoInput` + `InputAdvanceCfg` blob covers brightness /
   * contrast / saturation / sharpness AND the exposure mode in one
   * call). Sliders are normalized against Reolink's native 0..255 image
   * range; `exposureMode` maps 1:1 onto the cap's `'auto' | 'manual'`.
   *
   * Reolink's Baichuan API (`@apocaliss92/nodelink-js` 0.6.7) has no
   * write path for mirror / flip / rotate / white-balance / warmth, and
   * `InputAdvanceCfg.BLC` (backlight) has no matching setter — those
   * fields are honestly reported as unsupported (`false` / `[]`) rather
   * than rendering dead controls. TODO: revisit if nodelink-js adds
   * setters for any of these.
   */
  private registerImageSettingsCap(): void {
    const channel = this.getChannel()
    const CAP_NAME = 'image-settings' as const
    const SLIDER_MIN = 0
    const SLIDER_MAX = 255
    const NORMALIZED_RANGE = { min: 0, max: 100, step: 1 } as const

    /** Round-trip `getIsp`, map into the cap status schema, write slice. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.imageSettingsRefreshInFlight) return this.imageSettingsRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          const isp = await api.getIsp(channel)
          const vi = isp?.body?.VideoInput
          const exposureRaw = isp?.body?.InputAdvanceCfg?.Exposure?.mode
          const next: ImageSettingsStatus = { lastFetchedAt: Date.now() }
          if (typeof vi?.bright === 'number')
            next.brightness = normalizeToPercent(vi.bright, SLIDER_MIN, SLIDER_MAX)
          if (typeof vi?.contrast === 'number')
            next.contrast = normalizeToPercent(vi.contrast, SLIDER_MIN, SLIDER_MAX)
          if (typeof vi?.saturation === 'number')
            next.saturation = normalizeToPercent(vi.saturation, SLIDER_MIN, SLIDER_MAX)
          if (typeof vi?.sharpen === 'number')
            next.sharpness = normalizeToPercent(vi.sharpen, SLIDER_MIN, SLIDER_MAX)
          const exposureMode = reolinkExposureModeToCap(
            typeof exposureRaw === 'string' ? exposureRaw : undefined,
          )
          if (exposureMode !== undefined) next.exposureMode = exposureMode
          this.runtimeState.setCapState(CAP_NAME, next)
        } catch (err) {
          this.ctx.logger.debug('image-settings refresh failed — keeping last slice', {
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
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      // The Config tab must never WAIT on a camera. `getDeviceAggregate` calls
      // this bridge's `getStatus` on a 2.5 s poll and the derived-form
      // contributions carry no deadline, so `await-refresh` here IS the tab's
      // spinner — on 3825 it sat on "Loading device aggregate…" until
      // something else woke the camera. These values move only when an
      // operator moves them, and every `set*` below re-reads the camera, so a
      // CamStack write is its own invalidation and the window bounds only a
      // change made in the Reolink app (D224, the shape `privacy-mask`
      // already uses).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: (): ImageSettingsStatus => ({ lastFetchedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof imageSettingsCapability> = {
      getStatus: bridge.getStatus,

      getOptions: async ({ deviceId }): Promise<ImageSettingsOptions> => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkCamera: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const staticOptions = {
          // No mirror/flip/rotate/white-balance write path in the
          // Baichuan API surface — see class-doc TODO above.
          supportsMirror: false,
          supportsFlip: false,
          rotateOptions: [],
          whiteBalanceModes: [],
          supportsWarmth: false,
          // BLC/WDR/HLC is read-only in nodelink-js (no `setIsp` field
          // for `InputAdvanceCfg.BLC`) — omitted until a setter exists.
          backlightModes: [],
        } as const

        return this.resolveCapOptions({
          capName: CAP_NAME,
          schema: ImageSettingsOptionsSchema,
          probe: async (): Promise<ImageSettingsOptions> => {
            const api = await this.ensureApi()
            const isp = await api.getIsp(channel)
            const vi = isp?.body?.VideoInput
            const exposureRaw = isp?.body?.InputAdvanceCfg?.Exposure?.mode

            const supportsBrightness = typeof vi?.bright === 'number'
            const supportsContrast = typeof vi?.contrast === 'number'
            const supportsSaturation = typeof vi?.saturation === 'number'
            const supportsSharpness = typeof vi?.sharpen === 'number'
            const exposureModes: ExposureMode[] =
              typeof exposureRaw === 'string' ? ['auto', 'manual'] : []

            return {
              supportsBrightness,
              ...(supportsBrightness ? { brightness: NORMALIZED_RANGE } : {}),
              supportsContrast,
              ...(supportsContrast ? { contrast: NORMALIZED_RANGE } : {}),
              supportsSaturation,
              ...(supportsSaturation ? { saturation: NORMALIZED_RANGE } : {}),
              supportsSharpness,
              ...(supportsSharpness ? { sharpness: NORMALIZED_RANGE } : {}),
              ...staticOptions,
              rotateOptions: [...staticOptions.rotateOptions],
              whiteBalanceModes: [...staticOptions.whiteBalanceModes],
              backlightModes: [...staticOptions.backlightModes],
              exposureModes,
            }
          },
          // Never probed (cold cache + sleeping cam): no sliders rather
          // than sliders the camera might reject.
          fallback: (): ImageSettingsOptions => ({
            supportsBrightness: false,
            supportsContrast: false,
            supportsSaturation: false,
            supportsSharpness: false,
            ...staticOptions,
            rotateOptions: [...staticOptions.rotateOptions],
            whiteBalanceModes: [...staticOptions.whiteBalanceModes],
            backlightModes: [...staticOptions.backlightModes],
            exposureModes: [],
          }),
        })
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        const api = await this.ensureApi()

        const imagePatch: Parameters<typeof api.setImage>[1] = {}
        if (settings.brightness !== undefined)
          imagePatch.bright = denormalizeFromPercent(settings.brightness, SLIDER_MIN, SLIDER_MAX)
        if (settings.contrast !== undefined)
          imagePatch.contrast = denormalizeFromPercent(settings.contrast, SLIDER_MIN, SLIDER_MAX)
        if (settings.saturation !== undefined)
          imagePatch.saturation = denormalizeFromPercent(
            settings.saturation,
            SLIDER_MIN,
            SLIDER_MAX,
          )
        if (settings.sharpness !== undefined)
          imagePatch.sharpen = denormalizeFromPercent(settings.sharpness, SLIDER_MIN, SLIDER_MAX)
        if (Object.keys(imagePatch).length > 0) {
          await api.setImage(channel, imagePatch)
        }

        const ispPatch: Parameters<typeof api.setIsp>[1] = {}
        if (settings.exposureMode !== undefined) ispPatch.exposure = settings.exposureMode
        if (Object.keys(ispPatch).length > 0) {
          await api.setIsp(channel, ispPatch)
        }

        // mirror / flip / rotate / whiteBalance / warmth / backlightMode
        // have no Reolink write path — silently ignored per the cap
        // contract ("a provider ignores fields it does not support").

        await refreshFromCamera()
      },
    }

    // Warm this cap's cache during a wake window (see `capWarmers`):
    // options first (persisted, probed at most once per TTL), then the
    // status slice — so a sleeping camera always has something real to
    // serve instead of a cold-start default.
    this.registerCapWarmer(CAP_NAME, async () => {
      await provider.getOptions({ deviceId: this.id })
      await refreshFromCamera()
    })
    this.ctx.registerNativeCap(imageSettingsCapability, provider)
    this.ctx.logger.info('Reolink image-settings cap registered', {
      tags: { deviceId: this.id },
    })
  }

  /**
   * Tell the broker one of our declared signals just fired.
   *
   * Never awaited by the push path: a camera event must not wait on a stream
   * decision, and the broker's own answer (`woke` / `hold-extended` /
   * `no-consumer` / `not-enabled`) is the interesting part only when something
   * is actually watching. Logged at debug so a quiet camera does not fill the
   * log with refusals nobody asked about — the broker logs the wakes it acts
   * on, with `tags: { deviceId }`, and that is the operator-facing line.
   */
  private async reportWakeSignal(code: string): Promise<void> {
    try {
      const result = await this.ctx.api.streamBroker.reportStreamSignal.mutate({
        deviceId: this.id,
        code,
      })
      if (result.accepted) {
        this.ctx.logger.info('wake signal accepted by the broker', {
          tags: { deviceId: this.id },
          meta: { code, reason: result.reason },
        })
      }
    } catch (err) {
      this.ctx.logger.debug('wake signal not delivered', {
        tags: { deviceId: this.id },
        meta: { code, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Declare the signals THIS camera can emit to wake its own stream.
   *
   * Two, and both recommended: a Reolink pushes firmware motion over Baichuan
   * and camera-native AI detections, both without a stream running, which is
   * exactly the property the wake needs — our own detections come from decoded
   * frames and would depend on the stream they are meant to justify.
   *
   * Declaring is not enabling: the operator picks per camera, and the broker
   * holds that choice alongside the cooldown. `recommended` only says which
   * ones this provider is confident in.
   */
  private registerStreamSignalsCap(): void {
    const signals: readonly StreamSignal[] = [
      { code: 'motion', label: 'Motion (camera)', recommended: true },
      { code: 'detection', label: 'Object detected (camera)', recommended: true },
    ]
    const provider: InferNativeProvider<typeof streamSignalsCapability> = {
      listSignals: async () => signals,
    }
    this.ctx.registerNativeCap(streamSignalsCapability, provider)
  }

  /**
   * Register the `native-object-detection` cap.
   *
   * The runtimeState holds three fields:
   *  - `supportedClasses`: probed from `deviceCache.aiDetectTypes` (via
   *    `getAiDetectTypes` during the motion-alarm snapshot) and mapped
   *    through `AI_CLASS_MAP` to the cap's `NativeObjectClass` enum. Falls
   *    back to the full `AI_CLASS_MAP` value-set when the probe hasn't run
   *    yet (e.g. fresh device, no config cached).
   *  - `lastByClass`: updated in `handleSimpleEvent` every time an AI-class
   *    event fires, regardless of the `enabled` flag.
   *  - `enabled`: operator toggle, cold-start OFF on every camera. A vendor
   *    never turns a detector on for the operator; see `buildEmptyState`.
   *
   * Follows the trampoline pattern from `registerStreamParamsCap` — no
   * parallel private fields; all state lives in the kernel runtimeState
   * slice.
   */
  /**
   * Report — once a minute per class — that the forwarding gate dropped an
   * onboard AI detection. A branch that drops work names it (D391): without
   * this the toggle being off looks exactly like a camera that pushes nothing,
   * and the operator's only symptom is silence.
   */
  private noteNativeDetectionSuppressed(aiClass: string): void {
    const now = Date.now()
    const last = this.nativeDetectionSuppressedAt.get(aiClass) ?? 0
    if (now - last < NATIVE_DETECTION_SUPPRESSED_LOG_MS) return
    this.nativeDetectionSuppressedAt.set(aiClass, now)
    this.ctx.logger.info(
      'Reolink onboard AI detection dropped — forwarding is off for this camera',
      {
        tags: { deviceId: this.id },
        meta: { class: aiClass, battery: this.isBattery },
      },
    )
  }

  private registerNativeObjectDetectionCap(): void {
    const CAP_NAME = 'native-object-detection' as const

    // Derive `supportedClasses` from the persisted `deviceCache.aiDetectTypes`.
    // `aiDetectTypes` carries the Baichuan lib-side names ('people', 'vehicle',
    // 'dog_cat', 'face', 'package'). Map them through `AI_CLASS_MAP` to get
    // the cap-facing `NativeObjectClass` values.
    const buildSupportedClasses = (): readonly NativeObjectClass[] =>
      buildSupportedNativeClasses(
        this.config.get('deviceCache')?.aiDetectTypes,
        isNativeObjectClass,
      ).filter(isNativeObjectClass)

    // Cold-start default for the full slice. Shared by the bridge's
    // `empty()` (returned by-value from `getStatus` when unseeded) AND the
    // eager seed below so both agree on the complete shape.
    const buildEmptyState = (): NativeObjectDetectionRuntimeState => ({
      // OFF, on every camera, always. Which detector a camera runs is not a
      // vendor's decision to make on the operator's behalf — a default that
      // turns itself on is the vendor writing policy, and the policy belongs to
      // the camera's pipeline config, not here. What this cap answers is
      // CAPABILITY: what the firmware can detect, and whether a detection
      // carries geometry (`getOptions`). Whether it is USED is the system's
      // question.
      enabled: false,
      lastByClass: {},
      supportedClasses: buildSupportedClasses(),
      lastFetchedAt: 0,
    })

    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: nativeObjectDetectionCapability,
      ownDeviceId: this.id,
      // No camera round-trip needed — state is maintained via push events
      // and the `setEnabled` mutation. Pass a no-op refresh.
      refresh: async (): Promise<void> => {
        /* push-only cap, no pull refresh */
      },
      staleMs: Infinity,
      empty: buildEmptyState,
    })

    /** Shared by `setEnabled` and the derived form's `setSettings`. */
    const applyEnabled = async (enabled: boolean): Promise<void> => {
      await this.runtimeState.patchCapState(CAP_NAME, { enabled })
      // Toggle the boxed-detection substream to match: re-arm on enable,
      // tear it down on disable so a disabled cam doesn't hold an
      // always-on dial. No-op on battery cams (helper skips them) and
      // when no api is connected yet (login path arms it later).
      const api = this.api
      if (!api) return
      if (enabled) {
        await this.resubscribeObjectDetections(api, 'cap-enabled').catch((err: unknown) => {
          this.ctx.logger.debug('Reolink objectDetections re-arm on enable failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      } else {
        await this.unsubscribeObjectDetections(api)
      }
    }

    const provider: InferNativeProvider<typeof nativeObjectDetectionCapability> = {
      getStatus: bridge.getStatus,

      // D14: the form is derived from THIS, so it has to be honest about what
      // the toggle buys. A battery camera never attaches the boxed sub-stream,
      // so its detections are flag-only whatever the operator sets.
      getOptions: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          return { supportedClasses: [], geometry: 'flag-only' as const }
        }
        return {
          supportedClasses: buildSupportedClasses(),
          // A battery camera's boxes ride whatever stream is already open
          // (`onDetection`): free, and present exactly while the camera is
          // awake. A mains camera holds a standing sub-stream for them.
          geometry: this.isBattery ? ('while-streaming' as const) : ('boxed' as const),
        }
      },

      setSettings: async ({ deviceId, settings }): Promise<void> => {
        if (deviceId !== this.id) return
        if (settings.enabled === undefined) return
        await applyEnabled(settings.enabled)
      },

      setEnabled: async ({ deviceId, enabled }): Promise<void> => {
        if (deviceId !== this.id) return
        await applyEnabled(enabled)
      },
    }

    this.ctx.registerNativeCap(nativeObjectDetectionCapability, provider)
    this.registerStreamSignalsCap()

    // Eager-seed the FULL slice so the first partial write from the push
    // path can merge safely.
    //
    // This cap is push-only with a no-op `refresh` + `staleMs: Infinity`,
    // so `getStatus` NEVER writes the `empty()` default into runtimeState —
    // it returns it by value. The slice therefore stays `undefined` until
    // the first `setCapState`/`patchCapState` carrying ALL required fields.
    // But the first writer is `handleSimpleEvent`'s hot path, which issues
    // `patchCapState(CAP_NAME, { lastByClass: {…} })` (a PARTIAL). Merged
    // onto an empty base that partial lacks `supportedClasses`/`enabled`/
    // `lastFetchedAt`, so the cap's Zod schema rejects it and every AI-class
    // Baichuan push throws a ZodError — aborting the AI branch before it can
    // emit DetectionCameraNative / ProviderMotion.
    //
    // `registerNativeCap` above already installed the cap's runtime-state
    // schema synchronously (device-cap-proxy.ts `installCapSchema`), so this
    // `setCapState` is valid immediately. Guard on `=== undefined` so a slice
    // restored from persistence (operator's saved `enabled` toggle) is never
    // clobbered by the cold-start default.
    if (this.runtimeState.getCapState(CAP_NAME) === undefined) {
      this.runtimeState.setCapState(CAP_NAME, { ...buildEmptyState(), lastFetchedAt: Date.now() })
      // NAMED, because this branch DESTROYS an operator setting whenever it is
      // reached by a camera that had one. `durability: 'restored'` says the
      // `enabled` toggle survives a restart; when the persisted slice does not
      // reach this device's `runtimeState` before the cap registers, the
      // cold-start default silently replaces it with OFF — and the only symptom
      // downstream is a camera that forwards nothing. On 2026-09-15 all seven
      // Reolink cameras of the live hub carried a `lastFetchedAt` from the
      // previous evening's provider boot, i.e. every one of them came through
      // here, and camera 106 lost an `['onboard']` pick that way. The
      // orchestrator puts the flag back at attach
      // (`onboard-forwarding-reconcile.ts`); this line is how a future session
      // sees the loss happen instead of inferring it from a timestamp.
      this.ctx.logger.info('Reolink onboard AI: no restored state — cold-start default (OFF)', {
        tags: { deviceId: this.id },
      })
    } else {
      // A RESTORED slice keeps the operator's `enabled` — that is what
      // `durability: 'restored'` is for — but `supportedClasses` is not a
      // choice, it is what the PROBE said this firmware detects. Frozen at
      // first write it survives every later correction: camera 108 kept
      // reporting `["person","vehicle"]` for as long as the row existed, while
      // the same camera's `lastByClass` held a live `animal` detection,
      // because the `dog_cat` mapping gap had been baked into the row before
      // the map was fixed. Re-derived here, on the cold path, patching only
      // the field that is nobody's decision.
      this.runtimeState.patchCapState(CAP_NAME, { supportedClasses: buildSupportedClasses() })
    }

    this.ctx.logger.info('Reolink native-object-detection cap registered', {
      tags: { deviceId: this.id },
    })
  }

  /**
   * Resolve the `audio-codec` cap router off `ctx.api`. Throws a
   * clear error when the cap isn't mounted (no audio-codec addon
   * installed) so the operator gets actionable feedback at
   * `startSession` time rather than a generic dispatch failure.
   *
   * The shape we surface is the narrow `IntercomAudioCodecApi` used
   * by the orchestrator — we don't expose the full router because
   * intercom only needs decode + push + pull + close.
   */
  private resolveAudioCodecApi(): IntercomAudioCodecApi {
    const root = this.ctx.api as { audioCodec?: AudioCodecRouterShape }
    const router = root.audioCodec
    if (!router) {
      throw new Error(
        'Reolink intercom: `audio-codec` capability is not mounted. ' +
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

  /**
   * Battery-cam pre-wake hook for the intercom orchestrator: ask the
   * lib for the current sleep status (passive — no traffic), and if the cam
   * is asleep issue an explicit `wakeUp(channel, {waitAfterWakeMs:2000})`
   * + a 1s settle delay before letting the talk-session handshake
   * fire. Without this, the handshake against a sleeping UDP/battery
   * cam silently times out and the operator gets a generic "talk
   * session open failed" error.
   */
  private async wakeForIntercom(api: ReolinkBaichuanApi): Promise<void> {
    const channel = this.getChannel()
    let sleepStatus
    try {
      sleepStatus = api.getSleepStatus({ channel })
    } catch (err) {
      this.ctx.logger.debug('intercom: getSleepStatus failed — proceeding without explicit wake', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    if (sleepStatus.state !== 'sleeping') return
    this.ctx.logger.info('intercom: cam sleeping — waking up before talk session', {
      tags: { deviceId: this.id },
    })
    try {
      await api.wakeUp(channel, { waitAfterWakeMs: 2000 })
      // UDP wake completion lags the ack by ~1 s on Argus / battery
      // doorbell firmwares. Skipping this wait produces a flaky
      // `createDedicatedTalkSession` even though `getSleepStatus`
      // reports awake.
      await sleep(1000)
    } catch (err) {
      this.ctx.logger.warn('intercom: wakeUp failed — proceeding anyway', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Translate a Reolink Baichuan `doorbell` simple-event into a
   * camstack-side doorbell press: bump the counters, emit the cap
   * event, and bridge to the typed `EventCategory.DoorbellOnPressed`
   * so non-cap consumers (UI toast, notifier) can subscribe without
   * holding a cap reference.
   */
  private emitDoorbellPressed(timestamp: number): void {
    this.doorbellLastPressedAt = timestamp
    this.doorbellPressCountSinceStart += 1
    // Mirror the press into the kernel-managed `doorbell` runtimeState slice so
    // `device.state.doorbell.value` reflects the ring for state consumers (the
    // status cap is push-kind — without this write the mirror stays empty and the
    // device-details state surface never shows the doorbell). This was the lone
    // native cap that emitted its event but never wrote its declared slice.
    this.runtimeState.setCapState(doorbellCapability.name, {
      lastPressedAt: timestamp,
      pressCountSinceStart: this.doorbellPressCountSinceStart,
    })
    this.ctx.eventBus.emit(
      createEvent(EventCategory.DoorbellOnPressed, this.eventSource(), {
        deviceId: this.id,
        timestamp,
      }),
    )
  }

  /**
   * Register the `ptz-autotrack` cap when the abilities probe flagged
   * `hasAutotrack`. The cap surface (`getStatus` / `setEnabled` /
   * `getSettings` / `setSettings`) maps directly onto the lib's
   * `getAutotracking` / `setAutotracking` / `setAutotrackingSettings`
   * Baichuan commands.
   *
   * Source of truth is `runtimeState['ptz-autotrack']` — the kernel
   * persists this slice across restarts and validates it against the
   * cap's runtimeState schema. The four cap methods become trampolines:
   * read from the slice, refresh from the camera when stale, write
   * back to the slice. No private cache fields, no config-blob dance.
   */
  private registerPtzAutotrackIfSupported(): void {
    if (this.ptzAutotrackRegistered) return
    const probe = this.getProbeFlags<ReolinkProbeFlags>()
    if (!probe.hasAutotrack) return
    this.ptzAutotrackRegistered = true

    const channel = this.getChannel()
    const CAP_NAME = 'ptz-autotrack'
    /** Stale-after window for served-from-cache reads. ~10s is short
     *  enough that the UI's 5s poll always sees a fresh round-trip,
     *  long enough that two consumers in the same tick fold into one. */

    // Static for Reolink — the Baichuan `smartTrackType` field accepts
    // these well-known tokens (verified via the lib's example payloads).
    // Compound strings like `"people,vehicle"` work on multi-class
    // firmwares; we expose the canonical subset and let the operator
    // type compound values manually if needed.
    const SUPPORTED_TARGET_TYPES: PtzAutotrackStatus['supportedTargetTypes'] = [
      { value: 'people', label: 'People' },
      { value: 'vehicle', label: 'Vehicle' },
      { value: 'pet', label: 'Pet' },
      { value: 'people,vehicle', label: 'People + Vehicle' },
    ]

    const extractSettingsFromAiCfg = (raw: AiConfig | undefined): PtzAutotrackSettings | null => {
      const cfg = raw?.body?.AiCfg
      if (!cfg) return null
      return {
        targetType: typeof cfg.smartTrackType === 'string' ? cfg.smartTrackType : '',
        stopDelaySeconds: Number(cfg.smartTrackObjectStopDelay ?? 20),
        disappearDelaySeconds: Number(cfg.smartTrackObjectDisappearDelay ?? 10),
      }
    }

    const readSlice = (): PtzAutotrackRuntimeState | undefined =>
      this.runtimeState.getCapState<PtzAutotrackRuntimeState>(CAP_NAME)

    /** Round-trip the camera, mirror everything into runtimeState.
     *  Single-flight: concurrent callers within one tick await the
     *  same promise. Failure leaves the existing slice untouched. */
    const refreshFromCamera = async (): Promise<void> => {
      if (this.autotrackRefreshInFlight) return this.autotrackRefreshInFlight
      const promise = (async () => {
        try {
          const api = await this.ensureApi()
          const state = await api.getAutotracking(channel)
          const enabled = Boolean(state?.enabled)
          const fromCamera = extractSettingsFromAiCfg(state?.raw)
          const prev = readSlice()
          this.runtimeState.setCapState(CAP_NAME, {
            enabled,
            lastChangedAt: prev?.enabled === enabled ? (prev?.lastChangedAt ?? 0) : Date.now(),
            currentSettings: fromCamera ?? prev?.currentSettings ?? null,
            supportedTargetTypes: SUPPORTED_TARGET_TYPES,
            lastFetchedAt: Date.now(),
          })
        } catch (err) {
          this.ctx.logger.debug('autotrack refresh failed — keeping last slice', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
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
      refresh: this.sleepGatedRefresh(CAP_NAME, refreshFromCamera),
      // The Config tab must never WAIT on a camera. `getDeviceAggregate` calls
      // this bridge's `getStatus` on a 2.5 s poll and the derived-form
      // contributions carry no deadline, so `await-refresh` here IS the tab's
      // spinner — on 3825 it sat on "Loading device aggregate…" until
      // something else woke the camera. These values move only when an
      // operator moves them, and every `set*` below re-reads the camera, so a
      // CamStack write is its own invalidation and the window bounds only a
      // change made in the Reolink app (D224, the shape `privacy-mask`
      // already uses).
      staleMs: OPERATOR_WRITTEN_STALE_MS,
      staleRead: 'serve-and-revalidate',
      empty: (): PtzAutotrackStatus => ({
        enabled: false,
        lastChangedAt: 0,
        currentSettings: null,
        supportedTargetTypes: SUPPORTED_TARGET_TYPES,
      }),
    })

    const provider: InferNativeProvider<typeof ptzAutotrackCapability> = {
      getStatus: bridge.getStatus,
      setEnabled: async ({ deviceId, enabled }) => {
        if (deviceId !== this.id) return
        const api = await this.ensureApi()
        await api.setAutotracking(enabled, channel)
        const prev = readSlice()
        this.runtimeState.patchCapState(CAP_NAME, {
          enabled,
          lastChangedAt: prev?.enabled === enabled ? (prev?.lastChangedAt ?? 0) : Date.now(),
          lastFetchedAt: Date.now(),
        })
      },
      getSettings: async ({ deviceId }) => {
        if (deviceId !== this.id) return null
        await bridge.ensureFresh()
        return readSlice()?.currentSettings ?? null
      },
      setSettings: async ({ deviceId, settings }) => {
        if (deviceId !== this.id) return
        // Merge the patch onto whatever the slice currently holds so
        // partial UI updates don't clobber unspecified fields. Empty
        // slice (cold-start, camera never reached) → lib defaults.
        const current = readSlice()?.currentSettings ?? {
          targetType: '',
          stopDelaySeconds: 20,
          disappearDelaySeconds: 10,
        }
        const merged: PtzAutotrackSettings = {
          targetType: settings.targetType ?? current.targetType,
          stopDelaySeconds: settings.stopDelaySeconds ?? current.stopDelaySeconds,
          disappearDelaySeconds: settings.disappearDelaySeconds ?? current.disappearDelaySeconds,
        }
        // Push first — on failure, the slice stays untouched so the
        // UI matches the camera. Empty targetType means "camera
        // default" → drop the wire field (some firmwares reject "").
        const api = await this.ensureApi()
        const fwSettings: Parameters<typeof api.setAutotrackingSettings>[1] = {
          smartTrackObjectStopDelay: merged.stopDelaySeconds,
          smartTrackObjectDisappearDelay: merged.disappearDelaySeconds,
        }
        if (merged.targetType.length > 0) fwSettings.smartTrackType = merged.targetType
        await api.setAutotrackingSettings(channel, fwSettings)
        // Re-read so we reflect any clamping (some firmwares round
        // delays to multiples of 5).
        await refreshFromCamera()
      },
    }
    // No `getOptions` on this cap — warm the status slice only.
    this.registerCapWarmer(CAP_NAME, refreshFromCamera)
    this.ctx.registerNativeCap(ptzAutotrackCapability, provider)
    this.ctx.logger.info('Reolink ptz-autotrack cap registered', {
      tags: { deviceId: this.id },
    })
  }

  private registerPtzIfSupported(): void {
    if (this.ptzRegistered) return
    const probe = this.getProbeFlags<ReolinkProbeFlags>()
    if (!probe.hasPtz) return
    this.ptzRegistered = true
    {
      const ptzProvider: InferNativeProvider<typeof ptzCapability> = {
        move: async ({ deviceId, pan, tilt, zoom, speed }) => {
          if (deviceId !== this.id) return
          await this.runPtz(pan, tilt, zoom, speed, /* continuous */ false)
        },
        continuousMove: async ({ deviceId, pan, tilt, zoom, speed }) => {
          if (deviceId !== this.id) return
          await this.runPtz(pan, tilt, zoom, speed, /* continuous */ true)
        },
        stop: async ({ deviceId }) => {
          if (deviceId !== this.id) return
          const api = await this.ensureApi()
          const channel = this.getChannel()
          // Sending 'stop' on every direction is wasteful; nodelink's
          // ptz already sends a stop on whichever command was last
          // active, so issue a no-op stop on Up — the camera ignores
          // stops for inactive directions.
          try {
            await api.ptz(channel, { action: 'stop', command: 'Up' })
          } catch {
            /* ignore */
          }
        },
        getPresets: async ({ deviceId }) => {
          if (deviceId !== this.id) return []
          try {
            const api = await this.ensureApi()
            const channel = this.getChannel()
            const presets = await api.getPtzPresets(channel)
            // Baichuan documents no reserved preset band, so every id stays
            // writable and a firmware that disagrees refuses for itself --
            // guessing a band here would take a real slot away from the
            // operator.
            return presets.map((p) => ({
              id: String(p.id),
              name: p.name,
              fn: null,
              writable: true,
            }))
          } catch {
            return []
          }
        },
        goToPreset: async ({ deviceId, presetId }) => {
          if (deviceId !== this.id) return
          const api = await this.ensureApi()
          const channel = this.getChannel()
          const id = Number(presetId)
          if (!Number.isFinite(id))
            throw userError(
              'reolink.preset-invalid',
              { presetId: String(presetId) },
              `Invalid presetId: ${presetId}`,
            )
          await api.moveToPtzPreset(channel, id)
        },
        savePreset: async ({ deviceId, presetId, name }) => {
          if (deviceId !== this.id) return
          const api = await this.ensureApi()
          const channel = this.getChannel()
          const id = Number(presetId)
          if (!Number.isFinite(id))
            throw userError(
              'reolink.preset-invalid',
              { presetId: String(presetId) },
              `Invalid presetId: ${presetId}`,
            )
          // Baichuan `setPtzPreset` captures the camera's current head
          // position under `id` — no separate "current position" arg.
          await api.setPtzPreset(channel, id, name)
        },
        deletePreset: async ({ deviceId, presetId }) => {
          if (deviceId !== this.id) return
          const api = await this.ensureApi()
          const channel = this.getChannel()
          const id = Number(presetId)
          if (!Number.isFinite(id))
            throw userError(
              'reolink.preset-invalid',
              { presetId: String(presetId) },
              `Invalid presetId: ${presetId}`,
            )
          await api.deletePtzPreset(channel, id)
        },
        getOptions: async ({ deviceId }) => {
          if (deviceId !== this.id) {
            return {
              hasPan: false,
              hasTilt: false,
              hasZoom: false,
              supportsPresets: false,
              hasAutofocus: false,
              speedSteps: BAICHUAN_SPEED_STEPS,
              moveImpulseMs: PTZ_MOVE_IMPULSE_MS,
            }
          }
          // `hasAutofocus` — true when the camera answered a prior
          // `getAutoFocus` probe (cmd 224) successfully; the same
          // signal as the CGI `disableAutoFocus` ability leaf, already
          // persisted as `autoFocusSnapshot.supported`.
          const hasAutofocus = this.config.get('deviceCache')?.autoFocusSnapshot?.supported === true
          // Re-use the lib's pre-parsed capability probe — same source
          // `probeAndPersistFeatures` derives the aggregate `hasPtz`
          // flag from — but exposed at per-axis granularity here.
          // Cached + sleep-gated: the aggregate polls this every 2.5s.
          return this.resolveCapOptions({
            capName: 'ptz',
            schema: PtzOptionsSchema,
            probe: async (): Promise<PtzOptions> => {
              const api = await this.ensureApi()
              const { capabilities } = await api.getDeviceCapabilities(this.getChannel())
              return {
                hasPan: capabilities.hasPan,
                hasTilt: capabilities.hasTilt,
                hasZoom: capabilities.hasZoom,
                supportsPresets: capabilities.hasPresets,
                hasAutofocus,
                // `runPtz` maps the normalized speed onto Baichuan's 1..63.
                speedSteps: BAICHUAN_SPEED_STEPS,
                moveImpulseMs: PTZ_MOVE_IMPULSE_MS,
              }
            },
            // Never probed (cold cache + sleeping cam) or probe failed —
            // fall back to the persisted aggregate flag so the UI still
            // shows PTZ controls.
            fallback: (): PtzOptions => {
              const hasPtz = this.getProbeFlags<ReolinkProbeFlags>().hasPtz === true
              return {
                hasPan: hasPtz,
                hasTilt: hasPtz,
                hasZoom: hasPtz,
                supportsPresets: hasPtz,
                hasAutofocus,
                // These two are facts about the DRIVER, not about the camera,
                // so an unprobed or sleeping camera does not make them unknown.
                speedSteps: BAICHUAN_SPEED_STEPS,
                moveImpulseMs: PTZ_MOVE_IMPULSE_MS,
              }
            },
          })
        },
        goHome: async ({ deviceId }) => {
          if (deviceId !== this.id) return
          // This used to be `moveToPtzPreset(channel, 0)` on the belief that
          // "Baichuan exposes home as preset id 0 on most firmwares", wrapped
          // in a bare `catch {}`. On device 107 preset 0 holds "stanza", and
          // the silent catch meant a head that never moved looked exactly like
          // a head that went home. Both are fixed here: resolve, or refuse.
          const home = await this.resolveHomePreset()
          if (home.source === 'native') {
            // The guard point is a real destination, not just an idle-return
            // timer: `toGrd` sends the head there now.
            const api = await this.ensureApi()
            await api.goToPtzGuard(this.getChannel())
            return
          }
          if (home.source === 'none' || home.presetId === null) {
            throw new Error(
              'No home preset configured for this camera, and it has no guard point set — ' +
                'set one in the PTZ settings, or place a guard point on the camera',
            )
          }
          const id = Number(home.presetId)
          if (!Number.isFinite(id)) {
            throw userError(
              'reolink.home-preset-not-baichuan',
              { presetId: String(home.presetId) },
              `Configured home preset is not a Baichuan id: ${home.presetId}`,
            )
          }
          const api = await this.ensureApi()
          const channel = this.getChannel()
          await api.moveToPtzPreset(channel, id)
        },
        getHomePreset: async ({ deviceId }) => {
          if (deviceId !== this.id) return { presetId: null, source: 'none' as const }
          return this.resolveHomePreset()
        },
        captureHomeHere: async ({ deviceId }) => {
          if (deviceId !== this.id) return
          // The guard point IS the home on this vendor, and `needSetPos` is how
          // the camera is told to take the head's current position. The enable
          // flag and the timer are preserved so "set home here" only moves the
          // point -- it must not quietly switch the idle-return on or off.
          const current = await this.readGuardStatus()
          const api = await this.ensureApi()
          const channel = this.getChannel()
          await api.setPtzGuard(
            {
              enabled: current?.enabled ?? false,
              timeoutSeconds: current?.timeoutSeconds ?? DEFAULT_GUARD_TIMEOUT_SECONDS,
              setPosition: true,
            },
            channel,
          )
          this.ctx.logger.info('reolink: guard point pinned to the current position', {
            tags: { deviceId: this.id },
          })
        },
        getHomeReturn: async ({ deviceId }) => {
          if (deviceId !== this.id) return null
          const guard = await this.readGuardStatus()
          // An unreadable guard is UNKNOWN, not "no idle-return" (D393). And
          // `benable` is reported as it IS: a camera holding a 68 s delay with
          // the behaviour switched OFF is a real state, and the first version
          // of this cap made it invisible by reporting only the delay.
          return guard === null ? null : { enabled: guard.enabled, seconds: guard.timeoutSeconds }
        },
        setHomeReturn: async ({ deviceId, enabled, seconds }) => {
          if (deviceId !== this.id) return
          const api = await this.ensureApi()
          // Both go in ONE write because the camera carries them in one
          // element -- setting either alone would mean reading the other back
          // first and racing whoever else is writing. `setPosition` stays
          // FALSE: changing WHETHER or WHEN the head returns must never re-pin
          // WHERE it returns to.
          await api.setPtzGuard(
            { enabled, timeoutSeconds: seconds, setPosition: false },
            this.getChannel(),
          )
          this.ctx.logger.info('reolink: guard point idle-return updated', {
            tags: { deviceId: this.id },
            meta: { enabled, seconds },
          })
        },
        setHomePreset: async ({ deviceId, presetId }) => {
          if (deviceId !== this.id) return
          // `setAll` merges — never spread the snapshot back in (CLAUDE.md).
          await this.config.setAll({ homePresetId: presetId ?? '' })
        },
        getPosition: async ({ deviceId }) => {
          if (deviceId !== this.id) return { pan: null, tilt: null, zoom: null }
          // We do not read position here. This used to return zeros, which told
          // every caller the head was perfectly centred; `null` is what an
          // unread axis IS (D393).
          //
          // There IS a path: nodelink exposes `getPtzPosition(channel)` (cmd
          // 433) and `getZoomFocus`, both already in the installed library and
          // never called. Wiring them is a separate change -- the point of this
          // one is to stop claiming a reading we never took.
          return { pan: null, tilt: null, zoom: null }
        },
        getStatus: async ({ deviceId }) => {
          if (deviceId !== this.id) return { pan: null, tilt: null, zoom: null, autofocus: false }
          // Position is not live-queryable on Baichuan (see getPosition);
          // autofocus comes from the persisted `getAutoFocus` probe
          // (`disable === 0` → autofocus enabled).
          const af = this.config.get('deviceCache')?.autoFocusSnapshot
          return { pan: null, tilt: null, zoom: null, autofocus: af?.enabled === true }
        },
        setAutofocus: async ({ deviceId, enabled }) => {
          if (deviceId !== this.id) return
          const api = await this.ensureApi()
          const channel = this.getChannel()
          // Baichuan SetAutoFocus (cmd 225): `disable` 0 = autofocus ON.
          await api.setAutoFocus(channel, enabled ? 0 : 1)
          // Re-read so the snapshot (and getStatus) reflect the change.
          try {
            const af = await api.getAutoFocus(channel, { timeoutMs: 1500 })
            const a = af?.body?.AutoFocus
            if (a) {
              // `deviceCache` is a nested object and `setAll` does only a
              // shallow top-level merge — spread the current `deviceCache`
              // so its sibling fields (model, serial, probedAt, …) survive.
              // This is NOT the prohibited top-level `setAll({...snap,...patch})`
              // pattern: the spread is on a nested key, and necessary.
              const afCurrent = this.config.get('deviceCache')
              await this.config.setAll({
                deviceCache: {
                  ...afCurrent,
                  autoFocusSnapshot: {
                    enabled: typeof a.disable === 'number' ? a.disable === 0 : null,
                    supported: true,
                  },
                  // This re-read is a snapshot write like any other — it
                  // gets the per-snapshot stamp (D346).
                  snapshotFetchedAt: stampSnapshotFreshness(
                    afCurrent?.snapshotFetchedAt,
                    ['autoFocusSnapshot'],
                    Date.now(),
                  ),
                },
              })
            }
          } catch {
            /* best-effort — the write itself already succeeded */
          }
        },
      }
      // PTZ holds no status slice (position is not live-queryable on
      // Baichuan) — warm the per-axis options descriptor only.
      this.registerCapWarmer('ptz', async () => {
        await ptzProvider.getOptions({ deviceId: this.id })
      })
      this.ctx.registerNativeCap(ptzCapability, ptzProvider)
    }
  }

  /**
   * Translate normalized (-1..1) pan/tilt to discrete Baichuan
   * directional commands. Camstack ptz uses ONVIF-style continuous
   * motion vectors; Reolink Baichuan needs discrete directional
   * commands (Left/Right/Up/Down). Magnitudes map to speed (0–63
   * typical). Continuous=true issues 'start' (camera moves until next
   * 'stop'); continuous=false issues 'start' followed by an autoStop
   * after a short window so a single tap of an arrow key results in a
   * tiny nudge.
   *
   * Zoom is NOT a direction on this frame — see `runZoom`.
   */
  private async runPtz(
    pan: number | undefined,
    tilt: number | undefined,
    zoom: number | undefined,
    speed: number | undefined,
    continuous: boolean,
  ): Promise<void> {
    const api = await this.ensureApi()
    const channel = this.getChannel()
    const cmds: Array<'Left' | 'Right' | 'Up' | 'Down'> = []
    if (pan !== undefined && Math.abs(pan) > 0.01) cmds.push(pan > 0 ? 'Right' : 'Left')
    if (tilt !== undefined && Math.abs(tilt) > 0.01) cmds.push(tilt > 0 ? 'Up' : 'Down')
    if (zoom !== undefined && Math.abs(zoom) > 0.01) {
      await this.runZoom(api, channel, zoom)
    }
    if (cmds.length === 0) return

    const baichuanSpeed =
      speed === undefined
        ? Math.round(BAICHUAN_SPEED_STEPS / 2)
        : Math.max(1, Math.min(BAICHUAN_SPEED_STEPS, Math.round(speed * BAICHUAN_SPEED_STEPS)))
    for (const command of cmds) {
      try {
        await api.ptz(channel, {
          action: 'start',
          command,
          speed: baichuanSpeed,
          ...(continuous ? {} : { autoStopMs: PTZ_MOVE_IMPULSE_MS }),
        })
      } catch (err) {
        this.ctx.logger.warn('Baichuan ptz command failed', {
          tags: { deviceId: this.id, command },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  /**
   * Step the lens along the camera's own zoom travel.
   *
   * Baichuan has NO directional zoom on MSG_ID_PTZ_CONTROL (cmd 18) —
   * that frame accepts left/right/up/down and nothing else, so every
   * zoom this provider ever sent threw `Unsupported PTZ command for
   * MSG_ID_PTZ_CONTROL: ZoomIn` inside the lib, got swallowed into a
   * WARN, and returned void. The cap reported success and the lens
   * never moved: zoom has never worked on a Reolink here.
   *
   * The step arithmetic lives in `resolveZoomStep` (`./ptz-zoom.js`);
   * this method is only the I/O around it. A camera whose answer
   * carries no `<zoom>` block has no zoom to drive — that is a dropped
   * command and it is logged as one.
   */
  private async runZoom(api: ReolinkBaichuanApi, channel: number, zoom: number): Promise<void> {
    try {
      const range = (await api.getZoomFocus(channel)).zoom
      if (!range) {
        this.ctx.logger.warn('Baichuan zoom dropped — camera reported no zoom travel', {
          tags: { deviceId: this.id },
          meta: { reason: 'no-zoom-block' },
        })
        return
      }

      const step = resolveZoomStep(range, zoom)
      if (step.kind === 'refused') {
        this.ctx.logger.warn('Baichuan zoom dropped', {
          tags: { deviceId: this.id },
          meta: {
            reason: step.reason,
            curPos: range.curPos,
            minPos: range.minPos,
            maxPos: range.maxPos,
          },
        })
        return
      }

      // `zoomToFactor` multiplies by 1000 to reach an absolute movePos,
      // so a raw position goes back in divided by that same scale.
      //
      // A set issued while the lens is STILL TRAVELLING from the
      // previous press comes back `response_code 400`. Measured on an
      // E1 Outdoor PoE: presses 1.2 s apart were rejected, 3 s apart
      // were accepted. A rocker held down would otherwise drop most of
      // its presses, so one bounded retry absorbs the overlap — bounded,
      // never a loop.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await api.zoomToFactor(channel, step.target / ZOOM_FACTOR_SCALE)
          break
        } catch (err) {
          if (attempt >= ZOOM_SET_ATTEMPTS) throw err
          await new Promise((resolve) => setTimeout(resolve, ZOOM_SET_RETRY_MS))
        }
      }
      this.ctx.logger.debug('Baichuan zoom applied', {
        tags: { deviceId: this.id },
        meta: { from: range.curPos, to: step.target, minPos: range.minPos, maxPos: range.maxPos },
      })
    } catch (err) {
      this.ctx.logger.warn('Baichuan zoom command failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // ── Stream metadata ───────────────────────────────────────────────────

  async getStreamSources(): Promise<readonly StreamSourceEntry[]> {
    const streams = buildStreamIds(this.channelCount())
    return streams.map(
      (s, i): StreamSourceEntry => ({
        id: s.id,
        label: s.label,
        protocol: 'annexb',
        profileHint: i % 2 === 0 ? 'high' : 'mid',
      }),
    )
  }

  private channelCount(): number {
    return this.config.get('deviceCache')?.channelCount ?? 1
  }

  /**
   * Publish Reolink streams to the stream-broker. Reolink cameras
   * typically expose the same logical channel over THREE containers —
   * native Baichuan push, RTSP, RTMP. We publish all of them so the
   * operator can pick any in the assignment UI; native streams are
   * `autoEligible: true` (the recommended path) and RTSP / RTMP mirrors
   * are `autoEligible: false` (selectable, but never the default).
   *
   * Stream IDs are kind-prefixed (`native:main`, `rtsp:main`, …) so the
   * broker treats them as distinct rows even though they share the
   * same camera profile.
   *
   * The lib's `buildVideoStreamOptions()` is the single source of truth
   * for the camera's offer — it returns nativeStreams + rtspStreams +
   * rtmpStreams with full metadata (width/height/frameRate/bitRate/
   * videoEncType) in a single call. We resolve it lazily on every
   * publish instead of caching it in `deviceCache`: the cache layer
   * was a constant source of bugs (transient probe failures wiped
   * the persisted entry, leaving the device stuck with `desired.size === 0`
   * until manual recovery). Calling the lib directly is cheap (it
   * caches internally) and self-healing across firmware upgrades.
   *
   * Re-publish is idempotent — the broker keys entries by
   * `(deviceId, camStreamId)`. Streams from a previous publish that no
   * longer appear in the latest snapshot are explicitly retracted so
   * the broker registry stays in sync.
   *
   * Native streams need a per-(channel, profile) RFC 4571 TCP server on
   * loopback — handed off to `ensureRfc4571Server`, which uses the lib's
   * shared-server pool (`sharedRfc4571Servers` keyed by `(deviceId,
   * channel, profile, variant, …)`). Without `deviceId` the lib falls
   * back to the unshared path: every call opens a fresh
   * BaichuanVideoStream on the same control socket, and 3 concurrent
   * stream probes overload the camera's session table → ECONNRESET.
   * With it, main + sub + ext coexist freely.
   */
  /**
   * Build this camera's pull-able stream catalog — the authoritative set
   * of descriptors the stream-broker needs to dial. Sole source of the
   * descriptors served by the `stream-catalog` cap (broker PULLS via
   * `registerStreamCatalogProvider`).
   *
   * Returns `[]` only when there is genuinely nothing to say: the
   * battery-sleep gate (logged at debug), or a camera that connected and
   * reported zero streams. An `ensureApi` / `buildVideoStreamOptions` failure
   * THROWS — `[]` and an error are not the same fact, and the broker needs
   * the difference to keep the device's existing entry and to schedule its
   * per-device backoff instead of treating the camera as stream-less.
   *
   * This method only BUILDS descriptors — it never opens an upstream
   * session or touches the broker.
   */
  private async buildStreamCatalog(): Promise<CamStreamDescriptor[]> {
    // Profile-stable SUCCESS cache: serve a previously-built catalog with zero
    // socket I/O (and therefore without waking a battery cam). This only ever
    // holds descriptors assembled from a real camera response — it is NOT an
    // error fallback (a transient failure still surfaces as a throw below).
    if (this.cachedStreamDescriptors?.length) {
      return this.withLiveNativeSdp(this.cachedStreamDescriptors)
    }
    // Cold RAM, warm ledger: rehydrate from the persisted `stream-catalog`
    // slice (D173). This is the difference between a restart being a pause and
    // a restart being an outage — see the cap's schema doc. Only ever holds a
    // catalog the camera itself once produced, so it is exactly as
    // authoritative as the RAM copy it replaces.
    const restored = this.restoreStreamCatalogFromLedger()
    if (restored) return this.withLiveNativeSdp(restored)
    // Coalesce concurrent broker pulls so we never stack GetEnc round-trips on
    // the doorbell's single BCUDP stream.
    if (this.buildStreamCatalogInFlight) {
      return this.withLiveNativeSdp(await this.buildStreamCatalogInFlight)
    }
    const build = this.buildStreamCatalogUncached()
    this.buildStreamCatalogInFlight = build
    try {
      return this.withLiveNativeSdp(await build)
    } finally {
      this.buildStreamCatalogInFlight = null
    }
  }

  /**
   * Upgrade native `pull-rfc4571` descriptors to the live upstream server's
   * real `tcp://` URL + real (sprop-bearing) SDP whenever a server is
   * currently listening in `this.active`. The synthetic catalog SDP omits
   * `sprop-parameter-sets`, which the raw ffmpeg decode reader cannot recover
   * (it has no in-band SPS/PPS merge) — so a decode-path consumer that pulls
   * the catalog after `materializeStreamSocket` must still see the real SDP.
   * See `native-sdp-overlay.ts`.
   */
  private withLiveNativeSdp(descriptors: readonly CamStreamDescriptor[]): CamStreamDescriptor[] {
    return overlayLiveNativeRfc4571Sdp(descriptors, (camStreamId): LiveRfc4571Endpoint | null => {
      const server = this.active.get(camStreamId)?.server
      if (!server?.server?.listening) return null
      return {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
        sdp: server.sdp,
      }
    })
  }

  /**
   * Synthesize the HTTP-FLV pull URL for a (channel, profile) pair. FLV is
   * served off the Reolink Baichuan media port (default 1935, app `bcs`) as
   * `channel<channel>_<profile>.bcs` — the same shape restreamer uses. The
   * lib does NOT surface this URL, so we build it from the SAME connection
   * creds the RTSP/native paths use (`host`/`username`/`password` on the
   * device config), URL-encoding the credentials.
   *
   * Returns `null` when the host isn't locally resolvable (hub-child cameras
   * borrow the parent's socket and hold no own `host`), so the caller skips
   * FLV publication for those devices rather than emitting a broken URL.
   */
  private buildFlvUrl(channel: number, profile: ReolinkStreamProfile): string | null {
    const host = this.config.get('host')
    if (typeof host !== 'string' || host.length === 0) return null
    const user = encodeURIComponent(String(this.config.get('username') ?? ''))
    const password = encodeURIComponent(String(this.config.get('password') ?? ''))
    return `http://${host}/flv?port=1935&app=bcs&stream=channel${channel}_${profile}.bcs&user=${user}&password=${password}`
  }

  /**
   * Heavy path: talk to the camera and assemble the descriptors. Only ever
   * entered when there is no cached catalog (see `buildStreamCatalog`).
   *
   * Never force-wakes. A sleeping battery cam with no cache yet returns []
   * here and is (re)built by `onWakeTransition` the next time it is naturally
   * awake — the broker re-pulls on the nudge event then. Waking the cam is the
   * on-demand dial's job, not the catalog poll's; the old force-wake-every-30s
   * drained the battery and, by bursting the socket, was itself what starved
   * GetEnc.
   */
  /**
   * The catalog a SLEEPING hub child can still offer: the parent's RTSP
   * relay entries, derived from the parent's config (host + credentials +
   * the Reolink Hub's per-channel relay scheme), with zero contact to the
   * child. This is the difference between a sleeping hub child being
   * playable and being a permanent "sleeping" tile: the broker gets a
   * dialable URL, the relay dial wakes the camera over RF (verified live
   * against the Home Hub, 2026-08-15), and the catalog never depended on
   * the child being awake to build.
   */
  private async buildHubRelayDescriptors(): Promise<CamStreamDescriptor[]> {
    if (!this.isHubChild()) return []
    const parentId = this.parentDeviceId
    if (parentId === null) return []
    const all = await this.ctx.devices.getAll()
    const parent = all.find((d) => d.id === parentId)
    const cfg = parent?.config.values as
      | { host?: string; username?: string; password?: string; port?: number }
      | undefined
    const host = cfg?.host
    if (typeof host !== 'string' || host.length === 0) return []
    const user = encodeURIComponent(String(cfg?.username ?? ''))
    const password = encodeURIComponent(String(cfg?.password ?? ''))
    const port = typeof cfg?.port === 'number' && cfg.port > 0 ? cfg.port : 554
    const channel = this.getChannel()
    const channelCount = this.channelCount()
    // Reolink Hub relay scheme (probed live): h264Preview_0{channel+1}_{profile}.
    const relayChannel = channel + 1
    const out: CamStreamDescriptor[] = []
    for (const profile of ['main', 'sub'] as const) {
      out.push({
        camStreamId: buildCamStreamId('rtsp', channel, profile, channelCount),
        kind: 'pull-rtsp',
        label: `Hub relay (${profile})`,
        url: `rtsp://${user}:${password}@${host}:${port}/h264Preview_0${relayChannel}_${profile}`,
        autoEligible: true,
        deviceFeatures: [...this.features],
      })
    }
    return out
  }

  private async buildStreamCatalogUncached(): Promise<CamStreamDescriptor[]> {
    // Battery cam asleep with nothing cached: do NOT wake it just to poll.
    if (this.isBattery && this.sleeping) {
      // A hub child is exempt: its relay catalog costs the camera nothing
      // (derived from the parent's config) and without it the child is
      // unwakeable-by-play — no broker, so no dial, and the dial is the only
      // real wake (the hub answers wakeUp's GetEnc from cache without
      // raising the camera).
      const relay = await this.buildHubRelayDescriptors().catch(() => [])
      if (relay.length > 0) {
        this.ctx.logger.debug(
          'buildStreamCatalog: sleeping hub child — serving hub relay entries',
          {
            tags: { deviceId: this.id },
            meta: { entries: relay.map((r) => r.camStreamId) },
          },
        )
        return relay
      }
      this.ctx.logger.debug(
        'buildStreamCatalog: battery cam sleeping, no cache — deferring to wake',
        {
          tags: { deviceId: this.id },
        },
      )
      return []
    }
    let api: ReolinkBaichuanApi
    try {
      api = await withTimeout(this.ensureApi(), 10_000, 'ensureApi')
    } catch (err) {
      // Unreachable camera is an ERROR, not an empty catalog. Returning []
      // would make the broker drop the device's entry → the next stream open
      // fails with "No broker for stream <id>". Throw so the broker keeps the
      // prior entry and retries on the next reconcile.
      throw new Error(
        `buildStreamCatalog: ensureApi failed for device ${this.id}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    // NOTE: no force-wake here (see method doc). The catalog is read only when
    // the cam is already awake (on-wake build) or already cached.
    let streamOptions: import('@apocaliss92/nodelink-js').ReolinkVideoStreamOptionsResult
    // Hub-child cams share the parent's Baichuan socket. Pass our
    // channel + `onNvr: true` so the lib's stream enumeration runs
    // against the correct channel index — otherwise we get channel
    // 0's streams while addressing channel N's RFC 4571 server,
    // which produces black frames + the misleading
    // `[native-rfc4571 ch=0 profile=main]` log on a child whose
    // actual channel is 3.
    const isChild = this.isHubChild()
    const ownChannel = this.getChannel()
    const buildOptions = isChild ? { channel: ownChannel, onNvr: true } : undefined
    const readStreamOptions = async (
      current: ReolinkBaichuanApi,
    ): Promise<import('@apocaliss92/nodelink-js').ReolinkVideoStreamOptionsResult> =>
      withTimeout(
        buildOptions
          ? current.buildVideoStreamOptions(buildOptions)
          : current.buildVideoStreamOptions(),
        10_000,
        'buildVideoStreamOptions',
      )
    try {
      streamOptions = await readStreamOptions(api)
    } catch (err) {
      // ONE re-auth retry, then give up. `ensureApi` returns the CACHED client
      // whenever `this.api` is set, and a Baichuan session that has EXPIRED
      // under a socket that is still open produces exactly this: every
      // GetEnc answers `responseCode 400, empty body`, nothing emits
      // `close`/`error`, so `scheduleReconnect` never fires and the cached
      // client is handed back forever. Measured 2026-08-25 on device 3629:
      // 35+ minutes of `buildVideoStreamOptions failed` every 30 s, and the
      // only cure was restarting the addon. Dropping the session here is the
      // difference between a blip and a camera that stays dark until someone
      // notices.
      //
      // Not a new auth flow: `close()` + `this.api = null` is the same
      // invalidation `scheduleReconnect` and the debug-options patch already
      // perform, and the re-login is the existing `ensureApi`.
      //
      // Hub children are EXCLUDED on purpose. Their session belongs to the
      // parent Hub and is shared by every child on it — tearing it down
      // because ONE child's GetEnc failed is a fleet-scale action taken on a
      // single-device signal, the exact shape this whole change exists to
      // remove. The Hub owns its own reconnect (`ReolinkHub.scheduleReconnect`).
      //
      // No wake concern: we are past the battery-sleep gate above, so the
      // camera is awake and a second login costs it nothing.
      if (isChild) {
        throw new Error(
          `buildStreamCatalog: buildVideoStreamOptions failed for device ${this.id}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      this.ctx.logger.warn(
        'buildStreamCatalog: stream options read failed — dropping the Baichuan session and retrying once',
        {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      await this.dropBaichuanSession('stream-catalog-retry')
      try {
        const fresh = await withTimeout(this.ensureApi(), 10_000, 'ensureApi')
        streamOptions = await readStreamOptions(fresh)
      } catch (retryErr) {
        // Couldn't read stream options — error, not empty. Throw so the broker
        // keeps the device's entry instead of dropping it (see ensureApi
        // above). The broker's per-device backoff owns the next attempt.
        throw new Error(
          `buildStreamCatalog: buildVideoStreamOptions failed for device ${this.id} (after one re-auth retry): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          { cause: retryErr },
        )
      }
      this.ctx.logger.info('buildStreamCatalog: stream options read recovered after re-auth', {
        tags: { deviceId: this.id },
      })
    }
    const channelCount = this.channelCount()
    const desired = new Map<
      string,
      {
        readonly camStreamId: string
        readonly kind: 'pull-rfc4571' | 'pull-rtsp' | 'pull-rtmp' | 'pull-flv'
        readonly label: string
        readonly url?: string
        readonly autoEligible: boolean
        readonly resolution?: { width: number; height: number }
        readonly fps?: number
        readonly codec?: string
        readonly metadata?: Record<string, unknown>
      }
    >()

    // Native streams: LAZY PUBLISH. We build the broker entries from
    // device-side metadata (`buildVideoStreamOptions` → cmd_id 56
    // GetEnc) without opening the upstream Baichuan streaming session.
    // The lib's `createRfc4571TcpServer` would normally extract SDP
    // from a live IDR frame — that requires opening a dedicated TCP
    // session on the NVR for the channel, which then squats in the
    // firmware's session table for minutes after release.
    //
    // Instead we publish each entry with:
    //   - a synthetic SDP built from `videoEncType` + audio metadata
    //     (`buildSyntheticRfc4571Sdp`). SPS/PPS are omitted; the
    //     muxer's `sendCachedVideoConfigToClient` primes downstream
    //     consumers from in-band keyframe NAL units once the upstream
    //     session is active.
    //   - a `lazy:rfc4571:` sentinel URL. The broker detects this on
    //     dial and emits `StreamBrokerOnRequestStreamSourceRefresh`
    //     instead of attempting to connect. The
    //     `addon.onStreamBrokerOnRequestStreamSourceRefresh` handler
    //     responds by calling `materializeStreamSocket(camStreamId)`,
    //     which is the only path that actually opens the upstream
    //     Baichuan session via `ensureRfc4571Server`.
    //
    // Net effect: zero new sockets to the NVR until a consumer
    // (UI viewer, pipeline runner, restreamer) actually demands the
    // stream. Idle hub-children = idle session table firmware-side.
    for (const s of streamOptions.nativeStreams) {
      const fallbackChannel = isChild ? ownChannel : DEFAULT_CHANNEL
      const id = buildCamStreamId('native', s.channel ?? fallbackChannel, s.profile, channelCount)
      const m = s.metadata
      // Some Reolink firmwares report `videoEncType` as `"H.265"` /
      // `"H.264"` (with a dot), others as `"H265"` / `"H264"`. Strip
      // non-alphanumerics + lowercase so the broker registry stores
      // the canonical `"h265"` / `"h264"` form.
      const codec = normalizeCodecName(m?.videoEncType) ?? 'h264'
      const sdp = buildSyntheticRfc4571Sdp({
        videoEncType: m?.videoEncType ?? 'H.264',
        audioEnabled: (m?.audio ?? 0) === 1,
      })
      const entry: {
        readonly camStreamId: string
        readonly kind: 'pull-rfc4571' | 'pull-rtsp' | 'pull-rtmp' | 'pull-flv'
        readonly label: string
        readonly url: string
        readonly autoEligible: boolean
        readonly resolution?: { width: number; height: number }
        readonly fps?: number
        readonly codec: string
        readonly metadata: Record<string, unknown>
      } = {
        camStreamId: id,
        kind: 'pull-rfc4571',
        label: s.name && s.name.length > 0 ? s.name : streamLabel(s, 'native'),
        url: buildLazyRfc4571Url(id),
        autoEligible: true,
        ...(m && m.width > 0 && m.height > 0
          ? { resolution: { width: m.width, height: m.height } }
          : {}),
        ...(m && m.frameRate > 0 ? { fps: m.frameRate } : {}),
        codec,
        metadata: { sdp },
      }
      desired.set(id, entry)
    }

    // RTSP and RTMP — selectable secondary options, broker pulls directly
    // from the camera's own URLs. No local server needed.
    const enqueueAlt = (
      kind: 'rtsp' | 'rtmp',
      streams: ReadonlyArray<import('@apocaliss92/nodelink-js').ReolinkSupportedStream>,
    ): void => {
      if (streams.length === 0) return
      const brokerKind = kind === 'rtsp' ? 'pull-rtsp' : 'pull-rtmp'
      const fallbackChannel = isChild ? ownChannel : DEFAULT_CHANNEL
      for (const s of streams) {
        const id = buildCamStreamId(kind, s.channel ?? fallbackChannel, s.profile, channelCount)
        if (desired.has(id)) continue
        const m = s.metadata
        desired.set(id, {
          camStreamId: id,
          kind: brokerKind,
          label: s.name && s.name.length > 0 ? s.name : streamLabel(s, kind),
          url: s.urlWithAuth,
          autoEligible: false,
          ...(m && m.width > 0 && m.height > 0
            ? { resolution: { width: m.width, height: m.height } }
            : {}),
          ...(m && m.frameRate > 0 ? { fps: m.frameRate } : {}),
          ...(normalizeCodecName(m?.videoEncType)
            ? { codec: normalizeCodecName(m?.videoEncType)! }
            : {}),
        })
      }
    }
    enqueueAlt('rtsp', streamOptions.rtspStreams)
    enqueueAlt('rtmp', streamOptions.rtmpStreams)

    // HTTP-FLV — restreamer reports this as the most-reliable Reolink
    // container. nodelink-js does NOT surface an FLV url, so we synthesize
    // the Baichuan media-port URL (port 1935 / app `bcs`). We mirror the
    // channel+profile set of the native streams (FLV is served whenever the
    // Baichuan media port is, independent of the RTSP/RTMP toggles). These
    // entries carry `pull-flv`; the broker ALWAYS ingests them through its
    // ffmpeg source reader (native TS clients can't read FLV). Opt-in
    // secondary (`autoEligible: false`), like RTSP/RTMP. Skipped entirely
    // when the host isn't resolvable from local config (e.g. hub children,
    // which borrow the parent's socket and hold no own host/creds).
    for (const s of streamOptions.nativeStreams) {
      const channel = s.channel ?? (isChild ? ownChannel : DEFAULT_CHANNEL)
      const id = buildCamStreamId('flv', channel, s.profile, channelCount)
      if (desired.has(id)) continue
      const flvUrl = this.buildFlvUrl(channel, s.profile)
      if (!flvUrl) break
      const m = s.metadata
      desired.set(id, {
        camStreamId: id,
        kind: 'pull-flv',
        label: streamLabel(s, 'flv'),
        url: flvUrl,
        autoEligible: false,
        ...(m && m.width > 0 && m.height > 0
          ? { resolution: { width: m.width, height: m.height } }
          : {}),
        ...(m && m.frameRate > 0 ? { fps: m.frameRate } : {}),
        ...(normalizeCodecName(m?.videoEncType)
          ? { codec: normalizeCodecName(m?.videoEncType)! }
          : {}),
      })
    }

    if (desired.size === 0) {
      // Genuine empty: the camera connected and reported zero streams. This is
      // a real (not error) state, so [] is correct here.
      this.ctx.logger.warn('buildStreamCatalog: camera reports no streams — empty catalog', {
        tags: { deviceId: this.id },
      })
      return []
    }

    // Stamp each entry with the device-level features + autoEligible so
    // the descriptor carries the same payload the broker's
    // `publishCameraStream` envelope did, for the `stream-catalog` pull.
    // First successful build: stop force-waking on subsequent reconcile polls
    // (battery preservation — see the wake gate above).
    const descriptors = [...desired.values()].map(
      (e): CamStreamDescriptor => ({
        camStreamId: e.camStreamId,
        kind: e.kind,
        label: e.label,
        ...(e.url ? { url: e.url } : {}),
        ...(e.resolution ? { resolution: e.resolution } : {}),
        ...(e.fps !== undefined ? { fps: e.fps } : {}),
        ...(e.codec !== undefined ? { codec: e.codec } : {}),
        ...(e.metadata ? { metadata: e.metadata } : {}),
        deviceFeatures: [...this.features],
        autoEligible: e.autoEligible,
      }),
    )
    this.cachedStreamDescriptors = descriptors
    this.persistStreamCatalogToLedger(descriptors)
    return descriptors
  }

  /** Profile-stable stream descriptors, cached after the first successful
   *  build. Served on every subsequent pull WITHOUT touching the camera, so a
   *  sleeping battery cam is never woken by a catalog poll. Invalidated by
   *  `applyStreamProfilePatch` (codec/resolution may change). */
  private cachedStreamDescriptors: CamStreamDescriptor[] | undefined

  /**
   * Write the just-built catalog to the durable `stream-catalog` slice, so a
   * restart with the camera asleep still has descriptors to serve (D173).
   *
   * Best-effort by design: the RAM copy is already advanced by the caller, and
   * losing this write costs one cold catalog after the next restart — never a
   * wrong catalog. A build that FAILED writes nothing at all and therefore
   * cannot demote a good stored copy (D49's failure direction).
   */
  private persistStreamCatalogToLedger(descriptors: readonly CamStreamDescriptor[]): void {
    if (descriptors.length === 0) return
    try {
      const state: StreamCatalogState = {
        descriptors: [...descriptors],
        lastFetchedAt: Date.now(),
      }
      this.runtimeState.setCapState(streamCatalogCapability.name, state)
      this.ctx.logger.debug('stream catalog persisted to the durable slice', {
        tags: { deviceId: this.id },
        meta: { count: descriptors.length },
      })
    } catch (err) {
      this.ctx.logger.debug('stream catalog persist failed — RAM copy stands', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Rehydrate `cachedStreamDescriptors` from the durable slice. Returns the
   * restored descriptors, or `null` when there is nothing to restore.
   *
   * Logged at `info` when it fires: "these descriptors came from before the
   * restart" must never be something a reader has to infer (the DurableLedger
   * contract, D132).
   */
  private restoreStreamCatalogFromLedger(): CamStreamDescriptor[] | null {
    const stored = this.runtimeState.getCapState<StreamCatalogState>(streamCatalogCapability.name)
    const descriptors = stored?.descriptors
    if (!descriptors || descriptors.length === 0) return null
    this.cachedStreamDescriptors = [...descriptors]
    this.ctx.logger.info('stream catalog restored from the durable slice (no camera contact)', {
      tags: { deviceId: this.id },
      meta: {
        count: descriptors.length,
        builtAt: stored?.lastFetchedAt ?? 0,
        ageMs: Date.now() - (stored?.lastFetchedAt ?? 0),
        sleeping: this.sleeping,
      },
    })
    return this.cachedStreamDescriptors
  }

  /**
   * How old a RESTORED catalog may get before a natural wake is worth spending
   * on a re-read. The catalog is profile-stable, so this is not about
   * freshness — it is the backstop for a profile changed by something that did
   * not invalidate the cache (a firmware update, an edit made on the Reolink
   * app). A day is several natural wakes on any camera that is working.
   */
  private static readonly CATALOG_REFRESH_ON_WAKE_MS = 24 * 60 * 60_000
  /** Single-flight guard for `buildStreamCatalog`. */
  private buildStreamCatalogInFlight: Promise<CamStreamDescriptor[]> | null = null

  /**
   * Register the device-scoped `stream-catalog` cap — the broker PULLS
   * this (on start / reconcile poll / device + stream-params events) to
   * (re)build its cam-stream registry. Shares the descriptor builder
   * (`buildStreamCatalog`) with the dial-time `materializeStreamSocket`
   * handoff.
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

  private async publishOne(entry: CamStreamDescriptor): Promise<void> {
    try {
      await this.ctx.api.streamBroker.publishCameraStream.mutate({
        deviceId: this.id,
        camStreamId: entry.camStreamId,
        kind: entry.kind,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.resolution ? { resolution: entry.resolution } : {}),
        ...(entry.fps !== undefined ? { fps: entry.fps } : {}),
        ...(entry.codec !== undefined ? { codec: entry.codec } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
        deviceFeatures: entry.deviceFeatures ?? [...this.features],
        autoEligible: entry.autoEligible ?? true,
      })
      this.publishedStreamIds.add(entry.camStreamId)
    } catch (err) {
      this.ctx.logger.warn('publishCameraStream failed', {
        tags: { deviceId: this.id, camStreamId: entry.camStreamId },
        meta: { kind: entry.kind, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Materialize the upstream rfc4571 streaming session for one
   * camStreamId on demand. Called from the
   * `StreamBrokerOnRequestStreamSourceRefresh` listener when the broker
   * is about to dial a `lazy:rfc4571:` placeholder URL (or when an
   * established session went stale and the lib's loopback teardown ran).
   *
   * The flow:
   *   1. Parse camStreamId → (channel, profile)
   *   2. Open the rfc4571 server via `ensureRfc4571Server`. THIS is the
   *      single point where a new TCP session to the NVR is opened —
   *      the catalog pull only carries the `lazy:rfc4571:` sentinel.
   *   3. Re-publish the broker entry with the real `tcp://...` URL +
   *      the lib's accurate SDP (the lib has SPS/PPS now). The broker
   *      picks up the fresh URL on its next `sourceProvider()` call.
   *
   * Idempotent: subsequent calls reuse the cached server when still
   * listening; if the lib idle-tore-down between calls we recreate.
   */
  async materializeStreamSocket(camStreamId: string): Promise<void> {
    const parts = parseCamStreamId(camStreamId, this.getChannel())
    if (!parts || parts.kind !== 'native') {
      // Non-native streams (rtsp/rtmp) carry their own URL upfront;
      // refresh requests for them are a no-op.
      return
    }
    // Log AFTER the native-kind check — a non-native refresh drops out above
    // and must NOT be logged as "materializing" (the caller used to log this
    // before the check, mislabelling the silent drop as a successful refresh).
    this.ctx.logger.info('broker requested rfc4571 source refresh — materializing on demand', {
      tags: { deviceId: this.id },
      meta: { camStreamId },
    })
    const server = await this.ensureRfc4571Server(camStreamId, parts.channel, parts.profile)
    if (!server) {
      this.ctx.logger.warn('materializeStreamSocket: ensureRfc4571Server returned null', {
        tags: { deviceId: this.id, camStreamId },
      })
      return
    }
    const auth = `${encodeURIComponent(server.username)}:${encodeURIComponent(server.password)}`
    const url = `tcp://${auth}@${server.host}:${server.port}`
    // The lib's SDP carries SPS/PPS extracted from the live IDR — use
    // it (instead of the synthetic SDP) for the materialized entry so
    // downstream consumers get the most accurate decoder config. Both
    // the synthetic and the lib's SDP describe the same stream; only
    // the parameter sets differ.
    const codec = server.videoType === 'H265' ? 'h265' : 'h264'
    // Preserve resolution + fps + label from the built catalog descriptor. The
    // broker OVERWRITES a stream's fields on every re-publish, so omitting them
    // here (materialize runs on EVERY on-demand dial) would CLEAR the
    // resolution — which demotes this stream in the broker's pixel-count auto
    // ranking (`computeInitialAssignment`: no-resolution sorts last). For a
    // 3-stream Reolink that flips the `high` slot main↔ext every materialize,
    // oscillating the detection stream → a detection restart + re-materialize
    // loop (~6s churn) that starves the decoder. Carry the descriptor forward.
    const descriptor = this.cachedStreamDescriptors?.find((d) => d.camStreamId === camStreamId)
    await this.publishOne({
      camStreamId,
      kind: 'pull-rfc4571',
      label: descriptor?.label ?? camStreamId,
      url,
      codec,
      autoEligible: true,
      ...(descriptor?.resolution ? { resolution: descriptor.resolution } : {}),
      ...(descriptor?.fps !== undefined ? { fps: descriptor.fps } : {}),
      metadata: { sdp: server.sdp },
    })
    this.ctx.logger.info('materialized rfc4571 stream socket on broker demand', {
      tags: { deviceId: this.id, camStreamId },
      meta: { url: `tcp://${server.host}:${server.port}` },
    })
  }

  override async removeDevice(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reachability.dispose()
    this.ctx.logger.info('Removing Reolink camera', { meta: { stableId: this.stableId } })
    const ids = [...this.publishedStreamIds]
    await Promise.all(
      ids.map((id) =>
        this.ctx.api.streamBroker.retractCameraStream
          .mutate({ deviceId: this.id, camStreamId: id })
          .catch((err: unknown) => {
            this.ctx.logger.debug('retractCameraStream failed', {
              tags: { deviceId: this.id, camStreamId: id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          }),
      ),
    )
    this.publishedStreamIds.clear()
    await this.disconnectAll()
  }

  // ── Native-stream RFC 4571 servers ───────────────────────────────────

  /**
   * Spin up a loopback RFC 4571 TCP server for one (channel, profile)
   * tuple if we don't already have one. Returns the running server with
   * its `host`/`port`/`sdp`/`username`/`password`. Idempotent — repeat
   * calls return the existing instance.
   *
   * The lib's server manages the underlying Baichuan socket lifecycle
   * (open on first client connect, close on idle teardown), which keeps
   * battery cams asleep until a real consumer pulls the stream.
   */
  async ensureRfc4571Server(
    camStreamId: string,
    channel: number,
    profile: 'main' | 'sub' | 'ext',
  ): Promise<Rfc4571TcpServer | null> {
    // Self-healing: the lib's rfc4571 servers idle-teardown after
    // ~15s with no TCP client. If a previous `ensureRfc4571Server`
    // call cached a server that has since been torn down,
    // `existing.server.server.listening` is false. We close the
    // cached entry and fall through to recreate.
    const existing = this.active.get(camStreamId)
    if (existing?.server?.server?.listening) return existing.server
    if (existing) {
      this.ctx.logger.info('rfc4571: cached server is down — recreating', {
        tags: { deviceId: this.id, camStreamId },
      })
      try {
        await existing.server.close('recreate')
      } catch {
        /* already closed */
      }
      this.active.delete(camStreamId)
    }

    let api: ReolinkBaichuanApi
    try {
      api = await this.ensureApi()
    } catch (err) {
      this.ctx.logger.error('rfc4571: Baichuan login failed', {
        tags: { deviceId: this.id, camStreamId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      // Online state is firmware-push-driven only —
      // RFC4571 / login failures don't flip it; the next firmware
      // 'offline' push (or absence of an 'online' push) carries the
      // semantic transition.
      return null
    }

    // Use a per-stream username/password so the broker's pull URL stays
    // self-contained. Random suffix avoids leaking any device-level
    // secret onto the loopback socket. Auth is required to keep an
    // accidental scan on a free port from grabbing the stream.
    const username = `cam${this.id}`
    const password = randomToken(16)

    let server: Rfc4571TcpServer
    try {
      server = await createRfc4571TcpServer({
        api,
        // Keep our shared base api alive when the lib tears down a single
        // RFC 4571 server — the `disconnectAll` path handles api closure.
        closeApiOnTeardown: false,
        channel,
        profile,
        host: '127.0.0.1',
        username,
        password,
        requireAuth: true,
        // `deviceId` enables the lib's shared-server pool (see
        // `buildSharedRfc4571Key` in nodelink-js) — keyed by
        // `(deviceId, channel, profile, variant, …)`. Without it the
        // lib's "unshared" path opens a fresh BaichuanVideoStream on
        // the same control socket on EVERY call, and 3 concurrent
        // stream probes overload the camera (ECONNRESET). The pool
        // also handles in-flight dedup + refcount, so concurrent
        // assignProfile / publish races don't double-create.
        deviceId: this.stableId,
        // `requestedId` is used by the lib for composite-stream
        // pairing inference and shows up in shared-pool logs — pass
        // our broker camStreamId so log lines can be cross-referenced
        // with the broker's profile slots.
        requestedId: camStreamId,
        // Pass a console-shaped logger; the lib only calls `.log`/`.error`/
        // `.warn`/`.info`/`.debug` and we want them on our scoped logger.
        logger: this.libLoggerAdapter(),
      })
    } catch (err) {
      this.ctx.logger.error('rfc4571: createRfc4571TcpServer failed', {
        tags: { deviceId: this.id, camStreamId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }

    const entry = { camStreamId, profile: this.profileForCamStream(camStreamId), server }
    this.active.set(camStreamId, entry)

    // Note: the lib's idle-teardown closes its TCP listener after ~15s with
    // no clients. Without this listener the cache would survive the
    // teardown and the next `ensureRfc4571Server` call would still see
    // a stale entry until the explicit liveness check at the top of
    // the function. Evicting on `'close'` keeps the cache truthful
    // even when nobody asks for a while.
    server.server.once('close', () => {
      const current = this.active.get(camStreamId)
      if (current?.server === server) {
        this.active.delete(camStreamId)
        this.ctx.logger.debug('rfc4571: server closed — evicting cache entry', {
          tags: { deviceId: this.id, camStreamId },
        })
      }
    })

    this.ctx.logger.info('rfc4571: server listening', {
      tags: { deviceId: this.id, camStreamId },
      meta: {
        host: server.host,
        port: server.port,
        videoType: server.videoType,
        audio: server.audio?.codec ?? null,
      },
    })

    return server
  }

  /** Map a camStreamId back to its broker profile (for `ActiveStream.profile`). */
  private profileForCamStream(camStreamId: string): CamProfile {
    // Best-effort. For NVR per-channel streams the camStreamId is `native:ch{N}-main`,
    // but the broker profile is what assignment chose. Default to 'high' if unknown —
    // this field is informational only (logging).
    if (camStreamId.endsWith(':sub') || camStreamId.endsWith('-sub')) return 'low'
    if (camStreamId.endsWith(':ext') || camStreamId.endsWith('-ext')) return 'mid'
    return 'high'
  }

  /**
   * Adapt the camstack scoped logger to the `Console` shape the lib expects.
   * Drops the structured `meta` object — the lib only formats the message,
   * not our hierarchical log fields.
   */
  private libLoggerAdapter(): Console {
    const log = this.ctx.logger.child('nodelink')
    const wrap =
      (level: 'info' | 'warn' | 'error' | 'debug') =>
      (...args: unknown[]) => {
        const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
        log[level](message, {})
      }
    // Console is a class — coerce structurally; we only fill the methods the lib uses.
    return {
      log: wrap('info'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
      debug: wrap('debug'),
    } as Console
  }

  /**
   * Close every running RFC 4571 server (Slice 9). Used when the camera
   * reports sleep / device removal. Keeps the api alive so we still
   * receive `awake` events; the servers will be re-spawned the next
   * time the broker dials a stream and `materializeStreamSocket` runs.
   */
  private async closeActiveStreams(reason: string): Promise<void> {
    const entries = [...this.active.values()]
    this.active.clear()
    if (entries.length === 0) return
    this.ctx.logger.debug('Closing active RFC 4571 servers', {
      tags: { deviceId: this.id },
      meta: { count: entries.length, reason },
    })
    for (const entry of entries) {
      try {
        await entry.server.close('teardown')
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Periodic passive sleep-status poll (Slice 9, battery cams only).
   * Calls `api.getSleepStatus()` which inspects recent socket I/O —
   * no network traffic emitted, no risk of waking the camera. Used to
   * reconcile our `this.sleeping` flag when push events miss the
   * `sleeping`/`awake` transition (firmware quirks, NAT timeouts).
   */
  private startSleepPoll(): void {
    if (this.sleepPollTimer) return
    if (!this.isBattery) return
    // Hub-child battery cams: skip the poll.
    // The Hub holds the single Baichuan subscription and forwards
    // `awake`/`sleeping` simpleEvents into the child's
    // `handleSimpleEvent`, which is the canonical writer of the
    // `battery.sleeping` slice. A second poll on the child would
    // duplicate the work without adding signal.
    if (this.isHubChild()) return
    // 5 s. Pure passive
    // call (`api.getSleepStatus` inspects internal socket-I/O cache,
    // emits no network traffic), so a tight cadence is cheap.
    const POLL_MS = 5_000
    this.sleepPollTimer = setInterval(() => {
      const api = this.api
      if (!api) return
      try {
        const status = api.getSleepStatus({ channel: this.getChannel() })
        if (status.state === 'sleeping' && !this.sleeping) {
          // Active-consumer guard. `getSleepStatus` infers "sleeping"
          // from recent Baichuan CONTROL-socket I/O (rx/tx command
          // history + `isDeviceStreamingActive`). The lib's own
          // active-streaming guard keys off `activeVideoMsgNums`, which
          // briefly empties whenever an rfc4571 server idle-tears-down
          // (~15s with no TCP client) and recreates between broker
          // pulls — so a stream the operator is actively watching can
          // momentarily look "sleeping" on the control socket while
          // media still flows over the separate rfc4571 media path.
          // Acting on that false positive here would `closeActiveStreams`
          // a live, watched stream (the broker would re-dial, the cam
          // re-wakes, and we'd flap sleep↔wake every ~30-50s — the
          // exact teardown-every-30s symptom). When we hold live
          // rfc4571 servers (`this.active.size > 0`) a genuine consumer
          // is attached and continuously pulling, which keeps the cam
          // awake — so treat the poll's "sleeping" as a false positive,
          // skip both the slice flip and the teardown, and let the
          // firmware `sleeping` push (or stream-idle teardown, which
          // drains `this.active`) drive the real transition. Matches
          // this file's own `sleeping` simpleEvent handler (`if (this.active.size
          // > 0)`).
          if (this.active.size > 0) {
            this.ctx.logger.debug(
              'Sleep poll inferred sleep but streams are active — ignoring (consumer attached)',
              {
                tags: { deviceId: this.id },
                meta: { idleMs: status.idleMs, activeStreams: this.active.size },
              },
            )
            return
          }
          // Single writer (`commitSleepState`) — the poll used to write
          // `this.state.battery.sleeping` directly, which bypassed the
          // hysteresis AND left `sleepStateChangedAt` stale so the next
          // simpleEvent compared against an ancient timestamp.
          if (!this.commitSleepState(true, 'sleep-poll')) return
          this.ctx.logger.info('Sleep poll detected sleep — closing active streams', {
            tags: { deviceId: this.id },
            meta: { idleMs: status.idleMs },
          })
          void this.closeActiveStreams('sleep-poll').catch(() => {
            /* best-effort */
          })
        } else if (status.state === 'awake' && this.sleeping) {
          if (!this.commitSleepState(false, 'sleep-poll')) return
          this.ctx.logger.debug('Sleep poll detected awake', { tags: { deviceId: this.id } })
          // Backstop for a missed `awake` push event — drive the
          // same refresh contract the simpleEvent handler uses so
          // both paths converge to identical post-wake state.
          void this.onWakeTransition('sleep-poll').catch(() => {
            /* best-effort */
          })
        }
      } catch (err) {
        this.ctx.logger.debug('sleep poll error', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }, POLL_MS)
    if (typeof this.sleepPollTimer.unref === 'function') this.sleepPollTimer.unref()
  }

  private stopSleepPoll(): void {
    if (this.sleepPollTimer) {
      clearInterval(this.sleepPollTimer)
      this.sleepPollTimer = null
    }
  }

  // ── Aux device align ────────────────────────────────────────────────
  //
  // Spawned accessory children (siren, floodlight, pir) hold their own
  // runtime-state slice but don't poll. The parent runs a single
  // periodic align that refreshes every child's slice from firmware,
  // respecting:
  //   - per-accessory cooldowns (15s window after operator setState
  //     so a stale firmware read doesn't clobber the just-applied
  //     value — Reolink's GET endpoints lag the SET by 5-10s).
  //   - the parent's sleep state (battery cams: skip while sleeping;
  //     run once on the awake transition).
  // Wired cams: setInterval at 10s.

  /** Implements `ReolinkAccessoryHost.registerAccessoryChild`. Called
   *  from each accessory's constructor. Idempotent — re-registering the
   *  same kind overwrites the prior ref (covers a replay-on-restart
   *  scenario where the parent ctor lands before the child ctor of an
   *  already-spawned accessory). */
  registerAccessoryChild(ref: import('./accessories/base.js').ReolinkAccessoryRef): void {
    this.auxAccessoryRefs.set(ref.kind, ref)
    this.ctx.logger.info('reolink: aux accessory registered with parent', {
      tags: { deviceId: this.id, accessoryDeviceId: ref.id },
      meta: {
        kind: ref.kind,
        parentIsBattery: this.isBattery,
        parentSleeping: this.sleeping,
        totalAccessoryRefs: this.auxAccessoryRefs.size,
      },
    })
  }

  /** Pull-once refresh of every registered aux accessory's slice.
   *  Best-effort: per-accessory failures are logged + swallowed by the
   *  individual `refreshFromAlign` impls; this loop never throws. */
  private async alignAuxDevicesState(reason: 'periodic' | 'wake' | 'init'): Promise<void> {
    if (this.auxAccessoryRefs.size === 0) {
      this.ctx.logger.info('alignAuxDevicesState: no aux accessories registered — skipping', {
        tags: { deviceId: this.id },
        meta: { reason },
      })
      return
    }
    if (this.isBattery && this.sleeping && reason === 'periodic') {
      // Battery cam asleep → skip (would 400 + drain). The wake
      // transition path will fire `alignAuxDevicesState('wake')` when
      // the cam comes back up.
      this.ctx.logger.info('alignAuxDevicesState: battery cam sleeping — skipping periodic align', {
        tags: { deviceId: this.id },
        meta: { reason, accessoryCount: this.auxAccessoryRefs.size },
      })
      return
    }
    const refs = [...this.auxAccessoryRefs.values()]
    this.ctx.logger.info('alignAuxDevicesState: refreshing aux accessories from firmware', {
      tags: { deviceId: this.id },
      meta: { reason, accessoryCount: refs.length, accessories: refs.map((r) => r.kind) },
    })
    const skipped: string[] = []
    // SERIALIZED on purpose: a battery doorbell speaks Baichuan over a single
    // BCUDP byte-stream with one shared packet sequence, and the library does
    // not serialize writes. Issuing accessory refreshes concurrently collides
    // their replies on that stream and starves the heavier multi-packet GetEnc
    // reply until it times out (cmdId=56). One refresh at a time keeps the
    // socket sane — a sequential `await` per accessory is what this
    // hardware needs.
    for (const ref of refs) {
      if (ref.isInCooldown()) {
        skipped.push(ref.kind)
        continue
      }
      try {
        await ref.refreshFromAlign()
        this.ctx.logger.info('alignAuxDevicesState: accessory refresh OK', {
          tags: { deviceId: this.id, accessoryDeviceId: ref.id },
          meta: { reason, kind: ref.kind },
        })
      } catch (err: unknown) {
        this.ctx.logger.warn('alignAuxDevicesState: accessory refresh FAILED', {
          tags: { deviceId: this.id, accessoryDeviceId: ref.id },
          meta: { reason, kind: ref.kind, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    if (skipped.length > 0) {
      this.ctx.logger.info('alignAuxDevicesState: skipped (cooldown)', {
        tags: { deviceId: this.id },
        meta: { reason, skipped },
      })
    }
  }

  /** Start periodic align for wired cams. No-op for battery cams (wake
   *  path handles it). Idempotent. */
  private startAlignAuxPolling(): void {
    if (this.alignAuxTimer) return
    if (this.isBattery) return
    const POLL_MS = 10_000
    this.alignAuxTimer = setInterval(() => {
      void this.alignAuxDevicesState('periodic')
    }, POLL_MS)
    if (typeof this.alignAuxTimer.unref === 'function') this.alignAuxTimer.unref()
  }

  private stopAlignAuxPolling(): void {
    if (this.alignAuxTimer) {
      clearInterval(this.alignAuxTimer)
      this.alignAuxTimer = null
    }
  }

  // ── Battery-cam scheduled full refresh (D847) ────────────────────────
  //
  // Once per window (default 60 min, `batteryRefreshMinutes`) the camera
  // refreshes EVERY fact it owns and its cached snapshot, either because it was
  // found awake or because it was woken for it at the window's deadline. The
  // rule, the windows and the retry bound live in `battery-hourly-refresh.ts`;
  // this section only supplies the camera's side of it. It replaces the old
  // hourly cycle that did nothing while the camera slept (device 106 showed
  // 80 % until it died) and D355's separate contact-expiry wake: the scheduled
  // refresh stamps contact itself, and the longest window (4 h) stays inside
  // the 6 h presence budget.

  private batteryRefresh: BatteryHourlyRefresh | null = null

  private getBatteryRefresh(): BatteryHourlyRefresh {
    if (this.batteryRefresh === null) {
      this.batteryRefresh = new BatteryHourlyRefresh({
        deviceId: this.id,
        logger: this.ctx.logger,
        now: () => Date.now(),
        isAwake: () => !this.sleeping,
        intervalMs: () => resolveBatteryRefreshIntervalMs(this.config.get('batteryRefreshMinutes')),
        lastFullRefreshAt: () => this.state.battery.lastFullRefreshAt,
        // The existing wake path, behind the shared cooldown: a wake some other
        // path issued in the last minutes already has the camera up, and the
        // awake branch of the controller will find it there.
        wake: async () => {
          if (!this.canProactivelyWake('scheduled-refresh')) return false
          this.markWakeIssued()
          return this.wakeIfSleeping()
        },
        refreshAll: () => this.refreshEverythingNow(),
        stamp: (at) => {
          this.state.battery.lastFullRefreshAt = at
        },
      })
    }
    return this.batteryRefresh
  }

  /**
   * Every fact and the snapshot, read while the camera is up. SERIALIZED (one
   * Baichuan round-trip at a time on the single BCUDP stream), and each step
   * names itself in `failed` instead of throwing, so one dead read neither
   * hides the others nor stamps the window as done.
   */
  private async refreshEverythingNow(): Promise<BatteryRefreshOutcome> {
    const failed: string[] = []
    const step = async (name: string, run: () => Promise<boolean | void>): Promise<void> => {
      try {
        if ((await run()) === false) failed.push(name)
      } catch (err) {
        failed.push(name)
        this.ctx.logger.debug('battery hourly refresh: step threw', {
          tags: { deviceId: this.id },
          meta: { step: name, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    // Level, charging and (inside it) the signal/wifi link.
    await step('battery', () => this.refreshBatteryFromApi('demand'))
    await step('device-info', async () => {
      await this.populateMetadataFromFirmware(await this.ensureApi())
    })
    await step('cap-slices', async () => {
      await this.warmCapSlicesOnWake({ force: true })
    })
    await step('aux-accessories', () => this.alignAuxDevicesState('wake'))
    await step('settings-snapshot', () =>
      this.refreshParentSettingsSnapshot(undefined, 'scheduled'),
    )
    await step('snapshot', () => this.refreshSnapshotCache())
    return { failed }
  }

  /**
   * Run one scheduled-refresh check. Never throws; costs nothing unless a
   * refresh is due (see {@link decideBatteryRefresh}).
   */
  private async runBatteryUpdate(): Promise<void> {
    if (!this.isBattery) return
    await this.getBatteryRefresh().tick()
  }

  /** Arm the scheduled-refresh check. No-op for wired cams (their state is
   *  kept fresh by the 10 s aux-align poll and push events). Idempotent. */
  private startBatteryUpdatePolling(): void {
    if (this.batteryUpdateTimer) return
    if (!this.isBattery) return
    this.batteryUpdateTimer = setInterval(() => {
      void this.runBatteryUpdate().catch(() => {
        /* never throws; logged inside */
      })
    }, BATTERY_REFRESH_TICK_MS)
    if (typeof this.batteryUpdateTimer.unref === 'function') this.batteryUpdateTimer.unref()
    this.ctx.logger.info('battery-update: scheduled full refresh armed', {
      tags: { deviceId: this.id },
      meta: {
        tickMs: BATTERY_REFRESH_TICK_MS,
        intervalMs: resolveBatteryRefreshIntervalMs(this.config.get('batteryRefreshMinutes')),
        lastFullRefreshAt: this.state.battery.lastFullRefreshAt ?? null,
        isHubChild: this.isHubChild(),
      },
    })
  }

  private stopBatteryUpdatePolling(): void {
    if (this.batteryUpdateTimer) {
      clearInterval(this.batteryUpdateTimer)
      this.batteryUpdateTimer = null
    }
  }

  /**
   * Is this wake worth spending on a catalog re-read? See
   * `CATALOG_REFRESH_ON_WAKE_MS`. Held apart from `onWakeTransition` so the
   * decision is one expression a test can pin.
   */
  private shouldRebuildCatalogOnWake(): boolean {
    if (!this.cachedStreamDescriptors?.length) {
      // Nothing in RAM — but the restore may still cover us. Attempt it first
      // so a wake right after a restart does not re-read what we already hold.
      if (!this.restoreStreamCatalogFromLedger()) return true
    }
    const stored = this.runtimeState.getCapState<StreamCatalogState>(streamCatalogCapability.name)
    const builtAt = stored?.lastFetchedAt ?? 0
    if (builtAt <= 0) return true
    return Date.now() - builtAt > ReolinkCamera.CATALOG_REFRESH_ON_WAKE_MS
  }

  /**
   * A PASSIVE proof of reachability just arrived — stamp `battery.lastContactAt`
   * so `deriveBatteryPresence` can tell "asleep" from "gone" (D173).
   *
   * Callable only from paths where the evidence cost us nothing: an inbound
   * firmware push, an observed wake, a round-trip somebody else's demand
   * already paid for. Never from a poll issued to answer this question — that
   * poll is the wake it is trying to detect.
   *
   * Quantised to `CONTACT_WRITE_QUANTUM_MS`: the value means "recently", and
   * writing it at millisecond resolution would put a SQLite commit behind
   * every Baichuan reply on the hub's busiest write path (the exact cost
   * `scripts/check-runtime-state-durability.ts` exists to bound).
   */
  private markPassiveContact(): void {
    if (!this.isBattery) return
    const now = Date.now()
    const quantised = now - (now % ReolinkCamera.CONTACT_WRITE_QUANTUM_MS)
    const current = this.state.battery.lastContactAt ?? 0
    if (quantised <= current) return
    this.state.battery.lastContactAt = quantised
  }

  /** Write granularity for `battery.lastContactAt` — see `markPassiveContact`.
   *  Bounds the commit rate this field can cost at 12/hour/device, and only
   *  for a device something is actually reaching. */
  /** Bound on each best-effort network read; three reads at most per refresh. */
  private static readonly NETWORK_LINK_READ_TIMEOUT_MS = 4_000
  /** The first network read of this device was said at INFO (raw values included). */
  private networkLinkReported = false
  /** The first network read failure was said at WARN; later ones are debug. */
  private networkLinkFailureWarned = false
  private static readonly CONTACT_WRITE_QUANTUM_MS = 5 * 60_000

  /**
   * Shared wake-transition handler invoked by both the simpleEvent
   * `awake` push (canonical fast path) and the sleep poll's
   * `sleeping → awake` flip (backstop). Fan out the refreshes that
   * depend on the camera being responsive:
   *  - aux accessories (siren/floodlight/PIR) re-read their
   *    firmware state via `alignAuxDevicesState('wake')`
   *  - parent settings snapshot (image / motion / AI / enc / mask /
   *    audioNoise / autoFocus) re-reads via
   *    `refreshParentSettingsSnapshot()` so the Settings UI shows
   *    camera-current values instead of the snapshot taken before
   *    the cam went to sleep.
   * Both calls are best-effort; per-call failures land in their own
   * debug logs and never break the wake-transition flow.
   */
  private async onWakeTransition(reason: SleepCommitSource): Promise<void> {
    this.ctx.logger.info('reolink wake transition — refreshing (serialized)', {
      tags: { deviceId: this.id },
      meta: { reason, auxAccessoryCount: this.auxAccessoryRefs.size, isBattery: this.isBattery },
    })
    // SEQUENTIAL throughout: see alignAuxDevicesState — concurrent Baichuan
    // traffic on the doorbell's single BCUDP stream starves the heavy GetEnc
    // reply. Each step is best-effort and swallows its own per-probe errors.
    //
    // The cam's awake window is short (~14s). Read the profile-stable stream
    // catalog FIRST, while the window is freshest — it is the user-visible
    // priority (live stream) and only needs to succeed ONCE (thereafter it is
    // served from cache and skipped here). GetEnc is read once at init or
    // on a real stream, never buried behind a settings poll.
    //
    // "Probe the moment it comes back up, save it in the ledger, and it picks
    // it up from there" (D173) — this is that moment. The re-read runs when we
    // hold NOTHING, and also when the stored copy is older than
    // `CATALOG_REFRESH_ON_WAKE_MS`: a restored catalog keeps streams working
    // through a restart, and a natural wake is the only free chance to confirm
    // it still matches the camera.
    if (this.shouldRebuildCatalogOnWake()) {
      try {
        // Drop the RAM copy so the build is a real read rather than a
        // cache hit. The stored copy stays until a SUCCESSFUL build
        // replaces it — a failed re-read must never leave us worse off
        // than before we tried (D49).
        this.cachedStreamDescriptors = undefined
        const catalog = await this.buildStreamCatalog()
        if (catalog.length > 0) {
          // Nudge the broker to re-pull now that an entry exists (same
          // mechanism the stream-params write uses).
          this.ctx.eventBus.emit(
            createEvent(EventCategory.StreamParamsChanged, this.eventSource(), {
              deviceId: this.id,
            }),
          )
        }
      } catch (err) {
        this.ctx.logger.debug(
          'onWakeTransition: stream catalog build failed — will retry on next wake',
          {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          },
        )
      }
    }
    // The feature probe, once per session: a camera asleep at boot skipped
    // `onProbe`, and a hub child never logs in on its own, so this wake is
    // the only free moment to read its ability table. `reprobe()` runs the
    // kernel's probe + accessory reconcile — the Siren / Floodlight / PIR
    // children come up now, and `probeAndPersistFeatures` persists the
    // flags so they also exist after the next restart while it sleeps.
    if (!this.hasProbed()) {
      try {
        await this.reprobe()
      } catch (err) {
        this.ctx.logger.debug('onWakeTransition: feature probe failed — next wake retries', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    // Cap caches next — these back the State panel and every derived
    // config form, and they are what the operator stares at while the
    // camera sleeps. Ahead of the settings snapshot on purpose: that one
    // is a long multi-probe (image, motion, per-AI-class, enc, mask,
    // audioNoise, autoFocus, email) that can eat the whole window, and
    // it partly re-reads the same endpoints.
    // The scheduled full refresh (D847), when this window still owes one: the
    // camera is up for its own reasons, which is the free moment it wants.
    // It reads everything the tail below reads (forced), so it replaces the
    // tail instead of repeating it; a refresh that did not complete leaves the
    // tail to run as before.
    const scheduledRefreshCovered = this.isBattery
      ? await this.getBatteryRefresh()
          .noteAwake()
          .catch(() => false)
      : false
    if (!scheduledRefreshCovered) {
      await this.warmCapSlicesOnWake()
      // Then a frame for the snapshot wrapper's cache, so the tile keeps
      // showing the last known image for the whole sleep window.
      await this.warmSnapshotOnWake()
      // Then the rest of the wake refreshes (aux accessories + settings snapshot).
      await this.alignAuxDevicesState('wake')
      await this.refreshParentSettingsSnapshot()
    }
    // LAST, and only here: the camera is awake for its own reasons, which is
    // the only free catalog read a standalone battery camera ever gets. There
    // is deliberately no second wake hook — this one already fires on a camera
    // event, the sleep poll's flip, a hub summary and a confirmed wake.
    await this.refreshClipCatalogOnWake()
  }

  // ── Reliability watchdogs (Slice 10) ─────────────────────────────────

  private static readonly PING_INTERVAL_MS = 30_000
  private static readonly PING_MAX_FAILURES = 3
  private static readonly EVENT_CHECK_INTERVAL_MS = 60_000
  private static readonly EVENT_STALE_THRESHOLD_MS = 10 * 60_000

  /**
   * Arm the connection-liveness ping watchdog and the event-watchdog.
   * Battery cams skip the ping watchdog — they keep `setIdleDisconnect=true`
   * so the api intentionally goes silent and a ping would just wake the
   * camera and burn battery for no signal.
   *
   * Idempotent: re-arming clears prior timers first so we don't end up
   * with parallel watchdogs after a reconnect cycle.
   */
  private startWatchdogs(): void {
    this.stopWatchdogs()
    this.watchdogStartedAt = Date.now()
    this.consecutivePingFailures = 0

    if (!this.isBattery) {
      this.pingWatchdogTimer = setInterval(() => {
        void this.runPingWatchdog().catch(() => {
          /* logged inside */
        })
      }, ReolinkCamera.PING_INTERVAL_MS)
      if (typeof this.pingWatchdogTimer.unref === 'function') this.pingWatchdogTimer.unref()
    }

    // Event watchdog also skipped for battery cams — an equivalent check
    // would be double-gated on `eventSubscriptionActive === false && socket
    // connected`, which is effectively never true on UDP/battery during idle.
    // Running our equivalent here just risks waking the camera the
    // moment our 10-min stale threshold trips. The lib has its own
    // `simpleEventWatchdog` (`ReolinkBaichuanApi.ts:2854`) that
    // re-subscribes via `subscribeEvents` after exponential backoff,
    // and it short-circuits on `!isSocketConnected` so battery cams
    // are protected by it too.
    if (!this.isBattery) {
      this.eventWatchdogTimer = setInterval(() => {
        void this.runEventWatchdog().catch(() => {
          /* logged inside */
        })
      }, ReolinkCamera.EVENT_CHECK_INTERVAL_MS)
      if (typeof this.eventWatchdogTimer.unref === 'function') this.eventWatchdogTimer.unref()
    }
  }

  private stopWatchdogs(): void {
    if (this.pingWatchdogTimer) {
      clearInterval(this.pingWatchdogTimer)
      this.pingWatchdogTimer = null
    }
    if (this.eventWatchdogTimer) {
      clearInterval(this.eventWatchdogTimer)
      this.eventWatchdogTimer = null
    }
    this.stopEventHealthCheck()
    this.consecutivePingFailures = 0
  }

  private async runPingWatchdog(): Promise<void> {
    const api = this.api
    if (!api) return
    if (!api.client.isSocketConnected()) {
      // Socket is already gone — a reconnect is presumably in flight.
      // Don't pile on; reset the counter and let scheduleReconnect run.
      this.consecutivePingFailures = 0
      return
    }
    try {
      await api.ping()
      this.consecutivePingFailures = 0
    } catch (err) {
      this.consecutivePingFailures++
      const recoverable = isRecoverableBaichuanError(err)
      this.ctx.logger.debug('Reolink ping failed', {
        tags: { deviceId: this.id },
        meta: {
          failures: this.consecutivePingFailures,
          recoverable,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      if (this.consecutivePingFailures >= ReolinkCamera.PING_MAX_FAILURES) {
        this.ctx.logger.warn('Reolink ping watchdog: too many failures — recycling api', {
          tags: { deviceId: this.id },
          meta: { failures: this.consecutivePingFailures },
        })
        this.consecutivePingFailures = 0
        this.scheduleReconnect('ping-watchdog')
      }
    }
  }

  private async runEventWatchdog(): Promise<void> {
    const api = this.api
    if (!api) return
    if (!api.client.isSocketConnected() || !api.client.loggedIn) return

    const now = Date.now()
    const reference = this.lastEventAt > 0 ? this.lastEventAt : this.watchdogStartedAt
    const idleMs = now - reference
    if (idleMs < ReolinkCamera.EVENT_STALE_THRESHOLD_MS) return

    this.ctx.logger.warn('Reolink event watchdog: re-subscribing after idle window', {
      meta: { idleMs, lastEventAt: this.lastEventAt },
    })
    try {
      await this.resubscribeSimpleEvents(api, 'watchdog')
      // Reset the baseline so a fresh idle window starts now — no
      // events in the next 10 min will trigger another resubscribe.
      this.watchdogStartedAt = Date.now()
    } catch (err) {
      this.ctx.logger.debug('Reolink event watchdog re-subscribe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Off-then-prepend, so a re-attached api never carries two observers. */
  private observeMotionSensors(api: ReolinkBaichuanApi): void {
    api.client.off('event', this.observeRawEventBound)
    api.client.prependListener('event', this.observeRawEventBound)
  }

  /**
   * Subscribe (or re-subscribe) `handleSimpleEventBound` against
   * the Baichuan API. Single-source-of-truth for the listener
   * lifecycle:
   *
   *   1. Always `offSimpleEvent(handleSimpleEventBound)` first —
   *      Set-dedup is a no-op on the first call (handler isn't
   *      registered yet) but on re-subscribes it cleanly removes
   *      the prior registration so the lib's listener Set never
   *      grows past one entry per device.
   *   2. Verify the connection is ready (socket + login). The
   *      lib's own `ensureSimpleEventSubscribed` checks this too,
   *      but failing fast at the camstack layer keeps the
   *      re-subscribe attempts in lock-step with the connection
   *      state we observe — important for the `event-health`
   *      interval that fires every 60s.
   *   3. Register via `onSimpleEvent(handleSimpleEventBound)`.
   *      Lib starts/refreshes its own subscribe + 5min watchdog.
   *
   */
  private async resubscribeSimpleEvents(api: ReolinkBaichuanApi, reason: string): Promise<void> {
    try {
      await api.offSimpleEvent(this.handleSimpleEventBound)
    } catch {
      // First subscribe (handler not yet registered) — `Set.delete`
      // returns false but doesn't throw. Any other error here
      // shouldn't block the re-subscribe.
    }
    if (!api.client.isSocketConnected() || !api.client.loggedIn) {
      this.ctx.logger.debug('Reolink simpleEvent subscribe skipped — socket not ready', {
        meta: { reason, connected: api.client.isSocketConnected(), loggedIn: api.client.loggedIn },
      })
      return
    }
    await api.onSimpleEvent(this.handleSimpleEventBound)
    this.ctx.logger.debug('Reolink simpleEvent subscribed', { meta: { reason } })
  }

  /**
   * Subscribe the BOXED native-AI detection channel (`onObjectDetections`)
   * — the bbox/confidence-bearing counterpart to the flag-only
   * `handleSimpleEvent` AI path. Mirrors the `resubscribeSimpleEvents`
   * lifecycle (stable bound handler, off-before-on, socket-ready guard)
   * and is driven from the SAME connect/reconnect sites (login /
   * adoptApi).
   *
   * RESOURCE COST (important): unlike `onSimpleEvent` (a cmd_id push on
   * the existing control socket), `onObjectDetections` forces the lib to
   * keep a video SUBSTREAM open for the `(channel, profile)` tuple for as
   * long as we hold the listener — the boxes are decoded off the BcMedia
   * `additionalHeader` of every frame. The pool socket may be shared with
   * a regular streaming consumer, but if none is pulling we become an
   * always-on dial. Therefore:
   *
   *   - We subscribe ONLY when the `native-object-detection` cap toggle is
   *     enabled (default-on when unset), and tear the substream down
   *     (`offObjectDetections`) the moment it's disabled.
   *   - We DO NOT subscribe on battery cameras: a persistent substream
   *     keeps the radio awake and would drain the battery. Battery cams
   *     stay on the flag-only `handleSimpleEvent` AI path (no boxes).
   *     This is a deliberate limitation — boxed onboard detection on
   *     battery cams is out of scope until an on-demand (consumer-gated)
   *     attach is designed.
   *
   * Hub-child cameras don't run this path (they delegate their socket to
   * the parent and never call `ensureApi` login / adoptApi), so this only
   * arms on api-owning cameras. We pass `getChannel()` so multi-lens /
   * NVR-attached standalone cameras open the substream on the right
   * channel (default 0 for single-lens).
   */
  private async resubscribeObjectDetections(
    api: ReolinkBaichuanApi,
    reason: string,
  ): Promise<void> {
    const channel = this.getChannel()
    // Off-before-on so re-arming against the same api never accumulates
    // listeners (same Set-dedup rationale as simpleEvents). offObjectDetections
    // is idempotent — a no-op when nothing is registered.
    try {
      await api.offObjectDetections(this.handleObjectDetectionsBound, { channel, profile: 'sub' })
    } catch {
      // No prior registration — ignore.
    }
    this.objectDetectionsSubscribed = false

    const detectionEnabled = isNativeObjectForwardingEnabled(
      this.runtimeState.getCapState<NativeObjectDetectionRuntimeState>('native-object-detection'),
    )
    if (!detectionEnabled) {
      this.ctx.logger.debug('Reolink objectDetections subscribe skipped — cap disabled', {
        meta: { reason },
      })
      return
    }

    // A BATTERY camera gets the boxes for free, and never pays for them.
    //
    // What costs a battery camera is a PERSISTENT sub-stream — a second feed
    // held open across the sleep, which is what `onObjectDetections` ensures
    // and why this branch used to refuse outright. But the boxes do not need a
    // feed of their own: they ride the BcMedia `additionalHeader` of ANY open
    // stream, and while this camera is awake we are already pulling one
    // through this very library (`onCamStreamDemand` opens a
    // `BaichuanVideoStream`, and the lib's pool shares one control socket
    // across main/sub/ext). `onDetection` hooks those existing streams and
    // issues no Baichuan subscribe command at all — it opens nothing, ensures
    // nothing, and goes quiet the moment the last stream closes.
    //
    // Which is exactly the window that matters: a battery camera is awake
    // BECAUSE something is in front of it. Asleep it has nothing to report,
    // and the hook costs nothing while it sleeps.
    //
    // Coordinates are normalised `[0,1]` of the source frame, so a box is
    // correct whichever profile happens to be open (the lib's own words: "the
    // same box renders correctly on mainStream, subStream, and externStream")
    // — this path must never assume which one it got.
    if (this.isBattery) {
      api.onDetection(this.handleObjectDetectionsBound)
      this.objectDetectionsSubscribed = true
      this.ctx.logger.info('Reolink onboard boxes ride the open stream (battery cam)', {
        tags: { deviceId: this.id },
        meta: { reason, channel },
      })
      return
    }

    if (!api.client.isSocketConnected() || !api.client.loggedIn) {
      this.ctx.logger.debug('Reolink objectDetections subscribe skipped — socket not ready', {
        meta: { reason, connected: api.client.isSocketConnected(), loggedIn: api.client.loggedIn },
      })
      return
    }

    await api.onObjectDetections(this.handleObjectDetectionsBound, { channel, profile: 'sub' })
    this.objectDetectionsSubscribed = true
    this.ctx.logger.debug('Reolink objectDetections subscribed (substream armed)', {
      meta: { reason, channel },
    })
  }

  /**
   * Tear down the boxed-detection substream. Called on disable + on
   * disconnect. Best-effort — `offObjectDetections` closes the lib's
   * auto-managed substream once its last listener for the tuple is gone.
   */
  private async unsubscribeObjectDetections(api: ReolinkBaichuanApi): Promise<void> {
    if (!this.objectDetectionsSubscribed) return
    // The battery path registered a stream HOOK, not a managed sub-stream, so
    // it is removed by its own remover. Calling `offObjectDetections` for it
    // would be a no-op against a tuple that was never opened, and the hook
    // would outlive the disable.
    if (this.isBattery) {
      api.offDetection(this.handleObjectDetectionsBound)
      this.objectDetectionsSubscribed = false
      return
    }
    try {
      await api.offObjectDetections(this.handleObjectDetectionsBound, {
        channel: this.getChannel(),
        profile: 'sub',
      })
    } catch (err) {
      this.ctx.logger.debug('Reolink objectDetections unsubscribe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    this.objectDetectionsSubscribed = false
  }

  /**
   * Bridge a boxed native-AI detection frame to the camstack event bus.
   * One `DetectionCameraNative` payload per `ReolinkDetectionEvent` (all
   * boxes in one payload), `source: 'onboard'`, gated on the
   * `native-object-detection` cap toggle.
   *
   * Timestamp: the lib's `event.microseconds` is a stream PTS, NOT epoch —
   * we stamp `Date.now()` at receipt (same convention as
   * `handleSimpleEvent`). The mapper applies that one stamp to every box.
   *
   * This complements (does not replace) the flag-only AI emit in
   * `handleSimpleEvent`: the boxed path carries bbox/confidence the
   * analyzer needs; the simpleEvent path keeps the motion heartbeat the
   * recorder + phase machine depend on. The two channels are sourced from
   * different transports (cmd_id push vs streaming side-channel) and may
   * not arrive together.
   */
  private handleObjectDetections(
    event: import('@apocaliss92/nodelink-js').ReolinkDetectionEvent,
  ): void {
    // Re-check the gate at emit time — the cap may have been toggled off
    // between subscribe and this frame, and disable teardown is async.
    const detectionEnabled = isNativeObjectForwardingEnabled(
      this.runtimeState.getCapState<NativeObjectDetectionRuntimeState>('native-object-detection'),
    )
    if (!detectionEnabled) return
    // The BATTERY path hooks every stream this library has open, not a
    // `(channel, profile)` tuple it asked for — so on an NVR or a hub the
    // boxes of a SIBLING camera arrive here too, and attributing them to this
    // device would put another room's subject on this camera's timeline. The
    // managed sub-stream path is already tuple-scoped and this costs it one
    // comparison.
    if (event.channel !== this.getChannel()) return
    if (event.boxes.length === 0) return

    const now = Date.now()
    const payload = mapDetectionEvent(event, this.id, now)
    this.ctx.eventBus.emit(
      createEvent(EventCategory.DetectionCameraNative, this.eventSource(), payload),
    )
  }

  /**
   * Plugin-level event-health watchdog. Fires every 60s while the
   * api is alive. Two recovery paths:
   *
   *   - If we've never received an event AND the watchdog baseline
   *     is older than EVENT_STALE_THRESHOLD_MS, force a full
   *     re-subscribe. Catches "subscribe call succeeded but the
   *     camera silently rejected the registration" — the lib's
   *     own watchdog uses the same trigger but a re-arm at the
   *     plugin level recovers from cases where the lib's internal
   *     state has drifted.
   *   - If the connection went down between our `runEventWatchdog`
   *     ticks (every 30s by default), the next tick of THIS check
   *     re-subscribes the moment the socket comes back up.
   */
  private startEventHealthCheck(): void {
    this.stopEventHealthCheck()
    this.consecutiveStaleHealthChecks = 0
    this.nextEventHealthCheckAt = 0
    this.eventHealthCheckTimer = setInterval(() => {
      void (async () => {
        const api = this.api
        if (!api) return
        if (!api.client.isSocketConnected() || !api.client.loggedIn) return
        // Backoff gate: chronically-silent cameras (subnet quirks,
        // firmware that only emits events on motion in an empty room)
        // used to log every 60s for hours. Skip ticks until the
        // backoff window elapses.
        const now = Date.now()
        if (now < this.nextEventHealthCheckAt) return
        const idleMs = now - (this.lastEventAt > 0 ? this.lastEventAt : this.watchdogStartedAt)
        if (idleMs < ReolinkCamera.EVENT_STALE_THRESHOLD_MS) return
        // Log degradation: first re-subscribe in a stale streak is
        // `info` so operators see we noticed; subsequent ones drop
        // to `debug` to stop spamming. Counter is reset to 0 by
        // `handleSimpleEvent` on the first successful event delivery.
        const meta = {
          idleMs,
          lastEventAt: this.lastEventAt,
          consecutive: this.consecutiveStaleHealthChecks + 1,
        }
        if (this.consecutiveStaleHealthChecks === 0) {
          this.ctx.logger.info('Reolink event-health check forcing full re-subscribe', { meta })
        } else {
          this.ctx.logger.debug('Reolink event-health check forcing full re-subscribe', { meta })
        }
        try {
          await this.resubscribeSimpleEvents(api, 'event-health-check')
          this.watchdogStartedAt = Date.now()
        } catch (err) {
          this.ctx.logger.debug('Reolink event-health re-subscribe failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
        // Schedule the next allowed check using exponential backoff
        // (60s → 2min → 5min → 15min capped). Mirrors common
        // long-poll backoff patterns; a real event arriving resets
        // the counter and the next stale streak starts fresh at 60s.
        this.consecutiveStaleHealthChecks += 1
        const backoffMs = computeHealthCheckBackoffMs(this.consecutiveStaleHealthChecks)
        this.nextEventHealthCheckAt = Date.now() + backoffMs
      })()
    }, 60_000)
    if (typeof this.eventHealthCheckTimer.unref === 'function') {
      this.eventHealthCheckTimer.unref()
    }
  }

  private stopEventHealthCheck(): void {
    if (this.eventHealthCheckTimer) {
      clearInterval(this.eventHealthCheckTimer)
      this.eventHealthCheckTimer = null
    }
  }

  /** Stop every active stream and close the Baichuan API. */
  async disconnectAll(): Promise<void> {
    this.stopSleepPoll()
    this.stopBatteryUpdatePolling()
    this.stopAlignAuxPolling()
    this.stopWatchdogs()
    const entries = [...this.active.values()]
    this.active.clear()
    for (const entry of entries) {
      try {
        await entry.server.close('disconnect-all')
      } catch {
        /* best-effort */
      }
    }
    if (this.api) {
      // Release the boxed-detection substream first so the lib tears it
      // down cleanly; `api.close` would drop it anyway but this keeps the
      // listener bookkeeping honest across reconnects.
      await this.unsubscribeObjectDetections(this.api)
      try {
        await this.api.close({ reason: 'device-shutdown' })
      } catch {
        /* best-effort */
      }
      this.api = null
    }
    this.objectDetectionsSubscribed = false
    this.markOnline(false)
  }

  // ── Settings UI ───────────────────────────────────────────────────────

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const cache = this.config.get('deviceCache')
    const motionSnap = cache?.motionSnapshot ?? {}
    const imgSnap = cache?.imageSnapshot ?? {}
    const netSnap = cache?.netPortSnapshot ?? {}
    const ntpSnap = cache?.ntpSnapshot ?? {}
    // On-demand retry — if any settings-snapshot is missing from the
    // persisted cache, kick a background refresh. Debounced so opening
    // the form repeatedly during a sleep window doesn't spam the lib.
    // Battery cams that were sleeping at the time of the initial probe
    // (`onCreated` → `refreshParentSettingsSnapshot`) hit this path the
    // first time the operator opens settings post-wake.
    let kickedFullSnapshotRefresh = false
    if (this.hasIncompleteSettingsCache()) {
      const now = Date.now()
      if (now - this.lastSettingsSnapshotRetryAt > ReolinkCamera.SETTINGS_SNAPSHOT_RETRY_MIN_MS) {
        this.lastSettingsSnapshotRetryAt = now
        kickedFullSnapshotRefresh = true
        void this.refreshParentSettingsSnapshot().catch(() => {
          /* best-effort */
        })
      }
    }
    // OSD slice — serve-and-revalidate on the reader's path (D224). The
    // camera owns its overlay state and the operator can change it from the
    // Reolink app at any time, so an open that finds the persisted snapshot
    // older than OPERATOR_WRITTEN_STALE_MS re-reads BEHIND the form: the
    // known state is served immediately, and a read that fails changes
    // nothing. A sleeping battery cam is handled inside the refresh — it
    // refuses to wake the camera and logs the skip at info; the section
    // renders the stale/unknown state honestly instead (buildOsdSection).
    // Skipped when a full snapshot refresh (which includes the osd slice)
    // was already kicked this open.
    const osdSnap = cache?.osdSnapshot
    if (!kickedFullSnapshotRefresh && isOsdSnapshotStale(osdSnap, Date.now())) {
      const now = Date.now()
      if (now - this.lastOsdRevalidateKickAt > ReolinkCamera.SETTINGS_SNAPSHOT_RETRY_MIN_MS) {
        this.lastOsdRevalidateKickAt = now
        void this.refreshParentSettingsSnapshot(new Set<SnapshotSlice>(['osd'])).catch(() => {
          /* best-effort — the form keeps serving the persisted snapshot */
        })
      }
    }
    // Tri-state OSD values from the snapshot ALONE: camera snapshot →
    // UNKNOWN (null). The config keeps no `osd*` copy to consult — a stored
    // override shadowed the camera forever after one CamStack write
    // (D62-shape); a write invalidates the snapshot instead via the
    // post-save `osd` slice re-read. Computed once and used for BOTH the
    // section defaults and the hydration values so the two can never
    // disagree. `null` survives to the UI (D337) — buildOsdSection renders
    // it as a disabled "not reported" switch, never as a schema default.
    const osdValues = resolveOsdValues(osdSnap)
    // Auto-populate the Sessions tab on open for mains-powered cameras
    // (results land on the next aggregate poll). Battery cams are NOT
    // auto-refreshed — a fetch wakes the radio and drains the battery; they
    // keep the explicit "Refresh now" button (and an honest cold-state label).
    const sessSnap = this.sessionsSnapshot
    const sessStale = sessSnap === null || Date.now() - sessSnap.ts > SESSIONS_SNAPSHOT_MAX_AGE_MS
    if (!this.isBattery && sessStale) {
      void this.refreshSessionsSnapshot().catch((err) => {
        this.ctx.logger.debug('Camera sessions refresh threw', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    const schema: ConfigUISchema = {
      tabs: [
        // Same taxonomy as Hikvision — `general` (connection /
        // credentials / debug-as-advanced) + per-concern tabs. The
        // `image` / `audio` ids are well-known across the admin UI
        // so the tab labels + icons come from the registry; we just
        // declare the order here so Image lands before Audio.
        // The `streaming` tab hosts the editable encoder/stream
        // section built by `buildStreamSettingsSections()`. Its
        // option lists are persisted (`deviceCache.encOptionsSnapshot`)
        // by the same probe + helper that backs the `stream-params`
        // cap's `getOptions`, so the form is a static-schema mirror of
        // the cap — both surfaces share the underlying API logic.
        { id: 'general', label: 'General', icon: 'settings', order: 0 },
        { id: 'network', label: 'Network', icon: 'network', order: 10 },
        { id: 'image', label: 'Image', icon: 'image', order: 30 },
        { id: 'streaming', label: 'Streaming', icon: 'video', order: 35 },
        { id: 'audio', label: 'Audio', icon: 'volume', order: 40 },
        // Editable on-camera email/SMTP config — only for battery cams that can
        // host email push (the section + values are gated the same way).
        ...(this.isBattery && this.isEmailPushEligible
          ? [{ id: 'email', label: 'Email', icon: 'mail', order: 45 }]
          : []),
        { id: 'sessions', label: 'Sessions', icon: 'users', order: 80 },
      ],
      sections: [
        // ── General refresh ─────────────────────────────────────────
        // A form-wide "Refresh from camera" button — re-reads every
        // driver snapshot (encoder/options, ports, NTP, image, motion)
        // from the camera. Independent of any single settings section;
        // dispatches the `refresh-settings` device custom action via
        // deviceManager.runDeviceAction. The form re-hydrates on the next open.
        {
          id: 'driver-refresh',
          tab: 'general',
          title: 'Camera data',
          titleKey: 'provider-reolink:schema.s_driver-refresh.title',
          description:
            'Wakes a sleeping camera and re-reads everything; no other read here wakes it.',
          descriptionKey: 'provider-reolink:schema.s_driver-refresh.description',
          columns: 1,
          fields: [
            {
              type: 'device-action-button',
              key: '_refreshSettings',
              label: 'Refresh from camera',
              labelKey: 'provider-reolink:schema.s_driver-refresh._refreshSettings.label',
              buttonLabel: 'Refresh now',
              action: 'refresh-settings',
              variant: 'default',
              // Reports what LANDED, not that a button was pressed: on a
              // battery camera "awake=false" is the whole answer, and the
              // old handler could not tell that apart from a full re-read.
              successMessage:
                'Camera awake: {awake} · settings re-read: {snapshotRefreshed} · slices refreshed: {capsWarmed}/{capsTotal}',
            },
          ],
        },
        // Identity (`name`, `location`) is base meta — rendered by the
        // device-manager's contribution, not the driver schema.
        {
          id: 'connection',
          tab: 'general',
          title: 'Connection',
          titleKey: 'provider-reolink:schema.s_connection.title',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'Camera IP',
              labelKey: 'provider-reolink:schema.s_connection.host.label',
              required: true,
              placeholder: '192.168.10.100',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              labelKey: 'provider-reolink:schema.s_connection.port.label',
              default: 9000,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'provider-reolink:schema.s_connection.username.label',
              default: 'admin',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'provider-reolink:schema.s_connection.password.label',
              required: true,
              showToggle: true,
            },
          ],
        },
        // ── Network service ports (writable via setPortConfig cmd_id 36) ─
        // HTTP / HTTPS / RTSP / RTMP / ONVIF enable toggle + port number.
        // Defaults seed from the `getNetPort` (cmd_id 37) snapshot;
        // `applySettingsPatch` pushes touched protocols via the lib's
        // `setPortConfig`. The Baichuan/server control port is the
        // `Port` field in the Connection section above — not duplicated.
        {
          id: 'network-ports',
          tab: 'network',
          title: 'Service ports',
          titleKey: 'provider-reolink:schema.s_network-ports.title',
          description: 'Changing a port breaks existing URLs for that protocol.',
          descriptionKey: 'provider-reolink:schema.s_network-ports.description',
          columns: 2,
          fields: [
            {
              type: 'boolean',
              key: 'netHttpEnable',
              label: 'HTTP enabled',
              labelKey: 'provider-reolink:schema.s_network-ports.netHttpEnable.label',
              default: netSnap.http?.enable ?? true,
              style: 'switch',
            },
            {
              type: 'number',
              key: 'netHttpPort',
              label: 'HTTP port',
              labelKey: 'provider-reolink:schema.s_network-ports.netHttpPort.label',
              default: netSnap.http?.port ?? 80,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'netHttpsEnable',
              label: 'HTTPS enabled',
              labelKey: 'provider-reolink:schema.s_network-ports.netHttpsEnable.label',
              default: netSnap.https?.enable ?? false,
              style: 'switch',
            },
            {
              type: 'number',
              key: 'netHttpsPort',
              label: 'HTTPS port',
              labelKey: 'provider-reolink:schema.s_network-ports.netHttpsPort.label',
              default: netSnap.https?.port ?? 443,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'netRtspEnable',
              label: 'RTSP enabled',
              labelKey: 'provider-reolink:schema.s_network-ports.netRtspEnable.label',
              default: netSnap.rtsp?.enable ?? true,
              style: 'switch',
            },
            {
              type: 'number',
              key: 'netRtspPort',
              label: 'RTSP port',
              labelKey: 'provider-reolink:schema.s_network-ports.netRtspPort.label',
              default: netSnap.rtsp?.port ?? 554,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'netRtmpEnable',
              label: 'RTMP enabled',
              labelKey: 'provider-reolink:schema.s_network-ports.netRtmpEnable.label',
              default: netSnap.rtmp?.enable ?? true,
              style: 'switch',
            },
            {
              type: 'number',
              key: 'netRtmpPort',
              label: 'RTMP port',
              labelKey: 'provider-reolink:schema.s_network-ports.netRtmpPort.label',
              default: netSnap.rtmp?.port ?? 1935,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'netOnvifEnable',
              label: 'ONVIF enabled',
              labelKey: 'provider-reolink:schema.s_network-ports.netOnvifEnable.label',
              default: netSnap.onvif?.enable ?? true,
              style: 'switch',
            },
            {
              type: 'number',
              key: 'netOnvifPort',
              label: 'ONVIF port',
              labelKey: 'provider-reolink:schema.s_network-ports.netOnvifPort.label',
              default: netSnap.onvif?.port ?? 8000,
              min: 1,
              max: 65535,
              step: 1,
            },
          ],
        },
        // ── Time / NTP ──────────────────────────────────────────────
        // Network time-sync config. The `ntp*` keys persist to the
        // driver config on save; the camera-side push is wired through
        // the native Baichuan NTP commands once nodelink-js exposes
        // them — see the TODO(nodelink-ntp) markers below.
        {
          id: 'time-ntp',
          tab: 'network',
          title: 'Time / NTP',
          titleKey: 'provider-reolink:schema.s_time-ntp.title',
          columns: 2,
          fields: [
            {
              type: 'timezone',
              key: 'timeZoneId',
              label: 'Timezone',
              labelKey: 'provider-reolink:schema.s_time-ntp.timeZoneId.label',
              default:
                this.config.get('timeZoneId') ??
                reolinkTimeZoneToIana(
                  this.config.get('deviceCache')?.systemGeneralSnapshot?.timeZone,
                ) ??
                '',
              span: 2,
            },
            {
              type: 'boolean',
              key: 'ntpEnabled',
              label: 'NTP sync',
              labelKey: 'provider-reolink:schema.s_time-ntp.ntpEnabled.label',
              default: ntpSnap.enabled ?? true,
              style: 'switch',
              span: 2,
            },
            {
              type: 'text',
              key: 'ntpServer',
              label: 'NTP server',
              labelKey: 'provider-reolink:schema.s_time-ntp.ntpServer.label',
              default: ntpSnap.server ?? 'pool.ntp.org',
              placeholder: 'pool.ntp.org',
              span: 2,
            },
            {
              type: 'number',
              key: 'ntpPort',
              label: 'NTP port',
              labelKey: 'provider-reolink:schema.s_time-ntp.ntpPort.label',
              default: ntpSnap.port ?? 123,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'number',
              key: 'ntpInterval',
              label: 'Sync interval (min)',
              labelKey: 'provider-reolink:schema.s_time-ntp.ntpInterval.label',
              default: ntpSnap.interval ?? 1440,
              min: 1,
              max: 10080,
              step: 1,
            },
          ],
        },
        // ── Motion (writable via setMotionAlarm cmd_id=47) ──────────
        {
          id: 'motion',
          tab: 'motion',
          title: 'On-camera motion (MdAlarm)',
          titleKey: 'provider-reolink:schema.s_motion.title',
          columns: 2,
          fields: [
            {
              type: 'boolean',
              key: 'motionEnabled',
              label: 'Motion detection',
              labelKey: 'provider-reolink:schema.s_motion.motionEnabled.label',
              default: motionSnap.enabled ?? true,
              style: 'switch',
              span: 2,
            },
            {
              type: 'slider',
              key: 'motionSensitivity',
              label: 'Sensitivity',
              labelKey: 'provider-reolink:schema.s_motion.motionSensitivity.label',
              min: 1,
              max: 50,
              step: 1,
              default: motionSnap.sensitivity ?? 25,
              showValue: true,
              showStepper: true,
              span: 2,
            },
          ],
        },
        // ── AI sensitivity (writable via setAiDetection cmd_id=343) ──
        // Per-class sliders. Each one only renders when the camera's
        // `getAiDetectTypes` advertised the matching detector — the
        // Reolink mobile app uses the same gating so unsupported
        // models (e.g. fixed cams without AI) get a clean Motion tab.
        ...(cache?.aiDetectTypes && cache.aiDetectTypes.length > 0
          ? [
              {
                id: 'ai-sensitivity',
                tab: 'motion' as const,
                title: 'AI detection sensitivity',
                titleKey: 'provider-reolink:schema.s_ai-sensitivity.title',
                columns: 2 as const,
                // Sensitivity + stay-time + min/max target-size sliders per
                // supported class. All ride the same `setAiDetectionFull`
                // setter; the dispatcher reads the un-touched fields from the
                // snapshot so editing one keeps the rest (single round-trip).
                fields: (
                  [
                    [
                      'people',
                      'aiPersonSensitivity',
                      'aiPersonStayTime',
                      'aiPersonMinTargetWidth',
                      'aiPersonMinTargetHeight',
                      'aiPersonMaxTargetWidth',
                      'aiPersonMaxTargetHeight',
                      'Person',
                    ],
                    [
                      'vehicle',
                      'aiVehicleSensitivity',
                      'aiVehicleStayTime',
                      'aiVehicleMinTargetWidth',
                      'aiVehicleMinTargetHeight',
                      'aiVehicleMaxTargetWidth',
                      'aiVehicleMaxTargetHeight',
                      'Vehicle',
                    ],
                    [
                      'dog_cat',
                      'aiAnimalSensitivity',
                      'aiAnimalStayTime',
                      'aiAnimalMinTargetWidth',
                      'aiAnimalMinTargetHeight',
                      'aiAnimalMaxTargetWidth',
                      'aiAnimalMaxTargetHeight',
                      'Animal',
                    ],
                    [
                      'face',
                      'aiFaceSensitivity',
                      'aiFaceStayTime',
                      'aiFaceMinTargetWidth',
                      'aiFaceMinTargetHeight',
                      'aiFaceMaxTargetWidth',
                      'aiFaceMaxTargetHeight',
                      'Face',
                    ],
                    [
                      'package',
                      'aiPackageSensitivity',
                      'aiPackageStayTime',
                      'aiPackageMinTargetWidth',
                      'aiPackageMinTargetHeight',
                      'aiPackageMaxTargetWidth',
                      'aiPackageMaxTargetHeight',
                      'Package',
                    ],
                  ] as const
                )
                  .filter(([type]) => cache.aiDetectTypes!.includes(type))
                  .flatMap(
                    ([type, sensKey, stayKey, minWKey, minHKey, maxWKey, maxHKey, label]) => [
                      {
                        type: 'slider' as const,
                        key: sensKey,
                        label: `${label} sensitivity`,
                        min: 0,
                        max: 100,
                        step: 1,
                        default: cache.aiSensitivitySnapshot?.[type]?.sensitivity ?? 50,
                        showValue: true,
                        showStepper: true,
                      },
                      {
                        type: 'slider' as const,
                        key: stayKey,
                        label: `${label} stay time (s)`,
                        min: 0,
                        max: 600,
                        step: 1,
                        default: cache.aiSensitivitySnapshot?.[type]?.stayTime ?? 0,
                        showValue: true,
                        showStepper: true,
                      },
                      {
                        type: 'slider' as const,
                        key: minWKey,
                        label: `${label} min target width`,
                        description:
                          'Smallest object width to detect, as a fraction of the frame (0..1).',
                        min: 0,
                        max: 1,
                        step: 0.01,
                        default: cache.aiSensitivitySnapshot?.[type]?.minTargetWidth ?? 0,
                        showValue: true,
                        showStepper: true,
                      },
                      {
                        type: 'slider' as const,
                        key: minHKey,
                        label: `${label} min target height`,
                        description:
                          'Smallest object height to detect, as a fraction of the frame (0..1).',
                        min: 0,
                        max: 1,
                        step: 0.01,
                        default: cache.aiSensitivitySnapshot?.[type]?.minTargetHeight ?? 0,
                        showValue: true,
                        showStepper: true,
                      },
                      {
                        type: 'slider' as const,
                        key: maxWKey,
                        label: `${label} max target width`,
                        description:
                          'Largest object width to detect, as a fraction of the frame (0..1).',
                        min: 0,
                        max: 1,
                        step: 0.01,
                        default: cache.aiSensitivitySnapshot?.[type]?.maxTargetWidth ?? 1,
                        showValue: true,
                        showStepper: true,
                      },
                      {
                        type: 'slider' as const,
                        key: maxHKey,
                        label: `${label} max target height`,
                        description:
                          'Largest object height to detect, as a fraction of the frame (0..1).',
                        min: 0,
                        max: 1,
                        step: 0.01,
                        default: cache.aiSensitivitySnapshot?.[type]?.maxTargetHeight ?? 1,
                        showValue: true,
                        showStepper: true,
                      },
                    ],
                  ),
              },
            ]
          : []),
        // ── Image (writable via setImage / setIsp on cmd_id 25) ─────
        // Snapshot from `GetVideoInput` (cmd_id 26) seeds the
        // defaults so the operator sees the current value when they
        // first open the tab. Edits are pushed to the camera in the
        // applySettingsPatch dispatcher below — no round-trip to the
        // mobile app or on-device menu required anymore.
        {
          id: 'image',
          tab: 'image',
          title: 'Image',
          titleKey: 'provider-reolink:schema.s_image.title',
          columns: 2,
          fields: [
            {
              type: 'slider',
              key: 'imgBright',
              label: 'Brightness',
              labelKey: 'provider-reolink:schema.s_image.imgBright.label',
              min: 0,
              max: 255,
              step: 1,
              default: imgSnap.bright ?? 128,
              showValue: true,
              showStepper: true,
            },
            {
              type: 'slider',
              key: 'imgContrast',
              label: 'Contrast',
              labelKey: 'provider-reolink:schema.s_image.imgContrast.label',
              min: 0,
              max: 255,
              step: 1,
              default: imgSnap.contrast ?? 128,
              showValue: true,
              showStepper: true,
            },
            {
              type: 'slider',
              key: 'imgSaturation',
              label: 'Saturation',
              labelKey: 'provider-reolink:schema.s_image.imgSaturation.label',
              min: 0,
              max: 255,
              step: 1,
              default: imgSnap.saturation ?? 128,
              showValue: true,
              showStepper: true,
            },
            {
              type: 'slider',
              key: 'imgHue',
              label: 'Hue',
              labelKey: 'provider-reolink:schema.s_image.imgHue.label',
              min: 0,
              max: 255,
              step: 1,
              default: imgSnap.hue ?? 128,
              showValue: true,
              showStepper: true,
            },
            {
              type: 'slider',
              key: 'imgSharpen',
              label: 'Sharpness',
              labelKey: 'provider-reolink:schema.s_image.imgSharpen.label',
              min: 0,
              max: 255,
              step: 1,
              default: 128,
              showValue: true,
              showStepper: true,
              span: 2,
            },
          ],
        },
        // ── ISP (writable — same cmd_id 25 + 297 for dayNightThreshold) ─
        ...(imgSnap.dayNight !== undefined
          ? [
              {
                id: 'isp',
                tab: 'image' as const,
                title: 'Advanced (ISP)',
                titleKey: 'provider-reolink:schema.s_isp.title',
                columns: 2 as const,
                fields: [
                  {
                    type: 'text' as const,
                    key: 'ispDayNight',
                    label: 'Day/Night mode',
                    labelKey: 'provider-reolink:schema.s_isp.ispDayNight.label',
                    default: imgSnap.dayNight ?? 'auto',
                  },
                  {
                    type: 'text' as const,
                    key: 'ispExposure',
                    label: 'Exposure',
                    labelKey: 'provider-reolink:schema.s_isp.ispExposure.label',
                    default: 'auto',
                  },
                ],
              },
            ]
          : []),
        // Stream / encoder parameters are no longer a hand-rolled
        // section here — the `stream-params` cap declares a `ui` block,
        // so its config UI (the cap-driven StreamParamsSettings form)
        // is surfaced automatically by the cap-UI contribution
        // mechanism. The cap registration below stays as the
        // programmatic contract.
        // ── IR + status LED (writable via setIrLights cmd_id 209) ────
        {
          id: 'ir-lights',
          tab: 'image',
          title: 'IR + status LED',
          titleKey: 'provider-reolink:schema.s_ir-lights.title',
          columns: 2,
          fields: [
            {
              type: 'select',
              key: 'irLightsState',
              label: 'IR LED',
              labelKey: 'provider-reolink:schema.s_ir-lights.irLightsState.label',
              default: 'Auto',
              options: [
                {
                  value: 'Auto',
                  label: 'Auto (camera decides)',
                  labelKey: 'provider-reolink:schema.s_ir-lights.irLightsState.o_Auto.label',
                },
                {
                  value: 'On',
                  label: 'Always on',
                  labelKey: 'provider-reolink:schema.s_ir-lights.irLightsState.o_On.label',
                },
                {
                  value: 'Off',
                  label: 'Always off',
                  labelKey: 'provider-reolink:schema.s_ir-lights.irLightsState.o_Off.label',
                },
              ],
            },
            {
              type: 'slider',
              key: 'irLightsBrightness',
              label: 'IR brightness',
              labelKey: 'provider-reolink:schema.s_ir-lights.irLightsBrightness.label',
              description: 'Only applied when the camera supports adjustable IR brightness.',
              descriptionKey: 'provider-reolink:schema.s_ir-lights.irLightsBrightness.description',
              min: 0,
              max: 255,
              step: 5,
              default: 128,
              showValue: true,
              showStepper: true,
            },
            // Status LED (visible power/status LED) — same `setIrLights`
            // call as the IR fields. Default seeds from the LED snapshot.
            {
              type: 'boolean',
              key: 'statusLedEnabled',
              label: 'Status LED',
              labelKey: 'provider-reolink:schema.s_ir-lights.statusLedEnabled.label',
              default: cache?.ledSnapshot?.statusEnabled ?? true,
              style: 'switch',
              span: cache?.ledSnapshot?.doorbellSupported === true ? 1 : 2,
            },
            // Doorbell LED — only rendered when the camera advertised the
            // doorbell-LED ability (`doorbellAbility > 0`). Non-doorbell
            // models hide it rather than show a no-op control.
            ...(cache?.ledSnapshot?.doorbellSupported === true
              ? [
                  {
                    type: 'boolean' as const,
                    key: 'doorbellLedEnabled',
                    label: 'Doorbell LED',
                    labelKey: 'provider-reolink:schema.s_ir-lights.doorbellLedEnabled.label',
                    default: cache?.ledSnapshot?.doorbellEnabled ?? true,
                    style: 'switch' as const,
                  },
                ]
              : []),
          ],
        },
        // ── OSD overlay (writable via setOsd cmd_id 25) ──────────────
        // Built in `osd-settings-section.ts` (pure, unit-tested): tri-state
        // values, a state banner for stale/unknown readings, and disabled
        // "not reported" switches instead of defaults for facts the camera
        // never gave us. The write stays a read-modify-write `setOsd` push
        // that preserves the stored overlay positions (`pos`).
        buildOsdSection(osdSnap, osdValues, {
          sleeping: this.isBattery && this.sleeping,
          now: Date.now(),
        }),
        // NO privacy-mask section here. The mask has ONE authority — the
        // `privacy-mask` cap, which writes the zones and the enable together
        // and reads the camera — and this form used to carry a second switch
        // beside it, writing `setMask` and reading a config copy of our own.
        // The two disagreed with each other and with the Reolink app, on the
        // one control where being wrong blacks out, or un-blacks, a bedroom.
        // ── Auto-focus (writable via setAutoFocus cmd_id 225) ────────
        // Only rendered when the snapshot probe flagged
        // `supported=true`. Fixed-focus cameras (most Reolink bullet
        // models) don't expose AF and would round-trip an error
        // every save — gating keeps the form clean.
        ...(cache?.autoFocusSnapshot?.supported === true
          ? [
              {
                id: 'auto-focus',
                tab: 'image' as const,
                title: 'Auto focus',
                titleKey: 'provider-reolink:schema.s_auto-focus.title',
                description: 'Disabling locks the lens at its current focus.',
                descriptionKey: 'provider-reolink:schema.s_auto-focus.description',
                columns: 1 as const,
                fields: [
                  {
                    type: 'boolean' as const,
                    key: 'autoFocusEnabled',
                    label: 'Auto focus',
                    labelKey: 'provider-reolink:schema.s_auto-focus.autoFocusEnabled.label',
                    default: cache.autoFocusSnapshot?.enabled ?? true,
                    style: 'switch' as const,
                  },
                ],
              },
            ]
          : []),
        // ── Audio (writable via setAudioCfg cmd_id 265) ─────────────
        {
          id: 'audio',
          tab: 'audio',
          title: 'Audio output',
          titleKey: 'provider-reolink:schema.s_audio.title',
          columns: 2,
          fields: [
            {
              type: 'slider',
              key: 'audioVolume',
              label: 'Speaker volume',
              labelKey: 'provider-reolink:schema.s_audio.audioVolume.label',
              min: 0,
              max: 100,
              step: 5,
              default: 50,
              showValue: true,
              showStepper: true,
            },
            {
              type: 'slider',
              key: 'audioTalkAndReplyVolume',
              label: 'Talk + reply volume',
              labelKey: 'provider-reolink:schema.s_audio.audioTalkAndReplyVolume.label',
              description: 'Doorbell models only.',
              descriptionKey: 'provider-reolink:schema.s_audio.audioTalkAndReplyVolume.description',
              min: 0,
              max: 100,
              step: 5,
              default: 50,
              showValue: true,
              showStepper: true,
            },
            {
              type: 'slider',
              key: 'audioVisitorVolume',
              label: 'Visitor volume',
              labelKey: 'provider-reolink:schema.s_audio.audioVisitorVolume.label',
              description: 'Doorbell models only.',
              descriptionKey: 'provider-reolink:schema.s_audio.audioVisitorVolume.description',
              min: 0,
              max: 100,
              step: 5,
              default: 50,
              showValue: true,
              showStepper: true,
              span: 2,
            },
          ],
        },
        // ── Audio noise reduction (writable via setAudioNoise cmd_id 440) ─
        // Single integer level: 0 = off; 1..3 = low / mid / high.
        // Lib treats `level <= 0` as the off path, so a value of 0
        // reliably disables denoise without needing a separate
        // boolean. Renders unconditionally — the camera silently
        // accepts the setter even when the firmware doesn't expose
        // a denoise UI in the mobile app.
        {
          id: 'audio-noise',
          tab: 'audio',
          title: 'Audio noise reduction',
          titleKey: 'provider-reolink:schema.s_audio-noise.title',
          columns: 1,
          fields: [
            {
              type: 'slider',
              key: 'audioNoiseLevel',
              label: 'Noise reduction level',
              labelKey: 'provider-reolink:schema.s_audio-noise.audioNoiseLevel.label',
              description: '0 = off · 1 = low · 2 = medium · 3 = high.',
              descriptionKey: 'provider-reolink:schema.s_audio-noise.audioNoiseLevel.description',
              min: 0,
              max: 3,
              step: 1,
              default: cache?.audioNoiseSnapshot?.enabled
                ? (cache.audioNoiseSnapshot?.level ?? 1)
                : 0,
              showValue: true,
              showStepper: true,
            },
          ],
        },
        // ── Intercom tuning ─────────────────────────────────────────
        // Storage settings with stable names and ranges. Only renders when the cam
        // advertises two-way audio so non-intercom models don't show
        // controls that have no effect. Source-of-truth is the
        // `feature-probe` runtime-state slice (the canonical post-
        // migration store; the legacy `deviceCache.hasIntercom` was
        // stripped by `DeviceConfig.fromSchema` self-healing).
        ...(this.getProbeFlags<ReolinkProbeFlags>().hasIntercom === true
          ? [
              {
                id: 'intercom',
                tab: 'audio' as const,
                title: 'Intercom',
                titleKey: 'provider-reolink:schema.s_intercom.title',
                description: 'Changes apply to the next talk session.',
                descriptionKey: 'provider-reolink:schema.s_intercom.description',
                columns: 2 as const,
                fields: [
                  {
                    type: 'slider' as const,
                    key: 'intercomBlocksPerPayload',
                    label: 'Blocks per payload',
                    labelKey: 'provider-reolink:schema.s_intercom.intercomBlocksPerPayload.label',
                    description: 'Lower is lower latency, higher is fewer calls. Range 1..8.',
                    descriptionKey:
                      'provider-reolink:schema.s_intercom.intercomBlocksPerPayload.description',
                    min: 1,
                    max: 8,
                    step: 1,
                    default: this.config.get('intercomBlocksPerPayload') ?? 1,
                    showValue: true,
                    showStepper: true,
                  },
                  {
                    type: 'slider' as const,
                    key: 'intercomMaxBacklogMs',
                    label: 'Max backlog (ms)',
                    labelKey: 'provider-reolink:schema.s_intercom.intercomMaxBacklogMs.label',
                    description:
                      'Higher is more stable on slow systems but adds latency. Range 20..5000.',
                    descriptionKey:
                      'provider-reolink:schema.s_intercom.intercomMaxBacklogMs.description',
                    min: 20,
                    max: 5000,
                    step: 20,
                    default: this.config.get('intercomMaxBacklogMs') ?? 120,
                    showValue: true,
                    showStepper: true,
                  },
                  {
                    type: 'slider' as const,
                    key: 'intercomGain',
                    label: 'Output gain',
                    labelKey: 'provider-reolink:schema.s_intercom.intercomGain.label',
                    description: '1.0 = neutral, 2.0 ≈ +6 dB, 0.5 ≈ -6 dB.',
                    descriptionKey: 'provider-reolink:schema.s_intercom.intercomGain.description',
                    min: 0.1,
                    max: 10,
                    step: 0.1,
                    default: this.config.get('intercomGain') ?? 1.0,
                    showValue: true,
                    showStepper: true,
                    span: 2 as const,
                  },
                ],
              },
            ]
          : []),
        // ── Keyframe interval / GOP (writable via setEnc cmd_id 57) ──
        // Main-stream GOP only. The other encoder dimensions (resolution
        // / bitrate / framerate / codec) are owned by the `stream-params`
        // cap; this single read-modify-write field lives here so the GOP
        // slider doesn't require touching the cap. Only rendered when the
        // encoder snapshot reported a current GOP (firmware exposes it).
        ...(typeof cache?.encSnapshot?.mainStream?.gop === 'number'
          ? [
              {
                id: 'keyframe-gop',
                tab: 'advanced' as const,
                title: 'Keyframe interval (GOP)',
                titleKey: 'provider-reolink:schema.s_keyframe-gop.title',
                description: 'Lower = more keyframes (faster recovery, higher bitrate).',
                descriptionKey: 'provider-reolink:schema.s_keyframe-gop.description',
                columns: 1 as const,
                fields: [
                  {
                    type: 'slider' as const,
                    key: 'gop',
                    label: 'Keyframe interval (s)',
                    labelKey: 'provider-reolink:schema.s_keyframe-gop.gop.label',
                    min: 1,
                    max: 10,
                    step: 1,
                    default: cache.encSnapshot.mainStream.gop ?? 4,
                    showValue: true,
                    showStepper: true,
                  },
                ],
              },
            ]
          : []),
        // ── PIR reduce-false-alarm (writable via setPirInfo cmd_id 213) ─
        // Only rendered when the PIR probe succeeded (`supported=true`).
        // PIR sensitivity / interval live on the PIR accessory child —
        // this is just the camera's false-positive filter toggle.
        ...(cache?.pirSnapshot?.supported === true
          ? [
              {
                id: 'pir-reduce-alarm',
                tab: 'advanced' as const,
                title: 'PIR detection',
                titleKey: 'provider-reolink:schema.s_pir-reduce-alarm.title',
                columns: 1 as const,
                fields: [
                  {
                    type: 'boolean' as const,
                    key: 'pirReduceFalseAlarm',
                    label: 'Reduce false alarms',
                    labelKey:
                      'provider-reolink:schema.s_pir-reduce-alarm.pirReduceFalseAlarm.label',
                    default: cache.pirSnapshot.reduceFalseAlarm ?? false,
                    style: 'switch' as const,
                  },
                ],
              },
            ]
          : []),
        // ── Auto reboot schedule (writable via setAutoReboot cmd_id 100) ─
        // Only rendered when the probe succeeded (`supported=true`). The
        // camera reboots weekly (or daily) at the configured time. Disabling
        // keeps the stored day/time so re-enabling restores the schedule.
        ...(cache?.autoRebootSnapshot?.supported === true
          ? [
              {
                id: 'auto-reboot',
                tab: 'advanced' as const,
                title: 'Auto reboot',
                titleKey: 'provider-reolink:schema.s_auto-reboot.title',
                columns: 2 as const,
                fields: [
                  {
                    type: 'boolean' as const,
                    key: 'autoRebootEnabled',
                    label: 'Auto reboot',
                    labelKey: 'provider-reolink:schema.s_auto-reboot.autoRebootEnabled.label',
                    default: cache.autoRebootSnapshot.enabled ?? false,
                    style: 'switch' as const,
                    span: 2 as const,
                  },
                  {
                    type: 'select' as const,
                    key: 'autoRebootWeekDay',
                    label: 'Day',
                    labelKey: 'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.label',
                    default: cache.autoRebootSnapshot.weekDay ?? 'everyday',
                    span: 2 as const,
                    options: [
                      {
                        value: 'everyday',
                        label: 'Every day',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_everyday.label',
                      },
                      {
                        value: 'Sunday',
                        label: 'Sunday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Sunday.label',
                      },
                      {
                        value: 'Monday',
                        label: 'Monday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Monday.label',
                      },
                      {
                        value: 'Tuesday',
                        label: 'Tuesday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Tuesday.label',
                      },
                      {
                        value: 'Wednesday',
                        label: 'Wednesday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Wednesday.label',
                      },
                      {
                        value: 'Thursday',
                        label: 'Thursday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Thursday.label',
                      },
                      {
                        value: 'Friday',
                        label: 'Friday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Friday.label',
                      },
                      {
                        value: 'Saturday',
                        label: 'Saturday',
                        labelKey:
                          'provider-reolink:schema.s_auto-reboot.autoRebootWeekDay.o_Saturday.label',
                      },
                    ],
                  },
                  {
                    type: 'number' as const,
                    key: 'autoRebootHour',
                    label: 'Hour (0-23)',
                    labelKey: 'provider-reolink:schema.s_auto-reboot.autoRebootHour.label',
                    default: cache.autoRebootSnapshot.hour ?? 3,
                    min: 0,
                    max: 23,
                    step: 1,
                  },
                  {
                    type: 'number' as const,
                    key: 'autoRebootMinute',
                    label: 'Minute (0-59)',
                    labelKey: 'provider-reolink:schema.s_auto-reboot.autoRebootMinute.label',
                    default: cache.autoRebootSnapshot.minute ?? 0,
                    min: 0,
                    max: 59,
                    step: 1,
                  },
                ],
              },
            ]
          : []),
        {
          id: 'debug',
          tab: 'advanced',
          title: 'Debug',
          titleKey: 'provider-reolink:schema.s_debug.title',
          description: 'Debug logging adds log volume; use it temporarily.',
          descriptionKey: 'provider-reolink:schema.s_debug.description',
          columns: 1,
          fields: [
            {
              type: 'boolean',
              key: 'debugGeneral',
              label: 'General debug logs',
              labelKey: 'provider-reolink:schema.s_debug.debugGeneral.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'multiselect',
              key: 'debugSocketLogs',
              label: 'Socket trace categories',
              labelKey: 'provider-reolink:schema.s_debug.debugSocketLogs.label',
              description: 'Each area adds log volume.',
              descriptionKey: 'provider-reolink:schema.s_debug.debugSocketLogs.description',
              default: [],
              options: [
                {
                  value: 'debugRtsp',
                  label: 'RTSP (proxy/server traffic)',
                  labelKey: 'provider-reolink:schema.s_debug.debugSocketLogs.o_debugRtsp.label',
                },
                {
                  value: 'traceNativeStream',
                  label: 'Native stream (cmd 3/4 + H.264/H.265 + param sets)',
                  labelKey:
                    'provider-reolink:schema.s_debug.debugSocketLogs.o_traceNativeStream.label',
                },
                {
                  value: 'traceRecordings',
                  label: 'Recordings (FileInfoList, findAlarmVideo, download)',
                  labelKey:
                    'provider-reolink:schema.s_debug.debugSocketLogs.o_traceRecordings.label',
                },
                {
                  value: 'traceTalk',
                  label: 'Talkback (cmd 10/11/201/202)',
                  labelKey: 'provider-reolink:schema.s_debug.debugSocketLogs.o_traceTalk.label',
                },
                {
                  value: 'traceEvents',
                  label: 'Events (cmd 33 — AlarmEventList push)',
                  labelKey: 'provider-reolink:schema.s_debug.debugSocketLogs.o_traceEvents.label',
                },
              ],
            },
          ],
        },
        // Per-snapshot freshness (D224 generalised, D346): read-only panel
        // showing when each cached camera reading was last fetched — a
        // group with no stamp is of UNKNOWN age, never presented as fresh.
        // Triggers no reads (refresh stays on the "Refresh from camera"
        // action + event-driven paths).
        buildSnapshotFreshnessSection(cache, {
          sleeping: this.isBattery && this.sleeping,
          now: Date.now(),
        }),
        ...this.buildSessionsTabSections(),
        // Email/SMTP push — battery-cam motion capture without polling.
        // Only battery cameras benefit (wired cams keep a live socket
        // for native push), so the section is gated on `isBattery` AND
        // the camera being email-push-eligible (standalone, not
        // hub-attached). `buildEmailPushSection` returns `[]` otherwise.
        ...this.buildEmailPushSection(),
        // Editable on-camera email/SMTP config — its own "Email" tab, built
        // like every other settings section (Connection / NTP / Audio).
        ...this.buildEmailTabSections(),
        // The clip-catalog refresh interval, and — only on a standalone
        // battery camera, where it means anything — the forced wake (D562).
        ...buildClipRefreshDeviceSection({
          isHubChild: this.isHubChild(),
          isBattery: this.isBattery,
        }),
        // The scheduled full refresh window (D847), battery cameras only.
        ...buildBatteryRefreshDeviceSection({ isBattery: this.isBattery }),
      ],
    }
    const emailSnap = cache?.emailConfigSnapshot
    const values: Record<string, unknown> = {
      host: this.config.get('host'),
      port: this.config.get('port'),
      username: this.config.get('username'),
      password: this.config.get('password'),
      // Email/SMTP — camera-side config, shown live from the snapshot (no
      // local persist). Password is never echoed back (blank = leave as-is).
      emailSmtpServer: emailSnap?.smtpServer ?? '',
      emailSmtpPort: emailSnap?.smtpPort ?? 587,
      emailUserName: emailSnap?.userName ?? '',
      emailPassword: '',
      emailSsl: emailSnap?.ssl ?? false,
      emailRecipient1: emailSnap?.recipients?.[0] ?? '',
      emailRecipient2: emailSnap?.recipients?.[1] ?? '',
      emailRecipient3: emailSnap?.recipients?.[2] ?? '',
      emailSendNickname: emailSnap?.sendNickname ?? this.name,
      emailScheduleEnabled: emailSnap?.taskEnabled ?? false,
      // Left UNDEFINED when the camera overrides nothing: an empty field is
      // what "use the addon default" looks like, and seeding it with the
      // global would turn every camera into an override on the first Save
      // (`resolveClipCatalogRefreshMinutes` — reset == unset == the default).
      clipCatalogRefreshMinutes: this.config.get('clipCatalogRefreshMinutes'),
      clipCatalogForcedWake: this.config.get('clipCatalogForcedWake') ?? false,
      // Left undefined unless overridden, like the clip interval above: seeding
      // the default would turn every save into an override.
      batteryRefreshMinutes: this.config.get('batteryRefreshMinutes'),
      debugGeneral: this.config.get('debugGeneral') ?? false,
      debugSocketLogs: this.config.get('debugSocketLogs') ?? [],
      motionEnabled: this.config.get('motionEnabled') ?? motionSnap.enabled ?? true,
      motionSensitivity: this.config.get('motionSensitivity') ?? motionSnap.sensitivity ?? 25,
      // Per-AI-class sensitivities — operator override → camera
      // snapshot → schema default 50. Sliders that aren't rendered
      // (camera doesn't advertise the detector) round-trip the
      // value back as undefined and Zod's `.optional()` lets it
      // pass through `setAll` without trampling.
      aiPersonSensitivity:
        this.config.get('aiPersonSensitivity') ??
        cache?.aiSensitivitySnapshot?.['people']?.sensitivity ??
        50,
      aiVehicleSensitivity:
        this.config.get('aiVehicleSensitivity') ??
        cache?.aiSensitivitySnapshot?.['vehicle']?.sensitivity ??
        50,
      aiAnimalSensitivity:
        this.config.get('aiAnimalSensitivity') ??
        cache?.aiSensitivitySnapshot?.['dog_cat']?.sensitivity ??
        50,
      aiFaceSensitivity:
        this.config.get('aiFaceSensitivity') ??
        cache?.aiSensitivitySnapshot?.['face']?.sensitivity ??
        50,
      aiPackageSensitivity:
        this.config.get('aiPackageSensitivity') ??
        cache?.aiSensitivitySnapshot?.['package']?.sensitivity ??
        50,
      // Per-AI-class stay times — operator override → camera snapshot →
      // 0. Same gating + round-trip semantics as the sensitivity sliders.
      aiPersonStayTime:
        this.config.get('aiPersonStayTime') ??
        cache?.aiSensitivitySnapshot?.['people']?.stayTime ??
        0,
      aiVehicleStayTime:
        this.config.get('aiVehicleStayTime') ??
        cache?.aiSensitivitySnapshot?.['vehicle']?.stayTime ??
        0,
      aiAnimalStayTime:
        this.config.get('aiAnimalStayTime') ??
        cache?.aiSensitivitySnapshot?.['dog_cat']?.stayTime ??
        0,
      aiFaceStayTime:
        this.config.get('aiFaceStayTime') ?? cache?.aiSensitivitySnapshot?.['face']?.stayTime ?? 0,
      aiPackageStayTime:
        this.config.get('aiPackageStayTime') ??
        cache?.aiSensitivitySnapshot?.['package']?.stayTime ??
        0,
      // Per-AI-class min/max target-size gates — operator override → camera
      // snapshot → schema default (0 for mins = no lower bound, 1 for maxes
      // = no upper bound). Same gating + round-trip semantics as above.
      aiPersonMinTargetWidth:
        this.config.get('aiPersonMinTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['people']?.minTargetWidth ??
        0,
      aiPersonMinTargetHeight:
        this.config.get('aiPersonMinTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['people']?.minTargetHeight ??
        0,
      aiPersonMaxTargetWidth:
        this.config.get('aiPersonMaxTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['people']?.maxTargetWidth ??
        1,
      aiPersonMaxTargetHeight:
        this.config.get('aiPersonMaxTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['people']?.maxTargetHeight ??
        1,
      aiVehicleMinTargetWidth:
        this.config.get('aiVehicleMinTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['vehicle']?.minTargetWidth ??
        0,
      aiVehicleMinTargetHeight:
        this.config.get('aiVehicleMinTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['vehicle']?.minTargetHeight ??
        0,
      aiVehicleMaxTargetWidth:
        this.config.get('aiVehicleMaxTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['vehicle']?.maxTargetWidth ??
        1,
      aiVehicleMaxTargetHeight:
        this.config.get('aiVehicleMaxTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['vehicle']?.maxTargetHeight ??
        1,
      aiAnimalMinTargetWidth:
        this.config.get('aiAnimalMinTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['dog_cat']?.minTargetWidth ??
        0,
      aiAnimalMinTargetHeight:
        this.config.get('aiAnimalMinTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['dog_cat']?.minTargetHeight ??
        0,
      aiAnimalMaxTargetWidth:
        this.config.get('aiAnimalMaxTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['dog_cat']?.maxTargetWidth ??
        1,
      aiAnimalMaxTargetHeight:
        this.config.get('aiAnimalMaxTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['dog_cat']?.maxTargetHeight ??
        1,
      aiFaceMinTargetWidth:
        this.config.get('aiFaceMinTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['face']?.minTargetWidth ??
        0,
      aiFaceMinTargetHeight:
        this.config.get('aiFaceMinTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['face']?.minTargetHeight ??
        0,
      aiFaceMaxTargetWidth:
        this.config.get('aiFaceMaxTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['face']?.maxTargetWidth ??
        1,
      aiFaceMaxTargetHeight:
        this.config.get('aiFaceMaxTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['face']?.maxTargetHeight ??
        1,
      aiPackageMinTargetWidth:
        this.config.get('aiPackageMinTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['package']?.minTargetWidth ??
        0,
      aiPackageMinTargetHeight:
        this.config.get('aiPackageMinTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['package']?.minTargetHeight ??
        0,
      aiPackageMaxTargetWidth:
        this.config.get('aiPackageMaxTargetWidth') ??
        cache?.aiSensitivitySnapshot?.['package']?.maxTargetWidth ??
        1,
      aiPackageMaxTargetHeight:
        this.config.get('aiPackageMaxTargetHeight') ??
        cache?.aiSensitivitySnapshot?.['package']?.maxTargetHeight ??
        1,
      // Image controls — operator override on `this.config.get`,
      // probed snapshot fallback (so the slider lands on the
      // current camera value the first time the panel is opened),
      // schema default last.
      imgBright: this.config.get('imgBright') ?? imgSnap.bright ?? 128,
      imgContrast: this.config.get('imgContrast') ?? imgSnap.contrast ?? 128,
      imgSaturation: this.config.get('imgSaturation') ?? imgSnap.saturation ?? 128,
      imgHue: this.config.get('imgHue') ?? imgSnap.hue ?? 128,
      imgSharpen: this.config.get('imgSharpen') ?? 128,
      ispDayNight: this.config.get('ispDayNight') ?? imgSnap.dayNight ?? 'auto',
      ispExposure: this.config.get('ispExposure') ?? 'auto',
      irLightsState: this.config.get('irLightsState') ?? 'Auto',
      irLightsBrightness: this.config.get('irLightsBrightness') ?? 128,
      // Status + doorbell LED — operator override → LED snapshot →
      // enabled. Hydration covers the value side even when the section
      // is gated out (no doorbell LED) so `setAll` round-trips stay clean.
      statusLedEnabled:
        this.config.get('statusLedEnabled') ?? cache?.ledSnapshot?.statusEnabled ?? true,
      doorbellLedEnabled:
        this.config.get('doorbellLedEnabled') ?? cache?.ledSnapshot?.doorbellEnabled ?? true,
      // OSD overlay — operator override → camera snapshot → UNKNOWN (null).
      // Shared with the section defaults via `resolveOsdValues`; `??` must
      // never resurrect a boolean for a fact nobody observed (D337 — the
      // old `?? true` rendered "the camera did not tell us" as ON).
      osdChannelEnabled: osdValues.osdChannelEnabled,
      osdChannelName: osdValues.osdChannelName,
      osdChannelPosition: osdValues.osdChannelPosition,
      osdTimeEnabled: osdValues.osdTimeEnabled,
      osdTimePosition: osdValues.osdTimePosition,
      osdWatermark: osdValues.osdWatermark,
      audioVolume: this.config.get('audioVolume') ?? 50,
      audioTalkAndReplyVolume: this.config.get('audioTalkAndReplyVolume') ?? 50,
      audioVisitorVolume: this.config.get('audioVisitorVolume') ?? 50,
      // Privacy mask master switch + Audio noise level + AutoFocus
      audioNoiseLevel:
        this.config.get('audioNoiseLevel') ??
        (cache?.audioNoiseSnapshot?.enabled ? (cache.audioNoiseSnapshot?.level ?? 1) : 0),
      autoFocusEnabled:
        this.config.get('autoFocusEnabled') ?? cache?.autoFocusSnapshot?.enabled ?? true,
      // PIR reduce-false-alarm + main-stream GOP — operator override →
      // camera snapshot → defaults.
      pirReduceFalseAlarm:
        this.config.get('pirReduceFalseAlarm') ?? cache?.pirSnapshot?.reduceFalseAlarm ?? false,
      gop: this.config.get('gop') ?? cache?.encSnapshot?.mainStream?.gop ?? 4,
      // Auto-reboot schedule — operator override → camera snapshot →
      // defaults (disabled, every day at 03:00).
      autoRebootEnabled:
        this.config.get('autoRebootEnabled') ?? cache?.autoRebootSnapshot?.enabled ?? false,
      autoRebootWeekDay:
        this.config.get('autoRebootWeekDay') ?? cache?.autoRebootSnapshot?.weekDay ?? 'everyday',
      autoRebootHour: this.config.get('autoRebootHour') ?? cache?.autoRebootSnapshot?.hour ?? 3,
      autoRebootMinute:
        this.config.get('autoRebootMinute') ?? cache?.autoRebootSnapshot?.minute ?? 0,
      // Intercom tuning — operator override → shipped defaults.
      // Hydration covers the value side even when the section is gated
      // out (non-intercom cams), keeping `setAll` round-trips clean.
      intercomBlocksPerPayload: this.config.get('intercomBlocksPerPayload') ?? 1,
      intercomMaxBacklogMs: this.config.get('intercomMaxBacklogMs') ?? 120,
      intercomGain: this.config.get('intercomGain') ?? 1.0,
    }
    return hydrateSchema(schema, values)
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    // "Click button → run side-effect" UIs (Refresh from camera / Refresh
    // sessions / Auto-configure email push) no longer flow through here —
    // they dispatch typed device custom actions via runDeviceAction. This
    // override only persists real settings, plus the editable Email-tab and
    // OSD fields, which are written straight to the camera (never stored in
    // our config — the camera owns that state). For OSD the write is its own
    // invalidation: the post-save `osd` slice refresh below re-reads the
    // camera, so the form always shows what the camera actually accepted —
    // a refused or partial `setOsd` is never recorded as fact.
    const {
      emailSmtpServer,
      emailSmtpPort,
      emailUserName,
      emailPassword,
      emailSsl,
      emailRecipient1,
      emailRecipient2,
      emailRecipient3,
      emailSendNickname,
      emailScheduleEnabled,
      osdChannelEnabled,
      osdChannelName,
      osdChannelPosition,
      osdTimeEnabled,
      osdTimePosition,
      osdWatermark,
      ...rest
    } = patch
    // A camera-owned write must REACH the camera. On a hub child `ensureApi()`
    // is the parent's socket, so nothing in this path touches the camera's
    // radio — and a battery camera is asleep at almost every save. Measured on
    // 3825 on 2026-09-19: a write two seconds after the sleep push was
    // answered `success` by the Home Hub in 0.8 s and the camera never held
    // the value. `wakeIfSleeping` no-ops for a non-battery or already-awake
    // camera, so this costs nothing except where the write would be lost.
    const touchesCamera =
      osdChannelEnabled !== undefined ||
      osdChannelName !== undefined ||
      osdChannelPosition !== undefined ||
      osdTimeEnabled !== undefined ||
      osdTimePosition !== undefined ||
      osdWatermark !== undefined ||
      emailSmtpServer !== undefined ||
      emailRecipient1 !== undefined
    if (touchesCamera && !(await this.wakeIfSleeping())) {
      this.ctx.logger.warn('settings write: battery cam did not wake — writing anyway', {
        tags: { deviceId: this.id },
      })
    }

    const emailFields = {
      emailSmtpServer,
      emailSmtpPort,
      emailUserName,
      emailPassword,
      emailSsl,
      emailRecipient1,
      emailRecipient2,
      emailRecipient3,
      emailSendNickname,
      emailScheduleEnabled,
    }
    if (Object.values(emailFields).some((v) => v !== undefined)) {
      // Edited Email-tab fields → write to the camera + realign the snapshot.
      await this.applyEmailConfigPatch(emailFields).catch((err: unknown) => {
        this.ctx.logger.warn('email config write failed', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    // OSD keys are camera-writes, not config — an osd-only save leaves
    // `rest` empty but must still reach the setOsd dispatcher (and the
    // post-save `osd` slice re-read) below.
    const osdPatch = buildOsdPatch({
      osdChannelEnabled,
      osdChannelName,
      osdChannelPosition,
      osdTimeEnabled,
      osdTimePosition,
      osdWatermark,
    })
    // An osd-only save leaves `rest` empty but must still reach the camera
    // push AND the post-save `osd` re-read. A save whose only OSD key was the
    // "keep the camera's placement" position writes nothing, but still
    // re-reads - the form should snap back to what the camera holds.
    const hasOsdPatch =
      osdPatch !== null ||
      [
        osdChannelEnabled,
        osdChannelName,
        osdChannelPosition,
        osdTimeEnabled,
        osdTimePosition,
        osdWatermark,
      ].some((v) => v !== undefined)
    if (Object.keys(rest).length === 0 && !hasOsdPatch) return

    // setAll() already shallow-merges over the current data and
    // re-parses against the schema; no manual snapshot required.
    if (Object.keys(rest).length > 0) await this.config.setAll(rest)
    const typedPatch = patch as Partial<ReolinkCameraConfig>
    if (typedPatch.host || typedPatch.port || typedPatch.username || typedPatch.password) {
      await this.disconnectAll()
      return
    }
    // Debug-flag changes need a fresh `new ReolinkBaichuanApi` so the
    // lib picks the new options up. Don't tear down active streams —
    // each rfc4571 server holds its own dedicated socket and survives
    // a control-channel reset (see scheduleReconnect comment). Just
    // drop the cached api so the next demand rebuilds with the new
    // debug blob.
    if ('debugGeneral' in patch || 'debugSocketLogs' in patch) {
      if (this.api) {
        try {
          await this.api.close({ reason: 'debug-options-changed' })
        } catch {
          /* best-effort */
        }
        this.api = null
      }
    }
    // Timezone push — the friendly `timeZoneId` picker resolves to a
    // standard UTC offset (`SetSystemGeneral`, cmd 105) plus an implicit
    // DST rule (`SetDst`, cmd 107). The offset uses POSIX sign (UTC+1 →
    // -3600s), so we negate the east-positive `stdOffsetMinutes`. DST is
    // enabled with the zone's rule, or disabled for non-DST zones — the
    // operator never sees a separate DST toggle. The `timeZoneId` value
    // is already persisted by the `setAll(rest)` above; this block only
    // pushes the camera-side state.
    if (
      'timeZoneId' in patch &&
      typeof typedPatch.timeZoneId === 'string' &&
      typedPatch.timeZoneId
    ) {
      const tz = findTimezone(typedPatch.timeZoneId)
      if (tz) {
        try {
          const api = await this.ensureApi()
          await api.setSystemGeneral({ timeZone: -(tz.stdOffsetMinutes * 60) })
          // DST is best-effort: some firmwares lack cmd 107. A failure
          // here must not roll back the (already-applied) base offset.
          try {
            if (tz.dst) {
              await api.setDst({
                enable: 1,
                offset: tz.dst.offsetHours,
                startMonth: tz.dst.startMonth,
                startWeekIndex: tz.dst.startWeekIndex,
                startWeekday: tz.dst.startWeekday,
                startHour: tz.dst.startHour,
                startMinute: 0,
                startSecond: 0,
                endMonth: tz.dst.endMonth,
                endWeekIndex: tz.dst.endWeekIndex,
                endWeekday: tz.dst.endWeekday,
                endHour: tz.dst.endHour,
                endMinute: 0,
                endSecond: 0,
              })
            } else {
              await api.setDst({ enable: 0 })
            }
          } catch (dstError: unknown) {
            this.ctx.logger.debug('reolink DST push skipped (firmware may lack cmd 107)', {
              tags: { deviceId: this.id },
              meta: { error: dstError instanceof Error ? dstError.message : String(dstError) },
            })
          }
        } catch (error: unknown) {
          this.ctx.logger.warn('reolink timezone push failed', {
            tags: { deviceId: this.id },
            meta: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
    }
    // Motion alarm push (cmdId=47) — fires on either field change.
    // The schema field is the user-facing 1..50 (Reolink mobile-app
    // semantics); the camera-side raw value is the INVERSE
    // (`raw = 51 - userValue`) — same as reolink_aio's
    // `set_md_sensitivity`. We invert here on push so the operator
    // never sees the raw value. Reads current state into the wire
    // signature so the camera doesn't lose the un-touched dimension
    // (sensitivity stays put when only the master switch flips).
    if ('motionEnabled' in patch || 'motionSensitivity' in patch) {
      try {
        const api = await this.ensureApi()
        const cur = this.config.get('deviceCache')?.motionSnapshot ?? {}
        const enabled = typedPatch.motionEnabled ?? cur.enabled ?? true
        const userSensitivity = typedPatch.motionSensitivity ?? cur.sensitivity ?? undefined
        const rawSensitivity =
          typeof userSensitivity === 'number' ? 51 - userSensitivity : undefined
        const channel = this.getChannel()
        await api.setMotionAlarm(enabled, rawSensitivity, channel)
      } catch (err) {
        this.ctx.logger.warn('motion alarm push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Per-AI-class sensitivity + stay-time + min/max target-size gates
    // (cmdId=343 via `setAiDetectionFull`). One CONSOLIDATED call per
    // touched class: the lib's `setAiDetectionFull(channel, aiType, patch)`
    // writes the entire `<AiDetectCfg>` block in one round-trip, so we fold
    // sensitivity, stayTime AND the four target-size fractions into a single
    // SET to avoid two writes clobbering each other (e.g. a target-size
    // edit resetting sensitivity). Any field the operator didn't touch is
    // carried over from the AI snapshot so it stays put; `patchAiDetectCfgXml`
    // inside the lib preserves anything we still omit. We refresh the
    // snapshot at the end so the next form render shows the values the
    // camera actually accepted (Reolink clamps internally on a few firmwares).
    const aiPushes: ReadonlyArray<{
      sensKey: keyof ReolinkCameraConfig
      stayKey: keyof ReolinkCameraConfig
      minWKey: keyof ReolinkCameraConfig
      minHKey: keyof ReolinkCameraConfig
      maxWKey: keyof ReolinkCameraConfig
      maxHKey: keyof ReolinkCameraConfig
      aiType: string
    }> = [
      {
        sensKey: 'aiPersonSensitivity',
        stayKey: 'aiPersonStayTime',
        minWKey: 'aiPersonMinTargetWidth',
        minHKey: 'aiPersonMinTargetHeight',
        maxWKey: 'aiPersonMaxTargetWidth',
        maxHKey: 'aiPersonMaxTargetHeight',
        aiType: 'people',
      },
      {
        sensKey: 'aiVehicleSensitivity',
        stayKey: 'aiVehicleStayTime',
        minWKey: 'aiVehicleMinTargetWidth',
        minHKey: 'aiVehicleMinTargetHeight',
        maxWKey: 'aiVehicleMaxTargetWidth',
        maxHKey: 'aiVehicleMaxTargetHeight',
        aiType: 'vehicle',
      },
      {
        sensKey: 'aiAnimalSensitivity',
        stayKey: 'aiAnimalStayTime',
        minWKey: 'aiAnimalMinTargetWidth',
        minHKey: 'aiAnimalMinTargetHeight',
        maxWKey: 'aiAnimalMaxTargetWidth',
        maxHKey: 'aiAnimalMaxTargetHeight',
        aiType: 'dog_cat',
      },
      {
        sensKey: 'aiFaceSensitivity',
        stayKey: 'aiFaceStayTime',
        minWKey: 'aiFaceMinTargetWidth',
        minHKey: 'aiFaceMinTargetHeight',
        maxWKey: 'aiFaceMaxTargetWidth',
        maxHKey: 'aiFaceMaxTargetHeight',
        aiType: 'face',
      },
      {
        sensKey: 'aiPackageSensitivity',
        stayKey: 'aiPackageStayTime',
        minWKey: 'aiPackageMinTargetWidth',
        minHKey: 'aiPackageMinTargetHeight',
        maxWKey: 'aiPackageMaxTargetWidth',
        maxHKey: 'aiPackageMaxTargetHeight',
        aiType: 'package',
      },
    ]
    const aiSnap = this.config.get('deviceCache')?.aiSensitivitySnapshot ?? {}
    for (const { sensKey, stayKey, minWKey, minHKey, maxWKey, maxHKey, aiType } of aiPushes) {
      const touchedKeys = [sensKey, stayKey, minWKey, minHKey, maxWKey, maxHKey] as const
      if (!touchedKeys.some((k) => k in patch)) continue

      const snap = aiSnap[aiType]
      // For each field: the operator's touched value wins; otherwise carry
      // the snapshot's current value so the consolidated SET doesn't reset
      // it. `null` / missing snapshot → leave the field `undefined` (the lib
      // preserves the camera's existing value for omitted fields).
      const resolve = (
        key: keyof ReolinkCameraConfig,
        snapValue: number | null | undefined,
      ): number | undefined => {
        const patchValue = typedPatch[key]
        if (typeof patchValue === 'number') return patchValue
        return typeof snapValue === 'number' ? snapValue : undefined
      }

      const fullPatch: {
        sensitivity?: number
        stayTime?: number
        minTargetWidth?: number
        minTargetHeight?: number
        maxTargetWidth?: number
        maxTargetHeight?: number
      } = {}
      const sensitivity = resolve(sensKey, snap?.sensitivity)
      const stayTime = resolve(stayKey, snap?.stayTime)
      const minTargetWidth = resolve(minWKey, snap?.minTargetWidth)
      const minTargetHeight = resolve(minHKey, snap?.minTargetHeight)
      const maxTargetWidth = resolve(maxWKey, snap?.maxTargetWidth)
      const maxTargetHeight = resolve(maxHKey, snap?.maxTargetHeight)
      if (sensitivity !== undefined) fullPatch.sensitivity = sensitivity
      if (stayTime !== undefined) fullPatch.stayTime = stayTime
      if (minTargetWidth !== undefined) fullPatch.minTargetWidth = minTargetWidth
      if (minTargetHeight !== undefined) fullPatch.minTargetHeight = minTargetHeight
      if (maxTargetWidth !== undefined) fullPatch.maxTargetWidth = maxTargetWidth
      if (maxTargetHeight !== undefined) fullPatch.maxTargetHeight = maxTargetHeight

      try {
        const api = await this.ensureApi()
        await api.setAiDetectionFull(this.getChannel(), aiType, fullPatch)
      } catch (err) {
        this.ctx.logger.warn('ai detection push failed', {
          meta: { aiType, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    // Image controls (cmdId=25 via setImage). Build a partial patch
    // covering only the keys the operator actually touched — the lib
    // does a read-modify-write at cmdId=26 and only patches the tags
    // we pass, so untouched values stay at their camera-current value
    // even if the operator hasn't seen the latest probe yet.
    const imageKeys = ['imgBright', 'imgContrast', 'imgSaturation', 'imgHue', 'imgSharpen'] as const
    if (imageKeys.some((k) => k in patch)) {
      try {
        const api = await this.ensureApi()
        const imagePatch: Parameters<typeof api.setImage>[1] = {}
        if (typeof typedPatch.imgBright === 'number') imagePatch.bright = typedPatch.imgBright
        if (typeof typedPatch.imgContrast === 'number') imagePatch.contrast = typedPatch.imgContrast
        if (typeof typedPatch.imgSaturation === 'number')
          imagePatch.saturation = typedPatch.imgSaturation
        if (typeof typedPatch.imgHue === 'number') imagePatch.hue = typedPatch.imgHue
        if (typeof typedPatch.imgSharpen === 'number') imagePatch.sharpen = typedPatch.imgSharpen
        if (Object.keys(imagePatch).length > 0) {
          await api.setImage(this.getChannel(), imagePatch)
        }
      } catch (err) {
        this.ctx.logger.warn('image push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // ISP (DayNight / Exposure) — same cmdId=25 path with a different
    // section of the InputAdvanceCfg block. The lib's setIsp method
    // covers dayNight + exposure + binningMode + hdr + the threshold
    // (cmd_id 297) in one call.
    const ispKeys = [
      'ispDayNight',
      'ispExposure',
      'ispHdr',
      'ispBinningMode',
      'ispDayNightThreshold',
    ] as const
    if (ispKeys.some((k) => k in patch)) {
      try {
        const api = await this.ensureApi()
        const ispPatch: Parameters<typeof api.setIsp>[1] = {}
        if (typeof typedPatch.ispDayNight === 'string' && typedPatch.ispDayNight)
          ispPatch.dayNight = typedPatch.ispDayNight
        if (typeof typedPatch.ispExposure === 'string' && typedPatch.ispExposure)
          ispPatch.exposure = typedPatch.ispExposure
        if (typeof typedPatch.ispBinningMode === 'number')
          ispPatch.binningMode = typedPatch.ispBinningMode
        if (typedPatch.ispHdr === 0 || typedPatch.ispHdr === 1) ispPatch.hdr = typedPatch.ispHdr
        if (typeof typedPatch.ispDayNightThreshold === 'number')
          ispPatch.dayNightThreshold = typedPatch.ispDayNightThreshold
        if (Object.keys(ispPatch).length > 0) {
          await api.setIsp(this.getChannel(), ispPatch)
        }
      } catch (err) {
        this.ctx.logger.warn('isp push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // IR + status LED + doorbell LED (cmdId=209). Translate the
    // operator-friendly enums to the lib's already-normalized keys
    // (`irState`, `irBrightness`, `lightState`, `doorbellLightState`).
    // The status/doorbell LED booleans map to the lib's friendly
    // `'On'`/`'Off'` strings (the lib normalises to `open`/`close`).
    if (
      'irLightsState' in patch ||
      'irLightsBrightness' in patch ||
      'statusLedEnabled' in patch ||
      'doorbellLedEnabled' in patch
    ) {
      try {
        const api = await this.ensureApi()
        const irPatch: Parameters<typeof api.setIrLights>[1] = {}
        if (typedPatch.irLightsState !== undefined) irPatch.irState = typedPatch.irLightsState
        if (typeof typedPatch.irLightsBrightness === 'number')
          irPatch.irBrightness = typedPatch.irLightsBrightness
        if (typeof typedPatch.statusLedEnabled === 'boolean')
          irPatch.lightState = typedPatch.statusLedEnabled ? 'On' : 'Off'
        if (typeof typedPatch.doorbellLedEnabled === 'boolean')
          irPatch.doorbellLightState = typedPatch.doorbellLedEnabled ? 'On' : 'Off'
        if (Object.keys(irPatch).length > 0) {
          await api.setIrLights(this.getChannel(), irPatch)
        }
      } catch (err) {
        this.ctx.logger.warn('ir-lights push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // OSD overlay (cmd_id 45 via setOsd). The lib read-modify-writes
    // the camera's own `<OsdDatetime>` + `<OsdChannelName>` XML, so the patch
    // names ONLY the touched fields and every other field the camera sent -
    // width/height/language/enBgcolor, and the anchor of whichever overlay
    // was not repositioned - survives untouched. The values come from the
    // destructured patch locals, NOT the config: nothing is stored, and
    // whether the camera accepted the write is answered only by the post-save
    // `osd` slice re-read at the bottom of this method - intent is never
    // stamped as fact.
    if (osdPatch !== null) {
      try {
        const api = await this.ensureApi()
        await api.setOsd(this.getChannel(), osdPatch)
      } catch (err) {
        // The re-read below will show the camera's real (unchanged) state,
        // so the form snaps back honestly - but the drop itself must be
        // visible, per-camera.
        this.ctx.logger.warn('osd push failed - camera keeps its current overlay state', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Audio output (cmdId=265). Doorbell-only fields silently no-op
    // on cameras without the talk/visitor channels — cleaner than
    // gating the UI on the abilities probe.
    const audioKeys = ['audioVolume', 'audioTalkAndReplyVolume', 'audioVisitorVolume'] as const
    if (audioKeys.some((k) => k in patch)) {
      try {
        const api = await this.ensureApi()
        const audioPatch: Parameters<typeof api.setAudioCfg>[1] = {}
        if (typeof typedPatch.audioVolume === 'number') audioPatch.volume = typedPatch.audioVolume
        if (typeof typedPatch.audioTalkAndReplyVolume === 'number')
          audioPatch.talkAndReplyVolume = typedPatch.audioTalkAndReplyVolume
        if (typeof typedPatch.audioVisitorVolume === 'number')
          audioPatch.visitorVolume = typedPatch.audioVisitorVolume
        if (Object.keys(audioPatch).length > 0) await api.setAudioCfg(this.getChannel(), audioPatch)
      } catch (err) {
        this.ctx.logger.warn('audio-cfg push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Network service ports (cmd_id 36 via setPortConfig). Push only
    // the protocols whose enable/port the operator touched — the lib
    // emits one `<XxxPort>` block per protocol, so untouched protocols
    // keep their camera-side values.
    const netPortEntries: ReadonlyArray<{
      proto: 'http' | 'https' | 'rtsp' | 'rtmp' | 'onvif'
      enableKey: keyof ReolinkCameraConfig
      portKey: keyof ReolinkCameraConfig
    }> = [
      { proto: 'http', enableKey: 'netHttpEnable', portKey: 'netHttpPort' },
      { proto: 'https', enableKey: 'netHttpsEnable', portKey: 'netHttpsPort' },
      { proto: 'rtsp', enableKey: 'netRtspEnable', portKey: 'netRtspPort' },
      { proto: 'rtmp', enableKey: 'netRtmpEnable', portKey: 'netRtmpPort' },
      { proto: 'onvif', enableKey: 'netOnvifEnable', portKey: 'netOnvifPort' },
    ]
    if (netPortEntries.some((e) => e.enableKey in patch || e.portKey in patch)) {
      const portPatch: Parameters<ReolinkBaichuanApi['setPortConfig']>[0] = {}
      for (const { proto, enableKey, portKey } of netPortEntries) {
        const entry: { port?: number; enable?: boolean } = {}
        const enableVal = typedPatch[enableKey]
        const portVal = typedPatch[portKey]
        if (typeof enableVal === 'boolean') entry.enable = enableVal
        if (typeof portVal === 'number') entry.port = portVal
        if (entry.enable !== undefined || entry.port !== undefined) portPatch[proto] = entry
      }
      if (Object.keys(portPatch).length > 0) {
        try {
          const api = await this.ensureApi()
          await api.setPortConfig(portPatch)
        } catch (err) {
          this.ctx.logger.warn('reolink setPortConfig push failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    // NTP / time-sync config (cmd_id 39 via setNtp). Push only when the
    // operator touched an `ntp*` key. `setNtp` reads-merges camera-side
    // (Reolink rejects partial `<Ntp>` blocks), so a partial patch is
    // safe. The `ntp*` keys are already persisted to the driver config
    // by `setAll` above; this adds the camera round-trip + a
    // `refreshParentSettingsSnapshot()` so the form re-hydrates.
    const ntpKeys: ReadonlyArray<keyof ReolinkCameraConfig> = [
      'ntpEnabled',
      'ntpServer',
      'ntpPort',
      'ntpInterval',
    ]
    if (ntpKeys.some((k) => k in patch)) {
      const ntpPatch: Parameters<ReolinkBaichuanApi['setNtp']>[0] = {}
      if (typeof typedPatch.ntpEnabled === 'boolean')
        ntpPatch.enable = typedPatch.ntpEnabled ? 1 : 0
      if (typeof typedPatch.ntpServer === 'string') ntpPatch.server = typedPatch.ntpServer
      if (typeof typedPatch.ntpPort === 'number') ntpPatch.port = typedPatch.ntpPort
      if (typeof typedPatch.ntpInterval === 'number')
        ntpPatch.synchronizeInterval = typedPatch.ntpInterval
      if (Object.keys(ntpPatch).length > 0) {
        try {
          const api = await this.ensureApi()
          await api.setNtp(ntpPatch)
        } catch (err) {
          this.ctx.logger.warn('reolink setNtp push failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    // Stream / encoder parameters are no longer applied here — the
    // hand-rolled Stream section was removed. The `stream-params` cap
    // (declares a `ui` block) is now the single UI + write path; its
    // `setProfile` calls `applyStreamProfilePatch` directly.

    // The privacy mask is NOT written here. It has one authority — the
    // `privacy-mask` cap, which writes `setMaskZones` and reads the camera —
    // and this form used to carry a second switch that wrote `setMask` and
    // read a config copy of our own. Two knobs for one thing on a camera,
    // disagreeing with the Reolink app (D544, and D62's surviving rule).

    // Audio noise reduction (cmdId=440 via setAudioNoise). Single
    // integer level: 0 = off; >0 = on with that level. The lib does
    // the off-path conversion when level <= 0.
    if ('audioNoiseLevel' in patch) {
      try {
        const api = await this.ensureApi()
        const v = typedPatch.audioNoiseLevel
        if (typeof v === 'number') {
          await api.setAudioNoise(this.getChannel(), v)
        }
      } catch (err) {
        this.ctx.logger.warn('audio-noise push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // Auto-focus (cmdId=225 via setAutoFocus). UI-friendly polarity
    // ("autoFocusEnabled" = AF on) — invert before push because the
    // camera-side field is named `disable`.
    if ('autoFocusEnabled' in patch) {
      try {
        const api = await this.ensureApi()
        const v = typedPatch.autoFocusEnabled
        if (typeof v === 'boolean') {
          await api.setAutoFocus(this.getChannel(), v ? 0 : 1)
        }
      } catch (err) {
        this.ctx.logger.warn('auto-focus push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    // PIR reduce-false-alarm (cmdId=213 via setPirInfo). The lib requires
    // `enable` in every `setPirInfo` payload, so we read the current PIR
    // enable + sensitivity (`getPirInfo`) first and carry them through —
    // a reduce-alarm-only edit must not disable PIR or reset sensitivity.
    if ('pirReduceFalseAlarm' in patch) {
      const v = typedPatch.pirReduceFalseAlarm
      if (typeof v === 'boolean') {
        try {
          const api = await this.ensureApi()
          const channel = this.getChannel()
          const cur = await api.getPirInfo(channel)
          // `getPirInfo` reports the current enable on `state.enable`;
          // fall back to the top-level `enabled` flag, then to 1
          // (reduce-alarm is meaningless with PIR off, so default on).
          const currentPirEnable =
            typeof cur.state?.enable === 'number' ? cur.state.enable : cur.enabled === false ? 0 : 1
          const pirPatch: Parameters<typeof api.setPirInfo>[1] = {
            enable: currentPirEnable,
            reduceAlarm: v ? 1 : 0,
          }
          if (typeof cur.state?.sensitive === 'number') pirPatch.sensitive = cur.state.sensitive
          if (typeof cur.state?.interval === 'number') pirPatch.interval = cur.state.interval
          await api.setPirInfo(channel, pirPatch)
        } catch (err) {
          this.ctx.logger.warn('pir reduce-alarm push failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    // Keyframe interval / GOP (cmdId=57 via setEnc). Main-stream only.
    // `setEnc` does a read-modify-write — patching only `mainStream.gop`
    // leaves resolution / bitrate / framerate / codec (owned by the
    // `stream-params` cap) untouched.
    if ('gop' in patch) {
      const v = typedPatch.gop
      if (typeof v === 'number') {
        try {
          const api = await this.ensureApi()
          await api.setEnc(this.getChannel(), { mainStream: { gop: v } })
        } catch (err) {
          this.ctx.logger.warn('gop (setEnc) push failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    // Auto-reboot schedule (cmdId=100 via setAutoReboot). Device-global
    // (no channel). `setAutoReboot` is a read-modify-write of the
    // `<AutoReboot>` block, so a partial patch is safe — touched fields
    // win, untouched ones (e.g. `second`) keep their camera-side value.
    const rebootKeys = [
      'autoRebootEnabled',
      'autoRebootWeekDay',
      'autoRebootHour',
      'autoRebootMinute',
    ] as const
    if (rebootKeys.some((k) => k in patch)) {
      const rebootPatch: Parameters<ReolinkBaichuanApi['setAutoReboot']>[0] = {}
      if (typeof typedPatch.autoRebootEnabled === 'boolean')
        rebootPatch.enable = typedPatch.autoRebootEnabled ? 1 : 0
      if (typedPatch.autoRebootWeekDay !== undefined)
        rebootPatch.weekDay = typedPatch.autoRebootWeekDay
      if (typeof typedPatch.autoRebootHour === 'number')
        rebootPatch.hour = typedPatch.autoRebootHour
      if (typeof typedPatch.autoRebootMinute === 'number')
        rebootPatch.minute = typedPatch.autoRebootMinute
      if (Object.keys(rebootPatch).length > 0) {
        try {
          const api = await this.ensureApi()
          await api.setAutoReboot(rebootPatch)
        } catch (err) {
          this.ctx.logger.warn('auto-reboot push failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    // Targeted re-read of ONLY the slices this patch changed, AWAITED so the
    // Settings form re-hydrates with the camera's authoritative values on the
    // UI's post-save refetch. Replaces the per-section fire-and-forget full
    // re-probe that raced the refetch (toggles like ONVIF snapped back until a
    // page reload).
    const changedSlices = slicesForPatch(patch)
    if (changedSlices.size > 0) {
      // Info, not debug: for camera-owned slices (osd) this re-read IS the
      // write's invalidation — if it drops, the form keeps serving the
      // pre-write snapshot and nothing else says so.
      await this.refreshParentSettingsSnapshot(changedSlices, 'post-write').catch(
        (err: unknown) => {
          this.ctx.logger.info('reolink targeted settings refresh failed — snapshots left stale', {
            tags: { deviceId: this.id },
            meta: {
              slices: [...changedSlices],
              error: err instanceof Error ? err.message : String(err),
            },
          })
        },
      )
      this.assertOsdWriteLanded(patch)
    }
  }

  /**
   * Compare what the operator asked for with what the camera now reports, and
   * REFUSE to call a lost write a success.
   *
   * Nothing used to do this, so an applied write and a write the camera never
   * took were indistinguishable — to the code and to the operator, who was
   * told `{success: true}` for a change the camera discarded (3825,
   * 2026-09-19). Throwing is the right shape: the admin UI's in-flight
   * overlay hands the operator their own edit back, marked unsaved, instead
   * of quietly reverting the field to the old value.
   *
   * Silence is the pass. A slice we could not re-read at all is already
   * reported by the caller as "snapshots left stale" — absence of a reading
   * is not evidence of a lost write, and must never be treated as one (D393).
   */
  private assertOsdWriteLanded(patch: Record<string, unknown>): void {
    const asked = patch.osdTimePosition
    if (typeof asked !== 'string') return
    // The snapshot stores the camera's raw 16.16 pair, not a corner — decode
    // it exactly as the form does, or a correct write compares unequal.
    const got = resolveOsdValues(this.config.get('deviceCache')?.osdSnapshot).osdTimePosition
    if (typeof got !== 'string' || got === asked) return
    throw new Error(
      `the camera did not take the timestamp position: asked "${asked}", it reports "${got}"`,
    )
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Optionally inject an already-logged-in Baichuan api — used by
   * `onCreateDevice` to reuse the api instance returned by
   * `autoDetectDeviceType` (Slice 15 socket reuse). Skips the next
   * connect cycle entirely.
   */
  adoptApi(api: ReolinkBaichuanApi): void {
    this.api = api
    this.reconnectAttempts = 0
    this.observeMotionSensors(api)
    api.client.on('close', () => this.scheduleReconnect('close'))
    api.client.on('error', (err) => {
      this.ctx.logger.warn('Baichuan client error — scheduling reconnect', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      this.scheduleReconnect('error')
    })
    // Slice 9: kick off sleep-status poll if this turns out to be a
    // battery cam (autodetect flagged the deviceType).
    const persistedDeviceType = this.config.get('deviceCache')?.deviceType
    if (persistedDeviceType === 'battery-cam') {
      this.isBattery = true
      api.setIdleDisconnect(true)
      this.startSleepPoll()
      this.startBatteryUpdatePolling()
      this.registerBatteryIfSupported()
      // Eager registration in the constructor seeds with an api-less
      // refresh (no-op). Now that we have a live api, populate the
      // cache so the badge moves off the conservative 0% fallback.
      // Post-login: the socket is up, so the camera is awake by construction
      // — this read costs no wake.
      void this.refreshBatteryFromApi('demand')
    } else {
      // Wired cam — drive aux device alignment on a 10s periodic
      // timer. Battery cams use the wake transition
      // path inside startSleepPoll instead.
      this.startAlignAuxPolling()
    }
    // Subscribe simple events so awake/sleeping/motion/AI flows work
    // even when we skipped the regular login path. `resubscribeSimpleEvents`
    // does an `offSimpleEvent` first so re-running adoptApi against
    // the same api instance doesn't accumulate listeners.
    void this.resubscribeSimpleEvents(api, 'adoptApi').catch((err: unknown) => {
      this.ctx.logger.debug('Reolink adoptApi: simple-event subscribe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    // Boxed native-AI detections (substream-backed) — gated on the cap
    // toggle + skipped for battery cams inside the helper.
    void this.resubscribeObjectDetections(api, 'adoptApi').catch((err: unknown) => {
      this.ctx.logger.debug('Reolink adoptApi: objectDetections subscribe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    // Slice 10: arm watchdogs after adopting an api too.
    this.startWatchdogs()
    this.startEventHealthCheck()
    // Run the abilities probe on the adopted api too — the socket-
    // reuse path otherwise skips it, leaving `hasPtz`/`hasIntercom`
    // unset (PTZ controls hidden in the UI). Stream availability is
    // resolved runtime by the `stream-catalog` pull, so we only re-run
    // the probe when the static abilities haven't been recorded yet.
    if (!this.config.get('deviceCache')?.probedAt) {
      void this.probeAndPersistFeatures(api).catch((err: unknown) => {
        this.ctx.logger.debug('Reolink feature probe (adoptApi) failed (non-fatal)', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    // Hardware metadata refresh lives in `onProbe` (kernel-driven
    // entry point). adoptApi runs out-of-band — when the provider
    // hands us the autodetect-time socket — and the kernel always
    // fires onProbe right after, so duplicating the populator here
    // would just churn the bus.
  }

  /**
   * Expose the lazy-login Baichuan API to accessory children. The
   * children share the parent's socket and credentials — there's no
   * separate auth flow per accessory. `ReolinkAccessory` calls this
   * inside its `applyOn` / `fetchOn` to reach the camera firmware.
   */
  /** Implements `ReolinkAccessoryHost.isBatteryCam` so spawned
   *  accessory children skip background polling on a sleeping
   *  battery cam (Baichuan polls on a sleeping camera return 400 +
   *  drain the battery). Reads from the runtime feature-probe slice
   *  populated during `onProbe()`; falls back to false when the probe
   *  hasn't completed yet. */
  isBatteryCam(): boolean {
    const fp = this.runtimeState.getCapState<{ flags?: Record<string, unknown> }>('feature-probe')
    return fp?.flags?.['hasBattery'] === true
  }

  /** Implements `ReolinkAccessoryHost.isSleeping`. Reads the canonical
   *  source of truth — the `battery.sleeping` runtime-state slice — so
   *  hub-children (whose simpleEvents are routed in by the Hub) and
   *  top-level battery cams (whose own subscription / sleep poll write
   *  the slice) share one signal. Always returns `false` for non-
   *  battery cams (`this.sleeping` getter falls back to `false` when
   *  the slice is absent). */
  isSleeping(): boolean {
    return this.sleeping
  }

  async ensureApi(): Promise<ReolinkBaichuanApi> {
    // Hub-child fast path — never log in independently. The parent
    // Hub keeps a single long-lived Baichuan socket per device; we
    // borrow its api and inherit credentials, channel routing
    // (`this.getChannel()`), and event subscription (the Hub
    // dispatches simpleEvents into our `handleSimpleEvent` directly,
    // see `ReolinkHub.routeSimpleEvent`). Skipping login means
    // battery cams under a Hub never get woken by an "online" check
    // — exactly the behavior the user asked for.
    if (this.isHubChild()) {
      const parent = await this.getParentHub()
      if (!parent) {
        throw new Error(
          `ReolinkCamera ${this.id}: parent Hub ${this.parentDeviceId} not registered yet`,
        )
      }
      return parent.getApi()
    }

    if (this.api) return this.api
    if (this.loginPromise) return this.loginPromise

    // Diagnostic: a login on a sleeping battery cam IS a wake, so every
    // one of them must be attributable to a caller that is allowed to
    // wake it: a stream, an operator action, an intercom, or a snapshot
    // the operator FORCED (`snapshot-wake-gate.ts`). Anything else is a
    // leak — the 2026-09-15 sentry login was one — and
    // an INFO line without a caller is unactionable — capture a few
    // frames so the next occurrence names it. Library builds are not
    // minified (`vite-lib.preset.ts`), so the frames are readable.
    if (this.isBattery && this.sleeping) {
      // Frames go in the MESSAGE, not in `meta`: several operator log
      // views render only the message, and an attribution log whose
      // attribution is invisible is worse than none — it says a wake
      // happened without saying who caused it.
      const frames =
        new Error('wake-attribution').stack
          ?.split('\n')
          .slice(2, 7)
          .map((l) => l.trim())
          .join(' <- ') ?? 'stack unavailable'
      this.ctx.logger.info(
        `battery cam login while sleeping — this wakes the camera. caller: ${frames}`,
        { tags: { deviceId: this.id } },
      )
    }

    const host = this.config.get('host')
    const port = this.config.get('port')
    const username = this.config.get('username')
    const password = this.config.get('password')
    const transport = this.config.get('transport')
    const uid = this.config.get('uid')
    const udpDiscoveryMethod = this.config.get('udpDiscoveryMethod')

    this.ctx.logger.info('Connecting to Reolink', {
      tags: { deviceId: this.id, host: String(host) },
      meta: { port, transport, hasUid: Boolean(uid) },
    })

    const debugOptions = this.getBaichuanDebugOptions()

    // The dial detail that is NOT worth a line at rest: which discovery
    // method, whether a UID path is in play, how many times this camera has
    // already reconnected. Never a credential — `hasUid` and never `uid`.
    if (CH_HANDSHAKE.on && CH_HANDSHAKE.wants(this.id)) {
      CH_HANDSHAKE.log(this.ctx.logger, 'baichuan dial', {
        tags: { deviceId: this.id },
        meta: {
          host: String(host),
          port,
          transport,
          hasUid: Boolean(uid),
          udpDiscoveryMethod: udpDiscoveryMethod ?? null,
          reconnectAttempts: this.reconnectAttempts,
          debugOptions: debugOptions === undefined ? null : Object.keys(debugOptions),
        },
      })
    }

    this.loginPromise = (async () => {
      const api = new ReolinkBaichuanApi({
        host,
        port,
        username,
        password,
        transport,
        ...(uid ? { uid } : {}),
        ...(udpDiscoveryMethod ? { udpDiscoveryMethod } : {}),
        ...(debugOptions ? { debugOptions } : {}),
        // Wire our scoped logger as the lib's `Console` sink. Without
        // this, the main control-channel client's protocol traces
        // (`[BaichuanClient] tx/rx`, `udp_keepalive_*`, sleep
        // inference ticks) fall through to the lib's default sink and
        // bypass our deviceId/addonId tagging — making it impossible
        // to correlate the wake/sleep flap events with what was on
        // the wire.
        logger: this.libLoggerAdapter(),
      })
      try {
        await api.login()
      } catch (err) {
        this.loginPromise = null
        // An answer (bad credentials, a refused command) proves the camera is
        // there; only a network-level failure counts toward offline (D904).
        if (isConnectivityFailure(err)) {
          this.noteUnreachable(err instanceof Error ? err.message : String(err))
        } else if (this.ownsReachability()) {
          this.reachability.noteReachable()
        }
        throw err
      }
      this.api = api
      this.loginPromise = null
      this.reconnectAttempts = 0
      if (this.ownsReachability()) this.reachability.noteReachable()

      // Battery probe — autodetect already flagged battery cams at
      // creation time (Slice 15 features.deviceType==='battery-cam').
      // Honour the persisted flag first; only fall back to the live
      // probe when features hasn't been populated yet (older devices
      // created before Slice 15).
      const persistedDeviceType = this.config.get('deviceCache')?.deviceType
      if (persistedDeviceType === 'battery-cam') {
        this.isBattery = true
        api.setIdleDisconnect(true)
        this.ctx.logger.info(
          'Reolink camera flagged as battery (from autodetect) — idle disconnect enabled',
          {
            tags: { deviceId: this.id },
          },
        )
      } else if (persistedDeviceType === undefined) {
        try {
          await api.getBatteryInfo(0)
          this.isBattery = true
          api.setIdleDisconnect(true)
          this.ctx.logger.info(
            'Reolink camera flagged as battery (live probe) — idle disconnect enabled',
            {
              tags: { deviceId: this.id },
            },
          )
          // Battery flag changed → re-derive `this.features`. The broker
          // picks up the new BatteryOperated entry on its next
          // `stream-catalog` pull / reconcile — no push needed.
        } catch {
          this.isBattery = false
        }
      } else {
        this.isBattery = false
      }

      // Slice 9: start the periodic sleep-status poll for battery cams
      // so we catch missed sleeping/awake transitions from push events.
      if (this.isBattery) {
        this.startSleepPoll()
        this.startBatteryUpdatePolling()
        // Slice 13: register the battery cap so the snapshot wrapper
        // can consult sleep state without waking the camera.
        this.registerBatteryIfSupported()
        // Refresh the cache post-login. When the cap was already
        // registered eagerly at construction (battery-cam in
        // deviceCache), the seed inside `registerBatteryIfSupported`
        // ran without an api and was a no-op — without this explicit
        // refresh the badge would keep serving the conservative
        // fallback (0%) until the first push event arrives.
        // Post-login — awake by construction, no wake cost.
        void this.refreshBatteryFromApi('demand')
      }

      // Slice 10: arm reliability watchdogs (ping + event freshness).
      this.startWatchdogs()

      // Abilities + channel count probe (Slice 4). Persisted into config
      // so the UI / later slices can consult device capabilities without
      // forcing a fresh round-trip to the camera.
      void this.probeAndPersistFeatures(api).catch((err: unknown) => {
        this.ctx.logger.debug('Reolink feature probe failed (non-fatal)', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      // Hardware metadata refresh lives in `onProbe` — the kernel
      // calls onProbe right after construction (and after each addon
      // restart), and onProbe re-enters here via ensureApi. Putting
      // the populator there keeps a single refresh per probe cycle.

      this.observeMotionSensors(api)
      // Reconnect on socket loss / D2C disconnect.
      api.client.on('close', () => this.scheduleReconnect('close'))
      api.client.on('error', (err) => {
        this.ctx.logger.warn('Baichuan client error — scheduling reconnect', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        this.scheduleReconnect('error')
      })

      // Hardware motion / AI / lifecycle events (Slice 6). Routes
      // through `resubscribeSimpleEvents` so the bound handler ref
      // is reused across watchdog re-arms — see the field comment
      // for the listener-accumulation regression this prevents.
      void this.resubscribeSimpleEvents(api, 'login').catch((err: unknown) => {
        this.ctx.logger.debug('Baichuan onSimpleEvent subscribe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      // Boxed native-AI detections (substream-backed) — gated on the cap
      // toggle + skipped for battery cams inside the helper.
      void this.resubscribeObjectDetections(api, 'login').catch((err: unknown) => {
        this.ctx.logger.debug('Baichuan onObjectDetections subscribe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      this.startEventHealthCheck()

      return api
    })()

    return this.loginPromise
  }

  /**
   * Bridge Reolink hardware events to the camstack event bus:
   * online and sleeping are TWO ORTHOGONAL
   * axes, each driven exclusively by their own firmware push events.
   *
   * - 'motion' + AI types (people, vehicle, animal, face, package):
   *   emit the RAW push as `EventCategory.ProviderMotion`
   *   (`source: 'onboard'`, D673). The orchestrator's camera-sensors bridge
   *   re-emits it as the effective `MotionOnMotionChanged`, and the
   *   orchestrator is the only writer of the camera's `motion` runtime-state
   *   slice (D696; no slice write here). AI subtype also lands on
   *   `EventCategory.DetectionCameraNative`.
   * - 'awake' / 'sleeping': emit DeviceAwake / DeviceSleeping. Battery
   *   power-state only — does NOT touch online state.
   * - 'online' / 'offline': emit DeviceOnline / DeviceOffline + flip
   *   `this.online`, and reset the reachability verdict. The only OTHER
   *   source is sustained unreachability on a mains camera (D904,
   *   `onReachabilityOffline`): a single socket close, a reconnect or an
   *   RFC4571 idle teardown still leaves online state alone.
   * - 'battery': refresh cache, emit cap event.
   * - 'doorbell', 'daynight', 'other': informational debug log only.
   */
  /** Reusable event-source identity for every emit on this device. */
  private eventSource(): { type: 'device'; id: number; addonId: string; deviceId: number } {
    return { type: 'device', id: this.id, addonId: REOLINK_ADDON_ID, deviceId: this.id }
  }

  /**
   * Build the `DebugOptions` blob forwarded to `ReolinkBaichuanApi`'s
   * constructor. Returns `undefined` when no flags are set
   * so the lib falls back to its own defaults instead of an empty
   * object override.
   */
  private getBaichuanDebugOptions(): Record<string, boolean> | undefined {
    // Two arming paths, ORed, answering different questions: the per-camera
    // SETTING is durable and operator-owned, the `provider-reolink.baichuan`
    // CHANNEL is a window with a deadline armed from `/system/logs`. Neither
    // can switch the other off, so this is a hierarchy and not a second
    // authority. `CH_BAICHUAN.on` is a plain boolean field — disarmed it costs
    // one load and a branch, and `wants()` is never reached.
    const general =
      this.config.get('debugGeneral') === true || (CH_BAICHUAN.on && CH_BAICHUAN.wants(this.id))
    const socketFlags = (this.config.get('debugSocketLogs') ??
      []) as readonly ReolinkSocketDebugFlag[]
    const opts: Record<string, boolean> = {}
    if (general) opts.general = true
    for (const flag of socketFlags) opts[flag] = true
    return Object.keys(opts).length > 0 ? opts : undefined
  }

  /**
   * Public entry point for simpleEvent dispatch. Used both by the
   * camera's own subscription (`handleSimpleEventBound`) when the
   * camera holds its own Baichuan socket AND by `ReolinkHub.routeSimpleEvent`
   * when the camera lives under a Hub and inherits the parent's
   * single subscription.
   */
  handleSimpleEvent(
    event: import('@apocaliss92/nodelink-js').ReolinkSimpleEvent,
    routedMotionSensor: ReolinkMotionSensor | null = null,
  ): void {
    // Slice 10: stamp the watchdog so it knows the subscription is live.
    this.lastEventAt = Date.now()
    // MD vs PIR — taken first, so this push consumes the raw notification it
    // came from even when a later branch drops it. `null` = not reported
    // (email / webhook pushes, or a lib that never decoded it).
    const motionSensor =
      event.type === 'motion'
        ? (motionSensorOnSimpleEvent(event) ??
          routedMotionSensor ??
          this.motionSensors.take(event.channel))
        : null
    // Reset the health-check stale streak so the next quiet window
    // logs `info` again instead of staying on `debug` forever.
    this.consecutiveStaleHealthChecks = 0
    this.nextEventHealthCheckAt = 0
    // An inbound push is proof of reachability that cost us nothing — the one
    // kind of proof a battery camera is allowed to give (D173). Every event
    // type counts: motion, AI, battery, awake/sleeping. This is what makes a
    // 30-hour silence a positive observation rather than an assumption.
    this.markPassiveContact()
    const eventSource = this.eventSource()

    // Sleep-push exclusivity: email and HaCfg webhook must not both fire
    // into this handler for the same wake. Native baichuan (or omitted
    // source) always passes. Preference lives on the device config.
    const preference = this.config.get('batterySleepPushMethod') ?? 'auto'
    if (
      !shouldAcceptSleepPushSource(
        event.source,
        preference,
        this.baichuanWebhookSupportedCached === true,
      )
    ) {
      if (event.type !== 'battery') {
        this.ctx.logger.info('Reolink simpleEvent dropped by sleep-push preference', {
          meta: {
            type: event.type,
            source: event.source,
            preference,
            webhookSupported: this.baichuanWebhookSupportedCached === true,
          },
        })
      }
      return
    }

    // Trace every Baichuan simple-event we receive — operator
    // diagnostics for the motion / AI / lifecycle pipeline. Logged
    // at info level (low volume — bounded by the camera's push
    // cadence, not by frame rate) so it surfaces in the Logs tab
    // without enabling debug. Excludes only the high-frequency
    // `battery` push, which already has dedicated dedup +
    // periodic emit elsewhere; keeping it here would double-log.
    //
    // `this.ctx.logger` is the per-device logger built by
    // device-cap-proxy.ts:317 — already scoped to this device's
    // stableId with `deviceId` baked into its tags. No need to
    // re-tag it here.
    if (event.type !== 'battery') {
      this.ctx.logger.info('Reolink simpleEvent received', {
        meta: {
          type: event.type,
          channel: event.channel,
          timestamp: event.timestamp,
          source: event.source,
          ...(event.type === 'motion' ? { motionSensor } : {}),
        },
      })
    }

    // Bare motion. Single unified output:
    //
    //  - `ProviderMotion` event — the RAW push, `source: 'onboard'` (D673).
    //    The orchestrator's camera-sensors bridge re-emits it as
    //    `MotionOnMotionChanged` (verbatim for a camera with no attached
    //    sensor); the runner's phase machine subscribes to that, and the
    //    orchestrator writes the camera's `motion` runtime-state slice with
    //    the effective value (D696). Providers emit raw and write no slice.
    if (event.type === 'motion') {
      const now = Date.now()
      this.ctx.eventBus.emit(
        providerMotionEvent(eventSource, {
          deviceId: this.id,
          detected: true,
          timestamp: now,
          source: 'onboard',
        }),
      )
      // …and tell the BROKER, which is a different question from the phase
      // machine's: this one may wake a sleeping stream for a sentry
      // consumer. Fire-and-forget — a wake that fails must never hold up a
      // motion event, and the broker answers with what it did.
      void this.reportWakeSignal('motion')
      return
    }

    // AI-classified events → detection.camera-native with structured shape.
    // This is the canonical channel for hardware-AI pushes (people / vehicle
    // / animal / face / package). Motion is handled separately above; we
    // ALSO mirror an onboard motion tick on the unified event channel so
    // the runner's phase machine treats AI pushes as motion.
    const aiClass = AI_CLASS_MAP[event.type]
    if (aiClass !== undefined) {
      const now = Date.now()

      // Keep the `lastByClass` slice live regardless of whether forwarding
      // is enabled — the status surface always shows the last-seen instant.
      // We don't await: this is a fire-and-forget hot-path write; errors
      // are logged by the kernel runtimeState layer.
      if (isNativeObjectClass(aiClass)) {
        void this.runtimeState.patchCapState('native-object-detection', {
          lastByClass: {
            [aiClass]: { class: aiClass, timestamp: now, confidence: undefined },
          },
        })
      }

      // Gate DetectionCameraNative on the operator toggle.
      // Default-OFF when unset (opt-in): only forward onboard AI detections once
      // the operator has explicitly enabled them for this device.
      const detectionEnabled = isNativeObjectForwardingEnabled(
        this.runtimeState.getCapState<NativeObjectDetectionRuntimeState>('native-object-detection'),
      )

      if (detectionEnabled) {
        void this.reportWakeSignal('detection')
        this.ctx.eventBus.emit(
          createEvent(EventCategory.DetectionCameraNative, eventSource, {
            cameraId: this.id,
            source: 'onboard',
            detections: [{ class: aiClass, timestamp: now }],
          }),
        )
      } else {
        // A branch that DROPS work says so. Without this line the suppression
        // is indistinguishable from a camera that pushed nothing, which is how
        // three cameras sat with the toggle off for weeks and the only symptom
        // was "the onboard detections do nothing". Rate-limited per class, not
        // per push: the vocabulary is five values and the point is that the
        // class WAS pushed, not how often.
        this.noteNativeDetectionSuppressed(aiClass)
      }

      // The raw motion push is UNGATED here — whether the camera's own motion
      // counts is the camera-sensors bridge's decision (D673), not this
      // provider's. Suppressing DetectionCameraNative must never kill the
      // motion heartbeat.
      this.ctx.eventBus.emit(
        providerMotionEvent(eventSource, {
          deviceId: this.id,
          detected: true,
          timestamp: now,
          source: 'onboard',
        }),
      )
      return
    }

    // Power-state transitions (battery cams). DeviceAwake / DeviceSleeping
    // are the canonical events for power state — orthogonal to
    // DeviceOnline / DeviceOffline (firmware liveness, handled above).
    // BatteryBadge listens to DeviceAwake/Sleeping; connectivity
    // indicators listen to DeviceOnline/Offline.
    if (event.type === 'awake') {
      const wasSleeping = this.sleeping
      // Hysteresis: the lib runs an internal UDP "sleep inference"
      // every 2s that emits awake/sleeping events based on socket
      // I/O patterns, not actual camera firmware state. With idle
      // disconnect enabled (battery cams) the inference flaps every
      // ~12s during steady-state idle. Suppress flips that land
      // inside the hysteresis window so we don't churn UI / cache /
      // active-stream teardowns over an inferred state.
      // Battery slice exists ONLY when registerBatteryIfSupported ran.
      // simpleEvents can fire BEFORE that (e.g. initial 'awake' burst on
      // Hub login arriving for non-battery children, or pre-flight events
      // on a regular cam) — `commitSleepState` guards on `isBattery` so we
      // never trip the runtime-state validator with "no schema registered
      // for cap 'battery'".
      {
        const committed = this.commitSleepState(false, 'simple-event')
        if (committed && wasSleeping) {
          this.ctx.logger.info('Reolink camera woke up', { tags: { deviceId: this.id } })
          this.ctx.eventBus.emit(
            createEvent(EventCategory.DeviceAwake, eventSource, {
              deviceId: this.id,
              providerId: REOLINK_ADDON_ID,
              reason: 'awake',
            }),
          )
          // The broker re-pulls the `stream-catalog` cap once the camera
          // is awake (its reconcile / device-event poll picks up the
          // now-non-empty catalog) — no push from the wake path needed.
          // Wake-transition refresh: now that the camera is up,
          // re-read aux accessory state (siren / floodlight / PIR)
          // and the parent settings snapshot (image / motion / AI /
          // enc / mask / audioNoise / autoFocus). Both are
          // read-only Baichuan calls on an already-awake socket —
          // they don't re-wake the cam. The wake branch runs
          // `alignAuxDevicesState()` + battery/snapshot
          // on the same transition.
          // NOTE: `getBatteryInfo` is intentionally NOT called here.
          // The camera's own `battery` simpleEvent push arrives
          // shortly after wake on Argus firmware; the cache refresh
          // happens without us polling.
          void this.onWakeTransition('simple-event').catch(() => {
            /* best-effort */
          })
        }
      }
      return
    }

    // Firmware connectivity transitions. A push is the camera's own word, so it
    // wins at once and resets the reachability verdict (D904). The OTHER source
    // of DeviceOffline is sustained unreachability on a mains camera — a camera
    // that lost power sends no push (`onReachabilityOffline`). A single socket
    // close, an RFC4571 idle teardown or one failed reconnect never flips it.
    if (event.type === 'online' || event.type === 'offline') {
      const next = event.type === 'online'
      this.reachability.reset()
      if (next !== this.online) {
        this.markOnline(next)
        this.ctx.eventBus.emit(
          createEvent(
            next ? EventCategory.DeviceOnline : EventCategory.DeviceOffline,
            eventSource,
            next
              ? {
                  deviceId: this.id,
                  providerId: REOLINK_ADDON_ID,
                  profileCount: 0,
                  reason: 'firmware-push',
                }
              : { deviceId: this.id, providerId: REOLINK_ADDON_ID, reason: 'firmware-push' },
          ),
        )
      }
      return
    }

    if (event.type === 'sleeping') {
      const wasSleeping = this.sleeping
      // Everything below is gated on an ACCEPTED transition (as before —
      // the gate used to be `acceptSleepingTransition`, now folded into
      // `commitSleepState`). A repeated / rejected `sleeping` push must
      // not re-run the stream teardown, and a non-battery camera (which
      // has no sleep state at all) must not have its streams closed by a
      // stray firmware push.
      {
        const committed = this.commitSleepState(true, 'simple-event')
        if (!committed) return
        if (!wasSleeping) {
          this.ctx.eventBus.emit(
            createEvent(EventCategory.DeviceSleeping, eventSource, {
              deviceId: this.id,
              providerId: REOLINK_ADDON_ID,
              reason: 'sleeping',
            }),
          )
        }
        // Only escalate to info + active-stream teardown when the
        // camera was actually serving streams. With zero active
        // streams the "going to sleep" transition has no operational
        // impact — log at debug to keep the channel quiet during
        // idle-state lib inference flaps.
        if (this.active.size > 0) {
          this.ctx.logger.info('Reolink camera went to sleep — closing active streams', {
            tags: { deviceId: this.id },
            meta: { activeStreams: this.active.size },
          })
          // Close every BaichuanVideoStream so the broker doesn't
          // keep pushing into a dead session and so we release sockets
          // cleanly. Do NOT close the api itself — we still want
          // awake events.
          void this.closeActiveStreams('sleeping').catch(() => {
            /* best-effort */
          })
        } else {
          this.ctx.logger.debug('Reolink camera sleep transition (no active streams)', {
            tags: { deviceId: this.id },
          })
        }
        // `this.state.battery.sleeping = true` already updated the slice;
        // the `subscribeCap('battery')` bridge above re-emits
        // `BatteryOnStatusChanged` so the BatteryBadge picks the
        // moon icon up the moment the cam actually went down.
      }
      return
    }

    // Slice 13: battery push → refresh cache + emit cap event so the
    // snapshot wrapper's sleep gate sees fresh data without polling.
    if (event.type === 'battery' && event.battery) {
      this.updateBatteryCache(event.battery as import('@apocaliss92/nodelink-js').BatteryInfo)
      return
    }

    // Doorbell ring — bridge to the doorbell cap + EventCategory so
    // toasts/alerts react without polling.
    if (event.type === 'doorbell') {
      this.emitDoorbellPressed(Date.now())
      return
    }

    // daynight, other — log only; consumers can subscribe to
    // provider-reolink-specific events later if needed.
    this.ctx.logger.debug('Reolink simple-event (informational)', {
      tags: { deviceId: this.id },
      meta: {
        type: event.type,
        channel: event.channel,
        ...(event.battery ? { battery: event.battery } : {}),
      },
    })
  }

  /**
   * Probe device abilities + channel count and persist into the camera
   * config. Best-effort — unsupported camera firmwares may return
   * partial data; we record what we can and skip the rest.
   *
   * Writes the result into the `feature-probe` runtime-state slice
   * (the canonical store for hasPtz/hasIntercom/etc) and persists
   * channelCount + deviceType in the config blob (so the camera
   * lifecycle has them before next-boot rehydrate completes).
   *
   * Called by the kernel via `onProbe()` once after register, and by
   * `reprobe()` on demand.
   */
  private async probeAndPersistFeatures(api: ReolinkBaichuanApi): Promise<void> {
    let channelCount: number | undefined
    let hasPtz: boolean | undefined
    let hasIntercom: boolean | undefined
    let hasDoorbell: boolean | undefined
    let hasFloodlight: boolean | undefined
    let hasSiren: boolean | undefined
    let hasBattery: boolean | undefined
    let hasPirSensor: boolean | undefined
    let hasAutotrack: boolean | undefined
    let capabilitiesRead = false

    try {
      channelCount = await api.getChannelCount()
    } catch {
      /* ignore */
    }

    // Use the lib's pre-parsed `getDeviceCapabilities()` for every
    // hasX flag. The lib handles the firmware-specific quirks
    // (ptzMode='none' overriding individual ability flags, supportItem
    // vs ability-table differences, dingDong vs doorbellVersion vs
    // doorbell, lightType >= 2 for floodlight, etc).
    try {
      const { capabilities } = await api.getDeviceCapabilities(this.getChannel())
      hasPtz = capabilities.hasPtz
      hasIntercom = capabilities.hasIntercom
      hasDoorbell = capabilities.isDoorbell
      hasFloodlight = capabilities.hasFloodlight
      hasSiren = capabilities.hasSiren
      hasBattery = capabilities.hasBattery
      hasPirSensor = capabilities.hasPir
      hasAutotrack = capabilities.hasAutotracking
      capabilitiesRead = true
    } catch (err) {
      this.ctx.logger.debug('getDeviceCapabilities failed — leaving flags unset', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Only persist when the round-trip actually returned data.
    // Failures (transient login race / partial firmware response /
    // sleeping cam) leave every local `undefined`; persisting in that
    // case would mark `lastProbedAt` and trick downstream consumers
    // into thinking the probe completed.
    const probeReturnedData =
      hasPtz !== undefined ||
      hasIntercom !== undefined ||
      hasDoorbell !== undefined ||
      hasFloodlight !== undefined ||
      hasSiren !== undefined ||
      hasBattery !== undefined ||
      hasPirSensor !== undefined ||
      hasAutotrack !== undefined ||
      channelCount !== undefined

    if (!probeReturnedData) {
      this.ctx.logger.debug('Reolink features probe carried no data — slice unchanged', {
        tags: { deviceId: this.id },
      })
      return
    }

    // Preserve previously-known flags when this probe didn't reach a
    // particular field. The feature-probe slice is the live store; the
    // flags are ALSO persisted into `deviceCache` below, because the slice
    // does not survive a provider restart for a camera that is asleep at
    // boot (see `withPersistedProbe`).
    const prev = this.runtimeState.getCapState<FeatureProbeStatus>('feature-probe')
    const prevFlags = (prev?.flags ?? {}) as ReolinkProbeFlags
    const persistedDeviceType = this.config.get('deviceCache')?.deviceType
    const inferredDeviceType: string | null =
      persistedDeviceType ?? (this.isBattery ? 'battery-cam' : null)
    const persistedModel = this.config.get('deviceCache')?.model ?? null

    const flags: ReolinkProbeFlags = {
      ...prevFlags,
      // Battery is STICKY-TRUE. Any of the three sources saying "battery"
      // wins: the lib's ability probe, a previously-recorded flag, or
      // `this.isBattery` (standalone autodetect `deviceType==='battery-cam'`
      // / the NVR's `GetChannelstatus` `hasBattery` for hub children).
      // A probe that answers `hasBattery: false` must NOT clear it: the
      // ability table read through an NVR (or against a half-awake camera)
      // routinely omits the battery leaf, and losing the flag drops
      // `DeviceFeature.BatteryOperated` — which in turn hides the battery
      // badge AND disables the snapshot wrapper's sleep gate, so the
      // camera starts getting woken for thumbnails. Un-flagging a device
      // that really isn't battery-powered is a re-adoption, not a probe.
      hasBattery: hasBattery === true || prevFlags.hasBattery === true || this.isBattery,
      ...(hasPtz !== undefined ? { hasPtz } : {}),
      ...(hasIntercom !== undefined ? { hasIntercom } : {}),
      ...(hasDoorbell !== undefined ? { hasDoorbell } : {}),
      ...(hasFloodlight !== undefined ? { hasFloodlight } : {}),
      ...(hasSiren !== undefined ? { hasSiren } : {}),
      ...(hasPirSensor !== undefined ? { hasPirSensor } : {}),
      ...(hasAutotrack !== undefined ? { hasAutotrack } : {}),
    }

    const now = Date.now()
    const next: FeatureProbeStatus = {
      flags: flags as Record<string, unknown>,
      deviceType: inferredDeviceType,
      model: persistedModel,
      channelCount: channelCount ?? prev?.channelCount ?? null,
      lastProbedAt: now,
      lastFetchedAt: now,
    }
    this.runtimeState.setCapState('feature-probe', next)

    // Persist channelCount + deviceType in the config blob too — they
    // drive the camera lifecycle (channel routing, battery sleep
    // handling) BEFORE the runtime-state slice rehydrates on next boot.
    //
    // When the ability table was actually read, also persist the flags +
    // a `probedAt` stamp. A battery camera asleep at boot skips `onProbe`
    // and comes back with an empty `feature-probe` slice; without these,
    // `getAccessoryChildren()` returned nothing and its Siren / Floodlight
    // / PIR children did not exist until the camera woke up on its own.
    // A probe that only reached `getChannelCount` does not stamp — that
    // would claim a completed probe with no ability flags behind it.
    try {
      const previous = this.config.get('deviceCache') ?? {}
      const identity = {
        ...previous,
        ...(inferredDeviceType ? { deviceType: inferredDeviceType } : {}),
        ...(channelCount !== undefined ? { channelCount } : {}),
      }
      await this.config.setAll({
        deviceCache: capabilitiesRead ? withPersistedProbe(identity, flags, now) : identity,
      })
    } catch (err) {
      this.ctx.logger.debug('deviceCache identity persist failed (non-fatal)', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    // Now that features are known, register optional caps retroactively.
    // CRITICAL: each of these is probe-gated — the synchronous pass in the
    // constructor (`registerNativeCapabilities`) runs BEFORE the feature-probe
    // slice is populated, so probe-gated caps are no-ops there and MUST be
    // re-registered here once the flags are known. Every helper is idempotent
    // (guards on its own `*Registered` flag), so a warm-rehydrate boot that
    // already registered in the constructor pass just no-ops here.
    this.registerPtzIfSupported()
    this.registerPtzAutotrackIfSupported()
    this.registerDoorbellIfSupported()
    // Intercom was previously omitted here, so on a fresh boot (empty probe
    // slice at construction) the `intercom` cap never got registered. The cap
    // router then found no provider when the UI called `startSession`, the
    // call failed at the routing layer before any talk-session code ran (zero
    // intercom logs), and the two-way-audio panel closed immediately.
    this.registerIntercomIfSupported()

    // NOTE: hardware metadata refresh is NOT gated on the feature
    // probe — `adoptApi` / `ensureApi` already trigger it on every
    // post-login transition so a firmware update or a hardware swap
    // is reflected on the next addon restart even when `probedAt`
    // is set (which short-circuits this method).

    this.ctx.logger.info('Reolink features probed + persisted', {
      tags: { deviceId: this.id },
      meta: { flags, channelCount, deviceType: inferredDeviceType },
    })
  }

  /**
   * Pull `getInfo` and patch the device-meta `metadata` blob with the
   * resolved manufacturer / model / firmware / hardware / serial / uid.
   * Idempotent — `setMetadata` shallow-merges and emits a change event
   * only when at least one field flipped, so re-running the probe on
   * every reconnect doesn't churn the bus.
   */
  private async populateMetadataFromFirmware(api: ReolinkBaichuanApi): Promise<void> {
    const cfgUid = this.config.get('uid')
    // Top-level cameras are themselves the host — pass `undefined` so
    // the populator hits cmd 80 (host getInfo) + cmd 76 host. For
    // hub-adopted children, route via their channel index so
    // `getInfo cmd 318(ch=N)` returns the per-channel identity rather
    // than the hub's host data.
    const channel = this.parentDeviceId !== null ? this.getChannel() : undefined
    await populateReolinkMetadata(api, channel, {
      id: this.id,
      ctx: this.ctx,
      uid: typeof cfgUid === 'string' && cfgUid.length > 0 ? cfgUid : undefined,
      setDeviceCachePatch: async (cachePatch) => {
        const previous = this.config.get('deviceCache') ?? {}
        await this.config.setAll({ deviceCache: { ...previous, ...cachePatch } })
      },
    })
  }

  /**
   * Tear down the current API and schedule a reconnect with exponential
   * backoff. Active streams are cleared — when the broker re-issues
   * demand events on next consumer activity, ensureApi() reconnects
   * lazily and the demand path re-arms BaichuanVideoStream instances.
   *
   * **Battery-camera path**: when the camera is sleeping (or already
   * believed to be sleeping), a `close`/`error` from the Baichuan
   * client is the EXPECTED steady state — the lib disconnects the
   * idle UDP socket on its own, the camera is asleep, and there is
   * nothing to reconnect to. Aggressively reconnecting in that state
   * is what was waking up the doorbell every ~60 s in production
   * logs. Drop the api reference, but DO NOT schedule a reconnect timer. The next
   * `awake` push (or a snapshot demand from the operator) will
   * lazily call `ensureApi()` and re-establish the client.
   */
  /**
   * Close and forget the cached control-channel client so the NEXT
   * `ensureApi()` performs a fresh login.
   *
   * The one thing `scheduleReconnect` cannot express: an EXPIRED session on a
   * socket that is still open. No `close`/`error` ever fires, so the reconnect
   * ladder is never armed, and `ensureApi`'s `if (this.api) return this.api`
   * keeps handing back a client whose every request answers `responseCode
   * 400`. Callers that see an application-level rejection they believe is a
   * dead session call this and retry ONCE — they must never loop on it.
   *
   * Same teardown the `disconnectAll` / debug-options paths use: `close()`
   * best-effort, then null the field. Active RFC 4571 servers are untouched —
   * each owns a dedicated socket and survives a control-channel reset (see
   * `scheduleReconnect`).
   */
  private async dropBaichuanSession(reason: string): Promise<void> {
    const current = this.api
    this.api = null
    if (!current) return
    try {
      await current.close({ reason })
    } catch {
      /* best-effort — the point is that the NEXT ensureApi logs in fresh */
    }
  }

  /** D904 applies to a mains camera that dials its own socket — not a battery cam, not a hub child. */
  private ownsReachability(): boolean {
    return !this.isBattery && !this.isHubChild()
  }

  /** The camera could not be reached: open (or extend) the reachability window. */
  private noteUnreachable(reason: string): void {
    if (!this.ownsReachability()) return
    this.reachability.noteFailure(reason)
  }

  /**
   * One fresh login, for the tracker's confirmation and recovery probes. A
   * battery cam or hub child is never probed (D173) and answers `reachable`,
   * which closes the window instead of calling it offline.
   */
  private async probeReachability(): Promise<ReachabilityProbeResult> {
    if (!this.ownsReachability()) return 'reachable'
    try {
      await this.ensureApi()
      return 'reachable'
    } catch (err) {
      return isConnectivityFailure(err) ? 'unreachable' : 'reachable'
    }
  }

  /** Sustained unreachability, confirmed: the normal DeviceOffline, once. */
  private onReachabilityOffline(info: ReachabilityOfflineInfo): void {
    if (!this.online) {
      this.ctx.logger.info('Reolink camera unreachable, already offline — nothing to emit', {
        tags: { deviceId: this.id },
        meta: { ...info },
      })
      return
    }
    this.ctx.logger.warn('Reolink camera unreachable for the whole window — marked offline', {
      tags: { deviceId: this.id },
      meta: { ...info, unreachableForMs: Date.now() - info.since },
    })
    this.markOnline(false)
    this.ctx.eventBus.emit(
      createEvent(EventCategory.DeviceOffline, this.eventSource(), {
        deviceId: this.id,
        providerId: REOLINK_ADDON_ID,
        reason: 'unreachable',
      }),
    )
  }

  /** The first success after a reachability outage: the normal DeviceOnline, once. */
  private onReachabilityOnline(info: ReachabilityOnlineInfo): void {
    if (this.online) return
    this.ctx.logger.info('Reolink camera reachable again — marked online', {
      tags: { deviceId: this.id },
      meta: { ...info },
    })
    this.markOnline(true)
    this.ctx.eventBus.emit(
      createEvent(EventCategory.DeviceOnline, this.eventSource(), {
        deviceId: this.id,
        providerId: REOLINK_ADDON_ID,
        profileCount: 0,
        reason: 'reachable-again',
      }),
    )
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return
    if (this.isBattery) {
      // Battery cam: never proactively reconnect. Drop the stale api
      // reference so demand-driven `ensureApi` rebuilds it on next
      // call. Stop short of scheduling a timer — the next `awake`
      // event re-arms it. Online state is firmware-push-driven only:
      // socket close does NOT
      // flip `this.online`; the firmware emits its own 'offline' push
      // when the camera state actually transitions.
      this.api = null
      this.ctx.logger.debug('Battery cam disconnect — deferring reconnect to next demand', {
        tags: { deviceId: this.id },
        meta: { reason, sleeping: this.sleeping },
      })
      return
    }
    this.noteUnreachable(reason)
    const attempt = ++this.reconnectAttempts
    const backoffMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5))
    this.ctx.logger.info('Baichuan reconnect scheduled', {
      tags: { deviceId: this.id },
      meta: { reason, attempt, backoffMs },
    })

    // Where in the backoff ladder this camera actually is. The `info` line
    // above says one reconnect happened; this says whether the camera has been
    // flapping for an hour, which is the thing that distinguishes a blip from
    // a camera that never really came back.
    if (CH_HANDSHAKE.on && CH_HANDSHAKE.wants(this.id)) {
      CH_HANDSHAKE.log(this.ctx.logger, 'baichuan reconnect ladder', {
        tags: { deviceId: this.id },
        meta: { reason, attempt, backoffMs, hadApi: this.api !== null },
      })
    }

    // RFC 4571 servers each own a dedicated Baichuan socket (via the
    // `deviceId` option), so a control-channel reconnect on the main api
    // doesn't invalidate them. Leave them running — the lib's per-server
    // socket survives independently and self-heals on the next client
    // connection.
    this.api = null

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // Trigger ensureApi indirectly — the next demand event will. We
      // don't pre-emptively reconnect because the broker may already
      // have torn down its end (no active subscribers → no demand).
      this.ctx.logger.debug('Baichuan reconnect window elapsed — ready for next demand', {
        tags: { deviceId: this.id },
      })
    }, backoffMs)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }
}

// ── stream-params helpers ──────────────────────────────────────────────

/**
 * Translate a cap-layer `StreamProfilePatch` into the `EncStreamPatch`
 * shape that `ReolinkBaichuanApi.setEnc` accepts. Only populates fields
 * present in `patch` — the lib's read-modify-write preserves everything
 * else from the camera's current config.
 *
 * Field mapping:
 *  cap `codec`        → `videoEncType`  ('h264'|'h265', direct passthrough)
 *  cap `bitrateMode`  → `encoderType`   ('vbr'|'cbr', direct passthrough)
 *  cap `bitrate`      → `bitRate`       (kbps, same unit)
 *  cap `framerate`    → `frameRate`     (fps, same unit)
 *  cap `gop`          → `gop`           (seconds, same unit)
 *  cap `encoderProfile` → `encoderProfile` (direct passthrough)
 *  cap `width`/`height` → `width`/`height` (pixels, direct passthrough)
 *
 * There is deliberately NO audio branch. `StreamProfilePatch` carried one
 * until 2026-08-07, reachable from no form and no caller, while the camera's
 * microphone is a whole-device fact. It now has exactly one writer —
 * `privacyMask.setAudioEnabled`, which patches every stream block together so
 * the camera cannot end up half-muted.
 */
function buildEncStreamPatch(
  patch: StreamProfilePatch,
): import('@apocaliss92/nodelink-js').EncStreamPatch {
  const out: import('@apocaliss92/nodelink-js').EncStreamPatch = {}
  if (patch.codec !== undefined) out.videoEncType = patch.codec
  if (patch.bitrateMode !== undefined) out.encoderType = patch.bitrateMode
  if (patch.bitrate !== undefined) out.bitRate = patch.bitrate
  if (patch.framerate !== undefined) out.frameRate = patch.framerate
  if (patch.gop !== undefined) out.gop = patch.gop
  if (patch.encoderProfile !== undefined) out.encoderProfile = patch.encoderProfile
  if (patch.width !== undefined) out.width = patch.width
  if (patch.height !== undefined) out.height = patch.height
  return out
}

// ── Hub coupling helpers ───────────────────────────────────────────────
//
// Structural type for the parent Hub: kept here (instead of imported
// from `reolink-hub.ts`) to avoid the camera ↔ hub circular import.
// The Hub class IS structurally compatible — it exposes `id`, `getApi()`,
// and the deviceClass marker on its prototype. The duck-test below
// catches both the live class and the Moleculer-deserialized facade.

export interface ReolinkHubLike {
  readonly id: number
  getApi(): Promise<ReolinkBaichuanApi>
}

function isHubLike(d: unknown): d is ReolinkHubLike {
  if (typeof d !== 'object' || d === null) return false
  const obj = d as { getApi?: unknown; id?: unknown }
  return typeof obj.id === 'number' && typeof obj.getApi === 'function'
}

/**
 * Exponential backoff schedule for the event-health watchdog. The
 * camera's silent-event behaviour is bimodal: either there's a real
 * event flow (counter resets to 0 on every event → next stale streak
 * starts at 60s) OR the subscription is genuinely broken / nothing is
 * happening in front of the cam (counter rises → backoff lengthens).
 *
 * Schedule: 60s → 2min → 5min → 15min capped — the long-poll backoff
 * curve this hardware is known to tolerate.
 */
function computeHealthCheckBackoffMs(consecutive: number): number {
  if (consecutive <= 1) return 60_000 // 1st: 60s
  if (consecutive === 2) return 2 * 60_000 // 2nd: 2min
  if (consecutive === 3) return 5 * 60_000 // 3rd: 5min
  return 15 * 60_000 // 4th+: 15min
}
