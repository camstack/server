import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AddonApi,
  AddonDataPlaneHandle,
  BatteryStatus,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DataPlaneHandler,
  InferProvider,
  IngestOwner,
  IScopedLogger,
  BatteryPresence,
  ProfileSlot,
  ProviderRegistration,
  RtspRestreamEntry,
} from '@camstack/types'
import {
  BaseAddon,
  batteryCapability,
  BatteryStatusSchema,
  deriveBatteryPresence,
  bareAddonId,
  DeviceFeature,
  DeviceType,
  EventCategory,
  errMsg,
  memoizePinnedFfmpeg,
  nodePin,
  snapshotCapability,
  streamQualityLabel,
} from '@camstack/types'
import { z } from 'zod'
import { SnapshotCache, type SnapshotCacheEntry } from './snapshot-cache.js'
import { SnapshotDurableStore } from './snapshot-durable-store.js'
import {
  COALESCE_MS,
  decideSnapshotServe,
  MAX_CONCURRENT_GRABS,
  MAX_CONCURRENT_NATIVE,
  raceForResult,
  Semaphore,
  SingleFlight,
} from './snapshot-coalescing.js'
import {
  COURTESY_DEFAULT_WIDTH,
  type CourtesyReason,
  courtesyCacheKey,
  renderCourtesyJpeg,
  renderCourtesyOverlayJpeg,
} from './snapshot-courtesy.js'
import { NativeSnapshotFatigue } from './snapshot-fatigue.js'
import {
  buildSnapshotLinkUrl,
  parseVerifiedSnapshotLink,
  SNAPSHOT_LINK_TTL_MS,
  snapshotLinkExpiry,
} from './snapshot-link-url.js'
import type { SnapshotMedia, SnapshotPeek } from './snapshot-media-handler.js'
import { createSnapshotMediaHandler, snapSnapshotWidth } from './snapshot-media-handler.js'
import { type JpegResizer, resizeJpeg, SnapshotVariantCache } from './snapshot-resize.js'
import { isDerivedBrokerId, pickWarmSnapshotBroker } from './snapshot-grab-pick.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>
type SnapshotImage = { base64: string; contentType: string }
/**
 * Every reason a tile is not a live photograph — the snapshot service owns the
 * frame for ALL of them, and says which one in `stateReason`.
 *
 * `offline` joined this set on 2026-08-20 and is the one that changes the
 * shape. The other four are states where dialling cannot produce a better
 * answer, so they short-circuit the capture ladder. `online: false` is not that
 * kind of state: it is a VERDICT reached by three consecutive control-plane
 * misses (`reachability-poll.ts`), so it decides how the answer is DRESSED,
 * never whether the camera is asked. See {@link CAPTURE_BLOCKING_REASONS}.
 */
type SnapshotStateReason = CourtesyReason

/**
 * States that make a dial pointless — the ladder is skipped entirely.
 *
 * `offline` is deliberately absent: a camera that is never probed can never be
 * observed to come back, and this layer's own capture is one of the two ways a
 * wrong `online:false` gets discovered (the other is the reachability poller
 * that set it).
 */
const CAPTURE_BLOCKING_REASONS: readonly SnapshotStateReason[] = [
  'disabled',
  'sleeping',
  'unreachable',
  'waking',
]

/** True when this state must answer WITHOUT touching the camera. */
function blocksCapture(reason: SnapshotStateReason): boolean {
  return CAPTURE_BLOCKING_REASONS.includes(reason)
}

interface SnapshotState {
  readonly isBattery: boolean
  readonly reason?: SnapshotStateReason
}

interface SnapshotResolutionMeta {
  isBattery?: boolean
  stateReason?: SnapshotStateReason
}

/** Bytes for a card-sized frame, plus the width they are ACTUALLY at —
 *  `undefined` when the resize failed and the full frame is being served. */
interface ThumbnailBytes {
  readonly bytes: Buffer
  readonly width: number | undefined
}

/** Result of one capture-ladder run — never a rejection, so a background SWR
 *  refresh can't strand an unhandled rejection. */
type CaptureOutcome =
  | { readonly ok: true; readonly image: SnapshotImage | null }
  | { readonly ok: false; readonly error: unknown }

/**
 * How long `getSnapshotLinks` waits for the capture it triggered before minting
 * the link over whatever frame it has.
 *
 * Sized against the paint budget, not against the slowest camera. A cold fleet
 * is paced by `MAX_CONCURRENT_GRABS`, so waiting for the last of sixteen would
 * hold the whole grid for tens of seconds — and the frame that lands late is not
 * lost, it populates the cache and the client's next 5 s poll picks it up. The
 * value matches `SWR_STALE_WAIT_MS`'s intent: long enough that a warm broker
 * answers inside it, short enough that a dead camera cannot stall the batch.
 */
const LINK_MINT_DEADLINE_MS = 2_500
/**
 * A links RPC is one Viewer-wide batch. Never let one slow camera hold every
 * fast camera behind its individual capture deadline: wait briefly for the
 * common fast path, then mint from the cache as it stands. Slow captures keep
 * running and their new generation is returned by the next 5 s poll.
 */
const LINK_BATCH_WAIT_MS = 750
/** Frames older than this are never represented as current by the Viewer. */
const LINK_CURRENT_MAX_AGE_MS = 15_000
/**
 * Memo TTL for the per-device `deviceManager.getDevice` lookup.
 *
 * Every serve decision — each `getSnapshotLinks` target, each media-plane GET,
 * each conditional-GET peek — used to pay this cross-process round trip (plus
 * the battery-slice one) before it could even look at the cache: 21-target
 * grids paid 42 UDS calls per 5 s poll, on top of the captures themselves
 * (live hub, 2026-08-15). Registry facts (name/type/disabled/online/features)
 * change on operator action or provider reconnect, not mid-second, so ten
 * seconds of staleness is invisible next to the poll cadence — and every
 * lifecycle event that changes one of those fields evicts the entry
 * immediately (see the `device.*` subscriptions in `onInitialize`).
 *
 * The BATTERY SLICE is deliberately NOT memoized: sleep/wake transitions must
 * be reactive (a camera that just fell asleep must not be dialed — the
 * Baichuan wake-on-login incident), and `waking` is already live from the
 * in-memory `wakingDevices` map.
 */
const DEVICE_META_MEMO_MS = 10_000
/** Wake-on-play's 8 s firmware wait + 20 s broker settle, with scheduling
 *  slack. A lost completion event must not leave a camera "Waking" forever. */
const SNAPSHOT_WAKING_TTL_MS = 35_000

/** Delay before the single wake-capture retry — covers a camera whose status
 *  flips awake a beat before its snapshot endpoint actually answers. */
const WAKE_CAPTURE_RETRY_MS = 5_000

/** One row of `snapshot.getSnapshotLinks` — a signed link plus the honest age
 *  of the frame behind it. Structurally the cap's output element. */
interface SnapshotLinkRow {
  deviceId: number
  url: string | null
  capturedAt: number | null
  ageMs: number | null
  expiresAt: number | null
  width: number | null
  neverCaptured: boolean
  sleeping: boolean
  stateReason: SnapshotStateReason | null
  battery: boolean
}

/** One row of the cache-only `getSnapshotOverview` batch (no pixels). */
interface SnapshotOverviewRow {
  deviceId: number
  lastCapturedAt: number | null
  cacheAgeMs: number | null
  etag: string | null
}

/**
 * Per-device snapshot settings stored via `ctx.settings.writeDeviceStore`.
 * Kept as a plain interface (not Zod) because the value set is tiny and
 * `snapshot` isn't worth the extra schema plumbing — runtime coercion
 * happens inline in `getDeviceStoreTyped` below.
 */
interface SnapshotDeviceSettings {
  /** Quality profile to prefer when grabbing a snapshot (e.g. `high`, `mid`). Empty = auto. */
  readonly snapshotStreamId?: string
  /** If true, log extra detail (timing, selected stream, error paths). */
  readonly snapshotDebug?: boolean
  /**
   * Maximum acceptable cache age in seconds. Below it the wrapper
   * serves the cached image; above it (or on `force`) it falls
   * through to the native (which on battery cams wakes the
   * firmware). When unset the per-device default applies:
   * `BATTERY_DEFAULT_MAX_AGE_S` for battery cams and
   * `NON_BATTERY_DEFAULT_MAX_AGE_S` for everything else.
   */
  readonly snapshotMaxAgeS?: number
}

/**
 * The device facts the wrapper consults, from ONE `getDevice` trip.
 *
 * `disabled` and `online` exist for the courtesy frame: a camera that cannot
 * capture must say WHY rather than 404, or an operator's deliberate off-switch
 * is indistinguishable from a fault ([D62]).
 */
interface SnapshotDeviceMeta {
  readonly name?: string
  readonly isBattery: boolean
  readonly type?: DeviceType
  /** Soft-disabled by the operator. Never dial one. */
  readonly disabled: boolean
  /** The hub believes the device is reachable. Absent field ⇒ no opinion ⇒ up. */
  readonly online: boolean
}

/** Default cache window for non-battery cams (seconds). Matches the Viewer's
 *  15 s currency contract (`LINK_CURRENT_MAX_AGE_MS`): a frame younger than
 *  that is presented as current, so re-capturing INSIDE the window bought
 *  nothing the client would show — under the 5 s links poll it made every
 *  other poll recapture the whole fleet through the 6-permit grab pools. */
const NON_BATTERY_DEFAULT_MAX_AGE_S = 15
/** Default cache window for battery cams (seconds). 1h ≈ "don't wake the cam unless asked". */
const BATTERY_DEFAULT_MAX_AGE_S = 3600

/**
 * Effective per-device max cache age (seconds): the operator override
 * (`snapshotMaxAgeS`) when a finite non-negative number, else the battery-aware
 * default. Shared by the freshness gate (`getSnapshot`) and the HTTP endpoint's
 * `Cache-Control: max-age` (so the browser/`expo-image` layer caches for exactly
 * as long as the wrapper considers the frame fresh).
 */
function effectiveMaxAgeS(prefs: SnapshotDeviceSettings, isBattery: boolean): number {
  const def = isBattery ? BATTERY_DEFAULT_MAX_AGE_S : NON_BATTERY_DEFAULT_MAX_AGE_S
  return typeof prefs.snapshotMaxAgeS === 'number' && prefs.snapshotMaxAgeS >= 0
    ? prefs.snapshotMaxAgeS
    : def
}

interface SnapshotAddonConfig {
  /**
   * Last-resort cache age (ms): if every live capture path fails
   * (native + stream-broker fallback) AND a stale entry is older
   * than this, the wrapper still returns the stale image rather
   * than `null`. Keeps the UI from going blank during transient
   * camera unreachability. Per-device freshness is governed by
   * `snapshotMaxAgeS` instead.
   */
  readonly staleTtlMs: number
}

/**
 * SnapshotAddon — wrapper over the `snapshot` capability.
 *
 * Activated per-device (toggleable by user; default active). When active,
 * caches fresh snapshots in memory. On cache miss, delegates to the native
 * provider for this device via `ctx.getNativeProvider(snapshotCapability, id)`.
 *
 * No silent fallback — if the native fails, propagate the error up. Stale
 * cache is returned ONLY when the native throws AND a stale entry exists,
 * and the failure is logged so the fallback is never silent.
 *
 * Frame-grab fallback: when the native provider is absent (or returns null /
 * throws), we ask the `stream-broker` capability for the device's RTSP
 * restream URL and pipe one JPEG out of ffmpeg. stream-broker intentionally
 * does NOT expose a `grabFrame` method — the orchestration (native-first,
 * ffmpeg fallback, caching) is this addon's concern; stream-broker only
 * publishes stream endpoints.
 */
export class SnapshotAddon extends BaseAddon<SnapshotAddonConfig> {
  /**
   * The frame cache. Bounded by a byte budget + an idle timeout — it used to be
   * unbounded in both. Every eviction is logged with the device tag: a frame
   * that silently left the cache is the reason a later capture had to happen,
   * and per-camera is the only way that question is ever asked.
   */
  /** Cameras resting after a native miss — see `snapshot-fatigue.ts`. */
  private readonly fatigue = new NativeSnapshotFatigue()
  /**
   * The last good frame per camera, on disk, so it outlives the process.
   *
   * The cache above is RAM-only and the cameras that most need it are the ones
   * that can never be asked for a fresh frame: a sleeping battery camera
   * refuses every snapshot without `force`, and the background callers that
   * would want one deliberately never pass it. Measured 2026-09-17 — the baby
   * monitor showed the courtesy card all morning because three server updates
   * had emptied this cache and the camera had been asleep since.
   */
  private durableStore: SnapshotDurableStore | null = null

  /**
   * Built on first use, never in a field initializer: `ctx` does not exist
   * until `initialize()`, and reading it at construction throws
   * "ctx accessed before initialize()" for the whole addon.
   */
  private get durable(): SnapshotDurableStore {
    this.durableStore ??= new SnapshotDurableStore({
      dataDir: this.ctx.dataDir,
      logger: this.ctx.logger,
    })
    return this.durableStore
  }

  private readonly cache = new SnapshotCache({
    onEvict: (deviceId, streamId, reason) => {
      this.ctx.logger.debug('snapshot cache evicted', {
        tags: { deviceId },
        meta: { stream: streamId ?? 'auto', reason },
      })
    },
  })
  /** Card-sized derivatives of the frames above, keyed by width and validated
   *  against the source frame's timestamp. */
  private readonly variants = new SnapshotVariantCache()

  /**
   * Rendered courtesy frames, by (reason, size, device name).
   *
   * A courtesy frame is a pure function of those three, so it is rendered once
   * and reused for as long as the process lives — a disabled camera must not
   * cost an ffmpeg run per poll. Unbounded on purpose: the key space is
   * (state reasons × this node's own cameras), not user input.
   */
  private readonly courtesyFrames = new Map<string, Buffer>()
  /** State overlays over real cached frames, grouped by device so invalidation
   *  can discard every generation in O(1). */
  private readonly stateFrames = new Map<number, Map<string, Buffer>>()
  /** Devices inside the explicit battery wake-in-progress window. */
  private readonly wakingDevices = new Map<number, number>()
  /** Last sleeping flag per battery device, for wake-EDGE detection (the map
   *  starts empty; only an observed true→false transition is a wake). */
  private readonly lastKnownSleeping = new Map<number, boolean>()
  /**
   * Short-TTL memo for `lookupDeviceMeta` (see {@link DEVICE_META_MEMO_MS}).
   * The PROMISE is stored (not the resolved value), so a burst of concurrent
   * callers — a links batch plus the image fetches it mints — joins one
   * in-flight lookup instead of stampeding `deviceManager.getDevice`.
   * `fetchDeviceMeta` never rejects (failure → null), so a settled rejection
   * can never be served from the memo.
   */
  private readonly deviceMetaMemo = new Map<
    number,
    { readonly ts: number; readonly promise: Promise<SnapshotDeviceMeta | null> }
  >()

  /**
   * De-dupes concurrent captures per `${deviceId}:${streamId}` and holds a
   * settled SUCCESS for COALESCE_MS so a grid-mount burst (and a row of refresh
   * buttons) collapses into one capture instead of one dial per tile.
   */
  private readonly captureFlight = new SingleFlight<CaptureOutcome>(
    COALESCE_MS,
    (outcome) => outcome.ok && outcome.image !== null,
  )
  /** Bounds simultaneous ffmpeg keyframe grabs (the wrapper path — common case). */
  private readonly grabPool = new Semaphore(MAX_CONCURRENT_GRABS)
  /** This node's PINNED ffmpeg (D540), asked once. The keyframe grab used to
   *  spawn a bare `'ffmpeg'` — the HOST's binary — off PATH. */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())
  /** Bounds simultaneous native (vendor HTTP/ONVIF) snapshot fetches. */
  private readonly nativePool = new Semaphore(MAX_CONCURRENT_NATIVE)

  /**
   * Cached resolution of `pipelineOrchestrator.getIngestOwner` — SnapshotAddon
   * has no per-request attach hook to resolve this fresh, so it's cached with
   * a short TTL and invalidated on `onConfigChanged` (covers the common case
   * of an operator re-saving cluster/agent settings). A stale owner for up to
   * `OWNER_CACHE_TTL_MS` just means a snapshot fallback briefly targets the
   * previous ingest owner — self-heals on the next resolve.
   */
  private ownerCache: { readonly owner: IngestOwner; readonly ts: number } | null = null
  private static readonly OWNER_CACHE_TTL_MS = 30_000

  /**
   * Handle for the `/addon/snapshot/media/<deviceId>.jpg` HTTP data-plane
   * endpoint (§3.1). Null when the host provides no `ctx.dataPlane` facility
   * (the tRPC `getSnapshot` base64 surface still works — the endpoint is a
   * strictly-additive delivery path). Disposed on shutdown.
   */
  private mediaDataPlane: AddonDataPlaneHandle | null = null

  /**
   * The PUBLIC, signature-authenticated twin of the media plane. Null when the
   * host has no `ctx.dataPlane` facility, or before the per-install secret has
   * been minted — in which case `getSnapshotLinks` reports `url: null` and the
   * client keeps using the authenticated plane exactly as before.
   */
  private linkDataPlane: AddonDataPlaneHandle | null = null
  /** Per-install HMAC secret for link signatures. Minted once and persisted: a
   *  secret that rolled on every boot would invalidate every link a client is
   *  currently holding, which is a fleet-wide blank grid after each restart. */
  private linkSecret: string | null = null
  /**
   * In-flight `serveLinkDataPlane` attempt, so the retry below cannot start a
   * second one while the first is still awaiting the settings store.
   */
  private linkPlaneAttempt: Promise<void> | null = null

  /**
   * How a full frame becomes a card-sized one. Defaults to the real ffmpeg
   * resize; injectable so the wrapper's own logic is testable without spawning a
   * process for every fixture. `JpegResizer` was declared for exactly this and
   * had no injector — which is why the resize-failure path had never been
   * exercised anywhere but production.
   */
  private readonly resize: JpegResizer

  constructor(resize: JpegResizer = resizeJpeg) {
    super({
      staleTtlMs: 60_000,
    })
    this.resize = resize
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.ctx.logger.info('Snapshot wrapper initialized')
    const provider: ISnapshotProvider = {
      getSnapshot: (input) => this.getSnapshot(input),
      invalidateCache: (input) => this.invalidateCache(input),
      // DeviceSettingsContribution surface — numeric deviceId end-to-end.
      getDeviceSettingsContribution: (input) =>
        this.buildDeviceSettingsContribution(input.deviceId),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: (input) =>
        this.saveDeviceSettingsPatch(input.deviceId, input.patch),
      // Status surface — derives a diagnostic snapshot from the cache
      // bookkeeping (lastCapturedAt, cacheAgeMs, lastBytes, lastStreamId).
      // Returns null when the device has never been captured.
      getStatus: async (input) => this.getStatus(input.deviceId),
      getSnapshotOverview: (input) => this.getSnapshotOverview(input),
      getSnapshotLinks: (input) => this.getSnapshotLinks(input),
      getDebugState: (input) => this.getSnapshotDebugState(input.deviceId),
    }
    // A removed device must stop serving its last frame. The event is the
    // fast path; because events are lossy telemetry (D8/D11) `resolveOutcome`
    // re-checks existence before serving anything past `staleTtlMs`, which is
    // the reconcile that makes a dropped event self-heal.
    this.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
      const deviceId = event.data.deviceId
      if (typeof deviceId === 'number') this.evictRemovedDevice(deviceId, 'device-unregistered')
    })
    // Keep the device-meta memo honest: every event that can change one of the
    // memoized fields (name/disabled/online/features) drops the entry, so the
    // TTL only ever bounds SILENT drift, never an announced transition. The
    // off-switch is the load-bearing one ([D62]): a just-disabled camera must
    // stop being dialed on the event, not up to 10 s later.
    const dropMetaMemo = (data: unknown): void => {
      const deviceId = (data as { deviceId?: unknown } | null)?.deviceId
      if (typeof deviceId === 'number') this.deviceMetaMemo.delete(deviceId)
    }
    this.subscribe({ category: EventCategory.DeviceRegistered }, (event) =>
      dropMetaMemo(event.data),
    )
    this.subscribe({ category: EventCategory.DeviceEnabled }, (event) => dropMetaMemo(event.data))
    this.subscribe({ category: EventCategory.DeviceDisabled }, (event) => dropMetaMemo(event.data))
    this.subscribe({ category: EventCategory.DeviceMetaChanged }, (event) =>
      dropMetaMemo(event.data),
    )
    this.subscribe({ category: EventCategory.DeviceOnline }, (event) => dropMetaMemo(event.data))
    this.subscribe({ category: EventCategory.DeviceOffline }, (event) => dropMetaMemo(event.data))
    this.subscribe({ category: EventCategory.DeviceBindingsChanged }, (event) =>
      dropMetaMemo(event.data),
    )
    this.subscribe({ category: EventCategory.BatteryOnWakeStarted }, (event) => {
      this.wakingDevices.set(event.data.deviceId, Date.now())
    })
    this.subscribe({ category: EventCategory.BatteryOnStatusChanged }, (event) => {
      // Any authoritative status ends the transient wake window. A successful
      // wake reports sleeping:false; a failed/aborted one may report true.
      this.wakingDevices.delete(event.data.deviceId)
      // Wake EDGE detection: the poll cadence deliberately never recaptures an
      // awake-but-idle battery camera (each capture is a camera hit that keeps
      // it out of sleep), so the ONE fresh frame an idle-awake battery camera
      // gets is captured here, at the moment it wakes. Only a true→false edge
      // counts — a boot-time "awake" with no prior record is not a wake.
      const prevSleeping = this.lastKnownSleeping.get(event.data.deviceId)
      this.lastKnownSleeping.set(event.data.deviceId, event.data.status.sleeping)
      if (prevSleeping === true && !event.data.status.sleeping) {
        void this.captureOnWake(event.data.deviceId)
      }
    })
    await this.serveMediaDataPlane()
    await this.ensureLinkDataPlane()
    return [
      {
        capability: snapshotCapability,
        provider,
      },
    ]
  }

  /**
   * Serve the per-device snapshot image endpoint on the addon data-plane
   * (§3.1). Delivery: `GET /addon/snapshot/media/<deviceId>.jpg` → raw JPEG with
   * `ETag` + `Cache-Control: private, max-age=<device maxAgeS>`, so a grid is N
   * independent `<Image>` tiles served from the coalesced server cache (no
   * base64 tax, no batch head-of-line blocking, browser/`expo-image` caching for
   * free). Best-effort: a host without a `dataPlane` facility keeps the tRPC
   * base64 path.
   */
  private async serveMediaDataPlane(): Promise<void> {
    const handler = createSnapshotMediaHandler({
      getMedia: (deviceId, streamId, force, width) =>
        this.resolveSnapshotMedia(deviceId, streamId, force, width),
      peekFresh: (deviceId, streamId) => this.peekFreshFrame(deviceId, streamId),
    })
    try {
      this.mediaDataPlane =
        (await this.ctx.dataPlane?.serve({ prefix: 'media', access: 'authenticated', handler })) ??
        null
      this.ctx.logger.info('snapshot media data-plane served', {
        meta: {
          baseUrl: this.mediaDataPlane
            ? `/addon/${bareAddonId(this.ctx.id)}/media`
            : '(no dataPlane facility)',
        },
      })
    } catch (err) {
      this.ctx.logger.warn('snapshot media data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
      this.mediaDataPlane = null
    }
  }

  /**
   * Serve the link plane if it is not already served — at init, and again on
   * the first `getSnapshotLinks` after an attempt that could not finish.
   *
   * The retry is not defensive padding, it is the whole reason this wrapper
   * exists. The plane needs a persisted signing secret, and the secret needs
   * the settings store; this addon now boots in its OWN process, so "the store
   * is not answering yet" is a state it can genuinely observe. A one-shot
   * attempt turns that instant into a permanent condition: `linkDataPlane`
   * stays null, every `getSnapshotLinks` row answers `url: null`, and every
   * tile on every grid stays blank until someone restarts the runner. Nothing
   * in the logs would say why, because nothing failed twice.
   *
   * Single-flighted: a burst of link requests joins one attempt.
   */
  private async ensureLinkDataPlane(): Promise<void> {
    if (this.linkDataPlane !== null) return
    if (this.linkPlaneAttempt !== null) {
      await this.linkPlaneAttempt
      return
    }
    const attempt = this.serveLinkDataPlane().finally(() => {
      this.linkPlaneAttempt = null
    })
    this.linkPlaneAttempt = attempt
    await attempt
  }

  /**
   * Serve the PUBLIC link plane: `GET /addon/snapshot/link/<deviceId>.jpg?w&v&exp&sig`.
   *
   * `access: 'public'` is deliberate and is the only interesting decision here.
   * The authority is the HMAC, exactly as for the notification artifact plane
   * and the Home Assistant media plane — but unlike those, what sits behind it
   * is a LIVE view of the operator's home, so the compensating choices are
   * explicit: a short TTL (`SNAPSHOT_LINK_TTL_MS`), the width inside the signed
   * identity so a leaked tile cannot be escalated to the full frame, and
   * **`force` is not honoured on this route at all** — a public URL must never
   * be able to wake a battery camera.
   *
   * A leaked link therefore grants: one camera, at one thumbnail width, for at
   * most the TTL. No token, no other device, no session.
   */
  private async serveLinkDataPlane(): Promise<void> {
    try {
      const secret = await this.ensureLinkSecret()
      if (secret === null) return
      const prefix = this.linkRoutePrefix()
      const handler = createSnapshotMediaHandler({
        // `force` is dropped, not forwarded. A public URL must never be able to
        // wake a battery camera, and the rewritten url carries no `force` param
        // to parse in the first place — this is the second of the two.
        getMedia: (deviceId, streamId, _force, width) =>
          this.resolveSnapshotMedia(deviceId, streamId, false, width),
        peekFresh: (deviceId, streamId) => this.peekFreshFrame(deviceId, streamId),
      })
      this.linkDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: 'link',
          access: 'public',
          handler: (req, res) => this.handleLinkRequest(req, res, secret, handler),
        })) ?? null
      this.ctx.logger.info('snapshot link data-plane served', {
        meta: { served: this.linkDataPlane !== null, prefix },
      })
    } catch (err) {
      this.ctx.logger.warn('snapshot link data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
      this.linkDataPlane = null
    }
  }

  /**
   * Verify first, then hand the request to the ordinary media handler with a
   * REWRITTEN url carrying only the signed `(deviceId, width)`.
   *
   * Rewriting rather than passing the original through is what stops an unsigned
   * query parameter reaching the capture path: `force`, `streamId` and any other
   * lever the authenticated plane honours are simply not present in what the
   * handler parses.
   */
  private async handleLinkRequest(
    req: IncomingMessage,
    res: ServerResponse,
    secret: string,
    inner: DataPlaneHandler,
  ): Promise<void> {
    const verified = parseVerifiedSnapshotLink({
      url: req.url ?? '/',
      secret,
      nowMs: Date.now(),
    })
    if (verified === null) {
      // One answer for malformed, unsigned, wrong-signature and expired alike:
      // a public route must not be a signature oracle.
      res.writeHead(404).end()
      return
    }
    const rewritten = `/${String(verified.deviceId)}.jpg${
      verified.width === undefined ? '' : `?w=${String(verified.width)}`
    }`
    const original = req.url
    try {
      req.url = rewritten
      await inner(req, res)
    } finally {
      req.url = original
    }
  }

  private linkRoutePrefix(): string {
    return `/addon/${bareAddonId(this.ctx.id)}/link`
  }

  /**
   * Mint-once-and-persist the signing secret. Null when it cannot be
   * ESTABLISHED — a secret held only in memory would break every outstanding
   * link on restart, so no plane is better than a plane whose links die
   * unpredictably.
   *
   * A null is never cached, so the next `getSnapshotLinks` tries again. That
   * matters now the wrapper runs in its own process: the settings store can be
   * a moment behind at boot, and this used to be a one-shot.
   *
   * The read-back is the gate. `state.get()` cannot distinguish "no secret
   * yet" from "the store could not be read" — `readAddonStoreWithRetry` gives
   * up and answers `{}` — so a store that is merely slow reads as empty and
   * this would mint a SECOND secret over a perfectly good first one, silently
   * invalidating every link a client is holding. Reading back what we just
   * wrote is the only evidence available at this layer that the store is
   * actually answering, and a mismatch means it is not.
   */
  private async ensureLinkSecret(): Promise<string | null> {
    if (this.linkSecret !== null) return this.linkSecret
    try {
      const state = this.state<string>('snapshotLinkSecret', z.string(), '')
      const stored = await state.get()
      if (stored !== '') {
        this.linkSecret = stored
        return stored
      }
      const minted = randomUUID().replace(/-/g, '')
      await state.set(minted)
      const confirmed = await state.get()
      if (confirmed !== minted) {
        this.ctx.logger.warn(
          'snapshot: link secret did not persist — deferring the link plane rather than signing with a secret that will not survive',
          { meta: { confirmedEmpty: confirmed === '' } },
        )
        return null
      }
      this.linkSecret = minted
      return minted
    } catch (err) {
      this.ctx.logger.warn('snapshot: could not establish link signing secret', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Mint signed links for the tiles a surface is rendering — and, in the same
   * call, make those tiles CURRENT.
   *
   * This is the demand signal the design was missing. Under D93 enrolment rode
   * on the image request, and D93/D94/D95 each fixed a different way for that
   * request not to happen; none of them could fix the last one, because the
   * client's own image cache answers a repeated URL with no network at all. An
   * RPC has no such cache in front of it.
   *
   * So: note every target (creating a subscription, which `getSnapshotOverview`
   * deliberately cannot), then join the ordinary non-forced capture path and
   * wait a BOUNDED time for it. The Viewer never presents a frame older than
   * 15 seconds as current, so this path tightens a looser per-device cache
   * window to that contract without using `force` (and its battery-wake
   * semantics). What comes back is the identity of the frame the link serves.
   *
   * The bound matters more than its exact value. A cold fleet is paced by
   * `MAX_CONCURRENT_GRABS`, so sixteen cameras cannot all capture at once and
   * the last of them would hold the whole batch well past any sensible paint
   * budget. Devices that miss the bound return their real, older `capturedAt` —
   * honest rather than blocking — and the client's next poll carries them
   * forward.
   */
  private async getSnapshotLinks(input: {
    targets: { deviceId: number; width?: number }[]
  }): Promise<SnapshotLinkRow[]> {
    // The plane may not have come up at init (settings store still starting in
    // this runner's boot window). Retry here, where the answer is about to
    // matter, rather than reporting `url: null` forever.
    await this.ensureLinkDataPlane()
    const secret = await this.ensureLinkSecret()
    const now = Date.now()
    const expMs = snapshotLinkExpiry(now, SNAPSHOT_LINK_TTL_MS)
    const served = this.linkDataPlane !== null && secret !== null
    const prefix = this.linkRoutePrefix()

    const stateByDevice = new Map<number, SnapshotState>()
    const refreshes = input.targets.map(async (target): Promise<void> => {
      const state = await this.snapshotStateForLink(target.deviceId)
      stateByDevice.set(target.deviceId, state)
      if (state.reason !== undefined) return
      // An AWAKE battery camera is NOT recaptured on the poll cadence: every
      // capture is a camera hit, and a 5 s tile poll hitting the camera every
      // 15 s keeps it out of sleep forever (2026-08-16: baby monitor never
      // re-slept while the cameras page was open). The exception is a frame
      // grab that costs nothing — a consumer is already streaming, so the
      // camera is awake and the broker pipe is warm. The fresh frame for an
      // idle-awake battery camera arrives at the WAKE edge instead (see the
      // BatteryOnStatusChanged subscription), not from these polls.
      if (state.isBattery && !(await this.hasStreamingBrokerForDevice(target.deviceId))) return
      await this.awaitFreshEnough(target.deviceId)
    })
    const refreshBatch = Promise.allSettled(refreshes)
    // The loser deliberately keeps running. `allSettled` also guarantees that
    // a late per-camera failure can never become an unhandled rejection.
    await raceForResult(refreshBatch, LINK_BATCH_WAIT_MS)

    const rows = input.targets.map((target): SnapshotLinkRow => {
      const { deviceId } = target
      const width = target.width === undefined ? undefined : snapSnapshotWidth(target.width)
      const hit = this.cache.latest(deviceId)
      const capturedAt = hit?.ts ?? null
      const answeredAt = Date.now()
      return {
        deviceId,
        url:
          served && secret !== null
            ? buildSnapshotLinkUrl({
                routePrefix: prefix,
                deviceId,
                width,
                capturedAt,
                secret,
                expMs,
              })
            : null,
        capturedAt,
        ageMs: capturedAt === null ? null : answeredAt - capturedAt,
        expiresAt: served ? expMs : null,
        width: width ?? null,
        neverCaptured: capturedAt === null,
        sleeping: stateByDevice.get(deviceId)?.reason === 'sleeping',
        stateReason: stateByDevice.get(deviceId)?.reason ?? null,
        battery: stateByDevice.get(deviceId)?.isBattery ?? false,
      }
    })
    this.ctx.logger.debug('snapshot: minted links', {
      meta: {
        targets: input.targets.length,
        served,
        stale: rows.filter((r) => r.ageMs !== null && r.ageMs > 15_000).length,
      },
    })
    return rows
  }

  /**
   * The debug readout's data — the decision chain for one device, cache-only
   * and capture-free (a debug poll must never wake a battery camera).
   */
  private async getSnapshotDebugState(deviceId: number): Promise<{
    battery: { sleeping: boolean; lastUpdated: number; lastContactAt?: number } | null
    state: { isBattery: boolean; reason: SnapshotStateReason | null }
    frame: { capturedAt: number | null; ageMs: number | null }
    waking: boolean
  }> {
    const meta = await this.lookupDeviceMeta(deviceId)
    const state = await this.resolveSnapshotState(deviceId, meta)
    const hit = this.cache.latest(deviceId)
    const batterySlice = await this.ctx.api.deviceState.getCapSlice
      .query({ deviceId, capName: batteryCapability.name })
      .catch(() => null)
    const parsed = BatteryStatusSchema.safeParse(batterySlice)
    return {
      battery: parsed.success
        ? {
            sleeping: parsed.data.sleeping,
            lastUpdated: parsed.data.lastUpdated,
            ...(parsed.data.lastContactAt !== undefined
              ? { lastContactAt: parsed.data.lastContactAt }
              : {}),
          }
        : null,
      state: { isBattery: state.isBattery, reason: state.reason ?? null },
      frame: {
        capturedAt: hit?.ts ?? null,
        ageMs: hit ? Date.now() - hit.ts : null,
      },
      waking: this.isDeviceWaking(deviceId),
    }
  }

  /**
   * Join the ordinary capture path for one device and wait, bounded, for it.
   *
   * Deliberately `getSnapshot` with `force: false`: the single flight, grab
   * pool, and sleeping-battery refusal apply unchanged. The only override is
   * the Viewer's 15-second currency contract and the link-mint wait bound.
   */
  private async awaitFreshEnough(deviceId: number): Promise<void> {
    const before = this.cache.latest(deviceId)?.ts ?? null
    const alreadyCurrent = before !== null && Date.now() - before <= LINK_CURRENT_MAX_AGE_MS

    // Override only the SWR wait bound. Without this, getSnapshot can resolve
    // with the stale fallback before its background capture lands, and the
    // link is minted over the old generation despite having a larger deadline.
    await this.getSnapshot(
      { deviceId, force: false },
      LINK_MINT_DEADLINE_MS,
      LINK_CURRENT_MAX_AGE_MS,
      LINK_MINT_DEADLINE_MS,
    ).catch(() => null)
    const current = this.cache.latest(deviceId)?.ts ?? null
    if (alreadyCurrent || (current !== null && (before === null || current > before))) return

    // NEVER silent: a link minted over a frame we could not refresh is exactly
    // the "stale but plausible" state the operator reported, and it must be
    // answerable per-camera.
    this.ctx.logger.debug('snapshot: link mint gave up waiting; serving the older frame', {
      tags: { deviceId },
      meta: { deadlineMs: LINK_MINT_DEADLINE_MS, previousCapturedAt: before },
    })
  }

  /**
   * The one fresh frame an awake battery camera gets outside an active stream:
   * captured at the WAKE edge, because the link poll deliberately never
   * recaptures an idle-awake battery camera (every capture is a camera hit
   * that would keep it out of sleep — the link-mint gate documents the
   * incident).
   *
   * `force: true` is correct here — not a violation of "never wake for a
   * snapshot": the camera is ALREADY awake (the status edge is what fired),
   * and the battery 1 h cache default would otherwise answer the wake with
   * the pre-sleep frame. The single flight coalesces a burst of edges; one
   * delayed retry covers a camera whose status flipped a beat before its
   * snapshot endpoint is actually answering (firmware boot lag).
   */
  private async captureOnWake(deviceId: number): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, WAKE_CAPTURE_RETRY_MS))
      // `force: true` bypasses the sleeping-state block, so a STALE edge (a
      // status flap that already reverted to sleeping) would wake the camera
      // for a snapshot nobody asked for — the exact wake loop this capture
      // exists to avoid. Re-read the (capture-free) state before every dial.
      const state = await this.resolveSnapshotState(
        deviceId,
        await this.lookupDeviceMeta(deviceId),
      ).catch(() => null)
      if (state?.reason === 'sleeping') return
      try {
        const image = await this.getSnapshot({ deviceId, force: true })
        if (image !== null) {
          this.ctx.logger.debug('snapshot: wake capture landed', { tags: { deviceId } })
          return
        }
      } catch (err) {
        this.ctx.logger.debug('snapshot: wake capture failed', {
          tags: { deviceId },
          meta: { error: errMsg(err), attempt },
        })
      }
    }
  }

  /** Resolve the state advertised by a minted link before deciding whether a
   *  background capture is allowed. */
  private async snapshotStateForLink(deviceId: number): Promise<SnapshotState> {
    try {
      const meta = await this.lookupDeviceMeta(deviceId)
      return await this.resolveSnapshotState(deviceId, meta)
    } catch (err) {
      this.ctx.logger.debug('snapshot: link state resolution failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return { isBattery: false }
    }
  }

  /**
   * Resolve a device (+ optional stream, + force) to renderable JPEG bytes for
   * the HTTP endpoint. Runs the same coalesced capture ladder as the tRPC
   * `getSnapshot` (so every consumer shares one upstream pull), then decodes the
   * base64 cache into raw bytes and stamps the frame identity: `capturedAt` from
   * the cache entry (matching the ETag `getSnapshotOverview` advertises) and the
   * effective per-device `maxAgeS` for `Cache-Control`. Null → 404.
   */
  private async resolveSnapshotMedia(
    deviceId: number,
    streamId: string | undefined,
    force: boolean,
    width?: number,
  ): Promise<SnapshotMedia | null> {
    const resolutionMeta: SnapshotResolutionMeta = {}
    const image = await this.getSnapshot(
      {
        deviceId,
        ...(streamId !== undefined ? { streamId } : {}),
        force,
      },
      0,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      resolutionMeta,
      // Cache-first for the HTTP planes: a stale cached frame answers
      // immediately and the capture it joined keeps running for the next
      // poll. `force` (operator refresh on the authenticated plane) is
      // exempt — it waits for the capture it asked for.
      0,
    )
    if (!image) return null
    const capturedAt = this.cache.get(deviceId, streamId)?.ts ?? Date.now()
    const prefs = await this.readDeviceSettings(deviceId).catch(() => ({}))
    const isBattery = resolutionMeta.isBattery ?? false
    if (width === undefined) {
      return {
        bytes: Buffer.from(image.base64, 'base64'),
        contentType: image.contentType,
        capturedAt,
        maxAgeS: effectiveMaxAgeS(prefs, isBattery),
        variantKey: resolutionMeta.stateReason,
        servedWidth: undefined,
      }
    }
    const thumb = await this.thumbnailBytes(
      deviceId,
      streamId,
      width,
      capturedAt,
      image,
      prefs,
      resolutionMeta.stateReason,
    )
    return {
      bytes: thumb.bytes,
      contentType: image.contentType,
      capturedAt,
      maxAgeS: effectiveMaxAgeS(prefs, isBattery),
      variantKey: resolutionMeta.stateReason,
      // `undefined` when the resize failed and the FULL frame is going out —
      // the ETag must not claim a width the bytes do not have.
      servedWidth: thumb.width,
    }
  }

  /**
   * Cache-only freshness peek for the data-plane's conditional-GET fast path.
   * Never captures, never resizes, never dials anything: a cached frame that is
   * still inside its per-device max-age, or null.
   *
   * Returning null for a STALE entry is the important half. A 304 there would
   * pin the tile to the old frame for as long as the client kept revalidating,
   * which is the exact staleness this change exists to remove.
   */
  private async peekFreshFrame(
    deviceId: number,
    streamId: string | undefined,
  ): Promise<SnapshotPeek | null> {
    const hit = this.cache.get(deviceId, streamId)
    if (!hit) return null
    const prefs = await this.readDeviceSettings(deviceId).catch(() => ({}))
    const meta = await this.lookupDeviceMeta(deviceId)
    const state = await this.resolveSnapshotState(deviceId, meta)
    const maxAgeS = effectiveMaxAgeS(prefs, state.isBattery)
    if (Date.now() - hit.ts >= maxAgeS * 1_000) return null
    return { capturedAt: hit.ts, maxAgeS, variantKey: state.reason }
  }

  // ── Derived thumbnails ────────────────────────────────────────────────

  /**
   * The frame at a card-sized width, derived once per
   * (device, stream, width, state treatment) per capture.
   *
   * A failed resize falls back to the FULL frame — a visible card beats a
   * broken one — but never silently: the card would otherwise keep costing a
   * megabyte with nothing anywhere saying why, which is the shape of the bug
   * this whole change came from.
   */
  private async thumbnailBytes(
    deviceId: number,
    streamId: string | undefined,
    width: number,
    capturedAt: number,
    image: SnapshotImage,
    prefs: SnapshotDeviceSettings,
    variantKey?: SnapshotStateReason,
  ): Promise<ThumbnailBytes> {
    const cached = this.variants.get(deviceId, streamId, width, capturedAt, variantKey)
    if (cached !== undefined) return { bytes: cached, width }
    const full = Buffer.from(image.base64, 'base64')
    try {
      const resized = await this.resize(full, width)
      this.variants.set(deviceId, streamId, width, capturedAt, resized, variantKey)
      if (prefs.snapshotDebug) {
        this.ctx.logger.info('snapshot: thumbnail derived', {
          tags: { deviceId },
          meta: { width, fullBytes: full.length, thumbBytes: resized.length },
        })
      }
      return { bytes: resized, width }
    } catch (err) {
      this.ctx.logger.warn('snapshot: resize failed — serving the full frame', {
        tags: { deviceId },
        meta: { width, bytes: full.length, error: errMsg(err) },
      })
      // `width: undefined` — the caller stamps the ETag off what actually went
      // out, so this response cannot mint the same tag a successful resize of
      // the same capture would.
      return { bytes: full, width: undefined }
    }
  }

  protected async onShutdown(): Promise<void> {
    if (this.mediaDataPlane) {
      await this.mediaDataPlane.dispose().catch(() => undefined)
      this.mediaDataPlane = null
    }
    if (this.linkDataPlane) {
      await this.linkDataPlane.dispose().catch(() => undefined)
      this.linkDataPlane = null
    }
    this.cache.clear()
    this.variants.clear()
    this.stateFrames.clear()
    this.wakingDevices.clear()
    this.lastKnownSleeping.clear()
    this.deviceMetaMemo.clear()
    this.captureFlight.clear()
    this.ownerCache = null
  }

  /**
   * Drop the cached ingest owner whenever addon-level settings change —
   * cheap, correct-by-construction refresh point (BaseAddon calls this
   * after every `updateGlobalSettings`/`updateAddonSettings`). Combined
   * with the TTL in `resolveIngestOwner`, a cluster topology change is
   * picked up either on the next settings save or within
   * `OWNER_CACHE_TTL_MS`, whichever comes first.
   */
  protected async onConfigChanged(): Promise<void> {
    this.ownerCache = null
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'snapshot-cache',
          title: 'Snapshot Cache',
          titleKey: 'server:globalSettings.s_snapshot-cache.title',
          description:
            'Stale fallback when live capture fails. Per-device freshness is configured under Device → Snapshot → Max cache age.',
          descriptionKey: 'server:globalSettings.s_snapshot-cache.description',
          columns: 1,
          fields: [
            this.field({
              type: 'number',
              key: 'staleTtlMs',
              label: 'Stale fallback TTL (ms)',
              labelKey: 'server:globalSettings.s_snapshot-cache.staleTtlMs.label',
              description:
                'If live capture fails, cached snapshot younger than this is still returned.',
              descriptionKey: 'server:globalSettings.s_snapshot-cache.staleTtlMs.description',
              min: 0,
              max: 3_600_000,
              step: 1_000,
              default: 60_000,
            }),
          ],
        },
      ],
    })
  }

  // ── Capability methods ────────────────────────────────────────────────

  private async getSnapshot(
    input: {
      deviceId: number
      streamId?: string
      force?: boolean
    },
    /**
     * Some callers need the capture generation, not an early stale fallback.
     * This only widens the existing single-flight wait; every cache, battery,
     * and capture-pool gate remains unchanged.
     */
    minimumCaptureWaitMs = 0,
    /** Tighten the normal per-device cache window without turning the request
     * into `force` (which has battery wake semantics). */
    maximumCacheAgeMs = Number.POSITIVE_INFINITY,
    /**
     * Bound the single-flight wait from above. The capture keeps running in
     * the background and lands in the cache; the caller just stops waiting.
     * Without this, a caller with a deadline (the link mint) inherited the
     * cold-path wait: `Math.max(10_000, deadline)` turned its documented
     * 2.5 s bound into decoration.
     */
    maximumCaptureWaitMs = Number.POSITIVE_INFINITY,
    /** Optional internal metadata for the HTTP plane's state-aware ETag. */
    resolutionMeta?: SnapshotResolutionMeta,
    /**
     * Cap on the STALE-while-revalidate wait only (never the cold path).
     * The media plane passes 0: when a cached frame exists it goes out
     * immediately and the refresh keeps running for the next poll — the
     * Viewer's 15 s currency contract already refuses to PRESENT a frame
     * older than that, so holding the HTTP response open up to
     * `SWR_STALE_WAIT_MS` for a refresh that — under a fleet-wide capture
     * wave (21 cameras on 6 grab permits, measured 12–33 s per image on
     * 2026-08-15) — essentially never landed in time, was pure latency.
     * A caller with no cached frame (cold) still waits `SWR_COLD_WAIT_MS`:
     * otherwise first paint would 404 instead of joining the capture.
     */
    staleWaitCapMs = Number.POSITIVE_INFINITY,
  ): Promise<SnapshotImage | null> {
    const { deviceId } = input
    const force = input.force === true
    // Pull stable registry facts with one device-scoped query. Battery
    // classification is completed below from the canonical runtime-state
    // mirror too: a valid battery slice is affirmative evidence even when a
    // persisted feature projection is stale.
    const meta = await this.lookupDeviceMeta(deviceId)
    const deviceName = meta?.name
    const log = this.ctx.logger.withTags({ deviceId, ...(deviceName ? { deviceName } : {}) })
    const now = Date.now()

    // Honour the per-device stored preference unless the caller specified
    // an explicit streamId. `snapshotDebug` just flips log verbosity —
    // read once per call so the flag can be toggled without restart.
    const prefs: SnapshotDeviceSettings = await this.readDeviceSettings(deviceId).catch(() => ({}))
    const rawPref = prefs.snapshotStreamId
    const effectiveStreamId =
      input.streamId ?? (rawPref && rawPref !== 'auto' ? rawPref : undefined)
    if (prefs.snapshotDebug) {
      log.info('debug on', { tags: { deviceId }, meta: { stream: effectiveStreamId ?? 'auto' } })
    }

    // The cache is read AFTER the stream is resolved, and this order is the
    // fix, not a tidy-up. Reading it first — with a device-only key — served
    // whatever frame happened to be cached to a caller who had asked for a
    // specific stream, so `?streamId=low` returned the 4K main frame and the
    // one lever the UI had over snapshot size silently did nothing.
    const hit = this.cache.get(deviceId, effectiveStreamId)
    const state = await this.resolveSnapshotState(deviceId, meta)
    const isBatteryDevice = state.isBattery
    if (resolutionMeta) {
      resolutionMeta.isBattery = isBatteryDevice
      delete resolutionMeta.stateReason
    }

    // Camera state outranks raw cached pixels. A stale real frame without its
    // current state painted over it is more convincing than a 404 and just as
    // wrong: a sleeping, waking, unreachable or disabled camera must SAY so.
    //
    // `force` keeps its documented operator semantics for a normal sleeping
    // camera. It does not walk through disabled, unreachable, or an already
    // in-progress wake: those states cannot produce a better answer by adding
    // another dial.
    //
    // `offline` is NOT here (`CAPTURE_BLOCKING_REASONS`) — it dresses the answer
    // further down, after the ladder has had its chance.
    if (
      state.reason !== undefined &&
      blocksCapture(state.reason) &&
      (!force || state.reason !== 'sleeping')
    ) {
      if (resolutionMeta) resolutionMeta.stateReason = state.reason
      log.debug('snapshot: camera state overrides raw cache', {
        tags: { deviceId },
        meta: {
          reason: state.reason,
          hasCache: hit !== undefined,
          ageMs: hit ? now - hit.ts : null,
        },
      })
      // A camera that is asleep, unreachable or disabled cannot produce a new
      // frame, and RAM forgets at every restart. The frame from the last
      // process is the best base this treatment can have — and it carries its
      // real capture time, because a restored frame claiming to be new would
      // satisfy a freshness gate it has no right to pass.
      const base = hit ?? (await this.durableEntry(deviceId))
      return await this.stateImage(deviceId, state.reason, deviceName, base)
    }

    // Effective max-age check. A single per-device knob replaces the legacy
    // fresh/battery/sleeping cascade — defaults are 10s for non-battery cams
    // and 1h for battery cams; the operator can override via `snapshotMaxAgeS`,
    // and `force=true` bypasses the freshness gate (UI refresh button).
    const effectiveMaxAgeMs = Math.min(
      maximumCacheAgeMs,
      Math.max(0, effectiveMaxAgeS(prefs, isBatteryDevice) * 1_000),
    )

    const decision = decideSnapshotServe({
      now,
      cachedAt: hit?.ts ?? null,
      effectiveMaxAgeMs,
      force,
    })
    if (decision.kind === 'serve-cache') {
      if (prefs.snapshotDebug && hit) {
        log.debug('snapshot: cache hit', {
          tags: { deviceId },
          meta: { ageMs: now - hit.ts, maxAgeMs: effectiveMaxAgeMs, isBattery: isBatteryDevice },
        })
      }
      if (!hit) return null
      // A camera the hub cannot reach never answers with a bare photograph,
      // however fresh the cache entry happens to be.
      return state.reason === 'offline'
        ? await this.offlineImage(deviceId, deviceName, hit, resolutionMeta)
        : hit.data
    }

    // Coalesced capture: concurrent callers (a grid mount, a row of refresh
    // buttons) collapse into ONE run of the ladder; the settled success is
    // held briefly so a burst can't stack dials. `force` bypasses the cache
    // gate above but still joins/starts the single flight here.
    const flightKey = `${deviceId}:${effectiveStreamId ?? 'auto'}`
    const flight = this.captureFlight.run(flightKey, () =>
      this.captureFresh({ deviceId, input, effectiveStreamId, isBatteryDevice, log }),
    )
    // captureFresh never rejects (it resolves a CaptureOutcome); attach a
    // no-op catch anyway so a returned-stale path can never strand an
    // unhandled rejection if that contract ever changes.
    void flight.catch(() => undefined)

    // The stale-while-revalidate branch keeps its caller-specific wait: the
    // cap is `staleWaitCapMs` (media plane: serve the cached frame at once),
    // `force` is never capped (an operator pressing refresh asked to WAIT for
    // a capture), and the cold path is never capped here either — with nothing
    // cached there is nothing to serve, so the capture wait is the answer.
    const waitMs =
      !force && decision.staleFallback && hit !== undefined
        ? Math.min(decision.waitMs, staleWaitCapMs)
        : decision.waitMs
    const raced = await raceForResult(
      flight,
      Math.min(Math.max(waitMs, minimumCaptureWaitMs), maximumCaptureWaitMs),
    )
    if (raced.settled) {
      // An offline camera usually fails FAST — a vendor snapshot URL refuses
      // the connection in well under a second — so this settled branch, not the
      // timeout below, is where "offline" almost always lands. Answering the
      // courtesy frame only on the slow path (as the first draft did) left the
      // common case as a bare 404 the client renders as "Unavailable", which is
      // the exact thing this feature exists to remove.
      //
      // A FALLBACK, never a gate: the ladder still runs. Refusing to dial a
      // camera the registry calls offline would make a wrong `online` flag
      // self-sealing — the camera would never be probed, so it could never be
      // observed to come back.
      //
      // A capture that LANDS is served exactly as captured, with no treatment
      // and no `stateReason`: the frame is the strongest possible evidence that
      // the verdict is out of date, and the poller is about to agree.
      const captured = raced.value.ok && raced.value.image !== null
      try {
        const resolved = await this.resolveOutcome(raced.value, deviceId, hit, log)
        if (resolved !== null) {
          return captured || state.reason !== 'offline'
            ? resolved
            : await this.offlineImage(deviceId, deviceName, hit, resolutionMeta)
        }
        // Soft miss with nothing cached.
        return state.reason === 'offline'
          ? await this.offlineImage(deviceId, deviceName, undefined, resolutionMeta)
          : null
      } catch (err) {
        // Hard native error with nothing cached — `resolveOutcome` rethrows.
        if (state.reason === 'offline') {
          const stateFrame = await this.offlineImage(deviceId, deviceName, hit, resolutionMeta)
          if (stateFrame !== null) return stateFrame
        }
        throw err
      }
    }

    // Wait bound elapsed before the capture settled. Stale-while-revalidate:
    // return the cached frame (if any) and let the refresh land for the next
    // poll; on the cold path there is nothing to serve yet.
    if (decision.staleFallback && hit) {
      if (prefs.snapshotDebug) {
        log.debug('snapshot: SWR — returning stale frame; refresh continues in background', {
          tags: { deviceId },
          meta: { ageMs: now - hit.ts, waitMs: decision.waitMs },
        })
      }
      return state.reason === 'offline'
        ? await this.offlineImage(deviceId, deviceName, hit, resolutionMeta)
        : hit.data
    }
    // Cold, nothing captured in time, nothing cached. If the hub already
    // believes this device is unreachable, say THAT instead of nothing — a 404
    // here reads identically for an offline camera and a broken one.
    if (state.reason === 'offline') {
      const stateFrame = await this.offlineImage(deviceId, deviceName, undefined, resolutionMeta)
      if (stateFrame !== null) return stateFrame
    }
    return null
  }

  /**
   * Map a settled capture outcome onto the response, preserving the legacy
   * semantics: a fresh frame wins; a soft miss (native null + broker null)
   * falls back to stale cache (or null); a HARD native error with no frame
   * and no cache propagates.
   */
  private async resolveOutcome(
    outcome: CaptureOutcome,
    deviceId: number,
    hit: SnapshotCacheEntry | undefined,
    log: IScopedLogger,
  ): Promise<SnapshotImage | null> {
    if (outcome.ok) {
      if (outcome.image) return outcome.image
      // Soft miss — every live source declined. Keep the UI from going blank.
      if (hit) {
        const ageMs = Date.now() - hit.ts
        if (ageMs > this.config.staleTtlMs) {
          if (await this.staleHitBelongsToRemovedDevice(deviceId, ageMs)) return null
          log.warn('snapshot: all live paths failed — serving stale cache', {
            tags: { deviceId },
            meta: { ageMs },
          })
        }
        return hit.data
      }
      return null
    }
    // Hard native error. Stale cache first, else surface the cause.
    if (hit) {
      const ageMs = Date.now() - hit.ts
      if (ageMs > this.config.staleTtlMs) {
        if (await this.staleHitBelongsToRemovedDevice(deviceId, ageMs)) return null
        log.warn('snapshot: native failed — serving stale cache', {
          tags: { deviceId },
          meta: { ageMs },
        })
      }
      return hit.data
    }
    throw outcome.error
  }

  /**
   * Reconcile backstop for a stale hit: is the frame we are about to serve the
   * property of a device that no longer exists?
   *
   * Asked ONLY past `staleTtlMs`, which is already the "something is wrong"
   * threshold — so the common path costs nothing. A `true` answer evicts and
   * the caller returns null; anything else leaves the existing
   * keep-the-UI-from-going-blank contract untouched.
   */
  private async staleHitBelongsToRemovedDevice(deviceId: number, ageMs: number): Promise<boolean> {
    if ((await this.deviceStillExists(deviceId)) !== false) return false
    this.evictRemovedDevice(deviceId, 'stale-hit-absent')
    this.ctx.logger.debug('snapshot: refused a stale frame for a device that is gone', {
      tags: { deviceId },
      meta: { ageMs },
    })
    return true
  }

  /**
   * Run the capture ladder ONCE for a device: native provider first, then the
   * stream-broker ffmpeg fallback. Never rejects — resolves a {@link
   * CaptureOutcome}. On a produced frame it populates the cache (so a
   * background SWR refresh lands for the next poll) and returns it. A hard
   * native error with no broker frame resolves `{ ok:false }` so the caller
   * can surface it; a soft miss resolves `{ ok:true, image:null }`.
   *
   * TODO(decoded-frame fast path): for a device whose detection pipeline is
   * already decoding (the always-on subscription, see docs/design/decode-path.md),
   * the freshest decoded frame is already in the shared-memory ring — a single
   * JPEG encode of the latest FrameHandle would cost zero dials and beat the
   * ffmpeg grab for the wrapper fleet. Slotting it as native -> latest-decoded
   * -> broker needs cross-addon plumbing not cheaply reachable from the hub
   * builtin today: frames are session-scoped (decoder `pullHandles`/`getFrame`
   * need the device's active session id) and raw-pixel (need a JPEG encoder the
   * builtin lacks). Deferred as its own slice.
   */
  private async captureFresh(args: {
    deviceId: number
    input: { deviceId: number; streamId?: string; force?: boolean }
    effectiveStreamId: string | undefined
    isBatteryDevice: boolean
    log: IScopedLogger
  }): Promise<CaptureOutcome> {
    const { deviceId, input, effectiveStreamId, isBatteryDevice, log } = args
    const now = Date.now()
    let nativeError: unknown = null
    let nativeAbsent = false

    // 1. Native provider (per-device, registered by the device-class addon).
    //    A camera that missed is RESTING for a growing window: it is not
    //    dialled again, the request falls through to the broker grab and the
    //    stale cache, which cost the camera nothing. `force` is a deliberate
    //    operator wake and is never held back.
    const restingUntil = input.force === true ? null : this.fatigue.restingUntil(deviceId, now)

    try {
      const native =
        restingUntil === null ? this.ctx.getNativeProvider(snapshotCapability, deviceId) : null
      if (restingUntil !== null) {
        log.info('native snapshot: camera resting after a miss — not dialled', {
          tags: { deviceId },
          meta: { restMsLeft: restingUntil - now },
        })
      } else if (native) {
        const result = await this.nativePool.run(() => native.getSnapshot(input))
        if (result) {
          this.fatigue.recordSuccess(deviceId)
          this.stateFrames.delete(deviceId)
          this.cache.set(deviceId, effectiveStreamId, {
            data: result,
            ts: now,
            streamId: effectiveStreamId ?? null,
          })
          // Best-effort, throttled, and never awaited into the answer: the
          // caller already has its picture, and a disk that refuses must not
          // cost a snapshot that succeeded.
          void this.durable.put(deviceId, Buffer.from(result.base64, 'base64'))
          return { ok: true, image: result }
        }
        const rest = this.fatigue.recordFailure(deviceId, now)
        log.debug('native snapshot returned null — falling through to broker', {
          tags: { deviceId },
          meta: { restMs: rest.restMs, streak: rest.streak },
        })
      } else {
        nativeAbsent = true
        log.debug('native snapshot provider not resolved — falling through to broker', {
          tags: { deviceId },
        })
      }
    } catch (err) {
      const msg = errMsg(err)
      if (isAbsentNativeError(msg)) {
        nativeAbsent = true
        log.debug('native snapshot absent', { tags: { deviceId }, meta: { error: msg } })
      } else {
        nativeError = err
        const rest = this.fatigue.recordFailure(deviceId, now)
        log.warn('native snapshot failed', {
          tags: { deviceId },
          meta: { error: msg, restMs: rest.restMs, streak: rest.streak },
        })
      }
    }

    // 2. Frame-grab fallback via stream-broker's RTSP restream. Battery-cam
    //    guard: skip only when the native was ABSENT for a battery device AND
    //    no broker is already streaming (dialing would be the first wake-up).
    const skipBrokerForBattery =
      isBatteryDevice && nativeAbsent && !(await this.hasStreamingBrokerForDevice(deviceId))
    if (!skipBrokerForBattery) {
      try {
        const fallback = await this.grabFrameFromBroker(deviceId, effectiveStreamId)
        if (fallback) {
          this.stateFrames.delete(deviceId)
          this.cache.set(deviceId, effectiveStreamId, {
            data: fallback,
            ts: now,
            streamId: effectiveStreamId ?? null,
          })
          // Both capture paths persist. Persisting only the native one would
          // leave every camera served by the broker fallback with nothing to
          // show after a restart — the defect, moved rather than fixed.
          void this.durable.put(deviceId, Buffer.from(fallback.base64, 'base64'))
          return { ok: true, image: fallback }
        }
      } catch (err) {
        log.warn('stream-broker snapshot fallback failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      }
    } else {
      log.debug(
        'snapshot: skipping broker fallback — battery device with absent native and no streaming broker',
        { tags: { deviceId } },
      )
    }

    // 3. Nothing produced a frame. Surface a hard native error; a soft miss
    //    (absent/null native + no broker frame) resolves to an empty success
    //    so the caller applies its own stale-cache fallback.
    if (nativeError) return { ok: false, error: nativeError }
    return { ok: true, image: null }
  }

  /**
   * Pull one JPEG from the device's stream-broker RTSP restream using
   * a short-lived ffmpeg invocation.
   *
   * Stream selection strategy (picks the broker that won't stall):
   *   1. Explicit `preferredStreamId` (user set in per-device settings)
   *      — always honoured, even if currently idle. Operator choice
   *      wins.
   *   2. Auto: highest-quality broker currently in `streaming` state.
   *      This is the whole point — prefer the stream that has active
   *      subscribers (usually `low` for detection, but `mid`/`high`
   *      if WebRTC is watching) so ffmpeg hits a warm pipe and
   *      doesn't race the broker's resume.
   *   3. Fallback: highest-quality enabled entry regardless of status
   *      (will wake a suspended broker — retry-guarded against the
   *      cold-start error).
   *
   * The stream-broker auto-suspends idle streams on the "no demand"
   * signal; snapshots used to default to `high` which was often the
   * first to go idle, racing every snapshot with a broker resume.
   * Now we ask the orchestrator of streams which one is warm and grab
   * from there.
   *
   * Source acquisition is pinned to the cluster's ingest owner (the node
   * the stream-broker actually runs on) instead of the device-scoped
   * `dev.cameraStreams` facade — `dev.cameraStreams` resolves against
   * whichever node the cap-router picks by default, which double-pulls
   * the camera (or dials a hub-local restream that isn't serving) when
   * `ingestNode != hub`. `fetchSnapshotBrokerEntries` does the pinned
   * fetch + owner-relative URL host rewrite; hub-owner + no reachable
   * host is byte-identical to the previous unpinned call.
   */
  private async grabFrameFromBroker(
    deviceId: number,
    preferredStreamId?: string,
  ): Promise<SnapshotImage | null> {
    const prefix = `${deviceId}/`
    const owner = await this.resolveIngestOwner()
    const { entries: deviceEntries, slots: profileSlots } = await fetchSnapshotBrokerEntries(
      this.ctx.api,
      { deviceId, ownerNodeId: owner.ownerNodeId, reachableHost: owner.reachableHost },
    )
    const usable = deviceEntries.filter((e) => e.enabled && !!e.url)
    if (usable.length === 0) return null

    // 1. Explicit preference — try it first without status gating.
    if (preferredStreamId && preferredStreamId !== 'auto') {
      const explicit = usable.find((e) => e.brokerId === `${prefix}${preferredStreamId}`)
      if (explicit) {
        const grabbed = await this.runGrabWithResumeRetry(explicit.url, deviceId)
        if (grabbed) return grabbed
        // Explicit pick failed even after retry — fall through to auto
        // rather than give up. Keeps the snapshot useful when the
        // operator's preferred stream is momentarily unreachable.
        this.ctx.logger.debug('grabFrame: explicit stream failed — falling back to auto', {
          meta: { preferredStreamId },
        })
      }
    }

    // Rank entries by quality (high → mid → low → other).
    const ranked = [...usable].toSorted(
      (a, b) => qualityRank(b.brokerId, prefix) - qualityRank(a.brokerId, prefix),
    )

    // Per-device slot status lookup keyed by brokerId, sourced from the
    // same owner-pinned fetch — `status: 'streaming'` means the broker
    // is warm and an ffmpeg grab is free of dial overhead.
    const statusByBrokerId = new Map<string, ProfileSlot['status']>()
    for (const slot of profileSlots) statusByBrokerId.set(slot.brokerId, slot.status)
    const statuses = ranked.map((e) => ({
      entry: e,
      status: statusByBrokerId.get(e.brokerId) ?? ('idle' as const),
    }))

    // 2. Highest-quality broker currently `streaming` — never a derived.
    //    A derived whose source profile is unassigned reports `streaming`
    //    with zero packets (618 `derived:Mid to low`); ffmpeg then sits on
    //    a 15 s timeout and the connecting poster never moves.
    const warm = pickWarmSnapshotBroker(
      statuses.map((s) => ({
        brokerId: s.entry.brokerId,
        status: s.status,
      })),
      prefix,
    )
    if (warm) {
      const match = statuses.find((s) => s.entry.brokerId === warm.brokerId)
      if (match) {
        const grabbed = await this.runGrabWithResumeRetry(match.entry.url, deviceId)
        if (grabbed) return grabbed
      }
    }

    // 3. Final fallback: wake whichever broker has the highest quality.
    //    Skip derived — same 0-packet stall as the warm shortcut.
    for (const { entry } of statuses) {
      if (isDerivedBrokerId(entry.brokerId, prefix)) continue
      const grabbed = await this.runGrabWithResumeRetry(entry.url, deviceId).catch(() => null)
      if (grabbed) return grabbed
    }
    return null
  }

  /**
   * Cached, TTL-bounded resolution of the cluster's camera-source owner.
   * See `ownerCache` doc for the invalidation story.
   */
  private async resolveIngestOwner(): Promise<IngestOwner> {
    const now = Date.now()
    if (this.ownerCache && now - this.ownerCache.ts < SnapshotAddon.OWNER_CACHE_TTL_MS) {
      return this.ownerCache.owner
    }
    const owner = await this.fetchIngestOwner()
    this.ownerCache = { owner, ts: now }
    return owner
  }

  /**
   * Same graceful degrade as the recorder's `resolveIngestOwner`
   * (`packages/addon-pipeline/src/recorder/addon/index.ts`) — the cap may
   * not be mounted yet (pre-image-release) or the pipeline-orchestrator
   * addon may be absent entirely; either way we fall back to `'hub'`,
   * which is byte-identical to the previous hardcoded hub-only behaviour.
   */
  private async fetchIngestOwner(): Promise<IngestOwner> {
    try {
      return await this.ctx.api.pipelineOrchestrator.getIngestOwner.query()
    } catch (err) {
      this.ctx.logger.warn(
        'snapshot: getIngestOwner unavailable — defaulting to hub (cap not mounted yet?)',
        { meta: { error: errMsg(err) } },
      )
      return { ownerNodeId: 'hub' }
    }
  }

  /**
   * Ffmpeg grab with one retry on the broker-cold-start error
   * signature. Covers the window between "client connected" and
   * "first keyframe" when a suspended broker resumes.
   */
  private async runGrabWithResumeRetry(
    url: string,
    deviceId: number,
  ): Promise<SnapshotImage | null> {
    let ffmpegPath: string
    try {
      ffmpegPath = await this.pinnedFfmpeg()
    } catch (err) {
      // Refused, named per camera — never a PATH `ffmpeg` in its place.
      this.ctx.logger.error('grabFrame refused — no pinned ffmpeg on this node (D540)', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      throw new Error(`grabFrame: no pinned ffmpeg for device ${deviceId} — ${errMsg(err)}`, {
        cause: err,
      })
    }
    let buf: Buffer
    try {
      buf = await this.grabPool.run(() => runFfmpegFrameGrab(ffmpegPath, url, 15000))
    } catch (err) {
      const msg = errMsg(err)
      if (isBrokerColdError(msg)) {
        this.ctx.logger.debug('grabFrame: broker-resume race — retrying in 1500ms', {
          tags: { deviceId },
        })
        await new Promise((r) => setTimeout(r, 1500))
        buf = await this.grabPool.run(() => runFfmpegFrameGrab(ffmpegPath, url, 15000))
      } else {
        throw err
      }
    }
    if (buf.length === 0) return null
    return { base64: buf.toString('base64'), contentType: 'image/jpeg' }
  }

  private async invalidateCache(input: { deviceId: number }): Promise<void> {
    this.dropDeviceCaches(input.deviceId)
  }

  /** Forget every cached artefact of one device: frames, derived variants and
   *  any settled single-flight result that would answer the next request. */
  private dropDeviceCaches(deviceId: number): void {
    this.cache.deleteDevice(deviceId)
    this.variants.deleteDevice(deviceId)
    this.stateFrames.delete(deviceId)
    this.wakingDevices.delete(deviceId)
    this.deviceMetaMemo.delete(deviceId)
    this.captureFlight.invalidatePrefix(`${deviceId}:`)
  }

  /**
   * The device is GONE — drop its cached frames and say so.
   *
   * Distinct from `invalidateCache` (a refresh, expected and silent): this is
   * the terminal case, and a deleted camera that keeps answering with its last
   * JPEG looks to an operator exactly like a camera that was never deleted.
   */
  private evictRemovedDevice(
    deviceId: number,
    reason: 'device-unregistered' | 'stale-hit-absent',
  ): void {
    this.dropDeviceCaches(deviceId)
    this.fatigue.forget(deviceId)
    this.ctx.logger.info('snapshot: dropped cache for removed device', {
      tags: { deviceId },
      meta: { reason },
    })
  }

  /**
   * Does device-manager still know this id?
   *
   * `null` means the question could not be answered — a transport hiccup is
   * not a deletion (D49), and the caller keeps serving what it has. Only an
   * explicit "no such device" evicts.
   */
  private async deviceStillExists(deviceId: number): Promise<boolean | null> {
    const api = this.ctx.api
    if (!api) return null
    try {
      const found = await api.deviceManager.getDevice.query({ deviceId })
      return found ? true : false
    } catch (err) {
      this.ctx.logger.debug('snapshot: device existence check failed — keeping cache', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Resolve the state that must be visible on a snapshot.
   *
   * Uses the same two canonical sources as wake-on-play:
   *  1. `deviceManager.getDevice` for the registry's BatteryOperated feature;
   *  2. `deviceState.getCapSlice('battery')` for the durable runtime mirror.
   *
   * A valid battery slice is itself positive evidence that the device is
   * battery-operated. That closes the field failure where "Baby monitor" had a
   * sleeping battery slice but a stale persisted feature projection, so the
   * snapshot wrapper classified it as mains and a Viewer thumbnail logged in
   * to the sleeping camera. The reverse is deliberately not guessed: no
   * feature + no valid slice remains a mains/unknown camera and follows the
   * ordinary capture path.
   *
   * Once battery-operated is established, a missing slice fails safe toward
   * `sleeping` through the shared `deriveBatteryPresence` function. This avoids
   * a background wake without inventing an `unreachable` fault.
   */
  private async resolveSnapshotState(
    deviceId: number,
    meta: SnapshotDeviceMeta | null,
  ): Promise<SnapshotState> {
    if (meta?.disabled === true) return { isBattery: meta.isBattery, reason: 'disabled' }

    const waking = this.isDeviceWaking(deviceId)
    let batteryStatus: BatteryStatus | null = null
    try {
      const raw: unknown = await this.ctx.api.deviceState.getCapSlice.query({
        deviceId,
        capName: batteryCapability.name,
      })
      const parsed = BatteryStatusSchema.safeParse(raw)
      if (parsed.success) batteryStatus = parsed.data
    } catch (err) {
      this.ctx.logger.debug('snapshot: battery runtime-state read failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }

    const isBattery = meta?.isBattery === true || batteryStatus !== null || waking
    // The hub's reachability verdict, consulted LAST. Every battery state above
    // outranks it: a sleeping camera is usually unreachable too, and "asleep"
    // is both the truer and the kinder sentence — reporting a working camera as
    // a fault is the mirror image of D62's rule.
    const unreachableVerdict: SnapshotState | null =
      meta?.online === false ? { isBattery, reason: 'offline' } : null
    if (!isBattery) return unreachableVerdict ?? { isBattery: false }
    if (waking) return { isBattery: true, reason: 'waking' }

    const presence: BatteryPresence = deriveBatteryPresence({
      status: batteryStatus,
      nowMs: Date.now(),
    })
    if (presence !== 'awake') return { isBattery: true, reason: presence }
    return unreachableVerdict ?? { isBattery: true }
  }

  private isDeviceWaking(deviceId: number): boolean {
    const startedAt = this.wakingDevices.get(deviceId)
    if (startedAt === undefined) return false
    if (Date.now() - startedAt <= SNAPSHOT_WAKING_TTL_MS) return true
    this.wakingDevices.delete(deviceId)
    return false
  }

  /**
   * True when at least one of the device's brokers is actively
   * streaming (status === 'streaming'). Used by the battery-cam guard
   * around `grabFrameFromBroker` to allow the fallback ONLY when
   * grabbing a frame is free (a consumer is already keeping the
   * stream warm). When everything is suspended, the fallback would
   * dial the camera and wake it — defeats the sleeping cache.
   *
   * Pinned to the ingest owner via `fetchSnapshotBrokerEntries` — same
   * rationale as `grabFrameFromBroker`: the device-scoped
   * `dev.cameraStreams` facade resolves against whichever node the
   * cap-router picks by default, which is wrong once `ingestNode !=
   * hub` (queries the hub for slots that only exist on the agent,
   * always reporting no streaming broker). Owner === hub (no reachable
   * host) is byte-identical to the previous unpinned call.
   */
  private async hasStreamingBrokerForDevice(deviceId: number): Promise<boolean> {
    try {
      const owner = await this.resolveIngestOwner()
      const { slots } = await fetchSnapshotBrokerEntries(this.ctx.api, {
        deviceId,
        ownerNodeId: owner.ownerNodeId,
        reachableHost: owner.reachableHost,
      })
      return slots.some((s) => s.status === 'streaming')
    } catch {
      return false
    }
  }

  /**
   * Cache-only batch overview — O(n) over the in-memory cache, NEVER triggers
   * a capture. Lets a grid skip requesting images for devices that never
   * produced a frame, and hands each an ETag for conditional image fetches.
   */
  private getSnapshotOverview(input: { deviceIds: number[] }): Promise<SnapshotOverviewRow[]> {
    const now = Date.now()
    const rows = input.deviceIds.map((deviceId): SnapshotOverviewRow => {
      const hit = this.cache.latest(deviceId)
      if (!hit) return { deviceId, lastCapturedAt: null, cacheAgeMs: null, etag: null }
      return {
        deviceId,
        lastCapturedAt: hit.ts,
        cacheAgeMs: now - hit.ts,
        etag: `"${deviceId}-${hit.ts}"`,
      }
    })
    return Promise.resolve(rows)
  }

  /**
   * Diagnostic status for the `status` auto-injected cap method. Reports
   * the cache bookkeeping for this device — when the last snapshot was
   * captured, how stale the cached image is, its size, and which stream
   * was used. Returns null when the device has never been captured
   * (cache miss) since the addon started.
   */
  private async getStatus(deviceId: number): Promise<{
    lastCapturedAt: number | null
    cacheAgeMs: number | null
    lastBytes: number | null
    lastStreamId: string | null
  } | null> {
    const hit = this.cache.latest(deviceId)
    if (!hit) return null
    return {
      lastCapturedAt: hit.ts,
      cacheAgeMs: Date.now() - hit.ts,
      lastBytes: hit.data.base64.length, // approx bytes = base64 length * 3/4, but length is stable enough
      lastStreamId: hit.streamId,
    }
  }

  // ── DeviceSettingsContribution ────────────────────────────────────────
  //
  // Snapshot carries two per-device knobs:
  //   - `snapshotStreamId` — which stream to prefer when grabbing frames
  //     (empty = auto / default "main")
  //   - `snapshotDebug` — extra logging for troubleshooting snapshot paths
  //
  // Storage uses the addon's own per-device store (`ctx.settings
  // .writeDeviceStore`), not the device's config. The schema isn't
  // captured in a Zod object: the keys are optional and the UI layer
  // validates shapes.

  private async readDeviceSettings(deviceId: number): Promise<SnapshotDeviceSettings> {
    if (!this.ctx.settings) return {}
    const raw = await this.ctx.settings.readDeviceStore(deviceId)
    const rawAge = raw['snapshotMaxAgeS']
    const maxAgeS =
      typeof rawAge === 'number' && rawAge >= 0 && Number.isFinite(rawAge) ? rawAge : undefined
    return {
      snapshotStreamId:
        typeof raw['snapshotStreamId'] === 'string' ? raw['snapshotStreamId'] : undefined,
      snapshotDebug: raw['snapshotDebug'] === true,
      ...(maxAgeS !== undefined ? { snapshotMaxAgeS: maxAgeS } : {}),
    }
  }

  private async buildDeviceSettingsContribution(
    deviceId: number,
  ): Promise<ConfigUISchemaWithValues | null> {
    // Camera-only — snapshot settings are meaningless on Lights /
    // Switches / Sensors / Buttons, and surfacing the section there
    // produces ghost top-tabs (the device-detail UI builds the tab
    // list off the contribution sections). Source-side gate keeps the
    // policy with the addon that owns the cap; the admin-ui no longer
    // needs the symmetric `device-section-policy` allow-list.
    const meta = await this.lookupDeviceMeta(deviceId)
    if (meta && meta.type !== DeviceType.Camera) return null
    const current = await this.readDeviceSettings(deviceId)
    const streamOptions = await this.getStreamOptions(deviceId)
    const isBattery = await this.isDeviceBattery(deviceId)
    const defaultMaxAgeS = isBattery ? BATTERY_DEFAULT_MAX_AGE_S : NON_BATTERY_DEFAULT_MAX_AGE_S
    return {
      sections: [
        {
          id: 'snapshot-preferences',
          title: 'Snapshot',
          titleKey: 'server:deviceSettingsContribution.s_snapshot-preferences.title',
          tab: 'snapshot',
          order: 60,
          fields: [
            {
              type: 'select' as const,
              key: 'snapshotStreamId',
              label: 'Preferred stream',
              labelKey:
                'server:deviceSettingsContribution.s_snapshot-preferences.snapshotStreamId.label',
              description: 'Stream used when grabbing a snapshot',
              descriptionKey:
                'server:deviceSettingsContribution.s_snapshot-preferences.snapshotStreamId.description',
              options: streamOptions,
              required: true,
              value: current.snapshotStreamId || 'auto',
            },
            {
              type: 'number' as const,
              key: 'snapshotMaxAgeS',
              label: 'Max cache age (s)',
              labelKey:
                'server:deviceSettingsContribution.s_snapshot-preferences.snapshotMaxAgeS.label',
              description:
                `Serve cached snapshot up to this age before re-capturing. Default ${defaultMaxAgeS}s for ` +
                `${isBattery ? 'battery cams (avoids gratuitous wake-ups)' : 'non-battery cams (live-feel)'}. ` +
                'The UI refresh button always forces a fresh capture regardless of this value.',
              min: 0,
              max: 24 * 3600,
              step: 1,
              value: current.snapshotMaxAgeS ?? defaultMaxAgeS,
            },
            {
              type: 'boolean' as const,
              key: 'snapshotDebug',
              label: 'Debug logging',
              labelKey:
                'server:deviceSettingsContribution.s_snapshot-preferences.snapshotDebug.label',
              description: 'Log stream selection and timing details for this device.',
              descriptionKey:
                'server:deviceSettingsContribution.s_snapshot-preferences.snapshotDebug.description',
              value: current.snapshotDebug ?? false,
            },
          ],
        },
      ],
    }
  }

  /**
   * The frame a camera that CANNOT capture answers with.
   *
   * Returns null only if rendering itself fails — the caller then falls through
   * to its previous behaviour, so a broken courtesy path degrades to the old
   * 404 rather than masking a real capture failure as a placeholder.
   *
   * Rendered at the full tile size; the existing resize ladder derives the
   * card-sized variants from it exactly as it does for a real frame, so no
   * downstream consumer needs to know this frame is synthetic.
   */
  private async courtesyFrame(
    deviceId: number,
    reason: CourtesyReason,
    deviceName: string,
  ): Promise<Buffer | null> {
    const width = COURTESY_DEFAULT_WIDTH
    const height = Math.round((width * 9) / 16)
    const key = courtesyCacheKey({ deviceName, reason, width, height })
    const cached = this.courtesyFrames.get(key)
    if (cached !== undefined) return cached
    try {
      const bytes = await renderCourtesyJpeg({ deviceName, reason, width, height })
      this.courtesyFrames.set(key, bytes)
      return bytes
    } catch (err) {
      this.ctx.logger.warn('snapshot: courtesy frame failed — falling back to no image', {
        tags: { deviceId },
        meta: { reason, error: errMsg(err) },
      })
      return null
    }
  }

  /** A courtesy frame shaped as the cap's response, or null when unrenderable. */
  private async courtesyImage(
    deviceId: number,
    reason: CourtesyReason,
    deviceName: string | undefined,
  ): Promise<SnapshotImage | null> {
    const bytes = await this.courtesyFrame(deviceId, reason, deviceName ?? `#${String(deviceId)}`)
    return bytes === null ? null : { base64: bytes.toString('base64'), contentType: 'image/jpeg' }
  }

  /**
   * The answer for a camera the hub cannot reach: its last good frame, with
   * `Offline` painted over it, and `offline` stamped on the response identity.
   *
   * Called only AFTER the ladder has run (offline is not in
   * {@link CAPTURE_BLOCKING_REASONS}), so this dresses a frame that could not be
   * refreshed — never one that just landed.
   *
   * The `stateReason` is set FIRST and unconditionally, because it is what a
   * surface labels the tile from and what puts `offline` in the ETag: a client
   * holding the live frame has to see a new identity the moment the camera
   * drops, or it paints the unlabelled photograph until the camera comes back.
   * A failed render therefore degrades to the raw frame rather than to nothing —
   * the metadata still says offline, so the tile is still honest.
   */
  private async offlineImage(
    deviceId: number,
    deviceName: string | undefined,
    hit: SnapshotCacheEntry | undefined,
    resolutionMeta?: SnapshotResolutionMeta,
  ): Promise<SnapshotImage | null> {
    if (resolutionMeta) resolutionMeta.stateReason = 'offline'
    this.ctx.logger.debug('snapshot: serving the offline treatment', {
      tags: { deviceId },
      meta: { hasCache: hit !== undefined, ageMs: hit ? Date.now() - hit.ts : null },
    })
    const treated = await this.stateImage(deviceId, 'offline', deviceName, hit)
    return treated ?? hit?.data ?? null
  }

  /**
   * Render a state-labelled answer. A cached real frame is the background, not
   * the answer by itself; if it cannot be decoded, fall back to the generated
   * courtesy background rather than leaking an unlabelled stale frame.
   */
  /** The persisted frame as a cache entry, with its real age. */
  private async durableEntry(deviceId: number): Promise<SnapshotCacheEntry | undefined> {
    const dated = await this.durable.getDated(deviceId)
    if (dated === null) return undefined
    this.ctx.logger.debug('snapshot: serving the frame kept from a previous process', {
      tags: { deviceId },
      meta: { ageMs: Date.now() - dated.capturedAtMs },
    })
    return {
      data: { base64: dated.jpeg.toString('base64'), contentType: 'image/jpeg' },
      ts: dated.capturedAtMs,
      streamId: null,
    }
  }

  private async stateImage(
    deviceId: number,
    reason: SnapshotStateReason,
    deviceName: string | undefined,
    hit: SnapshotCacheEntry | undefined,
  ): Promise<SnapshotImage | null> {
    const resolvedName = deviceName ?? `#${String(deviceId)}`
    if (!hit) return await this.courtesyImage(deviceId, reason, resolvedName)

    const key = `${String(hit.ts)}:${hit.streamId ?? 'auto'}:${reason}:${resolvedName}`
    const deviceFrames = this.stateFrames.get(deviceId) ?? new Map<string, Buffer>()
    this.stateFrames.set(deviceId, deviceFrames)
    const cached = deviceFrames.get(key)
    if (cached !== undefined) {
      return { base64: cached.toString('base64'), contentType: 'image/jpeg' }
    }

    try {
      const bytes = await renderCourtesyOverlayJpeg(Buffer.from(hit.data.base64, 'base64'), {
        deviceName: resolvedName,
        reason,
      })
      deviceFrames.set(key, bytes)
      return { base64: bytes.toString('base64'), contentType: 'image/jpeg' }
    } catch (err) {
      this.ctx.logger.warn('snapshot: state overlay failed — using generated courtesy background', {
        tags: { deviceId },
        meta: { reason, error: errMsg(err) },
      })
      return await this.courtesyImage(deviceId, reason, resolvedName)
    }
  }

  /**
   * Single-trip device lookup against device-manager — memoized for
   * {@link DEVICE_META_MEMO_MS} (promise-keyed, so bursts single-flight).
   * Registry facts only; nothing battery-runtime lives here, so the TTL never
   * masks a sleep/wake transition. Announced changes evict immediately (the
   * `device.*` subscriptions in `onInitialize`); the TTL bounds silent drift.
   */
  private lookupDeviceMeta(deviceId: number): Promise<SnapshotDeviceMeta | null> {
    const hit = this.deviceMetaMemo.get(deviceId)
    if (hit !== undefined && Date.now() - hit.ts < DEVICE_META_MEMO_MS) return hit.promise
    const promise = this.fetchDeviceMeta(deviceId)
    this.deviceMetaMemo.set(deviceId, { ts: Date.now(), promise })
    return promise
  }

  /**
   * The actual `deviceManager.getDevice` round trip behind
   * {@link lookupDeviceMeta}. Returns the stable registry fields the wrapper
   * consults. Battery classification is completed by `resolveSnapshotState`
   * from this feature flag PLUS the canonical runtime-state mirror, so a stale
   * persisted feature projection cannot authorize a snapshot dial against a
   * known sleeping battery camera.
   *
   * Logged at debug + null return on failure: every call site already
   * has a sensible fallback path (cache hit, conservative default, …),
   * so we don't want a transient device-manager hiccup to throw.
   */
  private async fetchDeviceMeta(deviceId: number): Promise<SnapshotDeviceMeta | null> {
    const api = this.ctx.api
    if (!api) return null
    try {
      const found = await api.deviceManager.getDevice.query({ deviceId })
      if (!found) return null
      const features = (found.features as readonly string[] | undefined) ?? []
      const rawType = (found as { type?: string }).type
      // `disabled` and `online` drive the courtesy frame. Read from the same
      // single trip rather than a second query: a camera the operator switched
      // off must be REPORTED off ([D62]), and until 2026-08-11 this layer could
      // not tell "off" from "broken" because it never asked.
      const row = found as { disabled?: unknown; online?: unknown }
      return {
        ...(found.name ? { name: found.name } : {}),
        isBattery: features.includes(DeviceFeature.BatteryOperated),
        ...(rawType ? { type: rawType as DeviceType } : {}),
        disabled: row.disabled === true,
        // Absent `online` means "no opinion" — treat as up. Only an explicit
        // `false` is a device the hub believes is unreachable.
        online: row.online !== false,
      }
    } catch (err) {
      this.ctx.logger.debug('deviceManager.getDevice failed during snapshot', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  /** Settings-UI helper — battery flag drives the default max-age in the field description. */
  private async isDeviceBattery(deviceId: number): Promise<boolean> {
    const meta = await this.lookupDeviceMeta(deviceId)
    return (await this.resolveSnapshotState(deviceId, meta)).isBattery
  }

  /**
   * Feeds the settings-UI stream picker. Pinned to the ingest owner via
   * `fetchSnapshotBrokerEntries` — the device-scoped `dev.cameraStreams`
   * facade this used to call resolves against whichever node the
   * cap-router picks by default, which is empty once `ingestNode !=
   * hub` (the picker would render nothing but "Auto"). Owner === hub
   * (no reachable host) is byte-identical to the previous unpinned call.
   */
  private async getStreamOptions(
    deviceId: number,
  ): Promise<Array<{ value: string; label: string }>> {
    const prefix = `${deviceId}/`
    try {
      const owner = await this.resolveIngestOwner()
      const { entries } = await fetchSnapshotBrokerEntries(this.ctx.api, {
        deviceId,
        ownerNodeId: owner.ownerNodeId,
        reachableHost: owner.reachableHost,
      })
      const streamIds = entries.filter((e) => e.enabled).map((e) => e.brokerId.slice(prefix.length))
      return [
        { value: 'auto', label: 'Auto' },
        ...streamIds.map((id) => ({ value: id, label: streamQualityLabel(id) })),
      ]
    } catch (err) {
      this.ctx.logger.error('getStreamOptions failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return [{ value: 'auto', label: 'Auto' }]
    }
  }

  private async saveDeviceSettingsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<{ success: true }> {
    if (!this.ctx.settings) {
      throw new Error('[snapshot] settings store unavailable — cannot persist per-device settings')
    }
    const current = await this.ctx.settings.readDeviceStore(deviceId)
    const next: Record<string, unknown> = { ...current }
    if ('snapshotStreamId' in patch) {
      const v = patch['snapshotStreamId']
      next['snapshotStreamId'] = typeof v === 'string' && v.trim().length > 0 ? v.trim() : ''
    }
    if ('snapshotDebug' in patch) {
      next['snapshotDebug'] = patch['snapshotDebug'] === true
    }
    if ('snapshotMaxAgeS' in patch) {
      const v = patch['snapshotMaxAgeS']
      // Persist a finite non-negative number; anything else (null,
      // undefined, NaN, negative) falls back to the per-device
      // default at read time.
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        next['snapshotMaxAgeS'] = v
      } else {
        delete next['snapshotMaxAgeS']
      }
    }
    await this.ctx.settings.writeDeviceStore(deviceId, next)
    // Drop the cache + held flight so the next `getSnapshot` applies the new
    // stream/debug flags instead of serving a coalesced pre-change capture.
    this.cache.deleteDevice(deviceId)
    this.variants.deleteDevice(deviceId)
    this.captureFlight.invalidatePrefix(`${deviceId}:`)
    return { success: true as const }
  }
}

function isAbsentNativeError(msg: string): boolean {
  return msg.includes('no provider for') || msg.includes('no native provider for capability')
}

/** Result of {@link fetchSnapshotBrokerEntries} — this device's RTSP entries + profile slots. */
interface SnapshotBrokerEntries {
  readonly entries: readonly RtspRestreamEntry[]
  readonly slots: readonly ProfileSlot[]
}

/**
 * Pinned, testable fetch of this device's RTSP restream entries + profile
 * slots from the system `streamBroker` cap. Module-level (not a class
 * method) so `grabFrameFromBroker`'s owner-pin + host-rewrite contract is
 * directly unit-testable without instantiating the addon — mirrors
 * `acquireSessionDecodeRestreamFrom` in `pipeline-runner/index.ts`.
 *
 * Replaces the former `dev.cameraStreams.getRtspEntries({})` /
 * `getBrokerStreams({})` device-scoped facade calls, which resolve against
 * whichever node the cap-router picks by default — wrong once
 * `ingestNode != hub` (double-pulls the camera, or dials a hub-local
 * restream nobody is serving). `getAllRtspEntries`/`listAllProfileSlots`
 * are cluster-wide system-cap methods; pinning the call with `nodePin` +
 * filtering by the `${deviceId}/` brokerId prefix reproduces the exact
 * device-scoped result set the facade used to return.
 *
 * `reachableHost`, when present, rides as the cap's own `hostname` input —
 * the broker rewrites the returned URLs' host itself (same mechanism
 * `getStreamWithCodec` callers use for cross-node pulls), so no separate
 * client-side host-substitution is needed here. Omitting `hostname`
 * (owner === hub, no reachable host registered) leaves the broker's
 * default `127.0.0.1` URLs untouched — byte-identical to today.
 */
export async function fetchSnapshotBrokerEntries(
  api: AddonApi,
  params: {
    readonly deviceId: number
    readonly ownerNodeId: string
    readonly reachableHost?: string
  },
): Promise<SnapshotBrokerEntries> {
  const { deviceId, ownerNodeId, reachableHost } = params
  const prefix = `${deviceId}/`
  const pin = nodePin(ownerNodeId)
  const [allEntries, allSlots] = await Promise.all([
    api.streamBroker.getAllRtspEntries.query(
      reachableHost !== undefined ? { hostname: reachableHost } : {},
      pin,
    ),
    api.streamBroker.listAllProfileSlots.query(undefined, pin),
  ])
  return {
    entries: allEntries.filter((e) => e.brokerId.startsWith(prefix)),
    slots: allSlots.filter((s) => s.deviceId === deviceId),
  }
}

/**
 * Quality ordering for broker picker: `high` > `mid` > `low` > other.
 * The streamId is the suffix after `${deviceId}/` in the brokerId.
 * Unknown labels fall through to 0 so they land at the bottom of the
 * preference list without crashing.
 */
function qualityRank(brokerId: string, prefix: string): number {
  const streamId = brokerId.startsWith(prefix) ? brokerId.slice(prefix.length) : brokerId
  const normalized = streamId.toLowerCase()
  if (normalized.includes('high') || normalized === 'main' || normalized === 'hd') return 3
  if (normalized.includes('mid') || normalized === 'medium') return 2
  if (normalized.includes('low') || normalized === 'sub' || normalized === 'sd') return 1
  return 0
}

/**
 * Detect ffmpeg failure signatures that indicate the broker wasn't
 * streaming yet when we tried to read its RTSP restream — a race
 * window that closes as soon as the broker lands its first keyframe.
 * Used by `grabFrameFromBroker` to retry once instead of giving up.
 */
function isBrokerColdError(msg: string): boolean {
  return (
    msg.includes('Invalid data found when processing input') ||
    msg.includes('Error opening input') ||
    msg.includes('Connection refused') ||
    msg.includes('No route to host')
  )
}

function runFfmpegFrameGrab(ffmpegPath: string, url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // ── IDR-first snapshot ────────────────────────────────────────────────
    //
    // `-skip_frame nokey` decodes only keyframes — the first frame handed
    // to the MJPEG encoder is guaranteed to be a complete IDR with all
    // references present, so the JPEG can't come out as a half-decoded
    // delta (the "green stripe" a non-keyframe decode produces).
    //
    // `-fflags +discardcorrupt` drops corrupt packets that slipped in
    // before sync — otherwise they propagate as green/gray smears into
    // the decoded output.
    //
    // No `-analyzeduration` / `-probesize` override: the old values
    // (5_000_000 µs = 5 s) forced ffmpeg to buffer 5 s of RTP before
    // decoding even when a keyframe was already in hand, which stacked
    // with a cold stream-broker's upstream handshake and pushed the
    // snapshot past the caller's ffmpeg timeout. Defaults are fine —
    // `-skip_frame nokey` + `-frames:v 1` already bound the work to a
    // single keyframe.
    const child = execFile(
      ffmpegPath,
      [
        '-loglevel',
        'error',
        // ── ONE thread, and one filter thread ──────────────────────────────
        //
        // ffmpeg sizes its codec threads AND libavfilter's slice pool to the
        // core count, independently, per child. On this 20-core hub a grab that
        // decodes a SINGLE keyframe was measured holding 35 threads, and the
        // container's pid cgroup counts every one of them against a 2048
        // ceiling it was already hitting — 22 refused thread creations in 45
        // minutes on 2026-09-18, which cost a lost subject tile on camera 107
        // and a dead Alexa egress, none of it announced as "out of pids".
        //
        // One keyframe is not a parallel job: measured 35 -> 4 threads with no
        // change to the time it takes.
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-rtsp_transport',
        'tcp',
        '-fflags',
        '+discardcorrupt',
        '-skip_frame',
        'nokey',
        '-i',
        url,
        '-vf',
        'select=eq(pict_type\\,I)',
        '-vsync',
        'vfr',
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          // `execFile`'s default Error carries "Command failed: …" plus a
          // `code`/`signal` that Node fills in. ffmpeg with `-loglevel
          // error` is silent on RTSP-level failures; when the parent
          // kills the child on timeout, `killed === true` and stderr is
          // empty. Surface both sides so the log tells the real story.
          const errWithMeta = err as Error & {
            code?: string | number
            signal?: string | null
            killed?: boolean
          }
          const stderrText = Buffer.isBuffer(stderr)
            ? stderr.toString('utf8').trim()
            : String(stderr ?? '').trim()
          const parts: string[] = [err instanceof Error ? err.message : String(err)]
          if (errWithMeta.killed) parts.push('killed=true')
          if (errWithMeta.code !== undefined) parts.push(`code=${String(errWithMeta.code)}`)
          if (errWithMeta.signal) parts.push(`signal=${errWithMeta.signal}`)
          if (stderrText) parts.push(`stderr: ${stderrText.slice(0, 500)}`)
          reject(new Error(parts.join(' — ')))
          return
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
    child.on('error', (e: Error) => reject(e))
  })
}
