/**
 * The shell data the approved mockup draws on every card (its "common to every
 * type" options, all on): power, upstream supply, battery, consumables, remote.
 * Wording is the mockup's, in Italian, so the parity shots compare like with like.
 */
import type { CardCommon, CardConsumable, CardPower, CardRemoteKey } from '../shell/model'

export interface CommonFixtureInput {
  readonly name: string
  readonly integration: string
  readonly watts: number
  readonly supplyName: string
  readonly consumables: readonly CardConsumable[]
  readonly remote: readonly CardRemoteKey[]
  readonly battery?: number
}

export function mockupPower(watts: number): CardPower {
  return {
    watts,
    details: [
      { id: 'voltage', label: 'Tensione', value: '231 V' },
      { id: 'current', label: 'Corrente', value: '5.1 A' },
      { id: 'powerFactor', label: 'Fattore di potenza', value: '0.99' },
      {
        id: 'energyToday',
        label: 'Energia oggi',
        value: '0.9 kWh',
        group: true,
      },
      { id: 'energyTotal', label: 'Energia totale', value: '2.1 kWh' },
    ],
  }
}

export function mockupCommon(input: CommonFixtureInput): CardCommon {
  return {
    name: input.name,
    integration: input.integration,
    online: true,
    notice: null,
    offlineLabel: null,
    readOnly: false,
    power: mockupPower(input.watts),
    battery: { level: input.battery ?? 82 },
    supply: { name: input.supplyName, state: 'on' },
    consumables: input.consumables,
    remote: input.remote,
    history: {
      charts: null,
      events: [
        {
          id: 'e1',
          day: 'Oggi',
          actor: 'Gianni',
          text: 'Acceso',
          detail: 'dall’app',
          time: '08:12',
        },
        {
          id: 'e2',
          day: 'Oggi',
          actor: 'Automazione',
          text: 'Spento',
          detail: 'Buonanotte',
          time: '00:30',
        },
      ],
    },
  }
}

/** The mockup's "Offline" option. */
export function offline(common: CardCommon): CardCommon {
  return { ...common, online: false, offlineLabel: 'Offline da 2 h' }
}

/** The mockup's "Sola lettura (senza permesso)" option. */
export function readOnly(common: CardCommon): CardCommon {
  return { ...common, readOnly: true }
}
