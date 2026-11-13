/** What every wave D fixture shares: a device with a battery or a power reading, no supply, no remote. */
import type { CardCommon } from '../shell/model'
import { mockupCommon } from './common'

export interface DeviceFixtureInput {
  readonly name: string
  readonly integration: string
  /** A battery level; omitted when the device is mains-powered. */
  readonly battery?: number
  /** A power reading, W; omitted when there is none. */
  readonly watts?: number
}

export function deviceCommon(input: DeviceFixtureInput): CardCommon {
  const base = mockupCommon({
    name: input.name,
    integration: input.integration,
    watts: input.watts ?? 0,
    supplyName: '',
    consumables: [],
    remote: [],
    battery: input.battery,
  })
  return {
    ...base,
    power: input.watts === undefined ? null : base.power,
    battery: input.battery === undefined ? null : base.battery,
    supply: null,
    consumables: null,
    remote: null,
  }
}
