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
        powerCycle: false,
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
        powerCycle: false,
      },
    },
  ]
}

/**
 * Not in the mockup: a PoE port whose switch declares a native power cycle — the
 * two-step restart in the right column, vertical and horizontal.
 */
export function plugPowerCycleFixtures(): readonly PlugFixture[] {
  const port: PlugCardModel['common'] = {
    ...mockupCommon({
      name: 'Telecamera ingresso (porta 4)',
      integration: 'UniFi',
      watts: 6,
      supplyName: '',
      consumables: [],
      remote: [],
    }),
    battery: null,
    supply: null,
    consumables: null,
    remote: null,
  }
  return [
    {
      id: 'plug-power-cycle',
      caption: 'Verticale · porta PoE con riavvio',
      orientation: 'vertical',
      model: { common: port, on: true, since: '3 g', timer: null, powerCycle: true },
    },
    {
      id: 'plug-power-cycle-horizontal',
      caption: 'Orizzontale · porta PoE con riavvio',
      orientation: 'horizontal',
      model: { common: port, on: true, since: '3 g', timer: null, powerCycle: true },
    },
  ]
}

/** A PoE port as the Cantina switch reports it: PoE on or off, no watts. */
export function plugPoePortFixtures(): readonly PlugFixture[] {
  const common: PlugCardModel['common'] = {
    ...mockupCommon({
      name: 'Cantina (porta 3)',
      integration: 'UniFi',
      watts: 0,
      supplyName: '',
      consumables: [],
      remote: [],
    }),
    power: null,
    battery: null,
    supply: null,
    consumables: null,
    remote: null,
  }
  return [
    {
      id: 'poe-port-on',
      caption: 'Porta PoE accesa',
      orientation: 'vertical',
      model: { common, on: true, since: '3 g', timer: null, powerCycle: false, art: 'port' },
    },
    {
      id: 'poe-port-off',
      caption: 'Porta PoE spenta',
      orientation: 'vertical',
      model: { common, on: false, since: '3 g', timer: null, powerCycle: false, art: 'port' },
    },
  ]
}
