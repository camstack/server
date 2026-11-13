/** The lock page of the approved mockup. */
import type { LockCardModel } from '../scenes/lock/model'
import type { CardOrientation } from '../shell/model'
import { offline, readOnly } from './common'
import { deviceCommon } from './wave-d-common'

export interface LockFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: LockCardModel
}

const front = (battery: number) =>
  deviceCommon({ name: 'Porta ingresso', integration: 'Nuki', battery })
const DOOR_CLOSED = { name: 'Contatto porta', reading: 'closed' } as const
const DOOR_OPEN = { name: 'Contatto porta', reading: 'open' } as const

const base: Omit<LockCardModel, 'common' | 'activity' | 'door' | 'doorOpen'> = {
  since: '2 h',
  canLock: true,
  canUnlock: true,
  canOpen: true,
}

export function lockFixtures(): readonly LockFixture[] {
  return [
    {
      id: 'lock-locked',
      caption: 'Chiusa · porta chiusa',
      orientation: 'vertical',
      model: {
        ...base,
        common: front(76),
        activity: 'locked',
        door: DOOR_CLOSED,
        doorOpen: false,
      },
    },
    {
      id: 'lock-unlocked-open',
      caption: 'Sbloccata · porta aperta',
      orientation: 'vertical',
      model: {
        ...base,
        since: '3 min',
        common: front(76),
        activity: 'unlocked',
        door: DOOR_OPEN,
        doorOpen: true,
      },
    },
    {
      id: 'lock-jammed',
      caption: 'Bloccata (jammed) · batteria scarica',
      orientation: 'vertical',
      model: {
        ...base,
        since: null,
        common: front(12),
        activity: 'jammed',
        door: DOOR_CLOSED,
        doorOpen: false,
      },
    },
    {
      id: 'lock-moving',
      caption: 'In blocco · senza sensore porta',
      orientation: 'vertical',
      model: {
        ...base,
        canOpen: false,
        since: null,
        common: front(64),
        activity: 'locking',
        door: null,
        doorOpen: false,
      },
    },
    {
      id: 'lock-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: {
        ...base,
        common: offline(front(76)),
        activity: 'locked',
        door: DOOR_CLOSED,
        doorOpen: false,
      },
    },
    {
      id: 'lock-horizontal',
      caption: 'Orizzontale · sola lettura',
      orientation: 'horizontal',
      model: {
        ...base,
        common: readOnly(front(76)),
        activity: 'unlocked',
        door: DOOR_CLOSED,
        doorOpen: false,
      },
    },
  ]
}
