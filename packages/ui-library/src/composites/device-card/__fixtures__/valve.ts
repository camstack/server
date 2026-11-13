/** The valve page of the approved mockup. */
import type { ValveCardModel } from '../scenes/valve/model'
import type { CardOrientation } from '../shell/model'
import { offline } from './common'
import { deviceCommon } from './wave-d-common'

export interface ValveFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: ValveCardModel
}

const water = () => deviceCommon({ name: 'Valvola acqua', integration: 'Shelly', battery: 88 })
const garden = () => deviceCommon({ name: 'Irrigazione orto', integration: 'Zigbee' })

const base: Omit<ValveCardModel, 'common' | 'activity'> = {
  since: '5 h',
  position: null,
  positionable: false,
  canOpen: true,
  canClose: true,
  canStop: false,
}

export function valveFixtures(): readonly ValveFixture[] {
  return [
    {
      id: 'valve-open',
      caption: 'Aperta',
      orientation: 'vertical',
      model: { ...base, common: water(), activity: 'open' },
    },
    {
      id: 'valve-closed',
      caption: 'Chiusa',
      orientation: 'vertical',
      model: { ...base, common: water(), activity: 'closed' },
    },
    {
      id: 'valve-partial',
      caption: 'Posizione 40%',
      orientation: 'vertical',
      model: {
        ...base,
        common: garden(),
        activity: 'open',
        position: 40,
        positionable: true,
        canStop: true,
      },
    },
    {
      id: 'valve-moving',
      caption: 'In chiusura',
      orientation: 'vertical',
      model: {
        ...base,
        common: garden(),
        activity: 'closing',
        position: 70,
        positionable: true,
        canStop: true,
        since: null,
      },
    },
    {
      id: 'valve-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: { ...base, common: offline(water()), activity: 'open' },
    },
    {
      id: 'valve-horizontal',
      caption: 'Orizzontale',
      orientation: 'horizontal',
      model: {
        ...base,
        common: garden(),
        activity: 'stopped',
        position: 55,
        positionable: true,
        canStop: true,
      },
    },
  ]
}
