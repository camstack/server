/**
 * Extensible per-device event kinds (Part B).
 *
 * `composeEventKinds` builds the `listEventKinds` payload for a camera:
 *   (a) built-ins — motion + audio, always present;
 *   (b) detection classes actually OBSERVED on the device (track history);
 *   (c) sensor kinds contributed by the camera's OWN bindings and by its
 *       LINKED devices (device-manager `getLinkedDevices`), one descriptor per
 *       bound sensor cap present in the static `EVENT_KIND_BY_CAP` map.
 *       Binding-driven per device (`getBindings`) — never a global cap
 *       enumeration (D12).
 *
 * `LinkedCamerasCache` is the ingest-side reverse index (sensor device →
 * linked camera ids, plus the camera id set) with a TTL, so the
 * `DeviceStateChanged` handler stays cheap at bus rate.
 */
import { randomUUID } from 'node:crypto'
import type { EventKindDescriptor, EventKindsForDevice, SensorEvent } from '@camstack/types'
import { buildEventKindDescriptor, EVENT_KIND_BY_CAP, subKindsOf } from '@camstack/types'

// ── Thin client surfaces (subset of ctx.api the module consumes; tests mock these) ──

export interface LinkedDeviceEntry {
  readonly deviceId: number
  readonly name: string
  readonly location: string | null
  readonly features: readonly string[]
  /** Whether a state change on this linked device materializes a synthetic
   *  tracked event on the camera (device-manager `producesTrackedEvents`,
   *  S0). device-manager always sends the boolean and it defaults to `false`
   *  (opt-in); only an absent field — an older peer — is read as `true`. */
  readonly producesTrackedEvents?: boolean
}

export interface LinkedDevicesClient {
  getLinkedDevices(input: {
    deviceId: number
  }): Promise<{ mode: 'auto' | 'manual'; devices: readonly LinkedDeviceEntry[] }>
}

export interface DeviceBindingsClient {
  getBindings(input: { deviceId: number }): Promise<{ entries: ReadonlyArray<{ capName: string }> }>
}

/** Enumerate the camera deviceIds the reverse index should cover. */
export interface CameraListClient {
  listCameraIds(): Promise<readonly number[]>
}

// ── Self-camera sensor caps ──────────────────────────────────────────

/**
 * Mapped sensor/control caps that a CAMERA must NOT contribute for ITSELF.
 *
 * A sensor cap bound on a camera makes the camera both the source and the
 * subject — a composed doorbell on camera 101 (D671), a native Reolink
 * doorbell, a camera-side button. Those have no other route into the per-camera event
 * substrate, so the camera includes itself.
 *
 * `motion` is the exception, and today the ONLY one: camera motion already
 * has a dedicated camera-native path (`MotionAnalysis` /
 * `MotionOnMotionChanged` → `MotionEvent` rows under the built-in `motion`
 * taxonomy lane). Every real camera provider registers a native `motion` cap
 * on the camera device, so self-inclusion would mint a SECOND, differently
 * named copy (`motion-sensor`) of every motion transition, at motion rate.
 *
 * Add a cap here only when the camera already emits that event through
 * another ingest path — never to reduce noise.
 */
const SELF_CAMERA_EXCLUDED_CAPS: ReadonlySet<string> = new Set(['motion'])

/** True when a camera may contribute `capName` for itself. */
function selfCameraMayEmit(capName: string): boolean {
  return !SELF_CAMERA_EXCLUDED_CAPS.has(capName)
}

// ── Composition (pipeline-can-emit, config-derived) ──────────────────

export interface ComposeEventKindsDeps {
  readonly linkedDevices: LinkedDevicesClient
  readonly bindings: DeviceBindingsClient
  /**
   * Detection MACRO classes the camera's ENABLED detection pipeline can
   * emit (e.g. ['person','vehicle','animal']). Each macro expands into its
   * macro descriptor + every taxonomy SUB (reverse COCO): vehicle →
   * car/truck/bus/… — pipeline-CAN-emit, not observed. Empty when detection
   * is disabled (honest: the camera advertises none of those kinds).
   */
  readonly enabledMacroClasses: (deviceId: number) => Promise<readonly string[]>
  /** True when the camera's audio classifier step is enabled. */
  readonly audioEnabled: (deviceId: number) => Promise<boolean>
  /**
   * True when the camera has ≥1 ENABLED `package`-stage zone rule — gates
   * the package kinds so the timeline lane appears exactly on the cameras
   * configured for package drops. See package-zones-design §3.4.
   */
  readonly packageZonesEnabled?: (deviceId: number) => Promise<boolean>
  readonly onError?: (scope: string, err: unknown) => void
}

/**
 * Full event-kind taxonomy a camera CAN emit (config-derived):
 *   (a) motion built-in — always;
 *   (b) each enabled detection macro + its taxonomy subs (reverse COCO);
 *   (c) audio macro + its subs when the classifier is enabled;
 *   (d) package kinds when a package zone rule is enabled;
 *   (e) sensor/control kinds from the CAMERA'S OWN bindings and from its
 *       LINKED devices (binding-driven), deduped per (kind, source deviceId).
 * Every descriptor carries parentKind/level/iconId/labelKey via the single
 * taxonomy dictionary — no color/icon is declared here.
 */
/**
 * Run one lookup, reporting a failure instead of propagating it.
 *
 * `undefined` means "this one did not answer" — the caller degrades that part
 * of the taxonomy and keeps the rest. That is the pre-existing contract (each
 * section had its own try/catch); it is factored out here only because the
 * sections now run concurrently, and a rejected promise nobody has awaited yet
 * is an unhandled rejection.
 */
async function attempt<T>(
  deps: Pick<ComposeEventKindsDeps, 'onError'>,
  scope: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    deps.onError?.(scope, err)
    return undefined
  }
}

export async function composeEventKinds(
  deps: ComposeEventKindsDeps,
  deviceId: number,
): Promise<readonly EventKindDescriptor[]> {
  const out: EventKindDescriptor[] = []
  const cameraSource = { capName: 'pipeline-analytics', deviceId }
  const pushKind = (kind: string, source = cameraSource): void => {
    const d = buildEventKindDescriptor(kind, source)
    if (d !== null) out.push(d)
  }

  // (b)…(e) depend on nothing from each other, so they are ISSUED together and
  // read in order below. Every one of them is a cross-process round-trip; run
  // in sequence they made this the slowest per-device query on the hub (~100 ms
  // against 6–11 ms for its neighbours) and the viewer calls it once per
  // camera at boot. The `out` order is unchanged — the timeline lanes render
  // in it — because the pushes still happen in the original sequence.
  const macrosP = attempt(deps, 'enabledMacroClasses', () => deps.enabledMacroClasses(deviceId))
  const audioP = attempt(deps, 'audioEnabled', () => deps.audioEnabled(deviceId))
  const packageP = attempt(deps, 'packageZonesEnabled', async () =>
    deps.packageZonesEnabled ? deps.packageZonesEnabled(deviceId) : false,
  )
  const linkedP = attempt(deps, 'getLinkedDevices', () =>
    deps.linkedDevices.getLinkedDevices({ deviceId }),
  )
  // The camera's OWN bindings: a sensor/control cap can be bound on the camera
  // itself (composed doorbell, native doorbell), and the camera is then the
  // source of its own device events.
  const selfBindingsP = attempt(deps, 'getBindings', () => deps.bindings.getBindings({ deviceId }))

  // (a) Motion built-in.
  pushKind('motion')

  // (b) Enabled detection macros + their subs (pipeline-can-emit).
  for (const macro of (await macrosP) ?? []) {
    pushKind(macro)
    for (const sub of subKindsOf(macro)) pushKind(sub.kind)
  }

  // (c) Audio macro + subs when the classifier is enabled.
  if ((await audioP) === true) {
    pushKind('audio')
    for (const sub of subKindsOf('audio')) pushKind(sub.kind)
  }

  // (d) Package kinds — gated by an enabled package-zone rule.
  if ((await packageP) === true) {
    pushKind('package')
    for (const sub of subKindsOf('package')) pushKind(sub.kind)
  }

  // (e) Sensor/control kinds from the camera ITSELF and from its LINKED
  // devices — binding-driven per device. One `getBindings` per device, all in
  // flight at once: serially this was N more round-trips on top of the four
  // above. `Promise.all` preserves order, so the dedupe and the output stay
  // byte-identical to the loop.
  const devices = (await linkedP)?.devices ?? []
  const bindingsPerDevice = await Promise.all(
    devices.map((linked) =>
      attempt(deps, 'getBindings', () => deps.bindings.getBindings({ deviceId: linked.deviceId })),
    ),
  )
  const seen = new Set<string>()
  const pushSensorKinds = (
    sourceDeviceId: number,
    entries: ReadonlyArray<{ readonly capName: string }> | undefined,
    isSelf: boolean,
  ): void => {
    // `undefined` means this device's lookup failed — already reported through
    // `onError`. Skipping it drops one sensor's lanes, never the whole camera's.
    if (entries === undefined) return
    for (const { capName } of entries) {
      if (isSelf && !selfCameraMayEmit(capName)) continue
      const descriptor = EVENT_KIND_BY_CAP[capName]
      if (descriptor === undefined) continue
      const dedupeKey = `${descriptor.kind}:${sourceDeviceId}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      pushKind(descriptor.kind, { capName, deviceId: sourceDeviceId })
    }
  }
  pushSensorKinds(deviceId, (await selfBindingsP)?.entries, true)
  for (const [index, linked] of devices.entries()) {
    pushSensorKinds(linked.deviceId, bindingsPerDevice[index]?.entries, false)
  }

  return out
}

// ── Ingest-side reverse index (sensor device → linked cameras) ───────

/** Resolve the linked set for MANY cameras in one device-manager call. */
export interface LinkedDevicesBatchClient {
  getLinkedDevicesBatch(input: { deviceIds: number[] }): Promise<
    readonly {
      readonly deviceId: number
      readonly devices: readonly LinkedDeviceEntry[]
    }[]
  >
}

export interface LinkedCamerasCacheDeps {
  readonly cameras: CameraListClient
  readonly linkedDevices: LinkedDevicesClient
  /**
   * Preferred rebuild path — see {@link LinkedCamerasCache.rebuild}. Optional
   * because this addon deploys on its own and can be running against a hub
   * whose `@camstack/server` closure predates `getLinkedDevicesBatch`; absent
   * or rejecting, the per-camera loop still answers.
   */
  readonly linkedDevicesBatch?: LinkedDevicesBatchClient
  readonly ttlMs?: number
  /**
   * A rebuild step failed. `cameraId` is set when the failure is ONE camera's
   * links (the caller tags its line with it); absent for a fleet-wide step
   * (the camera list, the batch).
   */
  readonly onError?: (scope: string, err: unknown, cameraId?: number) => void
}

/**
 * What the camera index could NOT answer, for the line that drops an
 * evaluation because of it.
 */
export interface CameraIndexGap {
  /** False until one camera list has been read. */
  readonly cameraListRead: boolean
  /** Listed cameras whose links have never been read successfully. */
  readonly unansweredCameraIds: readonly number[]
}

const DEFAULT_CACHE_TTL_MS = 60_000

/**
 * TTL-cached reverse index: source deviceId → camera ids it is linked to,
 * plus the camera id SET the index was built from (so the ingest can ask
 * "is this device itself a camera" without a second enumeration).
 * Rebuilds lazily (single-flight) when stale, so the `DeviceStateChanged`
 * handler pays one map lookup per event in the common case.
 */
export class LinkedCamerasCache {
  private readonly deps: LinkedCamerasCacheDeps
  private readonly ttlMs: number
  private index = new Map<number, readonly number[]>()
  /**
   * source deviceId → EVERY camera that has it among its linked devices,
   * ignoring the tracked-events opt-in. Built in the same loop as
   * {@link index}; the opt-in governs timeline rows only.
   */
  private allIndex = new Map<number, readonly number[]>()
  /** Every camera id seen by the last successful build. */
  private cameras = new Set<number>()
  /**
   * Each camera's links as last READ successfully. A later rebuild that cannot
   * read a camera's links carries these forward rather than dropping them: the
   * mirror stays authoritative until something contradicts it (D49).
   */
  private linksByCamera = new Map<number, readonly LinkedDeviceEntry[]>()
  /** False until a camera list has been read once. A later failed list keeps
   *  the previous index, and this stays true. */
  private cameraListRead = false
  /** Listed cameras whose links have NEVER been read. Non-empty (or no camera
   *  list yet) ⇒ the index has not answered: a device absent from it is
   *  UNKNOWN, not unlinked (D49). */
  private unanswered: readonly number[] = []
  /** Ms timestamp of the last build; null = never built / invalidated. */
  private builtAt: number | null = null
  private building: Promise<void> | null = null

  constructor(deps: LinkedCamerasCacheDeps) {
    this.deps = deps
    this.ttlMs = deps.ttlMs ?? DEFAULT_CACHE_TTL_MS
  }

  /** Camera ids linked to `sourceDeviceId` ([] when none). */
  async camerasFor(sourceDeviceId: number, nowMs = Date.now()): Promise<readonly number[]> {
    await this.ensureFresh(nowMs)
    return this.index.get(sourceDeviceId) ?? []
  }

  /**
   * EVERY camera that links `sourceDeviceId`, whether or not it opted the
   * device into tracked events ([] when none). The notification side asks this
   * one; timeline rows ask {@link camerasFor}.
   */
  async allCamerasFor(sourceDeviceId: number, nowMs = Date.now()): Promise<readonly number[]> {
    await this.ensureFresh(nowMs)
    return this.allIndex.get(sourceDeviceId) ?? []
  }

  /**
   * True when the index ANSWERED: a camera list has been read, and every listed
   * camera's links have been read at least once (a camera whose read failed
   * later answers with its last good links). False means an empty answer from the other methods
   * is not knowledge and must not be acted on as "linked to nothing".
   */
  async answered(nowMs = Date.now()): Promise<boolean> {
    await this.ensureFresh(nowMs)
    return this.cameraListRead && this.unanswered.length === 0
  }

  /** What the index could not answer, as of the last build — no refresh. */
  gap(): CameraIndexGap {
    return { cameraListRead: this.cameraListRead, unansweredCameraIds: [...this.unanswered] }
  }

  /**
   * True when `deviceId` is ITSELF a camera. Answered off the same build as
   * {@link camerasFor} — a sensor cap bound on a camera needs both facts in
   * the same event, and a second enumeration would double the cost of the
   * ingest path for nothing.
   */
  async isCamera(deviceId: number, nowMs = Date.now()): Promise<boolean> {
    await this.ensureFresh(nowMs)
    return this.cameras.has(deviceId)
  }

  /** Drop the cached index (e.g. on link-topology change events). */
  invalidate(): void {
    this.builtAt = null
  }

  /** Test/maintenance hook: replace the index directly. */
  seed(
    index: ReadonlyMap<number, readonly number[]>,
    builtAt: number,
    cameraIds: readonly number[] = [],
    allIndex: ReadonlyMap<number, readonly number[]> = index,
  ): void {
    this.index = new Map(index)
    this.allIndex = new Map(allIndex)
    this.cameras = new Set(cameraIds)
    this.builtAt = builtAt
    this.cameraListRead = true
    this.unanswered = []
  }

  /** Rebuild (single-flight) when never built or past the TTL. */
  private async ensureFresh(nowMs: number): Promise<void> {
    if (this.builtAt !== null && nowMs - this.builtAt < this.ttlMs) return
    this.building ??= this.rebuild(nowMs).finally(() => {
      this.building = null
    })
    await this.building
  }

  /**
   * One `getLinkedDevicesBatch` for the whole camera set, or the per-camera
   * loop when the hub cannot answer it.
   *
   * The loop is not merely chattier — every `getLinkedDevices` runs a full
   * fleet listing inside device-manager, and they queue rather than overlap.
   * On the live hub 2026-08-25 this rebuild was ~31 of the ~38 full-fleet
   * sweeps a minute behind 36 814 `query addon-device-settings` calls a
   * minute, for an index that changes when the operator edits a room.
   *
   * A batch that REJECTS falls back rather than emptying the index: a stale
   * reverse index still routes sensor events, an empty one silently routes
   * none. A camera whose links could not be read is simply ABSENT from the
   * returned map — the caller carries its previous links forward.
   */
  private async resolveLinks(
    cameraIds: readonly number[],
  ): Promise<ReadonlyMap<number, readonly LinkedDeviceEntry[]>> {
    const batch = this.deps.linkedDevicesBatch
    if (batch !== undefined && cameraIds.length > 0) {
      try {
        const rows = await batch.getLinkedDevicesBatch({ deviceIds: [...cameraIds] })
        return new Map(rows.map((row) => [row.deviceId, row.devices]))
      } catch (err) {
        this.deps.onError?.('getLinkedDevicesBatch', err)
      }
    }
    const out = new Map<number, readonly LinkedDeviceEntry[]>()
    for (const cameraId of cameraIds) {
      try {
        const { devices } = await this.deps.linkedDevices.getLinkedDevices({ deviceId: cameraId })
        out.set(cameraId, devices)
      } catch (err) {
        this.deps.onError?.('getLinkedDevices', err, cameraId)
      }
    }
    return out
  }

  private async rebuild(nowMs: number): Promise<void> {
    try {
      const cameraIds = await this.deps.cameras.listCameraIds()
      const fresh = await this.resolveLinks(cameraIds)
      // Carry forward: a camera whose links could not be read this time keeps
      // the links it had at its last good read. Only a camera NEVER read
      // leaves the index unanswered.
      const linksByCamera = new Map<number, readonly LinkedDeviceEntry[]>()
      const unanswered: number[] = []
      for (const cameraId of cameraIds) {
        const links = fresh.get(cameraId) ?? this.linksByCamera.get(cameraId)
        if (links === undefined) unanswered.push(cameraId)
        else linksByCamera.set(cameraId, links)
      }
      const next = new Map<number, number[]>()
      const nextAll = new Map<number, number[]>()
      for (const cameraId of cameraIds) {
        for (const d of linksByCamera.get(cameraId) ?? []) {
          // EVERY linking camera — what a notification about this sensor may
          // show (ADR 0632). Built before the opt-in gate below, from the same
          // resolution, so the two indexes cannot disagree about the links.
          const all = nextAll.get(d.deviceId)
          if (all === undefined) nextAll.set(d.deviceId, [cameraId])
          else if (!all.includes(cameraId)) all.push(cameraId)
          // Tracked-events gate (S0): only linked devices the operator marked
          // as producing tracked events materialize synthetic tracks / sensor
          // rows on the camera. device-manager always sends the boolean and it
          // defaults to `false` (opt-in), so this index is "cameras that opted
          // this device into tracked events", not "cameras that link it" —
          // that is `allIndex`.
          // DELIBERATE: opting a device out (`false`) suppresses BOTH its
          // synthetic tracks AND its sensor-event history rows — the device
          // produces NO tracked events at all. This gate is intentionally not
          // narrowed to synthetic tracks only (default = all produce both).
          if (d.producesTrackedEvents === false) continue
          const list = next.get(d.deviceId)
          if (list === undefined) next.set(d.deviceId, [cameraId])
          else if (!list.includes(cameraId)) list.push(cameraId)
        }
      }
      this.index = next
      this.allIndex = nextAll
      this.cameras = new Set(cameraIds)
      this.linksByCamera = linksByCamera
      this.unanswered = unanswered
      this.cameraListRead = true
      this.builtAt = nowMs
    } catch (err) {
      // Keep the previous index — it is still the last thing the hub TOLD us,
      // and a failed read contradicts nothing (D49). It stays an answer if it
      // was one; a cache that never read a camera list stays unanswered.
      // Retry after TTL.
      this.deps.onError?.('listCameraIds', err)
      this.builtAt = nowMs
    }
  }
}

// ── Sensor-event ingest (DeviceStateChanged → per-camera history rows) ──

/** The insert surface the ingest needs (SensorEventStore satisfies it). */
export interface SensorEventSink {
  insert(ev: SensorEvent): Promise<void>
}

/**
 * Why a MAPPED sensor cap produced no rows. Both branches drop work, so both
 * are reported — a device-event that silently ingests nothing is exactly the
 * failure that kept camera 101's doorbell dark.
 */
export type SensorIngestDropReason =
  /**
   * The emitting device is not a camera and no camera takes a timeline row
   * for it: linked to none, or linked only by cameras that did not opt it
   * into tracked events ({@link SensorEventCameras.linkedCameraIds} says
   * which).
   */
  | 'no-camera'
  /**
   * The camera index has not ANSWERED (no camera list read yet, or a listed
   * camera whose links were never read), and the device is in no camera's
   * row set. Unknown is not "unlinked" (D49): nothing is evaluated.
   */
  | 'camera-index-unknown'
  /**
   * The emitting device IS a camera, but the cap already reaches the camera
   * through a dedicated camera-native path (`SELF_CAMERA_EXCLUDED_CAPS`), and
   * it is linked to no other camera either.
   */
  | 'camera-native-cap'

/**
 * The two questions the sensor-cap camera derivation asks of the reverse
 * index. `LinkedCamerasCache` satisfies it; naming the slice lets a caller
 * (or a test) supply exactly what is read and nothing else.
 */
export type SensorCameraLookup = Pick<
  LinkedCamerasCache,
  'camerasFor' | 'allCamerasFor' | 'isCamera' | 'answered'
>

export interface IngestSensorStateDeps {
  readonly sink: SensorEventSink
  readonly cache: SensorCameraLookup
  /** Id factory — injectable for tests. Defaults to `pa-sensor-<uuid>`. */
  readonly makeId?: () => string
  /**
   * Fired AFTER each per-camera row is durably inserted (the Notification
   * Center `device-event` persist hook, D-2). Best-effort / non-blocking; a
   * throw is not propagated (telemetry-lossy ingest must never fail on it).
   */
  readonly onPersisted?: (ev: SensorEvent) => void
  /**
   * Fired when a mapped cap resolved to ZERO cameras. The caller logs it with
   * `tags: { deviceId }` — a dropped device-event must never be silent.
   */
  readonly onDropped?: (reason: SensorIngestDropReason, kind: string) => void
  /**
   * Fired for a state change of a device that is NOT a camera and that no
   * camera takes a timeline row for (`no-camera`, and only once the camera
   * index ANSWERED): linked to no camera, or linked only by cameras that did
   * not opt it into tracked events. The event is the sensor as its own device
   * (`deviceId` and `sourceDeviceId` both the sensor), and NO row is inserted
   * — this is evaluation without persistence, handed to the Notification
   * Center (D630 §6: an unlinked door contact can fire a rule and so trigger
   * the alarm). When present, `onDropped` is NOT fired for `no-camera`.
   *
   * A throw propagates out of the ingest (to the caller's own logged catch).
   */
  readonly onUnowned?: (unowned: UnownedSensorEvent) => void
}

/**
 * A sensor state change no camera takes a timeline row for, handed to the
 * notification side instead of a sink.
 */
export interface UnownedSensorEvent {
  /** The sensor as its own device: `deviceId === sourceDeviceId`. Not persisted. */
  readonly event: SensorEvent
  /**
   * Every camera that links the sensor, ignoring the tracked-events opt-in.
   * [] = linked to no camera; non-empty = linked, but none of those cameras
   * opted it into tracked events.
   */
  readonly linkedCameraIds: readonly number[]
}

/** One sensor-cap state change, as the camera-set derivations read it. */
export interface SensorCapQuery {
  /** The device that emitted the state change. */
  readonly deviceId: number
  /** The cap whose state changed. */
  readonly capName: string
}

/**
 * The cameras ONE sensor-cap state change belongs to, and — when there are
 * none — why.
 */
export interface SensorEventCameras {
  /**
   * The emitting device's LINKED cameras, plus the emitting device ITSELF when
   * it is a camera the cap may self-emit for. Empty ⇒ `dropReason` is set.
   */
  readonly cameraIds: readonly number[]
  /** Set exactly when `cameraIds` is empty; null otherwise. */
  readonly dropReason: SensorIngestDropReason | null
  /**
   * Every camera linking the device, ignoring the tracked-events opt-in —
   * read only for `no-camera` (the sensor-level route); [] otherwise.
   */
  readonly linkedCameraIds: readonly number[]
}

/**
 * THE camera-set derivation for a sensor-cap state change — one function, so
 * every consumer of a device-event attributes it to the same cameras.
 *
 * It is shared on purpose. The self-camera half (a doorbell bound on camera
 * 101 makes 101 both source and subject) was added to the history-row
 * ingest on 2026-08-07 and NOT to the synthetic-track projection beside it,
 * which kept resolving `camerasFor` alone. The result: camera 101's real
 * doorbell press on 2026-08-08 06:59Z produced a `SensorEvent` row and no
 * timeline marker, for weeks, with the divergence invisible in both codepaths.
 * Two derivations of "which cameras" is one too many.
 */
export async function resolveSensorEventCameras(
  cache: SensorCameraLookup,
  data: SensorCapQuery,
): Promise<SensorEventCameras> {
  const linkedCameraIds = await cache.camerasFor(data.deviceId)
  const isCamera = await cache.isCamera(data.deviceId)
  const includesSelf =
    isCamera && selfCameraMayEmit(data.capName) && !linkedCameraIds.includes(data.deviceId)
  const cameraIds = includesSelf ? [data.deviceId, ...linkedCameraIds] : linkedCameraIds
  if (cameraIds.length > 0) return { cameraIds, dropReason: null, linkedCameraIds: [] }
  if (isCamera) return { cameraIds, dropReason: 'camera-native-cap', linkedCameraIds: [] }
  // Empty is only knowledge when the index answered. Otherwise a camera's own
  // cap on a cold start (no camera list ⇒ `isCamera` false) would look like
  // an unlinked sensor and be evaluated as one.
  if (!(await cache.answered())) {
    return { cameraIds, dropReason: 'camera-index-unknown', linkedCameraIds: [] }
  }
  return {
    cameraIds,
    dropReason: 'no-camera',
    linkedCameraIds: await cache.allCamerasFor(data.deviceId),
  }
}

/**
 * The cameras a NOTIFICATION about this sensor shows — the emitting device
 * itself when it is a camera that may self-emit this cap, then every camera
 * that links it, opt-in or not (ADR 0632). The order is the mosaic's tile order
 * and names the PRIMARY camera (the first). Deliberately a sibling of
 * resolveSensorEventCameras rather than a flag on it: that one decides which
 * timeline rows exist and must keep honouring the opt-in.
 *
 * `[]` is NOT knowledge. It answers both "no camera links this sensor" and
 * "the camera index has not answered yet" (cold start, no camera list read —
 * this function does not consult `answered()`). A caller must read `[]` (and a
 * single camera) as "no mosaic this time, fall back to the plain path", never
 * as a durable "linked to nothing" that drops or deletes work (D49).
 */
export async function resolveLinkedMediaCameras(
  cache: SensorCameraLookup,
  data: SensorCapQuery,
): Promise<readonly number[]> {
  const linked = await cache.allCamerasFor(data.deviceId)
  const isCamera = await cache.isCamera(data.deviceId)
  const self = isCamera && selfCameraMayEmit(data.capName) ? [data.deviceId] : []
  return [...self, ...linked.filter((id) => id !== data.deviceId)]
}

/**
 * The cameras a notification about one state change involves (ADR 0632).
 * `mediaCameraIds` is `[]` whenever the change is not evaluated at all — see
 * {@link resolveSensorNotificationCameras}.
 */
export interface SensorNotificationCameras {
  /** Every camera the notification shows, primary first — ANY link, opt-in or
   *  not ({@link resolveLinkedMediaCameras}). */
  readonly mediaCameraIds: readonly number[]
  /** The cameras the ingest writes a timeline row for (the opt-in). */
  readonly rowCameraIds: readonly number[]
}

export const NO_SENSOR_NOTIFICATION_CAMERAS: SensorNotificationCameras = {
  mediaCameraIds: [],
  rowCameraIds: [],
}

/**
 * Which cameras a notification about this change shows, known BEFORE the
 * ingest runs, so the capture can start at the trigger.
 *
 * Only a change the ingest EVALUATES has any: a mapped cap that takes rows
 * (`dropReason` null) or an unowned sensor (`no-camera`, D630 §6). A camera's
 * own `motion` no camera opted in (`camera-native-cap`) and a cold index
 * (`camera-index-unknown`) are drops today, and a camera merely LINKING the
 * device must not turn a drop into a notification. Asks the SAME resolution
 * the ingest asks (`resolveSensorEventCameras`), off the same cache.
 */
export async function resolveSensorNotificationCameras(
  cache: SensorCameraLookup,
  data: SensorCapQuery,
): Promise<SensorNotificationCameras> {
  if (EVENT_KIND_BY_CAP[data.capName] === undefined) return NO_SENSOR_NOTIFICATION_CAMERAS
  const rows = await resolveSensorEventCameras(cache, data)
  if (rows.dropReason !== null && rows.dropReason !== 'no-camera') {
    return NO_SENSOR_NOTIFICATION_CAMERAS
  }
  return {
    mediaCameraIds: await resolveLinkedMediaCameras(cache, data),
    rowCameraIds: rows.cameraIds,
  }
}

/**
 * A sensor slice as a row's `value`: the object it is, or `null` for anything
 * else (absent, a primitive, an array) — one narrowing for every sensor event
 * built from a `DeviceStateChanged`.
 */
export function sensorSliceRecord(slice: unknown): Record<string, unknown> | null {
  return isSliceRecord(slice) ? slice : null
}

function isSliceRecord(slice: unknown): slice is Record<string, unknown> {
  return typeof slice === 'object' && slice !== null && !Array.isArray(slice)
}

/**
 * One `DeviceStateChanged` → N history rows, one per camera the event belongs
 * to: the emitting device's LINKED cameras, plus the emitting device ITSELF
 * when it is a camera carrying the sensor cap (a doorbell bound on camera
 * 101 — see `SELF_CAMERA_EXCLUDED_CAPS` for the one cap that is not
 * self-ingested). The EVENT_KIND_BY_CAP gate exits first so non-sensor cap
 * churn costs one map lookup. Returns the number of rows inserted (0 when
 * unmapped, or when no camera takes a row for the device — a non-camera
 * sensor then goes to `onUnowned` instead, evaluated without a row, once the
 * camera index answered).
 * Telemetry-lossy by design (D8) — inserts are best-effort.
 */
export async function ingestSensorStateChange(
  deps: IngestSensorStateDeps,
  data: { readonly deviceId: number; readonly capName: string; readonly slice?: unknown },
  timestamp: number,
): Promise<number> {
  const descriptor = EVENT_KIND_BY_CAP[data.capName]
  if (descriptor === undefined) return 0
  const { cameraIds, dropReason, linkedCameraIds } = await resolveSensorEventCameras(
    deps.cache,
    data,
  )
  const value = sensorSliceRecord(data.slice)
  const makeId = deps.makeId ?? ((): string => `pa-sensor-${randomUUID()}`)
  if (dropReason === 'no-camera' && deps.onUnowned !== undefined) {
    // A sensor no camera links: evaluated, never persisted. The sensor is its
    // own device — there is no camera to attribute it to.
    const ev: SensorEvent = {
      id: makeId(),
      deviceId: data.deviceId,
      sourceDeviceId: data.deviceId,
      kind: descriptor.kind,
      value,
      timestamp,
    }
    // NOT swallowed: a throw here propagates to the caller, whose own catch
    // logs it with the sensor's deviceId. Nothing was inserted, so there is
    // no half-written state to protect.
    deps.onUnowned({ event: ev, linkedCameraIds })
    return 0
  }
  if (dropReason !== null) {
    deps.onDropped?.(dropReason, descriptor.kind)
    return 0
  }
  let inserted = 0
  for (const cameraId of cameraIds) {
    const ev: SensorEvent = {
      id: makeId(),
      deviceId: cameraId,
      sourceDeviceId: data.deviceId,
      kind: descriptor.kind,
      value,
      timestamp,
    }
    await deps.sink.insert(ev)
    inserted++
    // NC device-event hook — after the durable insert. Never let a hook throw
    // break the ingest (telemetry-lossy contract).
    if (deps.onPersisted !== undefined) {
      try {
        deps.onPersisted(ev)
      } catch {
        /* best-effort */
      }
    }
  }
  return inserted
}

/**
 * Compose many cameras' vocabularies, and answer for EVERY id that was asked.
 *
 * The resilience is the whole reason this is a function rather than a
 * `Promise.all` at the call site. A caller that asked for twelve cameras and
 * received eleven cannot tell WHICH one is missing, or even that one is — so a
 * camera whose composition throws yields an empty list, reported through
 * `onError`, and keeps its place in the response.
 *
 * Order and uniqueness follow the request: ids are de-duplicated, and the
 * result is in the order the caller gave them.
 */
export async function composeEventKindsForDevices(
  deviceIds: readonly number[],
  composeOne: (deviceId: number) => Promise<readonly EventKindDescriptor[]>,
  onError?: (deviceId: number, err: unknown) => void,
): Promise<readonly EventKindsForDevice[]> {
  const unique = [...new Set(deviceIds)]
  return Promise.all(
    unique.map(async (deviceId): Promise<EventKindsForDevice> => {
      try {
        return { deviceId, kinds: await composeOne(deviceId) }
      } catch (err) {
        onError?.(deviceId, err)
        return { deviceId, kinds: [] }
      }
    }),
  )
}
