import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  type IDevice,
  userError,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  enpalConnectionSchema,
  readConnection,
  slugifyHost,
} from './config.js'
import { EnpalBoxDevice } from './devices/enpal-box-device.js'
import { EnpalSensorDevice } from './devices/enpal-sensor-device.js'

/**
 * Enpal solar box provider, `mode: standalone` (the VeSync / Ecowitt pattern, no broker).
 * A box is added as a {@link DeviceType.Hub} through the manual-creation form: its host,
 * InfluxDB access and token live on the device. The box registers `device-discovery` and
 * adopts the data groups it reports as Sensor devices. The box does not advertise itself on
 * the network, so there is no auto-discovery of the box itself.
 */
export class EnpalProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-enpal'
  protected readonly providerName = 'Enpal'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: EnpalBoxDevice,
    [DeviceType.Sensor]: EnpalSensorDevice,
  }

  constructor() {
    super({})
  }

  override async supportsDiscovery(): Promise<boolean> {
    return false
  }

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    return type === DeviceType.Hub ? buildConnectionFormSchema() : null
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`Enpal provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (name.length === 0) throw userError('enpal.name-required', undefined, 'Box name is required')

    const parsed = enpalConnectionSchema.safeParse(config['connection'] ?? config)
    if (!parsed.success || parsed.data.host.length === 0) {
      throw userError('enpal.host-required', undefined, 'The box host or IP is required')
    }
    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection: parsed.data, system: 'enpal-box' },
    }
  }

  /** One row per box host: re-adding the same box reuses its persisted row. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const raw = config?.['connection'] ?? config
    const host = readConnection(raw).connection.host
    if (host.length > 0) return `enpal:${slugifyHost(host)}`
    throw new Error('Enpal: box resolved no host — cannot persist a stable row key.')
  }
}
