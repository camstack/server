/** The weather page of the approved mockup. */
import type { WeatherCardModel } from '../scenes/weather/model'
import type { CardOrientation } from '../shell/model'
import { offline } from './common'
import { deviceCommon } from './wave-d-common'

export interface WeatherFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: WeatherCardModel
}

const home = () => deviceCommon({ name: 'Meteo casa', integration: 'Met.no' })

const base: Omit<WeatherCardModel, 'common' | 'condition'> = {
  since: 'aggiornata 10 min fa',
  temperature: 18.4,
  humidity: 62,
  pressure: 1016,
  windSpeed: 3.2,
  windBearing: 225,
}

export function weatherFixtures(): readonly WeatherFixture[] {
  return [
    {
      id: 'weather-sunny',
      caption: 'Sereno',
      orientation: 'vertical',
      model: { ...base, common: home(), condition: 'sunny' },
    },
    {
      id: 'weather-rain',
      caption: 'Pioggia',
      orientation: 'vertical',
      model: {
        ...base,
        common: home(),
        condition: 'rainy',
        temperature: 11.2,
        humidity: 91,
      },
    },
    {
      id: 'weather-night',
      caption: 'Notte serena · senza vento',
      orientation: 'vertical',
      model: {
        ...base,
        common: home(),
        condition: 'clear-night',
        windSpeed: null,
        windBearing: null,
      },
    },
    {
      id: 'weather-offline',
      caption: 'Offline · nessuna lettura',
      orientation: 'vertical',
      model: {
        common: offline(home()),
        condition: null,
        since: null,
        temperature: null,
        humidity: null,
        pressure: null,
        windSpeed: null,
        windBearing: null,
      },
    },
    {
      id: 'weather-horizontal',
      caption: 'Orizzontale',
      orientation: 'horizontal',
      model: { ...base, common: home(), condition: 'partlycloudy' },
    },
  ]
}
