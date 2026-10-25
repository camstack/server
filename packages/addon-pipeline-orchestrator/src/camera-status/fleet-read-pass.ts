/**
 * `FleetReadPass` — ONE question, asked once per pass.
 *
 * `getCameraStatuses` composes a `CameraStatus` for every assigned camera, and
 * the admin Cameras page polls it every 5 seconds. Composing one camera's
 * status reaches seven stages; SIX of the questions those stages ask are not
 * about the camera at all:
 *
 * | question | scope | was asked |
 * | --- | --- | --- |
 * | `streamBroker.listAllProfileSlots` | the whole NODE's slot table | once per camera |
 * | `streamBroker.getAllRtspEntries` | the whole NODE's restream table | once per camera |
 * | `notificationRules.listDeviceMutes` | the whole FLEET's mute list | once per camera |
 * | `pipelineExecutor.getEngineProvisioning` | per NODE | once per camera |
 * | `pipelineExecutor.getSelectedEngine` | per NODE (`z.void()` input) | once per camera |
 * | `deviceManager.listBindableCapsForDeviceType` | per device TYPE | once per camera |
 *
 * Two more are per-camera questions the device manager already answers for a
 * SET — `listAll({deviceIds})` and `getBindingsBatch({deviceIds})`, both added
 * for exactly this shape — so they are one round trip for the pass instead of
 * one per camera.
 *
 * **This is not a cache and it must never become one.** It holds no state
 * across calls, has no TTL and nothing invalidates it: it lives for the
 * duration of ONE `getCameraStatuses` and is discarded. Every camera in a pass
 * therefore sees the same fleet-wide answer read at the same instant, which is
 * strictly MORE coherent than N reads taken at N instants — and the next poll
 * asks again from scratch. A copy that outlived the call would be the second
 * authority D224 forbids, and it would be stale by design on the one write an
 * operator makes.
 *
 * **It does not bound and it does not log.** Every promise handed out is the
 * RAW cap call. The consumer wraps it exactly as it wrapped its own call —
 * `bounded(...)` per source in `switch-authorities.ts`, `boundedStage(...)` per
 * stage in `camera-status-service.ts` — so each camera keeps its own deadline
 * and its own `tags.deviceId` warn line. A fleet read that fails fails for each
 * camera individually, with the same line each would have written alone.
 */
import type { AddonApi, ProfileSlot } from '@camstack/types'
import {
  deviceManagerCapability,
  nodePin,
  notificationRulesCapability,
  pipelineExecutorCapability,
  streamBrokerCapability,
} from '@camstack/types'
import type { z } from 'zod'

/** The device roster, as `deviceManager.listAll` answers it. */
type DeviceRoster = z.infer<typeof deviceManagerCapability.methods.listAll.output>
/** One row per device, as `deviceManager.getBindingsBatch` answers it. */
type BindingRows = z.infer<typeof deviceManagerCapability.methods.getBindingsBatch.output>
/** The fleet's muted-camera list. */
type DeviceMutes = z.infer<typeof notificationRulesCapability.methods.listDeviceMutes.output>
/** The caps a device TYPE can bind, with their wrappers. */
type BindableCaps = z.infer<
  typeof deviceManagerCapability.methods.listBindableCapsForDeviceType.output
>
/** Every per-broker restream entry on one node. */
type RtspEntries = z.infer<typeof streamBrokerCapability.methods.getAllRtspEntries.output>
/** One node's detection-runtime provisioning snapshot. */
type EngineProvisioning = z.infer<
  typeof pipelineExecutorCapability.methods.getEngineProvisioning.output
>
/** The executor's bootstrap engine choice. */
type SelectedEngine = z.infer<typeof pipelineExecutorCapability.methods.getSelectedEngine.output>

/**
 * Keep a rejection from becoming an UNHANDLED one.
 *
 * A shared promise is created by the first camera to ask and consumed by the
 * others later — `listBindableCapsForDeviceType` is reached in stage 2 of
 * `readSwitchAuthorities`, after an await, so two cameras genuinely attach
 * their handlers in different ticks. Without this the first rejection would be
 * unhandled for the window in between.
 *
 * The handler is a no-op ON PURPOSE: it never becomes the answer. Every real
 * consumer attaches its own `.catch` and reports the failure per camera.
 */
function keepAlive<T>(p: Promise<T>): Promise<T> {
  void p.catch((): void => undefined)
  return p
}

/**
 * A read in flight, and the cap method that is actually serving it.
 *
 * The method matters to the CALLER, not to the pass: every failure here is
 * reported per camera, and a line that names a method nobody called cannot be
 * grepped back to the call that failed. Two of the reads below change shape
 * with the size of the pass — a set of one asks the singular method — so the
 * name cannot be a constant at the call site.
 */
export interface PassRead<T> {
  /** The cap method this read is issued against, as a warn line must name it. */
  readonly source: string
  readonly result: Promise<T>
}

/** What a pass needs to ask its questions. */
export interface FleetReadPassDeps {
  /**
   * Every camera this pass will compose, fixed at construction. The two SET
   * reads (`listAll`, `getBindingsBatch`) are issued for exactly this list, so
   * a pass of one is one row and a pass of twenty-nine is one round trip.
   */
  readonly deviceIds: readonly number[]
}

export class FleetReadPass {
  private roster: Promise<DeviceRoster> | null = null
  private bindings: Promise<BindingRows> | null = null
  private mutes: Promise<DeviceMutes> | null = null
  private readonly bindableByType = new Map<string, Promise<BindableCaps>>()
  private readonly slotsByNode = new Map<string, Promise<readonly ProfileSlot[]>>()
  private readonly rtspByNode = new Map<string, Promise<RtspEntries>>()
  private readonly provisioningByNode = new Map<string, Promise<EngineProvisioning>>()
  private readonly selectedEngineByNode = new Map<string, Promise<SelectedEngine>>()

  constructor(private readonly deps: FleetReadPassDeps) {}

  /** The cameras this pass covers — the set both batch reads are issued for. */
  get deviceIds(): readonly number[] {
    return this.deps.deviceIds
  }

  /**
   * The device rows for the pass's set.
   *
   * **The shape follows the SET, not the caller.** A pass of one asks
   * `getDevice` — the exact question, and the one the write path
   * (`CameraSwitchService.setCameraSwitch`) has always asked. A pass of many
   * asks `listAll({deviceIds})`, which exists precisely because "these N" was
   * otherwise either N round trips or the whole fleet. Answering a set of one
   * with the fleet-shaped method would be no cheaper and would move the write
   * path onto a read it does not need.
   *
   * `projection: 'slim'` because the only fields read off it are `type` and
   * `disabled`: the full projection reads each device's settings row, which is
   * the per-device round trip this whole change exists to remove.
   */
  deviceRoster(api: AddonApi): PassRead<DeviceRoster> {
    const single = this.deps.deviceIds.length === 1 ? this.deps.deviceIds[0] : undefined
    const source = single === undefined ? 'deviceManager.listAll' : 'deviceManager.getDevice'
    if (this.roster === null) {
      this.roster = keepAlive(
        single === undefined
          ? api.deviceManager.listAll.query({
              deviceIds: [...this.deps.deviceIds],
              projection: 'slim',
            })
          : api.deviceManager.getDevice
              .query({ deviceId: single })
              .then((row): DeviceRoster => (row === null ? [] : [row])),
      )
    }
    return { source, result: this.roster }
  }

  /** The binding rows for the pass's set — `getBindings` for one, the batch for many. */
  bindingRows(api: AddonApi): PassRead<BindingRows> {
    const single = this.deps.deviceIds.length === 1 ? this.deps.deviceIds[0] : undefined
    const source =
      single === undefined ? 'deviceManager.getBindingsBatch' : 'deviceManager.getBindings'
    if (this.bindings === null) {
      this.bindings = keepAlive(
        single === undefined
          ? api.deviceManager.getBindingsBatch.query({ deviceIds: [...this.deps.deviceIds] })
          : api.deviceManager.getBindings
              .query({ deviceId: single })
              .then((row): BindingRows => [row]),
      )
    }
    return { source, result: this.bindings }
  }

  /** The fleet's muted-camera list. One answer for every camera in the pass. */
  mutedDevices(api: AddonApi): Promise<DeviceMutes> {
    if (this.mutes === null) {
      this.mutes = keepAlive(api.notificationRules.listDeviceMutes.query({}))
    }
    return this.mutes
  }

  /** The bindable caps for one device TYPE. Every camera shares one answer. */
  bindableCapsFor(api: AddonApi, deviceType: string): Promise<BindableCaps> {
    const existing = this.bindableByType.get(deviceType)
    if (existing !== undefined) return existing
    const created = keepAlive(api.deviceManager.listBindableCapsForDeviceType.query({ deviceType }))
    this.bindableByType.set(deviceType, created)
    return created
  }

  /** One source node's whole profile-slot table. */
  profileSlots(api: AddonApi, sourceNodeId: string): Promise<readonly ProfileSlot[]> {
    const existing = this.slotsByNode.get(sourceNodeId)
    if (existing !== undefined) return existing
    const created = keepAlive(
      api.streamBroker.listAllProfileSlots.query(undefined, nodePin(sourceNodeId)),
    )
    this.slotsByNode.set(sourceNodeId, created)
    return created
  }

  /** One source node's whole RTSP-restream table. */
  rtspEntries(api: AddonApi, sourceNodeId: string): Promise<RtspEntries> {
    const existing = this.rtspByNode.get(sourceNodeId)
    if (existing !== undefined) return existing
    const created = keepAlive(api.streamBroker.getAllRtspEntries.query({}, nodePin(sourceNodeId)))
    this.rtspByNode.set(sourceNodeId, created)
    return created
  }

  /** One detection node's runtime-provisioning snapshot. */
  engineProvisioning(api: AddonApi, detectionNodeId: string): Promise<EngineProvisioning> {
    const existing = this.provisioningByNode.get(detectionNodeId)
    if (existing !== undefined) return existing
    const created = keepAlive(
      api.pipelineExecutor.getEngineProvisioning.query({ nodeId: detectionNodeId }),
    )
    this.provisioningByNode.set(detectionNodeId, created)
    return created
  }

  /** The executor's bootstrap engine, as the detection stage reads it. */
  selectedEngine(api: AddonApi, detectionNodeId: string): Promise<SelectedEngine> {
    const existing = this.selectedEngineByNode.get(detectionNodeId)
    if (existing !== undefined) return existing
    const created = keepAlive(
      api.pipelineExecutor.getSelectedEngine.query({ nodeId: detectionNodeId }),
    )
    this.selectedEngineByNode.set(detectionNodeId, created)
    return created
  }
}
