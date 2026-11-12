import {
  IR_NATIVE_CODECS,
  IrCodecError,
  userError,
  type IrLearnResult,
  type IrNativeCode,
  type IrSendResult,
  type IrTimings,
  type IrTransmitterInfo,
  type TransmitSettings,
} from '@camstack/types'
import { renderTemplate } from '../mqtt-ha-template.js'
import type { MqttHaIrMatch } from '../mqtt-ha-ir-profiles.js'

/** Longest train one MQTT code is asked to carry. */
export const MQTT_HA_IR_MAX_TIMINGS = 512

const LEARN_START_PAYLOAD = 'ON'

export interface MqttHaIrBridgeDeps {
  readonly match: MqttHaIrMatch
  readonly publish: (topic: string, payload: string) => Promise<void>
  readonly deviceName: string
}

interface LearnWaiter {
  readonly resolve: (code: string) => void
}

/**
 * The transmitter behaviour of one profile-matched MQTT device: a code is sent
 * by publishing it to the `send` entity, learning is a command on the `learn`
 * entity followed by the NEXT value of the `learned` entity.
 */
export class MqttHaIrBridge {
  private waiter: LearnWaiter | null = null

  constructor(private readonly deps: MqttHaIrBridgeDeps) {}

  describe(): IrTransmitterInfo {
    return {
      media: ['ir'],
      settable: [],
      maxTimings: MQTT_HA_IR_MAX_TIMINGS,
      learn: true,
      formats: [this.deps.match.profile.format],
    }
  }

  async send(input: {
    readonly timings?: IrTimings | undefined
    readonly native?: IrNativeCode | undefined
    readonly settings?: TransmitSettings | undefined
  }): Promise<IrSendResult> {
    const { format } = this.deps.match.profile
    const code = this.codeToSend(input, format)
    const topic = this.deps.match.send.commandTopic
    if (topic === null) throw new Error('mqtt-ha: the code entity has no command topic')
    await this.deps.publish(topic, code)
    const ignoredSettings = Object.entries(input.settings ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
    return { ok: true, ignoredSettings }
  }

  private codeToSend(
    input: { readonly timings?: IrTimings | undefined; readonly native?: IrNativeCode | undefined },
    format: IrNativeCode['format'],
  ): string {
    if (input.native !== undefined) {
      if (input.native.format !== format) {
        throw userError(
          'ir-transmitter.native-unsupported',
          { name: this.deps.deviceName, format: input.native.format },
          `The transmitter ${this.deps.deviceName} does not replay ${input.native.format} codes`,
        )
      }
      return input.native.code
    }
    if (input.timings === undefined) {
      throw userError('ir-transmitter.no-code', {}, 'send takes timings or a native code')
    }
    if (input.timings.length > MQTT_HA_IR_MAX_TIMINGS) {
      throw userError(
        'ir-transmitter.too-long',
        { count: input.timings.length, max: MQTT_HA_IR_MAX_TIMINGS },
        `The command has ${input.timings.length} pulses but the transmitter accepts at most ${MQTT_HA_IR_MAX_TIMINGS}`,
      )
    }
    return IR_NATIVE_CODECS[format].encode(input.timings)
  }

  /** Feed a message of the `learned` entity; resolves a pending learn with it. */
  onLearnedMessage(payload: string): void {
    const waiter = this.waiter
    if (waiter === null) return
    const code = renderTemplate(this.deps.match.learned.valueTemplate, payload)
    if (code === null || code.length === 0) return
    this.waiter = null
    waiter.resolve(code)
  }

  async learn(timeoutMs: number): Promise<IrLearnResult> {
    const topic = this.deps.match.learn.commandTopic
    if (topic === null) throw new Error('mqtt-ha: the learn entity has no command topic')
    if (this.waiter !== null) {
      throw userError(
        'ir-transmitter.learn-busy',
        { name: this.deps.deviceName },
        `The transmitter ${this.deps.deviceName} is already learning`,
      )
    }
    // Armed BEFORE the command, so a fast answer is not missed; whatever the
    // entity held earlier (retained or previous) never reaches the waiter.
    const next = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve(null)
      }, timeoutMs)
      this.waiter = {
        resolve: (code) => {
          clearTimeout(timer)
          resolve(code)
        },
      }
    })
    try {
      await this.deps.publish(topic, LEARN_START_PAYLOAD)
    } catch (err: unknown) {
      this.waiter = null
      throw err
    }
    const code = await next
    if (code === null) {
      throw userError(
        'ir-transmitter.learn-timeout',
        { name: this.deps.deviceName, timeoutMs },
        `The transmitter ${this.deps.deviceName} learned nothing within ${Math.round(timeoutMs / 1000)} s`,
      )
    }
    return this.decode(code)
  }

  private decode(code: string): IrLearnResult {
    const { format } = this.deps.match.profile
    try {
      return {
        native: { format, code },
        timings: IR_NATIVE_CODECS[format].decode(code),
        carrierHz: null,
      }
    } catch (err: unknown) {
      if (err instanceof IrCodecError) {
        throw userError(
          'ir-transmitter.learn-undecodable',
          { name: this.deps.deviceName, format },
          `The code learned by ${this.deps.deviceName} is not a valid ${format} code`,
        )
      }
      throw err
    }
  }
}
