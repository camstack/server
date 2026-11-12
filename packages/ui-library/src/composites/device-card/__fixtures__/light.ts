/** The light page of the approved mockup, for the variants a light cap can draw. */
import type { LightCardModel } from '../scenes/light/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface LightFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: LightCardModel
}

interface LightRow {
  readonly id: string
  readonly caption: string
  readonly name: string
  readonly integration: string
  readonly watts: number
  readonly on: boolean
  readonly brightness: number | null
  readonly color: LightCardModel['color']
  readonly palette: boolean
  readonly kelvin: number | null
}

const ROWS: readonly LightRow[] = [
  {
    id: 'light-colour',
    caption: 'Colore',
    name: 'Lampada divano',
    integration: 'Hue',
    watts: 9,
    on: true,
    brightness: 70,
    color: { r: 255, g: 179, b: 92 },
    palette: true,
    kelvin: 2700,
  },
  {
    id: 'light-white',
    caption: 'Bianco regolabile',
    name: 'Faretti cucina',
    integration: 'Hue',
    watts: 30,
    on: true,
    brightness: 40,
    color: { r: 255, g: 226, b: 176 },
    palette: false,
    kelvin: 3000,
  },
  {
    id: 'light-onoff',
    caption: 'Solo acceso / spento',
    name: 'Luce scale',
    integration: 'Shelly',
    watts: 12,
    on: true,
    brightness: null,
    color: { r: 255, g: 210, b: 122 },
    palette: false,
    kelvin: null,
  },
  {
    id: 'light-strip',
    caption: 'Striscia LED',
    name: 'Striscia TV',
    integration: 'WLED',
    watts: 24,
    on: true,
    brightness: 55,
    color: { r: 106, g: 168, b: 255 },
    palette: true,
    kelvin: null,
  },
  {
    id: 'light-off',
    caption: 'Spenta',
    name: 'Lampada lettura',
    integration: 'IKEA',
    watts: 8,
    on: false,
    brightness: 80,
    color: { r: 255, g: 210, b: 122 },
    palette: false,
    kelvin: 3000,
  },
]

export function lightFixtures(): readonly LightFixture[] {
  return ROWS.map((row) => ({
    id: row.id,
    caption: row.caption,
    orientation: 'vertical',
    model: {
      common: {
        ...mockupCommon({
          name: row.name,
          integration: row.integration,
          watts: row.on ? Math.round((row.watts * (row.brightness ?? 100)) / 100) : 0,
          supplyName: 'Relè luce',
          consumables: [],
          remote: [
            { id: 'power', label: 'Accendi / spegni', glyph: 'power' },
            { id: 'up', label: 'Più luce', glyph: 'plus' },
            { id: 'down', label: 'Meno luce', glyph: 'minus' },
            { id: 'colour', label: 'Colore', glyph: 'colour' },
          ],
        }),
        battery: null,
        consumables: null,
      },
      on: row.on,
      since: '2 h',
      brightness: row.brightness,
      color: row.color,
      palette: row.palette,
      white: row.kelvin === null ? null : { kelvin: row.kelvin },
    },
  }))
}
