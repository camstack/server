/**
 * HomeKit (HAP) export addon — publishes selected camstack devices as
 * standalone HomeKit accessories.
 *
 * Operator flow:
 *   1. Install + enable the addon (hub-only, group `export-hap`).
 *   2. On first boot the addon generates a random pincode + bridge
 *      MAC username and persists them on `this.config.identity` via
 *      `updateGlobalSettings` (no JSON sidecar files — the kernel
 *      addon-store IS the cache).
 *   3. The setup URI (`X-HM://…`) is logged AND surfaced via the
 *      `getStatus` cap method so the wizard UI can render the QR.
 *   4. Operator opens iOS Home → + → scan QR → enter pincode.
 *   5. Operator hits "Expose to HomeKit" on individual camstack devices.
 *      Each exposed device is published as its OWN accessory with its own
 *      mDNS advertisement, sharing one setup code — cameras cannot be
 *      bridged, so nothing is.
 *
 * Exception — the hap-nodejs library's own `HAPStorage` lives under
 * `ctx.dataDir/hap-store/`. That directory is library-internal: the
 * library reads + writes its node-persist pairing blobs there outside
 * of our control. The user directive ("drop all ctx.dataDir/* JSON
 * I/O for addon-owned data") explicitly scopes itself to OUR own data;
 * library-managed blobs are out of scope.
 *
 * ## Two accessory shapes, one rule about coverage
 *
 * `exposeDevice({deviceId})` resolves the device's TYPE to a mapper kind
 * (`mappers/kind.ts`) and hands off:
 *
 *  - a camera → `mappers/camera-accessory.ts`: streams, HKSV recording,
 *    doorbell, motion, intercom, PTZ, battery, privacy and every accessory
 *    child, all as services on one accessory;
 *  - anything else → `mappers/generic-accessory.ts`, driven by the
 *    capability→service table in `mappers/builders/generic/`.
 *
 * The type only picks the SHAPE. What a device publishes is decided by the
 * capabilities bound to it — restricting coverage by type is precisely what
 * confined this exporter to cameras for its first three rounds.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as path from 'node:path'
import {
  BaseAddon,
  type ConfigOption,
  type ConfigSectionWithValues,
  type ConfigUISchemaWithValues,
  deviceExportCapability,
  type DeviceType,
  EventCategory,
  ExportSetupSchema,
  type IDeviceExportProvider,
  memoizePinnedFfmpeg,
  type ProviderRegistration,
  videoclipsCapability,
} from '@camstack/types'
import { canonicalDeviceFingerprint, resolveExportFingerprint } from '@camstack/types/node'
import { uuid as HapUuid } from '@homebridge/hap-nodejs'
import type { z } from 'zod'
import {
  accessoryPaired,
  clearPairingFiles,
  initHapStorage,
  publishStandalone,
  unpublishAccessory,
} from './accessory-publisher.js'
import { type ActionExportEntry, ActionExports } from './action-exports.js'
import { BridgeHost } from './bridge-host.js'
import { shouldBridge } from './bridge-policy.js'
import { carryForward } from './exposed-entry.js'
import { firstExposedAccessorySetupUri } from './hap-setup-uri.js'
import type { HksvBuildOutcome } from './hksv/build-outcome.js'
import { HksvBuildOutcomes } from './hksv/build-outcome.js'
import { createBoundedFfmpegRunner } from './hksv/clip-ffmpeg-run.js'
import { createClipLocationPorts, HksvClipLocation } from './hksv/clip-location.js'
import { CLIP_REMUX_TIMEOUT_MS, createClipRemuxer } from './hksv/clip-remux.js'
import { HksvClipStore } from './hksv/clip-store.js'
import { CLIP_THUMBNAIL_TIMEOUT_MS, createClipThumbnailMinter } from './hksv/clip-thumbnail.js'
import { describeHomekitRecording, readHomekitRecordingActive } from './hksv/recording-active.js'
import { recordabilityTokenFor, withRecordabilityToken } from './hksv/recordability-token.js'
import {
  createHksvClipPlanes,
  HKSV_CLIP_MEDIA_PREFIX,
  HKSV_CLIP_THUMB_PREFIX,
  type HksvClipPlanes,
} from './hksv/videoclips-plane.js'
import type { HksvCameraFacts } from './hksv/videoclips-source.js'
import { createHksvVideoclipsProvider } from './hksv/videoclips-source.js'
import { rowsForCaps } from './mappers/builders/generic/cap-service-table.js'
import {
  createHapDecodeMemos,
  type HapDecodeMemos,
} from './mappers/builders/stream-hwaccel-memo.js'
import {
  accessoryUuidFor,
  getMapperFactory,
  HAP_EXPORTABLE_DEVICE_TYPES,
  type Mapper,
  type MapperKind,
  pickMapperKind,
  SUPPORTED_MAPPER_KINDS,
} from './mappers/index.js'
import { syncStateFromJson, syncStateToJson } from './reconcile/sync-state.js'

/**
 * Persistent HAP identity. With the per-camera standalone model only `pincode`
 * is meaningful — it's the SHARED setup code applied to every published
 * accessory. `username`/`uuid` are legacy (each accessory now derives its own
 * MAC from its stable UUID); kept on the config shape for back-compat.
 */
interface HapIdentity {
  readonly username: string
  readonly pincode: string
  readonly uuid: string
}

/**
 * Per-device export settings persisted on each `ExposedConfigEntry`.
 * The shape is shared across all three export addons (HAP / Alexa /
 * HA-MQTT); HA-MQTT extends it with addon-specific fields on its own
 * entry type.
 */
interface ExportDeviceSettings {
  /** Offer Apple's new multi-tier RTP camera service (HEVC / 4K) on this
   *  camera. Absent means ON — see {@link resolveMultiTierService}. */
  readonly multiTierService?: boolean
  /**
   * Preferred broker stream id used when the HomeKit camera service
   * dials the RTSP restream.
   *
   * `'auto'` resolves against the resolution the CONTROLLER negotiated:
   * `pickPreferredRtspEntry` is driven with `request.video.{width,height}`
   * and prefers the smallest profile at or above that target, falling back
   * to the largest below it. Note the consequence — a controller asking for
   * 720p is steered onto whichever slot is bound to `mid`, regardless of the
   * frame rate that slot actually delivers.
   *
   * That steering is now REFLECTED in what we advertise: the frame rate
   * offered for each resolution is the real rate of the slot this same picker
   * resolves it to (measured by the broker, else published by the provider,
   * else assumed). So changing this setting changes the advertisement, which
   * is why a change triggers a full accessory rebuild below.
   * See `mappers/builders/stream-fps.ts`.
   */
  readonly streamPreference: 'auto' | string
  /**
   * Route this device's accessory onto the shared BRIDGE instead of giving it
   * its own mDNS advertisement, HAP server and pairing.
   *
   * Default ON for every non-camera, and absent means ON — the field did not
   * exist for entries persisted before it, and one accessory each is a port, an
   * advertisement, a pairing record and a separate "Add Accessory" per device.
   * Ignored for cameras, which HomeKit forbids bridging; the field is not even
   * offered there (`shouldBridge` is the one place that decides).
   *
   * A change REBUILDS the accessory and DROPS its pairing: a standalone
   * accessory and a bridged one are different identities to iOS, so the device
   * leaves the Home app and is added again from the bridge. The description in
   * the panel says so.
   */
  readonly useBridge?: boolean
  /**
   * Whether we may DECODE AND RE-ENCODE this camera's stream for HomeKit.
   *
   * ON unless the operator says otherwise, and ABSENT means ON — the field did
   * not exist for entries persisted before it. Same switch as Alexa's, and the
   * same meaning: it says what the operator is willing to SPEND, not what they
   * want to see. A transcode is a decode plus an encode for the life of the
   * session, and on this hub a concurrent HEVC decode is what exhausted the
   * VAAPI device.
   *
   * HomeKit's constraint differs from Alexa's in one way worth knowing: HAP
   * NEGOTIATES the resolution and profile with the controller, so a session
   * that cannot be served by a copy has already promised the controller
   * something. With this off, such a session is REFUSED with a named reason
   * rather than transcoded behind the operator's back — a refusal an operator
   * chose is not a fault, and it must not look like one (D62).
   */
  readonly allowTranscode?: boolean
  /**
   * Keep CamStack's OWN copy of every clip HomeKit Secure Video records from
   * this camera.
   *
   * ON unless the operator says otherwise, and ABSENT MEANS ON — the field did
   * not exist for entries persisted before it, and the reason the tee shipped
   * ahead of everything that will list its output is that HKSV is a SINK: HAP
   * has no read-back, so a stream nobody teed is gone for good (D550). A
   * default of off would mean the feature did nothing until the operator
   * visited every camera, and the clips lost in between are unrecoverable.
   *
   * Off costs nothing and saves the disk and one thumbnail ffmpeg per clip; the
   * HomeKit recording itself is untouched either way.
   */
  readonly keepClips?: boolean
  /**
   * How many days this camera's kept clips survive. Absent = the global
   * default (`clipRetentionDays`), which ships at
   * {@link DEFAULT_CLIP_RETENTION_DAYS}. Resolved ONLY through
   * {@link resolveClipRetentionDays} so reset, unset and never-written are the
   * same value.
   */
  readonly clipRetentionDays?: number
}

/**
 * What an entry with no stored settings is read as — and what a camera
 * exported TODAY is built from. Exported so a spec can assert the one thing
 * that matters about it: it must resolve to NOT recording, or "off by default"
 * is true only for cameras exposed before the flip.
 */
export const DEFAULT_DEVICE_SETTINGS: ExportDeviceSettings = {
  streamPreference: 'auto',
}

/**
 * Whether this camera offers Apple's NEW camera service alongside the classic
 * one — `camera-multi-tier-rtp-stream-management` (0x8031), where HEVC and 4K
 * live.
 *
 * ABSENT MEANS ON, like `resolveHksvRecording` and for the same reason: a
 * camera exposed before this field existed must not silently lose it. Only an
 * explicit `false` turns it off.
 *
 * Safe as a default because the FALLBACK is the controller's own and it was
 * measured: iOS reads the new service's characteristics and, finding it
 * unusable, opens its session on the classic one two seconds later. Until the
 * negotiation is built we say `streaming-enabled: false`, so declining is the
 * only thing a controller can do with it.
 */
/**
 * Keep a copy of what we send HomeKit, for this camera.
 *
 * ABSENT MEANS ON, for the same reason as `resolveHksvRecording` and one
 * stronger: HKSV has no read-back, so every recording made while this said
 * "off by accident" is gone permanently. Only an explicit `false` turns it off.
 */
export function resolveKeepHomekitClips(
  settings: ExportDeviceSettings | null | undefined,
): boolean {
  return settings?.keepClips !== false
}

/** This addon's id, as the manifest declares it and the registry knows it. */
export const EXPORT_HAP_ADDON_ID = 'export-hap'

/**
 * The narrow view of a persisted exposure the clip source needs. Structural, so
 * the source and its spec do not need the whole config entry.
 */
export interface HksvCameraEntry {
  readonly mapperKind: MapperKind
  readonly settings?: ExportDeviceSettings
}

/**
 * Whether a camera HAS a HomeKit clip source, read from the authorities that
 * already own each half.
 *
 * The source exists because the camera is EXPORTED to HomeKit and HomeKit
 * RECORDING is on for it, and it goes away when either goes off (D550, D569 §
 * 5). There is no third switch: a knob of this source's own would be a second
 * authority over somebody else's decision (D62), and this function is the only
 * place the two are read together.
 *
 * `keepClips` is deliberately NOT part of existence. It governs the TEE, and
 * the clips already kept are still the truth about this camera — so the row
 * stays and says the copies are off, which is D62's other half: an off switch
 * is REPORTED off, never made to look like a broken camera.
 */
export function describeHksvCamera(
  entry: HksvCameraEntry | null,
  lastBuild: HksvBuildOutcome | null,
  homekitRecording: boolean | null,
): HksvCameraFacts {
  const isCamera = entry !== null && entry.mapperKind === 'camera'
  return {
    exported: isCamera,
    // HomeKit's own answer, or `null` when this camera was never offered
    // recording. Never a value of ours — see `hksv/recording-active.ts`.
    homekitRecording: isCamera ? homekitRecording : null,
    keepingClips: isCamera && resolveKeepHomekitClips(entry.settings),
    lastBuild,
  }
}

/** What ships, and what an unset global resolves to. */
export const DEFAULT_CLIP_RETENTION_DAYS = 14

/** The rails on the retention itself. Zero would silently disable the tee. */
const MIN_CLIP_RETENTION_DAYS = 1
const MAX_CLIP_RETENTION_DAYS = 365

/**
 * This camera's retention in days: per-device override → global default →
 * {@link DEFAULT_CLIP_RETENTION_DAYS}.
 *
 * The cascade rule the repo already pays for (`stationary-settings.ts`):
 * **reset == unset**. A cleared override and a key that was never written must
 * resolve to the same number, or the Reset button is a lie. A value outside the
 * rails is not stored as a lie either — it falls back rather than turning the
 * tee into a no-op (0 days) or an unbounded archive.
 */
export function resolveClipRetentionDays(
  settings: ExportDeviceSettings | null | undefined,
  globalDefaultDays: number,
): number {
  const fleet = clampRetentionDays(globalDefaultDays) ?? DEFAULT_CLIP_RETENTION_DAYS
  return clampRetentionDays(settings?.clipRetentionDays) ?? fleet
}

function clampRetentionDays(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_CLIP_RETENTION_DAYS) {
    return null
  }
  return Math.min(Math.floor(value), MAX_CLIP_RETENTION_DAYS)
}

export function resolveMultiTierService(
  settings: ExportDeviceSettings | null | undefined,
): boolean {
  // DEFAULT OFF, 2026-09-17. It shipped default-ON on the measurement that iOS
  // reads the service and falls back harmlessly. Then the operator's whole
  // HomeKit stopped working with it live, and the honest position is that a
  // structural change made to EVERY camera accessory is the first suspect for
  // a failure that affects every camera.
  //
  // The cause is not established -- duplicate `export-hap` runners were live
  // at the same time and are a sufficient explanation on their own. This flips
  // the default rather than deleting the work, so the two can be separated:
  // with it off the fleet is byte-for-byte the accessory that worked, and it
  // can be turned back on for ONE camera once the runner duplication is
  // understood.
  return settings?.multiTierService === true
}

// ── Stream preference options ────────────────────────────────────────
//
// One source-stream picker per exporter — Alexa and HomeKit share the
// list (Alexa's is in `export-alexa.addon.ts`). Options are the three
// camstack profile slots (`high`/`mid`/`low`) plus the smart `auto`
// default; native camStream ids are intentionally excluded to keep
// operator choices portable across camera swaps.

const HAP_STREAM_PREFERENCE_OPTIONS: readonly ConfigOption[] = [
  { value: 'auto', label: 'Auto (closest to 1080p)' },
  { value: 'high', label: 'High' },
  { value: 'mid', label: 'Mid' },
  { value: 'low', label: 'Low' },
]

interface ExposedConfigEntry {
  readonly deviceId: string
  readonly displayName: string
  readonly mapperKind: MapperKind
  readonly capabilities?: readonly string[]
  /**
   * UUIDs of every child accessory this exposure produced. Tracked so
   * `unexposeDevice` can remove children deterministically without
   * re-enumerating the parent's children at unexpose time (parent
   * device may already be gone). Empty on entries persisted by
   * Round 1 (motion-sensor-only) — those have no children.
   */
  readonly childAccessoryUuids?: readonly string[]
  /** Ms epoch — useful for diagnostic display. */
  readonly addedAt?: number
  /**
   * Per-device export settings (preferred stream, …). New entries get
   * defaults via `DEFAULT_DEVICE_SETTINGS`. Old entries persisted by
   * pre-settings releases default at read time.
   */
  readonly settings?: ExportDeviceSettings
}

/** One device's advertised HAP state, persisted in the addon store. JSON-plain
 *  mirror of `ExportTargetEntry` from `@camstack/types/node`. Keyed by
 *  `String(deviceId)` in `ExportHapConfig.exportSyncState`. `externalIds` holds
 *  the deterministic accessory UUID (diagnostic; rebuild uses the live mapper). */
export interface ExportTargetEntryJson {
  readonly fingerprint: string
  readonly externalIds: readonly string[]
}

interface ExportHapConfig {
  readonly bridgeName: string
  readonly fixedPin: string
  readonly interfaceName: string
  /**
   * Fleet default for how many days a kept HomeKit clip survives. Per camera
   * overridable; see {@link resolveClipRetentionDays}.
   */
  readonly clipRetentionDays: number
  /**
   * Persistent bridge identity — generated on first boot and reused
   * forever. Empty `username` is the "uninitialised" sentinel.
   */
  readonly identity: HapIdentity
  /**
   * Operator-curated list of devices to mirror onto the HAP bridge.
   * Hidden from the global settings form — managed via the cap's
   * `exposeDevice` / `unexposeDevice` methods only.
   */
  readonly exposed: readonly ExposedConfigEntry[]
  /**
   * Operator-curated list of ACTIONS published as momentary switches (D968).
   * Actions are list entries, not devices (D954): this is a list of its own,
   * managed by `exposeEntity` / `unexposeEntity` only.
   */
  readonly exposedActions: readonly ActionExportEntry[]
  /** Durable per-device export sync state — the Phase-C reconciler cache.
   *  Key = `String(deviceId)`, value = the device's export fingerprint at last
   *  attach. Drives `diffExportTargets`: an unchanged restart hashes to the same
   *  fingerprint → no rebuild. Replaces the old in-memory binding-shape guard. */
  readonly exportSyncState: Readonly<Record<string, ExportTargetEntryJson>>
}

/** Generic `device-export` setup block — pairing QR + copyable rows + note. */
type ExportSetup = z.infer<typeof ExportSetupSchema>

const EMPTY_IDENTITY: HapIdentity = { username: '', pincode: '', uuid: '' }

const DEFAULT_CONFIG: ExportHapConfig = {
  bridgeName: 'CamStack Bridge',
  fixedPin: '',
  interfaceName: '',
  clipRetentionDays: DEFAULT_CLIP_RETENTION_DAYS,
  identity: EMPTY_IDENTITY,
  exposed: [],
  exposedActions: [],
  exportSyncState: {},
}

interface DeviceManagerApi {
  readonly deviceManager?: {
    readonly getDevice: {
      query: (input: { deviceId: number }) => Promise<{
        readonly id: number
        readonly name: string
        readonly type: string
      } | null>
    }
  }
}

/** What this addon reads off a device record: its label, and the accessory
 *  shape its type implies. */
interface DeviceSummary {
  readonly name: string
  readonly type: string
}

// HAP-banned trivial pincodes (per spec).
const BANNED_PINCODES = new Set<string>([
  '000-00-000',
  '111-11-111',
  '222-22-222',
  '333-33-333',
  '444-44-444',
  '555-55-555',
  '666-66-666',
  '777-77-777',
  '888-88-888',
  '999-99-999',
  '123-45-678',
  '876-54-321',
])

const PINCODE_REGEX = /^\d{3}-\d{2}-\d{3}$/

function isValidPincode(pin: string): boolean {
  return PINCODE_REGEX.test(pin) && !BANNED_PINCODES.has(pin)
}

function generateUsername(): string {
  const bytes = randomBytes(6)
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':')
}

function generatePincode(): string {
  for (let i = 0; i < 50; i++) {
    let pin = ''
    const buf = randomBytes(8)
    for (let j = 0; j < 8; j++) pin += (buf[j]! % 10).toString()
    const formatted = `${pin.slice(0, 3)}-${pin.slice(3, 5)}-${pin.slice(5)}`
    if (!BANNED_PINCODES.has(formatted)) return formatted
  }
  // Statistically unreachable; throw rather than return a banned code.
  throw new Error('export-hap: failed to generate a non-trivial pincode')
}

function buildBridgeUuid(bridgeName: string): string {
  return HapUuid.generate(`camstack:bridge:${bridgeName}:${Date.now()}`)
}

export class ExportHapAddon extends BaseAddon<ExportHapConfig> {
  /** The bridge setup code pairs a controller: a credential, kept in the keychain (D787). */
  protected override readonly secretStatePaths = ['identity.pincode']
  private readonly exposed = new Map<string, Mapper>()
  /** The exported actions — switches beside the devices (D968). */
  private actionExports: ActionExports | null = null
  private lastError: string | undefined
  /** Shared HAP setup code applied to every published accessory. */
  private pincode = ''
  /** Optional mDNS/bind interface (config.interfaceName), or undefined. */
  private bind: string | undefined
  /**
   * What this PROCESS remembers about decode hardware, shared by every camera
   * mapper: the decoder addon's per-node reading (60 s), and the backend that
   * last died at init (60 s).
   *
   * Owned here rather than as a module global for the reason `HwAccelCache`
   * itself records — a module global outlives an addon respawn and survives an
   * operator changing the decoder backend. Owned here rather than per mapper
   * because the whole point is that camera B does not re-pay camera A's failed
   * hardware init.
   */
  private readonly decodeMemos: HapDecodeMemos = createHapDecodeMemos()
  /**
   * This node's PINNED ffmpeg (D540) — asked once, shared by every child this
   * addon spawns: live HomeKit streams, the HKSV prebuffer and the clip passes.
   * All three used to spawn a bare `'ffmpeg'`, the HOST's binary, while the
   * broker next to them ran ours. It rejects rather than naming PATH.
   */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())
  /**
   * Where HomeKit's own clips are kept.
   *
   * ONE per addon: HomeKit Secure Video is a SINK — HAP has no read-back, so a
   * clip is ours only if we kept a copy of what we SENT — and the copy has to
   * be pruned against bounds that span every camera, which a per-camera store
   * could not see. Created at boot rather than lazily so the directory's
   * failure to exist is one line at boot and not a surprise mid-recording.
   */
  private hksvClipStore: HksvClipStore | null = null
  /** Resolves the declared `homekitClips` location; the doorbell invalidates it. */
  private hksvClipLocation: HksvClipLocation | null = null
  /**
   * What `buildHksvRecording` decided per camera, in this process.
   *
   * A MIRROR of the build, written by it and read only to be REPORTED: the
   * clip source's `index-empty` ("the switch says record and the store holds
   * nothing") is only honest if it can name which refusal fired (D571).
   */
  private readonly hksvBuilds = new HksvBuildOutcomes()
  /** The clip byte + still routes. `null` until `onInitialize` has served them. */
  private hksvClipPlanes: HksvClipPlanes | null = null

  /**
   * THE bridge. Lazily created and published the first time a non-camera
   * accessory needs it; never torn down while the addon runs, because an
   * unpublish would drop a pairing the operator already entered a code for.
   */
  private bridgeHost: BridgeHost | null = null

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const identity = await this.ensureIdentity()
    this.pincode = identity.pincode
    this.bind = this.config.interfaceName || undefined
    this.bridgeHost = new BridgeHost({
      displayName: this.config.bridgeName,
      uuid: identity.uuid,
      pincode: identity.pincode,
      bind: this.bind,
      logger: this.ctx.logger,
    })

    try {
      // hap-nodejs library-internal pairing-state storage (one shared dir;
      // each accessory's AccessoryInfo is keyed by its derived username).
      await initHapStorage(path.join(this.ctx.dataDir, 'hap-store'))
    } catch (err) {
      this.lastError = errMsg(err)
      this.ctx.logger.error('export-hap: HAP storage init failed', {
        meta: { error: this.lastError },
      })
      // Keep going — the provider reports `linkState: 'error'`.
    }

    // WHERE the clips go: the declared `homekitClips` location, resolved
    // through the storage cap and never composed here. `local-path`, because
    // the tee does real `node:fs` I/O on it.
    this.hksvClipLocation = new HksvClipLocation({
      logger: this.ctx.logger.child('hksv-clips'),
      ports: createClipLocationPorts(this.ctx.api),
    })
    this.hksvClipStore = new HksvClipStore({
      logger: this.ctx.logger.child('hksv-clips'),
      resolveRoot: () => this.hksvClipLocation?.root() ?? Promise.resolve(null),
      // The operator's knob, cascaded here and read ONLY here: the store owns
      // no second copy of a camera's retention.
      maxAgeMsFor: (deviceId) =>
        resolveClipRetentionDays(
          this.findEntry(deviceId)?.settings,
          this.config.clipRetentionDays,
        ) *
        24 *
        60 *
        60 *
        1000,
      mintThumbnail: createClipThumbnailMinter({
        runner: createBoundedFfmpegRunner({
          // The node's pinned build (D540), the same resolver the live
          // streaming and recording paths use. One resolution per addon.
          resolveFfmpeg: this.pinnedFfmpeg,
          spawnFn: spawn,
          timeoutMs: CLIP_THUMBNAIL_TIMEOUT_MS,
        }),
      }),
      // The faststart pass. Its own, larger budget: this one rewrites the
      // whole file where the still decodes one frame, and the two deadlines
      // answer different questions.
      remuxClip: createClipRemuxer({
        runner: createBoundedFfmpegRunner({
          resolveFfmpeg: this.pinnedFfmpeg,
          spawnFn: spawn,
          timeoutMs: CLIP_REMUX_TIMEOUT_MS,
        }),
      }),
    })

    // The two clip routes. Bytes NEVER travel through a cap call (D9/D18): the
    // cap answers with a URL into these prefixes and this addon serves the
    // bytes itself, with `Range` on the media route so a player can ask for a
    // window. There is no cross-runner hand-off to build — the clips were
    // written by THIS process, to a `local-path` location, and the provider is
    // registered here (see `videoclips-source.ts`).
    //
    // Served HERE, in `onInitialize`, because the hub PULLS an addon's data
    // planes during the node-registration handshake: serving later misses the
    // pull and the route never registers.
    await this.serveHksvClipPlanes()

    // Sweep the persisted `exposed` list and drop entries whose
    // `mapperKind` no longer maps to a registered factory (legacy
    // entries written by an earlier shape of the addon, or entries
    // whose persist write was interrupted before the kind field
    // landed). Persist the cleaned list once so subsequent boots are
    // quiet — without this, the no-mapper warn keeps firing at every
    // restart even after every exposed device has been re-published.
    const validKinds = new Set<MapperKind>(SUPPORTED_MAPPER_KINDS)
    const cleaned = this.config.exposed.filter((entry) => {
      if (validKinds.has(entry.mapperKind)) return true
      this.ctx.logger
        .withTags({ deviceId: Number.parseInt(entry.deviceId, 10) })
        .info('export-hap: dropping stale exposed entry (unknown mapperKind)', {
          meta: { mapperKind: entry.mapperKind },
        })
      return false
    })
    if (cleaned.length !== this.config.exposed.length) {
      await this.updateGlobalSettings({ exposed: cleaned })
    }

    // Re-attach mappers for the surviving entries.
    for (const entry of cleaned) {
      const log = this.ctx.logger.withTags({
        deviceId: Number.parseInt(entry.deviceId, 10),
      })
      try {
        await this.attachMapper(entry)
        const numericId = Number.parseInt(entry.deviceId, 10)
        if (Number.isFinite(numericId)) {
          const fp = await this.computeExportFingerprint(numericId)
          if (fp !== null) await this.persistFingerprint(numericId, fp)
        }
      } catch (err) {
        log.warn('export-hap: failed to re-attach mapper on boot', {
          meta: { error: errMsg(err) },
        })
      }
    }

    this.actionExports = new ActionExports(
      {
        api: this.ctx.api,
        logger: this.ctx.logger,
        publish: async (accessory) => {
          const bridged = this.bridgeHost !== null && (await this.bridgeHost.add(accessory))
          if (bridged) return
          await publishStandalone(accessory, {
            pincode: this.pincode,
            port: 0,
            bind: this.bind,
            logger: this.ctx.logger,
          })
        },
        unpublish: async (accessory) => {
          if (this.bridgeHost?.holds(accessory) === true) {
            this.bridgeHost.remove(accessory)
            return
          }
          await unpublishAccessory(accessory, this.ctx.logger)
        },
        persist: (entries) => this.updateGlobalSettings({ exposedActions: [...entries] }),
      },
      this.config.exposedActions ?? [],
    )
    await this.actionExports.attachAll()
    // The operator may have deleted an action while this addon was down.
    await this.actionExports.reconcile()

    this.ctx.addDisposer(async () => {
      await this.actionExports?.dispose()
      await this.detachAll()
      // The bridge goes down with the process, and only with the process: it is
      // never unpublished while the addon runs, because an unpublish drops the
      // pairing the operator already entered a code for.
      await this.bridgeHost?.dispose()
    })

    // ── Reconcile on device lifecycle ────────────────────────────────
    // Vendor providers finish probing caps after our boot attach.
    // `DeviceProvisioned` fires once the persisted export shape lands or
    // changes; `DeviceReady` is the clean post-probe trigger (by the time it
    // fires `device.probed` has flipped true, so `computeExportFingerprint`
    // returns the now-full shape instead of the carried-forward persisted one).
    // Both reconcile per-device; an unchanged restart rebuilds nothing.
    this.subscribeDeviceProvisionedForReconcile()
    this.subscribeDeviceReadyForReconcile()
    this.subscribeStorageLocationsForClips()
    // Both subscriptions above schedule timers into the SHARED
    // `pendingRebuildTimers`; its teardown is owned once here, not
    // per-subscription.
    this.disposeSharedRebuildTimers()

    const provider: IDeviceExportProvider = {
      getStatus: async () => {
        const anyPaired = Array.from(this.exposed.values()).some((m) =>
          accessoryPaired(m.accessory),
        )
        const linkState: 'linked' | 'unlinked' | 'error' = this.lastError
          ? 'error'
          : anyPaired
            ? 'linked'
            : 'unlinked'
        const setup = this.buildSetupBlock()
        return {
          linkState,
          exposedDeviceCount: this.exposed.size,
          ...(this.lastError ? { error: this.lastError } : {}),
          ...(setup ? { setup } : {}),
        }
      },
      // A UI FILTER over `DeviceType`, and nothing else — the cap contract
      // says so and nothing enforces it on `exposeDevice`. Whether a device
      // publishes anything is decided by its bound capabilities: a camera's
      // orchestrator auto-detects motion, intercom, doorbell, PTZ and its
      // accessory children; every other type goes through the capability
      // table. See `mappers/kind.ts` for why the list stops where it does.
      listSupportedDeviceKinds: async () => [...HAP_EXPORTABLE_DEVICE_TYPES],
      listExposedDevices: async () =>
        Array.from(this.exposed.entries()).map(([deviceId, m]) => {
          const entry = this.config.exposed.find((e) => e.deviceId === deviceId)
          return {
            deviceId,
            exposedAs: m.accessory.displayName,
            ...(entry?.capabilities ? { capabilities: [...entry.capabilities] } : {}),
          }
        }),
      exposeDevice: async ({ deviceId, capabilities }) => this.exposeDevice(deviceId, capabilities),
      unexposeDevice: async ({ deviceId }) => this.unexposeDevice(deviceId),
      // ── Entities beside devices (D968): actions only, as momentary switches.
      listSupportedEntityKinds: async () => ['device', 'action'],
      listExposedEntities: async () => {
        await this.actionExports?.reconcile()
        return [
          ...Array.from(this.exposed.entries()).map(([deviceId, m]) => ({
            entity: { kind: 'device' as const, deviceId },
            exposedAs: m.accessory.displayName,
          })),
          ...(this.actionExports?.list() ?? []),
        ]
      },
      exposeEntity: async ({ entity }) => {
        if (entity.kind === 'device') return this.exposeDevice(entity.deviceId)
        if (entity.kind === 'action') return this.requireActionExports().expose(entity.actionId)
        throw new Error('export-hap: a notification target cannot be exported to HomeKit')
      },
      unexposeEntity: async ({ entity }) => {
        if (entity.kind === 'device') return this.unexposeDevice(entity.deviceId)
        if (entity.kind === 'action') return this.requireActionExports().unexpose(entity.actionId)
        throw new Error('export-hap: a notification target cannot be exported to HomeKit')
      },
      // ── DeviceSettingsContribution surface ─────────────────────────
      getDeviceSettingsContribution: (input) =>
        this.buildDeviceSettingsContribution(input.deviceId),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: (input) =>
        this.applyDeviceSettingsPatch(input.deviceId, input.patch),
    }

    // ── The HomeKit clips, as a `videoclips` SOURCE (D571) ──────────────
    //
    // Registered HERE and not anywhere else, because the store is here: the
    // teed clips are files this hub-only process wrote to a `local-path`
    // location, and `videoclips` is a device-scoped COLLECTION wrapper, so an
    // addon declaring it becomes one of every camera's bindings without owning
    // the device. A camera that is not exported to HomeKit — or has HomeKit
    // recording off — gets `[]` from `listSources`, which is cheap and honest.
    //
    // Registered unconditionally, for the same reason the tee is: the gate is
    // per camera and is re-read on every call, so there is no boot-order
    // question to get wrong.
    const clipsProvider = createHksvVideoclipsProvider({
      logger: this.ctx.logger.child('hksv-clips'),
      addonId: EXPORT_HAP_ADDON_ID,
      describeCamera: (deviceId) =>
        describeHksvCamera(
          this.findEntry(deviceId),
          this.hksvBuilds.lastFor(deviceId),
          // Read from the published accessory at call time: the characteristic
          // IS the state, and there is no second copy to go stale.
          readHomekitRecordingActive(this.exposed.get(String(deviceId))?.accessories ?? []),
        ),
      readCatalog: async (deviceId) =>
        (await this.hksvClipStore?.listCatalog(deviceId)) ?? { kind: 'no-root' },
      // The ONE module that interprets a storage location's mode (D385) is
      // also the one that says why there is no root.
      locationRefusal: () => this.hksvClipLocation?.lastRefusal ?? null,
      mediaUrl: (deviceId, stem) => this.hksvClipUrl('media', deviceId, stem),
      thumbnailUrl: (deviceId, stem) => this.hksvClipUrl('thumb', deviceId, stem),
      // The inline read (D558) reaches the same file the route streams, through
      // the store's own layout — nothing else composes a path into the clips
      // location.
      clipFilePath: async (deviceId, stem) =>
        (await this.hksvClipStore?.artifactPath(deviceId, stem, 'clip')) ?? null,
    })

    return [
      { capability: deviceExportCapability, provider },
      { capability: videoclipsCapability, provider: clipsProvider },
    ]
  }

  protected async onConfigChanged(): Promise<void> {
    // Bridge identity is persisted in `this.config.identity` — changing
    // bridge name / port / pin requires a restart. Those fields are
    // flagged `requiresRestart: true` so BaseAddon's auto-restart kicks
    // in when they change. Also: if the operator typed a fixedPin we
    // honour it by patching the persisted identity below (still on the
    // next restart, since the bridge is already running with the old
    // pin). Nothing to do here today beyond that.
    if (
      this.config.fixedPin &&
      isValidPincode(this.config.fixedPin) &&
      this.config.identity.pincode !== this.config.fixedPin &&
      this.config.identity.username !== ''
    ) {
      const updated: HapIdentity = {
        username: this.config.identity.username,
        uuid: this.config.identity.uuid,
        pincode: this.config.fixedPin,
      }
      await this.updateGlobalSettings({ identity: updated })
    }
  }

  // ── Identity bootstrap ─────────────────────────────────────────

  /**
   * Resolve the persistent bridge identity. Empty `username` is the
   * "first boot" sentinel — generate fresh + persist. On subsequent
   * boots the persisted record is reused. An operator-supplied
   * `fixedPin` overrides the persisted pincode (useful for CI replay)
   * but never the username/uuid (those drive the iOS pairing record).
   */
  private async ensureIdentity(): Promise<HapIdentity> {
    const current = this.config.identity
    const fixedPin =
      this.config.fixedPin && isValidPincode(this.config.fixedPin) ? this.config.fixedPin : null

    if (current.username !== '' && current.uuid !== '' && current.pincode !== '') {
      // Already initialised.
      if (fixedPin && fixedPin !== current.pincode) {
        const updated: HapIdentity = {
          username: current.username,
          uuid: current.uuid,
          pincode: fixedPin,
        }
        await this.updateGlobalSettings({ identity: updated })
        return updated
      }
      return current
    }

    const fresh: HapIdentity = {
      username: generateUsername(),
      pincode: fixedPin ?? generatePincode(),
      uuid: buildBridgeUuid(this.config.bridgeName),
    }
    await this.updateGlobalSettings({ identity: fresh })
    this.ctx.logger.info('export-hap: generated bridge identity on first boot', {
      meta: { username: fresh.username },
    })
    return fresh
  }

  // ── Export setup block ──────────────────────────────────────────

  /**
   * Build the generic `device-export` `setup` block surfaced via
   * `getStatus` and rendered by the shared `DeviceExportPanel`: the
   * `X-HM://…` setup URI as a scannable QR, the 8-digit setup code as
   * a copyable field, and a short pairing instruction. Returns `null`
   * until the bridge has booted and produced both values.
   */
  private buildSetupBlock(): ExportSetup | null {
    const setupCode = this.config.identity.pincode
    if (!setupCode) return null
    const qr = firstExposedAccessorySetupUri(this.exposed, this.ctx.logger)
    return {
      ...(qr !== undefined ? { qr } : {}),
      fields: [{ label: 'Setup code (all cameras)', value: setupCode }],
      note:
        qr !== undefined
          ? 'Scan the QR with the iOS Camera app to pair the first exposed camera. Add additional cameras from iOS Home → + → Add Accessory; the setup code above applies to all of them.'
          : 'Each exposed camera is published as its OWN HomeKit accessory (cameras cannot be bridged). In the iOS Home app, tap + → Add Accessory: each exposed camera appears separately by name; add each one and enter this same setup code.',
    }
  }

  // ── Provider methods ────────────────────────────────────────────

  /**
   * @param settings Settings to build the accessory WITH.
   *
   * Needed because the only path a per-camera settings change takes is
   * `unexposeDevice` then `exposeDevice`, and the unexpose deletes the stored
   * entry — so `carryForward` below has nothing to carry and the accessory is
   * rebuilt on the DEFAULTS. Persisting the value afterwards is not enough:
   * the mapper, and with it the advertised resolution list, is already built.
   * Measured 2026-09-17 — the stored value read `mid` while the advertisement
   * still said `streamPreference=auto`.
   */
  private async exposeDevice(
    deviceId: string,
    capabilities?: readonly string[],
    settings?: ExportDeviceSettings,
  ): Promise<void> {
    const numericId = Number.parseInt(deviceId, 10)
    const log = this.ctx.logger.withTags({ deviceId: numericId })
    if (this.exposed.has(deviceId)) {
      log.debug('export-hap: device already exposed — refreshing capabilities')
      // Idempotent re-expose: detach then re-attach so capability
      // changes flow through to the mapper.
      await this.detachMapper(deviceId)
    }

    // The device's TYPE picks the accessory shape; its CAPABILITIES decide what
    // the shape publishes. `capabilities` here is the operator-supplied filter
    // on the cap method and is usually absent — it has never been the coverage
    // signal, and reading it as one is what made every device a camera.
    const summary = await this.fetchDeviceSummary(numericId)
    const mapperKind = pickMapperKind(summary?.type)
    if (!mapperKind) {
      throw new Error(
        `export-hap: device ${numericId} has type '${summary?.type ?? 'unknown'}', which HomeKit ` +
          `export does not support`,
      )
    }

    const displayName = summary?.name ?? `Device ${deviceId}`
    // A re-expose rebuilds this object and then REPLACES the stored one, so
    // anything not mentioned here is destroyed. The per-camera settings were
    // never mentioned: the operator's `streamPreference` pin was written, then
    // dropped between the write and the rebuild, and the accessory came back
    // advertising the DEFAULT. The selector only ever worked after a full
    // addon restart, when settings loaded before the first expose.
    const previous = this.config.exposed.find((e) => e.deviceId === deviceId)
    const rebuilt: ExposedConfigEntry = {
      deviceId,
      displayName,
      mapperKind,
      addedAt: previous?.addedAt ?? Date.now(),
      ...(capabilities ? { capabilities: [...capabilities] } : {}),
    }
    const seeded: ExposedConfigEntry = settings === undefined ? rebuilt : { ...rebuilt, settings }
    const baseEntry: ExposedConfigEntry = carryForward(seeded, previous, [
      'settings',
      'capabilities',
    ])
    const attached = await this.attachMapper(baseEntry)
    const finalEntry: ExposedConfigEntry = {
      ...baseEntry,
      childAccessoryUuids: attached.childAccessoryUuids,
    }
    const next = this.config.exposed.filter((e) => e.deviceId !== deviceId)
    next.push(finalEntry)
    await this.updateGlobalSettings({ exposed: next })
    if (Number.isFinite(numericId)) {
      const fp = await this.computeExportFingerprint(numericId)
      if (fp !== null) await this.persistFingerprint(numericId, fp)
    }
    log.info('export-hap: exposed device', {
      meta: {
        displayName,
        mapperKind,
        childCount: attached.childAccessoryUuids.length,
      },
    })
  }

  private async unexposeDevice(
    deviceId: string,
    options: { readonly clearPairing?: boolean } = {},
  ): Promise<void> {
    const numericId = Number.parseInt(deviceId, 10)
    const log = this.ctx.logger.withTags({ deviceId: numericId })
    // Read the entry BEFORE it is filtered out: the accessory uuid to clear
    // depends on which shape published it, and by the time the pairing wipe
    // runs both the entry and the mapper are gone.
    const mapperKind = this.findEntry(numericId)?.mapperKind ?? 'camera'
    await this.detachMapper(deviceId)
    const next = this.config.exposed.filter((e) => e.deviceId !== deviceId)
    if (next.length !== this.config.exposed.length) {
      await this.updateGlobalSettings({ exposed: next })
    }
    // Wipe hap-nodejs's persisted pairing for this camera. Without this,
    // iOS's "Remove Accessory" (issued while our HAP server was down or
    // unreachable) leaves the `pairedClients` state on disk AND inside
    // node-persist's in-memory cache, so the next publish would advertise
    // `sf=0` — iOS Home then refuses to show the camera in "Add
    // Accessory". The accessory UUID is derived deterministically from
    // the camstack device id (see `buildCameraAccessory`), so we can
    // recompute it here without touching the now-disposed mapper.
    //
    // But ONLY when the camera is genuinely being withdrawn. A settings change
    // re-attaches the same accessory, and wiping the pairing there makes the
    // camera vanish from the Home app and demand a fresh pairing code — for
    // changing a dropdown. The operator hit exactly that.
    if (options.clearPairing !== false) {
      clearPairingFiles(accessoryUuidFor(mapperKind, numericId), this.ctx.logger)
    }
    await this.forgetFingerprint(numericId)
    // The build verdict was a fact about a camera HomeKit had; it is not a
    // fact about one it does not.
    this.hksvBuilds.forget(numericId)
    log.info('export-hap: unexposed device')
  }

  // ── Mapper management ───────────────────────────────────────────

  private async attachMapper(
    entry: ExposedConfigEntry,
  ): Promise<{ childAccessoryUuids: readonly string[] }> {
    const factory = getMapperFactory(entry.mapperKind)
    const entrySettings = entry.settings ?? DEFAULT_DEVICE_SETTINGS
    const mapper = await factory({
      ctx: this.ctx,
      deviceId: entry.deviceId,
      displayName: entry.displayName,
      options: {
        decodeMemos: this.decodeMemos,
        resolveFfmpeg: this.pinnedFfmpeg,
        hksvClipStore: this.hksvClipStore,
        // The build writes its verdict where the clip source can report it.
        noteHksvOutcome: (outcome) => {
          this.hksvBuilds.note(outcome)
        },
        hapDeviceSettings: {
          streamPreference: entrySettings.streamPreference ?? 'auto',
          keepHomekitClips: resolveKeepHomekitClips(entrySettings),
          // Apple's new camera service, per camera. Absent means ON.
          multiTierService: resolveMultiTierService(entrySettings),
          // Absent means ON, like every other switch whose field postdates the
          // entries it governs.
          allowTranscode: entrySettings.allowTranscode !== false,
        },
      },
    })
    // A CAMERA is published STANDALONE — HomeKit cannot bridge one. Round 3
    // collapsed accessory children (siren / floodlight / spotlight) into
    // Services on this same Accessory, so `mapper.accessories` carries exactly
    // one entry: a single mDNS service / HAP port covers the whole device tree.
    //
    // Everything else goes on the BRIDGE by default — one advertisement, one
    // connection, one pairing for the whole fleet of switches, sensors, locks
    // and alarm panels. `shouldBridge` is the one place that decides, and it
    // refuses a camera whatever the entry stores. A bridge with no room falls
    // back to standalone rather than refusing the device.
    const wantsBridge = shouldBridge({
      mapperKind: entry.mapperKind,
      useBridge: entry.settings?.useBridge,
    })
    for (const accessory of mapper.accessories) {
      const bridged =
        wantsBridge && this.bridgeHost !== null && (await this.bridgeHost.add(accessory))
      if (bridged) continue
      await publishStandalone(accessory, {
        pincode: this.pincode,
        port: 0,
        bind: this.bind,
        logger: this.ctx.logger,
      })
    }
    this.exposed.set(entry.deviceId, mapper)
    // `childAccessoryUuids` is now vestigial — kept on the persisted
    // shape so old entries from Round 2 (when children were
    // standalone) still round-trip without a migration. Always empty
    // for fresh entries.
    return { childAccessoryUuids: [] as readonly string[] }
  }

  private async detachMapper(deviceId: string): Promise<void> {
    // Cancel any pending reconcile timer first — even when the mapper instance
    // is absent (boot reattach failed) — so a debounced reconcile can't fire
    // and republish a device we've just torn down. (Belt-and-suspenders:
    // reconcileDevice also re-checks findEntry before acting.)
    const pendingTimer = this.pendingRebuildTimers.get(deviceId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.pendingRebuildTimers.delete(deviceId)
    }
    const mapper = this.exposed.get(deviceId)
    if (!mapper) {
      // Mapper instance gone (boot reattach failed) — nothing for the
      // bridge to remove. The persisted `childAccessoryUuids` are
      // kept for diagnostics only; HAP serialisation reuses them on
      // the next successful re-attach.
      return
    }
    this.exposed.delete(deviceId)
    for (const accessory of mapper.accessories) {
      // A BRIDGED accessory has no server of its own: taking it off the bridge
      // is the whole of the teardown, and calling `unpublish` on it would be a
      // no-op at best. Asking the bridge rather than re-deriving the decision
      // means a device whose flag changed between attach and detach is still
      // removed from wherever it actually went.
      if (this.bridgeHost?.holds(accessory) === true) {
        this.bridgeHost.remove(accessory)
        continue
      }
      await unpublishAccessory(accessory, this.ctx.logger)
    }
    await mapper.dispose().catch((err: unknown) => {
      this.ctx.logger
        .withTags({ deviceId: Number.parseInt(deviceId, 10) })
        .warn('export-hap: mapper dispose failed', {
          meta: { error: errMsg(err) },
        })
    })
  }

  private requireActionExports(): ActionExports {
    if (this.actionExports === null) throw new Error('export-hap: addon is not initialised')
    return this.actionExports
  }

  private async detachAll(): Promise<void> {
    const ids = Array.from(this.exposed.keys())
    for (const id of ids) {
      await this.detachMapper(id)
    }
  }

  /** Pending rebuild timers per deviceId — used to debounce. Cleared
   *  on detach so stale timers can't republish a removed accessory. */
  private readonly pendingRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Deterministic HAP accessory UUID for a device — the same one the
   *  orchestrator built it with (`mappers/kind.ts`). */
  private hapAccessoryUuid(deviceId: number): string {
    return accessoryUuidFor(this.findEntry(deviceId)?.mapperKind ?? 'camera', deviceId)
  }

  /**
   * Export fingerprint of a device from its PERSISTED features + type
   * (`canonicalDeviceFingerprint`). Returns `null` on a transient API error or
   * a device not yet in the registry — the caller then leaves the current
   * accessory untouched (safer than tearing it down on incomplete info).
   *
   * Gated on `device.probed`: while a device's initial feature-probe has NOT
   * completed, its FRESH shape is partial (probe-gated caps — PTZ / intercom —
   * land a few seconds later). Returning the partial fingerprint would make
   * `reconcileDevice` detach + re-attach the accessory on restart (Apple emits
   * a "discovered" notification), then rebuild AGAIN once the probe lands.
   * `resolveExportFingerprint` carries the persisted (last-advertised)
   * fingerprint forward for an un-probed device so the reconcile sees NO change.
   * A brand-new un-probed device with no persisted entry falls back to its
   * fresh fingerprint (publishes once, acceptable).
   */
  protected async computeExportFingerprint(deviceId: number): Promise<string | null> {
    try {
      const device = await this.ctx.api.deviceManager.getDevice.query({
        deviceId,
      })
      if (!device) return null
      const fresh = canonicalDeviceFingerprint({
        deviceId,
        deviceType: device.type,
        features: device.features,
      })
      const persisted = syncStateFromJson(this.config.exportSyncState).get(deviceId)?.fingerprint
      // Whether the camera can be RECORDED is part of what the accessory
      // advertises, so it belongs in the fingerprint: a camera whose RTSP
      // profiles were unreadable when the accessory was built was refused HKSV
      // for ever, because nothing that moved afterwards was described here
      // (592, 2026-09-21). See `hksv/recordability-token.ts`.
      const withToken = withRecordabilityToken({
        base: fresh,
        token: await this.readRecordabilityToken(deviceId, device.type),
        persisted,
      })
      // Absent `probed` (record from an older device-manager build) → treat as
      // not-ready → carry forward; never advertise a partial shape.
      return resolveExportFingerprint({
        ready: device.probed ?? false,
        fresh: withToken,
        persisted,
      })
    } catch {
      return null
    }
  }

  /**
   * The slot HKSV would record this camera from, for the fingerprint.
   *
   * `null` — do not move the fingerprint — for anything that is not a camera
   * (a switch has no recording decision, and stamping a constant on it would
   * republish every non-camera accessory once for nothing) and for a camera
   * whose profiles could not be read right now.
   */
  private async readRecordabilityToken(
    deviceId: number,
    type: DeviceType | undefined,
  ): Promise<string | null> {
    if (pickMapperKind(type) !== 'camera') return null
    try {
      const proxy = await this.ctx.fetchDevice(deviceId)
      const entries = await proxy.cameraStreams?.getProfileRtspEntries({})
      return recordabilityTokenFor({
        allowTranscode: this.findEntry(deviceId)?.settings?.allowTranscode !== false,
        entries: entries ?? null,
      })
    } catch {
      return null
    }
  }

  /** Persist a device's current export fingerprint into `exportSyncState`
   *  (best-effort; called after a successful attach). */
  private async persistFingerprint(deviceId: number, fingerprint: string): Promise<void> {
    const state = syncStateFromJson(this.config.exportSyncState)
    state.set(deviceId, {
      fingerprint,
      externalIds: [this.hapAccessoryUuid(deviceId)],
    })
    await this.updateGlobalSettings({
      exportSyncState: syncStateToJson(state),
    })
  }

  /** Drop a device's `exportSyncState` entry (on unexpose). */
  private async forgetFingerprint(deviceId: number): Promise<void> {
    const state = syncStateFromJson(this.config.exportSyncState)
    if (!state.has(deviceId)) return
    state.delete(deviceId)
    await this.updateGlobalSettings({
      exportSyncState: syncStateToJson(state),
    })
  }

  /**
   * Subscribe to a device-lifecycle event category and reconcile the exposed
   * device whose id the event carries. Debounced 500 ms per device so a boot
   * burst (across both subscribed categories) collapses to one reconcile. The
   * per-device `device.probed` gate in `computeExportFingerprint` decides
   * whether the reconcile actually rebuilds anything. Shared by the two
   * triggers below.
   */
  /**
   * The clips location moved. A DOORBELL, not a payload: the event names which
   * row changed and the re-read is the authority (`StorageLocationsChangedPayload`
   * says so itself). Dropping the mirror is all this does — the next clip
   * resolves it again, and a missed event self-heals on the revalidation
   * window, so nothing here gates on a fallible read (D49).
   */
  private subscribeStorageLocationsForClips(): void {
    const unsubscribe = this.ctx.eventBus.subscribe(
      { category: EventCategory.StorageLocationsChanged },
      () => {
        this.hksvClipLocation?.invalidate()
      },
    )
    this.ctx.addDisposer(async () => {
      unsubscribe()
    })
  }

  private subscribeDeviceLifecycleForReconcile(category: EventCategory): void {
    const unsubscribe = this.ctx.eventBus.subscribe({ category }, (event) => {
      const data = event.data as { deviceId?: unknown } | null
      const deviceIdNumeric = typeof data?.deviceId === 'number' ? data.deviceId : null
      if (deviceIdNumeric === null) return
      const deviceId = String(deviceIdNumeric)
      if (!this.findEntry(deviceIdNumeric)) return // not exposed for HAP
      const existing = this.pendingRebuildTimers.get(deviceId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        this.pendingRebuildTimers.delete(deviceId)
        void this.reconcileDevice(deviceId)
      }, 500)
      if (typeof timer.unref === 'function') timer.unref()
      this.pendingRebuildTimers.set(deviceId, timer)
    })
    // This disposer owns ONLY its own subscription. The shared
    // `pendingRebuildTimers` map is written by BOTH the DeviceProvisioned and
    // the DeviceReady subscription, so its cleanup is registered once by
    // `disposeSharedRebuildTimers` (from `onInitialize`) rather than tied to —
    // and run redundantly per — each per-category subscription's disposer.
    this.ctx.addDisposer(async () => {
      unsubscribe()
    })
  }

  /**
   * Register the SINGLE owner of the shared rebuild-timer cleanup. Called once
   * from `onInitialize`. The per-category lifecycle subscriptions schedule
   * per-device timers into `pendingRebuildTimers` but never clear the map on
   * their own teardown — that shared resource is cleared here, exactly once, on
   * shutdown.
   */
  private disposeSharedRebuildTimers(): void {
    this.ctx.addDisposer(async () => {
      for (const timer of this.pendingRebuildTimers.values()) clearTimeout(timer)
      this.pendingRebuildTimers.clear()
    })
  }

  /**
   * Subscribe to `DeviceProvisioned` and reconcile an exposed device whenever
   * its persisted export shape changes. `DeviceProvisioned` is gated by
   * device-manager (fires ONLY on first registration or a real fingerprint
   * change), so this replaces the chatty per-cap `DeviceBindingsChanged`
   * subscription — an unchanged restart no longer rebuilds any accessory.
   * Covers a genuine shape change after the probe.
   */
  private subscribeDeviceProvisionedForReconcile(): void {
    this.subscribeDeviceLifecycleForReconcile(EventCategory.DeviceProvisioned)
  }

  /**
   * Subscribe to `DeviceReady` — fired once a device's initial feature-probe
   * completes — and reconcile. This is the CLEAN post-probe trigger: by the
   * time it fires, `device.probed` has flipped true, so the reconcile builds
   * the device's now-full (no longer carried-forward) shape.
   */
  protected subscribeDeviceReadyForReconcile(): void {
    this.subscribeDeviceLifecycleForReconcile(EventCategory.DeviceReady)
  }

  /**
   * Reconcile one exposed device against its persisted export fingerprint.
   *   - fingerprint unchanged → no-op (the storm-killer: a respawn's binding
   *     churn no longer rebuilds the accessory),
   *   - exposed but not attached (boot re-attach failed) → attach,
   *   - fingerprint changed → detach + re-attach (documented structural
   *     unpublish+republish fallback) and persist the new fingerprint.
   * Errors are logged and swallowed — a failed reconcile leaves the prior
   * accessory up, which is strictly better than removing it.
   */
  protected async reconcileDevice(deviceId: string): Promise<void> {
    const numericId = Number.parseInt(deviceId, 10)
    if (!Number.isFinite(numericId)) return
    const entry = this.findEntry(numericId)
    if (!entry) return
    const log = this.ctx.logger.withTags({ deviceId: numericId })

    const current = await this.computeExportFingerprint(numericId)
    if (current === null) {
      log.debug('export-hap: reconcile skipped — fingerprint unavailable (transient)')
      return
    }
    const last = syncStateFromJson(this.config.exportSyncState).get(numericId)

    if (last?.fingerprint === current) {
      if (!this.exposed.has(deviceId)) {
        // Exposed in config but not attached (boot re-attach failed earlier) —
        // attach now; shape is unchanged so this is a first publish, not churn.
        try {
          await this.attachMapper(entry)
          await this.persistFingerprint(numericId, current)
        } catch (err) {
          log.warn('export-hap: reconcile attach failed', {
            meta: { error: errMsg(err) },
          })
        }
      } else {
        log.debug('export-hap: reconcile — fingerprint unchanged, no rebuild', {
          meta: { hashPrefix: current.slice(0, 12) },
        })
      }
      return
    }

    log.info('export-hap: reconciling accessory — export shape changed', {
      meta: {
        from: last?.fingerprint?.slice(0, 12) ?? 'none',
        to: current.slice(0, 12),
      },
    })
    try {
      await this.detachMapper(deviceId)
      await this.attachMapper(entry)
      await this.persistFingerprint(numericId, current)
    } catch (err) {
      log.warn('export-hap: reconcile rebuild failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * The device's name and type, or `null` when the registry cannot answer.
   *
   * `null` is NOT "no such device" — it also covers a transient API failure,
   * and every caller treats it as "keep doing what was already being done"
   * rather than re-shaping an exposed accessory on incomplete information.
   */
  private async fetchDeviceSummary(deviceId: number): Promise<DeviceSummary | null> {
    if (!Number.isFinite(deviceId)) return null
    try {
      const api: DeviceManagerApi = this.ctx.api
      const device = await api.deviceManager?.getDevice.query({ deviceId })
      if (!device) return null
      return { name: device.name, type: device.type }
    } catch (err) {
      this.ctx.logger.withTags({ deviceId }).debug('export-hap: deviceManager.getDevice failed', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Which accessory shape this device would get, or `null` for "no Export tab".
   *
   * Two questions, in this order, because they fail differently:
   *  1. the TYPE — a type with no orchestrator is refused outright;
   *  2. for a non-camera, the CAPABILITIES — a device carrying nothing the
   *     table maps would publish an accessory that pairs and does nothing, and
   *     the operator cannot tell that from a broken integration.
   *
   * A camera skips (2): the camera orchestrator has always published on type
   * alone, and adding a cap gate here would be a new way for an existing camera
   * to lose its Export tab. A registry that cannot answer at all also resolves
   * to `camera`, which is what every persisted entry predating this method
   * carries.
   */
  private async resolveExportKind(deviceId: number): Promise<MapperKind | null> {
    const summary = await this.fetchDeviceSummary(deviceId)
    const kind = pickMapperKind(summary?.type)
    if (kind === null) return null
    if (kind === 'camera') return 'camera'

    try {
      const proxy = await this.ctx.fetchDevice(deviceId)
      const capNames = new Set(proxy.binding?.entries.map((entry) => entry.capName) ?? [])
      if (rowsForCaps(capNames).length > 0) return 'generic'
      this.ctx.logger.withTags({ deviceId }).debug('export-hap: no Export tab — no mapped caps', {
        meta: { type: summary?.type, caps: [...capNames].toSorted().join(',') },
      })
      return null
    } catch (err) {
      this.ctx.logger
        .withTags({ deviceId })
        .debug('export-hap: no Export tab — capability read failed', {
          meta: { type: summary?.type, error: errMsg(err) },
        })
      return null
    }
  }

  // ── Settings UI ─────────────────────────────────────────────────

  protected globalSettingsSchema() {
    // Pairing info (setup code + `X-HM://…` URI + scannable QR) is
    // surfaced through the `device-export` cap's `setup` block and
    // rendered by the shared `DeviceExportPanel` — see `buildSetupBlock`.
    // The settings form holds only the editable bridge knobs.
    return this.schema({
      sections: [
        {
          id: 'export-hap',
          title: 'HomeKit Export',
          description:
            'Publishes each exposed device as its own HomeKit accessory, sharing one setup code. Mark a device "Expose to HomeKit" on its settings page, then add it in the iOS Home app (+ → Add Accessory) and enter the setup code shown there.',
          columns: 1,
          fields: [
            this.field({
              type: 'text',
              key: 'bridgeName',
              label: 'Installation name',
              description:
                'The name of the shared bridge that carries every exposed device that is not a camera (switches, sensors, locks, alarm panels) — what iOS Home lists under Add Accessory. Cameras are never bridged: each one is published as its own accessory under its device name. Set it before you add the bridge in iOS Home.',
              default: DEFAULT_CONFIG.bridgeName,
              requiresRestart: true,
              placement: { tab: 'advanced' },
            }),
            this.field({
              type: 'text',
              key: 'fixedPin',
              // The setup code pairs a controller with the bridge: a secret,
              // declared as one (D783) — withheld from non-admin reads.
              secret: true,
              label: 'Fixed setup code (XXX-XX-XXX)',
              description:
                'Optional. Leave blank to use the auto-generated code persisted on first boot. Useful for CI replay.',
              default: DEFAULT_CONFIG.fixedPin,
              requiresRestart: true,
              placement: { tab: 'advanced' },
            }),
            this.field({
              type: 'text',
              key: 'interfaceName',
              label: 'Network interface',
              description:
                'Optional. Restrict mDNS advertisement and HAP bind to a specific interface (e.g. "en0"). Leave blank to advertise on all interfaces.',
              default: DEFAULT_CONFIG.interfaceName,
              requiresRestart: true,
              placement: { tab: 'advanced' },
            }),
            this.field({
              type: 'number',
              key: 'clipRetentionDays',
              label: 'Keep HomeKit clips for (days)',
              description:
                'CamStack keeps its own copy of every clip it sends to HomeKit Secure Video — HomeKit itself never gives one back. This is the fleet default; each camera can override it, and each can switch the copies off entirely. Clips are also capped at 200 per camera, 512 MB per camera and 4 GB overall — whichever limit is reached first wins, and the log names which one.',
              default: DEFAULT_CONFIG.clipRetentionDays,
              placement: { tab: 'advanced' },
            }),
          ],
        },
      ],
    })
  }

  // ── Device-details contribution ─────────────────────────────────
  //
  // Each export addon contributes a per-device "Export" panel that the
  // device-details page renders inline. The panel renders for any device
  // `resolveExportKind` can build an accessory for; the streaming fields below
  // are the only camera-shaped part of it.

  private async buildDeviceSettingsContribution(
    deviceId: number,
  ): Promise<ConfigUISchemaWithValues | null> {
    const kind = await this.resolveExportKind(deviceId)
    if (kind === null) return null
    const entry = this.findEntry(deviceId)
    const settings = entry?.settings ?? DEFAULT_DEVICE_SETTINGS
    const enabled = entry !== null
    // Field keys are namespaced per exporter — the device-aggregate form
    // flattens fields by `key` across sections, so a generic `'enabled'`
    // / `'streamPreference'` would collide with Alexa's same-named fields.
    // Last-writer-wins meant the HomeKit switch rendered Alexa's value
    // (and HomeKit toggles routed to Alexa's writer). Namespacing keeps
    // each exporter's form state isolated.
    const enabledKey = `hap:${deviceId}:enabled`
    const streamPreferenceKey = `hap:${deviceId}:streamPreference`
    const multiTierKey = `hap:${deviceId}:multiTierService`
    const useBridgeKey = `hap:${deviceId}:useBridge`
    const allowTranscodeKey = `hap:${deviceId}:allowTranscode`
    const keepClipsKey = `hap:${deviceId}:keepClips`
    const clipRetentionKey = `hap:${deviceId}:clipRetentionDays`
    const mapper = this.exposed.get(String(deviceId)) ?? null
    const paired = mapper ? accessoryPaired(mapper.accessory) : false
    const bridged = mapper !== null && this.bridgeHost?.holds(mapper.accessory) === true
    const name = entry?.displayName ?? `Device ${deviceId}`
    // A bridged device is not separately pairable: the operator adds the BRIDGE
    // once and every device on it appears. Telling them to look for this
    // device's own name in "Add Accessory" would send them hunting for a tile
    // that does not exist.
    const bridgePaired =
      this.bridgeHost?.accessory !== null && this.bridgeHost?.accessory !== undefined
        ? accessoryPaired(this.bridgeHost.accessory)
        : false
    const statusLabel = !enabled
      ? 'Not exposed'
      : bridged
        ? bridgePaired
          ? `On the “${this.config.bridgeName}” bridge, as “${name}”`
          : `On the “${this.config.bridgeName}” bridge, as “${name}” — the BRIDGE is not paired yet. In iOS Home: + → Add Accessory → “${this.config.bridgeName}”, then enter setup code ${this.config.identity.pincode}. Every bridged device arrives with it.`
        : paired
          ? `Paired — exposed as “${name}”`
          : `Exposed as “${name}” — not paired yet. In iOS Home: + → Add Accessory → “${name}”, then enter setup code ${this.config.identity.pincode}.`
    // Per-camera pairing QR: read this Accessory's own `X-HM://…` URI.
    // The URI bakes in this camera's category + setupID bits, so scanning
    // it opens iOS Home's pairing prompt directly on THIS camera. We
    // intentionally surface the QR even when the accessory is already
    // paired — the URI is constant for the accessory's lifetime; iOS
    // recognises an already-known pairing and skips, while a SECOND
    // controller (e.g. a household member's iPhone) can scan the same
    // QR to be added. Renders nothing when the URI is empty (not
    // exposed yet, hap-nodejs error).
    // A BRIDGED accessory has no setup URI of its own — it is not separately
    // pairable, and the code the operator needs is the BRIDGE's. Reading the
    // accessory's own URI here produced an empty string and a QR tile that
    // rendered nothing, which reads as "pairing is broken" rather than "pair
    // the bridge once".
    const qrSource = bridged ? (this.bridgeHost?.accessory ?? null) : (mapper?.accessory ?? null)
    let qrValue = ''
    if (qrSource) {
      try {
        qrValue = qrSource.setupURI()
      } catch (err) {
        this.ctx.logger
          .withTags({ deviceId })
          .debug('export-hap: setupURI failed for per-device contribution', {
            meta: { error: errMsg(err) },
          })
      }
    }
    // Streaming settings exist only on the camera shape. A switch or a sensor
    // has no source stream and cannot record, and rendering the pickers anyway
    // would be two knobs that write a store nothing reads.
    // The bridge switch, for everything HomeKit lets us bridge. A camera never
    // sees it: the answer there is HomeKit's and there is nothing to choose.
    const bridgeFields =
      kind === 'camera'
        ? []
        : [
            {
              type: 'boolean' as const,
              key: useBridgeKey,
              label: 'Export through the bridge',
              description:
                'Publish this device inside the shared CamStack bridge — one pairing and one entry in Add Accessory for every non-camera device, instead of one each. Turning this off gives it its own advertisement. Either way the switch REBUILDS the accessory and it must be added to the Home app again.',
              style: 'switch' as const,
              value: shouldBridge({
                mapperKind: kind,
                useBridge: settings.useBridge,
              }),
              showWhen: { field: enabledKey, equals: true },
              immediate: true,
            },
          ]

    const cameraFields =
      kind !== 'camera'
        ? []
        : [
            {
              // Single source-stream picker. Pinned to the three camstack
              // profile slots (`high`/`mid`/`low`) plus the smart-`auto`
              // fallback — NOT raw native camStream ids. The runtime
              // picker translates the choice to a broker brokerId at
              // session start; on `auto` it picks the slot closest to
              // 1080p (iOS Home's preferred resolution).
              type: 'select' as const,
              key: streamPreferenceKey,
              label: 'Source stream (HomeKit)',
              description:
                'Which camstack profile slot HomeKit pulls. Auto = the broker picks the slot closest to 1080p at session start.',
              options: HAP_STREAM_PREFERENCE_OPTIONS,
              required: true,
              value: settings.streamPreference,
              showWhen: { field: enabledKey, equals: true },
              // Auto-save: changing the source mid-life triggers a full
              // unexpose + re-expose so iOS Home picks up the new RTSP
              // entry. Operator intent is "apply now", not "stage + save".
              immediate: true,
            },
            {
              // HomeKit Secure Video — REPORTED, never set from here.
              //
              // "Record this camera" is HomeKit's decision: iOS asks it during
              // setup and persists it on the accessory, and the prebuffer runs
              // only while that characteristic is on. A switch of ours beside
              // it was a second authority over one function (D62), and it cost
              // what D62 says: the day its default flipped, a camera kept
              // teeing clips while every surface said it had no HomeKit source.
              //
              // The cost stays on the label, because it is still the
              // operator's to understand: a camera recording here runs a
              // PERMANENT ffmpeg (0.7% of a core on the copy branch).
              type: 'info' as const,
              key: `hap:${deviceId}:hksvRecordingStatus`,
              label: 'HomeKit recording (Secure Video)',
              content: describeHomekitRecording(
                readHomekitRecordingActive(this.exposed.get(String(deviceId))?.accessories ?? []),
                this.hksvBuilds.lastFor(deviceId),
              ),
              showWhen: { field: enabledKey, equals: true },
            },
            {
              // Apple's NEW camera service (0x8031), where HEVC and 4K live.
              // The classic service this addon has always spoken carries H.264
              // and nothing else — which is why an H.265 camera is transcoded
              // from 4K HEVC down to 720p H.264 just to be shown, while an
              // H.264 one is passed through untouched.
              //
              // Per camera because the prize is per camera, and safe as a
              // default because the fallback is the CONTROLLER'S own: measured
              // 2026-09-16, iOS reads the new service and — finding it
              // unusable — opens its session on the classic one two seconds
              // later. The description says what it does TODAY rather than
              // what it will do: a switch that promises HEVC before the
              // negotiation exists is a switch that lies.
              type: 'boolean' as const,
              key: multiTierKey,
              label: 'Offer the new HomeKit camera service (HEVC / 4K)',
              description:
                'Declares Apple’s multi-tier camera service beside the classic one, advertising what this sensor can really produce. Today a controller reads it and still streams over the classic H.264 path — the negotiation is being built. Turn it off if this camera behaves oddly in iOS Home.',
              style: 'switch' as const,
              value: resolveMultiTierService(settings),
              showWhen: { field: enabledKey, equals: true },
              immediate: true,
            },
            {
              // CamStack's own copy of what HomeKit is sent. Per camera because
              // the cost is per camera (disk plus one thumbnail ffmpeg per
              // clip), and ON by default because HKSV has no read-back: a
              // recording made while this was off is gone for good (D550).
              type: 'boolean' as const,
              key: keepClipsKey,
              label: 'Keep CamStack copies of HomeKit clips',
              description:
                'Save a copy of every clip sent to HomeKit Secure Video, on the “HomeKit Clips” storage location. HomeKit never gives a clip back, so a recording made with this off cannot be recovered later. Off saves the disk and one thumbnail decode per clip; the HomeKit recording itself is unchanged either way.',
              style: 'switch' as const,
              value: resolveKeepHomekitClips(settings),
              showWhen: { field: enabledKey, equals: true },
              immediate: true,
            },
            {
              type: 'number' as const,
              key: clipRetentionKey,
              label: 'Keep this camera’s clips for (days)',
              description: `How long this camera’s kept clips survive before they are pruned, oldest first. Leave at ${this.config.clipRetentionDays} to follow the fleet default. The per-camera caps (200 clips, 512 MB) and the 4 GB overall cap still apply — whichever is reached first wins, and the prune log names it.`,
              value: resolveClipRetentionDays(settings, this.config.clipRetentionDays),
              showWhen: { field: keepClipsKey, equals: true },
              immediate: true,
            },
            {
              // What the operator is willing to SPEND. With it off, a session
              // HomeKit negotiated that cannot be served by a copy is refused
              // with a named reason instead of transcoded silently.
              type: 'boolean' as const,
              key: allowTranscodeKey,
              label: 'Allow transcoding for HomeKit',
              description:
                'Let the hub re-encode this camera when the resolution HomeKit negotiated cannot be served by a direct copy. Off means only a stream that can be forwarded as-is is offered — cheaper, but a session HomeKit negotiates outside what the camera publishes will be refused instead of transcoded.',
              style: 'switch' as const,
              value: settings.allowTranscode !== false,
              showWhen: { field: enabledKey, equals: true },
              immediate: true,
            },
          ]

    const hapExportSection: ConfigSectionWithValues = {
      id: 'export-hap',
      title: 'HomeKit Export',
      description:
        kind === 'camera'
          ? 'Publish this camera as its own HomeKit accessory so iOS Home can pair with it.'
          : 'Publish this device as its own HomeKit accessory. Its capabilities decide which controls iOS Home shows.',
      tab: 'export',
      columns: 1,
      order: 10,
      fields: [
        {
          type: 'info' as const,
          key: '__hap-status',
          label: 'Status',
          content: statusLabel,
          variant: 'info' as const,
        },
        {
          type: 'qr-code' as const,
          key: '__hap-pair-qr',
          label: paired ? 'Pairing QR (already paired)' : 'Pairing QR',
          caption: paired
            ? `Already paired with at least one device. Scan from another iPhone / iPad to add it there too. Setup code: ${this.config.identity.pincode}.`
            : `Scan with the iOS Camera app to pair this accessory in HomeKit. Setup code: ${this.config.identity.pincode}.`,
          value: qrValue,
          size: 192,
          alt: `HomeKit pairing QR for ${name}`,
          showWhen: { field: enabledKey, equals: true },
        },
        {
          type: 'boolean' as const,
          key: enabledKey,
          label: 'Expose to HomeKit',
          description: 'Toggle to publish this device as a HomeKit accessory.',
          style: 'switch' as const,
          value: enabled,
          // Auto-save on click — there is no draft state to review for
          // a single toggle; the user expects the action to fire
          // immediately. The pending-edit overlay shows the new value
          // while the (slow) expose/unexpose runs server-side.
          immediate: true,
        },
        ...bridgeFields,
        ...cameraFields,
      ],
    }
    return {
      tabs: [{ id: 'export', label: 'Export', icon: 'share-2', order: 80 }],
      sections: [hapExportSection],
    }
  }

  /**
   * Persist a patch produced by the device-details form. Splits the
   * patch into the cap-level toggle (`enabled`) and the addon-specific
   * preferences. When `enabled` flips, runs the regular expose /
   * unexpose lifecycle; when only `streamPreference` changes on a
   * live-exposed device, we detach + re-attach the HAP mapper so the
   * RTSP source it dials is refreshed. A more surgical "swap stream
   * without re-pairing" path is feasible (StreamingDelegate would just
   * need a setter) but the unexpose + re-expose path is what iOS Home
   * already handles cleanly today — see the streamPreference-change
   * note in CLAUDE.md (Remaining work).
   */
  private async applyDeviceSettingsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<{ success: true }> {
    const deviceIdStr = String(deviceId)
    const log = this.ctx.logger.withTags({ deviceId })
    const current = this.findEntry(deviceId)
    // Runtime truth — `this.exposed` is populated by `attachMapper`
    // after a successful publish. A persisted entry that never made it
    // through attach (e.g. a stale legacy entry that errored at boot)
    // must be treated as NOT exposed so the next toggle-ON kicks off
    // a fresh `exposeDevice` (idempotent — overwrites the stale entry).
    const wasEnabled = this.exposed.has(deviceIdStr)

    // ── Standard keys (enabled / streamPreference) ─────────────────
    // Both keys are namespaced per-exporter — see buildDeviceSettingsContribution.
    const enabledKey = `hap:${deviceId}:enabled`
    const streamPreferenceKey = `hap:${deviceId}:streamPreference`
    const useBridgeKey = `hap:${deviceId}:useBridge`
    const allowTranscodeKey = `hap:${deviceId}:allowTranscode`
    const multiTierKey = `hap:${deviceId}:multiTierService`
    const keepClipsKey = `hap:${deviceId}:keepClips`
    const clipRetentionKey = `hap:${deviceId}:clipRetentionDays`
    const enabledValue = enabledKey in patch ? Boolean(patch[enabledKey]) : wasEnabled
    const streamPreferenceRaw =
      streamPreferenceKey in patch
        ? patch[streamPreferenceKey]
        : current?.settings?.streamPreference
    const streamPreference: 'auto' | string =
      typeof streamPreferenceRaw === 'string' && streamPreferenceRaw.trim().length > 0
        ? streamPreferenceRaw
        : 'auto'
    const useBridge =
      useBridgeKey in patch ? Boolean(patch[useBridgeKey]) : current?.settings?.useBridge !== false
    const allowTranscode =
      allowTranscodeKey in patch
        ? Boolean(patch[allowTranscodeKey])
        : current?.settings?.allowTranscode !== false
    // This branch was MISSING while the switch was already drawn. The operator
    // flipped it, the patch answered `{ success: true }`, and the value was
    // discarded — the read-back still said off, with no line anywhere saying
    // so. `settings-switches-write.spec.ts` now fails for any key that is
    // drawn and not written, including one nobody thought to test.
    const multiTierService =
      multiTierKey in patch
        ? Boolean(patch[multiTierKey])
        : resolveMultiTierService(current?.settings)
    const keepClips =
      keepClipsKey in patch
        ? Boolean(patch[keepClipsKey])
        : resolveKeepHomekitClips(current?.settings)
    // Resolved through the same cascade that DREW the field, so what is stored
    // is what the operator saw — a raw number here would persist an out-of-rail
    // value the reader then silently ignores.
    const clipRetentionDays =
      clipRetentionKey in patch
        ? resolveClipRetentionDays(
            { streamPreference, clipRetentionDays: Number(patch[clipRetentionKey]) },
            this.config.clipRetentionDays,
          )
        : resolveClipRetentionDays(current?.settings, this.config.clipRetentionDays)
    const nextSettings: ExportDeviceSettings = {
      ...(current?.settings ?? DEFAULT_DEVICE_SETTINGS),
      streamPreference,
      useBridge,
      allowTranscode,
      multiTierService,
      keepClips,
      clipRetentionDays,
    }

    if (!enabledValue) {
      if (wasEnabled) {
        await this.unexposeDevice(deviceIdStr)
      }
      return { success: true as const }
    }

    if (!wasEnabled) {
      await this.exposeDevice(deviceIdStr)
      await this.updateEntrySettings(deviceIdStr, nextSettings)
      return { success: true as const }
    }

    // Already exposed. Persist the new settings then refresh the mapper
    // if the streamPreference changed (full unexpose+re-expose for now —
    // see method header).
    const currentPref = current?.settings?.streamPreference ?? 'auto'
    // The tee is built with the delegate, so turning it on or off is a rebuild
    // — not a structural HAP change, but the factory is captured at build time
    // and a switch that only took effect after a restart would read as broken.
    const currentKeepClips = resolveKeepHomekitClips(current?.settings)
    // Whether the accessory MOVES between the bridge and its own advertisement.
    // Compared through `shouldBridge` and not on the raw field, so a camera —
    // where the field is ignored — never reads as a change and never triggers a
    // rebuild that would drop its pairing for nothing.
    const mapperKind = current?.mapperKind ?? 'generic'
    const wasBridged = shouldBridge({ mapperKind, useBridge: current?.settings?.useBridge })
    const willBridge = shouldBridge({ mapperKind, useBridge })
    await this.updateEntrySettings(deviceIdStr, nextSettings)
    // HKSV is rebuilt for the same reason as the stream preference, and one
    // stronger: `recording` adds the CameraRecordingManagement and
    // CameraOperatingMode services and moves the MotionSensor onto the
    // controller. Both are STRUCTURAL changes — they bump `c#` — and hap-nodejs
    // freezes the advertisement when the controller is constructed, so there is
    // no in-place path. iOS may additionally need the camera removed and
    // re-added before the toggle appears; it caches aggressively.
    if (
      currentPref !== streamPreference ||
      currentKeepClips !== keepClips ||
      wasBridged !== willBridge
    ) {
      log.info('export-hap: per-camera export settings changed — refreshing accessory', {
        meta: {
          streamPreference: { from: currentPref, to: streamPreference },
          keepClips: { from: currentKeepClips, to: keepClips },
          bridged: { from: wasBridged, to: willBridge },
        },
      })
      try {
        // The pairing SURVIVES a source or HKSV change: same accessory, different
        // source, not a withdrawal. It does NOT survive a move on or off the
        // bridge — a standalone accessory and a bridged one are different
        // identities to iOS, and leaving the stale pairing blob behind is what
        // makes an accessory advertise `sf=0` and never reappear in "Add
        // Accessory". So that one case wipes it, deliberately.
        await this.unexposeDevice(deviceIdStr, { clearPairing: wasBridged !== willBridge })
        // The settings travel INTO the rebuild. `unexposeDevice` has just
        // deleted the stored entry, so `carryForward` inside `exposeDevice` has
        // nothing to carry and would rebuild on the DEFAULTS — which is the
        // failure `exposed-entry.spec.ts` exists for, fixed in the mechanism
        // and defeated here by the call order: the only path a settings change
        // takes is the one that destroys it.
        //
        // Applying them AFTER the expose is not enough either: the mapper, and
        // with it the advertised resolution list, is already built. Measured
        // 2026-09-17 — the stored value read `mid` while the advertisement
        // still said `streamPreference=auto`.
        await this.exposeDevice(deviceIdStr, undefined, nextSettings)
      } catch (err) {
        log.warn('export-hap: failed to refresh accessory after a settings change', {
          meta: { error: errMsg(err) },
        })
      }
    }
    return { success: true as const }
  }

  /**
   * Host the clip byte + still routes, and never let a host without the
   * facility take the addon down with it: a data plane is an enhancement to an
   * addon that already works, so a failure here degrades the clip surface and
   * nothing else. It is LOGGED, because a branch that drops work silently
   * reads as "never happened".
   *
   * `authenticated`, not `admin`, and NO TOKEN in either URL: the hub's
   * `/addon/<id>/<prefix>` proxy takes the session cookie, exactly as the
   * recorder's own playback plane does (D549 22).
   */
  private async serveHksvClipPlanes(): Promise<void> {
    const store = this.hksvClipStore
    if (store === null) return
    const planes = createHksvClipPlanes({
      logger: this.ctx.logger.child('hksv-clips'),
      artifactPath: (deviceId, stem, artifact) => store.artifactPath(deviceId, stem, artifact),
    })
    try {
      const media = await this.ctx.dataPlane?.serve({
        prefix: planes.mediaPrefix,
        access: 'authenticated',
        handler: planes.mediaHandler,
      })
      const thumb = await this.ctx.dataPlane?.serve({
        prefix: planes.thumbPrefix,
        access: 'authenticated',
        handler: planes.thumbHandler,
      })
      this.hksvClipPlanes = planes
      this.ctx.logger.info('export-hap: HomeKit clip data planes served', {
        meta: {
          // The CLIENT path is the hub's reverse-proxy path, never the
          // internal listener the handle reports.
          mediaPath: `/addon/${EXPORT_HAP_ADDON_ID}/${planes.mediaPrefix}`,
          thumbPath: `/addon/${EXPORT_HAP_ADDON_ID}/${planes.thumbPrefix}`,
          mediaServed: media !== undefined,
          thumbServed: thumb !== undefined,
        },
      })
    } catch (err) {
      this.ctx.logger.warn(
        'export-hap: HomeKit clip data planes failed to serve — clips will list but not play',
        { meta: { error: errMsg(err) } },
      )
    }
  }

  /**
   * The client path of one clip artifact.
   *
   * Composed from the SERVED prefixes when the planes are up, so a URL is
   * never minted for a route that does not exist; the constants are the
   * fallback for the one window between registration and `serve` returning.
   */
  private hksvClipUrl(kind: 'media' | 'thumb', deviceId: number, stem: string): string {
    const planes = this.hksvClipPlanes
    const prefix =
      kind === 'media'
        ? (planes?.mediaPrefix ?? HKSV_CLIP_MEDIA_PREFIX)
        : (planes?.thumbPrefix ?? HKSV_CLIP_THUMB_PREFIX)
    const extension = kind === 'media' ? 'mp4' : 'jpg'
    return `/addon/${EXPORT_HAP_ADDON_ID}/${prefix}/${String(deviceId)}/${stem}.${extension}`
  }

  private findEntry(deviceId: number): ExposedConfigEntry | null {
    const id = String(deviceId)
    return this.config.exposed.find((e) => e.deviceId === id) ?? null
  }

  private async updateEntrySettings(
    deviceIdStr: string,
    settings: ExportDeviceSettings,
  ): Promise<void> {
    const next = this.config.exposed.map<ExposedConfigEntry>((e) =>
      e.deviceId === deviceIdStr ? { ...e, settings } : e,
    )
    await this.updateGlobalSettings({ exposed: next })
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default ExportHapAddon
