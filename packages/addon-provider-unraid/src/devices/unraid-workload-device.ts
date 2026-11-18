import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  type InferNativeProvider,
  registerPowerSwitch,
  type WorkloadStatus,
  workloadCapability,
} from '@camstack/types'
import { z } from 'zod'
import { UNRAID_SYSTEM } from '../config.js'
import type { UnraidClientLike } from '../unraid-client-contract.js'
import {
  findWorkload,
  type UnraidWorkloadMatch,
  type UnraidWorkloadRef,
  UnraidWorkloadRefSchema,
} from '../unraid-discovery.js'
import { UnraidIdentityDeclarer, unraidVmIdentifiers } from '../unraid-identifiers.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import {
  answeringSnapshot,
  unknownWorkloadStatus,
  unraidServerReach,
  unraidWorkloadOptions,
  unraidWorkloadStatus,
} from '../unraid-workload-state.js'

/**
 * Persisted config of an adopted Docker container or VM. `workload` names it the way that
 * survives on the server: a container by its name (Unraid recreates a container, with a new
 * id, on every update), a VM by its libvirt domain UUID (the local part of its id).
 */
export const unraidWorkloadSchema = z.object({
  nativeId: z.string().min(1),
  integrationId: z.string().min(1).describe('Owning integration'),
  workload: UnraidWorkloadRefSchema,
  system: z.literal(UNRAID_SYSTEM).optional(),
})

export type UnraidWorkloadConfig = z.infer<typeof unraidWorkloadSchema>

type WorkloadProvider = InferNativeProvider<typeof workloadCapability>

/** The start / stop / pause / resume of one kind, by the item's API id. */
interface WorkloadLifecycle {
  readonly start: (id: string) => Promise<void>
  readonly stop: (id: string) => Promise<void>
  readonly pause: (id: string) => Promise<void>
  readonly resume: (id: string) => Promise<void>
}

/** One action against the live item: the client and the item's current API id. */
type WorkloadCommand = (client: UnraidClientLike, id: string) => Promise<void>

/**
 * One Docker container or VM of an Unraid server, adopted on its own: a top-level `workload`
 * device (role `app-container` or `vm`) named after it, a sibling of the server's Host (its
 * `hostDeviceId`). It serves the `workload` cap from the poll
 * snapshot, with the controls node-unraid has for its kind, and the `switch` its power hint
 * derives. A row adopted before the workload type (a Generic device) serves no cap.
 */
export class UnraidWorkloadDevice extends BaseDevice<typeof unraidWorkloadSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private readonly ref: UnraidWorkloadRef
  private snapshotUnsub: (() => void) | null = null
  private identityUnsub: (() => void) | null = null
  private readonly identity: UnraidIdentityDeclarer

  constructor(ctx: DeviceContext) {
    const cfg = unraidWorkloadSchema.parse(ctx.persistedConfig ?? {})
    // The type the adoption stamped, never a second decision here.
    super(ctx, unraidWorkloadSchema, { type: ctx.deviceMeta.type })
    this.integrationId = cfg.integrationId
    this.ref = cfg.workload
    this.identity = new UnraidIdentityDeclarer({
      deviceId: this.id,
      logger: ctx.logger,
      writer: ctx.api.deviceManager?.setIdentifiers,
    })
    this.online = unraidInstances.getSnapshot(cfg.integrationId) !== null
    void this.updateSourceInfo({
      id: `${cfg.integrationId}:${cfg.nativeId}`,
      system: UNRAID_SYSTEM,
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // A VM declares its domain uuid (D1059), whatever the device type; a container has none.
    if (this.ref.kind === 'vm') {
      const declareIdentity = (): void => {
        const match = this.match()
        void this.identity.declare(unraidVmIdentifiers(match?.kind === 'vm' ? match.vm : null))
      }
      this.identityUnsub = unraidInstances.onSnapshot(this.integrationId, declareIdentity)
      declareIdentity()
    }
    // The cap is gated to `workload` devices; a legacy Generic row keeps none.
    if (this.type !== DeviceType.Workload) return
    const provider = this.buildProvider()
    this.ctx.registerNativeCap(workloadCapability, provider)
    registerPowerSwitch(this, workloadCapability, provider)
    this.runtimeState.setCapState(
      workloadCapability.name,
      unknownWorkloadStatus(unraidInstances.getHostDevice(this.integrationId), Date.now()),
    )
    this.snapshotUnsub = unraidInstances.onSnapshot(this.integrationId, () => this.recompute())
    this.recompute()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    this.identityUnsub?.()
    this.identityUnsub = null
    await super.removeDevice()
  }

  private buildProvider(): WorkloadProvider {
    const base: WorkloadProvider = {
      getOptions: async () => unraidWorkloadOptions(this.ref.kind),
      getStatus: async () =>
        this.runtimeState.getCapState<WorkloadStatus>(workloadCapability.name) ??
        unknownWorkloadStatus(unraidInstances.getHostDevice(this.integrationId), Date.now()),
      start: async () => this.run('start', (c, id) => this.lifecycle(c).start(id)),
      stop: async () => this.run('stop', (c, id) => this.lifecycle(c).stop(id)),
      pause: async () => this.run('pause', (c, id) => this.lifecycle(c).pause(id)),
      resume: async () => this.run('resume', (c, id) => this.lifecycle(c).resume(id)),
    }
    if (this.ref.kind === 'docker') {
      // The API has no atomic container restart: stop then start, by the same live id.
      return {
        ...base,
        restart: async () =>
          this.run('restart', async (c, id) => {
            await c.docker.stop(id)
            await c.docker.start(id)
          }),
      }
    }
    // A VM reboots (its restart) and force-stops; a container has no force stop in the API.
    return {
      ...base,
      restart: async () => this.run('restart', (c, id) => c.vms.reboot(id)),
      forceStop: async () => this.run('forceStop', (c, id) => c.vms.forceStop(id)),
    }
  }

  /** The kind's start / stop / pause / resume, under one shape. */
  private lifecycle(client: UnraidClientLike): WorkloadLifecycle {
    if (this.ref.kind === 'vm') {
      return {
        start: (id) => client.vms.start(id),
        stop: (id) => client.vms.stop(id),
        pause: (id) => client.vms.pause(id),
        resume: (id) => client.vms.resume(id),
      }
    }
    return {
      start: (id) => client.docker.start(id),
      stop: (id) => client.docker.stop(id),
      pause: (id) => client.docker.pause(id),
      resume: (id) => client.docker.unpause(id),
    }
  }

  /** The live item this device names, or null when the snapshot does not list it. */
  private match(): UnraidWorkloadMatch | null {
    return findWorkload(unraidInstances.getSnapshot(this.integrationId), this.ref)
  }

  /** Run one action against the item's CURRENT id (a container's changes on update), then re-poll. */
  private async run(action: string, command: WorkloadCommand): Promise<void> {
    const manager = unraidInstances.getManager(this.integrationId)
    const client = manager?.client ?? null
    const match = this.match()
    if (manager === null || client === null || match === null) {
      const reason = client === null ? 'not connected' : 'not listed by the server'
      this.ctx.logger.warn('unraid workload: action refused', {
        tags: { deviceId: this.id },
        meta: { action, workload: this.ref, reason },
      })
      throw new Error(`Unraid ${this.ref.kind} ${this.id}: cannot ${action}, ${reason}`)
    }
    const id = match.kind === 'docker' ? match.container.id : match.vm.id
    await command(client, id)
    this.ctx.logger.info('unraid workload: action sent', {
      tags: { deviceId: this.id },
      meta: { action, workload: this.ref },
    })
    await manager.poll()
  }

  /** The `workload` slice from the live snapshot; unknown while the server does not answer. */
  private recompute(): void {
    const snapshot = answeringSnapshot(
      unraidServerReach(unraidInstances.getManager(this.integrationId)),
    )
    this.runtimeState.setCapState(
      workloadCapability.name,
      unraidWorkloadStatus(
        findWorkload(snapshot, this.ref),
        unraidInstances.getHostDevice(this.integrationId),
        Date.now(),
      ),
    )
  }
}
