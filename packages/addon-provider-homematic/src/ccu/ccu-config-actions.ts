import type { CcuActionDeps } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import type { ChannelConfig, ConfigValue, DeviceConfig } from './ccu-schemas.js'

interface DeviceInput {
  readonly integrationId: string
  readonly address: string
}
interface SetChannelConfigInput {
  readonly integrationId: string
  readonly channel: string
  readonly values: Readonly<Record<string, ConfigValue>>
  readonly confirmed: boolean
}

/** The MASTER paramset editor: read a device's per-channel parameters, write a changed set to one channel. */
export function buildCcuConfigHandlers(deps: CcuActionDeps) {
  return {
    getCcuDeviceConfig: async (input: DeviceInput): Promise<DeviceConfig> => {
      const facade = requireFacade(deps, input.integrationId)
      const device = facade.devices().find((candidate) => candidate.address === input.address)
      if (device === undefined) {
        throw new Error(`Device ${input.address} is not known to the CCU`)
      }
      const channels: ChannelConfig[] = []
      for (const channel of device.channels) {
        const specs = facade.getConfigParams(channel.address)
        if (specs.length === 0) continue
        let values: Readonly<Record<string, ConfigValue>> = {}
        let error: string | null = null
        try {
          values = await facade.getConfig(channel.address)
        } catch (err) {
          error = errorText(err)
          deps.logger.warn('Homematic: channel configuration unreadable', {
            meta: {
              integrationId: input.integrationId,
              channel: channel.address,
              error,
            },
          })
        }
        channels.push({
          channel: channel.address,
          channelType: channel.type ?? null,
          error,
          params: specs.map((spec) => ({
            parameter: spec.parameter,
            type: spec.type,
            min: spec.min ?? null,
            max: spec.max ?? null,
            unit: spec.unit ?? null,
            valueList: spec.valueList === undefined ? null : [...spec.valueList],
            writable: spec.writable,
            value: values[spec.parameter] ?? null,
          })),
        })
      }
      return { channels }
    },

    setCcuChannelConfig: async (input: SetChannelConfigInput): Promise<{ ok: true }> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      const names = Object.keys(input.values)
      if (names.length === 0) throw new Error('Nothing to change: no parameter was edited')
      const writable = new Set(
        facade
          .getConfigParams(input.channel)
          .filter((spec) => spec.writable)
          .map((spec) => spec.parameter),
      )
      const refused = names.filter((name) => !writable.has(name))
      if (refused.length > 0) {
        throw new Error(`Not a writable parameter of ${input.channel}: ${refused.join(', ')}`)
      }
      await facade.setConfig(input.channel, { ...input.values })
      deps.logger.info('Homematic: channel configuration written', {
        meta: { integrationId: input.integrationId, channel: input.channel, parameters: names },
      })
      return { ok: true }
    },
  }
}
