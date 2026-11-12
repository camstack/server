/** The switch-heater page of the approved mockup: three heaters, the mockup's data. */
import type { HeaterCardModel } from '../scenes/heater/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface HeaterFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: HeaterCardModel
}

const MINUTE_MS = 60_000

/** The heater page shows neither the upstream supply nor a remote. */
const common = (name: string, watts: number): HeaterCardModel['common'] => ({
  ...mockupCommon({
    name,
    integration: 'Shelly',
    watts,
    supplyName: '',
    consumables: [],
    remote: [],
  }),
  battery: null,
  supply: null,
  consumables: null,
  remote: null,
})

/** `now` anchors the running cycle, so a shot always shows the same countdown. */
export function heaterFixtures(now: number = Date.now()): readonly HeaterFixture[] {
  return [
    {
      id: 'heater-running',
      caption: 'Ciclo a tempo in corso',
      orientation: 'vertical',
      model: {
        common: common('Stufa veranda', 1180),
        on: true,
        since: '40 min',
        timer: { defaultMinutes: 30, maxMinutes: 180, endsAt: now + 25 * MINUTE_MS },
      },
    },
    {
      id: 'heater-on',
      caption: 'Accesa',
      orientation: 'vertical',
      model: {
        common: common('Stufa bagno camerette', 900),
        on: true,
        since: '40 min',
        timer: { defaultMinutes: 30, maxMinutes: 180, endsAt: null },
      },
    },
    {
      id: 'heater-off',
      caption: 'Spenta',
      orientation: 'vertical',
      model: {
        common: common('Stufa bagno camera', 0),
        on: false,
        since: '2 h',
        timer: { defaultMinutes: 30, maxMinutes: 180, endsAt: null },
      },
    },
  ]
}
