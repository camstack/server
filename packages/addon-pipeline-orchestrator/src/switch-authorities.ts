/**
 * ONE bounded read of the AUTHORITIES that own each per-camera function
 * ([D113](../../../docs/decisions/adr-0113.md)).
 *
 * This module is the thing the switch group used to be wrapped around. The
 * group is going away — each function returns to its own component's options —
 * but two callers still need to ask "is this function on for this camera", and
 * they must get the same answer:
 *
 *  - `CameraStatusService` composes `CameraStatus.switchedOff` from it
 *    (`composeSwitchedOff`). That is the badge that separates DISABLED from
 *    BROKEN, and it survives every surface change above it.
 *  - `CameraSwitchService` — the deprecated compatibility shim behind
 *    `pipelineOrchestrator.getCameraSwitches` — derives its labelled group
 *    from it for as long as deployed viewers still call that pair.
 *
 * **Every one of the eight fields is a read-through to the authority that
 * already owned the fact — nothing here stores any of them.** That includes the
 * privacy pair, which is the one authority that reaches a camera: its freshness
 * lives in the provider's own runtime-state bridge, where the write path that
 * changes it already lands
 * ([D221](../../../docs/decisions/adr-0221-a-polled-list-never-dials-a-camera.md)).
 * A cache here as well would be a second authority over one fact, and it was:
 * the mask editor writes the cap directly, never through this server, so the
 * copy this module used to keep went stale the moment an operator used the
 * control the badge describes.
 *
 * | Function | Authority read | Scope |
 * | --- | --- | --- |
 * | `stream-broker` | `getDevice` / `listAll({deviceIds})` → `.disabled` | the PASS |
 * | `object-detection` | `getBindings` / `getBindingsBatch` ∋ `detection-pipeline` | the PASS |
 * | `audio-analysis` | `getBindings` / `getBindingsBatch` ∋ `audio-analysis` | the PASS |
 * | `recording` | `recordingArchive.getDeviceConfig().enabled` | per camera |
 * | `notifications` | `notificationRules.listDeviceMutes` | the PASS |
 * | `privacy-mask` | `privacyMask.getOptions` + `getStatus` (the CAMERA) | per camera |
 * | `device-audio` | `privacyMask.getOptions` + `getStatus` (the CAMERA) | per camera |
 * | `broker-audio` | `streamBroker.getDeviceAudioMute` (`DeviceOverride.audioMuted`) | per camera |
 *
 * The three PASS-scoped rows are questions about a SET, not about a camera: the
 * device row, the binding table and the fleet mute list. `getCameraStatuses`
 * composes twenty-nine cameras from one poll, so asking each of them
 * twenty-nine times was twenty-nine identical answers. A {@link FleetReadPass}
 * issues each once for the whole set and hands the SAME promise to every
 * camera — which is not a cache: it lives for one call and is discarded. Each
 * camera still bounds it and still reports its own failure, tagged with its own
 * `deviceId`, naming whichever method the pass issued.
 *
 * A pass of ONE — which is what the write path (`CameraSwitchService`) always
 * is — still asks `getDevice` and `getBindings`. The batch shapes exist for
 * "these N", and answering a set of one with them would be no cheaper.
 *
 * `broker-audio` is the one row that is NODE-PINNED. The stream-broker cap is a
 * per-node singleton and a camera's brokers live on its source owner, so an
 * unpinned call reads the hub's broker and answers about a camera it does not
 * serve. Every other authority here is cluster-global or device-routed.
 *
 * ## The rule the bounds exist for
 *
 * **A source that did not answer is `null`, never a value defaulted to "on".**
 * Guessing renders a function the operator believes is running that is not —
 * and, one level up, an empty `switchedOff` on a camera somebody switched off,
 * which is the 2026-08-08 inversion. Every branch degrades INDEPENDENTLY: one
 * unreachable addon nulls its own field and leaves the others usable.
 */
import type {
  AddonApi,
  BrokerAudioSwitchState,
  CameraSwitchDerivationInput,
  DeviceAudioSwitchState,
  IScopedLogger,
  PrivacyMaskSwitchState,
  RecordingConfig,
} from '@camstack/types'
import { errMsg, nodePin, PRIVACY_MASK_CAP_NAME } from '@camstack/types'
import { FleetReadPass } from './camera-status/fleet-read-pass.js'
import type { RepeatWarnSampler } from './repeat-warn-sampler.js'

/** Both camera-authority planes, as one read of the cap answers them. */
export interface PrivacyPlanes {
  readonly deviceAudio: DeviceAudioSwitchState | null
  readonly privacyMask: PrivacyMaskSwitchState | null
}

/** Nothing known about either plane — the read did not happen at all. */
const UNKNOWN_PRIVACY_PLANES: PrivacyPlanes = {
  deviceAudio: null,
  privacyMask: null,
}

/** What one read pass collected, plus the bits only a WRITE path needs. */
export interface SwitchAuthorityReads {
  /** The authority facts themselves — everything a derivation needs. */
  readonly derivation: CameraSwitchDerivationInput
  /** cap → the wrapper addon id to pass to `setWrapperActive`. */
  readonly wrapperAddonIdByCap: ReadonlyMap<string, string>
  /** The recorder's current config, so a write can patch `enabled` in place. */
  readonly recordingConfig: RecordingConfig | null
}

export interface SwitchAuthorityReadDeps {
  readonly logger: IScopedLogger
  /**
   * `topology.assignSource(deviceId)` — the node whose stream-broker holds this
   * camera's brokers. Only `broker-audio` needs it: the stream-broker cap is a
   * per-node singleton, so reading it without a pin answers for the wrong
   * node's brokers.
   */
  readonly assignSource: (deviceId: number) => string
  /**
   * Turns a REPEATING per-`(camera, source)` fault into a bounded record.
   *
   * Every branch here that drops a fact still logs it — silence reads as "it
   * never happened". But this runs per camera on a polled call, so an unbounded
   * line meant `cameras × sources × polls`: 337 WARN lines in one minute on
   * 2026-08-21. The first occurrence still logs in full, tagged with the
   * numeric deviceId.
   */
  readonly warnSampler: RepeatWarnSampler
}

/**
 * The two facts one `getBindings` answer yields. Kept together so they cannot
 * be fetched separately and drift apart.
 */
interface BindingFacts {
  /** Caps bound `kind: 'wrapped'`; `null` = the lookup failed. */
  readonly activeWrapperCapNames: readonly string[] | null
  /** cap → the addon currently providing it. Empty when the lookup failed. */
  readonly providerAddonIdByCap: ReadonlyMap<string, string>
  /**
   * EVERY cap bound to this device, whatever the `kind`. Device-NATIVE caps
   * (`privacy-mask`) only appear here — they carry no wrapper, so the
   * wrapper-only view above and `listBindableCapsForDeviceType` both drop
   * them. `null` = the lookup failed.
   *
   * Never branch on `kind` for ROUTING (D13); this is an availability question
   * — "does this camera have the cap at all" — which is the same question
   * `addon-export-alexa`'s discovery asks of the same answer.
   */
  readonly allCapNames: readonly string[] | null
}

/** Narrow `deviceManager.getDevice` to the two fields read here. */
interface DeviceShape {
  readonly type: string
  readonly disabled: boolean
}

function isDeviceShape(v: unknown): v is DeviceShape {
  if (v === null || typeof v !== 'object') return false
  const rec: Record<string, unknown> = { ...v }
  return typeof rec['type'] === 'string' && typeof rec['disabled'] === 'boolean'
}

/** Narrow `recordingArchive.getDeviceConfig` to the fields a switch may touch. */
function isRecordingConfig(v: unknown): v is RecordingConfig {
  if (v === null || typeof v !== 'object') return false
  const rec: Record<string, unknown> = { ...v }
  return typeof rec['enabled'] === 'boolean' && Array.isArray(rec['bands'])
}

/**
 * Read `audioEnabled` off a `privacyMask.getStatus` payload.
 *
 * The generated `getStatus` is the ONE cap method whose output is the generic
 * device-status shape rather than the cap's own schema, so it arrives untyped.
 * This is the type boundary; a guard rather than a cast, and it returns `null`
 * for anything it does not recognise — an unparseable status is "unknown",
 * never a value defaulted to on.
 */
function readAudioEnabled(v: unknown): boolean | null {
  if (v === null || typeof v !== 'object') return null
  const rec: Record<string, unknown> = { ...v }
  const raw = rec['audioEnabled']
  return typeof raw === 'boolean' ? raw : null
}

/**
 * Read the VIDEO mask's two facts off the same untyped `getStatus` payload.
 *
 * Same type boundary and same rule as {@link readAudioEnabled}: anything not
 * recognised is `null`. A status we cannot parse must never become "no zones
 * configured" — that is a real answer with real copy telling the operator to go
 * and draw one.
 *
 * `regions: null` — the cap's own "we have not reached this camera" — lands in
 * the same branch, and that is the point: until 2026-09-07 a cold provider
 * slice sent `regions: []`, this returned `configuredRegions: 0`, and the
 * derivation told the operator to draw a zone on a camera it had never asked.
 * The audio plane, from the SAME payload, correctly said "unknown".
 */
function readPrivacyMaskFacts(v: unknown): {
  readonly configuredRegions: number | null
  readonly enabled: boolean | null
} {
  if (v === null || typeof v !== 'object') return { configuredRegions: null, enabled: null }
  const rec: Record<string, unknown> = { ...v }
  const regions = rec['regions']
  const enabled = rec['enabled']
  return {
    configuredRegions: Array.isArray(regions) ? regions.length : null,
    enabled: typeof enabled === 'boolean' ? enabled : null,
  }
}

/**
 * How long ONE source may take before it is treated as unreachable.
 *
 * The read runs in two sequential stages, so the worst case is twice this —
 * 2.4s — which has to stay under the 3s `STAGE_TIMEOUT_MS` that
 * `CameraStatusService` allows the whole switch stage. That ordering is the
 * whole point of the number: if this can outlast its caller's budget, the
 * caller degrades to "nothing switched off" and a camera the operator DISABLED
 * renders as broken.
 *
 * Measured on the live hub, 2026-08-08: seven of the eight sources answered in
 * 5–15ms on every camera. The eighth, `privacyMask.getStatus`, probes the
 * camera itself and took 3.1–3.6s on device 105 on every single call (18s under
 * load) — so a bound generous enough to make the fast sources safe still has to
 * be willing to drop the slow one, because waiting for it costs the other six.
 */
const SOURCE_TIMEOUT_MS = 1_200

/** Nothing readable — what a caller with no wired api gets. */
function unknownReads(deviceId: number): SwitchAuthorityReads {
  return {
    derivation: {
      deviceId,
      deviceDisabled: false,
      bindableCapNames: null,
      activeWrapperCapNames: null,
      recordingEnabled: null,
      notificationsMuted: null,
      deviceAudio: null,
      privacyMask: null,
      brokerAudio: null,
    },
    wrapperAddonIdByCap: new Map(),
    recordingConfig: null,
  }
}

/**
 * Bound ONE source. A source that has not answered within
 * {@link SOURCE_TIMEOUT_MS} yields `fallback` — the same value its `.catch`
 * yields — so a slow source and a broken one produce the identical read: that
 * field is `null`, and every other field is untouched.
 *
 * The bound is per SOURCE rather than around the whole fan-out on purpose. One
 * deadline over the lot would let the slowest camera probe consume the budget of
 * the seven sources that already answered, which is precisely how
 * `getCameraStatus` came to report `switchedOff: []` for a camera whose
 * `stream-broker` and `recording` the operator had turned off.
 *
 * @param deps     Where a dropped source is announced, through the sampler.
 * @param deviceId The camera — every line about it carries the tag.
 * @param source   The cap method, as named in the warn line.
 * @param p        The source's promise. Already `.catch`-ed; never rejects.
 * @param fallback What the caller reads when the source did not answer.
 */
function bounded<T>(
  deps: SwitchAuthorityReadDeps,
  deviceId: number,
  source: string,
  p: Promise<T>,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      // A branch that drops work silently reads as "it never happened". This is
      // the only line that can answer "why does 614 report less than 101", so
      // it carries the numeric deviceId like every other.
      warnSampled(deps, deviceId, source, TIMED_OUT_MESSAGE, {
        source,
        timeoutMs: SOURCE_TIMEOUT_MS,
      })
      resolve(fallback)
    }, SOURCE_TIMEOUT_MS)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** The two lines this module writes, named so the sampler keys stay stable. */
const TIMED_OUT_MESSAGE = 'camera function authority TIMED OUT — its state is unknown'
const UNREACHABLE_MESSAGE = 'camera function authority unreachable — its state is unknown'

/**
 * Write a fault line, SAMPLED per `(camera, source, message)`.
 *
 * The first occurrence goes out in full — that is what makes the fault
 * actionable. After that the pair is counted and one line per sampler interval
 * carries `suppressedSinceLastLine`, so the RATE survives even though the
 * individual lines do not. Same message text either way, so a grep still finds
 * it; the counter is in `meta`.
 *
 * Keyed per camera, never globally: a camera that has been unreachable for an
 * hour must not mute the line for a second one going down.
 */
function warnSampled(
  deps: SwitchAuthorityReadDeps,
  deviceId: number,
  source: string,
  message: string,
  meta: Record<string, unknown>,
): void {
  const decision = deps.warnSampler.record(`${deviceId}:${source}:${message}`)
  if (decision.logExample) {
    deps.logger.warn(message, { tags: { deviceId }, meta })
    return
  }
  if (decision.summaryCount === null) return
  deps.logger.warn(message, {
    tags: { deviceId },
    meta: { ...meta, suppressedSinceLastLine: decision.summaryCount },
  })
}

function warnUnreachable(
  deps: SwitchAuthorityReadDeps,
  deviceId: number,
  source: string,
  err: unknown,
): void {
  // A source that did not answer makes its function UNKNOWN. Say so — a state
  // that silently vanished reads to the operator as a function that was never
  // there.
  warnSampled(deps, deviceId, source, UNREACHABLE_MESSAGE, { source, error: errMsg(err) })
}

/**
 * BOTH camera-authority planes, from ONE `getOptions` + `getStatus` pair.
 *
 * The video mask and the microphone live on the same device-native cap and the
 * same two answers describe both, so the second costs nothing. Fetching them
 * separately would double the per-camera round trips on a read `CameraStatus`
 * already pays once per camera, and would let the two disagree across a write
 * landing between them.
 *
 * Three distinct answers per plane, and collapsing any two loses a real
 * distinction:
 *  - the camera is DISABLED → `null` (unknown, never dialled; the derivation
 *    reports `device-disabled`, not a stalled source)
 *  - bindings unreadable → `null` (unknown)
 *  - the camera has no `privacy-mask` provider, or has one that says it cannot
 *    do this plane → `{ supported: false }` (no such control here)
 *  - the cap is there but did not answer → `null` (unknown), never on
 *
 * Only the last branch reaches the PROVIDER, and the two cheap answers above
 * are decided from bindings this pass already holds — so a camera with no
 * `privacy-mask` provider still costs zero calls.
 *
 * And the last branch is a read-through, not a probe with a cache in front of
 * it. The provider serves it from the runtime-state slice its own write path
 * refreshes, on the operator-written freshness window
 * (`OPERATOR_WRITTEN_STALE_MS`), revalidating behind the caller — so however
 * often this list is polled, the CAMERA is reached about once every ten
 * minutes and never on this request path (D221).
 */
function readPrivacyPlanes(
  api: AddonApi,
  deviceId: number,
  deps: SwitchAuthorityReadDeps,
  allCapNames: readonly string[] | null,
  deviceDisabled: boolean,
): Promise<PrivacyPlanes> {
  // A disabled camera has no session to ask through: its provider waited the
  // full bound on BOTH planes, every poll, for a switch the panel does not
  // offer while the camera is off. Unknown is the honest answer, and the
  // derivation names the reason (`device-disabled`), not a stalled source.
  if (deviceDisabled) return Promise.resolve(UNKNOWN_PRIVACY_PLANES)
  if (allCapNames === null) return Promise.resolve(UNKNOWN_PRIVACY_PLANES)
  if (!allCapNames.includes(PRIVACY_MASK_CAP_NAME))
    return Promise.resolve({
      deviceAudio: { supported: false, enabled: null },
      privacyMask: { supported: false, configuredRegions: null, enabled: null },
    })
  return probeCamera(api, deviceId, deps)
}

/**
 * The two calls to the camera's own provider.
 *
 * Still bounded per source: a provider whose process is wedged, or a camera
 * being reached for the first time, must not make the operator wait for the
 * other six authorities. Never rejects — a source that did not answer becomes
 * `null`, i.e. UNKNOWN, never a plane defaulted to "on".
 */
async function probeCamera(
  api: AddonApi,
  deviceId: number,
  deps: SwitchAuthorityReadDeps,
): Promise<PrivacyPlanes> {
  const [options, status] = await Promise.all([
    bounded(
      deps,
      deviceId,
      'privacyMask.getOptions',
      api.privacyMask.getOptions.query({ deviceId }).catch((err: unknown): null => {
        warnUnreachable(deps, deviceId, 'privacyMask.getOptions', err)
        return null
      }),
      null,
    ),
    bounded(
      deps,
      deviceId,
      'privacyMask.getStatus',
      api.privacyMask.getStatus.query({ deviceId }).catch((err: unknown): null => {
        warnUnreachable(deps, deviceId, 'privacyMask.getStatus', err)
        return null
      }),
      null,
    ),
  ])

  if (options === null) return UNKNOWN_PRIVACY_PLANES
  const maskFacts = readPrivacyMaskFacts(status)
  return {
    // Supported but unread is UNKNOWN, not off. `audioEnabled` is nullable on
    // the wire for exactly this reason and is passed through untouched.
    deviceAudio: options.supportsAudioMute
      ? { supported: true, enabled: readAudioEnabled(status) }
      : { supported: false, enabled: null },
    // There is no `supportsVideoMask` flag on the cap — a camera that can hold
    // zero regions of no shape cannot mask, and both providers that could
    // answer otherwise report those numbers honestly.
    privacyMask:
      options.maxRegions > 0 && options.supportedShapes.length > 0
        ? { supported: true, ...maskFacts }
        : { supported: false, configuredRegions: null, enabled: null },
  }
}

/**
 * Read every authority for one camera, bounded, degrading per source.
 *
 * @param api      The hub api, or `null` before it is wired — which yields an
 *                 all-`null` read, i.e. "unknown", never "everything is on".
 * @param deviceId The camera.
 * @param deps     Logger + source-owner resolver.
 */
export async function readSwitchAuthorities(
  api: AddonApi | null,
  deviceId: number,
  deps: SwitchAuthorityReadDeps,
  sharedPass?: FleetReadPass,
): Promise<SwitchAuthorityReads> {
  if (!api) return unknownReads(deviceId)

  // A caller composing many cameras hands its pass in, so the three
  // fleet-shaped reads below are issued ONCE for the whole set. A single-camera
  // caller (the write path, `CameraSwitchService`) gets a pass of one — the
  // same code, the same batch methods, one row each.
  const pass = sharedPass ?? new FleetReadPass({ deviceIds: [deviceId] })

  // The device row, from the pass's ONE roster read. A device that is not in
  // the answer reads exactly as `getDevice` returning null did: unknown, never
  // "enabled". The line names whichever method the pass actually issued.
  const roster = pass.deviceRoster(api)
  const devicePromise = bounded(
    deps,
    deviceId,
    roster.source,
    roster.result
      .then((rows): DeviceShape | null => {
        const row: unknown = rows.find((d) => d.id === deviceId)
        return isDeviceShape(row) ? row : null
      })
      .catch((err: unknown): null => {
        warnUnreachable(deps, deviceId, roster.source, err)
        return null
      }),
    null,
  )

  // ONE getBindings answers both questions asked of it: which wrappers are
  // ACTIVE (the read) and which addon provides each cap (the write target). Two
  // round trips could disagree — a rebind landing between them would derive
  // state from one snapshot and write the addon named by another.
  const unknownBindings: BindingFacts = {
    activeWrapperCapNames: null,
    providerAddonIdByCap: new Map(),
    allCapNames: null,
  }
  const bindingRead = pass.bindingRows(api)
  const bindingsPromise = bounded(
    deps,
    deviceId,
    bindingRead.source,
    bindingRead.result
      .then((rows): BindingFacts => {
        const row = rows.find((r) => r.deviceId === deviceId)
        // A device absent from the batch answer is UNKNOWN, not unbound.
        // `getBindingsBatch` gives a device with no bindings `entries: []`
        // rather than dropping it, so absence here means the answer did not
        // cover this camera — and reporting that as "no wrappers active" is
        // the D49 shape: a bad read that looks exactly like an unbind.
        if (row === undefined) return unknownBindings
        const active: string[] = []
        const all: string[] = []
        const providers = new Map<string, string>()
        for (const e of row.entries) {
          all.push(e.capName)
          if (e.kind !== 'wrapped') continue
          active.push(e.capName)
          if (e.providerAddonId !== '') providers.set(e.capName, e.providerAddonId)
        }
        return { activeWrapperCapNames: active, providerAddonIdByCap: providers, allCapNames: all }
      })
      .catch((err: unknown): BindingFacts => {
        warnUnreachable(deps, deviceId, bindingRead.source, err)
        // Unknown, NOT empty: `null` makes the wrapper functions unreadable
        // rather than reporting them off. An empty provider map is correct
        // either way — there is nothing to write to.
        return unknownBindings
      }),
    unknownBindings,
  )

  const recordingPromise = bounded(
    deps,
    deviceId,
    'recordingArchive.getDeviceConfig',
    api.recordingArchive.getDeviceConfig
      .query({ deviceId })
      .then((c: unknown): RecordingConfig | null => (isRecordingConfig(c) ? c : null))
      .catch((err: unknown): null => {
        warnUnreachable(deps, deviceId, 'recordingArchive.getDeviceConfig', err)
        return null
      }),
    null,
  )

  const mutesPromise = bounded(
    deps,
    deviceId,
    'notificationRules.listDeviceMutes',
    pass
      .mutedDevices(api)
      .then((r): readonly number[] | null => r.mutedDeviceIds)
      .catch((err: unknown): null => {
        warnUnreachable(deps, deviceId, 'notificationRules.listDeviceMutes', err)
        return null
      }),
    null,
  )

  // Node-pinned to the camera's SOURCE owner — the stream-broker cap is a
  // per-node singleton, so an unpinned read answers for whichever node's broker
  // the link chain happens to reach.
  const brokerAudioPromise = bounded(
    deps,
    deviceId,
    'streamBroker.getDeviceAudioMute',
    api.streamBroker.getDeviceAudioMute
      .query({ deviceId }, nodePin(deps.assignSource(deviceId)))
      .then((r): BrokerAudioSwitchState | null => ({ muted: r.muted }))
      .catch((err: unknown): null => {
        warnUnreachable(deps, deviceId, 'streamBroker.getDeviceAudioMute', err)
        return null
      }),
    null,
  )

  const [device, bindings, recordingConfig, mutedDeviceIds, brokerAudio] = await Promise.all([
    devicePromise,
    bindingsPromise,
    recordingPromise,
    mutesPromise,
    brokerAudioPromise,
  ])

  // Stage 2 — the two reads that need stage 1's answer first.
  //
  // Bindable caps are per device TYPE, so that needs the device. A cap with no
  // registered wrapper is NOT a function anyone can turn on or off here.
  //
  // The camera planes need the BINDINGS: probing a camera with no
  // `privacy-mask` provider would be two guaranteed round trips into a
  // PRECONDITION_FAILED, per camera, on a read `CameraStatus` already pays once
  // per camera. The cheap question comes first.
  const [bindable, privacy] = await Promise.all([
    device === null
      ? Promise.resolve(null)
      : bounded(
          deps,
          deviceId,
          'deviceManager.listBindableCapsForDeviceType',
          pass.bindableCapsFor(api, device.type).catch((err: unknown): null => {
            warnUnreachable(deps, deviceId, 'listBindableCapsForDeviceType', err)
            return null
          }),
          null,
        ),
    readPrivacyPlanes(api, deviceId, deps, bindings.allCapNames, device?.disabled ?? false),
  ])

  const wrapperAddonIdByCap = new Map<string, string>()
  for (const entry of bindable ?? []) {
    const first = entry.wrappers[0]
    // Prefer the wrapper ALREADY bound — turning a function off must deactivate
    // the provider that is actually serving it, not an arbitrary sibling.
    const bound = bindings.providerAddonIdByCap.get(entry.capName)
    const chosen = bound ?? first
    if (chosen !== undefined) wrapperAddonIdByCap.set(entry.capName, chosen)
  }

  return {
    derivation: {
      deviceId,
      deviceDisabled: device?.disabled ?? false,
      bindableCapNames:
        bindable === null
          ? null
          : bindable.filter((b) => b.wrappers.length > 0).map((b) => b.capName),
      activeWrapperCapNames: bindings.activeWrapperCapNames,
      recordingEnabled: recordingConfig === null ? null : recordingConfig.enabled,
      notificationsMuted: mutedDeviceIds === null ? null : mutedDeviceIds.includes(deviceId),
      deviceAudio: privacy.deviceAudio,
      privacyMask: privacy.privacyMask,
      brokerAudio,
    },
    wrapperAddonIdByCap,
    recordingConfig,
  }
}
