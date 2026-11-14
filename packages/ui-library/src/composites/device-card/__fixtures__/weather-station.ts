/** A full outdoor station and a sparse one (most readings absent). */
import type { WeatherStationCardModel } from '../scenes/weather-station/model'
import type { CardOrientation } from '../shell/model'
import { deviceCommon } from './wave-d-common'

export interface WeatherStationFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: WeatherStationCardModel
}

const home = () => deviceCommon({ name: 'Giardino', integration: 'Ecowitt' })

const full: Omit<WeatherStationCardModel, 'common'> = {
  since: 'aggiornata 2 min fa',
  temperature: 18.4,
  humidity: 62,
  pressure: 1016,
  windSpeed: 3.2,
  windGust: 7.1,
  windBearing: 225,
  rainRate: 1.4,
  rainDaily: 6.2,
  rainEvent: 2.1,
  uv: 4.2,
  solarRadiation: 640,
  dewPoint: 11.1,
}

const sparse: Omit<WeatherStationCardModel, 'common'> = {
  since: null,
  temperature: 9.5,
  humidity: null,
  pressure: null,
  windSpeed: null,
  windGust: null,
  windBearing: null,
  rainRate: null,
  rainDaily: null,
  rainEvent: null,
  uv: null,
  solarRadiation: null,
  dewPoint: null,
}

export function weatherStationFixtures(): readonly WeatherStationFixture[] {
  return [
    {
      id: 'station-full',
      caption: 'Stazione completa',
      orientation: 'vertical',
      model: { ...full, common: home() },
    },
    {
      id: 'station-sparse',
      caption: 'Solo temperatura',
      orientation: 'vertical',
      model: { ...sparse, common: home() },
    },
  ]
}
