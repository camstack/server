/** The fan page of the approved mockup: five fans, the mockup's data. */
import type { MenuOption } from '../parts/MenuButton'
import type { FanAxisModel, FanCardModel } from '../scenes/fan/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface FanFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: FanCardModel
}

const MINUTE_MS = 60_000
const presets = (names: readonly string[]): readonly MenuOption[] =>
  names.map((n) => ({ id: `device:${n}`, label: n, glyph: 'fanOnly' }))
const axis = (from: number, to: number, angle: number, min: number, max: number): FanAxisModel => ({
  oscillating: true,
  sweepFrom: from,
  sweepTo: to,
  angle,
  min,
  max,
  step: 5,
})

const common = (name: string, integration: string, watts: number): FanCardModel['common'] => ({
  ...mockupCommon({
    name,
    integration,
    watts,
    supplyName: 'Presa studio',
    consumables: [],
    remote: [
      { id: 'power', label: 'Accendi / spegni', glyph: 'power' },
      { id: 'up', label: 'Più veloce', glyph: 'plus' },
      { id: 'down', label: 'Più lento', glyph: 'minus' },
      { id: 'osc', label: 'Oscillazione', glyph: 'swingHorizontal' },
      { id: 'preset', label: 'Preset', glyph: 'fanOnly' },
    ],
  }),
  battery: null,
  consumables: null,
})

const BASE = {
  since: '1 h',
  presets: [],
  preset: null,
  direction: null,
  oscillating: null,
  axes: null,
  timer: { defaultMinutes: 60, maxMinutes: 720, endsAt: null },
} satisfies Partial<FanCardModel>

/** `now` anchors the running timer, so a shot always shows the same countdown. */
export function fanFixtures(now: number = Date.now()): readonly FanFixture[] {
  return [
    {
      id: 'fan-ceiling',
      caption: 'Velocità a scatti · direzione',
      orientation: 'vertical',
      model: {
        ...BASE,
        common: common('Ventilatore soffitto', 'Tuya', 23),
        on: true,
        speed: 50,
        speedStep: 25,
        direction: 'forward',
      },
    },
    {
      id: 'fan-tower',
      caption: 'Oscillazione · preset',
      orientation: 'vertical',
      model: {
        ...BASE,
        common: common('Ventilatore a colonna', 'Dreo', 21),
        on: true,
        speed: 70,
        speedStep: 10,
        oscillating: true,
        presets: presets(['Normale', 'Notte', 'Naturale']),
        preset: 'device:Normale',
        timer: { defaultMinutes: 60, maxMinutes: 720, endsAt: now + 42 * MINUTE_MS },
      },
    },
    {
      id: 'fan-axes',
      caption: 'Dreo · oscillazione 3D, angoli regolabili',
      orientation: 'vertical',
      model: {
        ...BASE,
        common: common('Ventilatore studio', 'Home Assistant · Dreo', 17),
        on: true,
        speed: 60,
        speedStep: 10,
        presets: presets(['Normale', 'Naturale', 'Notte', 'Turbo']),
        preset: 'device:Normale',
        axes: { horizontal: axis(-45, 45, 0, -60, 60), vertical: axis(0, 60, 15, -30, 90) },
      },
    },
    {
      id: 'fan-onoff',
      caption: 'Solo acceso / spento',
      orientation: 'vertical',
      model: {
        ...BASE,
        common: common('Aspiratore bagno', 'Shelly', 7),
        on: true,
        speed: null,
        speedStep: 1,
      },
    },
    {
      id: 'fan-off',
      caption: 'Spento',
      orientation: 'vertical',
      model: {
        ...BASE,
        common: common('Ventilatore camera', 'Xiaomi', 0),
        on: false,
        speed: 40,
        speedStep: 1,
        oscillating: false,
      },
    },
  ]
}
