/**
 * Camera-sensors lifecycle (D672). Owns WHEN the per-camera `cameraSensors`
 * record is read and resolved, and feeds the result to `CameraSensorsSource`
 * as a plain `cameraId → sensorIds` map.
 *
 * Resolution is lifecycle-driven, never polled (R9, D3): boot, a camera's
 * settings changing, a referenced addon registering a device, a watched sensor
 * going away / online / offline / changing bindings, and a status ask for a
 * camera nobody has read yet. Every request lands in ONE pending set drained
 * by ONE in-flight refresh — no timer, no debounce — so a burst of events costs
 * one extra pass, and a request that lands while a pass is finishing is picked
 * up by the re-kick rather than lost.
 *
 * The hot path (`onSensorState`) is the source's and is memory-only. Status is
 * answered from memory too; before a camera's first answered read it is
 * "not loaded", never "not configured" (R18, D315).
 */
import {
  CAMERA_SENSORS_NOT_LOADED,
  type CameraSensorAttachment,
  type CameraSensorsConfig,
  type CameraSensorsStatus,
  cameraSensorRefKey,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'
import {
  type CameraSensorsResolution,
  type CameraSensorsResolverPorts,
  resolveCameraSensors,
} from './resolver.js'
import type { CameraSensorsSetting } from './settings.js'
import type { CameraMotionEdge, CameraSensorsSource, SensorStateInput } from './source.js'

export type CameraIdsRead =
  | { readonly kind: 'ids'; readonly ids: readonly number[] }
  | { readonly kind: 'unreadable'; readonly error: string }

export type CameraSensorsRefreshReason =
  | 'boot'
  | 'settings-updated'
  | 'sensor-addon-registered'
  | 'sensor-unregistered'
  | 'sensor-online-changed'
  | 'sensor-bindings-changed'
  | 'sensor-enabled-changed'
  | 'status-asked'

export interface CameraSensorsControllerDeps {
  readonly logger: IScopedLogger
  readonly source: CameraSensorsSource
  readonly listCameraIds: () => Promise<CameraIdsRead>
  readonly readSetting: (cameraId: number) => Promise<CameraSensorsSetting>
  readonly ports: CameraSensorsResolverPorts
}

/** One camera a pass refreshes, and every reason it was asked for (said on its change lines). */
interface QueuedRefresh {
  readonly cameraId: number
  readonly reasons: readonly CameraSensorsRefreshReason[]
}

/** An attachment's comparable fields: a change in either is logged. */
interface AttachmentShape {
  readonly state: CameraSensorAttachment['state']
  readonly reason: string | undefined
  readonly mode: CameraSensorAttachment['mode']
}

function shapeOf(attachment: CameraSensorAttachment): AttachmentShape {
  return {
    state: attachment.state,
    reason: 'reason' in attachment ? attachment.reason : undefined,
    mode: attachment.mode,
  }
}

function attachmentsByKey(
  status: CameraSensorsStatus | undefined,
): ReadonlyMap<string, CameraSensorAttachment> {
  if (status?.state !== 'configured') return new Map()
  return new Map(status.sensors.map((a) => [cameraSensorRefKey(a), a]))
}

/** Does any attachment of this status carry `sensorId`, routed or not? */
function namesSensor(status: CameraSensorsStatus, sensorId: number): boolean {
  if (status.state !== 'configured') return false
  return status.sensors.some((a) => 'deviceId' in a && a.deviceId === sensorId)
}

export class CameraSensorsController {
  readonly #deps: CameraSensorsControllerDeps
  #inFlight: Promise<void> | null = null
  #pendingAll = false
  readonly #pendingCameras: Set<number> = new Set()
  /** Why the fleet pass was asked for (cleared when the pass takes it). */
  readonly #fleetReasons: Set<CameraSensorsRefreshReason> = new Set()
  /** Why each queued camera was asked for. */
  readonly #cameraReasons: Map<number, Set<CameraSensorsRefreshReason>> = new Map()
  #loaded = false
  #stopped = false
  readonly #resolutions: Map<number, CameraSensorsResolution> = new Map()
  readonly #configs: Map<number, CameraSensorsConfig> = new Map()

  constructor(deps: CameraSensorsControllerDeps) {
    this.#deps = deps
  }

  /** The boot pass: every camera. Resolves when that pass (and anything queued behind it) is done. */
  start(): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    this.#queueFleet('boot')
    return this.#kick()
  }

  requestCamera(cameraId: number, reason: CameraSensorsRefreshReason): void {
    if (this.#stopped) return
    if (!this.#loaded) this.#queueFleet(reason)
    this.#queueCamera(cameraId, reason)
    void this.#kick()
  }

  /**
   * A device of `addonId` registered. Only a camera with a NOT-ready ref of
   * that addon can gain from it: a ready ref already resolved, and a
   * re-adoption also unregisters the old device, which `requestSensor` covers.
   */
  requestAddon(addonId: string): void {
    const reason: CameraSensorsRefreshReason = 'sensor-addon-registered'
    if (this.#stopped) return
    if (!this.#loaded) {
      this.#queueFleet(reason)
      void this.#kick()
      return
    }
    const cameras = [...this.#configs].flatMap(([cameraId, config]) =>
      this.#hasUnreadyRef(cameraId, config, addonId) ? [cameraId] : [],
    )
    if (cameras.length === 0) return
    for (const cameraId of cameras) this.#queueCamera(cameraId, reason)
    void this.#kick()
  }

  /**
   * A sensor changed in a way that may change its attachment. Queues every
   * camera that ROUTES it, and every camera whose status still NAMES it — an
   * `unsupported` or `offline` attachment carries the device id although it may
   * route nothing. Without the second half, a sensor whose provider retracted
   * its binding (an HA addon restart decommissions every device, a hub boot can
   * read bindings before HA registered them) resolved `unsupported`, left
   * `inputs`, and was never looked at again when the binding came back.
   */
  requestSensor(sensorId: number, reason: CameraSensorsRefreshReason): void {
    if (this.#stopped) return
    if (!this.#loaded) {
      this.#queueFleet(reason)
      void this.#kick()
      return
    }
    const cameras = [...this.#resolutions].flatMap(([cameraId, resolution]) =>
      resolution.inputs.some((input) => input.deviceId === sensorId) ||
      namesSensor(resolution.status, sensorId)
        ? [cameraId]
        : [],
    )
    if (cameras.length === 0) return
    for (const cameraId of cameras) this.#queueCamera(cameraId, reason)
    void this.#kick()
  }

  /** The hot path: memory only, never I/O (R8). */
  onSensorState(input: SensorStateInput): void {
    this.#deps.source.onSensorState(input)
  }

  /** A camera's raw `ProviderMotion` push (D673): the bridge decides. Memory only. */
  onCameraMotion(edge: CameraMotionEdge): void {
    this.#deps.source.onCameraMotion(edge)
  }

  /** An unsplit provider's direct `onboard` emit (C13): noted, never re-emitted. Memory only. */
  noteDirectCameraMotion(cameraId: number, detected: boolean): void {
    this.#deps.source.noteDirectCameraMotion(cameraId, detected)
  }

  /** See `CameraSensorsSource.sensorHolds`; remove only when no unsplit emitter remains (the emitter guard's deferred map is empty) and the minimum provider versions carry Task 14. */
  sensorHolds(cameraId: number): boolean {
    return this.#deps.source.sensorHolds(cameraId)
  }

  watches(sensorId: number): boolean {
    return this.#deps.source.watches(sensorId)
  }

  statusFor(cameraId: number): CameraSensorsStatus {
    const status = this.#statusWithoutLevel(cameraId)
    // The camera's own raw level travels on every state (D696): the Motion card's camera row.
    const cameraLevel = this.#deps.source.cameraLevelOf(cameraId)
    return cameraLevel === null ? status : { ...status, cameraLevel }
  }

  /**
   * The device name of a sensor attached to `cameraId`, as the last resolution
   * read it — `undefined` when the camera has no answered resolution or does
   * not name that sensor. In-memory only: it is read on the session-dispatch
   * path, which never waits on a device read, and asking it queues nothing.
   */
  sensorNameOf(cameraId: number, sensorId: number): string | undefined {
    const status = this.#resolutions.get(cameraId)?.status
    if (status?.state !== 'configured') return undefined
    for (const a of status.sensors) {
      if ('deviceId' in a && a.deviceId === sensorId && 'name' in a) return a.name
    }
    return undefined
  }

  #statusWithoutLevel(cameraId: number): CameraSensorsStatus {
    const resolution = this.#resolutions.get(cameraId)
    if (resolution === undefined) {
      this.requestCamera(cameraId, 'status-asked')
      return CAMERA_SENSORS_NOT_LOADED
    }
    const notEnforced = this.#deps.source.enforcementOf(cameraId)
    return resolution.status.state === 'configured' && notEnforced !== null
      ? { ...resolution.status, notEnforced }
      : resolution.status
  }

  /** The camera left the registry: drop its mapping and whatever it was routing. */
  forgetCamera(cameraId: number): void {
    this.#pendingCameras.delete(cameraId)
    this.#cameraReasons.delete(cameraId)
    this.#resolutions.delete(cameraId)
    this.#configs.delete(cameraId)
    this.#deps.source.removeCamera(cameraId)
  }

  /** Test and teardown seam: resolves when no refresh is in flight. */
  async idle(): Promise<void> {
    while (this.#inFlight !== null) await this.#inFlight
  }

  stop(): void {
    this.#stopped = true
    this.#pendingAll = false
    this.#pendingCameras.clear()
    this.#fleetReasons.clear()
    this.#cameraReasons.clear()
    this.#deps.source.stop()
    this.#resolutions.clear()
    this.#configs.clear()
  }

  #queueFleet(reason: CameraSensorsRefreshReason): void {
    this.#pendingAll = true
    this.#fleetReasons.add(reason)
  }

  #queueCamera(cameraId: number, reason: CameraSensorsRefreshReason): void {
    this.#pendingCameras.add(cameraId)
    const reasons = this.#cameraReasons.get(cameraId) ?? new Set<CameraSensorsRefreshReason>()
    reasons.add(reason)
    this.#cameraReasons.set(cameraId, reasons)
  }

  /** Does `config` hold a ref of `addonId` that is not `ready` (or not resolved yet)? */
  #hasUnreadyRef(cameraId: number, config: CameraSensorsConfig, addonId: string): boolean {
    const attachments = attachmentsByKey(this.#resolutions.get(cameraId)?.status)
    return config.sensors.some(
      (ref) =>
        ref.addonId === addonId && attachments.get(cameraSensorRefKey(ref))?.state !== 'ready',
    )
  }

  #kick(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight
    const run = this.#drain().finally(() => {
      this.#inFlight = null
      // A request that landed after the drain's last check joined THIS run;
      // without this it would wait for an event that may never come.
      if (!this.#stopped && (this.#pendingAll || this.#pendingCameras.size > 0)) void this.#kick()
    })
    this.#inFlight = run
    return run
  }

  async #drain(): Promise<void> {
    while (!this.#stopped && (this.#pendingAll || this.#pendingCameras.size > 0)) {
      const batch = await this.#takeBatch()
      for (const { cameraId, reasons } of batch) {
        if (this.#stopped) return
        await this.#refreshOne(cameraId, reasons)
      }
    }
  }

  /** The cameras this pass refreshes: the whole fleet when asked (and readable), plus what is queued. */
  async #takeBatch(): Promise<readonly QueuedRefresh[]> {
    const wantAll = this.#pendingAll
    this.#pendingAll = false
    const fleetReasons = [...this.#fleetReasons]
    this.#fleetReasons.clear()
    const fleet = new Set(wantAll ? await this.#readFleet() : [])
    const batch = [...new Set([...fleet, ...this.#pendingCameras])]
    return batch.map((cameraId) => {
      const own = this.#cameraReasons.get(cameraId) ?? []
      this.#pendingCameras.delete(cameraId)
      this.#cameraReasons.delete(cameraId)
      const reasons = new Set([...(fleet.has(cameraId) ? fleetReasons : []), ...own])
      return { cameraId, reasons: [...reasons] }
    })
  }

  /** The fleet's camera ids. A throw is `unreadable` like any failed read — never a rejected drain. */
  async #readFleet(): Promise<readonly number[]> {
    const read = await this.#deps
      .listCameraIds()
      .catch((err: unknown): CameraIdsRead => ({ kind: 'unreadable', error: errMsg(err) }))
    if (read.kind === 'unreadable') {
      this.#deps.logger.warn('camera-sensors: camera list unreadable — mappings stay unloaded', {
        meta: { error: read.error },
      })
      return []
    }
    this.#loaded = true
    return read.ids
  }

  async #refreshOne(
    cameraId: number,
    reasons: readonly CameraSensorsRefreshReason[],
  ): Promise<void> {
    try {
      const setting = await this.#deps.readSetting(cameraId)
      const prior = this.#resolutions.get(cameraId) ?? null
      const next = await resolveCameraSensors(cameraId, setting, prior, this.#deps.ports)
      if (this.#stopped) return
      if (setting.state === 'configured') this.#configs.set(cameraId, setting.config)
      else if (setting.state === 'not-configured') this.#configs.delete(cameraId)
      this.#resolutions.set(cameraId, next)
      this.#deps.source.setInputs(
        cameraId,
        next.inputs.map((input) => ({
          deviceId: input.deviceId,
          mode: input.mode,
          ready: input.ready,
        })),
      )
      this.#logChanges(cameraId, prior?.status, next, reasons)
    } catch (err: unknown) {
      this.#deps.logger.error('camera-sensors: refresh failed — nothing applied', {
        tags: { deviceId: cameraId },
        meta: { error: errMsg(err) },
      })
    }
  }

  #logChanges(
    cameraId: number,
    prior: CameraSensorsStatus | undefined,
    next: CameraSensorsResolution,
    reasons: readonly CameraSensorsRefreshReason[],
  ): void {
    const from = prior?.state ?? 'not-configured'
    const to = next.status.state
    if (from !== to) {
      const line = `camera-sensors: mapping ${to}`
      const meta = {
        from,
        to,
        ...(next.status.state === 'unreadable' ? { reason: next.status.reason } : {}),
        inputs: next.inputs.map((input) => input.deviceId),
        reasons,
      }
      if (to === 'unreadable') this.#deps.logger.warn(line, { tags: { deviceId: cameraId }, meta })
      else this.#deps.logger.info(line, { tags: { deviceId: cameraId }, meta })
    }
    // Whether the camera's OWN motion counts is the operator-visible effect of a mode or readiness
    // change: say it whenever it moves (D673 C2, C3; task 11 review M3).
    const motionFrom = prior?.state === 'configured' ? (prior.cameraMotion ?? null) : null
    const motionTo = next.status.state === 'configured' ? (next.status.cameraMotion ?? null) : null
    if (motionTo !== null && motionFrom !== motionTo) {
      this.#deps.logger.info(`camera-sensors: camera motion ${motionTo}`, {
        tags: { deviceId: cameraId },
        meta: { from: motionFrom ?? 'unknown', to: motionTo, reasons },
      })
    }
    const before = attachmentsByKey(prior)
    for (const attachment of next.status.state === 'configured' ? next.status.sensors : []) {
      const key = cameraSensorRefKey(attachment)
      const was = before.get(key)
      const nowShape = shapeOf(attachment)
      const wasShape = was === undefined ? null : shapeOf(was)
      if (
        wasShape !== null &&
        wasShape.state === nowShape.state &&
        wasShape.reason === nowShape.reason &&
        wasShape.mode === nowShape.mode
      ) {
        continue
      }
      const line = `camera-sensors: attachment ${attachment.state}`
      const extras = {
        tags: { deviceId: cameraId },
        meta: {
          sensor: key,
          reasons,
          from: wasShape?.state ?? 'none',
          to: attachment.state,
          mode: attachment.mode,
          ...(wasShape !== null && wasShape.mode !== nowShape.mode
            ? { modeFrom: wasShape.mode }
            : {}),
          ...(nowShape.reason !== undefined ? { reason: nowShape.reason } : {}),
          ...('deviceId' in attachment ? { sensorDeviceId: attachment.deviceId } : {}),
        },
      }
      if (attachment.state === 'ready') this.#deps.logger.info(line, extras)
      else this.#deps.logger.warn(line, extras)
    }
  }
}
