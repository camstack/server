/** The plug page of the approved mockup: the same two cards, the same data. */
import type { CardOrientation } from '../shell/model'
import type { PlugCardModel } from '../scenes/plug/model'
import { mockupCommon } from './common'

export interface PlugFixture {
  readonly id: string
  /** The mockup's caption over the card. */
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: PlugCardModel
}

const MINUTE_MS = 60_000

const common = (watts: number): PlugCardModel['common'] =>
  mockupCommon({
    name: 'Stufa veranda',
    integration: 'Shelly',
    watts,
    supplyName: 'Ciabatta veranda',
    consumables: [
      {
        key: 'battery',
        label: 'Pile pulsante',
        percent: 70,
        resetLabel: 'Sostituite',
      },
    ],
    remote: [
      { id: 'on', label: 'Accendi', glyph: 'power' },
      { id: 'off', label: 'Spegni', glyph: 'power' },
      { id: 'run30', label: '30 min', glyph: 'timer' },
    ],
  })

/** `now` anchors the running cycle, so a shot always shows the same countdown. */
export function plugFixtures(now: number = Date.now()): readonly PlugFixture[] {
  return [
    {
      id: 'plug-on-running',
      caption: 'Verticale · accesa, ciclo in corso',
      orientation: 'vertical',
      model: {
        common: common(1180),
        on: true,
        since: '2 h',
        timer: {
          defaultMinutes: 25,
          maxMinutes: 240,
          endsAt: now + 25 * MINUTE_MS,
        },
      },
    },
    {
      id: 'plug-off',
      caption: 'Orizzontale · spenta',
      orientation: 'horizontal',
      model: {
        common: common(0),
        on: false,
        since: '2 h',
        timer: { defaultMinutes: 25, maxMinutes: 240, endsAt: null },
      },
    },
  ]
}
