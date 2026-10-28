import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type {
  AddonApi,
  BrokerStats,
  CameraStream,
  CamProfile,
  CamStreamDescriptor,
  CamStreamKind,
  ConfigFieldWithValue,
  ConfigOption,
  ConfigSectionWithValues,
  ConfigSubTabDefinitionWithValue,
  ConfigUISchemaWithValues,
  DecodedAudioChunk,
  EncodedPacket,
  EventMediaArtifact,
  EventMediaKind,
  EventMediaProduction,
  GetStreamWithCodecInput,
  IEventBus,
  IKernelHwAccel,
  IngestOwner,
  IScopedLogger,
  IStreamBroker,
  LiveViewerCount,
  NcClipRetentionAsk,
  PlaceholderReason,
  ProfileSlot,
  ProfileSlotStatus,
  PushAudioInfo,
  RtpSource,
  StreamFormat,
  StreamHealthReason,
  StreamSource,
  SubscribeAudioChunksInput,
  SubscribeAudioChunksResult,
  SystemEvent,
} from '@camstack/types'
import {
  BatteryStatusSchema,
  batteryCapability,
  CAM_PROFILE_ORDER,
  createHwAccelCache,
  DeviceFeature,
  type StreamSignal,
  DeviceType,
  type EgressTranscode,
  type EgressTranscodeRequest,
  type EncodeProfile,
  EncodeProfileSchema,
  EventCategory,
  errMsg,
  type HwAccelCache,
  isEvent,
  makeProfileBrokerId,
  makeSourceBrokerId,
  nodePin,
  type ProfileRtspEntry,
  resolveEgressDecodeHwAccel,
  type VideoEncode,
} from '@camstack/types'
import type { ChildCostRegistry } from '@camstack/types/node'
import { z } from 'zod'
import { mergeViewerCounts, type ViewerCounts } from '../live-viewers.js'
import { deviceIdFromBrokerId } from '../rtsp/broker-device-id.js'
import { rankDecodeHwAccels } from '../../shared/ffmpeg-decode-args.js'
import { sourceWaitState } from './egress-source-readiness.js'
import { healthEventIsOperatorFacing } from './stream-health-scope.js'
import {
  isStreamOutageReason,
  judgeStaleStream,
  WAKE_DEMAND_BOUND_MS,
  type BatterySleepFacts,
  type StaleStreamVerdict,
} from './stream-health-policy.js'
import { DeviceStreamOutages, type DeviceOutage } from './device-stream-outages.js'
import { sentryEligible } from './sentry-eligibility.js'
import { nextEnabledSignals } from './sentry-signal-selection.js'
import { DEFAULT_WAKE_HOLD_MS } from './wake-hold.js'
import {
  BatteryStreamUnavailableError,
  BatteryWakeOnPlaySingleFlight,
} from '../battery-wake-on-play.js'
import { type DerivedGraph, wouldCycle } from '../derived/cycle-check.js'
import {
  type ActiveDerivedFeeder,
  DerivedFeederController,
} from '../derived/derived-feeder-controller.js'
import {
  type DerivedSourceRef,
  DerivedSourceRefSchema,
  derivedSourceToStreamRequest,
} from '../derived/derived-source.js'
import { DerivedStreamFeeder } from '../derived/derived-stream-feeder.js'
import { buildDerivedTranscodeArgs } from '../derived/derived-transcode-args.js'
import { fillEmptyProfileSlots } from '../fill-empty-profile-slots.js'
import { rankInitialAssignment } from '../initial-assignment.js'
import {
  DEFAULT_PREBUFFER_SEC,
  PREBUFFER_MAX_SEC,
  type PrebufferConfig,
  resolvePrebuffer,
} from '../prebuffer.js'
import { migrateRetiredPreRollOverride } from '../prebuffer-migration.js'
import { HTTP_MJPEG_H264_OUTPUT_ARGS } from '../rtsp/ffmpeg-source-reader-args.js'
import {
  JOIN_BURST_MAX_SPAN_LIMIT_MS,
  JOIN_BURST_MIN_SPAN_MS,
  resolveJoinBurstBound,
} from '../rtsp/join-burst-bound.js'
import { RTSP_DESCRIBE_WARMUP_ATTRIBUTION, RtspListenServer } from '../rtsp/rtsp-listen-server.js'
import { type RtspRestreamEntry, RtspRestreamProviderImpl } from '../rtsp/rtsp-restream-provider.js'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import {
  type CreateStreamBroker,
  type IStreamBrokerWithSourceProvider,
  RemoteEncodedSourceBroker,
} from '../webrtc/remote-encoded-source-broker.js'
import { resolveTierSlot } from '../webrtc/resolve-tier-slot.js'
import { resolveWebrtcSourceMode } from '../webrtc/webrtc-source-mode.js'
import { buildAudioCodecCapApi } from './audio-codec-proxy.js'
import type { CatalogPullFailureState, CatalogReconcileTrigger } from './catalog-pull-backoff.js'
import {
  catalogPullRetryDelayMs,
  mayAttemptPolledCatalogPull,
  nextCatalogPullFailureState,
} from './catalog-pull-backoff.js'
import {
  AUDIO_PLANE_MAX_REDIALS,
  AUDIO_PLANE_REDIAL_COOLDOWN_MS,
  type AudioPlaneObservation,
  type AudioPlaneState,
  decideAudioPlaneAction,
  EMPTY_AUDIO_PLANE_STATE,
} from './audio-plane-reconcile.js'
import {
  createDeadDecodeBackends,
  type DeadDecodeBackends,
  resolveWithQuarantine,
} from './dead-decode-backends.js'
import type { EgressChild, EgressChildSpec, EgressPushSink } from './egress-transcode-manager.js'
import { EgressTranscodeManager, normaliseSourceCodec } from './egress-transcode-manager.js'
import { EventMediaStore } from './event-media-store.js'
import type { FfmpegHwAccelSetting, FfmpegSystemConfig } from './ffmpeg-invocation.js'
import { FFMPEG_HW_ACCEL_SETTINGS, requireBrokerFfmpeg } from './ffmpeg-invocation.js'
import { GIF_SPEED, gifDeriveSpeed, gifFromMp4 } from './gif-from-mp4.js'
import {
  type ClipCoverage,
  type ClipProfileCandidate,
  clipCanCopy,
  eventClipEncodeWidth,
  isHevcPacket,
  pickBestClipProfile,
  pickClipProfile,
  renderPreBufferClip as renderClipBytes,
  windowAround,
  windowCoverage,
} from './prebuffer-clip.js'
import {
  formatProbedSummary,
  type ProbedSnapshot,
  type ProbedSnapshotMap,
} from './probed-summary.js'
import { encodePrestreamIdr } from './sentry-encode.js'
import { composePrestreamPicture } from './sentry-picture.js'
import { planPrestream, type SentryPlan } from './sentry-plan.js'
import type { SentryFrame, SentryProvider } from './sentry-pump.js'
import { buildProfileRtspEntries, computeProfileRestreamerActions } from './profile-restreamers.js'
import { substituteRtspHost } from './rtsp-host.js'
import {
  resolveSourceParser,
  type SourceParserSetting,
  sourceParserOptionsFor,
} from './source-parser.js'
import { CH_WEBRTC } from '../log-channels.js'
import { judgeCatalogAbsence, type CatalogAbsenceMarks } from '../catalog-absence.js'
import { StreamBroker } from './stream-broker'
import type { EgressChannel } from './transcode-egress.js'
import { TranscodePipelineManager } from './transcode-pipeline.js'

interface StreamPreBuffer {
  readonly enabled: boolean
  readonly seconds: number
}

/** What `reportStreamSignal` did — mirrors the cap's own enum. */
type StreamSignalOutcome = 'woke' | 'hold-extended' | 'not-enabled' | 'no-consumer' | 'unknown-code'

export interface DeviceOverride {
  /**
   * Per-stream pre-buffer settings keyed by `camStreamId` (e.g.
   * `native:main`, `rtsp:sub`). Each stream sourceconfigures its own
   * buffer independently; profile assignment is decoupled — a profile
   * always inherits the pre-buffer of the cam stream currently mapped
   * to it via `assignments[deviceId].map[profile]`.
   */
  preBuffer?: Record<string, StreamPreBuffer>
  /**
   * Per-camera-stream join-burst span bound (ms), keyed by `camStreamId`.
   * Overrides the cluster default; absent means inherit.
   *
   * Keyed by stream and not by device because IDR interval is a property of
   * the ENCODER — a camera's sub-stream routinely runs a different GOP from
   * its main, so a per-device value would necessarily mis-tune one of them.
   * See `../rtsp/join-burst-bound.ts` for why this axis is allowed to diverge
   * when the per-node one is not.
   */
  joinBurstMaxSpanMs?: Record<string, number>
  /**
   * RETIRED (D381) — the per-camera-stream detection pre-roll (ms).
   *
   * Kept in the shape ONLY so a configuration written before that record can
   * still be read and converted by `migrateRetiredPreRollOverride`. Nothing
   * writes it, nothing reads it after boot, and it is dropped from the override
   * the manager keeps. It is declared here rather than deleted because a key
   * removed from a non-strict `z.object` is stripped in silence on the next
   * save, which would delete an operator's configured history without a line.
   */
  preRollMs?: Record<string, number>
  /**
   * Per-device debug flag for streaming subsystem (broker + WebRTC
   * session + repacketizer). When true, verbose info-level logs about
   * SDP param sets, RTP forwarding counts, repacketizer codecInfo
   * seeding, and source-RTP subscriber lifecycle become enabled.
   * Off by default to keep production logs quiet.
   */
  streamingDebug?: boolean
  /**
   * BROKER-SIDE AUDIO MUTE ([D83](../../../../../docs/decisions/adr-0083.md)).
   * `true` = this node distributes none of the device's audio, on live or on
   * recording, whatever the camera is capturing.
   *
   * Per-DEVICE and not per-camStream on purpose: every stream of a camera
   * carries the same microphone, so a per-stream value could only ever let
   * main and sub disagree about whether the camera is silent.
   *
   * It lives here rather than in a new store because this blob is already the
   * broker's per-device policy record — a switch that invented a second map
   * is the exact failure [D62](../../../../../docs/decisions/adr-0062.md)
   * exists to prevent.
   */
  audioMuted?: boolean
  /**
   * Per-device "Advanced WebRTC debug logging" flag. When true, EVERY
   * WebRTC `AdaptiveSession` created for this device gets `debug = true`,
   * which turns on the full per-step lifecycle logging in `session.ts`
   * (local answer ICE candidates + types, remote offer candidates, DTLS
   * state transitions, ICE nomination, codec negotiation, first
   * video/audio RTP, audio codec/clock). Distinct from `streamingDebug`
   * (broker/repacketizer verbosity) so an operator can isolate the
   * WebRTC negotiation path alone. Off by default.
   */
  webrtcDebug?: boolean
  /**
   * Operator-defined derived streams. Each entry is materialised
   * into a live broker by `loadPersistedDeviceOverrides` on hub
   * boot via publishCameraStream({kind:'derived', …}).
   */
  derivedStreams?: Record<string, DerivedStreamEntry>
  /**
   * Per-source-stream decode `hwaccel` override keyed by `camStreamId` (e.g.
   * `native:main`). Applies ONLY to the transcode paths (H265→H264 egress +
   * WebRTC feed) — passthrough and detection are unaffected. When set, the
   * override wins over the global `ffmpeg.hwAccel`; when absent, the global
   * config applies, whose own default is `'copy'` (software) out of the box.
   * `'copy'`/`'none'` = software decode (the safe choice for a camera whose
   * HEVC stream hard-fails on a hardware decoder).
   */
  hwaccel?: Record<string, FfmpegHwAccelSetting>
  /** Per-source-stream ingest parser keyed by `camStreamId`. Absent = native-tcp. */
  sourceParser?: Record<string, SourceParserSetting>
  /**
   * Per-source-stream ffmpeg-parser normalization args keyed by `camStreamId`.
   * Applies ONLY when the stream is ingested through the ffmpeg source reader
   * (either an `ffmpeg-*` `sourceParser` selection on an rtsp/rtmp stream, or a
   * `pull-flv` stream which is always ffmpeg-ingested). `inputArgs` are inserted
   * between the ffmpeg globals and `-i`; `outputArgs` before the final muxer.
   * Absent / empty = no extra args (default remux behaviour). Set from the
   * "FFmpeg parser args" widget in device settings.
   */
  sourceParserArgs?: Record<
    string,
    { inputArgs?: readonly string[]; outputArgs?: readonly string[] }
  >
  /**
   * The on-demand SENTRY, per camera. Absent is not "off": an absent
   * `enabledSignals` means every signal the camera declares, so a provider
   * that implements the cap works without the operator hunting for a
   * checkbox. An empty ARRAY is a deliberate "none" and is honoured.
   */
  sentry?: {
    enabledSignals?: string[]
    holdMs?: number
  }
}

interface DerivedStreamEntry {
  /**
   * Dual-mode source: a profile slot (follows assignment) or a physical
   * camStream (pinned). Absent = an unconfigured placeholder (the UI creates a
   * derived stream + encode params BEFORE the operator picks a source).
   */
  readonly source?: DerivedSourceRef
  readonly encodeProfile: EncodeProfile
  readonly preBuffer?: StreamPreBuffer
  readonly rtspEnabled?: boolean
}

/**
 * Whether an override still carries anything worth a map entry. An override
 * whose every field is absent/empty is DELETED rather than stored, so "no
 * entry" and "empty entry" stay one state — both `applyDeviceSettingsPatch`
 * and `forgetDeviceHardware` decide through this one predicate.
 */
function overrideHasContent(override: DeviceOverride): boolean {
  return (
    (override.preBuffer !== undefined && Object.keys(override.preBuffer).length > 0) ||
    override.streamingDebug !== undefined ||
    override.webrtcDebug !== undefined ||
    (override.hwaccel !== undefined && Object.keys(override.hwaccel).length > 0) ||
    (override.sourceParser !== undefined && Object.keys(override.sourceParser).length > 0) ||
    (override.sourceParserArgs !== undefined &&
      Object.keys(override.sourceParserArgs).length > 0) ||
    (override.derivedStreams !== undefined && Object.keys(override.derivedStreams).length > 0)
  )
}

/**
 * Resolve a derived stream's source to a physical camStreamId, if it is pinned
 * to one. A profile-kind source (which follows profile assignment) is NOT
 * resolvable here — the transcode feeder resolves those via the profile slot
 * map; until then a profile source yields `undefined` and the boot/patch
 * materialization paths defer it.
 */
function derivedSourceCamStreamId(source: DerivedSourceRef | undefined): string | undefined {
  return source?.kind === 'camStream' ? source.camStreamId : undefined
}

/**
 * Encode a {@link DerivedSourceRef} into the flat string a `select` field
 * carries as its value. Profiles serialize as `profile:<name>`; physical
 * camStreams as `stream:<camStreamId>` (the camStreamId may itself contain a
 * `:` — e.g. `native:mid` — so decode strips the `stream:` prefix ONCE and
 * keeps the remainder verbatim). An absent source (unconfigured placeholder)
 * encodes to the empty string.
 */
function encodeDerivedSourceValue(source: DerivedSourceRef | undefined): string {
  if (!source) return ''
  return source.kind === 'profile' ? `profile:${source.profile}` : `stream:${source.camStreamId}`
}

/**
 * Inverse of {@link encodeDerivedSourceValue}. Unknown / empty input yields
 * `undefined` (clears the source back to the unconfigured placeholder).
 */
function decodeDerivedSourceValue(value: string): DerivedSourceRef | undefined {
  if (value.startsWith('profile:')) {
    const profile = value.slice('profile:'.length)
    return profile === 'high' || profile === 'mid' || profile === 'low'
      ? { kind: 'profile', profile }
      : undefined
  }
  if (value.startsWith('stream:')) {
    const camStreamId = value.slice('stream:'.length)
    return camStreamId ? { kind: 'camStream', camStreamId } : undefined
  }
  return undefined
}

const StreamPreBufferSchema = z.object({
  enabled: z.boolean(),
  seconds: z.number(),
})

const DerivedStreamSchema = z.object({
  // Absent source = an unconfigured placeholder: the UI creates a derived
  // stream (name + encode params) BEFORE the operator picks a source. That
  // state must persist so the half-built stream survives a restart — making
  // `source` required rejected the whole device-overrides blob on save (one
  // placeholder blocked EVERY device). Runtime materialization skips
  // source-less entries, so an unconfigured entry is harmless until a source
  // is set.
  source: DerivedSourceRefSchema.optional(),
  encodeProfile: EncodeProfileSchema,
  preBuffer: StreamPreBufferSchema.optional(),
  rtspEnabled: z.boolean().optional(),
})

const FfmpegHwAccelSettingSchema = z.enum(
  FFMPEG_HW_ACCEL_SETTINGS as readonly [FfmpegHwAccelSetting, ...FfmpegHwAccelSetting[]],
)

const SourceParserSettingSchema = z.enum([
  'native-tcp',
  'native-udp',
  'ffmpeg-tcp',
  'ffmpeg-udp',
  'native',
  'ffmpeg',
])

/** Narrow an arbitrary string to a known `FfmpegHwAccelSetting`. */
function isFfmpegHwAccelSetting(value: string): value is FfmpegHwAccelSetting {
  return (FFMPEG_HW_ACCEL_SETTINGS as readonly string[]).includes(value)
}

/** Narrow an arbitrary string to a known `SourceParserSetting`. */
function isSourceParserSetting(value: string): value is SourceParserSetting {
  return SourceParserSettingSchema.safeParse(value).success
}

/** Operator-facing label for a per-camStream source-parser setting. */
function sourceParserOptionLabel(setting: SourceParserSetting): string {
  switch (setting) {
    case 'native-tcp':
      return 'Native (TCP)'
    case 'native-udp':
      return 'Native (UDP) — coming soon'
    case 'ffmpeg-tcp':
      return 'FFmpeg (TCP)'
    case 'ffmpeg-udp':
      return 'FFmpeg (UDP)'
    case 'native':
      return 'Native'
    case 'ffmpeg':
      return 'FFmpeg'
  }
}

/**
 * Map a cam-stream `kind` to the source type understood by
 * {@link sourceParserOptionsFor}. Only the URL-pull RTSP/RTMP kinds carry a
 * selectable parser; every other kind (push, rfc4571, http-mjpeg, derived)
 * yields `''` → empty options → the select is omitted.
 */
function sourceTypeForParser(kind: CamStreamKind): string {
  if (kind === 'pull-rtsp') return 'rtsp'
  if (kind === 'pull-rtmp') return 'rtmp'
  return ''
}

/** Operator-facing label for a decode `-hwaccel` setting in the UI selector. */
export function hwAccelOptionLabel(setting: FfmpegHwAccelSetting): string {
  switch (setting) {
    case 'copy':
      return 'Software (copy)'
    case 'none':
      return 'Software (none)'
    case 'auto':
      return 'Auto (hardware w/ fallback)'
    case 'videotoolbox':
      return 'VideoToolbox (Apple)'
    case 'vaapi':
      return 'VA-API (Linux)'
    case 'qsv':
      return 'Intel QSV'
    case 'cuda':
      return 'NVIDIA CUDA'
  }
}

const SourceParserArgsEntrySchema = z.object({
  // `.readonly()` so the inferred array type matches the `readonly string[]`
  // fields on the `DeviceOverride` interface (which the persister assigns into
  // the `DeviceOverridesMap` z.infer shape).
  inputArgs: z.array(z.string()).readonly().optional(),
  outputArgs: z.array(z.string()).readonly().optional(),
})

const DeviceOverrideSchema = z.object({
  preBuffer: z.record(z.string(), StreamPreBufferSchema).optional(),
  joinBurstMaxSpanMs: z.record(z.string(), z.number()).optional(),
  preRollMs: z.record(z.string(), z.number()).optional(),
  streamingDebug: z.boolean().optional(),
  audioMuted: z.boolean().optional(),
  webrtcDebug: z.boolean().optional(),
  derivedStreams: z.record(z.string(), DerivedStreamSchema).optional(),
  hwaccel: z.record(z.string(), FfmpegHwAccelSettingSchema).optional(),
  sourceParser: z.record(z.string(), SourceParserSettingSchema).optional(),
  sourceParserArgs: z.record(z.string(), SourceParserArgsEntrySchema).optional(),
  /**
   * The on-demand SENTRY, per camera.
   *
   * Absent means the operator has never touched it, which is NOT the same as
   * off: `enabledSignals` absent means "every signal this camera recommends",
   * so a Reolink works the moment a sentry URL is dialled without an
   * operator hunting for a checkbox. An empty ARRAY is a deliberate "none" and
   * is honoured — the two are different answers and the shape keeps them
   * apart.
   */
  sentry: z
    .object({
      /** Signal codes allowed to wake this camera. Absent ⇒ the recommended set. */
      enabledSignals: z.array(z.string()).optional(),
      /** How long the camera stays up after the LAST signal. Absent ⇒ default. */
      holdMs: z.number().int().min(1_000).max(300_000).optional(),
    })
    .optional(),
})

/**
 * Read `audioEnabled` off a `privacyMask.getStatus` payload (D83 reconcile).
 *
 * `getStatus` is the one cap method whose output is the generic device-status
 * shape rather than the cap's own schema, so it arrives untyped — this is the
 * documented type boundary, and a guard rather than a cast.
 *
 * `null` means UNKNOWN, and unknown must never become "audio is on": that is
 * the read that would re-dial a healthy stream on the strength of a payload
 * we could not parse. The camera says `null` itself when it has no microphone
 * control (`supportsAudioMute === false`), which lands in the same bucket for
 * the same reason.
 */
function readDeclaredAudioEnabled(v: unknown): boolean | null {
  if (v === null || typeof v !== 'object') return null
  const rec: Record<string, unknown> = { ...v }
  const raw = rec['audioEnabled']
  return typeof raw === 'boolean' ? raw : null
}

export function serializeDeviceOverride(o: DeviceOverride): string {
  return JSON.stringify(o)
}

export function parseDeviceOverride(s: string): DeviceOverride {
  return DeviceOverrideSchema.parse(JSON.parse(s))
}

/** Whole-blob schema for the persisted `deviceOverrides` store key:
 *  numeric-string deviceId → DeviceOverride (includes `derivedStreams`). */
export const DeviceOverridesMapSchema = z.record(z.string(), DeviceOverrideSchema)
export type DeviceOverridesMap = z.infer<typeof DeviceOverridesMapSchema>

/**
 * The one persisted store KEY the broker still keeps as a blob: `rtspEnabled`,
 * brokerId → enabled.
 *
 * `rtspTokens` and `profileMap` moved to their own collections in the
 * 2026-08-19 flatten and their whole-blob schemas are gone with them — the row
 * shapes live in `broker-row-stores.ts`. `rtspEnabled` stayed, and why is
 * argued in that file's header: its persister replaces the map from the set of
 * CURRENTLY registered restreamers, and reproducing that on rows would mean a
 * prune driven by a map that shrinks on every unregister.
 */
export const RtspEnabledSchema = z.record(z.string(), z.boolean())
export type RtspEnabledBlob = z.infer<typeof RtspEnabledSchema>

/**
 * Per-device assignment state persisted via `setProfileMapPersister`.
 * `auto` is true until the operator makes a manual assignment — used
 * so providers can keep publishing streams and have the broker
 * re-run `computeInitialAssignment` without overwriting a user's
 * chosen mapping.
 */
interface DeviceAssignment {
  readonly map: Partial<Record<CamProfile, string>>
  readonly auto: boolean
}

export type ProfileMapPersister = (assignments: ReadonlyMap<number, DeviceAssignment>) => void

/**
 * How far a {@link StreamBrokerManager.retractDevice} goes.
 *
 * The two flags answer different questions and a permanent removal sets BOTH:
 * `preserveAssignments` is about the per-stream teardown (skip the
 * re-ranking churn as each stream disappears), `purgeAssignments` is about the
 * device's profile-slot ENTRY (drop it outright, and persist that).
 */
/**
 * The departed-device sweep's second read must be at least this long after
 * the first mark (D685): one default catalog-poll interval. Two reads closer
 * than that — the startup pass's 1.5 s re-runs, two overlapping polls — are
 * one observation.
 */
const DEPARTURE_CONFIRM_MIN_MS = 30_000

/**
 * The catalog reconcile's second omission of a stream must be at least this
 * long after the first (D689) — the same one-poll-interval floor as the
 * departed-device sweep, for the same reason: an event-driven pull next to a
 * poll, or the startup pass's quick re-runs, are one observation.
 */
const CATALOG_ABSENCE_CONFIRM_MIN_MS = DEPARTURE_CONFIRM_MIN_MS

export interface RetractDeviceOptions {
  /**
   * Keep each stream's profile-map recompute from running as it goes away.
   * Set for a provider restart: the streams come back, and the operator's
   * manual slot choices must survive the gap.
   */
  readonly preserveAssignments?: boolean
  /**
   * PERMANENT removal — drop the device's whole assignment entry afterwards.
   * Only the `DeviceUnregistered` path sets this.
   */
  readonly purgeAssignments?: boolean
}

type CameraStreamInternal = CameraStream & {
  /** Insertion order within (deviceId) — drives UI dropdown ordering. */
  readonly order: number
  readonly deviceFeatures: readonly string[]
  /**
   * Whether this stream is eligible for the broker's automatic profile
   * assignment. `false` streams stay published (visible + manually
   * assignable), but `computeInitialAssignment` skips them. Defaults
   * `true` for back-compat with publishers that don't set the flag.
   */
  readonly autoEligible: boolean
  /**
   * A BROKER-OWNED synthetic: this broker minted the stream, no provider ever
   * declares it, and its lifecycle belongs to whatever created it — the
   * `derived:*` mechanism (`reconcileDerivedStreams`) or the egress primitive's
   * refcount. "Absent from the provider's `stream-catalog`" is therefore its
   * PERMANENT state, not a removal signal, and the catalog sweep must skip it.
   * Both publishers have now been swept out from under a live consumer: the 618
   * `derived:sub-cropped` bug, and the 587 Alexa egress teardown 13 s into
   * every session.
   */
  readonly brokerOwned: boolean
  /**
   * Derived-only: the source this transcode feeder reads. Stored so a later
   * consumer (getStreamWithCodec, WebRTC) can re-attach the feeder after the
   * push broker was released and recreated without going through publish.
   */
  readonly derivedSource?: DerivedSourceRef
  /** Derived-only: encode parameters for the feeder. See `derivedSource`. */
  readonly encodeProfile?: EncodeProfile
}

/** Pull source types that support the per-camStream "source parser" selection. */
type SourceParserSourceType = 'rtsp' | 'rtmp'

const PUSH_KINDS: ReadonlySet<CamStreamKind> = new Set(['push-annexb'])

/** Walk a profile map and return the slot that points at `camStreamId`, or null. */
function findProfileForStream(
  map: Partial<Record<CamProfile, string>>,
  camStreamId: string,
): CamProfile | null {
  for (const profile of CAM_PROFILE_ORDER) {
    if (map[profile] === camStreamId) return profile
  }
  return null
}

/**
 * Pure lookup behind `StreamBrokerManager`'s `profileTierResolver` closure
 * (Slice 3b Task 2). `localLookup` mirrors today's behavior — parse the
 * brokerId and walk the LOCAL device's `this.assignments` map — which is
 * always empty for a remote-owned camera, so it returns null for every
 * remote-ensured adapter's brokerId. `remoteBrokerTiers` is the fallback
 * populated at the remote-adapter ensure site (Task 3) so `selectBestBroker`
 * can still tier-match a remote-owned camera's broker. Local wins when both
 * resolve a tier — a local broker is never shadowed by a stale remote entry.
 */
export function resolveBrokerTier(
  brokerId: string,
  localLookup: (brokerId: string) => CamProfile | null,
  remoteBrokerTiers: ReadonlyMap<string, CamProfile>,
): CamProfile | null {
  return localLookup(brokerId) ?? remoteBrokerTiers.get(brokerId) ?? null
}

/**
 * Watchdog parameters for the stream-health emitter. Brokers that WERE
 * healthy and then go without a video packet for STREAM_STALE_TIMEOUT_MS
 * are reported as `stream.offline`; the next packet flips them back to
 * `stream.online` with reason `recovered`. A broker that has never been
 * healthy is seeded silent — never-online is not an outage (see
 * `evaluateStreamHealth`).
 *
 * THE TWO MINUTES ARE AN OPERATOR CONTRACT, not a tuning knob (2026-08-12).
 * A `stale-timeout` is the ONLY thing downstream is allowed to call an outage
 * (Notification Center: `notification-center/event-intake.ts`,
 * `NC_STREAM_OFFLINE_REASON`), and the operator's rule for it is "a camera
 * reboot must not get through" — a stream that comes back inside this window
 * produces no notification at all, because no `stream.offline` is emitted in
 * the first place. Shortening this window shortens that promise, and nothing
 * downstream re-checks it: this constant IS the two minutes.
 *
 * Nothing emits a notifiable `stream.offline` faster. The rfc4571 clean-FIN
 * failure edge (`onTeardown`) sets `_status='error'` and reconnects; it does
 * not emit. Idle suspend emits `suspended` (discarded by NC).
 */
const STREAM_STALE_TIMEOUT_MS = 120_000
const STREAM_HEALTH_POLL_MS = 15_000

/** A device-level health event's context: a failed wake may name no published stream. */
type DeviceHealthContext = Omit<StreamHealthEmitContext, 'camStreamId'> & {
  readonly camStreamId?: string
}

/** A device's battery facts as the health sweep holds them. */
interface BatteryProbe {
  readonly state: 'pending' | 'done'
  /** `null` = the registry could not say (judged as a mains camera, retried). */
  readonly isBattery: boolean | null
  /** `null` = the slice was never read: a sleep verdict is refused on it. */
  readonly facts: BatterySleepFacts | null
  readonly readAt: number
}

/**
 * `awakeSince` for a sleep fact just observed: stamped when `sleeping` flips to
 * false (from asleep, or from nothing known — the event IS the flip), kept while
 * it stays awake, absent while asleep.
 */
function awakeSinceFor(
  previous: BatterySleepFacts | null,
  sleeping: boolean,
  nowMs: number,
): { readonly awakeSince?: number } {
  if (sleeping) return {}
  if (previous !== null && !previous.sleeping && previous.awakeSince !== undefined) {
    return { awakeSince: previous.awakeSince }
  }
  return { awakeSince: nowMs }
}

/** A slice READ carries no flip time: keep the one an event gave while the camera stays awake. */
function carryAwakeSince(
  previous: BatterySleepFacts | null,
  read: BatterySleepFacts | null,
): BatterySleepFacts | null {
  if (read === null || read.sleeping) return read
  if (previous === null || previous.sleeping || previous.awakeSince === undefined) return read
  return { ...read, awakeSince: previous.awakeSince }
}

/** How often an unanswered / stale battery probe is asked again. */
const BATTERY_PROBE_RETRY_MS = 60_000
/** A wake-only outage with no further failed wake for this long is over: the demand is gone. */
const WAKE_ONLY_OUTAGE_TTL_MS = 5 * 60_000

/** What one broker's health flip knows about itself, before it becomes an event. */
interface StreamHealthEmitContext {
  readonly deviceId: number
  readonly camStreamId: string
  readonly brokerId: string
  readonly sourceType: string
  readonly lastPacketAt: number
}

/** Compose a SOURCE broker id from a `(deviceId, camStreamId)` tuple. Thin
 *  wrapper over the canonical `makeSourceBrokerId` — single source of truth. */
function brokerIdFor(deviceId: number, camStreamId: string): string {
  return makeSourceBrokerId(deviceId, camStreamId)
}

/** Local-time "HH:MM" label for the per-stream probe "as of" tag. */
function formatClockHHMM(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Force-probe ("Probe now") timing: how long to wait for the dialed stream to
 *  reach `streaming` with audio detected, and the stats poll cadence. */
const PROBE_STREAM_TIMEOUT_MS = 6_000
const PROBE_STREAM_POLL_MS = 250

/**
 * Seconds of encoded video kept for notification clips, on the cheapest
 * assigned profile only. Sized to cover the longest allowed pre-roll (20 s)
 * plus the seconds a rule takes to reach the dispatcher; the low-profile
 * rendition costs a few MB for that window, and nothing at all while the
 * camera is idle.
 */
/**
 * One selected clip window plus everything both producers need to describe it.
 *
 * Shared rather than recomputed: `renderPreBufferClip` and `produceEventMedia`
 * differ only in what they emit, and two copies of "which profile, which
 * packets, which resolution" is how the two paths would start disagreeing about
 * the same event again.
 */
interface ClipWindowCut {
  readonly deviceId: number
  readonly profile: CamProfile
  readonly window: readonly EncodedPacket[]
  readonly coverage: ClipCoverage
  readonly broker: StreamBroker
  /** 0 when the rendition publishes no resolution — refuses the copy branch. */
  readonly sourceWidth: number
  readonly sourceHeight: number
}

/**
 * How much history a notification clip may be cut from on a camera the
 * notification centre has **not spoken about yet**.
 *
 * Retention is no longer flat: every camera holds what its own notification
 * rules ask for ({@link refreshClipRetentionPlan}), which is nothing at all on
 * a camera whose rules never cut footage. This number is what a camera holds
 * while that ask is UNKNOWN — before the first successful pull, and after a
 * pull that failed or answered with a rule set that has not loaded. Absence
 * must not read as zero: dropping a ring on boot, before the rules arrive,
 * loses the footage for exactly the first events after every restart, which is
 * when an operator is most likely to be watching. So an unknown camera keeps
 * what the whole fleet used to keep, and only an ANSWER can take it away.
 *
 * Sixty seconds, raised from 25 on 2026-09-15 after measuring what the
 * alternative sources can actually serve. The recordings' availability edge is
 * not a number but a PHASE: asking for the same 10-second window at different
 * anchors, full coverage arrived at −18 s on one camera and −26 s on two
 * others, depending on where the request falls in the 10-second segment cycle.
 * A notification window is `[anchor−4, anchor+6]`, so at 25 s the ring served
 * an anchor roughly 6–19 s old while the recordings began at 14–26 s — and on
 * an unlucky phase those bands did not meet, which is the silent "no clip" the
 * operator kept receiving. No fixed threshold closes a gap that opens and
 * closes with the segment cycle; margin over the WORST phase does.
 *
 * It is affordable only because this ring runs on the cheap profile: the
 * fleet's 22 cheap streams sum 4.3 Mbps, so a minute costs ~32 MB across every
 * camera — against ~800 MB for the same minute of the main stream. And it is
 * SAFE only because the ring is now bounded by bytes
 * (`StreamBroker.CLIP_RING_MAX_BYTES`): a rule that arms a clip on the main
 * stream is clamped to what 16 MiB holds rather than taking 82 MB.
 */
const CLIP_RETENTION_UNKNOWN_SEC = 60

/** Cheapest-first — the profile a clip is cut from when the rule says nothing. */
const CLIP_PROFILE_BY_COST: readonly CamProfile[] = ['low', 'mid', 'high'] as const

/**
 * Head-room added to an OBSERVED ask (`preRoll + postRoll + this`).
 *
 * The notification centre derives the same shape from its own rules
 * (`NC_CLIP_DISPATCH_MARGIN_SEC`) and for the same reason: a cut is taken
 * seconds after the moment it is about — the row is queued, drained, and its
 * still is waited for — so a ring sized to the window alone drops the pre-roll
 * a heartbeat before the renderer asks for it. Deliberately NOT imported from
 * the notification addon: addons never import each other, and this is the
 * broker's own floor for a consumer that is not the notification centre.
 */
const CLIP_OBSERVED_ASK_MARGIN_SEC = 10

/** Where a camera's clip retention came from — for the transition log line. */
type ClipRetentionSource = 'rules' | 'observed' | 'unknown'

/** The seconds and profiles one camera's ring should hold, and why. */
interface ResolvedClipRetention {
  readonly seconds: number
  readonly profiles: ReadonlySet<CamProfile>
  readonly source: ClipRetentionSource
}

/** How long `renderPreBufferClip` will wait for the post-roll to accumulate. */
const CLIP_POST_ROLL_POLL_MS = 250

/**
 * Inverse of `brokerIdFor`: split a `<deviceId>/<camStreamId>` broker id back
 * into its tuple. Splits on the FIRST `/` (the deviceId is a leading integer;
 * the camStreamId may itself contain no `/` today, but be liberal). Returns
 * null when the leading segment isn't a non-negative integer.
 */
function parseBrokerId(brokerId: string): { deviceId: number; camStreamId: string } | null {
  const slash = brokerId.indexOf('/')
  if (slash <= 0) return null
  const deviceId = Number(brokerId.slice(0, slash))
  const camStreamId = brokerId.slice(slash + 1)
  if (!Number.isInteger(deviceId) || deviceId < 0 || camStreamId.length === 0) return null
  return { deviceId, camStreamId }
}

export class StreamBrokerManager {
  /**
   * brokers keyed by brokerId = `${deviceId}/${camStreamId}`.
   *
   * Single source of truth: one StreamBroker per cam stream source.
   * Profiles are an alias layer over this map — the profile slot
   * `(deviceId, profile)` resolves to the broker via
   * `assignments[deviceId].map[profile] -> camStreamId`.
   *
   * Lifecycle is tied 1:1 to publish/retract: a broker exists for as
   * long as the cam stream is published. Pre-buffer defaults OFF —
   * idle cam streams cost roughly nothing (the upstream readers stay
   * dormant until something subscribes), but we keep the broker
   * registered so callers (WebRTC, RTSP restream) can latch on at any
   * time without an activation handshake.
   */
  private readonly brokers = new Map<string, StreamBroker>()
  /**
   * Devices whose `deviceManager` meta says `disabled:true` — mirrored by the
   * SAME `reconcileAllCatalogs` poll that already reads `listAll` (the D8
   * reconcile backstop; no event plumbing). While a device is in this set,
   * `ensureBroker` refuses (re)creation so a retrying audio/frame subscriber
   * cannot resurrect a released broker, and the reconcile releases any broker
   * that still exists. Cleared by the same poll on re-enable.
   */
  private readonly disabledDevices = new Set<number>()
  /** profileBrokerId (`${deviceId}/${profile}`) → sourceBrokerId currently aliased. */
  private readonly profileRestreamerBindings = new Map<string, string>()
  /** Per-device published cam-stream registry. */
  private readonly cameraStreams = new Map<number, Map<string, CameraStreamInternal>>()
  /**
   * The encoded sentry frame per broker, with the digest of the picture it
   * was made from. One entry is one still image — kilobytes — and it is
   * dropped with the broker in `releaseBroker`.
   */
  /** Brokers with a background sentry re-encode in flight (single-flight). */
  private readonly sentryRefreshing = new Set<string>()
  private readonly sentryFrames = new Map<
    string,
    { readonly key: string; readonly frame: SentryFrame }
  >()
  /** Monotonic insertion counter per device — feeds `CameraStreamInternal.order`. */
  private readonly streamOrderSeq = new Map<number, number>()
  /** Persisted operator intent: which cam stream serves which profile. */
  private readonly assignments = new Map<number, DeviceAssignment>()
  /** Per-device overrides (pre-buffer + legacy). */
  private readonly deviceOverrides = new Map<number, DeviceOverride>()
  /**
   * D83 audio-plane reconcile memory, per device. Absent = agreeing; entries
   * are deleted the moment a pass agrees, so a healthy fleet holds none.
   */
  private readonly audioPlaneState = new Map<number, AudioPlaneState>()
  /**
   * `deviceId:camStreamId` keys for which the `native-udp` → `native-tcp`
   * fallback warning has already been logged, so the warn fires once per stream
   * rather than on every source (re)build / dial.
   */
  private readonly sourceParserFellBackWarned = new Set<string>()
  /**
   * brokerIds for which the "not the ingest owner — skipping local physical
   * broker" debug line was already logged. The ingest-owner gate runs on
   * EVERY `ensureBroker` (reconcile per source, re-fires on each stream
   * republish — frequent for rfc4571/reolink), so without this it spams the
   * log once per reconcile on every non-owner node. Log once per brokerId;
   * cleared on an ingest-owner change so a topology shift re-surfaces it.
   */
  private readonly nonOwnerSkipLogged = new Set<string>()
  private deviceOverridePersister:
    | ((overrides: ReadonlyMap<number, DeviceOverride>) => void)
    | null = null
  private profileMapPersister: ProfileMapPersister | null = null
  /** See {@link setDeviceHardwareForgetHook}. */
  private deviceHardwareForgetHook:
    | ((deviceId: number) => Promise<{ rtspTokenRowsDeleted: number }>)
    | null = null
  private readonly deviceCatalogOperations = new Map<number, Promise<void>>()
  /**
   * Devices whose `stream-catalog` pull is currently failing, and when the
   * POLL may ask again. Absent = healthy; an entry is deleted the moment a
   * pull succeeds. See `catalog-pull-backoff.ts` for the ladder and for the
   * outage that put it here.
   */
  private readonly catalogPullFailures = new Map<number, CatalogPullFailureState>()
  /**
   * Devices with registered streams that a successful fleet read did not
   * list, and WHEN that read was (D685). A mark, not a verdict: the sweep
   * retracts only when a read at least {@link DEPARTURE_CONFIRM_MIN_MS} later
   * agrees, and a reappearance clears it (D49).
   */
  private readonly departureMarks = new Map<number, number>()
  /**
   * Per device: provider streams the broker holds that a successful catalog
   * pull OMITTED, and when (D689). A mark, not a verdict — see
   * `catalog-absence.ts`. Dropped when the stream is retracted by any path and
   * when the device is disabled (no pulls run then, so a mark would outlive
   * the observation it records).
   */
  private readonly catalogAbsenceMarks = new Map<number, CatalogAbsenceMarks>()
  private eventBus: IEventBus | null = null
  /**
   * Per-broker stream health flag set by the watchdog. `undefined`
   * before the first transition — emit `stream.online` on first packet
   * regardless of prior state.
   */
  private readonly streamHealthByBroker = new Map<string, boolean>()
  /**
   * Why each broker last went UNhealthy. Read when it comes back so the
   * recovery names the same kind of transition its outage did: a broker that
   * went quiet because the last consumer left comes back `resumed`, not
   * `recovered`. Without this, an intentional suspend/resume cycle emitted the
   * same pair a two-minute outage does, and every consumer downstream had to
   * guess which one it was looking at.
   */
  private readonly streamOfflineReasonByBroker = new Map<string, StreamHealthReason>()
  /**
   * Brokers whose stream went quiet because their BATTERY camera is asleep.
   * Not an outage and never announced (D883); remembered so the wake that ends
   * it is recognised as a plain wake instead of a `recovered`.
   */
  private readonly sleepSuppressedBrokers = new Set<string>()
  /**
   * What the sweep knows of a device's battery: is it one, and what did its
   * `battery` slice last say. Fed by `BatteryOnStatusChanged` (droppable, empty
   * after a restart) AND read from the device registry / slice by the sweep
   * itself — the same two reads wake-on-play makes — so a restart or a lost
   * event never leaves the verdict standing on an unread mirror (D49).
   */
  private readonly batteryProbe = new Map<number, BatteryProbe>()
  private readonly batteryProbeInFlight = new Set<number>()
  /** When a consumer's demand on a quiet battery stream was first seen (the wake bound starts there). */
  private readonly demandSince = new Map<string, number>()
  /** The stream outage a DEVICE is in (one entry per device, however many profiles). */
  private readonly deviceOutages = new DeviceStreamOutages()
  private streamHealthTimer: ReturnType<typeof setInterval> | undefined
  /**
   * Routes an audio-chunk `subscriptionId` (Phase 5 / D9) back to its owning
   * brokerId so `pullAudioChunks` / `unsubscribeAudioChunks` resolve in O(1)
   * without scanning every broker.
   */
  private readonly audioSubscriptionBroker = new Map<string, string>()
  /**
   * Derived streams that could not be materialised at boot because their
   * source broker had not yet been registered. Keyed by the source brokerId
   * (`${deviceId}/${sourceCamStreamId}`). Drained by `publishCameraStream`
   * when the matching source is registered.
   */
  private readonly pendingDerivedStreams = new Map<
    string,
    Array<{
      deviceId: number
      name: string
      def: NonNullable<DeviceOverride['derivedStreams']>[string]
      /** Profile slot to restore after a source-change republish (see
       *  `reconcileDerivedStreams`); undefined for a first materialise. */
      restoreProfile?: CamProfile
    }>
  >()
  /**
   * On-demand transcode-feeder lifecycle owner per derived broker, keyed by the
   * derived brokerId (`${deviceId}/derived:<name>`). Spawns ffmpeg only while
   * the derived broker is consumed (via the broker's `onDemandChange`) and tears
   * it down on idle / retract. Populated by {@link attachDerivedFeeder}.
   */
  private readonly derivedFeeders = new Map<
    string,
    { controller: DerivedFeederController; unsubscribe: () => void }
  >()
  private readonly logger: IScopedLogger
  /** Public accessor for same-process callers (e.g. `CameraStreamsProvider.pickStream`)
   *  that want to emit diagnostics through the manager's logger. Internal callers
   *  use `this.logger` directly. */
  getLogger(): IScopedLogger {
    return this.logger
  }
  private readonly rtspServer = new RtspListenServer()
  private readonly rtspProvider: RtspRestreamProviderImpl
  private persistedTokens = new Map<string, string>()
  /**
   * True for a camera whose restream tokens are held in an unreadable keychain
   * (D870). Such a camera gets NO restream URL - minting a temporary token would
   * hand consumers a URL that dies as soon as the real one is restored - while
   * every other camera, and the camera's own streams and recording, are
   * untouched.
   */
  private restreamGate: (deviceId: number) => boolean = () => false
  /**
   * Last runtime probe per broker, captured while the broker was streaming.
   * Survives the stream going idle so the per-stream "Probed" settings field
   * stays populated (with an "as of" tag). In-memory only — repopulates on the
   * next pull after a hub restart. Keyed by `brokerIdFor(deviceId, camStreamId)`.
   */
  private readonly lastProbedByBroker = new Map<string, ProbedSnapshot>()
  /**
   * tRPC api proxy injected from the host addon. Used to resolve the
   * `decoder` capability (and any future cross-cap consumers) via the
   * canonical API surface — `localProviderLink` short-circuits when
   * the provider lives in the same broker / group, otherwise the call
   * goes over `brokerTransportLink`. Replaces the previous direct
   * `CapabilityRegistry` lookup, which only worked on the hub.
   */
  private api: AddonApi | null = null
  /**
   * This node's LOCAL hwaccel resolver (`ctx.kernel.hwaccel`), wired by
   * `setApiAccess`. Drives the transcode manager's decode/encode backend picks
   * and `getHwAccelOptions` from THIS node's hardware in-process — never the
   * `platform-probe` singleton (whose per-node `nodePin` answers with the hub's
   * hardware from a forked agent child).
   */
  private hwaccel: IKernelHwAccel | null = null
  /**
   * This broker node's own Moleculer nodeID (`ctx.kernel.localNodeId`). The
   * shm frame plane's decoder sessions MUST be co-located on this node — an
   * shm frame ring is node-local, so a decoder placed on any OTHER node can
   * never deliver handles to this broker's consumers (the reader's
   * `shm_open` fails "No such file"). The `decoder` cap is a `singleton`, so
   * an UNPINNED `createSession` resolves to the cluster-elected active node —
   * which may be a remote agent. We therefore pin every decode to this local
   * node. `null` until `setApiAccess` wires it (falls back to unpinned).
   */
  private localNodeId: string | null = null
  /**
   * Short-TTL cache of `clusterRoles.ingestNode` (via `getIngestOwner`) for the
   * `ensureBroker` dormancy gate — the reconcile calls `ensureBroker` per
   * camera, so a per-call cross-node query would be wasteful. Refreshed lazily
   * when older than {@link INGEST_OWNER_CACHE_TTL_MS}. `null` = never resolved.
   */
  private cachedIngestOwnerNodeId: string | null = null
  private cachedIngestOwnerAt = 0
  // Long BACKSTOP reconcile interval. The owner is normally kept fresh by the
  // orchestrator's pushed `PipelineIngestOwnerChanged` events (which stamp
  // `cachedIngestOwnerAt`), so a `getIngestOwner` query fires only on cold start
  // or if no event landed for this long — a loss-safety reconcile, not a hot
  // path. (Was 5s — a per-reconcile-batch cross-process poll.)
  private static readonly INGEST_OWNER_CACHE_TTL_MS = 60_000
  // Retained promise of the most recent ownership-change teardown reconcile
  // (reverse-flip). Fire-and-forget in production; awaited in tests for
  // determinism.
  private lastOwnershipReconcile: Promise<void> = Promise.resolve()
  private defaultPreBufferSec = DEFAULT_PREBUFFER_SEC
  /**
   * Cluster-wide default join-burst span bound (D57). `undefined` until the
   * addon applies its config, at which point every live broker is re-bounded.
   * Cluster-scoped, never per-node: the ingest node is a movable role, so a
   * per-node value would make a camera's join behaviour depend on which node
   * happened to own its ingest (D52/D56).
   */
  private defaultJoinBurstMaxSpanMs: number | undefined
  private webrtcServer: import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer | null = null
  /**
   * brokerId → the remote-encoded adapter backing a non-owned camera's WebRTC
   * session (Slice 3 Task 3 — cross-node ingest wiring). Mirrors `this.brokers`
   * for the cross-node leg: `ensureBrokerForWebrtcSession` get-or-creates one
   * when `getIngestOwner` resolves to a DIFFERENT node than this one, and
   * tears it down on the adapter's inner broker's own `onDemandChange(false)`
   * edge (last-session-idle) — the same hook `attachDerivedFeeder` uses to
   * tear down a derived feeder.
   */
  private readonly remoteBrokerAdapters = new Map<string, RemoteEncodedSourceBroker>()
  /**
   * brokerId → in-flight `ensureBrokerForWebrtcSession` get-or-create for
   * that broker's remote adapter. Manager-level single-flight guard: two
   * concurrent WebRTC session creations for the SAME non-owned brokerId
   * (a real race — first-session-ever for a camera whose owner is a
   * different node) both pass the `remoteBrokerAdapters.has()` early-return
   * with the map still empty, because the check and the eventual `.set()`
   * straddle an `await getIngestOwner.query()`. Without this guard both
   * callers would construct their own `RemoteEncodedSourceBroker`, both
   * `.set()` into `remoteBrokerAdapters` (second overwrites first), and
   * both acquire the owner's restream (`getStreamWithCodec`) — the first
   * adapter becomes unreachable from the map so its `onDemandChange(false)`
   * teardown never runs and its restream refcount leaks forever. Concurrent
   * callers instead await the SAME promise, so exactly one adapter is
   * constructed, registered, and refcounted per brokerId.
   */
  private readonly remoteAdapterEnsures = new Map<string, Promise<void>>()
  /**
   * brokerId → in-flight `ensureBroker` get-or-create for that brokerId's
   * PHYSICAL source broker. Mirrors `remoteAdapterEnsures` for the
   * physical-source leg. `ensureBroker`'s body awaits `isLocalIngestOwner()`
   * and `broker.start()` before it reaches `this.brokers.set()`, so two
   * concurrent callers for the SAME brokerId (~7 call sites: catalog
   * reconcile, publish, restart, subscribe-resurrect) both pass the
   * `this.brokers.has()` guard while the map is still empty. Without this
   * guard both would construct + `start()` their own `StreamBroker`, and
   * the SECOND `this.brokers.set()` would silently overwrite the first —
   * the loser becomes a zombie: unreachable from `this.brokers`, never
   * `.stop()`-ed, but its `scheduleReconnect` timer keeps firing forever
   * (observed as event-loop starvation under a flapping/offline camera).
   * Concurrent callers instead await the SAME promise, so exactly one
   * broker is constructed, started, and registered per brokerId.
   */
  private readonly brokerEnsures = new Map<string, Promise<void>>()
  /**
   * Device-scoped wake-on-play transactions. A camera wake is shared by every
   * profile, so Viewer retries or concurrent sessions must join the existing
   * sleeping → waking → broker-settle transaction instead of issuing another
   * `battery.wakeForStream` mutation.
   */
  private readonly batteryWakeOnPlay = new BatteryWakeOnPlaySingleFlight()
  /**
   * brokerId → the profile tier a remote-ensured adapter was created for
   * (Slice 3b Task 2). `this.assignments` only tracks LOCALLY-owned devices,
   * so the `profileTierResolver` closure below always misses for a remote
   * adapter's brokerId — this map is the fallback so `selectBestBroker` can
   * still tier-match it. Populated at the ensure site alongside
   * `remoteBrokerAdapters.set(brokerId, ...)` (Task 3 threads the tier in)
   * and cleared at every `remoteBrokerAdapters.delete(brokerId)` site so no
   * stale tier lingers past the adapter's own lifetime.
   */
  private readonly remoteBrokerTiers = new Map<string, CamProfile>()
  /**
   * Injected factory for the inner broker a `RemoteEncodedSourceBroker`
   * drives. Production wraps the real `StreamBroker` — this leg never decodes
   * audio locally, so the audio-codec cap is unused (mirrors the
   * recommendation in `RemoteEncodedSourceBroker`'s doc comment).
   * Tests substitute a fake via `setRemoteEncodedBrokerFactory` so no real
   * RTSP dial happens.
   */
  private createRemoteEncodedBroker: CreateStreamBroker = (deps) =>
    new StreamBroker(deps.brokerId, deps.logger, null)
  /**
   * Transcode-pipeline manager — backs `getStreamWithCodec`. Lazily
   * created on first acquire, lives until `destroyAll`.
   */
  private transcodeManager: TranscodePipelineManager | null = null
  /**
   * The ffmpeg primitive's acquire/refcount/release (D67). Lazily created on
   * first acquire, torn down by `destroyAll` — which is also the only thing
   * that reclaims a refcount whose holder died without releasing.
   */
  private egressTranscodeManager: EgressTranscodeManager | null = null
  /** See {@link StreamBrokerManager.setCostRegistry}. */
  private costRegistry: ChildCostRegistry | null = null
  /**
   * Test/injection seam for the egress primitive's child. Production leaves it
   * null and `EgressTranscodeManager` builds a real `TranscodeEgress` /
   * `FfmpegPushReader`; a spec substitutes a fake so the REAL
   * `publishPushStream` closure — publish, sink, retract — runs without ffmpeg.
   * Mirrors `setRemoteEncodedBrokerFactory`.
   */
  private createEgressChild: ((spec: EgressChildSpec) => EgressChild) | null = null
  /**
   * Memo for the decoder addon's per-node backend, so a per-session resolve is
   * not a per-session cross-process cap call. Owned HERE rather than as a
   * module global on purpose: a module global would outlive an addon respawn
   * and survive an operator changing the decoder backend.
   */
  private readonly egressHwAccelCache: HwAccelCache = createHwAccelCache({
    ttlMs: 60_000,
  })
  /**
   * Backends that could not create a device in THIS process. Separate from the
   * memo above on purpose: the memo answers "what should decode this" on a read
   * cadence and expires in a minute, so folding the failure into it meant the
   * next cold child one minute later re-paid the same ~3 s death — measured
   * seven times on 101 between 22:17 and 22:52 on 2026-08-07. See
   * `dead-decode-backends.ts`.
   */
  private readonly deadDecodeBackends: DeadDecodeBackends = createDeadDecodeBackends()
  /**
   * Snapshot of the system `ffmpeg` config section (binaryPath / hwAccel /
   * threadCount). Refreshed by the host addon via `setFfmpegConfig`; the
   * transcode manager reads it live per spawn. Until the addon resolves the
   * node's pinned binary there is NONE (`binaryPath: null`) and every child
   * refuses by name — never a PATH `ffmpeg` (D540). `'copy'` software decode
   * and auto threads stay the defaults: software decode never hard-fails on a
   * fragile HEVC source.
   */
  private ffmpegConfig: FfmpegSystemConfig = {
    binaryPath: null,
    hwAccel: 'copy',
    threadCount: 0,
  }

  constructor(logger: IScopedLogger) {
    this.logger = logger
    this.rtspServer.setLogger(logger.child('rtsp-listen'))
    this.rtspProvider = new RtspRestreamProviderImpl(this.rtspServer, logger.child('rtsp-restream'))
  }

  /**
   * The addon's child-cost registry, threaded down to every broker and to the
   * egress transcode manager so each spawn site claims its OWN child. Injected
   * (not constructed) because it is per-addon-process and is what the addon's
   * `load-contribution` provider reads.
   */
  setCostRegistry(registry: ChildCostRegistry): void {
    this.costRegistry = registry
  }

  /**
   * Lazily create the transcode manager wired with closures rather than
   * direct refs so it only sees the surface it needs.
   */
  private getTranscodeManager(): TranscodePipelineManager {
    if (!this.transcodeManager) {
      this.transcodeManager = new TranscodePipelineManager({
        logger: this.logger.child('transcode'),
        // Decode/encode hw-accel picks resolve from THIS node's local
        // `ctx.kernel.hwaccel` — never the `platform-probe` singleton (which
        // answers with HUB hardware from a forked agent child).
        hwaccel: this.hwaccel ?? undefined,
        cameraStreamLookup: (deviceId) => this.getCameraStreamsForDevice(deviceId),
        rtspEntryLookup: (brokerId) => {
          // IN-PROCESS consumer: rides the internal alias of a camera whose
          // external token is held back (D870), never the consumer URL.
          const entry = this.rtspProvider.getInternalEntry(brokerId)
          // `mutedUrl` rides along: an `audio: 'none'` consumer (the decode
          // worker) must dial the `/muted` path, which is what makes the
          // restreamer treat it as a LOCAL DECODER rather than a viewer.
          return entry ? { url: entry.url, mutedUrl: entry.mutedUrl } : null
        },
        resolveProfileSource: (deviceId, profile) =>
          this.assignments.get(deviceId)?.map[profile] ?? null,
        ffmpegConfig: () => this.ffmpegConfig,
        onFfmpegMissing: () => this.reportFfmpegMissing(),
        resolveStreamHwAccel: (deviceId, camStreamId) =>
          this.getStreamHwAccelOverride(deviceId, camStreamId),
        // ONE authority on "may this camera be dialled in sentry?" — the same
        // `sentryEligible` the prestream provider gates on, asked of the same
        // facts. A consumer (the composite camera, which must compose a battery
        // source without waking it) is handed the ANSWER on the acquisition
        // rather than re-deriving the rule from cap bindings of its own.
        sentryOffered: async (deviceId: number) =>
          sentryEligible({
            batteryOperated: await this.isBatteryOperated(deviceId),
            declaresSignals: (await this.declaredSignalCodes(deviceId)).length > 0,
          }).eligible,
        // Create + register the egress restreamer on the main listen server.
        // Holds the concrete `RtspRestreamer` here so no cast is needed at the
        // listen-server boundary; the egress only sees the structural `*Like`.
        acquireChannel: (brokerId): EgressChannel => {
          const restreamer = new RtspRestreamer(brokerId)
          const token = this.rtspServer.registerRestreamer(brokerId, restreamer)
          return {
            restreamer,
            consumerUrl: `rtsp://127.0.0.1:${this.rtspProvider.getRtspPort()}/${token}`,
            release: () => {
              this.rtspServer.unregisterRestreamer(brokerId)
              restreamer.destroy()
            },
          }
        },
      })
    }
    return this.transcodeManager
  }

  // ── Cap methods: getStreamWithCodec / releaseStreamWithCodec ─────────

  async getStreamWithCodec(input: GetStreamWithCodecInput): Promise<RtpSource> {
    // A profile assigned to `derived:*` has no camera pull URL. Acquire still
    // returns the broker restream, but the push broker produces nothing until
    // its transcode feeder is attached — do that before the caller dials.
    if (input.profile !== undefined) {
      const camStreamId = this.assignments.get(input.deviceId)?.map[input.profile]
      if (camStreamId) await this.ensureDerivedReady(input.deviceId, camStreamId)
    }
    const source = await this.getTranscodeManager().acquire(input)
    // The transcode/passthrough pipeline is refcounted and shared across
    // consumers, so the restream `url` it mints is hub-local (`127.0.0.1`).
    // `input.hostname` is purely a per-consumer dial-address rewrite — the
    // shared restreamer (bound on 0.0.0.0) is the same regardless — so apply
    // it here, outside the shared pipeline, rather than baking a host into the
    // shared entry. Absent/empty hostname leaves the hub-local URL untouched.
    if (input.hostname !== undefined && input.hostname.length > 0) {
      return { ...source, url: substituteRtspHost(source.url, input.hostname) }
    }
    return source
  }

  async releaseStreamWithCodec(input: {
    pipelineKey: string
  }): Promise<{ released: boolean; refcount: number }> {
    return this.getTranscodeManager().release(input.pipelineKey)
  }

  // ── Cap methods: acquireEgressTranscode / releaseEgressTranscode ─────
  //
  // THE ffmpeg primitive (D67). One method through which every live-media
  // consumer asks for an encoded stream, refcounted and deduplicated on EXACT
  // match, with an IMMUTABLE handle. See `egress-transcode-manager.ts` for the
  // sharing and refcount contract, and `docs/decisions/adr-0067.md` for what
  // still has to be true before a transcode runs off-hub.
  //
  // Placement is a CALLER-side `nodePin`: `stream-broker` is `any-node`, and
  // `classifyCapRoute` serves an unpinned call hub-in-process, so nothing here
  // may assume hub-locality. The one hub-local thing — the `127.0.0.1` restream
  // url — is rewritten per caller from `hostname`, inside the manager.

  /**
   * Lazily create the egress-transcode manager, wired with closures rather
   * than direct refs so it only sees the surface it needs. Shares the same
   * `acquireChannel` shape as the transcode pool: an `RtspRestreamer`
   * registered on the broker's main listen server under a consumer token.
   */
  private getEgressTranscodeManager(): EgressTranscodeManager {
    if (!this.egressTranscodeManager) {
      const createEgressChild = this.createEgressChild
      this.egressTranscodeManager = new EgressTranscodeManager({
        logger: this.logger.child('egress-transcode'),
        ...(createEgressChild === null ? {} : { createChild: createEgressChild }),
        cameraStreamLookup: (deviceId) => this.getCameraStreamsForDevice(deviceId),
        resolveProfileSource: (deviceId, profile) =>
          this.assignments.get(deviceId)?.map[profile] ?? null,
        rtspEntryLookup: (brokerId) => {
          // IN-PROCESS consumer: rides the internal alias of a camera whose
          // external token is held back (D870), never the consumer URL.
          const entry = this.rtspProvider.getInternalEntry(brokerId)
          return entry ? { url: entry.url } : null
        },
        // Three-way, and the third value is the one that matters: a COLD idle
        // source answers `null` — not "no media" but "waiting here cannot
        // help", because the ffmpeg child's dial is the demand that starts a
        // lazy publisher's wake. See `sourceWaitState`.
        sourceHasMedia: (brokerId) => {
          const broker = this.brokers.get(brokerId)
          if (broker === undefined) return null
          return sourceWaitState({
            hasMedia: broker.getLastPacketAt() > 0,
            materializing: broker.isMaterializing(),
          })
        },
        ffmpegConfig: () => this.ffmpegConfig,
        onFfmpegMissing: () => this.reportFfmpegMissing(),
        ...(this.costRegistry === null ? {} : { costRegistry: this.costRegistry }),
        resolveDecodeHwAccel: (deviceId, override) => this.resolveEgressHwAccel(deviceId, override),
        acquireChannel: (brokerId): EgressChannel => {
          const restreamer = new RtspRestreamer(brokerId)
          const token = this.rtspServer.registerRestreamer(brokerId, restreamer)
          return {
            restreamer,
            consumerUrl: `rtsp://127.0.0.1:${this.rtspProvider.getRtspPort()}/${token}`,
            release: () => {
              this.rtspServer.unregisterRestreamer(brokerId)
              restreamer.destroy()
            },
          }
        },
        publishPushStream: async (input): Promise<EgressPushSink | null> => {
          // `autoEligible: false` is load-bearing, not tidiness: a consumer's
          // private egress must never become a camera's published stream. That
          // is the co-tenant hazard the derived stream had — publicly
          // selectable, so a browser viewer or the recorder could attach and
          // one consumer's downgrade dragged them all down.
          await this.publishCameraStream({
            deviceId: input.deviceId,
            camStreamId: input.camStreamId,
            kind: 'push-annexb',
            codec: input.codec,
            ...(input.width > 0 && input.height > 0
              ? { resolution: { width: input.width, height: input.height } }
              : {}),
            autoEligible: false,
            label: 'egress',
            // BROKER-OWNED: a provider's `stream-catalog` can never contain
            // this stream, so the reconcile sweep must not read its absence as
            // a removal. It did, and the sweep retracted a live egress out from
            // under a refcounted entry 13 s into every Alexa session — ffmpeg
            // kept encoding into a dropped sink and every later offer failed
            // with "No broker for stream". Same shape as the 618 derived bug.
            brokerOwned: true,
          })
          const broker = (): StreamBroker | undefined =>
            this.brokerFor(input.deviceId, input.camStreamId)
          // The on-demand broker's two states, each announced ONCE PER BROKER
          // GENERATION. Dropping packets before any consumer attached is
          // correct; still dropping them ten seconds in is the failure, and
          // until now both looked exactly the same — like nothing at all. The
          // announcements re-arm when the broker is recreated, because a
          // recovery nothing says reads exactly like the outage continuing.
          let currentBroker: StreamBroker | undefined
          let attachAnnounced = false
          let dropsAnnounced = false
          let droppedPackets = 0
          /**
           * The audio plane is declared ONCE, by the demuxer, at the start of
           * the child's life. A broker minted after that would carry video and
           * no audio for the rest of the session unless the declaration is
           * replayed — so the last one is kept and re-pushed per generation.
           */
          let lastAudioInfo: PushAudioInfo | null = null
          let primedThisResolve = false
          /**
           * The holder is gone and the stream is retracted. The child's reader
           * is destroyed first, but its buffered stdout is still demuxed after
           * that, so the last packets of every teardown arrive at a sink whose
           * broker is deliberately gone. Warning about those would put one
           * "packets are being DROPPED" on the log per NORMAL teardown — the
           * exact line that means a live session is broken.
           */
          let released = false
          const resolveBroker = (): StreamBroker | undefined => {
            primedThisResolve = false
            const b = broker()
            if (b === undefined) {
              if (released) return undefined
              currentBroker = undefined
              attachAnnounced = false
              droppedPackets += 1
              if (!dropsAnnounced) {
                dropsAnnounced = true
                this.logger.warn(
                  'egress push sink: NO broker for the published stream — packets are being DROPPED',
                  {
                    tags: { deviceId: input.deviceId },
                    meta: {
                      camStreamId: input.camStreamId,
                      brokerId: brokerIdFor(input.deviceId, input.camStreamId),
                      droppedPackets,
                    },
                  },
                )
              }
              return undefined
            }
            if (b !== currentBroker) {
              currentBroker = b
              dropsAnnounced = false
              attachAnnounced = false
              if (lastAudioInfo !== null) {
                b.pushAudioInfo(lastAudioInfo)
                primedThisResolve = true
              }
            }
            if (!attachAnnounced) {
              attachAnnounced = true
              this.logger.info(
                'egress push sink: broker RESOLVED — packets now reach the published stream',
                {
                  tags: { deviceId: input.deviceId },
                  meta: {
                    camStreamId: input.camStreamId,
                    brokerId: brokerIdFor(input.deviceId, input.camStreamId),
                    droppedBeforeAttach: droppedPackets,
                    audioReprimed: primedThisResolve,
                  },
                },
              )
              droppedPackets = 0
            }
            return b
          }
          return {
            // Resolved per packet rather than captured: the broker is created
            // on DEMAND, so it does not exist when the stream is published and
            // capturing it here would pin an undefined forever.
            push: (packet) => resolveBroker()?.pushEncodedPacket(packet),
            audioInfo: (info) => {
              // Stored BEFORE resolving so a generation flip on this very call
              // primes the new broker with it — `primedThisResolve` then stops
              // the second, redundant arm (which closes and rebuilds the codec
              // session).
              lastAudioInfo = info
              const b = resolveBroker()
              if (b !== undefined && !primedThisResolve) b.pushAudioInfo(info)
            },
            // The codec ffmpeg actually put in the PMT, against the one the
            // stream was PUBLISHED with. This was `() => undefined`: a stream
            // published as h264 and carrying h265 looked identical to a healthy
            // one, and the only place the disagreement showed was a consumer
            // that could not decode it — as a black picture.
            videoCodec: (codec) => {
              if (normaliseSourceCodec(codec) === normaliseSourceCodec(input.codec)) return
              this.logger.warn(
                'egress push sink: the PMT codec DISAGREES with the published stream record',
                {
                  tags: { deviceId: input.deviceId },
                  meta: {
                    camStreamId: input.camStreamId,
                    declared: input.codec,
                    identified: codec,
                  },
                },
              )
            },
            release: async () => {
              released = true
              await this.retractCameraStream({
                deviceId: input.deviceId,
                camStreamId: input.camStreamId,
              })
            },
          }
        },
        onDecodeHwAccelFailed: (backend) => {
          // A backend that could not produce ONE packet in THIS process. The
          // verdict is QUARANTINED rather than written into the read-cadence
          // memo: that memo expires in a minute and the decoder then answers
          // `vaapi` again, so every cold child a minute later re-paid the same
          // ~3 s death — seven times on 101 between 22:17 and 22:52 on
          // 2026-08-07, on a hub where it has never once succeeded from this
          // runner.
          //
          // Deliberately NOT a fix for WHY it fails: `-hwaccel vaapi` creates a
          // device for the decoder addon (ten concurrent 4K decodes on this
          // hub) and returns ENOMEM here (`code=244`, "Device creation failed:
          // -12"). That is an open question; this only stops it costing every
          // session.
          const verdict = this.deadDecodeBackends.markDead(backend)
          this.logger.warn(
            'egress transcode: decode backend FAILED in this process — QUARANTINED, software until it is re-probed',
            {
              meta: {
                backend,
                failures: verdict.failures,
                quarantineMs: verdict.quarantineMs,
              },
            },
          )
        },
        onDecodeHwAccelSucceeded: (backend) => {
          if (this.deadDecodeBackends.failuresOf(backend) === 0) return
          this.deadDecodeBackends.markAlive(backend)
          this.logger.info(
            'egress transcode: decode backend RECOVERED in this process — the quarantine is lifted',
            { meta: { backend } },
          )
        },
      })
    }
    return this.egressTranscodeManager
  }

  /**
   * Decode hardware for an egress transcode, through the ONE ranking known to
   * work on this hardware.
   *
   * `resolveEgressDecodeHwAccel` reads the DECODER ADDON's per-node
   * `probedBestHwaccel` and deliberately never re-derives a ranking: the raw
   * kernel resolver returns `['qsv','vaapi']` on an Intel host — qsv FIRST —
   * while the decoder addon puts vaapi above qsv on purpose, because on this
   * hub a qsv decode child exits `code=171` producing no frames. The kernel
   * resolver is read only to NAME that disagreement in the fallback log.
   *
   * Hardware is the DEFAULT, and every software outcome is announced at `warn`
   * with `tags: { deviceId }` — a silent fall back to software here is a flow
   * bug, not a capability limit (vaapi does 10 concurrent 4K decodes on this
   * hub).
   */
  private async resolveEgressHwAccel(
    deviceId: number,
    override: string | undefined,
  ): Promise<string | null> {
    const resolved = await resolveWithQuarantine({
      resolve: () => this.readEgressHwAccel(deviceId, override),
      dead: this.deadDecodeBackends,
    })
    if (resolved.veto !== null) {
      // A branch that silently downgrades reads as "hardware was used" — the
      // exact failure `resolveEgressDecodeHwAccel` exists to make loud. Said
      // once per child, naming the remaining window so an operator can tell
      // "quarantined here" from "this node has no accelerator".
      this.logger.warn(
        'egress transcode: decoding in SOFTWARE — the backend is QUARANTINED after failing in this process',
        {
          tags: { deviceId },
          meta: {
            backend: resolved.veto.backend,
            failures: resolved.veto.failures,
            remainingMs: resolved.veto.remainingMs,
          },
        },
      )
    }
    return resolved.backend
  }

  /** The decoder addon's answer for this node — before the process quarantine. */
  private async readEgressHwAccel(
    deviceId: number,
    override: string | undefined,
  ): Promise<string | null> {
    return resolveEgressDecodeHwAccel({
      readDecoderBackend: async () => {
        const api = this.api
        if (!api) throw new Error('decoder cap not reachable from this broker')
        // Pinned to THIS node: the answer is this node's own decode probe, and
        // an unpinned singleton call would resolve to the cluster-elected
        // decoder, which may be another node's.
        const pin = this.localNodeId ? nodePin(this.localNodeId) : undefined
        const info = await api.decoder.getInfo.query(undefined, pin)
        return info.probedBestHwaccel ?? ''
      },
      readKernelPreferred: async () => {
        if (!this.hwaccel) return []
        return (await this.hwaccel.resolve(null)).preferred
      },
      onFallback: (fallback) => {
        this.logger.warn(
          'egress transcode: decoding in SOFTWARE — the hub has working hardware decode',
          {
            tags: { deviceId },
            meta: {
              reason: fallback.reason,
              // Reported so an operator can SEE the disagreement. Never used to
              // select: the kernel's qsv-first order is the known-bad one.
              kernelPreferred: fallback.kernelPreferred,
              error: fallback.error,
            },
          },
        )
      },
      ...(override !== undefined ? { override } : {}),
      cache: this.egressHwAccelCache,
    })
  }

  async acquireEgressTranscode(input: EgressTranscodeRequest): Promise<EgressTranscode> {
    return this.getEgressTranscodeManager().acquire(input)
  }

  async releaseEgressTranscode(input: {
    pipelineKey: string
  }): Promise<{ released: boolean; refcount: number }> {
    return this.getEgressTranscodeManager().release(input)
  }

  // ── Setters (wiring from the addon) ──────────────────────────────────

  /**
   * Wire the addon's `ctx.api` proxy — the broker's route to other caps
   * (the stream catalog, the decoder's per-node hwaccel probe, …).
   */
  setApiAccess(api: AddonApi, localNodeId?: string, hwaccel?: IKernelHwAccel): void {
    this.api = api
    if (localNodeId !== undefined) this.localNodeId = localNodeId
    if (hwaccel !== undefined) this.hwaccel = hwaccel
  }

  /**
   * Update the node's ffmpeg config snapshot. Every broker READS it per dial
   * ({@link bindBrokerFfmpeg}), so a re-resolved binary reaches live brokers —
   * including one created while the re-resolve was in flight — with no copy to
   * fan out (D540).
   */
  setFfmpegConfig(cfg: FfmpegSystemConfig): void {
    this.ffmpegConfig = cfg
  }

  /**
   * Point a broker at the node's LIVE pinned ffmpeg and at the re-resolve
   * request, so its ffmpeg-parser ingress spawns the current binary and a
   * refusal asks for it again.
   */
  bindBrokerFfmpeg(broker: StreamBroker): void {
    broker.setFfmpegBinaryPathSource(() => this.ffmpegConfig.binaryPath)
    broker.setFfmpegMissingHandler(() => this.reportFfmpegMissing())
  }

  /** Who asks for the pinned binary again after a refusal. Set by the addon. */
  private ffmpegMissingHandler: (() => void) | null = null

  /** Wire the host's re-resolve (`FfmpegReresolver.request`). */
  setFfmpegMissingHandler(handler: () => void): void {
    this.ffmpegMissingHandler = handler
  }

  /** A child was refused for want of the pinned ffmpeg: ask the host again. */
  private reportFfmpegMissing(): void {
    this.ffmpegMissingHandler?.()
  }

  /**
   * The decode `hwaccel` options surfaceable in a (future) UI: the always-valid
   * settings (`copy`, `auto`, `none`) plus the concrete hardware backends THIS
   * node can use, resolved from the LOCAL `ctx.kernel.hwaccel` (os.platform +
   * GPU-vendor probe), ranked so vaapi precedes qsv. Node-local — never the
   * `platform-probe` singleton (which answers with the hub's methods from a
   * forked agent broker). Best-effort: no resolver / error → always-valid only.
   */
  async getHwAccelOptions(): Promise<readonly FfmpegHwAccelSetting[]> {
    const always: readonly FfmpegHwAccelSetting[] = ['copy', 'auto', 'none']
    if (!this.hwaccel) return always
    try {
      const res = await this.hwaccel.resolve(null)
      const probed = rankDecodeHwAccels(res.preferred, []).filter((m): m is FfmpegHwAccelSetting =>
        (FFMPEG_HW_ACCEL_SETTINGS as readonly string[]).includes(m),
      )
      return [...always, ...probed]
    } catch (err) {
      this.logger.warn('getHwAccelOptions: local hwaccel resolve failed — static options only', {
        meta: { error: errMsg(err) },
      })
      return always
    }
  }

  /**
   * The cluster-wide prebuffer SECONDS — the only duration in this subsystem
   * (D381). Pushed into every live broker, because a broker created before the
   * edit would otherwise keep the old retention for the life of the stream.
   */
  setDefaultPreBufferSec(sec: number): void {
    this.defaultPreBufferSec = sec
    this.pushPrebufferToLiveBrokers()
  }

  /**
   * Set the cluster-wide default join-burst span bound and push the newly
   * effective value into every live broker.
   *
   * The push is needed because a broker outlives the setting: it is created on
   * the first dial and reused for the life of the stream, so a cluster edit
   * that only changed the field here would apply to cameras published
   * afterwards and to no others.
   */
  setDefaultJoinBurstMaxSpanMs(ms: number): void {
    this.defaultJoinBurstMaxSpanMs = ms
    for (const [brokerId, broker] of this.brokers) {
      const parsed = parseBrokerId(brokerId)
      if (!parsed) continue
      this.applyJoinBurstBound(broker, parsed.deviceId, parsed.camStreamId)
    }
  }

  /**
   * Resolve and install this stream's join-burst bound. Applies to the RTSP
   * RESTREAM consumers only — the WebRTC bootstrap reads the broker's
   * pre-buffer ring directly and is deliberately exempt (D57).
   */
  private applyJoinBurstBound(broker: StreamBroker, deviceId: number, camStreamId: string): void {
    broker.setJoinBurstBound(
      resolveJoinBurstBound({
        camStreamId,
        clusterMaxSpanMs: this.defaultJoinBurstMaxSpanMs,
        overrides: this.deviceOverrides.get(deviceId)?.joinBurstMaxSpanMs,
      }),
    )
  }

  /**
   * Set the cluster-wide default prebuffer SECONDS and push the newly
   * effective configuration into every live broker — a broker outlives the
   * setting that configured it, so an un-pushed edit would apply to cameras
   * published afterwards and to no others.
   */
  private pushPrebufferToLiveBrokers(): void {
    for (const [brokerId, broker] of this.brokers) {
      const parsed = parseBrokerId(brokerId)
      if (!parsed) continue
      this.applyPrebufferConfig(broker, parsed.deviceId, parsed.camStreamId)
    }
  }

  setEventBus(bus: IEventBus): void {
    this.eventBus = bus
    this.startStreamHealthWatchdog()
    this.subscribePlaceholderStateSources(bus)
    this.subscribeIngestOwnerChanges(bus)
  }

  /**
   * Track the cluster camera-source owner from the orchestrator's pushed
   * `PipelineIngestOwnerChanged` events instead of polling `getIngestOwner`
   * on every `ensureBroker`. The orchestrator re-emits on every node-capability
   * refresh (boot / agent online-offline / ingest flip), so this keeps the
   * ingest-owner gate current and prompt; the query in {@link isLocalIngestOwner}
   * survives only as a cold-start + long-backstop reconcile (loss-safety).
   */
  private subscribeIngestOwnerChanges(bus: IEventBus): void {
    bus.subscribe({ category: EventCategory.PipelineIngestOwnerChanged }, (event: SystemEvent) => {
      if (!isEvent(event, EventCategory.PipelineIngestOwnerChanged)) return
      const { ownerNodeId } = event.data
      const changed = this.cachedIngestOwnerNodeId !== ownerNodeId
      // Update the cache BEFORE any teardown so a concurrent `ensureBroker`
      // reads the new owner (and the gate denies re-creation on a now-non-owner).
      this.cachedIngestOwnerNodeId = ownerNodeId
      this.cachedIngestOwnerAt = Date.now()
      if (changed) {
        // Re-arm the one-shot non-owner skip log so a topology shift
        // re-surfaces the gate decision once under the new ownership.
        this.nonOwnerSkipLogged.clear()
        this.logger.debug('ingest owner changed (pushed)', {
          meta: { ownerNodeId, self: this.localNodeId },
        })
      }
      // Reverse-flip teardown: if THIS node just stopped being the owner, drop
      // its physical source brokers so it no longer dials the cameras (the new
      // owner does). Without this the old owner keeps its connections open —
      // a lingering double-pull. Fire-and-forget from the sync bus handler; the
      // promise is retained for deterministic testing.
      this.lastOwnershipReconcile = this.reconcileOwnershipTeardown()
    })
  }

  /**
   * Tear down every LOCAL physical source broker when this node is no longer the
   * cluster ingest owner. `this.brokers` holds only physical source + derived
   * brokers (the `RemoteEncodedSourceBroker` restream adapters a non-owner uses
   * live in the separate `remoteBrokerAdapters` map, so they are untouched).
   * Re-creation is blocked by the ingest-owner gate on this node; the node's
   * consumers re-source from the new owner's restream via the orchestrator's
   * re-dispatch. No-op when this node IS the owner or holds no brokers, so a
   * repeated same-owner re-emit is cheap.
   */
  private async reconcileOwnershipTeardown(): Promise<void> {
    if (this.localNodeId === null) return
    if (this.cachedIngestOwnerNodeId === null) return
    if (this.cachedIngestOwnerNodeId === this.localNodeId) return
    if (this.brokers.size === 0) return

    // Snapshot the ids up front — releaseBroker mutates `this.brokers`.
    const brokerIds = [...this.brokers.keys()]
    this.logger.info('ingest owner moved away — tearing down local physical brokers', {
      meta: {
        owner: this.cachedIngestOwnerNodeId,
        self: this.localNodeId,
        count: brokerIds.length,
      },
    })
    for (const brokerId of brokerIds) {
      const parsed = this.parseBrokerId(brokerId)
      if (!parsed) continue
      await this.releaseBroker(parsed.deviceId, parsed.camStreamId).catch((err: unknown) => {
        this.logger.warn('reverse-flip teardown: releaseBroker failed', {
          meta: { brokerId, error: errMsg(err) },
        })
      })
    }
  }

  /**
   * Subscribe to the cap-scoped bus events that drive the per-broker
   * placeholder image. Lives in the manager (not the broker) because
   * a single device can host multiple brokers (`high`/`mid`/`low`)
   * and one listener fans out to all of them. Lives at the broker
   * layer (not the provider) because providers must stay oblivious
   * to the placeholder pipeline — they only mutate their runtime-
   * state slices.
   *
   * Each cap defines its own state-change event (`BatteryStatus`
   * surfaces `battery.onStatusChanged`), wired automatically by the
   * `subscribeCap('battery')` bridge in the provider's
   * `registerBatteryIfSupported`. We subscribe to the cap event
   * directly rather than the catch-all `device.state-changed`
   * firehose so we don't filter the entire device-state stream
   * client-side and we get a typed payload.
   */
  /**
   * Build the per-broker SENTRY provider — the fill for the window between
   * "someone asked for this camera" and "the camera is awake".
   *
   * On this hub that window is 2.2-12.4 s for a lazy source, and it is not
   * merely ugly: Amazon allows SIX SECONDS for an Alexa SDP answer, so a cold
   * battery camera could not answer an Echo at all.
   *
   * Four facts are needed and all four are the manager's, which is why the
   * provider is a closure here rather than anything the broker knows about:
   * the probed geometry and codec ({@link planPrestream}), the camera's last
   * cached snapshot, its name, and the ffmpeg binary path.
   *
   * `null` is a REFUSAL, named in the log. Refusing is cheap — the consumer
   * gets the black screen it got before the sentry existed — and the
   * alternative for an unknown geometry is the decoder freeze the whole
   * synthetic-frame path is shaped around.
   */
  private buildPrestreamProvider(
    deviceId: number,
    camStreamId: string,
    brokerId: string,
    logger: IScopedLogger,
  ): SentryProvider {
    return {
      prepare: async ({ sourceUrl }) => {
        // THE GATE, and it is deliberately narrow: a BATTERY camera THAT
        // DECLARES the signals cap. A mains camera has nothing to save by
        // sleeping, and a battery camera with no signals could never be woken
        // — a sentry consumer would hold a session open against a stream
        // that is permanently a photograph. Both facts are asked; an
        // unanswerable question is a no (`sentry-eligibility.ts`).
        const gate = sentryEligible({
          batteryOperated: await this.isBatteryOperated(deviceId),
          declaresSignals: (await this.declaredSignalCodes(deviceId)).length > 0,
        })
        if (!gate.eligible) {
          logger.info('sentry: not offered for this camera', {
            tags: { deviceId },
            meta: { brokerId, reason: gate.reason },
          })
          return null
        }
        const stream = this.cameraStreams.get(deviceId)?.get(camStreamId)
        // The PROBED codec wins over the declared one: it is what the real
        // stream will actually arrive in, and a sentry in the other codec
        // is a stream the consumer cannot decode at all.
        const codec = this.lastProbedByBroker.get(brokerId)?.codec ?? stream?.codec
        const planned = planPrestream({
          sourceUrl,
          width: stream?.resolution?.width,
          height: stream?.resolution?.height,
          codec,
        })
        if ('refusal' in planned) {
          logger.info('sentry: no fill for this camera', {
            tags: { deviceId },
            meta: {
              refusal: planned.refusal,
              camStreamId,
              width: stream?.resolution?.width ?? null,
              height: stream?.resolution?.height ?? null,
              codec: codec ?? null,
            },
          })
          return null
        }
        return await this.preparePrestreamFrame(deviceId, brokerId, planned.plan, logger)
      },
      /**
       * REFRESH THE PICTURE WHILE THE CAMERA IS UP.
       *
       * The window shows the camera's last snapshot, and nothing was
       * refreshing it: a battery camera refuses a capture while it believes
       * itself asleep, and that belief lags the wake by seconds — so the only
       * attempts ever made were the sentry's own, while composing, which is
       * BEFORE any media exists. Measured on device 106 (2026-09-16): four
       * wakes in forty minutes, the encoded picture `bytes=23912` every time,
       * and between first packet and suspend not one capture was even
       * attempted. The operator read the result as a placeholder rather than
       * as their own room, which is exactly what it had become.
       *
       * Here the camera is provably awake and its media is flowing, so a
       * capture costs it nothing it is not already paying — and what lands is
       * a scene from the event that just happened.
       *
       * NEVER `force`: it is an operator signal, and the rule holds even where
       * it would be harmless. If the native path still refuses, the addon's
       * own stream-broker fallback pulls a frame from the restream that is, by
       * construction, running right now.
       *
       * Fire and forget, and a failure is DEBUG: the window already has a
       * picture to show, and this only decides how recent the NEXT one is.
       */
      onRealMediaStarted: () => {
        const api = this.api
        if (!api) return
        void api.snapshot.getSnapshot
          .query({ deviceId })
          .then(() => {
            logger.debug('sentry: picture refreshed from the live window', {
              tags: { deviceId },
              meta: { brokerId },
            })
          })
          .catch((err: unknown) => {
            logger.debug('sentry: live-window refresh failed — keeping the older picture', {
              tags: { deviceId },
              meta: { brokerId, error: errMsg(err) },
            })
          })
      },
    }
  }

  /**
   * Fetch the picture, compose the treatment, encode ONCE and cache the bytes.
   *
   * The cache is keyed on the picture's own digest plus the geometry, so a
   * second wake of the same camera re-uses the frame and spawns nothing: the
   * picture changes at most hourly, and a fork+exec per wake per sleeping
   * camera is the cost this shape exists to avoid.
   */
  private async preparePrestreamFrame(
    deviceId: number,
    brokerId: string,
    plan: SentryPlan,
    logger: IScopedLogger,
  ): Promise<SentryFrame | null> {
    if (!this.api) {
      logger.info('sentry: no api access — the window goes unfilled', {
        tags: { deviceId },
      })
      return null
    }
    const api = this.api

    // NEVER `force`. `force` is an operator signal and the one thing that walks
    // past the snapshot wrapper's sleep gate — a background caller that sets it
    // wakes the very camera the sentry exists so as not to disturb. The
    // cache is RAM-only, so after a hub restart this legitimately answers
    // nothing and the generated card is the picture.
    let cachedJpeg: Buffer | null = null
    try {
      const image = await api.snapshot.getSnapshot.query({ deviceId })
      if (image) cachedJpeg = Buffer.from(image.base64, 'base64')
    } catch (err) {
      logger.debug('sentry: cached snapshot read failed — falling back to the card', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }

    let deviceName = `#${String(deviceId)}`
    try {
      const device = await api.deviceManager.getDevice.query({ deviceId })
      if (device?.name) deviceName = device.name
    } catch (err) {
      logger.debug('sentry: device name read failed — using the numeric id', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }

    const digest = createHash('sha1')
      .update(cachedJpeg ?? Buffer.alloc(0))
      .update(deviceName)
      .digest('hex')
    const key = `${digest}:${String(plan.width)}x${String(plan.height)}:${plan.codec}`
    const cached = this.sentryFrames.get(brokerId)
    if (cached && cached.key === key) {
      logger.debug('sentry: re-using the encoded frame', {
        tags: { deviceId },
        meta: { bytes: cached.frame.annexB.length },
      })
      return cached.frame
    }

    // SERVE THE LAST PICTURE, REFRESH BEHIND IT.
    //
    // The key carries the snapshot's digest, and a battery camera captures a
    // fresh snapshot during every stream window — so the key changed on every
    // wake and this cache, built to make the second wake free, missed every
    // time. Measured on the Baby monitor: `preparedInMs` 2 540-7 000 ms inside
    // a 2.5-7.4 s window, so the placeholder was ready as the real stream
    // arrived and emitted ONE frame. That is indistinguishable from the
    // sentry not working, and is how it was reported.
    //
    // A placeholder ONE WAKE old is still a picture of this camera, shown for
    // the two to six seconds before real media replaces it. Waiting seven
    // seconds to have a newer one is the worse trade, and it is the whole
    // cost. So an existing frame for a DIFFERENT digest is returned now and
    // the new one is encoded in the background for the next wake — the same
    // serve-and-revalidate the device-details fan-out uses (D224).
    //
    // Only the geometry must still agree: a frame of the wrong size does not
    // decode, so `key` is compared on its geometry+codec half.
    const cachedGeometry = cached ? cached.key.slice(cached.key.indexOf(':')) : null
    const wantedGeometry = key.slice(key.indexOf(':'))
    if (cached && cachedGeometry === wantedGeometry) {
      logger.info('sentry: serving the previous picture while the new one encodes', {
        tags: { deviceId },
        meta: { bytes: cached.frame.annexB.length },
      })
      void this.encodePrestreamInBackground(
        deviceId,
        brokerId,
        plan,
        key,
        cachedJpeg,
        deviceName,
        logger,
      )
      return cached.frame
    }

    return await this.composeAndEncodePrestream(
      deviceId,
      brokerId,
      plan,
      key,
      cachedJpeg,
      deviceName,
      logger,
    )
  }

  /**
   * Compose the treatment and encode ONE IDR, then cache it under `key`.
   *
   * Split out so the wake path and the background refresh share it byte for
   * byte — two encoders that drifted apart would put two different pictures in
   * front of the operator depending on which wake they caught.
   */
  private async composeAndEncodePrestream(
    deviceId: number,
    brokerId: string,
    plan: SentryPlan,
    key: string,
    cachedJpeg: Buffer | null,
    deviceName: string,
    logger: IScopedLogger,
  ): Promise<SentryFrame | null> {
    const picture = await composePrestreamPicture({
      cachedJpeg,
      deviceName,
      width: plan.width,
      height: plan.height,
      logger,
      deviceId,
    })
    // WHICH of the two was used, per camera. They look identical to a consumer
    // and mean opposite things to an operator: one says the cache is warm, the
    // other says it is cold.
    logger.info('sentry: picture composed', {
      tags: { deviceId },
      meta: {
        source: picture.source,
        // What the picture SAYS the camera is doing. A stale tile is always
        // asked about as "what did we think was happening", and until now the
        // answer lived only in pixels.
        reason: picture.reason,
        width: plan.width,
        height: plan.height,
        codec: plan.codec,
      },
    })

    let annexB: Buffer
    try {
      annexB = await encodePrestreamIdr({
        ffmpegPath: requireBrokerFfmpeg(this.ffmpegConfig.binaryPath, {
          logger,
          deviceId,
          purpose: 'sentry pre-stream encode',
          onMissing: () => this.reportFfmpegMissing(),
        }),
        plan,
        jpeg: picture.jpeg,
        logger,
        deviceId,
      })
    } catch (err) {
      logger.warn('sentry: encode failed — the window goes unfilled', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return null
    }

    const frame: SentryFrame = { annexB, codec: plan.codec }
    this.sentryFrames.set(brokerId, { key, frame })
    return frame
  }

  /**
   * Encode the CURRENT picture for the NEXT wake, off the wake path.
   *
   * Single-flight per broker: a camera that wakes twice inside one encode must
   * not spawn a second ffmpeg — that is CPU taken from the live stream the
   * operator is actually waiting for.
   */
  private encodePrestreamInBackground(
    deviceId: number,
    brokerId: string,
    plan: SentryPlan,
    key: string,
    cachedJpeg: Buffer | null,
    deviceName: string,
    logger: IScopedLogger,
  ): void {
    if (this.sentryRefreshing.has(brokerId)) return
    this.sentryRefreshing.add(brokerId)
    void this.composeAndEncodePrestream(
      deviceId,
      brokerId,
      plan,
      key,
      cachedJpeg,
      deviceName,
      logger,
    )
      .catch(() => {
        // A refresh that did not happen leaves the previous picture standing,
        // which is the outcome this whole path exists to guarantee.
      })
      .finally(() => {
        this.sentryRefreshing.delete(brokerId)
      })
  }

  private subscribePlaceholderStateSources(bus: IEventBus): void {
    bus.subscribe({ category: EventCategory.BatteryOnStatusChanged }, (event: SystemEvent) => {
      const data = event.data as {
        deviceId?: unknown
        status?: { sleeping?: unknown; lastContactAt?: unknown } | null
      }
      const deviceId = typeof data.deviceId === 'number' ? data.deviceId : null
      if (deviceId === null) return
      // Slice may be `undefined` (cap slice cleared) or `null` (slice
      // dropped); both map to "no longer sleeping" — fall back to the
      // generic reconnecting placeholder.
      const sleeping = data.status?.sleeping === true
      this.recordBatterySleep(deviceId, data.status)
      this.applyPlaceholderReasonToDevice(deviceId, sleeping ? 'sleeping' : 'reconnecting')
    })

    // Wake-up window: between the Baichuan wake-up issue and the
    // camera's first dialed-back RTP packet. Surfaces as a labelled
    // "WAKING UP" tile (`'waking'` placeholder reason) on encoded-path
    // subscribers (H.264 sessions, derived-broker pipelines). The
    // H.265 RTP repacketizer path still drops placeholders to avoid
    // freezing Chrome's HEVC decoder — see `BrokerWebrtcServer`'s
    // useRtpRepacketizer guard. The reason snaps back via the
    // subsequent `BatteryOnStatusChanged { sleeping: false }` event,
    // or implicitly once the first real packet flips the broker's
    // status to `'streaming'`.
    bus.subscribe({ category: EventCategory.BatteryOnWakeStarted }, (event: SystemEvent) => {
      const data = event.data as { deviceId?: unknown }
      const deviceId = typeof data.deviceId === 'number' ? data.deviceId : null
      if (deviceId === null) return
      this.applyPlaceholderReasonToDevice(deviceId, 'waking')
    })

    const handlerForReason = (reason: PlaceholderReason) => (event: SystemEvent) => {
      const data = event.data as { deviceId?: unknown }
      const deviceId = typeof data.deviceId === 'number' ? data.deviceId : null
      if (deviceId === null) return
      this.applyPlaceholderReasonToDevice(deviceId, reason)
    }
    bus.subscribe({ category: EventCategory.DeviceOffline }, handlerForReason('offline'))
    bus.subscribe({ category: EventCategory.DeviceDisabled }, handlerForReason('disabled'))
  }

  setWebrtcServer(server: import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer): void {
    this.webrtcServer = server
    // Inject the assignments-aware tier resolver so the WebRTC adaptive
    // bitrate logic can map cam-stream-keyed brokers back to their
    // current profile tier ('high'/'mid'/'low'). Without this, all
    // candidates appear "untiered" and `prefersTier` hints fall through
    // to the order-based pick.
    server.setProfileTierResolver((brokerId) =>
      resolveBrokerTier(
        brokerId,
        (id) => {
          const parsed = this.parseBrokerId(id)
          if (!parsed) return null
          return findProfileForStream(
            this.assignments.get(parsed.deviceId)?.map ?? {},
            parsed.camStreamId,
          )
        },
        this.remoteBrokerTiers,
      ),
    )
    // Where a broker's media is INGESTED, for the stream-debug overlay. The
    // manager owns the ownership map, so the WebRTC server asks rather than
    // keeping a second copy (D224). A broker with no remote adapter is served
    // from this node; one with an adapter is fed across a node boundary, and
    // the owner is whatever the last `IngestOwnerChanged` said — `null` when
    // nothing has said yet, because an unresolved owner must not render as
    // "local" in a tool an operator uses to decide where to look.
    server.setStreamOriginResolver((brokerId) => {
      if (this.remoteBrokerAdapters.has(brokerId)) {
        return {
          ingestNodeId: this.cachedIngestOwnerNodeId,
          ingestIsRemote: true,
        }
      }
      if (this.localNodeId === null) return { ingestNodeId: null, ingestIsRemote: null }
      return { ingestNodeId: this.localNodeId, ingestIsRemote: false }
    })
    // THE ffmpeg primitive for the WebRTC transcode leg (D67). The call is
    // deliberately IN-PROCESS rather than through `ctx.api`: the leg and the
    // egress manager live in the same runner, `classifyCapRoute` would serve an
    // unpinned cap call hub-in-process anyway, and going out over tRPC would
    // additionally depend on the INSTALLED `@camstack/system` carrying the D67
    // method. Placement of a transcode remains a caller-side `nodePin` on the
    // cap — nothing here forecloses it.
    server.setEgressTranscodeProvider({
      acquire: (request) => this.acquireEgressTranscode(request),
      release: (input) => this.releaseEgressTranscode(input),
    })
    // Ensure the wanted tier's remote adaptive broker is registered before
    // the server resolves an ADAPTIVE stream (Slice 3b Task 4 wiring).
    // `ensureRemoteAdaptiveTierBroker` no-ops for a locally-owned device, so
    // this is a no-op call on the byte-identical-today path.
    server.setEnsureAdaptiveTierBrokerHook((deviceId, tier) =>
      this.ensureRemoteAdaptiveTierBroker(deviceId, tier),
    )
    // Back-register every broker created BEFORE the server was wired. Addon
    // activation runs `reconcileAllCatalogsAtStartup()` (which creates brokers
    // via ensureBroker → fanOutRegistration) BEFORE this call, so those
    // registrations hit the `if (this.webrtcServer)` guard while it was still
    // undefined and were silently dropped. They live only in `this.brokers`;
    // ensureBroker's `this.brokers.has` short-circuit means no later reconcile
    // ever repairs them — so the WebRTC server would never learn about them and
    // every session for those devices fails with "No broker for stream …".
    // Re-registering here also makes a server swap self-healing.
    // TODO(slice-5): re-register remoteBrokerAdapters on setWebrtcServer swap
    for (const [brokerId, broker] of this.brokers) {
      server.registerBroker(brokerId, broker)
    }
  }

  /**
   * Test/injection seam for the inner broker a `RemoteEncodedSourceBroker`
   * drives (Slice 3 Task 3). Production never calls this — the field default
   * already wraps the real `StreamBroker`. Mirrors the `createBroker`
   * injection point `RemoteEncodedSourceBroker` itself exposes.
   */
  setRemoteEncodedBrokerFactory(factory: CreateStreamBroker): void {
    this.createRemoteEncodedBroker = factory
  }

  /**
   * Test/injection seam for the egress primitive's ffmpeg child. Production
   * never calls this — `EgressTranscodeManager` builds the real child. A spec
   * substitutes a fake so the REAL `publishPushStream` closure (publish, sink,
   * generation re-prime, retract) is exercised without ffmpeg. Must be set
   * before the first acquire; the manager is built lazily and once.
   */
  setEgressChildFactory(factory: (spec: EgressChildSpec) => EgressChild): void {
    this.createEgressChild = factory
  }

  /**
   * Ensure a broker exists for `brokerId` before a WebRTC session subscribes
   * to it (Slice 3 Task 3 — cross-node ingest wiring). Called by
   * `WebrtcSessionProvider.createSession`/`handleOffer` right before they
   * delegate to `BrokerWebrtcServer`.
   *
   * No-op when a LOCAL broker already covers `brokerId` — the
   * default/dormant state while every camera's `ingestNode` is the hub, so
   * this returns on the very first check with ZERO extra calls (byte-
   * identical to today). Otherwise resolves the cluster's camera-source
   * owner (`getIngestOwner`) and branches via `resolveWebrtcSourceMode`:
   *
   *   - `local` → this node IS the owner but hasn't published/registered a
   *     broker for this brokerId (a genuinely missing/misconfigured
   *     stream) — do nothing and let `BrokerWebrtcServer` throw its normal
   *     "No broker for stream" error, unchanged.
   *   - `remote-adapter` → get-or-create a `RemoteEncodedSourceBroker` that
   *     dials the owner's compressed passthrough restream, register its
   *     inner broker with the WebRTC server exactly like a local broker (so
   *     `setupSessionForBroker`'s resolution, tier logic, and everything
   *     downstream see an ordinary `IStreamBroker` — this leg never touches
   *     `broker-webrtc-server.ts`), and tear the adapter down on its own
   *     `onDemandChange(false)` (last-session-idle) edge, mirroring
   *     `attachDerivedFeeder`'s local-broker teardown hook.
   *   - `unresolvable` → the owner is set but has no reachable host —
   *     throw a descriptive error rather than let the session hang.
   *
   * `camStreamId === undefined` (an `adaptive` target with no cam stream
   * pinned yet) can't resolve a single owner profile to acquire — falls
   * through to the natural local-only resolution/error, same as today.
   *
   * `tier` (Slice 3b Task 3) is an optional hint from
   * `ensureRemoteAdaptiveTierBroker` — the profile the caller already
   * resolved `camStreamId` from via `resolveTierSlot`. When set, it is
   * recorded into `remoteBrokerTiers` alongside the adapter registration so
   * `resolveBrokerTier`/`selectBestBroker` can tier-match this brokerId even
   * though it's absent from `this.assignments` (remote-owned). Callers that
   * don't have a resolved tier (the plain WebRTC session path) omit it —
   * unchanged behavior.
   */
  async ensureBrokerForWebrtcSession(
    deviceId: number,
    brokerId: string,
    camStreamId: string | undefined,
    tier?: CamProfile,
  ): Promise<void> {
    // Disabled devices stream nothing — see `disabledDevices` (reconcile mirror).
    if (this.disabledDevices.has(deviceId)) return
    if (this.remoteBrokerAdapters.has(brokerId)) return

    // A stream that is STILL PUBLISHED here is reattachable, full stop. The
    // broker's lifecycle is on-demand — created at publish, torn down by a
    // release, a restart, a disable edge — and an attach arriving after a
    // teardown used to fail with "No broker for stream" forever, because
    // nothing on this path recreates one. That is what made an Alexa
    // re-offer against a live, refcounted egress unrecoverable.
    //
    // `derived:*` used to be skipped here because a naive `ensureBroker`
    // minted a push shell with no transcode feeder ("push source stalled" —
    // the 618 bug). Recreate it WITH the feeder instead of leaving WebRTC
    // attached to an empty push broker.
    if (camStreamId !== undefined) {
      const published = this.cameraStreams.get(deviceId)?.get(camStreamId)
      if (published?.kind === 'derived') {
        await this.ensureDerivedReady(deviceId, camStreamId)
        if (this.brokers.has(brokerId)) return
      }
    }

    if (this.brokers.has(brokerId)) return
    if (camStreamId === undefined) return

    const published = this.cameraStreams.get(deviceId)?.get(camStreamId)
    if (published !== undefined && published.kind !== 'derived') {
      await this.ensureBroker(deviceId, camStreamId)
      if (this.brokers.has(brokerId)) return
    }

    if (!this.api || this.localNodeId === null) return
    const api = this.api
    const ownNodeId = this.localNodeId

    // Single-flight the get-or-create per brokerId: the body below awaits
    // `getIngestOwner` before it reaches `remoteBrokerAdapters.set()`, so two
    // callers racing this method for the SAME brokerId would otherwise both
    // pass the `.has()` guard above. Everything from here to the `.set()`
    // just below is synchronous, so this check-then-store is atomic — no
    // other invocation of this method can interleave.
    const existingEnsure = this.remoteAdapterEnsures.get(brokerId)
    if (existingEnsure) {
      await existingEnsure
      return
    }

    const ensure = this.createRemoteBrokerAdapterForSession(
      api,
      ownNodeId,
      deviceId,
      brokerId,
      camStreamId,
      tier,
    )
    this.remoteAdapterEnsures.set(brokerId, ensure)
    try {
      await ensure
    } finally {
      this.remoteAdapterEnsures.delete(brokerId)
    }
  }

  /** Is a broker (local or remote-adapter) registered for `brokerId` right now?
   *  Synchronous on purpose — the wake-on-play retry has to re-ask this between
   *  two awaits, and an async answer would invite a race the caller cannot see. */
  hasRegisteredBroker(brokerId: string): boolean {
    return this.brokers.has(brokerId) || this.remoteBrokerAdapters.has(brokerId)
  }

  /**
   * Wake-on-play (D173). Called by `WebrtcSessionProvider` when the normal
   * resolution left no broker: if the device is battery-operated, ask the
   * camera to wake, then poll catalog reconciliation + broker resolution
   * through one bounded settle transaction.
   *
   * Throws `BatteryStreamUnavailableError` — naming `sleeping` / `waking` /
   * `unreachable` — instead of letting `BrokerWebrtcServer` answer a healthy,
   * sleeping camera with a flat "No broker for stream". Returns normally (and
   * changes nothing) for a non-battery device, so the pre-existing error path
   * is byte-identical everywhere it used to be right.
   */
  async wakeBatteryDeviceOnPlay(
    deviceId: number,
    brokerId: string,
    camStreamId: string | undefined,
  ): Promise<void> {
    // An ADAPTIVE target (`camStreamId === undefined`, brokerId
    // `<deviceId>/adaptive`) names a sentinel no broker is ever registered
    // under — the WebRTC server resolves it via `selectBestBroker` at offer
    // time. Checking the literal id made the settle loop blind to the brokers
    // its own reconcile had just published: wake ACK'd, brokers registered,
    // and the loop still exhausted 20 s later with "waking" (live hub,
    // 2026-08-15, device 106). For adaptive the answer is "any broker for
    // this device"; for a pinned cam-stream it stays the exact brokerId.
    const demandHasBroker =
      camStreamId === undefined
        ? () => this.hasAnyRegisteredBrokerForDevice(deviceId)
        : () => this.hasRegisteredBroker(brokerId)
    if (demandHasBroker()) return
    if (this.disabledDevices.has(deviceId)) return
    const api = this.api
    if (!api) return
    await this.batteryWakeOnPlay
      .run(deviceId, {
        logger: this.logger,
        isBatteryDevice: (id) => this.isBatteryOperated(id),
        readBatteryFacts: (id) => this.readBatterySleepFacts(id),
        wakeForStream: async (id, timeoutMs) =>
          api.battery.wakeForStream.mutate({ deviceId: id, timeoutMs }),
        reconcileCatalog: (id) => this.reconcileDeviceCatalog(id),
        ensureBroker: () => this.ensureBrokerForWebrtcSession(deviceId, brokerId, camStreamId),
        hasBroker: demandHasBroker,
      })
      .catch((err: unknown) => {
        // A wake somebody asked for that delivered nothing is the one battery
        // failure with no broker to report it (D883): name it, once per device.
        if (err instanceof BatteryStreamUnavailableError) {
          this.announceBatteryWakeFailure(
            deviceId,
            camStreamId,
            err.presence === 'unreachable' ? 'battery-unreachable' : 'wake-timeout',
          )
        }
        throw err
      })
  }

  /** Any broker (local or remote-adapter) registered for this device? The
   *  wake-on-play answer for `adaptive` targets — see the comment in
   *  {@link wakeBatteryDeviceOnPlay}. */
  private hasAnyRegisteredBrokerForDevice(deviceId: number): boolean {
    const prefix = `${String(deviceId)}/`
    for (const id of this.brokers.keys()) {
      if (id.startsWith(prefix)) return true
    }
    for (const id of this.remoteBrokerAdapters.keys()) {
      if (id.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * Single-flight body for `ensureBrokerForWebrtcSession`'s remote-adapter
   * get-or-create — resolves the ingest owner, and for `remote-adapter` mode
   * constructs the `RemoteEncodedSourceBroker`, registers it with the WebRTC
   * server, and wires its idle-teardown hook. Only ever run once per
   * brokerId at a time; see `remoteAdapterEnsures`.
   */
  private async createRemoteBrokerAdapterForSession(
    api: AddonApi,
    ownNodeId: string,
    deviceId: number,
    brokerId: string,
    camStreamId: string,
    tier: CamProfile | undefined,
  ): Promise<void> {
    let owner: IngestOwner
    try {
      owner = await api.pipelineOrchestrator.getIngestOwner.query()
    } catch (err: unknown) {
      this.logger.debug(
        'webrtc-session: getIngestOwner unavailable — defaulting to local (cap not mounted yet?)',
        { tags: { deviceId }, meta: { error: errMsg(err) } },
      )
      owner = { ownerNodeId: ownNodeId }
    }

    const mode = resolveWebrtcSourceMode({
      ownerNodeId: owner.ownerNodeId,
      ownNodeId,
      reachableHost: owner.reachableHost,
    })
    if (mode.kind === 'local') return
    if (mode.kind === 'unresolvable') {
      const configIssueSuffix = owner.configIssue ? ` (${owner.configIssue})` : ''
      throw new Error(
        `webrtc-session: device ${deviceId} is owned by node "${mode.ownerNodeId}" but no reachable host is configured for it — cannot source its WebRTC stream remotely${configIssueSuffix}`,
      )
    }

    const adapter = new RemoteEncodedSourceBroker({
      api,
      logger: this.logger.child('remote-encoded').withTags({ deviceId }),
      deviceId,
      streamId: camStreamId,
      ownerNodeId: mode.ownerNodeId,
      reachableHost: mode.reachableHost,
      createBroker: this.createRemoteEncodedBroker,
    })
    this.remoteBrokerAdapters.set(brokerId, adapter)
    // Task 3: single-sourced tier recording — the ONLY place `remoteBrokerTiers`
    // is populated. `ensureRemoteAdaptiveTierBroker` threads its
    // `resolveTierSlot` result in as `tier`; the plain WebRTC session path
    // (`ensureBrokerAvailable` in device-scoped-providers.ts) never passes
    // one, so this is a no-op there — unchanged behavior.
    if (tier) this.remoteBrokerTiers.set(brokerId, tier)

    let broker: IStreamBrokerWithSourceProvider
    try {
      broker = await adapter.getBroker()
    } catch (err) {
      this.remoteBrokerAdapters.delete(brokerId)
      this.remoteBrokerTiers.delete(brokerId)
      throw err
    }

    this.webrtcServer?.registerBroker(brokerId, broker)

    let unsubscribeDemand: () => void = () => {}
    unsubscribeDemand = broker.onDemandChange((active) => {
      if (active) return
      unsubscribeDemand()
      this.remoteBrokerAdapters.delete(brokerId)
      this.remoteBrokerTiers.delete(brokerId)
      this.webrtcServer?.unregisterBroker(brokerId)
      void adapter.dispose().catch((disposeErr: unknown) => {
        this.logger.warn('webrtc-session: remote-encoded adapter dispose failed', {
          tags: { deviceId },
          meta: { brokerId, error: errMsg(disposeErr) },
        })
      })
    })
  }

  /**
   * Idempotent cleanup for a remote adapter registered by
   * `ensureBrokerForWebrtcSession`. `WebrtcSessionProvider.createSession`/
   * `handleOffer` call this when the downstream `BrokerWebrtcServer`
   * delegate throws AFTER the adapter was already registered.
   *
   * Without this, teardown is driven ONLY by the inner broker's
   * `onDemandChange(true→false)` edge (last-WebRTC-subscriber-leaves). If
   * the delegate never succeeds, demand never reaches `true`, that edge
   * never fires, and the adapter + its WebRTC registration + the owner
   * restream refcount (`releaseStreamWithCodec`) leak permanently.
   *
   * A cheap no-op when no remote adapter exists for `brokerId` — the
   * owner==self / local-broker path never registers one, so this call adds
   * zero behavior there. Also safe if the adapter was already torn down
   * (e.g. a racing `onDemandChange(false)` edge) — `RemoteEncodedSourceBroker
   * .dispose()` is itself idempotent. Dispose failures are logged and
   * swallowed; this method never throws, so callers can always re-throw the
   * original delegate error afterward.
   */
  async disposeRemoteBrokerAdapterIfPresent(brokerId: string): Promise<void> {
    const adapter = this.remoteBrokerAdapters.get(brokerId)
    if (!adapter) return
    this.remoteBrokerAdapters.delete(brokerId)
    this.remoteBrokerTiers.delete(brokerId)
    this.webrtcServer?.unregisterBroker(brokerId)
    try {
      await adapter.dispose()
    } catch (disposeErr: unknown) {
      this.logger.warn(
        'webrtc-session: remote-encoded adapter dispose failed (delegate-failure cleanup)',
        {
          meta: { brokerId, error: errMsg(disposeErr) },
        },
      )
    }
  }

  /**
   * Lazily ensure a remote adapter exists for a device's PREFERRED tier's
   * camStream (Slice 3b Task 3 — adaptive WebRTC live-view for remote-owned
   * cameras, lazy-per-tier). Adaptive-target sessions don't carry a
   * session-pinned camStreamId, so unlike `ensureBrokerForWebrtcSession`
   * this method's own job is resolving WHICH camStreamId the preferred tier
   * maps to on the owning node — via `resolveTierSlot` walking the owner's
   * `listAllProfileSlots` — before delegating to
   * `ensureBrokerForWebrtcSession` for the actual get-or-create (reusing its
   * single-flight guard and idle-teardown wiring unchanged).
   *
   * No-op for a LOCALLY-owned device — `this.assignments` already tracks it
   * and the normal (non-adaptive) resolve path handles it; this returns on
   * the very first check with ZERO extra calls, byte-identical to today.
   *
   * Mirrors `ensureBrokerForWebrtcSession`'s owner-resolution: graceful
   * `getIngestOwner` (defaults to local on failure — cap not mounted yet) +
   * `resolveWebrtcSourceMode`. `local` → return (nothing to do; the normal
   * resolve path already covers this node being the owner). `unresolvable`
   * → throw the same descriptive error rather than let a session hang.
   *
   * When the preferred tier (and every fallback tier) has no assigned slot
   * on the owner, `resolveTierSlot` returns null — this method returns
   * without throwing; the normal WebRTC resolve path will surface its own
   * "no broker for stream" error naturally once a session actually tries to
   * subscribe.
   */
  async ensureRemoteAdaptiveTierBroker(deviceId: number, preferredTier: CamProfile): Promise<void> {
    if (this.assignments.has(deviceId)) return
    if (!this.api || this.localNodeId === null) return
    const api = this.api
    const ownNodeId = this.localNodeId

    let owner: IngestOwner
    try {
      owner = await api.pipelineOrchestrator.getIngestOwner.query()
    } catch (err: unknown) {
      this.logger.debug(
        'webrtc-adaptive-tier: getIngestOwner unavailable — defaulting to local (cap not mounted yet?)',
        { tags: { deviceId }, meta: { error: errMsg(err) } },
      )
      owner = { ownerNodeId: ownNodeId }
    }

    const mode = resolveWebrtcSourceMode({
      ownerNodeId: owner.ownerNodeId,
      ownNodeId,
      reachableHost: owner.reachableHost,
    })
    if (mode.kind === 'local') return
    if (mode.kind === 'unresolvable') {
      const configIssueSuffix = owner.configIssue ? ` (${owner.configIssue})` : ''
      throw new Error(
        `webrtc-adaptive-tier: device ${deviceId} is owned by node "${mode.ownerNodeId}" but no reachable host is configured for it — cannot source its WebRTC stream remotely${configIssueSuffix}`,
      )
    }

    const slots = await api.streamBroker.listAllProfileSlots.query(
      undefined,
      nodePin(mode.ownerNodeId),
    )
    const hit = resolveTierSlot(slots, deviceId, preferredTier)
    if (hit === null) return

    const brokerId = makeSourceBrokerId(deviceId, hit.camStreamId)
    await this.ensureBrokerForWebrtcSession(deviceId, brokerId, hit.camStreamId, hit.profile)
  }

  setProfileMapPersister(persister: ProfileMapPersister): void {
    this.profileMapPersister = persister
  }

  /**
   * Rehydrate the persisted profile map, then reconcile it against the live
   * device registry — a blob written before a camera was deleted otherwise
   * resurrects that camera's slots on every boot.
   *
   * Call AFTER `setProfileMapPersister` / `setApiAccess`: the prune persists
   * what it drops, and reads the registry to decide what to drop.
   */
  async loadPersistedProfileMap(entries: ReadonlyMap<number, DeviceAssignment>): Promise<void> {
    this.assignments.clear()
    for (const [k, v] of entries) this.assignments.set(k, v)
    await this.pruneAssignmentsForRemovedDevices()
  }

  /**
   * Drop assignments for devices the registry no longer knows.
   *
   * Deletion decided by a fallible read, so every way the read can be WRONG
   * skips the prune outright (D49): no api yet, a failed enumeration, or an
   * empty enumeration standing next to persisted assignments — that last one
   * is device-restore not having run, and believing it would wipe the whole
   * fleet's slot map on one bad boot. Nothing here is retried: the next boot
   * reads the same blob, and A3 already removes a device at the moment it is
   * deleted.
   */
  private async pruneAssignmentsForRemovedDevices(): Promise<void> {
    const persistedCount = this.assignments.size
    if (persistedCount === 0) return
    const api = this.api
    if (!api) {
      this.logger.warn('profile-map prune skipped — no api access', {
        meta: { persistedCount },
      })
      return
    }
    let devices: readonly { id: number }[]
    try {
      // `slim`: this prune reads `id` only — see the note in `reconcileAllCatalogs`.
      devices = await api.deviceManager.listAll.query({ projection: 'slim' })
    } catch (err) {
      this.logger.warn('profile-map prune skipped — deviceManager.listAll failed', {
        meta: { persistedCount, error: errMsg(err) },
      })
      return
    }
    if (devices.length === 0) {
      this.logger.warn('profile-map prune skipped — device enumeration came back empty', {
        meta: { persistedCount },
      })
      return
    }
    const known = new Set(devices.map((d) => d.id))
    const dropped = [...this.assignments.keys()].filter((deviceId) => !known.has(deviceId))
    if (dropped.length === 0) {
      this.logger.debug('profile-map prune: every persisted device still exists', {
        meta: { persistedCount },
      })
      return
    }
    for (const deviceId of dropped) {
      this.assignments.delete(deviceId)
      this.logger.debug('profile-map prune dropped a device that no longer exists', {
        tags: { deviceId },
      })
    }
    this.persistProfileMap()
    this.logger.info('profile-map prune — dropped assignments for devices that no longer exist', {
      meta: { dropped, remaining: this.assignments.size },
    })
  }

  getRtspRestreamProvider(): RtspRestreamProviderImpl {
    return this.rtspProvider
  }

  loadPersistedTokens(tokens: ReadonlyMap<string, string>): void {
    this.persistedTokens = new Map(tokens)
  }

  /** See {@link restreamGate}. */
  setRestreamGate(gate: (deviceId: number) => boolean): void {
    this.restreamGate = gate
  }

  /**
   * Register the restream URLs of ONE camera now (its tokens became readable, or
   * were issued fresh): each of its source brokers and the profile restreamers
   * over them. No broker is torn down or recreated, so nothing stops recording.
   */
  registerRestreamersForDevice(deviceId: number): void {
    if (this.restreamGate(deviceId)) return
    for (const [brokerId, broker] of this.brokers) {
      if (brokerId.startsWith(`${deviceId}/`)) this.registerSourceRestreamer(brokerId, broker)
    }
    this.syncProfileRestreamers(deviceId)
  }

  // ── Cap methods: cam stream lifecycle ────────────────────────────────

  /** Upsert a single SOURCE (non-derived) cam-stream into the registry
   *  WITHOUT ranking or broker creation. Returns the prior entry (if any)
   *  so callers can detect url refresh / already-existed. */
  private upsertSourceCameraStream(
    deviceId: number,
    input: {
      camStreamId: string
      kind: CamStreamKind
      url?: string
      codec?: string
      resolution?: { width: number; height: number }
      fps?: number
      label?: string
      deviceFeatures?: readonly string[]
      autoEligible?: boolean
      profileHint?: CamProfile
      metadata?: Readonly<Record<string, unknown>>
      brokerOwned?: boolean
    },
  ): CameraStreamInternal | undefined {
    const { camStreamId, kind, url, codec, resolution, fps, label, metadata } = input
    let streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap) {
      streamMap = new Map()
      this.cameraStreams.set(deviceId, streamMap)
    }
    const existing = streamMap.get(camStreamId)
    const order = existing?.order ?? this.nextOrder(deviceId)
    const deviceFeatures: string[] = input.deviceFeatures
      ? [...input.deviceFeatures]
      : existing?.deviceFeatures
        ? [...existing.deviceFeatures]
        : []
    const autoEligible = input.autoEligible ?? existing?.autoEligible ?? true
    // Sticky like `autoEligible`: the publisher's statement of what the stream
    // IS does not evaporate on a re-publish that omits it.
    const profileHint = input.profileHint ?? existing?.profileHint
    // Sticky across re-publishes, like `autoEligible`: a broker-owned stream
    // that a later upsert silently demoted to provider-owned would be swept by
    // the very next reconcile tick.
    const brokerOwned = input.brokerOwned ?? existing?.brokerOwned ?? false
    const cam: CameraStreamInternal = {
      camStreamId,
      deviceId,
      kind,
      ...(url !== undefined ? { url } : {}),
      ...(codec !== undefined ? { codec } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(fps !== undefined ? { fps } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(metadata !== undefined
        ? { metadata }
        : existing?.metadata !== undefined
          ? { metadata: existing.metadata }
          : {}),
      order,
      deviceFeatures,
      autoEligible,
      ...(profileHint !== undefined ? { profileHint } : {}),
      brokerOwned,
    }
    streamMap.set(camStreamId, cam)
    return existing
  }

  async publishCameraStream(input: {
    deviceId: number
    camStreamId: string
    kind: CamStreamKind
    url?: string
    codec?: string
    resolution?: { width: number; height: number }
    fps?: number
    label?: string
    /**
     * Device-level features the publisher advertised — single source of
     * truth for downstream policy (battery → relaxed stall watchdog,
     * prebuffer off, snapshot rate-limit longer). Re-publishes overwrite
     * the prior list so device feature changes (e.g. live battery
     * detection) propagate.
     */
    deviceFeatures?: readonly string[]
    /**
     * Whether this stream is eligible for automatic profile assignment.
     * Re-publishes overwrite — flipping a stream from auto-eligible to
     * not (or vice versa) takes effect on the next assignment recompute.
     * Default `true`.
     */
    autoEligible?: boolean
    /** The slot the publisher says this stream IS — honoured by the automatic
     *  ranking before the pixel heuristic (`rankInitialAssignment`). */
    profileHint?: CamProfile
    /**
     * Transport-specific opaque metadata. Stored alongside the stream
     * record and forwarded to the source reader via
     * `StreamSource.metadata`. `pull-rfc4571` publishers put the SDP
     * here.
     */
    metadata?: Readonly<Record<string, unknown>>
    /**
     * This broker minted the stream; no provider will ever declare it. Marks it
     * exempt from the catalog reconcile's "absent from the catalog → retract"
     * sweep — see {@link CameraStreamInternal.brokerOwned}.
     *
     * INTERNAL, like `source` below: not part of the cap-wire schema, so a cap
     * caller cannot make its own publication un-sweepable. `kind: 'derived'`
     * sets it implicitly.
     */
    brokerOwned?: boolean
    /**
     * Required when `kind === 'derived'`. The `camStreamId` of the source
     * stream (within the same device) whose encoded plane this derived
     * stream re-encodes.
     */
    sourceCamStreamId?: string
    /**
     * Dual-mode derived source (profile slot | pinned camStream). Set by the
     * INTERNAL boot/drain materialization paths, which carry the full
     * {@link DerivedSourceRef} from the persisted override. When absent, a
     * legacy `sourceCamStreamId` is treated as `{kind:'camStream'}`. Not part of
     * the cap-wire schema — external cap callers use `sourceCamStreamId`.
     */
    source?: DerivedSourceRef
    /**
     * Required when `kind === 'derived'`. The encode parameters that the
     * broker-spawned transcode pipeline will apply to the source plane.
     */
    encodeProfile?: EncodeProfile
  }): Promise<{ success: true }> {
    const { deviceId, camStreamId, kind, codec, resolution, label } = input

    // ── derived kind: register metadata, mint a push broker, attach feeder ──
    if (kind === 'derived') {
      const { encodeProfile } = input
      // Prefer the dual-mode `source` (internal boot/drain); fall back to a
      // legacy `sourceCamStreamId` as a pinned camStream source.
      const derivedSource: DerivedSourceRef | undefined =
        input.source ??
        (input.sourceCamStreamId
          ? { kind: 'camStream', camStreamId: input.sourceCamStreamId }
          : undefined)
      if (!derivedSource || !encodeProfile) {
        throw new Error("kind: 'derived' requires a source (profile|camStream) + encodeProfile")
      }

      // Single-flight: if a derived entry with this name already exists,
      // return immediately — callers should use retractCameraStream +
      // republish to change encode parameters.
      const existingDerived = this.cameraStreams.get(deviceId)?.get(camStreamId)
      if (existingDerived) {
        // Republish must re-bind the feeder: a catalog/session recreate can
        // leave a push broker with no transcode producer (618 "push source
        // stalled"). Attach is idempotent when the feeder is already live.
        const existingMap = this.cameraStreams.get(deviceId)
        existingMap?.set(camStreamId, {
          ...existingDerived,
          derivedSource,
          encodeProfile,
        })
        await this.ensureDerivedReady(deviceId, camStreamId)
        return { success: true as const }
      }

      // A pinned camStream source must already be registered (its broker backs
      // the feeder's loopback). A profile source resolves its physical stream
      // dynamically at feeder-spawn time (getStreamWithCodec), so no
      // source-broker precondition applies.
      if (derivedSource.kind === 'camStream') {
        const sourceBrokerId = brokerIdFor(deviceId, derivedSource.camStreamId)
        if (!this.brokers.has(sourceBrokerId)) {
          throw new Error(`SOURCE_NOT_FOUND: ${sourceBrokerId}`)
        }
      }

      // Register the derived stream metadata so getCameraStreamsForDevice
      // surfaces it. The encode profile fields are mapped onto the standard
      // CameraStreamInternal shape for UI / assignment purposes.
      let derivedStreamMap = this.cameraStreams.get(deviceId)
      if (!derivedStreamMap) {
        derivedStreamMap = new Map()
        this.cameraStreams.set(deviceId, derivedStreamMap)
      }
      const order = this.nextOrder(deviceId)
      const deviceFeaturesArr: string[] = input.deviceFeatures ? [...input.deviceFeatures] : []
      const derivedCam: CameraStreamInternal = {
        camStreamId,
        deviceId,
        kind: 'derived',
        ...(label !== undefined ? { label } : {}),
        ...(codec !== undefined
          ? { codec }
          : encodeProfile.video.codec !== 'copy'
            ? { codec: encodeProfile.video.codec }
            : {}),
        ...(resolution !== undefined
          ? { resolution }
          : encodeProfile.video.width !== undefined && encodeProfile.video.height !== undefined
            ? {
                resolution: {
                  width: encodeProfile.video.width,
                  height: encodeProfile.video.height,
                },
              }
            : {}),
        ...(encodeProfile.video.fps !== undefined ? { fps: encodeProfile.video.fps } : {}),
        order,
        deviceFeatures: deviceFeaturesArr,
        autoEligible: input.autoEligible ?? false,
        // A `derived:*` is broker-owned by construction — no provider catalog
        // can declare one. Its lifecycle is `reconcileDerivedStreams`'.
        brokerOwned: true,
        derivedSource,
        encodeProfile,
      }
      derivedStreamMap.set(camStreamId, derivedCam)

      // Mint the derived PUSH broker (RTSP restreamer + profile participation +
      // frame plane for free, exactly like a source push broker) then attach
      // the on-demand transcode feeder that fills its push ingress.
      await this.ensureBroker(deviceId, camStreamId)
      this.attachDerivedFeeder(deviceId, camStreamId, derivedSource, encodeProfile)
      // Materializing a derived is what flips the empty-slot heal on
      // (`auto=false` + a derived in the set). Do it here so a boot-time
      // derived that lands AFTER the first catalog tick still refills
      // high/mid without waiting for the next poll.
      await this.reconcileAutoAssignment(deviceId, 'publish', true)

      this.emitCamStreamsChanged(deviceId)
      return { success: true as const }
    }

    // Detect a refreshed loopback transport: the publisher just re-ran
    // its publish pipeline (typically in response to an
    // `OnRequestStreamSourceRefresh` round-trip after a wake-up or an
    // idle-tear-down) and bound a new URL. Capture it now so we can
    // kick the broker's reconnect timer once the registry has
    // absorbed the new entry — without this nudge the broker stays
    // on its exponential-backoff schedule and may dial the stale URL
    // for several more seconds before observing the change. The upsert
    // overwrites the feature snapshot too — battery detection can happen
    // post-creation (live probe), so the latest signal wins.
    const existing = this.upsertSourceCameraStream(deviceId, input)
    const urlRefreshed =
      existing !== undefined && input.url !== undefined && existing.url !== input.url

    // Capture push-demand state BEFORE the rank so a re-published,
    // already-assigned push stream re-triggers demand afterward.
    const prePublishProfile = PUSH_KINDS.has(kind)
      ? findProfileForStream(this.assignments.get(deviceId)?.map ?? {}, camStreamId)
      : null
    const wasAlreadyAssigned = prePublishProfile !== null && existing !== undefined

    await this.reconcileAutoAssignment(deviceId, 'publish', existing === undefined)

    if (wasAlreadyAssigned) {
      const finalProfile = findProfileForStream(
        this.assignments.get(deviceId)?.map ?? {},
        camStreamId,
      )
      if (finalProfile !== null) {
        this.emitCamStreamDemand(deviceId, camStreamId, finalProfile)
      }
    }

    // Every published cam stream gets a live broker. Pre-buffer is
    // OFF by default so idle streams don't pin RAM or wake battery
    // cameras; the broker just sits ready for the first subscriber
    // (WebRTC viewer, RTSP restream client, detection pipeline) to
    // attach.
    await this.ensureBroker(deviceId, camStreamId)

    // The broker that survived this re-publish may have been waiting on its
    // exponential-backoff timer — kick it so the next dial uses the fresh
    // source right away instead of after several more wasted retries.
    //
    // Unconditional, NOT gated on the URL having changed. A re-publish is the
    // publisher stating that this source is serviceable now; whether the string
    // moved is an implementation detail of the publisher, and the wyze bridge
    // re-publishes the SAME loopback port after recreating its P2P server
    // (measured 2026-08-20). Gated on `urlRefreshed`, that camera sat out the
    // full backoff after every recreate for a source that was already up.
    // `kickReconnect` is self-guarding — it returns unless a reconnect timer is
    // actually armed and there is demand — and it throttles itself, so calling
    // it on every publish costs nothing when nothing is waiting.
    void urlRefreshed
    this.brokers.get(brokerIdFor(deviceId, camStreamId))?.kickReconnect()

    // Drain any derived streams that were queued in pendingDerivedStreams
    // because their source wasn't registered when loadPersistedDeviceOverrides
    // ran. Now that the source broker has landed, materialise each pending
    // derived in order. Only non-derived publishes (i.e. real source streams)
    // can unblock pending deriveds — derived-on-derived is not supported.
    const justRegisteredBrokerId = brokerIdFor(deviceId, camStreamId)
    const pending = this.pendingDerivedStreams.get(justRegisteredBrokerId)
    if (pending) {
      this.pendingDerivedStreams.delete(justRegisteredBrokerId)
      for (const p of pending) {
        if (!p.def.source) continue
        const derivedCamStreamId = `derived:${p.name}`
        await this.publishCameraStream({
          deviceId: p.deviceId,
          camStreamId: derivedCamStreamId,
          kind: 'derived',
          source: p.def.source,
          encodeProfile: p.def.encodeProfile,
        })
        // Restore the slot a source-change retract cleared (see reconcileDerivedStreams).
        if (p.restoreProfile) {
          await this.assignProfile({
            deviceId: p.deviceId,
            profile: p.restoreProfile,
            camStreamId: derivedCamStreamId,
          }).catch(() => {})
        }
      }
    }

    this.emitCamStreamsChanged(deviceId)
    return { success: true as const }
  }

  /**
   * Publish a device's FULL stream catalog atomically: upsert every
   * source descriptor, rank the profiles ONCE over the complete set,
   * then create each broker. Deterministic counterpart to looping
   * `publishCameraStream` per descriptor (which persisted + emitted an
   * intermediate, wrong assignment between each publish → the transient
   * high/mid/low reshuffle during catalog republish). Derived descriptors
   * (which need their source broker to already exist) fall back to the
   * per-stream path AFTER the sources are live.
   */
  private async publishCatalog(
    deviceId: number,
    descriptors: readonly CamStreamDescriptor[],
  ): Promise<void> {
    const sources = descriptors.filter((d) => d.kind !== 'derived')
    const derived = descriptors.filter((d) => d.kind === 'derived')

    const streamMapBefore = this.cameraStreams.get(deviceId)
    const reEmitDemandFor: string[] = []
    for (const d of sources) {
      const existed = streamMapBefore?.get(d.camStreamId) !== undefined
      const wasAssigned =
        PUSH_KINDS.has(d.kind) &&
        findProfileForStream(this.assignments.get(deviceId)?.map ?? {}, d.camStreamId) !== null
      if (existed && wasAssigned) reEmitDemandFor.push(d.camStreamId)
    }
    const urlBefore = new Map<string, string | undefined>()
    for (const d of sources) urlBefore.set(d.camStreamId, streamMapBefore?.get(d.camStreamId)?.url)

    // (1) Upsert every source descriptor (no rank, no broker yet).
    for (const d of sources) {
      this.upsertSourceCameraStream(deviceId, d)
    }

    // (2) Rank ONCE over the complete set.
    const anyNewStream = sources.some((d) => streamMapBefore?.get(d.camStreamId) === undefined)
    await this.reconcileAutoAssignment(deviceId, 'publish', anyNewStream)

    // (3) Re-emit demand for already-assigned push streams.
    for (const camStreamId of reEmitDemandFor) {
      const profile = findProfileForStream(this.assignments.get(deviceId)?.map ?? {}, camStreamId)
      if (profile !== null) this.emitCamStreamDemand(deviceId, camStreamId, profile)
    }

    // (4) Ensure a broker per source (+ url-refresh reconnect).
    for (const d of sources) {
      await this.ensureBroker(deviceId, d.camStreamId)
      const prevUrl = urlBefore.get(d.camStreamId)
      if (d.url !== undefined && prevUrl !== undefined && prevUrl !== d.url) {
        this.brokers.get(brokerIdFor(deviceId, d.camStreamId))?.kickReconnect()
      }
    }

    // (5) Derived descriptors: per-stream (source brokers now exist).
    for (const d of derived) {
      await this.publishCameraStream({ deviceId, ...d })
    }

    this.emitCamStreamsChanged(deviceId)
  }

  async retractCameraStream(input: {
    deviceId: number
    camStreamId: string
    preserveAssignment?: boolean
  }): Promise<{ success: true }> {
    const { deviceId, camStreamId, preserveAssignment = false } = input
    const streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap?.has(camStreamId)) return { success: true as const }

    const current = this.assignments.get(deviceId) ?? { map: {}, auto: true }
    if (preserveAssignment) {
      if (
        PUSH_KINDS.has(streamMap.get(camStreamId)!.kind) &&
        findProfileForStream(current.map, camStreamId) !== null
      ) {
        this.emitCamStreamIdle(deviceId, camStreamId)
      }
    } else {
      let newMap = { ...current.map }
      for (const profile of CAM_PROFILE_ORDER) {
        if (newMap[profile] === camStreamId) delete newMap[profile]
      }
      if (current.auto) {
        const remaining = [...streamMap.values()]
          .filter((s) => s.camStreamId !== camStreamId)
          .toSorted((a, b) => a.order - b.order)
        newMap = this.computeInitialAssignment(remaining)
      }

      // Apply the assignment BEFORE removing from streamMap so
      // `countPushConsumers` can still identify the retracted stream as
      // push-kind and emit the N→0 idle event.
      await this.applyAssignmentUpdate(deviceId, newMap, {
        auto: current.auto,
        reason: 'retract',
      })
    }

    // Stream lifecycle is tied 1:1 to publish/retract — destroy the
    // broker now that its source is gone.
    await this.releaseBroker(deviceId, camStreamId)

    streamMap.delete(camStreamId)
    if (streamMap.size === 0) this.cameraStreams.delete(deviceId)
    // Whatever retracted it, a pending absence mark now describes nothing — and
    // left in place it would retract the NEXT stream under this id at once.
    this.dropCatalogAbsenceMark(deviceId, camStreamId)

    this.emitCamStreamsChanged(deviceId)
    return { success: true as const }
  }

  // ── Catalog reconcile (PULL) ─────────────────────────────────────────
  //
  // The broker is the authority for its own cam-stream registry: it PULLS
  // each camera's `stream-catalog` (via DeviceProxy) and reconciles, rather
  // than relying on providers to push. This makes the broker self-heal after
  // a restart — it re-derives the full registry from the providers. Driven by
  // the host addon on start + a configurable poll + device / stream-params
  // events.

  /**
   * Race a catalog pull against a timeout so a wedged provider handler
   * can't leave the reconcile pending forever. Rejects (caught upstream →
   * retry next tick) if the provider hasn't answered in time.
   */
  private async withCatalogTimeout<T>(promise: Promise<T>, deviceId: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`stream-catalog.getCatalog timed out for device ${String(deviceId)}`)),
        12_000,
      )
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Dial every one of this device's SOURCE brokers again, because the camera's
   * encoder restarted under them.
   *
   * A restart drops the RTSP connection and the broker reconnects on its own —
   * but the reconnect lands INSIDE the restart window, so it negotiates
   * whatever transient SDP the camera is offering mid-change. Measured on
   * Hikvision 104 (2026-08-07): a microphone mute/unmute left all three
   * brokers holding video-only sessions against a camera that had its audio
   * mux back, and because those sessions were healthy nothing ever re-dialed.
   * The hub was deaf on that camera until the device was disabled long enough
   * for the catalog reconcile to release the brokers.
   *
   * `settleMs` is why this exists as a method rather than a loop at the call
   * site: the whole point is to dial AFTER the camera has finished, and the
   * writer that knows a restart happened does not know when it ends. Derived
   * brokers are excluded — they consume a source broker rather than dialing
   * the camera, and re-dialing them would tear down an egress for nothing.
   */
  redialDeviceSources(deviceId: number, reason: string, settleMs = 2000): void {
    const streams = this.cameraStreams.get(deviceId)
    if (!streams) return
    const targets: string[] = []
    for (const [camStreamId, entry] of streams) {
      if (entry.kind === 'derived') continue
      if (this.brokers.has(brokerIdFor(deviceId, camStreamId))) targets.push(camStreamId)
    }
    if (targets.length === 0) return
    this.logger.info('camera encoder restarted — re-dialing its source brokers', {
      tags: { deviceId },
      meta: { reason, settleMs, streams: targets.join(',') },
    })
    setTimeout(() => {
      for (const camStreamId of targets) {
        this.brokers.get(brokerIdFor(deviceId, camStreamId))?.redial(reason)
      }
    }, settleMs).unref?.()
  }

  /**
   * Pull one camera's `stream-catalog` and reconcile its cam-streams: upsert
   * every descriptor, retract a cam-stream the catalog no longer lists. A pull
   * that throws (provider mid-restart, no `stream-catalog` cap, a camera whose
   * session died) omits THIS DEVICE ONLY — it is logged at `warn` with the
   * device's id and re-asked on the `catalog-pull-backoff.ts` ladder.
   *
   * The retract DESTROYS work (broker, restreamer, every writer and viewer on
   * it), so it is never decided by one read (D689, D49): a pull that omits a
   * stream only marks it, and the retract needs a later successful pull, at
   * least {@link CATALOG_ABSENCE_CONFIRM_MIN_MS} after the mark, to agree. A
   * failed pull, or one that answered nothing at all (`null`), decides
   * nothing. Neither does an answered EMPTY catalog: providers answer `[]`
   * both for "not mine" and for "don't know yet" (a sleeping Reolink battery
   * camera, a rebooting Hikvision), so it is not a read that may destroy work
   * — it neither marks nor clears. Genuine removal of a whole camera is the
   * `DeviceUnregistered` path and the departed-device sweep (D685).
   *
   * `trigger` decides whether the backoff applies — see
   * {@link CatalogReconcileTrigger}. It defaults to `'event'` (always attempt)
   * so only the caller that actually repeats forever pays the throttle.
   */
  async reconcileDeviceCatalog(
    deviceId: number,
    trigger: CatalogReconcileTrigger = 'event',
  ): Promise<void> {
    await this.runDeviceCatalogOperation(deviceId, () =>
      this.reconcileDeviceCatalogNow(deviceId, trigger),
    )
  }

  private async reconcileDeviceCatalogNow(
    deviceId: number,
    trigger: CatalogReconcileTrigger,
  ): Promise<void> {
    if (!this.api) return
    // A device whose pull keeps failing is asked on the backoff ladder, not on
    // every 30 s tick. Only the POLL is gated: an event carries new
    // information and always attempts. See `catalog-pull-backoff.ts`.
    const failure = this.catalogPullFailures.get(deviceId)
    if (trigger === 'poll' && !mayAttemptPolledCatalogPull(failure, Date.now())) {
      this.logger.debug('reconcileDeviceCatalog: skipped — device is on catalog-pull backoff', {
        tags: { deviceId },
        meta: {
          consecutiveFailures: failure?.consecutiveFailures ?? 0,
          nextAttemptInMs: Math.max(0, (failure?.nextAttemptAtMs ?? 0) - Date.now()),
        },
      })
      return
    }
    let answer: readonly CamStreamDescriptor[] | null | undefined
    try {
      // Device-scoped cap called from the broker (system context): pass the
      // deviceId explicitly — the SDK link chain routes to the owning
      // provider, hub-local or cross-node, transparently.
      //
      // Bounded with a timeout: a provider whose getCatalog handler wedges
      // (e.g. a session-exhausted Reolink camera that never answers the
      // Baichuan stream-options query) would otherwise leave this await
      // pending forever, permanently stalling the reconcile and leaving the
      // device's cam-stream registry — and its device-settings tab — empty.
      // On timeout we fall into the catch and retry on the next poll tick.
      answer = await this.withCatalogTimeout(
        this.api.streamCatalog.getCatalog.query({ deviceId }),
        deviceId,
      )
    } catch (err) {
      // OMISSION, REPORTED. This device is dropped from THIS reconcile and
      // every other device still gets one (`Promise.allSettled` in
      // `reconcileAllCatalogs`, this `catch` here). A camera silently missing
      // from the catalog has no broker, no recording and no detection — the
      // 3 629 outage was 35 minutes of exactly this at `debug`. `warn` on
      // every failed attempt is affordable precisely BECAUSE the ladder below
      // bounds how many attempts there are.
      const next = nextCatalogPullFailureState(this.catalogPullFailures.get(deviceId), Date.now())
      this.catalogPullFailures.set(deviceId, next)
      this.logger.warn('stream-catalog pull failed — device omitted from this catalog reconcile', {
        tags: { deviceId },
        meta: {
          trigger,
          consecutiveFailures: next.consecutiveFailures,
          retryInMs: catalogPullRetryDelayMs(next.consecutiveFailures),
          error: errMsg(err),
        },
      })
      return
    }
    if (this.catalogPullFailures.delete(deviceId)) {
      this.logger.info('stream-catalog pull recovered — device is back in the catalog', {
        tags: { deviceId },
        meta: { descriptors: answer?.length ?? null },
      })
    }
    // Unknown is not empty: a pull that answered nothing decides nothing.
    if (answer === null || answer === undefined) {
      this.logger.debug('stream-catalog pull answered nothing — the registry is left as it is', {
        tags: { deviceId },
        meta: { trigger },
      })
      return
    }
    const descriptors = answer
    if (descriptors.length === 0) {
      this.logger.debug(
        'stream-catalog pull answered empty — ignored: neither marks nor clears a stream (D689)',
        {
          tags: { deviceId },
          meta: {
            trigger,
            pendingMarks: this.catalogAbsenceMarks.get(deviceId)?.size ?? 0,
          },
        },
      )
      return
    }

    // Atomic: upsert all + rank ONCE (no transient reshuffle). Replaces the
    // per-descriptor publishCameraStream loop, which persisted an
    // intermediate assignment between each stream.
    await this.publishCatalog(deviceId, descriptors)
    await this.retractStreamsTwoPullsOmitted(deviceId, descriptors, trigger)
  }

  /**
   * The retract half of a SUCCESSFUL catalog pull (D689): mark what this pull
   * omitted, unmark what it lists again, retract what two pulls a reconcile
   * interval apart both omitted. See `catalog-absence.ts`.
   */
  private async retractStreamsTwoPullsOmitted(
    deviceId: number,
    descriptors: readonly CamStreamDescriptor[],
    trigger: CatalogReconcileTrigger,
  ): Promise<void> {
    const existing = this.cameraStreams.get(deviceId)
    // BROKER-OWNED synthetics are never in a provider catalog, so "absent
    // from the catalog" is their PERMANENT state, not a removal signal.
    // Sweeping them retracted every materialized derived on the next poll
    // tick (the 618 sub-cropped bug: broker later recreated feeder-less by
    // a subscriber → "push source stalled") and, until this guard stopped
    // reading `kind` alone, every LIVE Alexa egress 13 s into its session
    // (587, refcount still 2, ffmpeg still encoding into a dropped sink).
    // Their lifecycle belongs to whoever minted them —
    // `reconcileDerivedStreams` + the deviceOverrides boot hydration for a
    // derived, the egress refcount for an `egress:*`.
    const candidates = existing
      ? Array.from(existing.values())
          .filter((cam) => !cam.brokerOwned)
          .map((cam) => cam.camStreamId)
      : []
    const verdict = judgeCatalogAbsence({
      marks: this.catalogAbsenceMarks.get(deviceId) ?? new Map<string, number>(),
      listed: new Set(descriptors.map((d) => d.camStreamId)),
      candidates,
      nowMs: Date.now(),
      confirmMinMs: CATALOG_ABSENCE_CONFIRM_MIN_MS,
    })
    if (verdict.nextMarks.size > 0) this.catalogAbsenceMarks.set(deviceId, verdict.nextMarks)
    else this.catalogAbsenceMarks.delete(deviceId)

    for (const camStreamId of verdict.marked) {
      this.logger.info(
        'stream absent from the catalog — retracted only if a pull a reconcile interval later agrees',
        {
          tags: { deviceId },
          meta: {
            camStreamId,
            trigger,
            confirmAfterMs: CATALOG_ABSENCE_CONFIRM_MIN_MS,
          },
        },
      )
    }
    for (const camStreamId of verdict.cleared) {
      this.logger.info('stream is back in the catalog — pending retract cancelled', {
        tags: { deviceId },
        meta: { camStreamId, trigger },
      })
    }
    for (const { camStreamId, absentForMs } of verdict.retract) {
      this.logger.warn('stream absent from two catalog pulls — retracted', {
        tags: { deviceId },
        meta: { camStreamId, absentForMs, trigger },
      })
      // Provider restart (Hikvision plugin, a catalog probe) often drops
      // physical streams for one tick. Retracting them WITHOUT preserving
      // the slot emptied high/mid on a device whose `low` was a derived
      // (auto=false after assignProfile) — 618, 2026-08-16. The stream
      // itself still goes away; the operator's slot choice waits for it.
      await this.retractCameraStream({
        deviceId,
        camStreamId,
        preserveAssignment: true,
      })
    }
  }

  /** Forget one stream's pending catalog-absence mark — it was retracted by some path. */
  private dropCatalogAbsenceMark(deviceId: number, camStreamId: string): void {
    const marks = this.catalogAbsenceMarks.get(deviceId)
    if (!marks?.has(camStreamId)) return
    const next = new Map([...marks].filter(([id]) => id !== camStreamId))
    if (next.size > 0) this.catalogAbsenceMarks.set(deviceId, next)
    else this.catalogAbsenceMarks.delete(deviceId)
  }

  /**
   * Enumerate every camera and reconcile its catalog. The reconcile backstop
   * (poll cadence) and the start-up fetch. Per-device failures are isolated so
   * one unreachable camera can't block the rest.
   */
  async reconcileAllCatalogs(): Promise<void> {
    if (!this.api) return
    let devices: readonly {
      id: number
      type: string
      isCamera: boolean
      disabled: boolean
    }[]
    try {
      // `slim` is not decoration. The FULL projection makes
      // `device-queries.ts#listAll` materialise every row's `config` with one
      // SEQUENTIAL `readDeviceStore` on hub-main's event loop — 967 of them on
      // this hub, and this poll runs every 30 s. The four fields read below
      // (`id`, `type`, `isCamera`, `disabled`) are all columns `slim` carries.
      devices = await this.api.deviceManager.listAll.query({
        projection: 'slim',
      })
    } catch (err) {
      this.logger.debug('reconcileAllCatalogs: deviceManager.listAll failed — will retry', {
        meta: { error: errMsg(err) },
      })
      return
    }
    await this.sweepDepartedDevices(devices)
    const cameras = devices.filter((d) => d.isCamera || d.type === DeviceType.Camera)
    // Disabled-camera lifecycle (2026-07-23, dev614 reconnect storm): a
    // DISABLED camera must hold NO live broker — before this, the prebuffer
    // warm-hold + always-on audio subscription kept dialing an unreachable
    // disabled camera forever (30s-backoff reconnects, both main+sub, plus
    // provider catalog polls, indefinitely). This poll IS the D8 reconcile
    // backstop: disable/enable takes effect within one tick, no new event
    // plumbing. The `disabledDevices` mirror also makes `ensureBroker` refuse
    // (re)creation, so a retrying audio/frame subscriber cannot resurrect the
    // released broker; on re-enable the mirror clears, the next reconcile
    // re-publishes the catalog (prebuffer re-warms) and the subscriber's own
    // retry loop reopens its stream.
    for (const d of cameras) {
      if (d.disabled) {
        const firstSeen = !this.disabledDevices.has(d.id)
        this.disabledDevices.add(d.id)
        // No catalog pull runs while it is disabled, so a pending absence mark
        // would outlive its observation: on re-enable, ONE omission would retract.
        this.catalogAbsenceMarks.delete(d.id)
        await this.releaseDisabledDeviceBrokers(d.id, firstSeen)
      } else {
        this.disabledDevices.delete(d.id)
      }
    }
    const live = cameras.filter((d) => !d.disabled)
    // `'poll'` — and ONLY here. This is the tick that repeats forever, so it
    // is the one that honours the per-device catalog-pull backoff; every
    // event-driven caller stays unthrottled.
    await Promise.allSettled(live.map((d) => this.reconcileDeviceCatalog(d.id, 'poll')))
    // The same tick re-derives what each camera's clip ring must hold. It is
    // ONE cheap query against the notification centre's in-memory rule mirror,
    // and it is what keeps the retention following the rules instead of only
    // the boot: a rule created, edited, enabled, disabled or deleted reaches
    // every node's rings within a tick. A failure changes nothing.
    await this.refreshClipRetentionPlan()
    // D83: the same tick is also the audio-plane net under D77's one-shot
    // recovery. Isolated per device and cheap-first — a camera whose brokers
    // already carry audio costs nothing but a map lookup.
    await Promise.allSettled(live.map((d) => this.reconcileDeviceAudioPlane(d.id)))
    // Devices that vanished from the fleet must not keep reconcile memory.
    const liveIds = new Set(live.map((d) => d.id))
    for (const deviceId of [...this.audioPlaneState.keys()]) {
      if (!liveIds.has(deviceId)) this.audioPlaneState.delete(deviceId)
    }
    // Same for the catalog-pull failure memory: a device that left the fleet
    // (removed, or disabled) must not come back already on a backoff rung.
    for (const deviceId of [...this.catalogPullFailures.keys()]) {
      if (!liveIds.has(deviceId)) this.catalogPullFailures.delete(deviceId)
    }
  }

  /**
   * Retract and purge a device that left the fleet WITHOUT a
   * `DeviceUnregistered` (D685).
   *
   * The event is the fast path and it may be dropped (D8/D11). Since D685 no
   * provider retracts on teardown (that hook also runs on every runner
   * restart), so a lost event used to leave the device's cam streams
   * registered — and `high` is default-warm, so its prebuffer hold kept
   * dialling the camera with no consumer at all, until the broker restarted.
   *
   * Destroying on a fallible read, so every way the read can be WRONG decides
   * nothing (D49): the caller has already returned on a failed read, an EMPTY
   * listing is device-restore not having run, and one absence only MARKS the
   * device — the retract needs the next successful read to agree. A device
   * that reappears in between is unmarked.
   */
  private async sweepDepartedDevices(devices: readonly { readonly id: number }[]): Promise<void> {
    if (devices.length === 0) {
      if (this.departureMarks.size > 0) {
        this.logger.debug('departed-device sweep skipped — device enumeration came back empty', {
          meta: { marked: [...this.departureMarks.keys()] },
        })
      }
      return
    }
    const listed = new Set(devices.map((d) => d.id))
    for (const deviceId of [...this.departureMarks.keys()]) {
      // Its streams went by another path (the DeviceUnregistered retract, a
      // catalog retract): the mark describes nothing any more, and left in
      // place it would turn the NEXT registration under that id into an
      // instant retract.
      if (!this.cameraStreams.has(deviceId)) {
        this.departureMarks.delete(deviceId)
        this.logger.debug('departure mark dropped — the device has no streams any more', {
          tags: { deviceId },
        })
        continue
      }
      if (listed.has(deviceId)) {
        this.departureMarks.delete(deviceId)
        this.logger.info('device is back in the fleet listing — departure sweep cancelled', {
          tags: { deviceId },
        })
      }
    }
    const nowMs = Date.now()
    for (const deviceId of [...this.cameraStreams.keys()]) {
      if (listed.has(deviceId)) continue
      const markedAt = this.departureMarks.get(deviceId)
      if (markedAt === undefined) {
        this.departureMarks.set(deviceId, nowMs)
        this.logger.info(
          'device absent from the fleet listing — its streams are swept if a later read agrees',
          {
            tags: { deviceId },
            meta: { confirmAfterMs: DEPARTURE_CONFIRM_MIN_MS },
          },
        )
        continue
      }
      // Startup re-runs this pass 1.5 s apart and the poll is not single-flight:
      // a read that close to the mark is the same observation, not a second one.
      if (nowMs - markedAt < DEPARTURE_CONFIRM_MIN_MS) continue
      this.departureMarks.delete(deviceId)
      this.logger.warn('device left the fleet without DeviceUnregistered — swept', {
        tags: { deviceId },
        meta: {
          camStreamIds: [...(this.cameraStreams.get(deviceId)?.keys() ?? [])],
          absentForMs: nowMs - markedAt,
        },
      })
      await this.retractDevice(deviceId, {
        preserveAssignments: true,
        purgeAssignments: true,
      }).catch((err: unknown) => {
        this.logger.warn('departed-device sweep: retract failed — the next two polls try again', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  /**
   * ONE device's audio-plane reconcile pass. See `audio-plane-reconcile.ts`
   * for the decision rules; this half only gathers and acts.
   *
   * Every branch that changes nothing still says so at debug — the whole
   * failure this repairs was invisible, and a reconcile whose "I looked and
   * everything was fine" is unobservable is a reconcile nobody can trust
   * after the next incident.
   */
  async reconcileDeviceAudioPlane(deviceId: number): Promise<void> {
    const observation = await this.observeAudioPlane(deviceId)
    const prior = this.audioPlaneState.get(deviceId) ?? EMPTY_AUDIO_PLANE_STATE
    const { action, nextState } = decideAudioPlaneAction(observation, prior, Date.now())
    if (nextState === EMPTY_AUDIO_PLANE_STATE) this.audioPlaneState.delete(deviceId)
    else this.audioPlaneState.set(deviceId, nextState)

    const meta = {
      observed: observation.kind,
      disagreements: nextState.disagreements,
      redials: nextState.redials,
    }
    switch (action.kind) {
      case 'none':
        return
      case 'await-second-pass':
        this.logger.info(
          'audio-plane reconcile: camera declares audio but no broker carries a track — confirming on the next pass',
          { tags: { deviceId }, meta },
        )
        return
      case 'cooldown':
        this.logger.debug('audio-plane reconcile: disagreement held — re-dial cooling down', {
          tags: { deviceId },
          meta: { ...meta, cooldownMs: AUDIO_PLANE_REDIAL_COOLDOWN_MS },
        })
        return
      case 'give-up':
        this.logger.warn(
          'audio-plane reconcile: giving up — the camera declares audio and re-dialing has not brought a track back',
          {
            tags: { deviceId },
            meta: { ...meta, maxRedials: AUDIO_PLANE_MAX_REDIALS },
          },
        )
        return
      case 'redial':
        this.logger.info(
          'audio-plane reconcile: audio declared but absent on every source — re-dialing',
          { tags: { deviceId }, meta },
        )
        this.redialDeviceSources(deviceId, 'audio-plane-reconcile')
        return
    }
  }

  /**
   * The gather half. Cheap questions first: the expensive device read happens
   * ONLY when the free in-memory answer already looks wrong.
   */
  private async observeAudioPlane(deviceId: number): Promise<AudioPlaneObservation> {
    if (this.deviceOverrides.get(deviceId)?.audioMuted === true) return { kind: 'broker-muted' }
    const streams = this.cameraStreams.get(deviceId)
    if (!streams) return { kind: 'no-live-source' }
    const sources: StreamBroker[] = []
    for (const [camStreamId, entry] of streams) {
      if (entry.kind === 'derived') continue
      const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
      // Only a broker that is actually STREAMING can be asked whether it
      // muxed audio. A suspended or reconnecting one has no answer, and
      // reading its stale track snapshot as "no audio" would manufacture a
      // disagreement out of an idle camera.
      if (broker && broker.status === 'streaming') sources.push(broker)
    }
    if (sources.length === 0) return { kind: 'no-live-source' }
    if (sources.some((b) => b.hasAudioTrack())) return { kind: 'audio-present' }
    if (!this.api) return { kind: 'read-failed' }

    let status: unknown
    try {
      status = await this.api.privacyMask.getStatus.query({ deviceId })
    } catch (err) {
      this.logger.debug('audio-plane reconcile: device audio read failed — changing nothing', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return { kind: 'read-failed' }
    }
    const declared = readDeclaredAudioEnabled(status)
    if (declared === null) return { kind: 'audio-unknown' }
    return declared ? { kind: 'declared-on' } : { kind: 'declared-off' }
  }

  /** Release every live broker of a disabled device (idempotent — later poll
   *  ticks find none and no-op). `logTransition` marks the disable EDGE. */
  private async releaseDisabledDeviceBrokers(
    deviceId: number,
    logTransition: boolean,
  ): Promise<void> {
    const streams = this.cameraStreams.get(deviceId)
    if (!streams) return
    const live = Array.from(streams.keys()).filter((camStreamId) =>
      this.brokers.has(brokerIdFor(deviceId, camStreamId)),
    )
    if (live.length === 0) return
    if (logTransition || live.length > 0) {
      this.logger.info('device disabled — releasing its brokers (no dial while disabled)', {
        tags: { deviceId },
        meta: { camStreamIds: live },
      })
    }
    for (const camStreamId of live) {
      await this.releaseBroker(deviceId, camStreamId).catch((err: unknown) => {
        this.logger.warn('disabled-device broker release failed', {
          tags: { deviceId, camStreamId },
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  /**
   * Startup catalog pull: run a full reconcile, then a bounded number of extra
   * passes while any camera still has an empty registry (a cold/slow provider
   * may answer on a later attempt). Bounded so a genuinely-offline camera can't
   * loop forever — the 30s poll remains the ongoing backstop.
   */
  async reconcileAllCatalogsAtStartup(maxPasses = 3, gapMs = 1500): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass++) {
      await this.reconcileAllCatalogs()
      if (!(await this.hasAnyCameraWithEmptyCatalog())) return
      if (pass < maxPasses - 1) await new Promise((r) => setTimeout(r, gapMs))
    }
  }

  private async hasAnyCameraWithEmptyCatalog(): Promise<boolean> {
    if (!this.api) return false
    let devices: readonly {
      id: number
      type: string
      isCamera: boolean
      disabled: boolean
    }[]
    try {
      // `slim` is not decoration. The FULL projection makes
      // `device-queries.ts#listAll` materialise every row's `config` with one
      // SEQUENTIAL `readDeviceStore` on hub-main's event loop — 967 of them on
      // this hub, and this poll runs every 30 s. The four fields read below
      // (`id`, `type`, `isCamera`, `disabled`) are all columns `slim` carries.
      devices = await this.api.deviceManager.listAll.query({
        projection: 'slim',
      })
    } catch {
      return false
    }
    for (const d of devices) {
      if ((d.isCamera || d.type === DeviceType.Camera) && !d.disabled) {
        const streams = this.cameraStreams.get(d.id)
        if (!streams || streams.size === 0) return true
      }
    }
    return false
  }

  /**
   * Drop a device's cam-streams entirely — fired on `device.unregistered`.
   */
  async retractDevice(deviceId: number, opts: RetractDeviceOptions = {}): Promise<void> {
    await this.runDeviceCatalogOperation(deviceId, () => this.retractDeviceNow(deviceId, opts))
  }

  private async retractDeviceNow(deviceId: number, opts: RetractDeviceOptions): Promise<void> {
    // The device is going away: forget its catalog-pull backoff rung so a
    // re-registration starts from a clean ladder rather than inheriting a
    // 90-minute wait from its previous life.
    this.catalogPullFailures.delete(deviceId)
    const existing = this.cameraStreams.get(deviceId)
    // NOT an early return when the device has no streams: the stream teardown
    // and the meta removal are separate events, so by the time
    // `DeviceUnregistered` lands the catalog reconcile has often already
    // retracted everything — leaving ONLY the orphan assignment to purge.
    if (existing) {
      for (const camStreamId of Array.from(existing.keys())) {
        await this.retractCameraStream({
          deviceId,
          camStreamId,
          preserveAssignment: opts.preserveAssignments === true,
        })
      }
    }
    if (opts.purgeAssignments === true) this.purgeDeviceAssignments(deviceId)
  }

  /**
   * Forget a device's profile-slot assignments and persist the shrunk map.
   *
   * Reachable only from the PERMANENT-removal path. A deleted device that
   * keeps its entry stays in `listAllProfileSlots` for the life of the
   * process AND is written straight back into the persisted `profileMap`
   * blob, so it returns at every boot — which is how 3217/3218 outlived
   * their cameras.
   */
  private purgeDeviceAssignments(deviceId: number): void {
    const existing = this.assignments.get(deviceId)
    if (!existing) return
    const profiles = CAM_PROFILE_ORDER.filter((profile) => existing.map[profile] !== undefined)
    this.assignments.delete(deviceId)
    this.persistProfileMap()
    this.logger.info('device removed — dropping its profile-slot assignments', {
      tags: { deviceId },
      meta: { profiles },
    })
  }

  private async runDeviceCatalogOperation<T>(
    deviceId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.deviceCatalogOperations.get(deviceId) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.catch(() => {}).then(() => turn)
    this.deviceCatalogOperations.set(deviceId, queued)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.deviceCatalogOperations.get(deviceId) === queued) {
        this.deviceCatalogOperations.delete(deviceId)
      }
    }
  }

  /**
   * Lazily (re)create the broker instance for a `brokerId` if its cam-stream
   * is known. The audio/frame subscribe paths call this so a consumer's
   * retry RESURRECTS the broker after a restart — the video path already
   * `ensureBroker`s, but audio/frame subscribers previously assumed an
   * existing instance and failed forever once the process respawned.
   * No-op when the brokerId is malformed or its cam-stream isn't (yet)
   * reconciled into the registry (`ensureBroker` itself guards on that).
   */
  private async ensureBrokerForId(brokerId: string): Promise<void> {
    if (this.brokers.has(brokerId)) return
    const parsed = parseBrokerId(brokerId)
    if (!parsed) return
    await this.ensureBroker(parsed.deviceId, parsed.camStreamId)
  }

  // ── Cap methods: profile assignment ─────────────────────────────────

  /**
   * Build the derived-stream dependency graph for a device from the current
   * profile assignments + the persisted `derivedStreams` overrides. Consumed by
   * the {@link wouldCycle} guard on {@link assignProfile}. Pure snapshot — does
   * not mutate manager state.
   */
  private buildDerivedGraph(deviceId: number): DerivedGraph {
    const map = this.assignments.get(deviceId)?.map ?? {}
    const assignments: Record<CamProfile, string | null> = {
      high: map.high ?? null,
      mid: map.mid ?? null,
      low: map.low ?? null,
    }
    const derived: Record<string, DerivedSourceRef> = {}
    const overrides = this.deviceOverrides.get(deviceId)?.derivedStreams
    if (overrides) {
      for (const [name, def] of Object.entries(overrides)) {
        if (def.source) derived[`derived:${name}`] = def.source
      }
    }
    return { assignments, derived }
  }

  async assignProfile(input: {
    deviceId: number
    profile: CamProfile
    camStreamId: string
  }): Promise<{ success: true }> {
    const { deviceId, profile, camStreamId } = input
    const streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap || !streamMap.has(camStreamId)) {
      throw new Error(
        `assignProfile: camStreamId "${camStreamId}" is not published for device ${deviceId}`,
      )
    }
    // Cycle-guard: a `derived:*` stream follows its source (a profile or a
    // physical camStream). Pointing a profile slot at a derived that
    // (transitively) sources from that same slot creates a feedback loop
    // (mid→derived→mid) — reject it before committing the assignment.
    if (wouldCycle(this.buildDerivedGraph(deviceId), camStreamId, profile)) {
      throw new Error(`Cannot assign ${camStreamId} to profile ${profile} — it would create a loop`)
    }
    const current = this.assignments.get(deviceId) ?? { map: {}, auto: true }
    const newMap = { ...current.map, [profile]: camStreamId }
    await this.applyAssignmentUpdate(deviceId, newMap, {
      auto: false,
      reason: 'assign',
    })
    return { success: true as const }
  }

  async unassignProfile(input: {
    deviceId: number
    profile: CamProfile
  }): Promise<{ success: true }> {
    const { deviceId, profile } = input
    const current = this.assignments.get(deviceId) ?? { map: {}, auto: true }
    if (current.map[profile] === undefined) {
      // Still mark manual so subsequent publishes don't auto-reassign.
      if (current.auto) {
        await this.applyAssignmentUpdate(deviceId, current.map, {
          auto: false,
          reason: 'unassign',
        })
      }
      return { success: true as const }
    }
    const newMap = { ...current.map }
    delete newMap[profile]
    await this.applyAssignmentUpdate(deviceId, newMap, {
      auto: false,
      reason: 'unassign',
    })
    return { success: true as const }
  }

  /**
   * Drop a DELETED camera's whole override entry and persist (D870). The
   * device-removal hook's one reach into the override map; `forgetDeviceHardware`
   * keeps the entry's non-hardware fields, a deleted camera keeps nothing.
   */
  dropDeviceOverride(deviceId: number): boolean {
    if (!this.deviceOverrides.delete(deviceId)) return false
    this.deviceOverridePersister?.(this.deviceOverrides)
    return true
  }

  /** Cameras that have an override entry. */
  listDeviceOverrideIds(): readonly number[] {
    return [...this.deviceOverrides.keys()]
  }

  /**
   * The hardware behind `deviceId` was replaced (`deviceManager.migrateDevice`)
   * — forget everything this broker knows that described the OLD box. See the
   * cap doc for the inventory. What deliberately SURVIVES is the role-scoped
   * half of the override blob: `audioMuted` (an operator's privacy choice about
   * the camera at this number), `preBuffer`/`preRollMs` (per-profile tuning),
   * and the debug flags. The camStreamId-keyed maps (`hwaccel`,
   * `sourceParser`, `sourceParserArgs`) go with the hardware — they are keyed
   * by stream ids only the old box had, and a same-vendor replacement reusing
   * an id must not inherit a parser chosen for different firmware.
   *
   * NOT `overrideHasContent`: an override left with only `audioMuted` must be
   * kept, and that predicate would call it empty.
   */
  async forgetDeviceHardware(input: { deviceId: number }): Promise<{
    derivedStreamsDeleted: readonly string[]
    assignmentsPurged: boolean
    probeSnapshotsDropped: number
    rtspTokenRowsDeleted: number
  }> {
    const { deviceId } = input

    // 1. Derived-stream definitions: drop the persisted defs, then let the
    // same reconcile the settings path uses tear down the live feeders.
    const existing = this.deviceOverrides.get(deviceId)
    const prior = new Map<string, DerivedStreamEntry>(
      Object.entries(existing?.derivedStreams ?? {}),
    )
    const derivedStreamsDeleted = [...prior.keys()].toSorted()
    if (existing) {
      const {
        derivedStreams: _derived,
        hwaccel: _hwaccel,
        sourceParser: _sourceParser,
        sourceParserArgs: _sourceParserArgs,
        ...kept
      } = existing
      if (Object.keys(kept).length === 0) {
        this.deviceOverrides.delete(deviceId)
      } else {
        this.deviceOverrides.set(deviceId, kept)
      }
      this.deviceOverridePersister?.(this.deviceOverrides)
    }
    if (prior.size > 0) {
      await this.reconcileDerivedStreams(deviceId, prior)
    }
    // A derived queued behind a source that never came up would rematerialise
    // the moment a same-named source lands — drain the device from the queue.
    for (const [sourceBrokerId, list] of [...this.pendingDerivedStreams]) {
      const keptPending = list.filter((p) => p.deviceId !== deviceId)
      if (keptPending.length === 0) this.pendingDerivedStreams.delete(sourceBrokerId)
      else if (keptPending.length !== list.length)
        this.pendingDerivedStreams.set(sourceBrokerId, keptPending)
    }

    // 2. Streams + the profile-slot assignment ENTRY — the permanent-removal
    // treatment (`purgeAssignments`), so the next catalog publish runs
    // `computeInitialAssignment` fresh instead of serving the old layout.
    const assignmentsPurged = this.assignments.has(deviceId)
    await this.retractDevice(deviceId, {
      preserveAssignments: true,
      purgeAssignments: true,
    })

    // 3. Probe snapshots — probed codec/resolution of the old hardware. The
    // persisted rows die at the next authoritative flush (the addon's forget
    // hook forces one).
    let probeSnapshotsDropped = 0
    for (const brokerId of [...this.lastProbedByBroker.keys()]) {
      if (brokerId.startsWith(`${deviceId}/`)) {
        this.lastProbedByBroker.delete(brokerId)
        probeSnapshotsDropped++
      }
    }

    // 4. Persisted rows the manager holds no handle to (RTSP token rows) +
    // the forced probe flush — injected by the addon.
    let rtspTokenRowsDeleted = 0
    if (this.deviceHardwareForgetHook) {
      rtspTokenRowsDeleted = (await this.deviceHardwareForgetHook(deviceId)).rtspTokenRowsDeleted
    }

    this.logger.info('forgot device hardware state after a migration', {
      tags: { deviceId },
      meta: {
        derivedStreamsDeleted,
        assignmentsPurged,
        probeSnapshotsDropped,
        rtspTokenRowsDeleted,
      },
    })
    return {
      derivedStreamsDeleted,
      assignmentsPurged,
      probeSnapshotsDropped,
      rtspTokenRowsDeleted,
    }
  }

  /**
   * Injected by the addon: work `forgetDeviceHardware` needs done against
   * durable handles the manager does not own (deleting the device's persisted
   * RTSP token rows, forcing the probe-snapshot flush).
   */
  setDeviceHardwareForgetHook(
    hook: (deviceId: number) => Promise<{ rtspTokenRowsDeleted: number }>,
  ): void {
    this.deviceHardwareForgetHook = hook
  }

  async restartProfile(input: {
    deviceId: number
    profile: CamProfile
  }): Promise<{ success: boolean }> {
    const { deviceId, profile } = input
    const camStreamId = this.assignments.get(deviceId)?.map[profile]
    if (!camStreamId) return { success: false }
    await this.restartBroker(deviceId, camStreamId)
    this.emitProfileSlotsChanged(deviceId)
    return { success: true }
  }

  /**
   * Recreate the broker for a cam stream — destroy the existing
   * instance then re-create it from the same source. Used by
   * `restartProfile`; lifecycle stays tied to publish/retract so the
   * broker comes back unconditionally as long as the source is still
   * published.
   */
  private async restartBroker(deviceId: number, camStreamId: string): Promise<void> {
    if (!this.cameraStreams.get(deviceId)?.has(camStreamId)) return
    await this.releaseBroker(deviceId, camStreamId)
    await this.ensureBroker(deviceId, camStreamId)
  }

  // ── Cap methods: system-wide views ──────────────────────────────────

  async listAllCameraStreams(): Promise<readonly CameraStream[]> {
    const out: CameraStream[] = []
    for (const streamMap of this.cameraStreams.values()) {
      const sorted = [...streamMap.values()].toSorted((a, b) => a.order - b.order)
      for (const s of sorted) out.push(this.toCameraStream(s))
    }
    return out
  }

  async listAllProfileSlots(): Promise<readonly ProfileSlot[]> {
    const out: ProfileSlot[] = []
    for (const deviceId of this.assignments.keys()) {
      for (const slot of this.snapshotProfileSlots(deviceId)) out.push(slot)
    }
    return out
  }

  /** The live broker for a profile's cam stream, when both exist. */
  private brokerFor(deviceId: number, camStreamId: string | undefined): StreamBroker | undefined {
    return camStreamId === undefined
      ? undefined
      : this.brokers.get(brokerIdFor(deviceId, camStreamId))
  }

  /**
   * Cut a GIF / MP4 out of the retained clip window, CENTRED on `aroundMs`.
   *
   * Waits for the post-roll to accumulate (the moment is normally ~now, so the
   * seconds after it have not happened yet), then selects by wall clock rather
   * than taking the tail — a call that arrives late must still produce footage
   * of the event, not of the present.
   */
  async renderPreBufferClip(input: {
    deviceId: number
    profile?: CamProfile
    aroundMs: number
    preRollSec: number
    postRollSec: number
    format: 'gif' | 'mp4'
    maxWidth: number
    fps: number
    speed?: number
  }): Promise<{
    base64: string
    mime: string
    bytes: number
    profile: CamProfile
    durationMs: number
  }> {
    const cut = await this.selectClipWindow({
      deviceId: input.deviceId,
      aroundMs: input.aroundMs,
      preRollSec: input.preRollSec,
      postRollSec: input.postRollSec,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    })
    const bytes = await this.muxClipWindow(cut, {
      format: input.format,
      maxWidth: input.maxWidth,
      fps: input.fps,
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
    })
    const first = cut.window[0]
    const last = cut.window[cut.window.length - 1]
    return {
      base64: Buffer.from(bytes).toString('base64'),
      mime: input.format === 'gif' ? 'image/gif' : 'video/mp4',
      bytes: bytes.byteLength,
      profile: cut.profile,
      durationMs: first && last ? Math.max(0, last.pts - first.pts) : 0,
    }
  }

  /**
   * ONE cut of an event, in every container the caller asked for — the
   * production point every consumer of event media goes through.
   *
   * See the cap docblock for why this is one method rather than one call per
   * format. The short version is that `renderPreBufferClip` renders one format
   * per call, so a caller wanting a gif AND a video made two calls, got two
   * windows, and shipped a notification whose two attachments showed different
   * moments.
   *
   * The window comes out of the broker's own AnnexB retention ring — packets
   * that were already in RAM — so a production reaches BACKWARDS from the event
   * with nothing spawned and nothing kept warm. The mp4 is muxed once, COPYING
   * the camera's own H.264 whenever nothing is being changed, and any gif is
   * derived from that same mp4 rather than rendered a second time from the
   * packets: same window, same pixels, by construction.
   */
  async produceEventMedia(input: {
    deviceId: number
    profile?: CamProfile
    aroundMs: number
    preSeconds: number
    postSeconds: number
    kinds: readonly EventMediaKind[]
    gifMaxWidth: number
    gifFps: number
    speed: number
    /**
     * OPTIONAL on purpose, and defaulted right here rather than only in the cap
     * schema: a Zod `.default()` on a cap input is applied by the hub's router,
     * which ships inside `@camstack/system` and therefore lags an addon deploy
     * by a whole publish train (CAP_INPUT_DEFAULTS). A caller that predates the
     * field must still get the operator's 4×, so the provider owns the fallback
     * too — the two sides agree, and the addon deploy alone is enough.
     */
    gifSpeed?: number
  }): Promise<EventMediaProduction> {
    // The caller's choice wins; otherwise the LARGEST H.264 rendition at or
    // below 1080p — the opposite default to `renderPreBufferClip`'s cheapest,
    // and the reason an event gif stops being cut from a 640×360 substream.
    const preferred = input.profile ?? this.bestClipProfile(input.deviceId) ?? undefined
    const cut = await this.selectClipWindow({
      deviceId: input.deviceId,
      aroundMs: input.aroundMs,
      preRollSec: input.preSeconds,
      postRollSec: input.postSeconds,
      ...(preferred !== undefined ? { profile: preferred } : {}),
    })
    // At real time this is the source's own width, so `clipCanCopy` sees an
    // identity scale and the camera's H.264 is copied. At any other speed the
    // decode is already forced, so the width stops being free and is capped at
    // 720p — see `eventClipEncodeWidth`. Computed ONCE and shared with
    // `clipVideoMode` below, because a reported mode that disagrees with the
    // render is a log line that lies.
    const clipWidth = eventClipEncodeWidth(cut.sourceWidth, input.speed)
    // The mp4 is produced whatever was asked for: a gif is DERIVED from it, so
    // a gif-only caller still pays the mux — and gets a gif that shares its
    // window with any video anybody else asks for later.
    const mp4 = await this.muxClipWindow(cut, {
      format: 'mp4',
      maxWidth: clipWidth,
      fps: 0,
      speed: input.speed,
    })
    const media: EventMediaArtifact[] = []
    if (input.kinds.includes('mp4')) {
      media.push({
        kind: 'mp4',
        handle: this.eventMedia.put({
          deviceId: input.deviceId,
          kind: 'mp4',
          mime: 'video/mp4',
          bytes: mp4,
        }),
        nodeId: this.localNodeId ?? '',
        mime: 'video/mp4',
        bytes: mp4.byteLength,
        // What was RENDERED, not what the ring held: a capped re-encode is
        // narrower than its source, and a consumer sizing a player off this
        // would letterbox it.
        width: clipWidth,
        height: scaledHeight(cut, clipWidth),
      })
    }
    const gifSpeed = input.gifSpeed ?? GIF_SPEED
    const gifFfmpeg = this.ffmpegConfig.binaryPath
    if (input.kinds.includes('gif') && gifFfmpeg === null) {
      // Named, per camera: the production carries one fewer artifact, and the
      // reason is the node's binary — never a PATH `ffmpeg` in its place (D540).
      this.logger?.error('event media gif refused — no pinned ffmpeg on this node (D540)', {
        tags: { deviceId: input.deviceId },
      })
      this.reportFfmpegMissing()
    }
    if (input.kinds.includes('gif') && gifFfmpeg !== null) {
      const gif = await gifFromMp4({
        mp4,
        deviceId: input.deviceId,
        maxWidth: input.gifMaxWidth,
        fps: input.gifFps,
        // The gif runs at its OWN rate — 4× by default, because it is glanced
        // at rather than watched — while the mp4 stays at `input.speed` so it
        // can be copied. The mp4 already carries that speed, so only the
        // remainder is applied here; passing the absolute rate would compound
        // the two and hand a 2× video an 8× gif.
        speed: gifDeriveSpeed(gifSpeed, input.speed),
        ...(this.logger !== undefined ? { logger: this.logger } : {}),
        spawnFn: spawn,
        ffmpegPath: gifFfmpeg,
      })
      if (gif !== null) {
        const height = scaledHeight(cut, input.gifMaxWidth)
        media.push({
          kind: 'gif',
          handle: this.eventMedia.put({
            deviceId: input.deviceId,
            kind: 'gif',
            mime: 'image/gif',
            bytes: gif,
          }),
          nodeId: this.localNodeId ?? '',
          mime: 'image/gif',
          bytes: gif.byteLength,
          width: input.gifMaxWidth,
          height,
        })
      }
      // A null gif already logged its own reason in `gifFromMp4` — the
      // production simply carries one fewer artifact, which the caller sees.
    }

    const video = this.clipVideoMode(cut, {
      format: 'mp4',
      maxWidth: clipWidth,
      speed: input.speed,
    })
    this.logger?.info('event media produced — one window, every container', {
      tags: { deviceId: input.deviceId },
      meta: {
        profile: cut.profile,
        video,
        resolution: `${cut.sourceWidth}x${cut.sourceHeight}`,
        packets: cut.window.length,
        kinds: [...input.kinds].join(','),
        artifacts: media.map((m) => `${m.kind}:${m.bytes}`).join(' '),
        // The video's rate and the gif's are DIFFERENT by design (4× gif, real
        // time mp4) — stated so nobody reads one off the other.
        speed: input.speed,
        gifSpeed,
        // The number the operator's complaint was about. NEGATIVE means the
        // media starts before the event; positive means it does not.
        startOffsetMs: cut.coverage.fromTs - input.aroundMs,
        endOffsetMs: cut.coverage.toTs - input.aroundMs,
      },
    })
    return {
      media,
      coverage: {
        fromTs: cut.coverage.fromTs,
        toTs: cut.coverage.toTs,
        packets: cut.window.length,
      },
      profile: cut.profile,
      video,
    }
  }

  /** Redeem an artifact handle. `null` once it has expired (see
   *  {@link EventMediaStore}). */
  async fetchEventMedia(input: {
    handle: string
  }): Promise<{ base64: string; mime: string; bytes: number } | null> {
    const item = this.eventMedia.get(input.handle)
    if (item === null) {
      // A consumer holding a dead handle would otherwise see an empty file and
      // blame the encoder.
      this.logger?.warn('event media: handle expired or unknown — nothing to fetch', {
        meta: { handle: input.handle },
      })
      return null
    }
    return {
      base64: Buffer.from(item.bytes).toString('base64'),
      mime: item.mime,
      bytes: item.bytes.length,
    }
  }

  // ── clip window selection (shared by both producers) ──────────────────

  /**
   * Wait out the post-roll, then select the retained window around the moment.
   *
   * Shared by `renderPreBufferClip` and `produceEventMedia` deliberately: two
   * copies of "which profile, which packets, which resolution" is exactly how
   * the two paths would start disagreeing again.
   */
  private async selectClipWindow(input: {
    deviceId: number
    profile?: CamProfile
    aroundMs: number
    preRollSec: number
    postRollSec: number
  }): Promise<ClipWindowCut> {
    const map = this.assignments.get(input.deviceId)?.map ?? {}
    const assigned = CLIP_PROFILE_BY_COST.filter((p) => map[p] !== undefined)
    const wanted = pickClipProfile(assigned, input.profile)
    if (!wanted) throw new Error(`No profile assigned for device ${input.deviceId}`)

    // ARM the window this cut actually needs, on the profile it actually asked
    // for — ONE ask, not a profile here and a flat duration somewhere else.
    // Retention can only ever fill FORWARD, so this render falls back below;
    // the next one is served what was asked. A camera whose rules already ask
    // for at least this much is unchanged.
    this.noteClipAsk(
      input.deviceId,
      wanted,
      input.preRollSec + input.postRollSec + CLIP_OBSERVED_ASK_MARGIN_SEC,
    )

    // Wait out the post-roll. Bounded by what THIS camera's ring holds: waiting
    // longer than that would evict the pre-roll we came for.
    const until = Math.min(
      input.aroundMs + input.postRollSec * 1000,
      Date.now() + this.clipRetentionSecFor(input.deviceId) * 1000,
    )
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, CLIP_POST_ROLL_POLL_MS))
    }

    // Prefer the requested profile; fall back to any assigned one whose ring
    // actually covers the moment. Reporting the profile used (rather than
    // failing, or pretending) is what keeps this honest.
    const candidates = [wanted, ...assigned.filter((p) => p !== wanted)]
    let profile: CamProfile | null = null
    let window: readonly EncodedPacket[] = []
    let coverage = { fromTs: input.aroundMs, toTs: input.aroundMs }
    for (const candidate of candidates) {
      const broker = this.brokerFor(input.deviceId, map[candidate])
      if (!broker) continue
      const packets = broker.getClipBuffer()
      const nowMs = Date.now()
      const found = windowAround({
        packets,
        aroundMs: input.aroundMs,
        preRollSec: input.preRollSec,
        postRollSec: input.postRollSec,
        nowMs,
      })
      if (found.length > 0) {
        profile = candidate
        window = found
        coverage = windowCoverage(packets, found, nowMs)
        break
      }
    }
    if (profile === null) {
      throw new Error(
        `No retained footage for device ${input.deviceId} covers ${new Date(input.aroundMs).toISOString()}`,
      )
    }
    if (profile !== wanted) {
      this.logger?.debug('clip fell back to a retained profile', {
        tags: { deviceId: input.deviceId },
        meta: { wanted, used: profile },
      })
    }
    const broker = this.brokerFor(input.deviceId, map[profile])
    if (!broker) throw new Error(`No live broker for device ${input.deviceId} (${profile})`)
    const cam = this.cameraStreams.get(input.deviceId)?.get(map[profile] ?? '')
    return {
      deviceId: input.deviceId,
      profile,
      window,
      coverage,
      broker,
      // Absent (an unpublished resolution) means 0, which REFUSES the copy
      // branch rather than guessing at a geometry.
      sourceWidth: cam?.resolution?.width ?? 0,
      sourceHeight: cam?.resolution?.height ?? 0,
    }
  }

  /** The rendition an event production prefers for this camera, or null when
   *  nothing qualifies (every slot H.265, or none publishes a resolution). */
  private bestClipProfile(deviceId: number): CamProfile | null {
    const map = this.assignments.get(deviceId)?.map ?? {}
    const streams = this.cameraStreams.get(deviceId)
    const candidates: ClipProfileCandidate[] = []
    for (const profile of CLIP_PROFILE_BY_COST) {
      const camStreamId = map[profile]
      if (camStreamId === undefined) continue
      const cam = streams?.get(camStreamId)
      candidates.push({
        profile,
        ...(cam?.codec !== undefined ? { codec: cam.codec } : {}),
        ...(cam?.resolution?.width !== undefined ? { width: cam.resolution.width } : {}),
        ...(cam?.resolution?.height !== undefined ? { height: cam.resolution.height } : {}),
      })
    }
    return pickBestClipProfile(candidates)
  }

  /** `copy` or `encode` for this cut — reported, never inferred from a size. */
  private clipVideoMode(
    cut: ClipWindowCut,
    render: { format: 'gif' | 'mp4'; maxWidth: number; speed?: number },
  ): 'copy' | 'encode' {
    return clipCanCopy({
      format: render.format,
      maxWidth: render.maxWidth,
      ...(render.speed !== undefined ? { speed: render.speed } : {}),
      hevc: isHevcPacket(cut.window[0]),
      sourceWidth: cut.sourceWidth,
    })
      ? 'copy'
      : 'encode'
  }

  private async muxClipWindow(
    cut: ClipWindowCut,
    render: {
      format: 'gif' | 'mp4'
      maxWidth: number
      fps: number
      speed?: number
    },
  ): Promise<Uint8Array> {
    const bytes = await renderClipBytes({
      window: cut.window,
      format: render.format,
      maxWidth: render.maxWidth,
      fps: render.fps,
      sourceWidth: cut.sourceWidth,
      ...(render.speed !== undefined ? { speed: render.speed } : {}),
      spawn: (cmd, args) => spawn(cmd, [...args], { stdio: ['pipe', 'pipe', 'pipe'] }),
      ffmpegPath: requireBrokerFfmpeg(this.ffmpegConfig.binaryPath, {
        logger: this.logger,
        deviceId: cut.deviceId,
        purpose: 'pre-buffer clip render',
        onMissing: () => this.reportFfmpegMissing(),
      }),
      sdpParameterSets: cut.broker.getSdpParameterSets(),
    })
    this.logger?.info('pre-buffer clip rendered', {
      tags: { deviceId: cut.deviceId },
      meta: {
        profile: cut.profile,
        format: render.format,
        // COPY or ENCODE is the difference between the camera's own picture and
        // `libx264 -crf 28`, and it is the first thing to check when a clip
        // looks soft. Reported, never inferred from the byte count.
        video: this.clipVideoMode(cut, render),
        sourceWidth: cut.sourceWidth,
        maxWidth: render.maxWidth,
        speed: render.speed ?? null,
        packets: cut.window.length,
        bytes: bytes.byteLength,
        coverageMs: cut.coverage.toTs - cut.coverage.fromTs,
      },
    })
    return bytes
  }

  // ── Device-scoped facades (for camera-streams cap) ───────────────────

  getCameraStreamsForDevice(deviceId: number): readonly CameraStream[] {
    const streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap) return []
    return [...streamMap.values()]
      .toSorted((a, b) => a.order - b.order)
      .map((s) => this.toCameraStream(s))
  }

  getProfileSlotsForDevice(deviceId: number): readonly ProfileSlot[] {
    // Return empty for devices the broker has never touched — avoids
    // phantom `unassigned` slots for every numeric id in the universe.
    if (!this.cameraStreams.has(deviceId) && !this.assignments.has(deviceId)) return []
    return this.snapshotProfileSlots(deviceId)
  }

  // ── Internal: live broker lookup (not a cap method) ─────────────────

  /**
   * Resolve the live `StreamBroker` instance for a broker id. In-process
   * only — a `StreamBroker` is not tRPC-serialisable, so this is reachable
   * solely from same-process callers (device-scoped providers, the WebRTC
   * server). Cross-process stats go through `getBrokerStats` / `listClients`.
   */
  async getBroker(input: { brokerId: string }): Promise<IStreamBroker | null> {
    return this.brokers.get(input.brokerId) ?? null
  }

  // ── Cap methods: broker runtime (stats + client inventory) ──────────

  /**
   * Drop every `audioSubscriptionBroker` entry pointing at `brokerId`. Called
   * on broker teardown so a destroyed broker leaves no dangling
   * `subscriptionId → brokerId` rows (a slow consumer that never calls
   * `unsubscribeAudioChunks` would otherwise leak a map entry per stream).
   */
  private sweepAudioSubscriptions(brokerId: string): void {
    for (const [subscriptionId, mappedBrokerId] of this.audioSubscriptionBroker) {
      if (mappedBrokerId === brokerId) {
        this.audioSubscriptionBroker.delete(subscriptionId)
      }
    }
  }

  // ── Cap methods: decoded audio-chunk plane (Phase 5 / D9) ────────────

  /**
   * Open a decoded audio-chunk subscription on a broker — the poll-based,
   * tRPC-reachable replacement for the live-object `onDecodedAudioChunk`
   * callback. The consumer then polls `pullAudioChunks` and feeds each
   * `DecodedAudioChunk` to its downstream audio logic. Audio chunks are tiny
   * so their bytes travel inline on the RPC wire — no shared memory.
   */
  async subscribeAudioChunks(
    input: SubscribeAudioChunksInput,
  ): Promise<SubscribeAudioChunksResult> {
    await this.ensureBrokerForId(input.brokerId)
    const broker = this.brokers.get(input.brokerId)
    if (!broker) {
      throw new Error(`stream-broker: no broker for "${input.brokerId}"`)
    }
    const result = broker.subscribeAudioChunks({
      tag: input.tag,
      accept: input.accept,
    })
    this.audioSubscriptionBroker.set(result.subscriptionId, input.brokerId)
    return result
  }

  /** Drain `DecodedAudioChunk`s for a subscription opened via `subscribeAudioChunks`. */
  async pullAudioChunks(input: {
    subscriptionId: string
    maxCount: number
  }): Promise<readonly DecodedAudioChunk[]> {
    const brokerId = this.audioSubscriptionBroker.get(input.subscriptionId)
    if (!brokerId) return []
    const broker = this.brokers.get(brokerId)
    if (!broker) return []
    return broker.pullAudioChunks(input.subscriptionId, input.maxCount)
  }

  /** Release an audio-chunk subscription. */
  async unsubscribeAudioChunks(input: { subscriptionId: string }): Promise<{ released: boolean }> {
    const brokerId = this.audioSubscriptionBroker.get(input.subscriptionId)
    if (!brokerId) return { released: false }
    this.audioSubscriptionBroker.delete(input.subscriptionId)
    const broker = this.brokers.get(brokerId)
    if (!broker) return { released: false }
    const released = broker.unsubscribeAudioChunks(input.subscriptionId)
    return { released }
  }

  async getBrokerStats(input: { brokerId: string }): Promise<BrokerStats> {
    const broker = this.brokers.get(input.brokerId)
    if (!broker) {
      return {
        status: 'stopped',
        inputFps: 0,
        encodedSubscribers: 0,
        uptimeMs: 0,
        bitrateKbps: 0,
        idrIntervalMs: 0,
        totalBytes: 0,
        packetCount: 0,
        rtspClients: 0,
        pipeClients: 0,
        preBufferSec: 0,
        preBufferMs: 0,
        preBufferPackets: 0,
        audio: null,
      }
    }
    return broker.getStats()
  }

  async listClients(input: { brokerId: string }): Promise<import('@camstack/types').BrokerClients> {
    const broker = this.brokers.get(input.brokerId)
    if (!broker) {
      return {
        rtsp: [],
        audio: [],
        encoded: [],
        pipeClients: 0,
        encodedSubscribers: 0,
      }
    }
    return broker.listClients()
  }

  /**
   * People watching each camera live right now (cap `getLiveViewerCounts`).
   * Two planes, one definition (`live-viewers.ts`): the WebRTC server's live
   * viewer sessions plus every broker's external RTSP restream clients, summed
   * per camera over all of its profile brokers. Both are read off live session
   * maps — no stored counter — so an ended session cannot be left counted.
   */
  async getLiveViewerCounts(): Promise<readonly LiveViewerCount[]> {
    const rtsp = new Map<number, number>()
    for (const [brokerId, broker] of this.brokers) {
      const n = broker.countExternalRestreamViewers()
      const deviceId = deviceIdFromBrokerId(brokerId)
      if (n > 0 && deviceId !== undefined) rtsp.set(deviceId, (rtsp.get(deviceId) ?? 0) + n)
    }
    const webrtc: ViewerCounts = this.webrtcServer?.countLiveViewers() ?? new Map<number, number>()
    return [...mergeViewerCounts([webrtc, rtsp])]
      .map(([deviceId, viewers]) => ({ deviceId, viewers }))
      .sort((a, b) => a.deviceId - b.deviceId)
  }

  async killClient(input: {
    brokerId: string
    channel: 'rtsp' | 'audio'
    handle: string
  }): Promise<{ killed: boolean }> {
    const broker = this.brokers.get(input.brokerId)
    if (!broker) return { killed: false }
    return { killed: broker.killClient(input.channel, input.handle) }
  }

  /** Raw broker instances — internal use only. */
  /** Live egress transcodes (ffmpeg children) — the `[broker-mem]` probe. */
  getEgressTranscodeCount(): number {
    return this.egressTranscodeManager?.activeCount() ?? 0
  }

  getBrokerInstances(): readonly StreamBroker[] {
    return [...this.brokers.values()]
  }

  /**
   * Record the latest runtime probe for a broker. Called from the addon's
   * periodic metrics loop. Only streaming brokers are captured — an idle or
   * suspended broker carries zeroed/empty stats and would clobber the last
   * good probe we want to keep showing in the per-stream settings field.
   */
  recordProbeSnapshot(brokerId: string, stats: BrokerStats, at: number): void {
    if (stats.status !== 'streaming') return
    this.lastProbedByBroker.set(brokerId, {
      ...(stats.codec !== undefined ? { codec: stats.codec } : {}),
      bitrateKbps: stats.bitrateKbps,
      idrIntervalMs: stats.idrIntervalMs,
      audio: stats.audio ?? null,
      at,
    })
  }

  /** Serialize the probe map for durable persistence (whole-object round-trip). */
  getProbeSnapshots(): ProbedSnapshotMap {
    const out: ProbedSnapshotMap = {}
    for (const [brokerId, snap] of this.lastProbedByBroker) out[brokerId] = snap
    return out
  }

  /** Seed the probe map from a persisted blob on boot (so the per-stream
   *  "Probed" field is populated before the first post-restart pull). */
  loadProbeSnapshots(blob: ProbedSnapshotMap): void {
    for (const [brokerId, snap] of Object.entries(blob)) this.lastProbedByBroker.set(brokerId, snap)
  }

  /** Render the current probed summary string for a broker (declared + last snapshot). */
  private buildProbeSummary(brokerId: string): {
    probed: boolean
    summary: string
  } {
    const parsed = parseBrokerId(brokerId)
    const snap = this.lastProbedByBroker.get(brokerId) ?? null
    const stream = parsed
      ? this.cameraStreams.get(parsed.deviceId)?.get(parsed.camStreamId)
      : undefined
    const summary = formatProbedSummary(
      {
        ...(stream?.codec !== undefined ? { codec: stream.codec } : {}),
        ...(stream?.resolution !== undefined ? { resolution: stream.resolution } : {}),
        ...(stream?.fps !== undefined ? { fps: stream.fps } : {}),
      },
      snap,
      snap ? { asOf: formatClockHHMM(snap.at) } : undefined,
    )
    return { probed: snap !== null, summary }
  }

  /**
   * Force a one-shot probe of one source stream (the "Probe now" button on the
   * per-stream settings field). Attaches a transient `warmup` consumer so the
   * broker dials/resumes on-demand, polls `getStats` until it reaches
   * `streaming` (and audio detection settles) or the timeout, captures the
   * snapshot, then detaches — the broker suspends again if nothing else holds
   * demand. Wakes suspended/battery streams: this is an explicit operator action.
   */
  async probeStream(input: { brokerId: string }): Promise<{ probed: boolean; summary: string }> {
    const parsed = parseBrokerId(input.brokerId)
    if (!parsed) return this.buildProbeSummary(input.brokerId)

    await this.ensureBroker(parsed.deviceId, parsed.camStreamId)
    const broker = this.brokers.get(input.brokerId)
    if (!broker) return this.buildProbeSummary(input.brokerId)

    // Transient demand → broker dials/resumes; the no-op callback just keeps
    // the source alive while we read stats. Released in `finally`.
    const unsubscribe = broker.onEncodedData(() => {}, {
      kind: 'warmup',
      label: 'force-probe',
      media: 'both',
    })
    try {
      const deadline = Date.now() + PROBE_STREAM_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PROBE_STREAM_POLL_MS))
        const stats = broker.getStats()
        if (stats.status === 'streaming') {
          this.recordProbeSnapshot(input.brokerId, stats, Date.now())
          // `audio === undefined` means the SDP audio track hasn't been detected
          // yet; once it settles (null or present) the probe is complete.
          if (stats.audio !== undefined) break
        }
      }
    } finally {
      unsubscribe()
    }
    return this.buildProbeSummary(input.brokerId)
  }

  async destroyAll(): Promise<void> {
    if (this.streamHealthTimer) {
      clearInterval(this.streamHealthTimer)
      this.streamHealthTimer = undefined
    }
    // Let any in-flight reverse-flip teardown settle before we tear everything
    // down, so a releaseBroker racing destroyAll doesn't touch freed state.
    await this.lastOwnershipReconcile.catch(() => undefined)
    if (this.transcodeManager) {
      this.transcodeManager.shutdownAll()
      this.transcodeManager = null
    }
    // The egress primitive's children. This is also the only thing that
    // reclaims a refcount whose holder died without releasing — there is no
    // lease TTL (D67).
    if (this.egressTranscodeManager) {
      await this.egressTranscodeManager.shutdownAll()
      this.egressTranscodeManager = null
    }
    // Kill every derived feeder (ffmpeg + source refcount) before stopping the
    // brokers so no transcode outlives the manager.
    for (const brokerId of [...this.derivedFeeders.keys()]) this.detachDerivedFeeder(brokerId)
    const stopPromises = [...this.brokers.values()].map((broker) => broker.stop())
    await Promise.all(stopPromises)
    this.brokers.clear()
    this.streamHealthByBroker.clear()
    this.streamOfflineReasonByBroker.clear()
    this.sleepSuppressedBrokers.clear()
    this.batteryProbe.clear()
    this.demandSince.clear()
    this.deviceOutages.clear()
    this.audioSubscriptionBroker.clear()
    await this.rtspServer.stop()
  }

  // ── Stream health watchdog ──────────────────────────────────────────
  //
  // Polls every active broker every STREAM_HEALTH_POLL_MS. A broker is
  // considered stale when its last video packet is older than
  // STREAM_STALE_TIMEOUT_MS. State transitions emit `stream.online` /
  // `stream.offline` on the event bus; payload includes the camStreamId
  // currently bound to the profile slot (the operator-visible "key").
  //
  // Brokers whose slot is unassigned (no camStreamId) skip emission —
  // there is no published stream to report on.

  private startStreamHealthWatchdog(): void {
    if (this.streamHealthTimer) return
    this.streamHealthTimer = setInterval(() => this.evaluateStreamHealth(), STREAM_HEALTH_POLL_MS)
  }

  /**
   * @internal Test seam. Registers a pre-built broker under `brokerId` and runs
   * ONE stream-health evaluation pass synchronously. Production registers
   * brokers through the publish/assignment path and runs the sweep on the
   * {@link STREAM_HEALTH_POLL_MS} interval; this exists only so the
   * level-triggered phantom-streaming redial (the self-healing backstop) can be
   * asserted in isolation without standing up the full assignment pipeline.
   */
  runStreamHealthSweepForTest(brokerId: string, broker: StreamBroker): void {
    this.brokers.set(brokerId, broker)
    this.evaluateStreamHealth()
  }

  private evaluateStreamHealth(): void {
    if (!this.eventBus) return
    const now = Date.now()
    // Devices whose outage opened / whose broker came back during this pass.
    // The emission is DEVICE-level and happens after the loop, so main + sub
    // dropping in one sweep is one event naming both (D883).
    const outageOpenedOn = new Map<number, StreamHealthEmitContext>()
    const cameBackOn = new Map<number, StreamHealthEmitContext>()
    for (const [brokerId, broker] of this.brokers) {
      const parsed = this.parseBrokerId(brokerId)
      if (!parsed) continue
      const { deviceId, camStreamId } = parsed
      // An EGRESS pipe's online/offline is not a fact about the camera — see
      // `stream-health-scope.ts` for the pair of notifications every Alexa
      // session was sending the operator.
      if (!healthEventIsOperatorFacing(camStreamId)) continue
      const lastPacketAt = broker.getLastPacketAt()
      const wasHealthy = this.streamHealthByBroker.get(brokerId)
      const isHealthy = lastPacketAt > 0 && now - lastPacketAt <= STREAM_STALE_TIMEOUT_MS
      // Level-triggered self-healing backstop (runs BEFORE the transition
      // early-out below). A broker that still reports `status:'streaming'` while
      // its packets have gone stale is in the phantom state the rfc4571 reboot
      // wedge produced — 'streaming' latched by `onPlaying` (loopback TCP open),
      // no media flowing. The edge-triggered emit could not recover it: once
      // flagged stale, `wasHealthy === isHealthy` short-circuits every later
      // pass. Force a redial each sweep until it recovers or its status leaves
      // 'streaming'. `redial()` is internally guarded on demand / manualStop.
      if (!isHealthy && broker.getStats().status === 'streaming') {
        broker.redial('stream-health sweep: phantom streaming, no packets within stale window')
      }
      const context: StreamHealthEmitContext = {
        deviceId,
        camStreamId,
        brokerId,
        sourceType: broker.getActiveSourceType(),
        lastPacketAt,
      }
      if (wasHealthy === isHealthy) {
        // A quiet stream is LEVEL state, not only an edge (D883): a camera that
        // slept and then died, or whose wake was demanded and never delivered,
        // makes no transition. Re-judge what was suppressed, and keep an outage
        // consistent with the consumer that held it open.
        if (!isHealthy) {
          this.rejudgeQuietBroker(brokerId, broker, context, now, outageOpenedOn)
        }
        continue
      }
      // Never-online is not an outage. `isHealthy` is false the instant
      // `lastPacketAt === 0`, so a demanded derived whose feeder is still
      // waiting on its source (motion wakes it before `native:slot-*` is
      // published) used to emit `stale-timeout` on the first sweep — NC
      // accepted it, then accepted the later `recovered` when packets
      // arrived. Idle suspend still announces (`suspended`, discarded by
      // NC) so a later resume is labelled `resumed` rather than
      // `recovered`. Seed the map without emitting and without an offline
      // reason; the first real packet then lands as `first-packet`.
      if (wasHealthy === undefined && !isHealthy && !broker.suspended) {
        this.streamHealthByBroker.set(brokerId, false)
        continue
      }
      // What a quiet, demanded-or-not stream means is decided BEFORE the flip
      // is recorded: a verdict that has to wait for a read leaves the edge
      // standing, and the next sweep judges it again.
      let verdict: StaleStreamVerdict | 'defer' | null = null
      if (!isHealthy && !broker.suspended) {
        verdict = this.judgeQuietStream(brokerId, deviceId, broker, now)
        if (verdict === 'defer') continue
      }
      this.streamHealthByBroker.set(brokerId, isHealthy)
      const wasSleepSuppressed = this.sleepSuppressedBrokers.delete(brokerId)
      const previousReason = this.streamOfflineReasonByBroker.get(brokerId)

      if (verdict !== null) {
        if (verdict.kind === 'suppressed') {
          // A battery camera that went to sleep. The designed steady state:
          // no event, but the branch says so (a branch that drops work logs it).
          this.markSleepSuppressed(brokerId, context, verdict.presence, lastPacketAt)
          continue
        }
        this.openStreamOutage(brokerId, context, verdict.reason, now, outageOpenedOn)
        continue
      }

      if (!isHealthy) {
        // Idle suspend — deliberate, per-broker lazy-dial telemetry.
        this.demandSince.delete(brokerId)
        this.streamOfflineReasonByBroker.set(brokerId, 'suspended')
        this.emitStreamHealth(false, { ...context, reason: 'suspended' })
        continue
      }

      // The broker is delivering again. Absence of a stored offline reason
      // means we never announced an outage for it (the never-online seed above),
      // so the first healthy flip is `first-packet`.
      this.streamOfflineReasonByBroker.delete(brokerId)
      this.demandSince.delete(brokerId)
      if (wasSleepSuppressed) {
        this.logger.info('battery camera woke and delivers a stream — plain wake, no event', {
          tags: { deviceId },
          meta: { camStreamId },
        })
      }
      if (this.deviceOutages.get(deviceId) !== undefined) {
        if (!cameBackOn.has(deviceId)) cameBackOn.set(deviceId, context)
        continue
      }
      if (wasSleepSuppressed) {
        void this.writeCameraStreamsSlice(deviceId, this.snapshotProfileSlots(deviceId))
        continue
      }
      const reason: StreamHealthReason = isStreamOutageReason(previousReason)
        ? 'recovered'
        : previousReason === 'suspended'
          ? 'resumed'
          : 'first-packet'
      this.emitStreamHealth(true, { ...context, reason })
    }
    for (const [deviceId, context] of outageOpenedOn) this.announceDeviceOutage(deviceId, context)
    for (const [deviceId, context] of cameBackOn) this.settleDeviceOutage(deviceId, context)
    this.expireWakeOnlyOutages(now)
  }

  /** Record one stream as part of its device's outage (announced after the pass). */
  private openStreamOutage(
    brokerId: string,
    context: StreamHealthEmitContext,
    reason: Extract<
      StreamHealthReason,
      'stale-timeout' | 'wake-timeout' | 'connection-error' | 'battery-unreachable'
    >,
    now: number,
    outageOpenedOn: Map<number, StreamHealthEmitContext>,
  ): void {
    this.sleepSuppressedBrokers.delete(brokerId)
    this.streamOfflineReasonByBroker.set(brokerId, reason)
    this.deviceOutages.open(context.deviceId, context.camStreamId, reason, now)
    if (!outageOpenedOn.has(context.deviceId)) outageOpenedOn.set(context.deviceId, context)
  }

  private markSleepSuppressed(
    brokerId: string,
    context: StreamHealthEmitContext,
    presence: string,
    lastPacketAt: number,
  ): void {
    this.sleepSuppressedBrokers.add(brokerId)
    this.streamOfflineReasonByBroker.delete(brokerId)
    this.logger.info(
      presence === 'awake'
        ? 'stream quiet on a battery camera that just woke — not an outage yet, judged again after the wake bound'
        : 'stream quiet on a sleeping battery camera — not an outage',
      {
        tags: { deviceId: context.deviceId },
        meta: { camStreamId: context.camStreamId, presence, lastPacketAt },
      },
    )
    void this.writeCameraStreamsSlice(context.deviceId, this.snapshotProfileSlots(context.deviceId))
  }

  /**
   * The verdict on a quiet, non-idle stream. `'defer'` = the device's battery
   * class is still being asked of the registry; the edge is kept and judged
   * again. A class that could not be answered, or a slice never read, judges as
   * a mains camera — never as a sleeper (D49).
   */
  private judgeQuietStream(
    brokerId: string,
    deviceId: number,
    broker: StreamBroker,
    now: number,
  ): StaleStreamVerdict | 'defer' {
    const probe = this.ensureBatteryProbe(deviceId, now)
    if (probe.state === 'pending') return 'defer'
    const battery = probe.isBattery === true && probe.facts !== null ? { facts: probe.facts } : null
    return judgeStaleStream({
      battery,
      demanded: this.demandHeldPastBound(brokerId, broker, now),
      nowMs: now,
    })
  }

  private demandHeldPastBound(brokerId: string, broker: StreamBroker, now: number): boolean {
    if (!broker.hasLiveDemand()) {
      this.demandSince.delete(brokerId)
      return false
    }
    const since = this.demandSince.get(brokerId) ?? now
    this.demandSince.set(brokerId, since)
    return now - since >= WAKE_DEMAND_BOUND_MS
  }

  /**
   * A broker that stays quiet, pass after pass. Three things can be true of it:
   * it was suppressed as a sleeper (the camera may have died, or a wake may
   * have been demanded since); it went idle while holding an outage open; or it
   * resumed from an idle suspend on a battery camera that never answered.
   */
  private rejudgeQuietBroker(
    brokerId: string,
    broker: StreamBroker,
    context: StreamHealthEmitContext,
    now: number,
    outageOpenedOn: Map<number, StreamHealthEmitContext>,
  ): void {
    const { deviceId } = context
    const reason = this.streamOfflineReasonByBroker.get(brokerId)
    if (isStreamOutageReason(reason) && broker.suspended) {
      this.dropSuspendedOutage(brokerId, context)
      return
    }
    const suppressed = this.sleepSuppressedBrokers.has(brokerId)
    const resumedQuiet = reason === 'suspended' && !broker.suspended
    if (!suppressed && !resumedQuiet) return
    if (broker.suspended) {
      this.demandSince.delete(brokerId)
      return
    }
    this.refreshBatteryFactsIfDue(deviceId, now)
    const probe = this.batteryProbe.get(deviceId)
    // Only a battery camera whose slice was read is re-judged here. A resumed
    // MAINS stream is quiet because it was idle, and its first packet is
    // `resumed` — judging it now would invent the outage the suspend avoids.
    if (probe?.state !== 'done' || probe.isBattery !== true || probe.facts === null) return
    const verdict = judgeStaleStream({
      battery: { facts: probe.facts },
      demanded: this.demandHeldPastBound(brokerId, broker, now),
      nowMs: now,
    })
    if (verdict.kind === 'suppressed') return
    this.logger.warn('quiet battery stream is now an outage', {
      tags: { deviceId },
      meta: { camStreamId: context.camStreamId, reason: verdict.reason },
    })
    this.openStreamOutage(brokerId, context, verdict.reason, now, outageOpenedOn)
  }

  /**
   * An outage stream whose last consumer left (the broker went idle). Nobody is
   * waiting for it any more, so the outage ends there — closed cleanly, with
   * the one online that lets every consumer clear its row (reason `suspended`,
   * which the notification gate discards).
   */
  private dropSuspendedOutage(brokerId: string, context: StreamHealthEmitContext): void {
    const { deviceId, camStreamId } = context
    this.demandSince.delete(brokerId)
    this.streamOfflineReasonByBroker.set(brokerId, 'suspended')
    const outage = this.deviceOutages.get(deviceId)
    this.logger.info('stream outage dropped — the broker went idle, nobody is waiting', {
      tags: { deviceId },
      meta: { camStreamId },
    })
    if (!outage) return
    outage.camStreamIds.delete(camStreamId)
    if (outage.camStreamIds.size > 0 || outage.wakeOnly) return
    this.closeDeviceOutage(deviceId, outage, 'suspended', context)
  }

  /** Close a device outage and, when it was announced, say so once (any online closes the rows). */
  private closeDeviceOutage(
    deviceId: number,
    outage: DeviceOutage,
    reason: StreamHealthReason,
    context: DeviceHealthContext,
  ): void {
    this.deviceOutages.close(deviceId)
    if (!outage.announced) return
    this.emitDeviceStreamHealth(true, deviceId, reason, new Set(), context)
  }

  /** Wake-only outages end when the failed wakes stop (demand released). */
  private expireWakeOnlyOutages(now: number): void {
    for (const [deviceId, outage] of [...this.deviceOutages.entries()]) {
      if (!outage.wakeOnly || now - outage.lastSignalAt < WAKE_ONLY_OUTAGE_TTL_MS) continue
      this.logger.info('wake failure outage ended — no further demand', {
        tags: { deviceId },
        meta: { reason: outage.reason },
      })
      this.closeDeviceOutage(deviceId, outage, 'suspended', {
        deviceId,
        brokerId: String(deviceId),
        sourceType: 'battery-wake',
        lastPacketAt: 0,
      })
    }
  }

  // ── Battery facts: the registry and the slice, not only a droppable event ──

  /** The device's battery probe; starts the read when there is none (or a retry is due). */
  private ensureBatteryProbe(deviceId: number, now: number): BatteryProbe {
    const existing = this.batteryProbe.get(deviceId)
    if (existing === undefined) {
      if (!this.api) {
        // Nothing to ask: judged as a mains camera, as before this existed.
        const none: BatteryProbe = { state: 'done', isBattery: null, facts: null, readAt: now }
        this.batteryProbe.set(deviceId, none)
        return none
      }
      const pending: BatteryProbe = { state: 'pending', isBattery: null, facts: null, readAt: now }
      this.batteryProbe.set(deviceId, pending)
      void this.probeBattery(deviceId)
      return pending
    }
    if (
      existing.state === 'done' &&
      existing.isBattery === null &&
      this.api &&
      now - existing.readAt >= BATTERY_PROBE_RETRY_MS &&
      !this.batteryProbeInFlight.has(deviceId)
    ) {
      void this.probeBattery(deviceId)
    }
    return existing
  }

  private async probeBattery(deviceId: number): Promise<void> {
    this.batteryProbeInFlight.add(deviceId)
    try {
      const isBattery = await this.isBatteryOperated(deviceId)
      const facts = isBattery === true ? await this.readBatterySleepFacts(deviceId) : null
      const current = this.batteryProbe.get(deviceId)
      // An event that landed while we were reading is newer than the read.
      this.batteryProbe.set(deviceId, {
        state: 'done',
        isBattery: current?.isBattery === true ? true : isBattery,
        facts: current?.facts ?? facts,
        readAt: Date.now(),
      })
    } finally {
      this.batteryProbeInFlight.delete(deviceId)
    }
  }

  private refreshBatteryFactsIfDue(deviceId: number, now: number): void {
    const probe = this.batteryProbe.get(deviceId)
    if (probe?.state !== 'done' || probe.isBattery !== true) return
    if (now - probe.readAt < BATTERY_PROBE_RETRY_MS || this.batteryProbeInFlight.has(deviceId)) {
      return
    }
    this.batteryProbeInFlight.add(deviceId)
    void this.readBatterySleepFacts(deviceId)
      .then((facts) => {
        const current = this.batteryProbe.get(deviceId)
        this.batteryProbe.set(deviceId, {
          state: 'done',
          isBattery: true,
          facts: carryAwakeSince(current?.facts ?? null, facts) ?? current?.facts ?? null,
          readAt: Date.now(),
        })
      })
      .finally(() => this.batteryProbeInFlight.delete(deviceId))
  }

  /** The device's `battery` slice as sleep facts, or `null` when it cannot be read. */
  private async readBatterySleepFacts(deviceId: number): Promise<BatterySleepFacts | null> {
    const api = this.api
    if (!api) return null
    const slice = await api.deviceState.getCapSlice
      .query({ deviceId, capName: batteryCapability.name })
      .catch(() => null)
    const parsed = BatteryStatusSchema.safeParse(slice)
    if (!parsed.success) return null
    return { sleeping: parsed.data.sleeping, lastContactAt: parsed.data.lastContactAt }
  }

  private recordBatterySleep(
    deviceId: number,
    status: { sleeping?: unknown; lastContactAt?: unknown } | null | undefined,
  ): void {
    const previous = this.batteryProbe.get(deviceId)
    const nowMs = Date.now()
    const facts: BatterySleepFacts | null =
      status && typeof status.sleeping === 'boolean'
        ? {
            sleeping: status.sleeping,
            ...(typeof status.lastContactAt === 'number'
              ? { lastContactAt: status.lastContactAt }
              : {}),
            ...awakeSinceFor(previous?.facts ?? null, status.sleeping, nowMs),
          }
        : null
    // The event is only ever emitted by a battery cap: it is also the class.
    this.batteryProbe.set(deviceId, {
      state: 'done',
      isBattery: true,
      facts: facts ?? previous?.facts ?? null,
      readAt: Date.now(),
    })
  }

  /**
   * A released broker can no longer carry an outage. When it was the last
   * stream holding an ANNOUNCED outage open, the outage is closed with an
   * online (`broker-destroyed`, which the notification gate discards but every
   * ledger and alert card clears on) — otherwise the row stays open for ever.
   */
  private forgetReleasedStreamOutage(context: StreamHealthEmitContext): void {
    const { deviceId, camStreamId } = context
    const outage = this.deviceOutages.get(deviceId)
    if (!outage || !outage.camStreamIds.delete(camStreamId)) return
    if (outage.camStreamIds.size > 0) return
    this.logger.info('stream outage closed — its last stream was released', {
      tags: { deviceId },
      meta: { reason: outage.reason, camStreamId, announced: outage.announced },
    })
    this.closeDeviceOutage(deviceId, outage, 'broker-destroyed', context)
  }

  /** The ONE `stream.offline` of a device outage, naming every stream it covers. */
  private announceDeviceOutage(deviceId: number, context: DeviceHealthContext): void {
    const outage = this.deviceOutages.get(deviceId)
    if (!outage) return
    if (outage.announced) {
      this.logger.debug('stream outage joined an already announced one — no second event', {
        tags: { deviceId },
        meta: {
          camStreamIds: [...outage.camStreamIds],
          reason: outage.reason,
        },
      })
      return
    }
    outage.announced = true
    this.logger.warn('stream outage', {
      tags: { deviceId },
      meta: { reason: outage.reason, camStreamIds: [...outage.camStreamIds] },
    })
    this.emitDeviceStreamHealth(false, deviceId, outage.reason, outage.camStreamIds, context)
  }

  /**
   * A broker of a device in outage is delivering again. The device is back when
   * no stream of it is still down for an outage reason; then, and only then,
   * the single `stream.online` (`recovered`) goes out.
   */
  private settleDeviceOutage(deviceId: number, context: DeviceHealthContext): void {
    const outage = this.deviceOutages.get(deviceId)
    if (!outage) return
    for (const camStreamId of [...outage.camStreamIds]) {
      const brokerId = brokerIdFor(deviceId, camStreamId)
      const stillDown = isStreamOutageReason(this.streamOfflineReasonByBroker.get(brokerId))
      if (!stillDown) outage.camStreamIds.delete(camStreamId)
    }
    if (outage.camStreamIds.size > 0) return
    this.deviceOutages.close(deviceId)
    if (!outage.announced) return
    this.logger.info('stream outage over — device delivers again', {
      tags: { deviceId },
      meta: { reason: outage.reason, outageMs: Date.now() - outage.since },
    })
    this.emitDeviceStreamHealth(
      true,
      deviceId,
      'recovered',
      new Set(context.camStreamId !== undefined ? [context.camStreamId] : []),
      context,
    )
  }

  /**
   * A wake somebody ASKED for did not produce a stream (the viewer's play
   * button, found no broker and a wake that settled nothing). This is the one
   * failure with no broker to carry it, so it opens the device outage itself.
   */
  announceBatteryWakeFailure(
    deviceId: number,
    camStreamId: string | undefined,
    reason: Extract<StreamHealthReason, 'wake-timeout' | 'battery-unreachable'>,
  ): void {
    if (!this.eventBus) return
    // Keyed to the device's REAL streams — never an invented id. A camera with
    // none published yet (a sleeper after a restart) is named by the device.
    const published = [...(this.cameraStreams.get(deviceId)?.keys() ?? [])]
    const streamIds =
      camStreamId !== undefined && published.includes(camStreamId) ? [camStreamId] : published
    this.deviceOutages.openWake(deviceId, streamIds, reason, Date.now())
    this.announceDeviceOutage(deviceId, {
      deviceId,
      ...(streamIds[0] !== undefined ? { camStreamId: streamIds[0] } : {}),
      brokerId: streamIds[0] !== undefined ? brokerIdFor(deviceId, streamIds[0]) : String(deviceId),
      sourceType: 'battery-wake',
      lastPacketAt: 0,
    })
  }

  private emitDeviceStreamHealth(
    online: boolean,
    deviceId: number,
    reason: StreamHealthReason,
    camStreamIds: ReadonlySet<string>,
    context: DeviceHealthContext,
  ): void {
    const ids = [...camStreamIds]
    const first = ids[0] ?? context.camStreamId
    const assignments = this.assignments.get(deviceId)?.map ?? {}
    this.emitStreamHealth(online, {
      ...context,
      deviceId,
      ...(first !== undefined ? { camStreamId: first } : {}),
      brokerId: first !== undefined ? brokerIdFor(deviceId, first) : context.brokerId,
      profile: first !== undefined ? findProfileForStream(assignments, first) : null,
      reason,
      camStreamIds: ids,
    })
  }

  private emitStreamHealth(
    online: boolean,
    payload: {
      deviceId: number
      camStreamId?: string
      profile?: CamProfile | null
      brokerId: string
      sourceType: string
      lastPacketAt: number
      reason: StreamHealthReason
      camStreamIds?: readonly string[]
    },
  ): void {
    const bus = this.eventBus
    if (!bus) return
    const category = online ? 'stream.online' : 'stream.offline'
    const profile =
      payload.profile !== undefined
        ? payload.profile
        : payload.camStreamId !== undefined
          ? findProfileForStream(
              this.assignments.get(payload.deviceId)?.map ?? {},
              payload.camStreamId,
            )
          : null
    bus.emit({
      id: `${category}-${payload.brokerId}-${Date.now()}`,
      timestamp: new Date(),
      category,
      source: { type: 'stream-broker', id: payload.brokerId },
      data: { ...payload, profile },
    })
    // Slot status flipped — re-snapshot and propagate to the device's
    // `camera-streams` runtime-state slice so consumers (RTSP autonomous
    // online tracking, UI dashboards) get push semantics without having
    // to subscribe to the per-stream events themselves. SLICE-ONLY:
    // we deliberately do NOT fire `onProfileSlotsChanged` here — the
    // orchestrator listens to that event to restart detection, but a
    // health flip (lazy-dial suspend / on-demand resume) is not a slot
    // mutation and must not tear down the runner attachment. Without
    // this guard each `suspend()`/`start()` cycle would race a
    // `stopDetection`+`startDetection` pair, surfacing as
    // `PipelineCameraUnassigned`+`PipelineCameraAssigned` pairs in the
    // UI events panel.
    void this.writeCameraStreamsSlice(payload.deviceId, this.snapshotProfileSlots(payload.deviceId))
  }

  /**
   * Decompose a brokerId `${deviceId}/${camStreamId}` back into its
   * components. `camStreamId` may contain `:` (e.g. `native:main`), so
   * we split on the FIRST `/` only — everything after is the cam stream
   * id verbatim.
   */
  private parseBrokerId(brokerId: string): { deviceId: number; camStreamId: string } | null {
    const idx = brokerId.indexOf('/')
    if (idx <= 0) return null
    const deviceId = Number(brokerId.slice(0, idx))
    const camStreamId = brokerId.slice(idx + 1)
    if (!Number.isFinite(deviceId) || camStreamId.length === 0) return null
    return { deviceId, camStreamId }
  }

  async startRtspServer(port: number = 8554): Promise<void> {
    await this.rtspServer.start(port)
    this.logger.info('RTSP restream server listening', {
      meta: { port: this.rtspServer.getPort() },
    })
  }

  // ── Cap methods: pre-buffer ─────────────────────────────────────────

  async setPreBufferDuration(input: { brokerId: string; seconds: number }): Promise<void> {
    const broker = this.brokers.get(input.brokerId)
    if (!broker) return
    broker.setPreBufferDuration(input.seconds)
  }

  async getPreBufferInfo(input: { brokerId: string }): Promise<{
    configuredSec: number
    bufferedMs: number
    packetCount: number
  }> {
    const broker = this.brokers.get(input.brokerId)
    if (!broker) return { configuredSec: 0, bufferedMs: 0, packetCount: 0 }
    const stats = broker.getStats()
    return {
      configuredSec: stats.preBufferSec,
      bufferedMs: stats.preBufferMs,
      packetCount: stats.preBufferPackets,
    }
  }

  // ── Cap methods: stream URLs ────────────────────────────────────────

  async getStreamUrl(_input: { streamId: string; format: StreamFormat }): Promise<{ url: string }> {
    return { url: '' }
  }

  // ── Cap methods: RTSP restream ──────────────────────────────────────

  async getRtspPort(): Promise<number> {
    return this.rtspProvider.getRtspPort()
  }

  async getAllRtspEntries(input?: { hostname?: string }): Promise<readonly RtspRestreamEntry[]> {
    return this.rtspProvider.getAllEntries(input?.hostname).map((e) => this.enrichRtspEntry(e))
  }

  /** Device-scoped RTSP entry fetch — backs `cameraStreams.getRtspEntries`. */
  getRtspEntriesForDevice(deviceId: number, hostname?: string): readonly RtspRestreamEntry[] {
    return this.rtspProvider
      .getEntriesForDevice(deviceId, hostname)
      .map((e) => this.enrichRtspEntry(e))
  }

  /** Device-scoped PROFILE RTSP entry fetch — backs `cameraStreams.getProfileRtspEntries`. */
  getProfileRtspEntriesForDevice(deviceId: number, hostname?: string): readonly ProfileRtspEntry[] {
    if (!this.assignments.has(deviceId)) return []
    // Ensure the profile→source aliasing is current before reading URLs.
    this.syncProfileRestreamers(deviceId)
    const assignmentMap = this.assignments.get(deviceId)?.map ?? {}
    const streamMap = this.cameraStreams.get(deviceId)
    return buildProfileRtspEntries({
      deviceId,
      assignmentMap,
      resolveEntry: (profileBrokerId) => this.rtspProvider.getEntry(profileBrokerId, hostname),
      resolveMeta: (camStreamId) => {
        const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
        const cam = streamMap?.get(camStreamId)
        const codec = broker?.getStats()?.codec ?? cam?.codec
        return {
          ...(codec !== undefined ? { codec } : {}),
          ...(cam?.resolution !== undefined ? { resolution: cam.resolution } : {}),
        }
      },
    })
  }

  /**
   * Keep one RTSP restreamer per assigned profile slot, aliasing the
   * assigned source broker's `RtspRestreamer` + a warm-up that drives
   * the source broker's single on-demand pull. So a profile consumer
   * (HAP/Alexa/recording) and a WebRTC consumer of the same profile
   * converge on ONE physical camera pull. Diff-based + idempotent: only
   * (re)registers when a profile's backing source changes, so a stable
   * token survives across reads (no mid-session token rotation).
   */
  private syncProfileRestreamers(deviceId: number): void {
    const assignmentMap = this.assignments.get(deviceId)?.map ?? {}
    const actions = computeProfileRestreamerActions({
      deviceId,
      assignmentMap,
      sourceBrokerExists: (camStreamId) => this.brokers.has(brokerIdFor(deviceId, camStreamId)),
      currentBindings: this.profileRestreamerBindings,
    })
    if (actions.register.length === 0 && actions.unregister.length === 0) return
    for (const profileBrokerId of actions.unregister) {
      this.rtspServer.unregisterRestreamer(profileBrokerId)
      this.profileRestreamerBindings.delete(profileBrokerId)
    }
    for (const { profileBrokerId, camStreamId } of actions.register) {
      const sourceBrokerId = brokerIdFor(deviceId, camStreamId)
      const sourceBroker = this.brokers.get(sourceBrokerId)
      if (!sourceBroker) continue
      if (this.restreamGate(deviceId)) continue
      const existingToken = this.persistedTokens.get(profileBrokerId)
      // Warm-up: subscribing a no-op encoded consumer to the SOURCE
      // broker keeps it dialed for the lifetime of an RTSP session, so
      // the profile DESCRIBE doesn't race a cold broker.
      const warmUp = (): (() => void) =>
        sourceBroker.onEncodedData(() => {
          /* warm-up no-op */
        }, RTSP_DESCRIBE_WARMUP_ATTRIBUTION)
      // The profile's sentry opens the SOURCE broker's picture window — the
      // same broker the warm-up above would have dialled, and the same reason
      // it must not be dialled for a sentry (D502).
      const openPrestreamWindow = (): (() => void) => sourceBroker.openPrestreamWindow()
      this.rtspServer.registerRestreamer(
        profileBrokerId,
        sourceBroker.getRtspRestreamer(),
        warmUp,
        existingToken,
        openPrestreamWindow,
      )
      this.profileRestreamerBindings.set(profileBrokerId, sourceBrokerId)
      if (!existingToken) this.rtspProvider.persistTokens()
    }
  }

  /**
   * Enrich a bare RTSP entry with the source camStream's `codec` /
   * `resolution`. The provider doesn't know — it only owns tokens + URL
   * minting — but the consumer-side pickers
   * (`pickPreferredRtspEntry`, the exporter's `resolveSourceParams`)
   * need that shape to resolve `streamPreference: 'auto'` to the slot
   * whose source is closest to the consumer's target. Falls back to
   * the bare entry when the brokerId points at a stream the manager
   * never registered (legacy + race scenarios) — the picker then
   * silently degrades to first-enabled.
   */
  private enrichRtspEntry(entry: RtspRestreamEntry): RtspRestreamEntry {
    const parsed = parseBrokerId(entry.brokerId)
    if (!parsed) return entry
    const stream = this.cameraStreams.get(parsed.deviceId)?.get(parsed.camStreamId)
    if (!stream) return entry
    return {
      ...entry,
      ...(stream.codec !== undefined ? { codec: stream.codec } : {}),
      ...(stream.resolution !== undefined ? { resolution: stream.resolution } : {}),
    }
  }

  async getRtspEntry(input: {
    brokerId: string
    hostname?: string
  }): Promise<RtspRestreamEntry | null> {
    return this.rtspProvider.getEntry(input.brokerId, input.hostname)
  }

  async regenerateRtspToken(input: { brokerId: string }): Promise<string | null> {
    const parsedBrokerId = parseBrokerId(input.brokerId)
    const tags = parsedBrokerId ? { deviceId: parsedBrokerId.deviceId } : undefined
    this.logger.info('regenerateRtspToken called', {
      tags,
      meta: { brokerId: input.brokerId },
    })
    const result = this.rtspProvider.regenerateToken(input.brokerId)
    if (result) {
      this.logger.info('regenerateRtspToken succeeded', {
        tags,
        meta: { brokerId: input.brokerId, newTokenPrefix: result.slice(0, 8) },
      })
    } else {
      this.logger.warn('regenerateRtspToken failed — broker not found', {
        tags,
        meta: { brokerId: input.brokerId },
      })
    }
    return result
  }

  async setRtspEnabled(input: { brokerId: string; enabled: boolean }): Promise<void> {
    this.rtspProvider.setEnabled(input.brokerId, input.enabled)
  }

  async isRtspEnabled(input: { brokerId: string }): Promise<boolean> {
    return this.rtspProvider.isEnabled(input.brokerId)
  }

  /**
   * Fan-out a placeholder reason to every broker registered for a
   * given device. Internal — drives the runtime-state-driven
   * placeholder behaviour: the broker manager subscribes to events
   * that reflect device state (battery sleep, online/offline,
   * disabled), translates them to a `PlaceholderReason`, and pushes
   * to the per-device broker set. Providers stay oblivious — they
   * only mutate their own runtime state.
   */
  private applyPlaceholderReasonToDevice(deviceId: number, reason: PlaceholderReason): void {
    const streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap) return
    for (const camStreamId of streamMap.keys()) {
      const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
      broker?.setPlaceholderReason(reason)
    }
  }

  // ── Device overrides (kept for per-profile pre-buffer tuning) ──────

  setDeviceOverridePersister(cb: (overrides: ReadonlyMap<number, DeviceOverride>) => void): void {
    this.deviceOverridePersister = cb
  }

  loadPersistedDeviceOverrides(overrides: ReadonlyMap<number, DeviceOverride>): void {
    this.deviceOverrides.clear()
    for (const [deviceId, persisted] of overrides) {
      // The retired per-stream pre-roll becomes the prebuffer it now means
      // (D381). Explicit, never a silent strip: the key would otherwise vanish
      // on the next save through a non-strict `z.object`, taking an operator's
      // configured history with it.
      const { override, migrated, superseded } = migrateRetiredPreRollOverride(persisted)
      if (migrated.length > 0 || superseded.length > 0) {
        this.logger.info('retired per-stream pre-roll folded into the prebuffer', {
          tags: { deviceId },
          meta: { migrated, superseded },
        })
      }
      this.deviceOverrides.set(deviceId, override)
    }

    // Queue any persisted derived streams for boot-time hydration.
    // publishCameraStream({kind:'derived'}) requires the source broker to
    // already be registered, which is not guaranteed at boot. For each
    // derived definition whose source is already up, we attempt the publish
    // immediately (inside the IIFE). If SOURCE_NOT_FOUND is thrown, the
    // definition is recorded in pendingDerivedStreams, keyed by the source
    // brokerId. publishCameraStream drains the queue when the source lands.
    void (async () => {
      for (const [deviceId, override] of overrides) {
        if (!override.derivedStreams) continue
        for (const [name, def] of Object.entries(override.derivedStreams)) {
          // Unconfigured placeholder (no source yet) — keep it persisted but
          // don't materialize a broker. A PROFILE source resolves its physical
          // stream dynamically (getStreamWithCodec), so it materializes now; a
          // CAMSTREAM source needs its source broker up first (may defer to the
          // pending queue on SOURCE_NOT_FOUND).
          if (!def.source) continue
          try {
            await this.publishCameraStream({
              deviceId,
              camStreamId: `derived:${name}`,
              kind: 'derived',
              source: def.source,
              encodeProfile: def.encodeProfile,
            })
          } catch (err) {
            const camStreamId = derivedSourceCamStreamId(def.source)
            if (camStreamId && err instanceof Error && err.message.includes('SOURCE_NOT_FOUND')) {
              const sourceBrokerId = brokerIdFor(deviceId, camStreamId)
              const list = this.pendingDerivedStreams.get(sourceBrokerId) ?? []
              list.push({ deviceId, name, def })
              this.pendingDerivedStreams.set(sourceBrokerId, list)
            }
          }
        }
      }
    })()
  }

  /**
   * Per-device streaming debug flag — controls verbose info-level
   * logging across the broker, WebRTC server, and session for one
   * device. Off by default.
   */
  isStreamingDebug(deviceId: number): boolean {
    return this.deviceOverrides.get(deviceId)?.streamingDebug === true
  }

  /**
   * Per-device "Advanced WebRTC debug logging" flag — when true, every
   * WebRTC session created for this device runs with `debug = true` so
   * the full negotiation/media lifecycle is logged. Off by default.
   * Independent of `isStreamingDebug`.
   *
   * Two independent arming paths, ORed, and they answer different questions:
   *
   *  - the per-camera SETTING is durable and operator-owned — "this camera is
   *    under investigation until I say otherwise";
   *  - the `stream-broker.webrtc` CHANNEL is a diagnostic WINDOW with a
   *    deadline, armed from `/system/logs` and expiring by itself.
   *
   * ORing them is not two authorities over one value: neither can turn the
   * other off, and each is reported where it was set. `CH_WEBRTC.on` is read
   * FIRST and is a plain boolean field, so a disarmed channel costs one load
   * and a branch — `wants()` is never called and no Set is consulted.
   */
  isWebrtcDebug(deviceId: number): boolean {
    if (this.deviceOverrides.get(deviceId)?.webrtcDebug === true) return true
    return CH_WEBRTC.on && CH_WEBRTC.wants(deviceId)
  }

  /**
   * Per-source-stream decode `hwaccel` override for a (deviceId, camStreamId)
   * source, or `null` when the stream has no override (→ the transcode manager
   * falls back to the global `ffmpeg.hwAccel`). Read by the transcode pipeline
   * per spawn; affects ONLY the transcode paths.
   */
  /**
   * A device reporting one of its own signals — the cap method the provider
   * calls. See `streamBroker.reportStreamSignal` for the contract.
   *
   * Everything that could refuse says WHY, because this is the path that
   * decides whether a battery camera wakes, and a silent refusal here is
   * indistinguishable from a signal that never arrived.
   */
  async reportStreamSignal(input: {
    deviceId: number
    code: string
    at?: number
  }): Promise<{ accepted: boolean; reason: StreamSignalOutcome }> {
    const at = input.at ?? Date.now()
    const declared = await this.declaredSignalCodes(input.deviceId)
    if (!declared.includes(input.code)) {
      this.logger.warn('wake signal REFUSED — this camera never declared that code', {
        tags: { deviceId: input.deviceId },
        meta: { code: input.code, declared },
      })
      return { accepted: false, reason: 'unknown-code' }
    }
    const settings = this.deviceOverrides.get(input.deviceId)?.sentry
    // Absent ⇒ every declared signal. An empty array is a deliberate "none".
    const enabled = settings?.enabledSignals ?? declared
    if (!enabled.includes(input.code)) {
      return { accepted: false, reason: 'not-enabled' }
    }
    const holdMs = settings?.holdMs ?? DEFAULT_WAKE_HOLD_MS
    // Every broker of this device: the signal is about the CAMERA, and which
    // of its profiles a consumer is waiting on is not the camera's business.
    let outcome: StreamSignalOutcome = 'no-consumer'
    for (const [brokerId, broker] of this.brokers) {
      const parsed = this.parseBrokerId(brokerId)
      if (parsed?.deviceId !== input.deviceId) continue
      const result = broker.reportWakeSignal(input.code, holdMs, at)
      if (result === 'woke') outcome = 'woke'
      else if (result === 'hold-extended' && outcome !== 'woke') outcome = 'hold-extended'
    }
    return { accepted: outcome !== 'no-consumer', reason: outcome }
  }

  /**
   * What this camera says it can emit. `[]` when it declares the cap and lists
   * nothing, and `[]` when it does not declare the cap at all — both mean no
   * signal of that name is acceptable, which is the same refusal.
   */
  /**
   * The signals a camera declares, with their labels — what the form renders.
   * `[]` on any failure, which the caller reads as "not eligible": a form built
   * from a list we could not read would offer wakes nobody confirmed.
   */
  private async declaredSignalList(deviceId: number): Promise<readonly StreamSignal[]> {
    const read = this.deviceSignalDetailReader
    if (read === null) return []
    try {
      return await read(deviceId)
    } catch {
      return []
    }
  }

  private async declaredSignalCodes(deviceId: number): Promise<readonly string[]> {
    const read = this.deviceSignalReader
    if (read === null) return []
    try {
      return await read(deviceId)
    } catch {
      // A read that failed is not a declaration. Refusing is the safe
      // direction here: the alternative is waking a camera on a code nobody
      // confirmed it can emit.
      return []
    }
  }

  /**
   * How the manager asks a DEVICE what signals it declares. Injected by the
   * host addon, which owns the device proxy. `null` until it is.
   */
  private deviceSignalReader: ((deviceId: number) => Promise<readonly string[]>) | null = null

  setDeviceSignalReader(read: (deviceId: number) => Promise<readonly string[]>): void {
    this.deviceSignalReader = read
  }

  /** The same read, with labels — the form needs them, the wake decision does
   *  not. Injected by the host addon for the same reason. */
  private deviceSignalDetailReader:
    | ((deviceId: number) => Promise<readonly StreamSignal[]>)
    | null = null

  setDeviceSignalDetailReader(read: (deviceId: number) => Promise<readonly StreamSignal[]>): void {
    this.deviceSignalDetailReader = read
  }

  /**
   * Whether this device runs on a battery.
   *
   * The DEVICE REGISTRY, never the published cam-streams: a sleeping camera has
   * none — which is precisely when this question gets asked — and
   * `deviceHasFeature` reads the stream map, so it answers `false` for every
   * sleeping battery camera. That reasoning was written for the wake-on-play
   * path and belongs to the question, not to one caller of it.
   *
   * `null` when nobody could say, and unknown is refused by every caller rather
   * than guessed: guessing yes puts a mains camera in a wake-hold loop, and
   * guessing no silently disables the feature on the cameras it exists for.
   */
  private async isBatteryOperated(deviceId: number): Promise<boolean | null> {
    if (!this.api) return null
    try {
      const device = await this.api.deviceManager.getDevice.query({ deviceId })
      const features = device?.features
      if (!Array.isArray(features)) return null
      return features.includes(DeviceFeature.BatteryOperated)
    } catch {
      return null
    }
  }

  getStreamHwAccelOverride(deviceId: number, camStreamId: string): FfmpegHwAccelSetting | null {
    return this.deviceOverrides.get(deviceId)?.hwaccel?.[camStreamId] ?? null
  }

  /**
   * Returns an EncodeProfile-shaped snapshot of the camStream's *probed*
   * source parameters — the codec / resolution / fps the publisher
   * advertised when it called `publishCameraStream`, optionally enriched
   * with live broker stats (bitrateKbps) when available.
   *
   * Used as `widgetConfig.sourceParams` so the FFmpeg parameters widget
   * can render a read-only "Source (probed)" chips card next to the
   * override editor. Returns `undefined` when the camStream isn't
   * registered or has no advertised media shape (the widget then
   * omits the card rather than showing fictitious zeros).
   *
   * Note: audio is reported as `'passthrough'` because the broker's
   * source side doesn't probe audio shape today — the widget's audio
   * chip will read "passthrough" rather than guess a sample rate.
   */
  getCameraStreamProbedParams(deviceId: number, camStreamId: string): EncodeProfile | undefined {
    const stream = this.cameraStreams.get(deviceId)?.get(camStreamId)
    if (stream === undefined) return undefined
    const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
    const stats = broker?.getStats()
    const rawCodec = (stream.codec ?? stats?.codec ?? '').toLowerCase()
    const codec: VideoEncode['codec'] = rawCodec === 'h265' ? 'h265' : 'h264'
    const video: VideoEncode = {
      codec,
      ...(stream.resolution?.width !== undefined ? { width: stream.resolution.width } : {}),
      ...(stream.resolution?.height !== undefined ? { height: stream.resolution.height } : {}),
      ...(stream.fps !== undefined ? { fps: stream.fps } : {}),
      ...(stats?.bitrateKbps !== undefined && stats.bitrateKbps > 0
        ? { bitrateKbps: Math.round(stats.bitrateKbps) }
        : {}),
    }
    // Nothing meaningful was advertised — omit so the widget hides the
    // probed card instead of showing only a codec chip.
    if (video.width === undefined && video.height === undefined && video.fps === undefined) {
      return undefined
    }
    return { video, audio: 'passthrough' as const }
  }

  // ── Device-details aggregator contribution ─────────────────────────

  async getDeviceSettingsContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    const deviceId = input.deviceId
    const streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap || streamMap.size === 0) return null
    const assignment = this.assignments.get(deviceId) ?? {
      map: {},
      auto: true,
    }
    const streams = [...streamMap.values()].toSorted((a, b) => a.order - b.order)
    const override = this.deviceOverrides.get(deviceId)

    const streamOptions = [
      { value: '', label: 'Not assigned' },
      ...streams.map((s) => ({
        value: s.camStreamId,
        label: this.labelForDropdown(s),
      })),
    ]

    const PROFILES: ReadonlyArray<{ key: CamProfile; label: string }> = [
      { key: 'high', label: 'High' },
      { key: 'mid', label: 'Mid' },
      { key: 'low', label: 'Low' },
    ]

    // ── Sub-tab "General" — three profile→stream selectors + derived stream names ──────
    const generalTab: ConfigSubTabDefinitionWithValue = {
      id: 'general',
      label: 'General',
      fields: [
        ...PROFILES.map(({ key: profile, label }) => ({
          type: 'select' as const,
          key: `streamProfile:${profile}`,
          label: `${label} Quality`,
          description: `Which camera stream serves the "${label}" profile slot`,
          options: streamOptions,
          span: 2 as const,
          value: assignment.map[profile] ?? '',
        })),
        {
          type: 'text' as const,
          key: 'derivedStreamNames',
          label: 'Derived stream names',
          description:
            'Add a name to create a new derived stream; configure its source and encode params in its tab below.',
          placeholder: 'e.g. web-720p',
          span: 2 as const,
          value: Object.keys(override?.derivedStreams ?? {}),
          multiple: {
            min: 0,
            max: 10,
            addLabel: 'Add derived stream',
            itemLabel: 'Stream ${n}',
          },
        },
      ],
    }

    // Decode `-hwaccel` options for the per-stream selector: the
    // always-valid settings (copy/auto/none) plus the backends this
    // host's ffmpeg build actually supports. Probed once and shared
    // across every stream tab. `'copy'` is the default sentinel — it
    // maps to "use the global ffmpeg.hwAccel" and clears the override.
    const hwAccelSettings = await this.getHwAccelOptions()
    const hwAccelOptions = hwAccelSettings.map((setting) => ({
      value: setting,
      label: hwAccelOptionLabel(setting),
    }))

    // ── One sub-tab per stream source with its broker settings ─────
    // Every published cam stream owns a broker for as long as the
    // source is published — there is no "Active" toggle. Pre-buffer
    // is OFF by default and opt-in per stream.
    // Derived streams are EXCLUDED here: they carry their own dedicated
    // "derived:<name>" tab (source + encode + pre-buffer + RTSP) below, so
    // rendering a physical-source tab for them too would duplicate the
    // controls. (They still show up in the profile-assignment selector and
    // the player stream picker, which enumerate the full cam-stream set.)
    // Asked ONCE, used twice: the per-stream sentry URL and the "Wake
    // signals" section must agree about whether this camera has the feature —
    // an URL offered beside a section that is not there would be a promise
    // nothing keeps.
    const declaredSignals = await this.declaredSignalList(deviceId)
    const sentryGate = sentryEligible({
      batteryOperated: await this.isBatteryOperated(deviceId),
      declaresSignals: declaredSignals.length > 0,
    })
    const sentryOffered = sentryGate.eligible

    const streamTabs: ConfigSubTabDefinitionWithValue[] = streams
      .filter((s) => !s.camStreamId.startsWith('derived:'))
      .map((stream) => {
        const camStreamId = stream.camStreamId
        const brokerId = brokerIdFor(deviceId, camStreamId)
        const profile = findProfileForStream(assignment.map, camStreamId)
        const rtspEnabled = this.rtspProvider.isEnabled(brokerId)
        const rtspEntry = this.rtspProvider.getEntry(brokerId)
        // The DISPLAYED prebuffer is the EFFECTIVE one — the same value this
        // manager installs on the broker (D381). It used to be
        // `perStream?.enabled ?? false`, which showed OFF on every stream
        // nobody had configured while the broker's own flag shipped `true` and
        // the warm default held the camera dialed. A switch that reports off on
        // a running function is worse than no switch (D62), and "not yet
        // configured" must never read as "not on" (D315).
        const effectivePrebuffer = this.effectivePrebuffer(deviceId, camStreamId)
        const preBufferEnabled = effectivePrebuffer.enabled
        const preBufferSec = effectivePrebuffer.enabled
          ? effectivePrebuffer.seconds
          : this.defaultPreBufferSec
        // Per-source-stream decode override, or `'copy'` when unset (the
        // "use the global default" sentinel the select binds to).
        const hwAccelValue: FfmpegHwAccelSetting = override?.hwaccel?.[camStreamId] ?? 'copy'

        // Per-source-stream "source parser" selector — offered only for the
        // URL-pull kinds that support alternative ingest engines (rtsp/rtmp).
        // For every other kind the option list is empty and the select is
        // omitted entirely. The default (first option) is the native engine.
        const sourceParserOptionSettings = sourceParserOptionsFor(sourceTypeForParser(stream.kind))
        const sourceParserField: ConfigFieldWithValue[] =
          sourceParserOptionSettings.length > 0
            ? [
                {
                  type: 'select' as const,
                  key: `sourceParser:${camStreamId}`,
                  label: 'Source parser',
                  description:
                    'How this source stream is ingested. "Native" uses the built-in TypeScript client; "FFmpeg" ingests through an ffmpeg re-mux reader. TCP is the safe default; UDP trades reliability for lower latency where the network allows it.',
                  options: sourceParserOptionSettings.map((setting) => ({
                    value: setting,
                    label: sourceParserOptionLabel(setting),
                  })),
                  span: 2 as const,
                  default: sourceParserOptionSettings[0],
                  value: override?.sourceParser?.[camStreamId] ?? sourceParserOptionSettings[0],
                },
              ]
            : []

        // Per-source-stream ffmpeg-parser normalization args — offered ONLY for
        // ffmpeg-capable streams: an rtsp/rtmp stream (whose parser options carry
        // an `ffmpeg-*` engine) OR a `pull-flv` stream (always ffmpeg-ingested).
        // The widget writes an EncodeProfile over a copy/passthrough base; only
        // its inputArgs/outputArgs are persisted (see applyDeviceSettingsPatch).
        const ffmpegCapable =
          sourceParserOptionSettings.some((s) => s.startsWith('ffmpeg')) ||
          stream.kind === 'pull-flv'
        const sourceParserArgsField: ConfigFieldWithValue[] = ffmpegCapable
          ? [
              {
                type: 'widget' as const,
                key: `sourceParserArgsWidget:${camStreamId}`,
                label: 'FFmpeg parser args',
                span: 2 as const,
                widgetId: 'stream-broker/ffmpeg-params',
                widgetConfig: {
                  argsOnly: true,
                  fieldKey: `sourceParserArgs:${camStreamId}`,
                  label: 'FFmpeg parser args',
                  initialValue: this.buildSourceParserArgsProfile(
                    override?.sourceParserArgs?.[camStreamId],
                  ),
                  writerCapName: 'stream-broker',
                  writerAddonId: 'stream-broker',
                },
              },
            ]
          : []

        // Probed video+audio summary. Refresh the persisted snapshot from the
        // live broker (so opening settings mid-stream shows current values even
        // before the periodic metrics tick), then render the last known probe.
        const liveStats = this.brokers.get(brokerId)?.getStats()
        if (liveStats) this.recordProbeSnapshot(brokerId, liveStats, Date.now())
        const probedValue = this.buildProbeSummary(brokerId).summary

        const fields: ConfigFieldWithValue[] = [
          {
            type: 'text' as const,
            key: `probedInfo:${camStreamId}`,
            label: 'Probed',
            description:
              'Detected video + audio properties (last value while streaming). "Probe now" briefly dials the stream to refresh.',
            readonlyField: true,
            span: 2 as const,
            value: probedValue,
            actions: [
              {
                action: 'refresh-probe',
                icon: 'refresh-cw',
                tooltip: 'Probe now — briefly dials the stream to capture fresh values',
              },
            ],
          },
          {
            type: 'boolean' as const,
            style: 'switch' as const,
            key: `rtspEnabled:${camStreamId}`,
            label: 'RTSP Restream',
            description: 'Expose this stream via the RTSP restream server',
            default: true,
            value: rtspEnabled,
          },
          {
            type: 'text' as const,
            key: `rtspUrl:${camStreamId}`,
            label: 'RTSP URL',
            readonlyField: true,
            span: 2 as const,
            value: rtspEntry?.url ?? 'inactive',
            actions: [
              {
                action: 'copy-value',
                icon: 'copy',
                tooltip: 'Copy URL to clipboard',
              },
              {
                action: 'regenerate-rtsp-token',
                icon: 'refresh-cw',
                tooltip: 'Regenerate RTSP token',
                variant: 'danger' as const,
                confirmMessage: `Rotate the RTSP token for ${stream.label ?? camStreamId}? Current URL will stop working immediately.`,
              },
            ],
          },
          {
            type: 'text' as const,
            key: `rtspMutedUrl:${camStreamId}`,
            label: 'RTSP URL (muted)',
            description: 'Video-only stream — no audio track',
            readonlyField: true,
            span: 2 as const,
            value: rtspEntry?.url ? `${rtspEntry.url}/muted` : 'inactive',
            actions: [
              {
                action: 'copy-value',
                icon: 'copy',
                tooltip: 'Copy muted URL to clipboard',
              },
            ],
          },
          // The SENTRY twin of this stream's URL — the thing an operator
          // actually pastes into plus catalog. Rendered only where the feature is
          // offered (a battery camera declaring `stream-signals`), because a
          // URL that cannot do what it says is worse than no URL: it would be
          // copied once and debugged for an hour.
          ...(sentryOffered
            ? [
                {
                  type: 'text' as const,
                  key: `rtspPrestreamUrl:${camStreamId}`,
                  label: 'RTSP URL (sentry)',
                  description:
                    'Video-only. Shows this camera’s last picture while it sleeps and cuts to live video when one of its wake signals fires — without a consumer on this URL ever keeping the camera awake.',
                  readonlyField: true,
                  span: 2 as const,
                  value: rtspEntry?.url ? `${rtspEntry.url}/sentry` : 'inactive',
                  actions: [
                    {
                      action: 'copy-value',
                      icon: 'copy',
                      tooltip: 'Copy sentry URL to clipboard',
                    },
                  ],
                },
              ]
            : []),
          {
            type: 'boolean' as const,
            style: 'switch' as const,
            key: `preBufferEnabled:${camStreamId}`,
            label: 'Pre-buffer',
            description:
              "Hold this stream dialed and keep the last few seconds of it, so anything that attaches after an event — a recording, a detection decode — starts BEFORE the event instead of at the live edge. This is the only history setting in the system: recordings and detection ask for what is kept here and never configure a window of their own. Costs a permanent connection to the camera and memory on the ingest node. On by default for a mains camera's main profile; off for a battery camera, which has nothing to hold between wakes.",
            default: preBufferEnabled,
            value: preBufferEnabled,
          },
          {
            type: 'slider' as const,
            key: `preBufferSec:${camStreamId}`,
            label: 'Pre-buffer Duration',
            description:
              'Seconds of history kept while the pre-buffer is on. A consumer is served this much or less — never more, and never more than the stream has actually been warm for.',
            min: 0,
            max: PREBUFFER_MAX_SEC,
            step: 1,
            unit: 's',
            default: this.defaultPreBufferSec,
            showValue: true,
            value: preBufferSec,
          },
          {
            type: 'number' as const,
            key: `joinBurstMaxSpanMs:${camStreamId}`,
            label: 'Join-burst bound',
            description:
              'How much recent video a client joining the RTSP restream may be handed at once. Over this, the burst is withheld whole (a partial GOP cannot be decoded) and the client starts at the next keyframe instead. Raise it only for a camera whose keyframe interval is longer than the cluster default — above ~2.5 s the burst becomes jitter for any consumer that re-clocks it. 0 = inherit the cluster default.',
            min: 0,
            max: JOIN_BURST_MAX_SPAN_LIMIT_MS,
            step: 250,
            unit: 'ms',
            span: 2 as const,
            default: 0,
            value: override?.joinBurstMaxSpanMs?.[camStreamId] ?? 0,
          },
          {
            type: 'select' as const,
            key: `hwaccel:${camStreamId}`,
            label: 'Decode acceleration',
            description:
              'Hardware decode backend for the transcode paths (H.265→H.264 egress + WebRTC feed). Passthrough and detection are unaffected. "Software (copy)" decodes on CPU — the safe choice for a stream whose hardware decoder hard-fails.',
            options: hwAccelOptions,
            span: 2 as const,
            default: 'copy',
            value: hwAccelValue,
          },
          ...sourceParserField,
          ...sourceParserArgsField,
        ]

        const tabBadge = profile ? PROFILES.find((p) => p.key === profile)?.label : undefined
        const tabLabel = stream.label ?? camStreamId
        const def: ConfigSubTabDefinitionWithValue = {
          id: `stream:${camStreamId}`,
          label: tabLabel,
          fields,
          ...(tabBadge ? { badge: tabBadge } : {}),
        }
        return def
      })

    // Physical (non-derived) camStreams a derived stream may pin to. A
    // `derived:*` stream is EXCLUDED as a source so a derived stream can never
    // read from another derived one (the cycle guard backstops this, but the
    // selector never even offers it).
    const physicalStreams = streams.filter((s) => !s.camStreamId.startsWith('derived:'))

    // Is a physical camStream's broker actively pulling right now? A stream
    // that is only `idle`/`stopped`/absent means selecting it as a pinned
    // source forces the feeder to open its OWN camera connection.
    const isCamStreamPulled = (camStreamId: string): boolean => {
      const status = this.brokers.get(brokerIdFor(deviceId, camStreamId))?.getStats().status
      return status === 'streaming' || status === 'connecting'
    }

    // Grouped source options. The renderer draws a flat `<select>` (no native
    // optgroup support in `ConfigSelectField`), so the two groups are conveyed
    // with label prefixes: the three profile slots ("Profile · High") whose
    // source follows quality assignment, then each physical camStream
    // ("native:mid — currently Mid") which pins the source to that stream.
    const derivedSourceOptions: ConfigOption[] = [
      { value: '', label: 'Not configured' },
      ...PROFILES.map(({ key, label }) => ({
        value: encodeDerivedSourceValue({ kind: 'profile', profile: key }),
        label: `Profile · ${label}`,
      })),
      ...physicalStreams.map((s) => {
        const assignedProfile = findProfileForStream(assignment.map, s.camStreamId)
        const assignedLabel = assignedProfile
          ? PROFILES.find((p) => p.key === assignedProfile)?.label
          : undefined
        const suffix = assignedLabel
          ? ` — currently ${assignedLabel}`
          : s.label && s.label !== s.camStreamId
            ? ` — ${s.label}`
            : ''
        return {
          value: encodeDerivedSourceValue({
            kind: 'camStream',
            camStreamId: s.camStreamId,
          }),
          label: `${s.camStreamId}${suffix}`,
        }
      }),
    ]

    // Encoded values of the physical streams NOT currently pulled — selecting
    // one triggers the "independent camera connection" warning banner below.
    const notPulledStreamValues = physicalStreams
      .filter((s) => !isCamStreamPulled(s.camStreamId))
      .map((s) =>
        encodeDerivedSourceValue({
          kind: 'camStream',
          camStreamId: s.camStreamId,
        }),
      )

    const derivedTabs: ConfigSubTabDefinitionWithValue[] = Object.entries(
      override?.derivedStreams ?? {},
    ).map(([name, def]) => ({
      id: `derived:${name}`,
      label: name,
      fields: [
        {
          type: 'select' as const,
          key: `derivedSource:${name}`,
          label: 'Source',
          description:
            'What feeds this derived stream. A profile slot follows quality assignment (shares the existing pull); a physical stream pins the source to that camStream.',
          options: derivedSourceOptions,
          span: 2 as const,
          value: encodeDerivedSourceValue(def.source),
        },
        // Best-effort warning: a pinned physical stream that isn't currently
        // pulled means the feeder opens its own camera connection. Only added
        // when at least one such stream exists; the `in` condition makes the
        // banner appear reactively as the operator picks that option.
        ...(notPulledStreamValues.length > 0
          ? [
              {
                type: 'info' as const,
                key: `derivedSourceWarning:${name}`,
                label: 'Independent camera connection',
                variant: 'warning' as const,
                content:
                  'The selected physical stream is not currently being pulled. This derived stream will open its own connection to the camera for it — a second connection if another consumer later pulls the same stream via a profile. Choose a profile source to share the existing pull instead.',
                showWhen: {
                  field: `derivedSource:${name}`,
                  in: notPulledStreamValues,
                },
              },
            ]
          : []),
        {
          type: 'widget' as const,
          key: `derivedEncodeWidget:${name}`,
          label: 'Encode parameters',
          span: 2 as const,
          widgetId: 'stream-broker/ffmpeg-params',
          widgetConfig: {
            fieldKey: `derivedProfile:${name}`,
            label: 'Encode parameters',
            // The derived stream's "source" is its upstream camStream —
            // surface that camStream's probed shape so the operator sees
            // what the transcode pipeline is consuming.
            sourceParams: this.getCameraStreamProbedParams(
              deviceId,
              derivedSourceCamStreamId(def.source) ?? '',
            ),
            initialValue: def.encodeProfile,
            writerCapName: 'stream-broker',
            writerAddonId: 'stream-broker',
          },
        },
        // Toggle pair: Pre-buffer + RTSP restream render side by side
        // (span 1 each). Order matters — adjacent span-1 fields share a
        // row in the two-column form grid.
        {
          type: 'boolean' as const,
          key: `derivedPrebufferEnabled:${name}`,
          label: 'Pre-buffer',
          style: 'switch' as const,
          span: 1 as const,
          default: false,
          value: def.preBuffer?.enabled ?? false,
        },
        {
          type: 'boolean' as const,
          key: `derivedRtspEnabled:${name}`,
          label: 'RTSP restream',
          style: 'switch' as const,
          span: 1 as const,
          default: false,
          value: def.rtspEnabled ?? false,
        },
        // Full-width duration slider, shown only when Pre-buffer is on —
        // no orphan slider when the feature is disabled.
        {
          type: 'slider' as const,
          key: `derivedPrebufferSec:${name}`,
          label: 'Pre-buffer Duration',
          min: 0,
          max: 30,
          step: 1,
          unit: 's',
          showValue: true,
          span: 2 as const,
          showWhen: { field: `derivedPrebufferEnabled:${name}`, equals: true },
          default: this.defaultPreBufferSec,
          value: def.preBuffer?.seconds ?? this.defaultPreBufferSec,
        },
      ],
    }))

    const streamBrokerSection: ConfigSectionWithValues = {
      id: 'stream-broker-streams',
      title: '',
      tab: 'stream-broker',
      // Hoist out of the Config tab into a dedicated device-detail
      // top-level "Stream Broker" tab — DeviceDetail discovers the tab
      // from `location: 'top-tab'` sections, the way recording/zones/ptz
      // do. Without this the section nests as a Config inner-tab.
      location: 'top-tab',
      order: 10,
      fields: [
        {
          type: 'sub-tabs' as const,
          key: 'streamBroker:streams',
          label: '',
          span: 2 as const,
          tabs: [generalTab, ...streamTabs, ...derivedTabs],
        },
      ],
    }

    // ── "Wake signals" — the on-demand sentry ──────────────────────
    //
    // Rendered only for a camera the feature is actually OFFERED to: a battery
    // camera that declares `stream-signals`. Showing the section on a mains
    // camera would be a form that writes a store nothing reads, which this
    // repo has shipped twice (D62). The signals listed are the ones the CAMERA
    // declares — never a fixed list — so an operator cannot enable a wake the
    // camera has no way to give.
    const sentryCfg = override?.sentry
    const sentrySections: ConfigSectionWithValues[] = sentryGate.eligible
      ? [
          {
            id: 'stream-broker-sentry',
            title: 'Wake signals',
            tab: 'stream-broker',
            location: 'top-tab',
            order: 50,
            description:
              'A consumer can dial this camera’s sentry URL (the profile URL with /sentry) and be shown the last picture while the camera sleeps. It is fed without keeping the camera awake: only the signals below wake it, and it goes back to sleep once they stop.',
            fields: [
              ...declaredSignals.map((signal) => ({
                type: 'boolean' as const,
                style: 'switch' as const,
                key: `sentrySignal:${signal.code}`,
                label: signal.label,
                description: signal.recommended
                  ? 'Recommended by this camera’s driver.'
                  : 'Offered by this camera’s driver.',
                default: signal.recommended,
                // Absent means "every signal the camera declares", which is why
                // an untouched camera works without visiting this form. Once
                // the operator has written the list, the list is the answer.
                value:
                  sentryCfg?.enabledSignals === undefined
                    ? true
                    : sentryCfg.enabledSignals.includes(signal.code),
              })),
              {
                type: 'number' as const,
                key: 'sentryHoldMs',
                label: 'Stay awake after the last signal',
                description:
                  'How long the camera keeps streaming once its signals stop. Extended by each new signal, never stacked — continuous motion keeps it up and it sleeps this long after the last one. One run is capped at five minutes whatever this says, and a camera whose sensor never stops is left alone for ten minutes after that.',
                min: 1_000,
                max: 300_000,
                step: 1_000,
                unit: 'ms',
                default: DEFAULT_WAKE_HOLD_MS,
                value: sentryCfg?.holdMs ?? DEFAULT_WAKE_HOLD_MS,
              },
            ],
          },
        ]
      : []

    const diagnosticsSection: ConfigSectionWithValues = {
      id: 'stream-broker-diagnostics',
      title: 'Diagnostics',
      tab: 'stream-broker',
      // Same top-tab as the streams section (sections sharing a tab id
      // stack in `order` sequence inside that one tab body).
      location: 'top-tab',
      order: 100,
      fields: [
        {
          type: 'boolean' as const,
          style: 'switch' as const,
          key: 'streamingDebug',
          label: 'Streaming debug logs',
          description:
            'Enable verbose info-level logs for the broker, WebRTC server, and H.265 repacketizer for this device. Off by default; turn on while diagnosing playback issues.',
          default: false,
          value: override?.streamingDebug === true,
        },
        {
          type: 'boolean' as const,
          style: 'switch' as const,
          key: 'webrtcDebug',
          label: 'Advanced WebRTC debug logging',
          description:
            'Log EVERY step of the WebRTC pipeline for this device: the local ICE candidates we put in the answer (with type host/srflx/relay + address), the remote offer candidates, DTLS state transitions, ICE nomination, codec negotiation (offered vs negotiated), and first video/audio RTP. Use to diagnose hard cases (Alexa streaming, A/V sync). Off by default — turn on only while debugging.',
          default: false,
          value: override?.webrtcDebug === true,
        },
      ],
    }

    return {
      sections: [streamBrokerSection, ...sentrySections, diagnosticsSection],
    }
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
    const deviceId = input.deviceId
    if (!this.cameraStreams.has(deviceId)) {
      this.logger.debug('applyDeviceSettingsPatch: unknown deviceId — no-op', {
        tags: { deviceId },
      })
      return { success: true as const }
    }

    let overrideDirty = false
    // Whether this patch touched any derived-stream field. Gates the
    // post-loop derived materialization reconcile so an unrelated patch
    // (pre-buffer toggle, hwaccel, …) never churns a live derived broker.
    let derivedDirty = false
    const nextOverride: DeviceOverride = {
      ...this.deviceOverrides.get(deviceId),
    }
    // Snapshot the derived defs BEFORE this patch mutates them, so the
    // reconcile can tell a source CHANGE (rebind the feeder) from an
    // unchanged / encode-only edit (leave the running broker alone).
    const priorDerivedDefs = new Map<string, DerivedStreamEntry>(
      Object.entries(this.deviceOverrides.get(deviceId)?.derivedStreams ?? {}),
    )

    for (const [fieldKey, value] of Object.entries(input.patch)) {
      // Profile → camStreamId selectors live in the Assignment sub-tab
      // (`streamProfile:<profile>`).
      if (fieldKey.startsWith('streamProfile:')) {
        const profile = fieldKey.slice('streamProfile:'.length) as CamProfile
        if (!CAM_PROFILE_ORDER.includes(profile)) continue
        const newCamId = typeof value === 'string' && value !== '' ? value : null
        if (newCamId === null) {
          await this.unassignProfile({ deviceId, profile })
        } else {
          await this.assignProfile({
            deviceId,
            profile,
            camStreamId: newCamId,
          })
        }
        continue
      }
      if (fieldKey.startsWith('rtspEnabled:')) {
        const camStreamId = fieldKey.slice('rtspEnabled:'.length)
        const brokerId = brokerIdFor(deviceId, camStreamId)
        this.rtspProvider.setEnabled(brokerId, Boolean(value))
        continue
      }
      // The prebuffer switch and its seconds are ONE configuration, so both
      // keys write the same entry and then re-resolve it through the same
      // function the settings screen displays and the broker installs (D381).
      // Each used to compute its own half of the answer — the switch pushed
      // `setPreBufferDuration` + `setPreBufferEnabled`, the seconds pushed only
      // the duration, and `defaultStreamPreBuffer` synthesised a third value to
      // fill in whichever half the operator had not touched.
      if (fieldKey.startsWith('preBufferEnabled:') || fieldKey.startsWith('preBufferSec:')) {
        const isSwitch = fieldKey.startsWith('preBufferEnabled:')
        const camStreamId = fieldKey.slice(
          (isSwitch ? 'preBufferEnabled:' : 'preBufferSec:').length,
        )
        overrideDirty = true
        const pb = { ...nextOverride.preBuffer }
        // The value the operator is looking at when they move ONE of the two
        // controls — never a fresh default, which is how a seconds-only edit
        // could silently turn a warm stream off.
        const current = pb[camStreamId] ?? this.effectivePrebuffer(deviceId, camStreamId)
        pb[camStreamId] = isSwitch
          ? {
              enabled: Boolean(value),
              // Turning the switch ON adopts a real duration. `current.seconds`
              // is 0 for every stream whose effective prebuffer is OFF, and
              // persisting `{ enabled: true, seconds: 0 }` would be a switch
              // that reports on and retains nothing — the shape of knob this
              // record exists to remove.
              seconds: current.seconds > 0 ? current.seconds : this.defaultPreBufferSec,
            }
          : {
              ...current,
              seconds:
                typeof value === 'number' && Number.isFinite(value)
                  ? value
                  : this.defaultPreBufferSec,
            }
        nextOverride.preBuffer = pb
        const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
        if (broker) {
          broker.setPrebuffer(
            resolvePrebuffer({
              camStreamId,
              clusterSeconds: this.defaultPreBufferSec,
              overrides: pb,
              defaultWarm: this.isDefaultWarm(deviceId, camStreamId),
              batteryOperated: this.deviceHasFeature(deviceId, DeviceFeature.BatteryOperated),
              terminalRelay:
                this.cameraStreams.get(deviceId)?.get(camStreamId)?.kind === 'pull-http',
            }),
          )
        }
        continue
      }
      if (fieldKey.startsWith('joinBurstMaxSpanMs:')) {
        const camStreamId = fieldKey.slice('joinBurstMaxSpanMs:'.length)
        overrideDirty = true
        const jb = { ...nextOverride.joinBurstMaxSpanMs }
        // 0 / cleared / nonsense = "inherit the cluster default", so the
        // override is DELETED rather than persisted as a falsy number that
        // `resolveJoinBurstBound` would then have to keep re-rejecting.
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          jb[camStreamId] = Math.min(
            JOIN_BURST_MAX_SPAN_LIMIT_MS,
            Math.max(JOIN_BURST_MIN_SPAN_MS, value),
          )
        } else {
          delete jb[camStreamId]
        }
        nextOverride.joinBurstMaxSpanMs = jb
        // Live push: the broker is reused for the life of the stream, so a
        // bound left un-pushed would apply only after the next re-publish.
        const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
        if (broker) {
          broker.setJoinBurstBound(
            resolveJoinBurstBound({
              camStreamId,
              clusterMaxSpanMs: this.defaultJoinBurstMaxSpanMs,
              overrides: jb,
            }),
          )
        }
        continue
      }
      if (fieldKey.startsWith('hwaccel:')) {
        const camStreamId = fieldKey.slice('hwaccel:'.length)
        overrideDirty = true
        const hw = { ...nextOverride.hwaccel }
        // `'copy'` is the default sentinel (== "use the global ffmpeg.hwAccel")
        // and `''` is the empty/unset selection — both clear the per-stream
        // override so precedence falls back to the global config. Any other
        // value must be a known setting (validated against the enum); an
        // unknown value is ignored, never persisted.
        if (value === 'copy' || value === '' || value === null || value === undefined) {
          delete hw[camStreamId]
        } else if (typeof value === 'string' && isFfmpegHwAccelSetting(value)) {
          hw[camStreamId] = value
        }
        nextOverride.hwaccel = hw
        // No live broker push: each transcode pipeline re-reads the effective
        // hwaccel at spawn time (getStreamHwAccelOverride), and addon.ts
        // force-rotates active decoders on the per-agent hwaccel-changed event.
        continue
      }
      if (fieldKey.startsWith('sourceParser:')) {
        const camStreamId = fieldKey.slice('sourceParser:'.length)
        overrideDirty = true
        const sp = { ...nextOverride.sourceParser }
        // The default (first offered) parser is the sentinel that clears the
        // per-stream override — no point persisting the native default. `''`
        // and null clear it too. Any other value must be BOTH a known setting
        // AND valid for this stream's source type; anything else is ignored.
        const cam = this.cameraStreams.get(deviceId)?.get(camStreamId)
        const options = cam ? sourceParserOptionsFor(sourceTypeForParser(cam.kind)) : []
        const defaultSetting = options[0]
        if (value === '' || value === null || value === undefined || value === defaultSetting) {
          delete sp[camStreamId]
        } else if (
          typeof value === 'string' &&
          isSourceParserSetting(value) &&
          options.includes(value)
        ) {
          sp[camStreamId] = value
        }
        nextOverride.sourceParser = sp
        // No live broker push: each broker re-derives its source (and thus the
        // resolved parser) on every dial via the sourceProvider closure.
        continue
      }
      if (fieldKey.startsWith('sourceParserArgs:')) {
        const camStreamId = fieldKey.slice('sourceParserArgs:'.length)
        overrideDirty = true
        const spa = { ...nextOverride.sourceParserArgs }
        // The widget writes a full EncodeProfile (copy/passthrough base +
        // inputArgs/outputArgs) or null when cleared. We persist ONLY the args
        // — the transcode fields are inert in the ffmpeg-parser (remux) path.
        const profile =
          value === null || value === undefined ? undefined : EncodeProfileSchema.parse(value)
        const inputArgs = (profile?.inputArgs ?? []).filter((a) => a.length > 0)
        const outputArgs = (profile?.outputArgs ?? []).filter((a) => a.length > 0)
        if (inputArgs.length === 0 && outputArgs.length === 0) {
          delete spa[camStreamId]
        } else {
          spa[camStreamId] = {
            ...(inputArgs.length > 0 ? { inputArgs } : {}),
            ...(outputArgs.length > 0 ? { outputArgs } : {}),
          }
        }
        nextOverride.sourceParserArgs = spa
        // No live broker push: the sourceProvider closure re-derives the
        // ffmpegParser (transport + args) on every dial.
        continue
      }
      // ── The wake signals, and the hold ──────────────────────────────
      //
      // A per-signal switch writes the LIST, never a per-signal flag: the list
      // is what `reportStreamSignal` reads, and two representations of one
      // choice is the defect this session removed three times. Absent means
      // "every declared signal"; the first write materialises the full list so
      // the stored answer is complete rather than a diff against a default
      // that could later change.
      if (fieldKey.startsWith('sentrySignal:')) {
        overrideDirty = true
        const next = nextEnabledSignals({
          declared: await this.declaredSignalCodes(deviceId),
          stored: nextOverride.sentry?.enabledSignals,
          code: fieldKey.slice('sentrySignal:'.length),
          enabled: value === null || value === undefined ? true : Boolean(value),
        })
        nextOverride.sentry = {
          ...nextOverride.sentry,
          enabledSignals: [...next],
        }
        continue
      }
      if (fieldKey === 'sentryHoldMs') {
        overrideDirty = true
        const raw = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(raw)) {
          // An unreadable number is left alone rather than written as a
          // default: a hold silently reset to 15 s is a camera that sleeps
          // sooner than the operator asked, with nothing saying why.
          continue
        }
        const clamped = Math.min(300_000, Math.max(1_000, Math.round(raw)))
        nextOverride.sentry = { ...nextOverride.sentry, holdMs: clamped }
        continue
      }
      if (fieldKey === 'streamingDebug') {
        overrideDirty = true
        const next = value === null || value === undefined ? undefined : Boolean(value)
        if (next === undefined) {
          delete nextOverride.streamingDebug
        } else {
          nextOverride.streamingDebug = next
        }
        // Push to every active broker for this device immediately so
        // the toggle takes effect without restarting the stream.
        for (const [bid, broker] of this.brokers) {
          if (bid.startsWith(`${deviceId}/`)) {
            broker.setStreamingDebug(next === true)
          }
        }
        continue
      }
      if (fieldKey === 'webrtcDebug') {
        overrideDirty = true
        const next = value === null || value === undefined ? undefined : Boolean(value)
        if (next === undefined) {
          delete nextOverride.webrtcDebug
        } else {
          nextOverride.webrtcDebug = next
        }
        // No live broker push needed: each new WebRTC session reads
        // `isWebrtcDebug(deviceId)` at creation (see
        // `device-scoped-providers.ts`), so the next session for this
        // device picks the flag up. Existing sessions keep their flag.
        continue
      }

      if (fieldKey === 'derivedStreamNames' && Array.isArray(value)) {
        overrideDirty = true
        derivedDirty = true
        const names = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
        const next = { ...nextOverride.derivedStreams }
        // Add missing entries with empty profile placeholders
        for (const n of names) {
          if (!next[n]) {
            next[n] = {
              encodeProfile: {
                video: { codec: 'h264' as const },
                audio: 'passthrough' as const,
              },
            }
          }
        }
        // Remove names no longer in the list
        for (const existing of Object.keys(next)) {
          if (!names.includes(existing)) delete next[existing]
        }
        nextOverride.derivedStreams = next
        // Broker materialization (add) + teardown (remove) is handled by the
        // post-loop `reconcileDerivedStreams` step, which sees the final
        // persisted def set and diffs it against `priorDerivedDefs`.
        continue
      }

      if (fieldKey.startsWith('derivedSource:')) {
        const name = fieldKey.slice('derivedSource:'.length)
        overrideDirty = true
        derivedDirty = true
        const next = { ...nextOverride.derivedStreams }
        if (!next[name]) {
          next[name] = {
            encodeProfile: {
              video: { codec: 'h264' as const },
              audio: 'passthrough' as const,
            },
          }
        }
        // The grouped source selector emits an ENCODED DerivedSourceRef
        // (`profile:<name>` | `stream:<camStreamId>`); decode it back to the
        // union. Empty / unknown clears the source to an unconfigured
        // placeholder. A bare camStreamId (legacy widget) is still accepted:
        // decode returns undefined for it, so fall back to a camStream ref.
        const raw = typeof value === 'string' ? value : ''
        const decoded =
          decodeDerivedSourceValue(raw) ??
          (raw && !raw.startsWith('profile:') && !raw.startsWith('stream:')
            ? { kind: 'camStream' as const, camStreamId: raw }
            : undefined)
        next[name] = {
          ...next[name],
          source: decoded,
        }
        nextOverride.derivedStreams = next
        continue
      }

      if (fieldKey.startsWith('derivedProfile:')) {
        const name = fieldKey.slice('derivedProfile:'.length)
        overrideDirty = true
        derivedDirty = true
        const next = { ...nextOverride.derivedStreams }
        if (!next[name]) {
          next[name] = {
            encodeProfile: {
              video: { codec: 'h264' as const },
              audio: 'passthrough' as const,
            },
          }
        }
        next[name] = {
          ...next[name],
          encodeProfile: EncodeProfileSchema.parse(value),
        }
        nextOverride.derivedStreams = next
        continue
      }

      if (fieldKey.startsWith('derivedPrebufferEnabled:')) {
        const name = fieldKey.slice('derivedPrebufferEnabled:'.length)
        overrideDirty = true
        derivedDirty = true
        const next = { ...nextOverride.derivedStreams }
        if (next[name]) {
          next[name] = {
            ...next[name],
            preBuffer: {
              ...(next[name].preBuffer ?? {
                enabled: false,
                seconds: this.defaultPreBufferSec,
              }),
              enabled: Boolean(value),
            },
          }
          nextOverride.derivedStreams = next
        }
        continue
      }

      if (fieldKey.startsWith('derivedPrebufferSec:')) {
        const name = fieldKey.slice('derivedPrebufferSec:'.length)
        overrideDirty = true
        derivedDirty = true
        const next = { ...nextOverride.derivedStreams }
        if (next[name] && typeof value === 'number') {
          next[name] = {
            ...next[name],
            preBuffer: {
              ...(next[name].preBuffer ?? { enabled: false, seconds: 0 }),
              seconds: value,
            },
          }
          nextOverride.derivedStreams = next
        }
        continue
      }

      if (fieldKey.startsWith('derivedRtspEnabled:')) {
        const name = fieldKey.slice('derivedRtspEnabled:'.length)
        overrideDirty = true
        derivedDirty = true
        const next = { ...nextOverride.derivedStreams }
        if (next[name]) {
          next[name] = { ...next[name], rtspEnabled: Boolean(value) }
          nextOverride.derivedStreams = next
        }
        continue
      }
    }

    if (overrideDirty) {
      if (!overrideHasContent(nextOverride)) {
        this.deviceOverrides.delete(deviceId)
      } else {
        this.deviceOverrides.set(deviceId, nextOverride)
      }
      this.deviceOverridePersister?.(this.deviceOverrides)
    }

    // Reconcile the LIVE derived brokers against the just-persisted defs.
    // Runs AFTER persistence so it reads the final `deviceOverrides` state.
    // This is what makes a derived stream materialize the moment its source
    // is set (so it shows up in the profile-assignment picker + the player
    // stream selector) — the per-field handlers only persist config.
    if (derivedDirty) {
      await this.reconcileDerivedStreams(deviceId, priorDerivedDefs)
    }
    return { success: true as const }
  }

  /**
   * Materialize / rebind / tear down the live `derived:*` brokers of a device
   * so they match the persisted `derivedStreams` overrides. Idempotent:
   *
   *   - a derived WITH a source that isn't live yet → publish (materialize);
   *   - a materialized derived whose SOURCE changed → retract + republish so
   *     its feeder rebinds to the new source;
   *   - a materialized derived whose source is unchanged → left running (an
   *     encode-only edit must NOT tear down a live stream on every keystroke —
   *     the new encode params apply on the next feeder respawn, matching the
   *     `publishCameraStream` single-flight contract);
   *   - a derived removed from the list (present in `prior`, absent now) →
   *     retract.
   *
   * A PROFILE source resolves its physical stream dynamically (no
   * precondition); a pinned CAMSTREAM source needs its broker up first — when
   * absent the def is queued in `pendingDerivedStreams` so a later source
   * publish drains it.
   */
  private async reconcileDerivedStreams(
    deviceId: number,
    prior: ReadonlyMap<string, DerivedStreamEntry>,
  ): Promise<void> {
    const current = this.deviceOverrides.get(deviceId)?.derivedStreams ?? {}

    // Tear down deriveds that were removed from the list.
    for (const name of prior.keys()) {
      if (!(name in current)) {
        await this.retractCameraStream({
          deviceId,
          camStreamId: `derived:${name}`,
        }).catch(() => {})
      }
    }

    for (const [name, def] of Object.entries(current)) {
      const camStreamId = `derived:${name}`
      const materialized = this.cameraStreams.get(deviceId)?.has(camStreamId) ?? false

      // Unconfigured placeholder (no source) — ensure no stale broker lingers.
      if (!def.source) {
        if (materialized) {
          await this.retractCameraStream({ deviceId, camStreamId }).catch(() => {})
        }
        continue
      }

      const priorSource = prior.get(name)?.source
      const sourceChanged =
        priorSource === undefined ||
        encodeDerivedSourceValue(priorSource) !== encodeDerivedSourceValue(def.source)

      // Already live on the same source — leave it running (encode edits take
      // effect on the next feeder respawn per the single-flight contract).
      if (materialized && !sourceChanged) continue

      // Source changed on a live derived — retract so the republish below
      // rebinds the feeder to the new source. `retractCameraStream` deletes the
      // stream from the profile map, so capture the slot FIRST and restore it
      // after the republish — otherwise a source edit silently empties the
      // derived's assigned slot (operator sees a "profile reset").
      let restoreProfile: CamProfile | undefined
      if (materialized && sourceChanged) {
        restoreProfile =
          findProfileForStream(this.assignments.get(deviceId)?.map ?? {}, camStreamId) ?? undefined
        await this.retractCameraStream({ deviceId, camStreamId }).catch(() => {})
      }

      // A pinned camStream source must have its broker up first; a profile
      // source resolves dynamically. Defer to the pending queue otherwise.
      const pinned = derivedSourceCamStreamId(def.source)
      if (pinned && !this.brokers.has(brokerIdFor(deviceId, pinned))) {
        const sourceBrokerId = brokerIdFor(deviceId, pinned)
        const list = this.pendingDerivedStreams.get(sourceBrokerId) ?? []
        if (!list.some((p) => p.name === name)) list.push({ deviceId, name, def, restoreProfile })
        this.pendingDerivedStreams.set(sourceBrokerId, list)
        continue
      }

      await this.publishCameraStream({
        deviceId,
        camStreamId,
        kind: 'derived',
        source: def.source,
        encodeProfile: def.encodeProfile,
      }).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('SOURCE_NOT_FOUND')) return
        this.logger.warn('reconcileDerivedStreams: materialize failed', {
          tags: { deviceId },
          meta: {
            name,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      })
      if (restoreProfile) {
        await this.assignProfile({
          deviceId,
          profile: restoreProfile,
          camStreamId,
        }).catch(() => {})
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private nextOrder(deviceId: number): number {
    const next = (this.streamOrderSeq.get(deviceId) ?? 0) + 1
    this.streamOrderSeq.set(deviceId, next)
    return next
  }

  private toCameraStream(s: CameraStreamInternal): CameraStream {
    const { order: _order, deviceFeatures: _df, ...rest } = s
    return rest
  }

  private deviceHasFeature(deviceId: number, feature: string): boolean {
    const streamMap = this.cameraStreams.get(deviceId)
    if (!streamMap) return false
    for (const s of streamMap.values()) {
      if (s.deviceFeatures.includes(feature)) return true
    }
    return false
  }

  private labelForDropdown(s: CameraStreamInternal): string {
    // Derived streams carry a synthetic `derived:<name>` id — surface a
    // human "Derived · <name>" label instead of the raw prefixed id so the
    // operator can tell a transcoded derived from a physical source stream in
    // the profile-assignment picker.
    const base =
      s.label ??
      (s.kind === 'derived' && s.camStreamId.startsWith('derived:')
        ? `Derived · ${s.camStreamId.slice('derived:'.length)}`
        : s.camStreamId)
    if (s.resolution) return `${base} (${s.resolution.width}×${s.resolution.height})`
    return base
  }

  /**
   * Compute the canonical profile map for a given ordered stream list.
   *
   *   1 stream  → { mid }
   *   2 streams → { high, low }  (higher resolution → high)
   *   3+ streams → { high, mid, low }
   *
   * Ties on resolution fall back to publish order (stream.order asc).
   * Streams with no resolution sort below those with one — publish
   * order breaks ties within each rank.
   *
   * Streams marked `autoEligible: false` are skipped — they remain
   * published (visible + manually assignable via `assignProfile`) but
   * never become the default. If every stream is non-eligible the map
   * stays empty: ranking ineligible streams (a derived that beat the
   * catalog to boot) parked a transcode on `high` and left the natives
   * around it (618, 2026-08-17).
   */
  private computeInitialAssignment(
    streams: readonly CameraStreamInternal[],
  ): Partial<Record<CamProfile, string>> {
    // The rule lives in `initial-assignment.ts` (pure, tested): a publisher's
    // `profileHint` takes its slot first, the rest are ranked by pixels.
    return rankInitialAssignment(streams)
  }

  /**
   * Recompute the auto profile assignment for a device over its CURRENT
   * complete cam-stream set and apply it once. Extracted from
   * `publishCameraStream` so a multi-stream catalog publish can upsert
   * every stream first and rank ONCE (no transient intermediate
   * assignment). When the device's assignment is operator-locked
   * (`auto === false`) occupied slots stay put (a derived on `low` must
   * not be kicked off). Empty slots refill from unused natives when the
   * device has a derived stream (108 / 1438) or the whole map is empty —
   * a camera without deriveds still honours an operator unassign.
   */
  private async reconcileAutoAssignment(
    deviceId: number,
    reason: 'publish' | 'retract',
    streamAdded = false,
  ): Promise<void> {
    const current = this.assignments.get(deviceId)
    const streams = [...(this.cameraStreams.get(deviceId)?.values() ?? [])].toSorted(
      (a, b) => a.order - b.order,
    )
    const isAuto = current?.auto ?? true
    const ranked = this.computeInitialAssignment(streams)
    const hasDerived = streams.some((s) => s.kind === 'derived')
    const lockedEmpty =
      current !== undefined &&
      !isAuto &&
      CAM_PROFILE_ORDER.every((profile) => current.map[profile] === undefined)
    const newMap: Partial<Record<CamProfile, string>> = !current
      ? ranked
      : isAuto
        ? this.wouldChangeAutoMap(current.map, streams)
          ? ranked
          : current.map
        : hasDerived || lockedEmpty
          ? fillEmptyProfileSlots(current.map, ranked)
          : current.map
    await this.applyAssignmentUpdate(deviceId, newMap, {
      auto: isAuto,
      reason,
      streamAdded,
    })
  }

  private wouldChangeAutoMap(
    current: Partial<Record<CamProfile, string>>,
    streams: readonly CameraStreamInternal[],
  ): boolean {
    const computed = this.computeInitialAssignment(streams)
    for (const p of CAM_PROFILE_ORDER) {
      if (current[p] !== computed[p]) return true
    }
    return false
  }

  /**
   * Core transition: diff `current.map` vs `newMap`, then translate the
   * profile-level diff to demand/idle events for push-kind streams.
   * Brokers are NOT touched here — every published cam stream owns
   * its broker for as long as the source exists, regardless of which
   * profile slot points at it. Profile reassignments are pure
   * metadata changes from the broker's point of view.
   */
  private async applyAssignmentUpdate(
    deviceId: number,
    newMap: Partial<Record<CamProfile, string>>,
    opts: {
      auto: boolean
      reason: 'publish' | 'retract' | 'assign' | 'unassign'
      streamAdded?: boolean
    },
  ): Promise<void> {
    const current = this.assignments.get(deviceId) ?? { map: {}, auto: true }
    const nextAssignment: DeviceAssignment = { map: newMap, auto: opts.auto }

    // Pre-change demand view: which push cam streams have active consumers?
    const oldPushConsumers = this.countPushConsumers(current.map, deviceId)
    const newPushConsumers = this.countPushConsumers(newMap, deviceId)

    let anyChange = false
    for (const profile of CAM_PROFILE_ORDER) {
      if (current.map[profile] !== newMap[profile]) {
        anyChange = true
        break
      }
    }

    this.assignments.set(deviceId, nextAssignment)

    // The high-profile prebuffer default (warm) is evaluated against the profile
    // assignment. `applyPrebufferConfig` runs once at broker creation, which on a
    // normal multi-stream boot happens BEFORE the stream is auto-assigned to
    // `high` — so re-apply it here whenever the high slot's camStreamId changes,
    // for the stream that stops being high (reverts to on-demand) and the one that
    // becomes high (warms up). Idempotent; explicit operator overrides still win.
    if (current.map.high !== newMap.high) {
      for (const camStreamId of [current.map.high, newMap.high]) {
        if (!camStreamId) continue
        const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
        if (broker) this.applyPrebufferConfig(broker, deviceId, camStreamId)
      }
    }

    // Demand transitions for push-kind streams.
    for (const [camId, prevCount] of oldPushConsumers) {
      if ((newPushConsumers.get(camId) ?? 0) === 0 && prevCount > 0) {
        this.emitCamStreamIdle(deviceId, camId)
      }
    }
    for (const [camId, nextCount] of newPushConsumers) {
      if ((oldPushConsumers.get(camId) ?? 0) === 0 && nextCount > 0) {
        // Figure out which profile triggered the demand (first one in canonical order).
        let triggerProfile: CamProfile = 'mid'
        for (const p of CAM_PROFILE_ORDER) {
          if (newMap[p] === camId) {
            triggerProfile = p
            break
          }
        }
        this.emitCamStreamDemand(deviceId, camId, triggerProfile)
      }
    }

    if (anyChange || current.auto !== nextAssignment.auto) {
      this.persistProfileMap()
      this.emitProfileSlotsChanged(deviceId)
    } else if (opts.reason === 'publish' && opts.streamAdded) {
      // Re-publish that (re)introduced a stream (provider reconnect / a stream
      // reappearing) with an unchanged assignment: still emit so the
      // orchestrator can re-dispatch detection onto the fresh broker. But a
      // routine re-publish that only UPDATES an existing stream's url/sdp (the
      // Reolink on-demand `materializeStreamSocket`, which fires on every dial)
      // must NOT emit — otherwise it re-triggers detection/decoder churn on a
      // ~loop as demand cycles the socket. `streamAdded` gates exactly that.
      this.emitProfileSlotsChanged(deviceId)
    }
    // Re-point profile-keyed restreamers at their (possibly new) sources.
    // On a FIRST publish this runs before ensureBroker creates the source
    // broker, so profiles whose source isn't live yet are skipped here and
    // wired by the syncProfileRestreamers call inside the publish path once
    // the broker exists — don't remove that second call thinking it redundant.
    this.syncProfileRestreamers(deviceId)
    this.applyClipRetention(deviceId)
  }

  /**
   * Apply the retention THIS camera's notification rules actually ask for.
   *
   * Three inputs, one number:
   *
   *  1. the PLAN — `notificationRules.getClipRetentionAsks`, the rules' own
   *     demand per camera ({@link refreshClipRetentionPlan});
   *  2. what a cut has been OBSERVED asking for on this camera
   *     ({@link noteClipAsk}) — the old reactive arming, folded into the same
   *     ask so there is one mechanism rather than two;
   *  3. nothing at all, when the plan has never arrived — see
   *     {@link CLIP_RETENTION_UNKNOWN_SEC}. An unknown camera is not a camera
   *     that needs nothing.
   *
   * Retention is opportunistic: it never dials a camera, it only fills while
   * something else already holds the stream up (usually the detection pipeline
   * that produced the event in the first place). A camera nobody is watching
   * therefore yields a shorter clip instead of a permanently warm stream.
   */
  private applyClipRetention(deviceId: number): void {
    const map = this.assignments.get(deviceId)?.map ?? {}
    const resolved = this.resolveClipRetention(deviceId, map)
    for (const profile of CAM_PROFILE_ORDER) {
      const camStreamId = map[profile]
      if (!camStreamId) continue
      const wanted = resolved.profiles.has(profile) ? resolved.seconds : 0
      this.brokers.get(brokerIdFor(deviceId, camStreamId))?.setClipRetention(wanted)
    }
    this.reportClipRetention(deviceId, resolved)
  }

  /**
   * The seconds and the profiles this camera's ring should hold, and WHY.
   *
   * The MAX over every ask that reaches the camera — the asks describe the
   * rules, the bounding belongs here (and, below this, to the ring's own byte
   * budget, which is never raised for an ask).
   */
  private resolveClipRetention(
    deviceId: number,
    map: Partial<Record<CamProfile, string>>,
  ): ResolvedClipRetention {
    const cheapest = CLIP_PROFILE_BY_COST.find((p) => map[p] !== undefined)
    const observed = this.clipRetentionObserved.get(deviceId)
    const profiles = new Set<CamProfile>()
    let seconds = 0
    let source: ClipRetentionSource
    if (this.clipRetentionAsks === null) {
      seconds = CLIP_RETENTION_UNKNOWN_SEC
      source = 'unknown'
    } else {
      source = 'rules'
      for (const ask of this.clipRetentionAsks) {
        if (ask.deviceId !== undefined && ask.deviceId !== deviceId) continue
        if (ask.seconds > seconds) seconds = ask.seconds
        if (ask.profile !== undefined) profiles.add(ask.profile)
      }
    }
    if (observed !== undefined) {
      for (const [profile, asked] of observed) {
        if (asked > seconds) {
          seconds = asked
          source = source === 'unknown' ? 'unknown' : 'observed'
        }
        profiles.add(profile)
      }
    }
    // Zero is a real answer — every rule that can fire on this camera is a rule
    // that never cuts footage — and it must reach every profile, the cheapest
    // included. That is the whole saving.
    if (seconds <= 0) return { seconds: 0, profiles: new Set<CamProfile>(), source }
    // The cut defaults to the cheapest assigned profile, so it is always armed;
    // an ask that named a profile adds that one on top.
    if (cheapest !== undefined) profiles.add(cheapest)
    return { seconds, profiles, source }
  }

  /**
   * Say it, once per transition, per camera.
   *
   * This mechanism MOVES — a rule created, disabled or deleted changes what a
   * camera holds within one reconcile tick — and a retention that changes
   * silently is a retention nobody can correlate with a missing clip. The
   * broker's own `setClipRetention` logs the buffer it allocated; this line
   * says who asked for it.
   */
  private reportClipRetention(deviceId: number, resolved: ResolvedClipRetention): void {
    const signature = `${resolved.seconds}:${resolved.source}:${[...resolved.profiles].sort().join(',')}`
    const previous = this.clipRetentionApplied.get(deviceId)
    if (previous === signature) return
    this.clipRetentionApplied.set(deviceId, signature)
    this.logger.info(
      resolved.seconds === 0
        ? 'clip retention: none — no notification rule on this camera cuts footage'
        : 'clip retention set from the notification rules',
      {
        tags: { deviceId },
        meta: {
          seconds: resolved.seconds,
          profiles: [...resolved.profiles],
          source: resolved.source,
          previous: previous ?? 'none',
        },
      },
    )
  }

  /** Seconds this camera's ring is currently asked to hold (0 when none). */
  private clipRetentionSecFor(deviceId: number): number {
    return this.resolveClipRetention(deviceId, this.assignments.get(deviceId)?.map ?? {}).seconds
  }

  /**
   * PULL the notification centre's per-camera asks and apply them.
   *
   * A pull, not a push: a camera's ring lives on the node that ingests it while
   * `notification-rules` is a singleton, so a push would have to enumerate the
   * cluster. It also makes the failure mode right — a pull that fails, or one
   * answered by a centre whose rules have not loaded, changes NOTHING (D49: a
   * read that fails must never be able to destroy work, and dropping a ring is
   * destroying work). Only an answer about a rule set that was actually read
   * can take retention away.
   *
   * Rides the catalog reconcile, which is also the D8 backstop that re-derives
   * after a rule is created, edited, enabled, disabled or deleted — bounded
   * staleness (one tick), never a mirror that only follows the rules at boot.
   */
  async refreshClipRetentionPlan(): Promise<void> {
    const api = this.api
    if (!api) return
    let plan: { rulesLoaded: boolean; asks: readonly NcClipRetentionAsk[] }
    try {
      plan = await api.notificationRules.getClipRetentionAsks.query({})
    } catch (err) {
      this.logger.debug('clip retention plan unavailable — keeping the one in force', {
        meta: { error: errMsg(err), known: this.clipRetentionAsks !== null },
      })
      return
    }
    if (!plan.rulesLoaded) {
      this.logger.debug('clip retention plan: the notification centre has not read its rules yet', {
        meta: { known: this.clipRetentionAsks !== null },
      })
      return
    }
    this.clipRetentionAsks = plan.asks
    for (const deviceId of this.assignments.keys()) this.applyClipRetention(deviceId)
  }

  /** Produced event artifacts waiting to be fetched by handle (D9/D18). */
  private readonly eventMedia = new EventMediaStore()

  /**
   * The notification rules' own asks, per camera. `null` = never answered.
   *
   * `null` and `[]` are DIFFERENT and the difference is a camera's footage:
   * `[]` means the centre read its rules and none of them cut footage here,
   * `null` means nobody has said. Only the first one is allowed to zero a ring.
   */
  private clipRetentionAsks: readonly NcClipRetentionAsk[] | null = null

  /**
   * What a cut was OBSERVED asking for, per camera and profile.
   *
   * The old `armClipRetention`, folded into the ask above so retention has ONE
   * input shape. It still exists because the plan describes the notification
   * rules and a cut can come from elsewhere (a clips API, an export, a rule
   * created a second ago on another node): a consumer that asked for a window
   * this ring did not hold gets it next time. It is REMEMBERED because the
   * reconcile re-applies retention on a timer, and without that the arming was
   * wiped within the minute — a rule asking for `high` fell back to `low`
   * forever and looked like the choice did nothing.
   */
  private readonly clipRetentionObserved = new Map<number, Map<CamProfile, number>>()

  /** Last reported (seconds, source, profiles) per camera — transitions only. */
  private readonly clipRetentionApplied = new Map<number, string>()

  /**
   * A cut asked this camera for `seconds` on `profile` — remember it.
   *
   * ONE ask, with both halves: the reactive arming used to carry the profile
   * and inherit the flat duration, so a consumer that needed a longer window
   * had no way to say so and a consumer that needed none still paid.
   */
  private noteClipAsk(deviceId: number, profile: CamProfile, seconds: number): void {
    const observed = this.clipRetentionObserved.get(deviceId) ?? new Map<CamProfile, number>()
    const bounded = Math.max(0, Math.min(seconds, CLIP_RETENTION_UNKNOWN_SEC))
    if ((observed.get(profile) ?? 0) >= bounded && this.clipRetentionObserved.has(deviceId)) return
    observed.set(profile, Math.max(observed.get(profile) ?? 0, bounded))
    this.clipRetentionObserved.set(deviceId, observed)
    this.applyClipRetention(deviceId)
  }

  private countPushConsumers(
    map: Partial<Record<CamProfile, string>>,
    deviceId: number,
  ): Map<string, number> {
    const out = new Map<string, number>()
    const streamMap = this.cameraStreams.get(deviceId)
    for (const profile of CAM_PROFILE_ORDER) {
      const camId = map[profile]
      if (!camId) continue
      const cam = streamMap?.get(camId)
      if (!cam || !PUSH_KINDS.has(cam.kind)) continue
      out.set(camId, (out.get(camId) ?? 0) + 1)
    }
    return out
  }

  private persistProfileMap(): void {
    this.profileMapPersister?.(this.assignments)
  }

  /**
   * Resolve the per-camStream "source parser" override into the optional
   * `ffmpegParser` slice of a pull-* {@link StreamSource}. Returns `{}` for
   * native ingest (the default) and `{ ffmpegParser: { transport } }` when the
   * operator selected the ffmpeg engine — the broker then ingests through
   * {@link FfmpegSourceReader} instead of a native TS client. Normalization args
   * (input/output) are a later slice and stay unset. Logs a one-time warning
   * when a reserved setting (`native-udp`) fell back to `native-tcp`.
   */
  private resolveFfmpegParser(
    cam: CameraStreamInternal,
    sourceType: SourceParserSourceType,
  ): Pick<StreamSource, 'ffmpegParser'> {
    const setting = this.deviceOverrides.get(cam.deviceId)?.sourceParser?.[cam.camStreamId]
    const resolved = resolveSourceParser(setting, sourceType)
    if (resolved.fellBack) {
      const key = `${cam.deviceId}:${cam.camStreamId}`
      if (!this.sourceParserFellBackWarned.has(key)) {
        this.sourceParserFellBackWarned.add(key)
        this.logger.warn(
          'source parser native-udp requested but not yet implemented — falling back to native-tcp',
          {
            tags: { deviceId: cam.deviceId },
            meta: { deviceId: cam.deviceId, camStreamId: cam.camStreamId },
          },
        )
      }
    }
    if (resolved.engine !== 'ffmpeg') return {}
    return {
      ffmpegParser: {
        transport: resolved.transport,
        ...this.resolveSourceParserArgs(cam.deviceId, cam.camStreamId),
      },
    }
  }

  /**
   * Resolve the per-camStream operator-authored ffmpeg normalization args into
   * the optional `inputArgs`/`outputArgs` slice of a {@link StreamSource.ffmpegParser}.
   * Returns only the non-empty arrays so a `{}` result stays clean. Shared by
   * BOTH the rtsp/rtmp `resolveFfmpegParser` path and the always-ffmpeg
   * `pull-flv` case — the single source of truth for per-camStream args.
   */
  private resolveSourceParserArgs(
    deviceId: number,
    camStreamId: string,
  ): { inputArgs?: readonly string[]; outputArgs?: readonly string[] } {
    const entry = this.deviceOverrides.get(deviceId)?.sourceParserArgs?.[camStreamId]
    const out: {
      inputArgs?: readonly string[]
      outputArgs?: readonly string[]
    } = {}
    if (entry?.inputArgs && entry.inputArgs.length > 0) out.inputArgs = entry.inputArgs
    if (entry?.outputArgs && entry.outputArgs.length > 0) out.outputArgs = entry.outputArgs
    return out
  }

  /**
   * Build the {@link EncodeProfile} the args-only ffmpeg-params widget mounts
   * as its `initialValue`: the persisted per-camStream input/output args layered
   * over a copy/passthrough base (no transcode). The widget renders only the
   * args editors; the copy/passthrough base is inert but keeps the profile
   * well-formed for the round-trip through `EncodeProfileSchema`.
   */
  private buildSourceParserArgsProfile(
    entry: { inputArgs?: readonly string[]; outputArgs?: readonly string[] } | undefined,
  ): EncodeProfile {
    const inputArgs = entry?.inputArgs
    const outputArgs = entry?.outputArgs
    return {
      video: { codec: 'copy' },
      audio: 'passthrough',
      ...(inputArgs && inputArgs.length > 0 ? { inputArgs: [...inputArgs] } : {}),
      ...(outputArgs && outputArgs.length > 0 ? { outputArgs: [...outputArgs] } : {}),
    }
  }

  private buildSourceFromCamStream(cam: CameraStreamInternal): StreamSource {
    const label = cam.label ?? cam.camStreamId
    const codec = cam.codec !== undefined ? { videoCodec: cam.codec } : {}
    // Battery-flagged devices want the stall watchdog relaxed (Reolink
    // Argus and friends intentionally go silent between motion events).
    // Derive the per-source flag from the device-level feature list so
    // publishers don't have to carry their own per-stream flag.
    const stall = cam.deviceFeatures.includes(DeviceFeature.BatteryOperated)
      ? { allowStall: true as const }
      : {}
    // Pre-compose pass-through metadata so the publisher's opaque payload
    // (e.g. `pull-rfc4571` SDP) reaches the broker reader unchanged.
    const passthroughMeta = cam.metadata ?? {}
    switch (cam.kind) {
      case 'push-annexb':
        return {
          type: 'push',
          url: '',
          ...codec,
          ...stall,
          metadata: { kind: 'push-annexb', label, ...passthroughMeta },
        }
      case 'pull-rtsp': {
        const parser = this.resolveFfmpegParser(cam, 'rtsp')
        return {
          type: 'rtsp',
          url: cam.url ?? '',
          ...codec,
          ...parser,
          metadata: { kind: 'pull-rtsp', label, ...passthroughMeta },
        }
      }
      case 'pull-rtmp': {
        const parser = this.resolveFfmpegParser(cam, 'rtmp')
        return {
          type: 'rtmp',
          url: cam.url ?? '',
          ...codec,
          ...parser,
          metadata: { kind: 'pull-rtmp', label, ...passthroughMeta },
        }
      }
      case 'pull-http':
        return {
          // HTTP/MJPEG is normalized to H.264 before entering the broker. The
          // native broker has no MJPEG packet reader; leaving this as the old
          // `http-mjpeg` discriminator silently selected the "external push"
          // fallback and no frames ever arrived.
          type: 'http',
          url: cam.url ?? '',
          videoCodec: 'h264',
          ffmpegParser: {
            transport: 'tcp',
            outputArgs: HTTP_MJPEG_H264_OUTPUT_ARGS,
          },
          metadata: { kind: 'pull-http', label, ...passthroughMeta },
        }
      case 'pull-flv':
        // HTTP-FLV is unreadable by the native TS clients — ALWAYS route it
        // through the broker's ffmpeg source reader (`-c copy -f mpegts`).
        // The `source.ffmpegParser` presence makes `start()` dispatch to
        // `startFfmpegSourceReader` before the per-`type` native switch, so
        // `type: 'flv'` only needs to be a distinct discriminator string.
        return {
          type: 'flv',
          url: cam.url ?? '',
          ...codec,
          ffmpegParser: {
            transport: 'tcp',
            ...this.resolveSourceParserArgs(cam.deviceId, cam.camStreamId),
          },
          metadata: { kind: 'pull-flv', label, ...passthroughMeta },
        }
      case 'pull-rfc4571':
        return {
          type: 'rfc4571',
          url: cam.url ?? '',
          ...codec,
          ...stall,
          metadata: { kind: 'pull-rfc4571', label, ...passthroughMeta },
        }
      case 'derived':
        // A derived stream is a PUSH broker: its encoded plane is produced by a
        // manager-owned DerivedStreamFeeder (ffmpeg transcode of the source
        // loopback) that calls `pushEncodedPacket`/`pushAudioInfo`. The broker
        // itself dials nothing — it waits for the feeder exactly like a
        // camera-provider push source. `codec` (seeded from the encode
        // profile's target codec) primes `detectedCodec` so WebRTC negotiates
        // the right codec before the first transcoded packet arrives.
        return {
          type: 'push',
          url: '',
          ...codec,
          metadata: { kind: 'derived', label, ...passthroughMeta },
        }
      default: {
        const _exhaustive: never = cam.kind
        throw new Error(`Unknown cam stream kind: ${String(_exhaustive)}`)
      }
    }
  }

  /**
   * Acquire (or create) the broker for a (deviceId, camStreamId) pair.
   * Idempotent — returns the existing broker when one is already
   * registered. Tied to publish lifecycle: `publishCameraStream` calls
   * this once per stream; `retractCameraStream` releases it.
   */
  /**
   * True when THIS node owns the cluster's camera source pull
   * (`clusterRoles.ingestNode`). Backs the `ensureBroker` dormancy gate.
   *
   * Ownership is normally PUSHED by the orchestrator's
   * `PipelineIngestOwnerChanged` event ({@link subscribeIngestOwnerChanges}),
   * so the steady-state gate is a pure cache read — no per-`ensureBroker`
   * cross-process query.
   *
   * - Not yet wired (`api`/`localNodeId` absent) → `true` (unchanged behavior;
   *   the manager runs as today until `setApiAccess` supplies a node id).
   * - Cached owner fresh (event-stamped, within {@link INGEST_OWNER_CACHE_TTL_MS}) →
   *   pure comparison, no query.
   * - Cold start / no event for the backstop window → a single `getIngestOwner`
   *   reconcile query. It fails FAST now (FIX #1 makes an unregistered-provider
   *   miss a precise error, not a 30s hang), so on failure we FAIL-OPEN: use the
   *   last-known owner, or ALLOW when nothing is known — a rare transient
   *   double-pull self-heals on the next pushed event, whereas denying would
   *   starve the owner (no prebuffer, no recording).
   */
  private async isLocalIngestOwner(): Promise<boolean> {
    if (!this.api || this.localNodeId === null) return true
    const now = Date.now()
    if (
      this.cachedIngestOwnerNodeId !== null &&
      now - this.cachedIngestOwnerAt < StreamBrokerManager.INGEST_OWNER_CACHE_TTL_MS
    ) {
      return this.cachedIngestOwnerNodeId === this.localNodeId
    }
    try {
      const owner = await this.api.pipelineOrchestrator.getIngestOwner.query()
      this.cachedIngestOwnerNodeId = owner.ownerNodeId
      this.cachedIngestOwnerAt = now
      return owner.ownerNodeId === this.localNodeId
    } catch (err: unknown) {
      // FAIL-OPEN. `getIngestOwner` is a cross-process (UDS) call from this
      // forked stream-broker to the orchestrator; a transient failure
      // (orchestrator respawn/churn) must NOT starve the OWNER — denying here
      // stops the hub (the usual owner) from dialing, breaking prebuffer +
      // recording. Prefer a rare, transient double-pull (self-heals on the next
      // resolve) over a source outage. Use last-known when we have it; else ALLOW.
      this.logger.debug('isLocalIngestOwner: getIngestOwner unavailable — fail-open', {
        meta: {
          lastKnown: this.cachedIngestOwnerNodeId,
          self: this.localNodeId,
          error: errMsg(err),
        },
      })
      return this.cachedIngestOwnerNodeId === null
        ? true
        : this.cachedIngestOwnerNodeId === this.localNodeId
    }
  }

  private async ensureBroker(deviceId: number, camStreamId: string): Promise<void> {
    // A disabled device never (re)creates a broker — see `disabledDevices`.
    // Without this, a subscriber's retry (audio-chunk poller, frame plane)
    // resurrects the broker the disable teardown just released.
    if (this.disabledDevices.has(deviceId)) return
    const cam = this.cameraStreams.get(deviceId)?.get(camStreamId)
    if (!cam) return
    const brokerId = brokerIdFor(deviceId, camStreamId)
    const live = this.brokers.get(brokerId)
    if (live) {
      // A re-publish refreshes the device FEATURE snapshot (battery detection
      // can happen post-creation, via a live probe), and the recording pre-roll
      // default reads that snapshot. Re-applying here is what keeps a camera
      // that turned out to be battery-operated from retaining 10 s of ring for
      // the rest of the process's life.
      return
    }

    // Single-flight the get-or-create per brokerId: the body below awaits
    // `isLocalIngestOwner()` and `broker.start()` before it reaches
    // `this.brokers.set()`, so two callers racing this method for the SAME
    // brokerId would otherwise both pass the `.has()` guard above.
    // Everything from here to the `.set()` just below is synchronous, so
    // this check-then-store is atomic — no other invocation of this method
    // can interleave. Mirrors `ensureBrokerForWebrtcSession` /
    // `remoteAdapterEnsures`.
    const existingEnsure = this.brokerEnsures.get(brokerId)
    if (existingEnsure) {
      await existingEnsure
      return
    }

    const ensure = this.createBrokerForId(deviceId, camStreamId, brokerId, cam)
    this.brokerEnsures.set(brokerId, ensure)
    try {
      await ensure
    } finally {
      this.brokerEnsures.delete(brokerId)
    }
  }

  /**
   * Single-flight body for `ensureBroker`'s physical-broker get-or-create —
   * resolves the ingest-owner dormancy gate, then constructs, starts, and
   * registers the `StreamBroker`. Only ever run once per brokerId at a
   * time; see `brokerEnsures`.
   */
  private async createBrokerForId(
    deviceId: number,
    camStreamId: string,
    brokerId: string,
    cam: CameraStreamInternal,
  ): Promise<void> {
    // Ingest-owner dormancy gate: a PHYSICAL-source broker (this method always
    // builds one — the RemoteEncodedSourceBroker restream path is separate) may
    // only be created on the node that owns the camera's source pull
    // (`clusterRoles.ingestNode`). On a non-owner node every consumer sources
    // the owner's restream (detection `remote-restream`, recorder/snapshot/audio
    // owner-pins, WebRTC `RemoteEncodedSourceBroker`), so a local physical broker
    // here would be a second physical dial of the same camera (double-pull). At
    // `ingestNode='hub'` (default) the hub is the owner and creates every broker
    // — byte-identical to before.
    if (!(await this.isLocalIngestOwner())) {
      // Steady-state on every non-owner node — log once per brokerId, not on
      // every reconcile (see `nonOwnerSkipLogged`).
      if (!this.nonOwnerSkipLogged.has(brokerId)) {
        this.nonOwnerSkipLogged.add(brokerId)
        this.logger.debug('ensureBroker: not the ingest owner — skipping local physical broker', {
          tags: { deviceId, camStreamId },
          meta: {
            brokerId,
            ingestOwner: this.cachedIngestOwnerNodeId,
            self: this.localNodeId,
          },
        })
      }
      return
    }

    const brokerLogger = this.logger.child(camStreamId).withTags({ deviceId, camStreamId })
    const source = this.buildSourceFromCamStream(cam)
    const broker = new StreamBroker(brokerId, brokerLogger, buildAudioCodecCapApi(this.api))
    // Point the broker at the LIVE pinned ffmpeg so an ffmpeg-parser source can
    // spawn its `FfmpegSourceReader` ingress (no-op for native sources).
    this.bindBrokerFfmpeg(broker)
    // Let the broker claim the ffmpeg ingest it may spawn as this addon's cost
    // for this camera (`load-contribution`). No-op when the addon did not hand
    // the manager a registry.
    if (this.costRegistry !== null) broker.setCostRegistry(this.costRegistry)
    this.applyPrebufferConfig(broker, deviceId, camStreamId)
    // Before `start()`: a broker created for a muted device must never have
    // distributed a single audio unit. Applying it after the dial would leave
    // a window of audible packets on every reconnect, catalog republish and
    // addon restart — the mute would look intermittent rather than broken,
    // which is the harder bug to see.
    this.applyAudioMuteConfig(broker, deviceId)
    this.applyJoinBurstBound(broker, deviceId, camStreamId)
    this.applyClipRetention(deviceId)
    const override = this.deviceOverrides.get(deviceId)
    if (override?.streamingDebug) broker.setStreamingDebug(true)

    // Hook the broker into the cam-stream registry: every dial
    // attempt re-derives the source so a re-publish (e.g. Reolink
    // refreshing its rfc4571 URL) is observed transparently — the
    // source provider closure re-resolves a fresh URL on every dial.
    broker.setSourceProvider(() => {
      const latest = this.cameraStreams.get(deviceId)?.get(camStreamId)
      return latest ? this.buildSourceFromCamStream(latest) : null
    })
    broker.setRequestSourceRefresh(() => {
      this.emitRequestStreamSourceRefresh(deviceId, camStreamId, brokerId)
    })
    // The SENTRY. Everything it needs lives here and nowhere else: the
    // probed geometry and codec, the snapshot cache, the device name and the
    // ffmpeg binary. The broker contributes only WHEN the window is open.
    broker.setPrestreamProvider(
      this.buildPrestreamProvider(deviceId, camStreamId, brokerId, brokerLogger),
    )

    try {
      await broker.start(source)
    } catch (err) {
      // `start()` failed before the broker was registered in `this.brokers`
      // — stop it so it can't leak as a zombie (armed reconnect/watchdog
      // timers, a partially-started pipe server) and propagate the original
      // failure unchanged. `stop()` is idempotent (sets `manualStop`/
      // `stopping` and clears timers), so this is safe even if `start()`
      // failed before touching any of that state.
      await broker.stop().catch(() => {})
      throw err
    }

    // Belt-and-suspenders: `brokerEnsures` should make this impossible, but
    // never silently overwrite a broker that's already live in the registry
    // — stop the just-started instance instead of leaking it as a zombie.
    if (this.brokers.has(brokerId)) {
      await broker.stop()
      return
    }
    this.brokers.set(brokerId, broker)
    // AFTER the registry insert, not before. The `applyClipRetention` above
    // runs while this broker is still invisible to `this.brokers`, so it armed
    // every OTHER slot of this camera and left the one being created at zero
    // until some later assignment change happened to re-apply — which on a
    // steady camera is never. A ring that is empty at the moment the first
    // event of a boot arrives is the failure this whole mechanism exists to
    // prevent, so the ask is applied once more here, where the broker can
    // actually receive it.
    this.applyClipRetention(deviceId)

    this.registerSourceRestreamer(brokerId, broker)

    await this.fanOutRegistration(deviceId, brokerId, cam, broker)
    // A new source broker may back one or more assigned profiles — wire
    // their profile-keyed restreamers now that the source exists.
    this.syncProfileRestreamers(deviceId)

    // Recreating a derived push broker without its feeder is the 618 stall.
    // Bind it here so every `ensureBroker` path (not only publish) produces
    // a live transcode, not an empty shell.
    if (cam.kind === 'derived') {
      const def = this.resolveDerivedDef(deviceId, camStreamId)
      if (def) this.attachDerivedFeeder(deviceId, camStreamId, def.source, def.encodeProfile)
    }
  }

  /**
   * Register one source broker's RTSP restreamer with its persisted token (or a
   * freshly minted one). A camera whose tokens are held in an unreadable keychain
   * gets no EXTERNAL token, only the internal loopback-only alias.
   */
  private registerSourceRestreamer(brokerId: string, broker: StreamBroker): void {
    const deviceId = parseBrokerId(brokerId)?.deviceId
    if (deviceId === undefined) return
    if (this.restreamGate(deviceId)) {
      // NO external URL (the token is held in an unreadable keychain), but the
      // broker's own consumers still need the restream: an ephemeral,
      // loopback-only, never-persisted alias serves them (D870).
      this.logger.warn('external restream URL withheld - the tokens are held but unreadable', {
        tags: { deviceId },
        meta: { brokerId },
      })
      this.rtspServer.registerInternalAlias(
        brokerId,
        broker.getRtspRestreamer(),
        () =>
          broker.onEncodedData(() => {
            /* warm-up no-op */
          }, RTSP_DESCRIBE_WARMUP_ATTRIBUTION),
        () => broker.openPrestreamWindow(),
      )
      return
    }
    const existingToken = this.persistedTokens.get(brokerId)
    // Pass a warm-up closure that subscribes a no-op encoded-data
    // consumer for the duration of an RTSP restream session. Triggers
    // `checkDemand` → upstream dial when an external client (ffprobe,
    // recording sidecar, NVR) connects, so the DESCRIBE doesn't race a
    // cold broker and return an empty SDP. The handle is released when
    // the RTSP socket closes, letting the broker idle-suspend normally.
    const warmUp = (): (() => void) =>
      broker.onEncodedData(() => {
        /* warm-up no-op */
      }, RTSP_DESCRIBE_WARMUP_ATTRIBUTION)
    // …and a sentry opener, which is the warm-up's opposite: it makes the
    // picture flow so the DESCRIBE has an SDP, without subscribing demand and
    // therefore without dialling. A battery camera is never touched by it
    // (D173, D502).
    const openPrestreamWindow = (): (() => void) => broker.openPrestreamWindow()
    this.rtspServer.registerRestreamer(
      brokerId,
      broker.getRtspRestreamer(),
      warmUp,
      existingToken,
      openPrestreamWindow,
    )
    if (!existingToken) this.rtspProvider.persistTokens()
  }

  /**
   * Tear down the broker for a `(deviceId, camStreamId)` pair. No-op
   * when no broker exists. Called by `retractCameraStream` and by the
   * teardown half of `restartBroker`.
   */
  private async releaseBroker(deviceId: number, camStreamId: string): Promise<void> {
    const brokerId = brokerIdFor(deviceId, camStreamId)
    const broker = this.brokers.get(brokerId)
    if (!broker) return

    // Tear down a derived stream's feeder (kills ffmpeg + releases the source
    // loopback) BEFORE the broker stops, so no orphaned transcode outlives it.
    this.detachDerivedFeeder(brokerId)
    await this.fanOutUnregistration(deviceId, brokerId)
    this.rtspServer.unregisterRestreamer(brokerId)
    // Emit terminal stream.offline so subscribers can clear their
    // aggregate before the broker disappears. Skip if the broker never
    // became healthy (no transition to report).
    const wasHealthy = this.streamHealthByBroker.get(brokerId)
    if (wasHealthy && this.eventBus) {
      this.emitStreamHealth(false, {
        deviceId,
        camStreamId,
        profile: findProfileForStream(this.assignments.get(deviceId)?.map ?? {}, camStreamId),
        brokerId,
        sourceType: broker.getActiveSourceType(),
        lastPacketAt: broker.getLastPacketAt(),
        reason: 'broker-destroyed',
      })
    }
    this.streamHealthByBroker.delete(brokerId)
    this.streamOfflineReasonByBroker.delete(brokerId)
    this.sleepSuppressedBrokers.delete(brokerId)
    this.forgetReleasedStreamOutage({
      deviceId,
      camStreamId,
      brokerId,
      sourceType: broker.getActiveSourceType(),
      lastPacketAt: broker.getLastPacketAt(),
    })
    await broker.stop()
    this.brokers.delete(brokerId)
    this.sentryFrames.delete(brokerId)
    this.sweepAudioSubscriptions(brokerId)
    this.rtspProvider.persistTokens()
    // The source for one or more profiles just disappeared — drop the
    // now-dangling profile-keyed restreamers.
    this.syncProfileRestreamers(deviceId)
  }

  /**
   * Ensure a derived stream's push broker exists AND its transcode feeder is
   * attached. Consumers (recording `getStreamWithCodec`, WebRTC session setup,
   * profile restream DESCRIBE) address the PROFILE; the broker is responsible
   * for starting the derived. No-op for non-derived camStreams.
   */
  private async ensureDerivedReady(deviceId: number, camStreamId: string): Promise<void> {
    const published = this.cameraStreams.get(deviceId)?.get(camStreamId)
    if (published?.kind !== 'derived') return
    const def = this.resolveDerivedDef(deviceId, camStreamId)
    if (!def) return
    await this.ensureBroker(deviceId, camStreamId)
    this.attachDerivedFeeder(deviceId, camStreamId, def.source, def.encodeProfile)
  }

  /**
   * Source + encode profile for a derived camStream. Prefers the fields stored
   * on the catalog entry at publish; falls back to the persisted device
   * override (`derivedStreams[<name>]`) so a consumer can re-attach after a
   * broker release even if the in-memory record predates those fields.
   */
  private resolveDerivedDef(
    deviceId: number,
    camStreamId: string,
  ): { source: DerivedSourceRef; encodeProfile: EncodeProfile } | null {
    const published = this.cameraStreams.get(deviceId)?.get(camStreamId)
    if (published?.derivedSource && published.encodeProfile) {
      return {
        source: published.derivedSource,
        encodeProfile: published.encodeProfile,
      }
    }
    if (!camStreamId.startsWith('derived:')) return null
    const name = camStreamId.slice('derived:'.length)
    const def = this.deviceOverrides.get(deviceId)?.derivedStreams?.[name]
    if (!def?.source || !def.encodeProfile) return null
    return { source: def.source, encodeProfile: def.encodeProfile }
  }

  /**
   * Attach the on-demand transcode-feeder lifecycle to a freshly-minted derived
   * push broker. The feeder runs ONLY while the derived broker is consumed — it
   * is spawned on the broker's demand edge (`onDemandChange(true)`) and torn
   * down on idle (`false`), so an unwatched derived never pins its source. A
   * bounded-restart policy (mirroring the recorder's SegmentWriter) recovers a
   * feeder that dies while still demanded. Idempotent per broker.
   */
  private attachDerivedFeeder(
    deviceId: number,
    camStreamId: string,
    source: DerivedSourceRef,
    encodeProfile: EncodeProfile,
  ): void {
    const brokerId = brokerIdFor(deviceId, camStreamId)
    const broker = this.brokers.get(brokerId)
    if (!broker) return
    if (this.derivedFeeders.has(brokerId)) return

    const controller = new DerivedFeederController({
      logger: this.logger.child(`derived-feeder:${camStreamId}`).withTags({ deviceId }),
      spawn: (onTeardown) =>
        this.spawnDerivedFeeder(deviceId, camStreamId, source, encodeProfile, broker, onTeardown),
    })
    const unsubscribe = broker.onDemandChange((active) => controller.onDemand(active))
    this.derivedFeeders.set(brokerId, { controller, unsubscribe })
  }

  /** Detach + destroy a derived broker's feeder controller. No-op when absent. */
  private detachDerivedFeeder(brokerId: string): void {
    const entry = this.derivedFeeders.get(brokerId)
    if (!entry) return
    this.derivedFeeders.delete(brokerId)
    entry.unsubscribe()
    entry.controller.destroy()
  }

  /**
   * Resolve a derived stream's source loopback, build the transcode argv, and
   * connect a {@link DerivedStreamFeeder} that pushes into `broker`. Returns the
   * started feeder plus a `release` for the source refcount:
   *
   *  - PROFILE source → `getStreamWithCodec` returns a refcounted restream URL
   *    that follows the profile's current assignment (single camera pull); its
   *    `pipelineKey` is released on teardown.
   *  - CAMSTREAM source → the pinned source broker's RTSP restream loopback
   *    (dialing it registers an RTSP session that keeps that broker warm); no
   *    refcount to release.
   */
  private async spawnDerivedFeeder(
    deviceId: number,
    camStreamId: string,
    source: DerivedSourceRef,
    encodeProfile: EncodeProfile,
    broker: StreamBroker,
    onTeardown: () => void,
  ): Promise<ActiveDerivedFeeder> {
    const request = derivedSourceToStreamRequest(source, deviceId)
    let loopbackUrl: string
    let release: () => Promise<void>
    if (request.kind === 'ready') {
      const rtp = await this.getStreamWithCodec(request.request)
      loopbackUrl = rtp.url
      const { pipelineKey } = rtp
      release = async () => {
        await this.releaseStreamWithCodec({ pipelineKey })
      }
    } else {
      const sourceBrokerId = brokerIdFor(deviceId, request.camStreamId)
      const entry = this.rtspProvider.getInternalEntry(sourceBrokerId, '127.0.0.1')
      if (!entry) {
        throw new Error(`derived source camStream loopback unavailable: ${sourceBrokerId}`)
      }
      loopbackUrl = entry.url
      release = async () => {}
    }

    const sourceAudioCodec = this.observedSourceAudioCodec(deviceId, source)
    const { args, audio } = buildDerivedTranscodeArgs({
      profile: encodeProfile,
      loopbackUrl,
      sourceAudioCodec,
    })
    if (audio.decision.kind === 'recode-aac') {
      // The documented ripiego, said out loud once per feeder spawn. An
      // MPEG-TS cannot carry a copied G.711 track anywhere the demux will find
      // it (see `derived-transcode-args.ts`), so the source audio is
      // re-encoded rather than silently lost — which is what camera 108 did
      // for four days.
      this.logger.info('derived audio re-encoded to AAC — MPEG-TS cannot copy this source codec', {
        tags: { deviceId },
        meta: {
          camStreamId,
          sourceAudioCodec: audio.decision.sourceCodec ?? 'unknown',
        },
      })
    }
    const feeder = new DerivedStreamFeeder(
      {
        ffmpegPath: requireBrokerFfmpeg(this.ffmpegConfig.binaryPath, {
          logger: this.logger,
          deviceId,
          purpose: 'derived transcode',
          onMissing: () => this.reportFfmpegMissing(),
        }),
        args,
        logger: this.logger.child(`derived-ffmpeg:${camStreamId}`).withTags({ deviceId }),
      },
      {
        onEncodedPacket: (packet) => broker.pushEncodedPacket(packet),
        onAudioInfo: (info) => broker.pushAudioInfo(info),
        onPlaying: () => {
          this.logger.info('derived feeder streaming', {
            tags: { deviceId },
            meta: { camStreamId, loopbackUrl },
          })
        },
        onError: (error) => {
          this.logger.warn('derived feeder error', {
            tags: { deviceId },
            meta: { camStreamId, error: error.message },
          })
        },
        onTeardown,
      },
    )
    feeder.connect()
    return { feeder, release }
  }

  /**
   * The audio codec the derived stream's SOURCE broker has actually observed,
   * or `null` when there is nothing to read (source not resolved, broker not
   * created yet, cold dial, no audio track).
   *
   * Only ever an input to "can this track be COPIED into the derived MPEG-TS".
   * `null` resolves to the AAC re-encode, so every failure of this read lands
   * on the branch that still produces audible audio — the read can never mute
   * a camera, which is the direction that cost 108 four silent days.
   */
  private observedSourceAudioCodec(deviceId: number, source: DerivedSourceRef): string | null {
    const camStreamId =
      source.kind === 'camStream'
        ? source.camStreamId
        : (this.assignments.get(deviceId)?.map[source.profile] ?? null)
    if (camStreamId === null) return null
    const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
    return broker?.getStats().audio?.codec ?? null
  }

  /**
   * Whether a stream is warmed BY DEFAULT — the device's `high` profile.
   *
   * ONE input to {@link resolvePrebuffer}, not a decision of its own. Battery
   * and `pull-http` used to be tested here as well AND in
   * `getEffectivePreBufferSec` AND in `resolveRecordingPreRollMs`: three
   * statements of one rule, which is how they came to be able to disagree
   * about a single camera. They are stated once now, in `prebuffer.ts`.
   */
  private isDefaultWarm(deviceId: number, camStreamId: string): boolean {
    return findProfileForStream(this.assignments.get(deviceId)?.map ?? {}, camStreamId) === 'high'
  }

  /**
   * THE prebuffer for a (device, stream) — the one answer every caller uses.
   *
   * The settings screen reads it to display, the patch handler reads it to
   * apply, and {@link applyPrebufferConfig} reads it to install. That is the
   * D315-shaped half of this record: what the operator is SHOWN is resolved by
   * the same function that decides what runs, so a switch can no longer report
   * off on a function that is on — which is exactly what the settings
   * contribution did while it answered `perStream?.enabled ?? false` and the
   * broker's own flag shipped `true`.
   */
  private effectivePrebuffer(deviceId: number, camStreamId: string): PrebufferConfig {
    return resolvePrebuffer({
      camStreamId,
      clusterSeconds: this.defaultPreBufferSec,
      overrides: this.deviceOverrides.get(deviceId)?.preBuffer,
      defaultWarm: this.isDefaultWarm(deviceId, camStreamId),
      batteryOperated: this.deviceHasFeature(deviceId, DeviceFeature.BatteryOperated),
      terminalRelay: this.cameraStreams.get(deviceId)?.get(camStreamId)?.kind === 'pull-http',
    })
  }

  /**
   * Install the effective prebuffer on a broker. Idempotent — safe on every
   * publish, every re-publish and every settings edit, which is what lets a
   * camera discovered late (a battery flag that arrives after the first dial)
   * converge instead of holding the wrong retention for the life of the
   * process.
   */
  private applyPrebufferConfig(broker: StreamBroker, deviceId: number, camStreamId: string): void {
    broker.setPrebuffer(this.effectivePrebuffer(deviceId, camStreamId))
  }

  // ── Broker-side audio mute (D83) ──────────────────────────────────────

  /** Push the persisted mute onto a broker. Idempotent — safe on every pass. */
  private applyAudioMuteConfig(broker: StreamBroker, deviceId: number): void {
    broker.setAudioMuted(this.deviceOverrides.get(deviceId)?.audioMuted === true)
  }

  /** Every live broker of a device, derived and source alike. */
  private brokersOfDevice(deviceId: number): readonly StreamBroker[] {
    const streams = this.cameraStreams.get(deviceId)
    if (!streams) return []
    const found: StreamBroker[] = []
    for (const camStreamId of streams.keys()) {
      const broker = this.brokers.get(brokerIdFor(deviceId, camStreamId))
      if (broker) found.push(broker)
    }
    return found
  }

  /**
   * `streamBroker.getDeviceAudioMute` — read the device's audio-plane policy.
   *
   * The STORE is the answer, not the brokers: the policy applies to brokers
   * that do not exist yet, so a camera with nothing dialled is still muted.
   * `appliedBrokers` reports how much of it is presently in force, and is
   * diagnostic only — a switch that read it as the state would flip itself
   * off every time the camera went idle.
   */
  getDeviceAudioMute(input: { deviceId: number }): {
    muted: boolean
    appliedBrokers: number
  } {
    const muted = this.deviceOverrides.get(input.deviceId)?.audioMuted === true
    const applied = this.brokersOfDevice(input.deviceId).filter((b) => b.isAudioMuted()).length
    return { muted, appliedBrokers: applied }
  }

  /**
   * Set the device's audio-plane policy: persist it, then apply it to every
   * live broker — including DERIVED ones, whose restreamer would otherwise
   * keep serving an `m=audio` grafted from its transcode egress.
   *
   * Persist BEFORE applying. If the process dies between the two, the next
   * boot re-applies from the store and the camera is silent as asked; the
   * other order loses the operator's decision and the camera is audible again
   * with the switch still reading off.
   */
  async setDeviceAudioMute(input: {
    deviceId: number
    muted: boolean
  }): Promise<{ muted: boolean; appliedBrokers: number }> {
    const { deviceId, muted } = input
    const prior = this.deviceOverrides.get(deviceId)?.audioMuted === true
    const next: DeviceOverride = {
      ...this.deviceOverrides.get(deviceId),
      audioMuted: muted,
    }
    this.deviceOverrides.set(deviceId, next)
    this.deviceOverridePersister?.(this.deviceOverrides)
    const brokers = this.brokersOfDevice(deviceId)
    for (const broker of brokers) broker.setAudioMuted(muted)
    if (prior !== muted) {
      this.logger.info('broker audio mute set', {
        tags: { deviceId },
        meta: { muted, brokers: brokers.length },
      })
      // Either direction invalidates the D83 reconcile memory: muting makes
      // the absence of audio intended, un-muting starts a fresh observation.
      // Carrying disagreements across the flip would spend the re-dial budget
      // on a state the operator just changed.
      this.audioPlaneState.delete(deviceId)
    }
    return Promise.resolve({
      muted,
      appliedBrokers: brokers.filter((b) => b.isAudioMuted()).length,
    })
  }

  private async fanOutRegistration(
    _deviceId: number,
    brokerId: string,
    _cam: CameraStreamInternal,
    broker: StreamBroker,
  ): Promise<void> {
    // Register broker with the built-in WebRTC server (direct encoded
    // packet subscription — no ffmpeg, no RTSP double-hop).
    if (this.webrtcServer) {
      this.webrtcServer.registerBroker(brokerId, broker)
    }
  }

  private async fanOutUnregistration(_deviceId: number, brokerId: string): Promise<void> {
    // Unregister from built-in WebRTC server.
    if (this.webrtcServer) {
      this.webrtcServer.unregisterBroker(brokerId)
    }
  }

  private brokerStatusToSlotStatus(status: BrokerStats['status']): ProfileSlotStatus {
    // BrokerStatus has 'stopped' (broker tore down cleanly) which the
    // ProfileSlotStatus schema does not model — collapse to 'idle' since
    // a stopped-but-assigned slot from the consumer's POV is equivalent
    // to idle awaiting restart.
    if (status === 'stopped') return 'idle'
    return status
  }

  private snapshotProfileSlots(deviceId: number): ProfileSlot[] {
    const assignment = this.assignments.get(deviceId) ?? {
      map: {},
      auto: true,
    }
    const streamMap = this.cameraStreams.get(deviceId)
    const slots: ProfileSlot[] = []
    for (const profile of CAM_PROFILE_ORDER) {
      const camId = assignment.map[profile] ?? null
      // brokerId is keyed by camStreamId (the canonical broker identity);
      // for unassigned slots there's no live broker, so we surface a
      // synthetic profile-shaped key purely so consumers that ignore
      // the field for unassigned slots keep working unchanged.
      const brokerId = camId ? brokerIdFor(deviceId, camId) : makeProfileBrokerId(deviceId, profile)
      const broker = camId ? this.brokers.get(brokerId) : undefined
      const stats = broker?.getStats()
      const cam = camId ? streamMap?.get(camId) : undefined
      const status: ProfileSlotStatus = camId
        ? stats
          ? this.brokerStatusToSlotStatus(stats.status)
          : 'idle'
        : 'unassigned'
      // Codec resolution: prefer the live broker's detected codec
      // (`stats.codec` — populated after first frame), fall back to the
      // provider-declared `cam.codec`. Reolink cameras don't always
      // populate cam.codec at registration, so without this fallback
      // every slot reported codec=undefined and the UI rendered "—".
      const resolvedCodec = stats?.codec ?? cam?.codec
      const slot: ProfileSlot = {
        deviceId,
        profile,
        brokerId,
        sourceCamStreamId: camId,
        status,
        ...(cam?.resolution !== undefined ? { resolution: cam.resolution } : {}),
        ...(resolvedCodec !== undefined ? { codec: resolvedCodec } : {}),
        ...(stats !== undefined ? { preBufferSec: stats.preBufferSec } : {}),
      }
      slots.push(slot)
    }
    return slots
  }

  // ── Event emission (via IEventBus) ──────────────────────────────────

  private emitCapEvent(category: string, deviceId: number, data: Record<string, unknown>): void {
    const bus = this.eventBus
    if (!bus) return
    bus.emit({
      id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: {
        type: 'device',
        id: deviceId,
        addonId: 'stream-broker',
        deviceId,
      },
      category,
      data,
    })
  }

  private emitCamStreamDemand(deviceId: number, camStreamId: string, profile: CamProfile): void {
    this.emitCapEvent(EventCategory.StreamBrokerOnCamStreamDemand, deviceId, {
      deviceId,
      camStreamId,
      profile,
    })
  }

  private emitCamStreamIdle(deviceId: number, camStreamId: string): void {
    this.emitCapEvent(EventCategory.StreamBrokerOnCamStreamIdle, deviceId, {
      deviceId,
      camStreamId,
    })
  }

  private emitRequestStreamSourceRefresh(
    deviceId: number,
    camStreamId: string,
    brokerId: string,
  ): void {
    this.emitCapEvent(EventCategory.StreamBrokerOnRequestStreamSourceRefresh, deviceId, {
      deviceId,
      camStreamId,
      brokerId,
    })
  }

  private emitCamStreamsChanged(deviceId: number): void {
    const camStreams = this.getCameraStreamsForDevice(deviceId)
    this.emitCapEvent('camera-streams.onCamStreamsChanged', deviceId, {
      deviceId,
      camStreams,
    })
  }

  private emitProfileSlotsChanged(deviceId: number): void {
    const profileSlots = this.snapshotProfileSlots(deviceId)
    this.emitCapEvent('camera-streams.onProfileSlotsChanged', deviceId, {
      deviceId,
      profileSlots,
    })
    void this.writeCameraStreamsSlice(deviceId, profileSlots)
  }

  /**
   * Mirror per-device runtime state into the `camera-streams` slice.
   * Fire-and-forget — failures land on the debug log and don't impact
   * broker behavior (the slice is observability + RTSP autonomous-online
   * source, both fault-tolerant). Mirrors the same `setCapSlice` pattern
   * pipeline-runner uses for the `motion` slice.
   */
  private async writeCameraStreamsSlice(
    deviceId: number,
    slots: readonly ProfileSlot[],
  ): Promise<void> {
    const api = this.api
    if (!api) return
    const slotStatuses: {
      high?: ProfileSlotStatus
      mid?: ProfileSlotStatus
      low?: ProfileSlotStatus
    } = {}
    const slotErrors: { high?: string; mid?: string; low?: string } = {}
    let online = false
    for (const slot of slots) {
      if (slot.status !== 'unassigned') {
        slotStatuses[slot.profile] = slot.status
        if (slot.errorMessage) slotErrors[slot.profile] = slot.errorMessage
        if (slot.status === 'streaming') online = true
      }
    }
    try {
      await api.deviceState.setCapSlice.mutate({
        deviceId,
        capName: 'camera-streams',
        slice: { online, slotStatuses, slotErrors, lastChangedAt: Date.now() },
      })
    } catch (err) {
      this.logger.debug('writeCameraStreamsSlice failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

/**
 * The height a render lands at, once `scale=W:-2` has picked it.
 *
 * `-2` means "keep the aspect, round to an EVEN number" — libx264 rejects an
 * odd dimension in yuv420p. Reporting the arithmetic without the rounding is
 * how an artifact ends up one pixel taller than the file it describes.
 */
function scaledHeight(cut: ClipWindowCut, width: number): number {
  if (cut.sourceWidth <= 0 || cut.sourceHeight <= 0) return 0
  return 2 * Math.round(((width / cut.sourceWidth) * cut.sourceHeight) / 2)
}
