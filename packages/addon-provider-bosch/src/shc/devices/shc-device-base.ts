import { z } from 'zod'
import { BaseDevice, errMsg, type DeviceContext, type DeviceFeature } from '@camstack/types'
import { shcConnections } from '../shc-gateway.js'
import type { ShcClient } from '../shc-client.js'

export const shcDeviceSchema = z.object({
  shcDeviceId: z.string().min(1).describe('Bosch SHC device id'),
  brokerId: z.string().min(1).describe('Integration id'),
  deviceModel: z.string().optional(),
  system: z.literal('bosch-shc').optional(),
  integrationId: z.string().optional(),
  tempStep: z.number().positive().optional(),
})

export type ShcDeviceConfig = z.infer<typeof shcDeviceSchema>

export abstract class ShcBaseDevice extends BaseDevice<typeof shcDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  protected readonly shcDeviceId: string
  protected readonly brokerId: string
  protected readonly deviceModel: string | undefined

  private stateUnsub: (() => void) | null = null

  protected constructor(ctx: DeviceContext) {
    const persisted = shcDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, shcDeviceSchema, { type: ctx.deviceMeta.type })
    this.shcDeviceId = persisted.shcDeviceId
    this.brokerId = persisted.brokerId
    this.deviceModel = persisted.deviceModel
    this.online = shcConnections.has(this.brokerId)
    void this.updateSourceInfo({ id: this.shcDeviceId, system: 'bosch-shc' })
  }

  protected resolveClient(): ShcClient | null {
    return shcConnections.getClient(this.brokerId)
  }

  protected requireClient(): ShcClient {
    const client = this.resolveClient()
    if (client === null) {
      throw new Error(`SHC client unavailable (device=${this.shcDeviceId})`)
    }
    return client
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCaps()
    this.attachStateListener()
    await this.refreshFromController()
  }

  override async removeDevice(): Promise<void> {
    if (this.stateUnsub) {
      try {
        this.stateUnsub()
      } catch {
        // best-effort
      }
      this.stateUnsub = null
    }
  }

  private attachStateListener(): void {
    const client = this.resolveClient()
    if (client === null) return
    const onEvent = (event: { deviceId?: string }): void => {
      if (event.deviceId !== this.shcDeviceId) return
      void this.refreshFromController().catch((err: unknown) => {
        this.deviceLog('warn', 'SHC refresh after controller event failed', {
          shcDeviceId: this.shcDeviceId,
          error: errMsg(err),
        })
      })
    }
    this.stateUnsub = client.onStateChange(onEvent)
  }

  protected deviceLog(
    level: 'info' | 'warn',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const extras = { tags: { deviceId: this.ctx.id }, ...(meta === undefined ? {} : { meta }) }
    if (level === 'warn') this.ctx.logger.warn(message, extras)
    else this.ctx.logger.info(message, extras)
  }

  protected unsupported(surface: string): never {
    throw new Error(`bosch-shc ${this.shcDeviceId}: ${surface} not supported`)
  }

  protected abstract registerCaps(): void

  protected abstract refreshFromController(): Promise<void>
}
