import { TuyaDevice, type TuyaDeviceOptions } from '@apocaliss92/nodetuya'
import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  errMsg,
} from '@camstack/types'
import { z } from 'zod'
import { DEFAULT_SWITCH_DP } from '../tuya-dp-mapping.js'
import { tuyaConnections } from '../tuya-gateway.js'

/**
 * Persisted config every adopted Tuya device carries. `tuyaDeviceId` +
 * `integrationId` resolve the device on its account; `localKey` + `host` +
 * `version` are the LAN-control credentials (a SETTING captured at adoption from
 * the cloud catalog — never hard-coded). `switchDp` is the boolean DP a raw
 * on/off switch drives (default `'1'`); `category` is the Tuya product category
 * for provenance.
 */
export const tuyaDeviceConfigSchema = z.object({
  integrationId: z.string().min(1).describe('Owning Tuya integration id'),
  tuyaDeviceId: z.string().min(1).describe('Tuya cloud device id (gwId/devId)'),
  localKey: z
    .string()
    .min(1)
    .describe('Device local key (from the Tuya cloud)')
    .meta({ secret: true }),
  host: z.string().default('').describe('Device LAN IP / host'),
  version: z.string().default('3.3').describe('Tuya protocol version (3.1–3.5)'),
  switchDp: z.string().default(DEFAULT_SWITCH_DP).describe('Boolean DP a raw switch drives'),
  category: z.string().optional().describe('Tuya product category code'),
  system: z.literal('tuya').optional(),
  name: z.string().optional(),
})

export type TuyaDeviceConfig = z.infer<typeof tuyaDeviceConfigSchema>

/**
 * Shared base for an adopted Tuya device that OWNS a single live
 * `@apocaliss92/nodetuya` LAN client (Tuya permits only one TCP client per
 * device). The owner constructs + connects the {@link TuyaDevice}, publishes the
 * handle on the shared {@link tuyaConnections} resolver keyed by
 * `(integrationId, deviceId)` so any accessory children read/write through the
 * SAME connection, and pumps every `dps` push through the resolver's fan-out bus
 * so children recompute without each attaching a socket listener.
 *
 * Withhold-until-ready: a device with no known `host` stays offline (no client)
 * until Phase-C onboarding supplies the LAN address; `onDpsPush` lets a concrete
 * owner (the raw switch) recompute its own cap on each push.
 */
export abstract class TuyaBaseDevice extends BaseDevice<typeof tuyaDeviceConfigSchema> {
  readonly features: readonly DeviceFeature[] = []

  protected readonly integrationId: string
  protected readonly tuyaDeviceId: string
  protected readonly localKey: string
  protected readonly host: string
  protected readonly protocolVersion: string
  protected readonly switchDp: string

  #handle: TuyaDevice | null = null

  protected constructor(ctx: DeviceContext, type: DeviceType) {
    const cfg = tuyaDeviceConfigSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, tuyaDeviceConfigSchema, { type })
    this.integrationId = cfg.integrationId
    this.tuyaDeviceId = cfg.tuyaDeviceId
    this.localKey = cfg.localKey
    this.host = cfg.host
    this.protocolVersion = cfg.version.length > 0 ? cfg.version : '3.3'
    this.switchDp = cfg.switchDp
    this.online = false
    void this.updateSourceInfo({ id: this.tuyaDeviceId, system: 'tuya' })
  }

  /** The live handle this owner holds, or null when not connected. */
  protected get handle(): TuyaDevice | null {
    return this.#handle
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCaps()
    await this.startConnection()
  }

  override async removeDevice(): Promise<void> {
    await this.stopConnection()
  }

  /** Build + connect the single LAN client (best-effort), publish the handle. */
  protected async startConnection(): Promise<void> {
    if (this.#handle !== null) return
    if (this.host.trim().length === 0) {
      this.ctx.logger.debug('Tuya device: no LAN host yet — withholding connection', {
        meta: { tuyaDeviceId: this.tuyaDeviceId },
      })
      return
    }
    const options: TuyaDeviceOptions = {
      id: this.tuyaDeviceId,
      key: this.localKey,
      host: this.host,
      version: this.protocolVersion,
    }
    const device = new TuyaDevice(options)
    device.on('dps', () => this.handleDpsPush())
    device.on('connected', () => this.markConnected(true))
    device.on('disconnected', () => this.markConnected(false))
    device.on('error', (err: Error) => {
      this.ctx.logger.debug('Tuya device: client error', {
        meta: { tuyaDeviceId: this.tuyaDeviceId, error: errMsg(err) },
      })
    })
    this.#handle = device
    tuyaConnections.setHandle(this.integrationId, this.tuyaDeviceId, device)
    try {
      await device.connect()
      await device.get()
      this.handleDpsPush()
    } catch (err: unknown) {
      this.ctx.logger.warn('Tuya device: initial connect failed — will stay offline', {
        meta: { tuyaDeviceId: this.tuyaDeviceId, error: errMsg(err) },
      })
    }
  }

  /** Disconnect + unpublish the handle. */
  protected async stopConnection(): Promise<void> {
    const device = this.#handle
    this.#handle = null
    tuyaConnections.setHandle(this.integrationId, this.tuyaDeviceId, null)
    if (device) {
      try {
        device.disconnect()
      } catch (err: unknown) {
        this.ctx.logger.debug('Tuya device: disconnect error', {
          meta: { tuyaDeviceId: this.tuyaDeviceId, error: errMsg(err) },
        })
      }
    }
    return Promise.resolve()
  }

  private handleDpsPush(): void {
    try {
      this.onDpsPush()
    } catch (err: unknown) {
      this.ctx.logger.warn('Tuya device: dps handler error', {
        meta: { tuyaDeviceId: this.tuyaDeviceId, error: errMsg(err) },
      })
    }
    // Fan out to any accessory children owning no socket of their own.
    tuyaConnections.emitDps(this.integrationId, this.tuyaDeviceId)
  }

  private markConnected(connected: boolean): void {
    if (this.online === connected) return
    this.markOnline(connected)
  }

  /** Register this owner's own device-native cap(s). */
  protected abstract registerCaps(): void

  /** Recompute this owner's own cap slice(s) from the latest `dps`. No-op for a
   *  container whose caps live entirely on its children. */
  protected abstract onDpsPush(): void
}
