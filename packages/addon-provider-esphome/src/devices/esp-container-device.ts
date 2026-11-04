import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceRole,
  DeviceType,
  errMsg,
  type AccessoryChildSpec,
  type DeviceContext,
} from '@camstack/types'
import { childConfigFor, childFactoryFor, deviceTypeOf, roleOf } from '../esphome-child-spec.js'
import { planBoard, type ChildPlan } from '../esphome-entity-spec.js'
import { espIrOverrides } from '../esphome-ir-overrides.js'
import { planIrServices, type IrServicePlan } from '../esphome-ir-plan.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { EspIrTransmitterDevice } from './esp-ir-transmitter-device.js'

/**
 * Persisted config of a board container. One board = one container; its
 * children are derived from the board's own entity list on every connect, so
 * nothing about them is persisted here.
 */
export const espContainerSchema = z.object({
  brokerId: z.string().min(1),
  integrationId: z.string().optional(),
  /** Adoption provenance, read by the offline filter and the cascade-remove. */
  system: z.literal('esphome').optional(),
  /** The board's own name, for the candidate list and the resync check. */
  boardName: z.string().optional(),
})

export type EspContainerConfig = z.infer<typeof espContainerSchema>

/**
 * The parent device of one ESPHome board. It owns no control cap itself: it
 * declares {@link getAccessoryChildren} and the kernel spawns and reconciles one
 * child per mapped entity (switch, light, sensor, power meter...). The children
 * come from the live link, so a container restored while the board is
 * unreachable spawns nothing and prunes nothing (see {@link onProbe}).
 */
export class EspContainerDevice extends BaseDevice<typeof espContainerSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly brokerId: string
  private readonly integrationId: string | undefined
  /** False until the kernel has finished the registration reconcile (onActivate). */
  private registrationSettled = false
  /** A connect arrived while that reconcile was still spawning children. */
  private connectDuringRegistration = false
  /** Overlapping reconciles would register the same child twice. */
  private reconcileChain: Promise<void> = Promise.resolve()

  constructor(ctx: DeviceContext) {
    const cfg = espContainerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, espContainerSchema, { type: DeviceType.Container })
    this.brokerId = cfg.brokerId
    this.integrationId = cfg.integrationId
    this.online = espLinkHub.link(this.brokerId) !== null
    void this.updateSourceInfo({ id: this.brokerId, system: 'esphome' })
  }

  /**
   * Stamp `feature-probe.lastProbedAt` only while the board is reachable. An
   * empty child list together with a stamped probe is how the kernel prunes
   * orphaned accessory children: a restore that races an unreachable board
   * would otherwise delete every child. Leaving the probe unstamped keeps that
   * gate closed; {@link onBoardConnected} completes it once registration has settled.
   */
  override async onProbe(): Promise<void> {
    if (espLinkHub.link(this.brokerId) === null) return
    await super.onProbe()
  }

  /**
   * The kernel calls this after its own registration reconcile. A connect that
   * landed during that reconcile is run now, so it cannot register the same
   * child a second time while the first spawn is still in flight.
   */
  override async onActivate(): Promise<void> {
    this.registrationSettled = true
    if (!this.connectDuringRegistration) return
    this.connectDuringRegistration = false
    await this.reconcileBoard()
  }

  /** The board session connected. Deferred while registration is still spawning. */
  onBoardConnected(): void {
    if (!this.registrationSettled) {
      this.connectDuringRegistration = true
      return
    }
    void this.reconcileBoard().catch((err: unknown) => {
      this.ctx.logger.warn('esphome: board reconcile failed', {
        tags: { deviceId: this.id },
        meta: { brokerId: this.brokerId, error: errMsg(err) },
      })
    })
  }

  /** Re-read the live board and reconcile its children, after any reconcile already running. */
  reconcileBoard(): Promise<void> {
    if (!this.registrationSettled) {
      this.connectDuringRegistration = true
      return Promise.resolve()
    }
    const run = this.reconcileChain.then(() => this.reprobe())
    this.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const link = espLinkHub.link(this.brokerId)
    if (link === null) {
      this.ctx.logger.debug('esphome: board not connected; no children yet', {
        tags: { deviceId: this.id },
        meta: { brokerId: this.brokerId },
      })
      return []
    }
    const entityChildren = planBoard(link.entities()).map((plan) => this.childSpec(plan))
    const transmitters = planIrServices(link.listServices(), espIrOverrides.get(this.id)).map(
      (plan) => this.irChildSpec(plan),
    )
    return this.oneSpecPerSuffix([...entityChildren, ...transmitters])
  }

  /** One child per suffix. A repeated entity (the list answered twice) is not a second device. */
  private oneSpecPerSuffix(specs: readonly AccessoryChildSpec[]): readonly AccessoryChildSpec[] {
    const seen = new Set<string>()
    const unique: AccessoryChildSpec[] = []
    for (const spec of specs) {
      if (seen.has(spec.stableIdSuffix)) {
        this.ctx.logger.warn('esphome: board entity repeated; the second child is not registered', {
          tags: { deviceId: this.id },
          meta: { brokerId: this.brokerId, stableIdSuffix: spec.stableIdSuffix },
        })
        continue
      }
      seen.add(spec.stableIdSuffix)
      unique.push(spec)
    }
    return unique
  }

  /** One `ir-transmitter` child per API service the board exposes as a transmitter. */
  private irChildSpec(plan: IrServicePlan): AccessoryChildSpec {
    return {
      stableIdSuffix: `svc:${plan.name}`,
      meta: {
        type: DeviceType.Generic,
        name: plan.name,
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        role: String(DeviceRole.IrTransmitter),
      },
      config: {
        brokerId: this.brokerId,
        service: plan.name,
        timingsArg: plan.timingsArg,
        ...(plan.carrierArg !== undefined ? { carrierArg: plan.carrierArg } : {}),
        media: [...plan.media],
      },
      factory: (ctx) => new EspIrTransmitterDevice(ctx),
    }
  }

  private childSpec(plan: ChildPlan): AccessoryChildSpec {
    const role = roleOf(plan.kind)
    const name = plan.name.length > 0 ? plan.name : this.name
    return {
      stableIdSuffix: plan.key,
      meta: {
        type: deviceTypeOf(plan.kind),
        name,
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        ...(role !== undefined ? { role: String(role) } : {}),
      },
      config: { ...childConfigFor(plan, this.brokerId) },
      factory: childFactoryFor(plan.kind),
    }
  }
}
