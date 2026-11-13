/** The humidifier page of the approved mockup. */
import type { HumidifierCardModel, HumidifierModeOption } from '../scenes/humidifier/model'
import type { CardOrientation } from '../shell/model'
import { offline } from './common'
import { deviceCommon } from './wave-d-common'

export interface HumidifierFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: HumidifierCardModel
}

const MODES: readonly HumidifierModeOption[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'normal', label: 'Normale' },
  { id: 'sleep', label: 'Notte' },
]

const humid = () =>
  deviceCommon({
    name: 'Umidificatore camera',
    integration: 'Xiaomi',
    watts: 24,
  })
const dehumid = () =>
  deviceCommon({
    name: 'Deumidificatore cantina',
    integration: 'De’Longhi',
    watts: 210,
  })

const base: Omit<HumidifierCardModel, 'common' | 'activity'> = {
  since: 'Auto',
  currentHumidity: 42,
  targetHumidity: 50,
  targetSettable: true,
  minHumidity: 30,
  maxHumidity: 80,
  mode: 'auto',
  modes: MODES,
  power: true,
}

export function humidifierFixtures(): readonly HumidifierFixture[] {
  return [
    {
      id: 'humid-on',
      caption: 'Umidifica',
      orientation: 'vertical',
      model: { ...base, common: humid(), activity: 'humidify' },
    },
    {
      id: 'humid-dry',
      caption: 'Deumidifica',
      orientation: 'vertical',
      model: {
        ...base,
        common: dehumid(),
        activity: 'dry',
        currentHumidity: 68,
        targetHumidity: 55,
        modes: [],
        mode: null,
        since: null,
      },
    },
    {
      id: 'humid-idle',
      caption: 'Al target',
      orientation: 'vertical',
      model: {
        ...base,
        common: humid(),
        activity: 'idle',
        currentHumidity: 50,
      },
    },
    {
      id: 'humid-off',
      caption: 'Spento',
      orientation: 'vertical',
      model: {
        ...base,
        common: humid(),
        activity: 'off',
        power: false,
        since: '3 h',
      },
    },
    {
      id: 'humid-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: { ...base, common: offline(humid()), activity: 'humidify' },
    },
    {
      id: 'humid-horizontal',
      caption: 'Orizzontale · umidità non riportata',
      orientation: 'horizontal',
      model: {
        ...base,
        common: humid(),
        activity: 'humidify',
        currentHumidity: null,
      },
    },
  ]
}
