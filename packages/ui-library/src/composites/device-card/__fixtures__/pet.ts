/** The pet page of the approved mockup: feeders and a fountain. */
import type { PetFeederCardModel, PetFountainCardModel } from '../scenes/pet/model'
import type { CardOrientation } from '../shell/model'
import { offline } from './common'
import { deviceCommon } from './wave-d-common'

export interface PetFixture<M> {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: M
}

const feeder = () => deviceCommon({ name: 'Pappa Micio', integration: 'PetKit', battery: 100 })
const fountain = () => deviceCommon({ name: 'Fontanella', integration: 'PetKit' })

const feederBase: Omit<PetFeederCardModel, 'common' | 'activity'> = {
  since: 'ultima 20 g',
  fault: null,
  foodLevel: 64,
  hoppers: null,
  bowl: '12 g',
  bowlFull: true,
  lowFood: false,
  portion: 20,
  portionMin: 4,
  portionMax: 200,
  canFeed: true,
  canCancel: true,
  canCallPet: true,
  canMarkRefilled: false,
  powerNote: null,
  settings: { childLock: false, light: true, feedSound: true, volume: 5 },
}

export function petFeederFixtures(): readonly PetFixture<PetFeederCardModel>[] {
  return [
    {
      id: 'feeder-ready',
      caption: 'Pronto',
      orientation: 'vertical',
      model: {
        ...feederBase,
        common: { ...feeder(), battery: { level: 40, label: 'Backup 40%' } },
        activity: 'ready',
        powerNote: 'Mains',
      },
    },
    {
      id: 'feeder-feeding',
      caption: 'Eroga',
      orientation: 'vertical',
      model: { ...feederBase, common: feeder(), activity: 'feeding' },
    },
    {
      id: 'feeder-low',
      caption: 'Cibo scarso · doppio serbatoio',
      orientation: 'vertical',
      model: {
        ...feederBase,
        common: feeder(),
        activity: 'low',
        lowFood: true,
        foodLevel: 8,
        hoppers: [8, 35],
        canMarkRefilled: true,
        bowl: '0 g',
        bowlFull: false,
      },
    },
    {
      id: 'feeder-fault',
      caption: 'Bloccato',
      orientation: 'vertical',
      model: {
        ...feederBase,
        common: feeder(),
        activity: 'fault',
        fault: 'Erogatore inceppato',
      },
    },
    {
      id: 'feeder-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: { ...feederBase, common: offline(feeder()), activity: 'ready' },
    },
  ]
}

const fountainBase: Omit<PetFountainCardModel, 'common' | 'activity'> = {
  since: '4 min',
  fault: null,
  waterLevel: 72,
  waterVolume: 1.3,
  pump: true,
  pumpSwitchable: true,
  cycle: { enabled: true, runMinutes: 10, restMinutes: 20 },
}

export function petFountainFixtures(): readonly PetFixture<PetFountainCardModel>[] {
  return [
    {
      id: 'fountain-running',
      caption: 'Pompa accesa',
      orientation: 'vertical',
      model: { ...fountainBase, common: fountain(), activity: 'running' },
    },
    {
      id: 'fountain-low',
      caption: 'Acqua quasi finita',
      orientation: 'vertical',
      model: {
        ...fountainBase,
        common: fountain(),
        activity: 'stopped',
        pump: false,
        waterLevel: 6,
      },
    },
    {
      id: 'fountain-horizontal',
      caption: 'Orizzontale',
      orientation: 'horizontal',
      model: { ...fountainBase, common: fountain(), activity: 'running' },
    },
  ]
}
