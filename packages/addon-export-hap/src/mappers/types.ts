/**
 * Mapper contract — a Mapper translates a single camstack device into
 * a HomeKit `Accessory` (potentially with multiple HAP services on it)
 * and owns the live bridge to camstack runtime state (event-bus
 * subscriptions, cap-poll loops, …).
 *
 * One Mapper instance per (camstack deviceId, HomeKit accessory). The
 * mapper registry (`./index.ts`) picks the concrete factory from the
 * device's type (`./kind.ts`).
 *
 * Both orchestrators use the **builder** pattern (`./builders/*.ts`): the
 * orchestrator builds a single `Accessory`, then delegates to per-feature
 * builders that ADD services to it. Each builder returns a `BuilderHandle`
 * exposing its own dispose so the orchestrator can tear them down
 * deterministically on `unexposeDevice`.
 */

import type { AddonContext, DeviceProxy, PinnedFfmpegResolver } from '@camstack/types'
import type { Accessory } from '@homebridge/hap-nodejs'

import type { HksvBuildOutcome } from '../hksv/build-outcome.js'
import type { HksvClipStore } from '../hksv/clip-store.js'
import type { HapDecodeMemos } from './builders/stream-hwaccel-memo.js'

export interface Mapper {
  readonly accessory: Accessory
  /** All accessories owned by this mapping (camera + any child accessories). */
  readonly accessories: readonly Accessory[]
  /** Tear down event subscriptions, timers, etc. */
  dispose(): Promise<void>
}

/**
 * Tunables for the camera mapper — passed down to every builder so they
 * don't have to reach into the addon's config blob — plus the collaborators
 * that must be shared across cameras rather than rebuilt per mapper.
 */
export interface CameraMapperOptions {
  /**
   * What the decode path remembers between sessions: the decoder addon's
   * per-node reading, and the backend that last died at init.
   *
   * ONE instance per addon process, created by the addon and handed to every
   * mapper. It is here rather than as a module global in `stream-hwaccel-memo`
   * for the reason `HwAccelCache` records: a module global outlives an addon
   * respawn and survives an operator changing the decoder backend. Per-camera
   * instances would be the opposite mistake — camera B re-paying camera A's
   * failed hardware init.
   */
  readonly decodeMemos: HapDecodeMemos
  /**
   * The node's PINNED ffmpeg (D540), one resolver per addon — every child a
   * mapper spawns (live stream, HKSV prebuffer) asks it. Rejects rather than
   * naming PATH; the spawning site logs the refusal per camera.
   */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /**
   * Where HomeKit Secure Video clips are TEED to, or `null` when the addon
   * could not open its own clip directory.
   *
   * ONE instance per addon, like `decodeMemos` and for a sharper version of
   * the same reason: the store's retention bounds are whole-store bounds, and
   * a per-camera instance would prune against a ceiling each camera thought
   * it had to itself.
   */
  readonly hksvClipStore: HksvClipStore | null
  /**
   * Where `buildHksvRecording` writes what it DECIDED for this camera.
   *
   * The clip source has to be able to say `index-empty` — "HomeKit recording
   * is switched on for this camera and the store holds nothing, because the
   * advertisement was withheld, and here is which of the three refusals fired"
   * — and the build is the only thing that knows. A mirror, written by the
   * authority at the moment it decides and read by nobody who makes a decision
   * (`hksv/build-outcome.ts`). Absent in a test that does not care.
   */
  readonly noteHksvOutcome?: (outcome: HksvBuildOutcome) => void
  /**
   * Per-device HAP streaming settings from the operator's configuration.
   * Injected by the addon at mapper-attach time so builders can read
   * the operator's source-stream choice without reaching back into the
   * addon's config blob.
   */
  readonly hapDeviceSettings: {
    /** Operator's stream preference ('auto' | 'high' | 'mid' | 'low'). */
    readonly streamPreference: 'auto' | string
    /**
     * Whether HomeKit Secure Video is advertised for this camera.
     *
     * Per-camera and off by default, because turning it on starts a PERMANENT
     * ffmpeg for this camera — the prebuffer only exists because the muxer
     * never stopped. Measured at 0.7 % of a core on the copy branch, which is
     * what makes it schedulable at all (D84); a fleet-wide default would still
     * be a capacity decision nobody made.
     */
    readonly hksvRecording?: boolean
    /** Offer Apple's new multi-tier RTP camera service (HEVC / 4K) on this
     *  camera. Absent means ON — `resolveMultiTierService`. */
    readonly multiTierService?: boolean
    /**
     * Keep CamStack's own copy of every clip HomeKit Secure Video records from
     * this camera. Absent means ON — `resolveKeepHomekitClips`; HKSV has no
     * read-back, so a recording nobody teed is gone for good (D550).
     */
    readonly keepHomekitClips?: boolean
    /**
     * Whether a session that cannot be served by a COPY may be transcoded.
     * Absent means yes. See the addon's `ExportDeviceSettings.allowTranscode`.
     */
    readonly allowTranscode?: boolean
  }
}

/**
 * Shared input bag for camera builders. The orchestrator hands each
 * builder the accessory it should mutate, the typed device proxy, and a
 * short string identifying the device for diagnostic logging.
 */
export interface BuilderContext {
  readonly ctx: AddonContext
  readonly accessory: Accessory
  readonly proxy: DeviceProxy
  readonly numericDeviceId: number
  readonly displayName: string
  readonly options: CameraMapperOptions
}

/**
 * Handle returned by each feature builder. `dispose` tears down event
 * subscriptions, timers, and ffmpeg children spawned by the builder.
 * Builders that only add static services may return a no-op dispose.
 */
export interface BuilderHandle {
  dispose(): Promise<void>
}
