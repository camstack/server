import { z } from 'zod'
import {
  BaseDevice,
  IrMediumSchema,
  irTransmitterCapability,
  userError,
  type DeviceContext,
  type DeviceFeature,
  type InferNativeProvider,
  type IrSendResult,
  type IrTransmitterInfo,
  type TransmitSettingKey,
  type TransmitSettings,
} from '@camstack/types'
import { espLinkHub } from '../esphome-link-hub.js'
import { EspServiceError, type EspServiceArgValue } from '../esphome-link.js'
import { EspServiceRunner } from '../esphome-services.js'

/** Longest train one board service call is asked to carry. */
export const ESP_IR_MAX_TIMINGS = 512

/**
 * Persisted config of one transmitter child, stamped at spawn from the plan
 * (`planIrServices`) so it restores without the board being reachable.
 */
export const espIrTransmitterSchema = z.object({
  brokerId: z.string().min(1).describe('Board this transmitter belongs to'),
  service: z.string().min(1).describe('API service that emits the pulse train'),
  timingsArg: z.string().min(1).describe('The int[] argument that receives the train'),
  carrierArg: z.string().min(1).optional().describe('The int argument that receives the carrier'),
  media: z.array(IrMediumSchema).min(1).default(['ir']),
})

export type EspIrTransmitterConfig = z.infer<typeof espIrTransmitterSchema>

/**
 * One API service of an ESPHome board, exposed as an `ir-transmitter`. It goes
 * through the board service runner (`executeService`), so a call is validated
 * against the service the board listed and logged like any other.
 *
 * A setting the service cannot take is not a refusal: the train is sent, the
 * key comes back in `ignoredSettings`, and the first time it happens for this
 * device is warned.
 */
export class EspIrTransmitterDevice extends BaseDevice<typeof espIrTransmitterSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly settings: EspIrTransmitterConfig
  private readonly runner: EspServiceRunner
  private readonly warnedSettings = new Set<string>()

  constructor(ctx: DeviceContext) {
    const parsed = espIrTransmitterSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, espIrTransmitterSchema, { type: ctx.deviceMeta.type })
    this.settings = parsed
    this.runner = new EspServiceRunner({
      getLink: (brokerId) => espLinkHub.link(brokerId),
      logger: ctx.logger,
    })
    const provider: InferNativeProvider<typeof irTransmitterCapability> = {
      send: async ({ timings, settings }) => this.transmit(timings, settings),
      getInfo: async () => this.describe(),
    }
    ctx.registerNativeCap(irTransmitterCapability, provider)
  }

  /** What this transmitter declares: medium, the settings it can apply, its bound. */
  describe(): IrTransmitterInfo {
    return {
      media: [...this.settings.media],
      settable: this.settableKeys(),
      maxTimings: ESP_IR_MAX_TIMINGS,
    }
  }

  async transmit(
    timings: readonly number[],
    settings: TransmitSettings = {},
  ): Promise<IrSendResult> {
    if (timings.length > ESP_IR_MAX_TIMINGS) {
      throw userError(
        'ir-transmitter.too-long',
        { count: timings.length, max: ESP_IR_MAX_TIMINGS },
        `The command has ${timings.length} pulses but the transmitter accepts at most ${ESP_IR_MAX_TIMINGS}`,
      )
    }
    const settable = this.settableKeys()
    const given = Object.entries(settings).filter(([, value]) => value !== undefined)
    const ignoredSettings = given.map(([key]) => key).filter((key) => !isSettable(settable, key))
    for (const key of ignoredSettings) this.warnIgnoredOnce(key)

    const args: Record<string, EspServiceArgValue> = { [this.settings.timingsArg]: [...timings] }
    const carrierHz = settings.carrierHz
    if (this.settings.carrierArg !== undefined && carrierHz !== undefined) {
      args[this.settings.carrierArg] = carrierHz
    }
    try {
      await this.runner.executeService(this.settings.brokerId, this.settings.service, args, this.id)
    } catch (err: unknown) {
      if (err instanceof EspServiceError && err.reason === 'not-connected') {
        throw userError(
          'ir-transmitter.offline',
          { name: this.name },
          `The transmitter ${this.name} is not reachable`,
        )
      }
      throw err
    }
    return { ok: true, ignoredSettings }
  }

  private settableKeys(): TransmitSettingKey[] {
    return this.settings.carrierArg === undefined ? [] : ['carrierHz']
  }

  private warnIgnoredOnce(setting: string): void {
    if (this.warnedSettings.has(setting)) return
    this.warnedSettings.add(setting)
    this.ctx.logger.warn('esphome: transmitter cannot apply a setting; sent without it', {
      tags: { deviceId: this.id },
      meta: { service: this.settings.service, setting },
    })
  }
}

function isSettable(settable: readonly TransmitSettingKey[], key: string): boolean {
  return settable.some((k) => k === key)
}
