/** The robot page of the approved mockup: four vacuums, three mowers, the first one horizontal. */
import type { RobotActivity } from '../illustrations/RobotIllustration'
import type { RobotCardModel } from '../scenes/robot/model'
import type { CardConsumable, CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface RobotFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: RobotCardModel
}

const SUCTION = ['Silenziosa', 'Standard', 'Turbo', 'Max']

const VACUUM_PARTS: readonly CardConsumable[] = [
  { key: 'main', label: 'Spazzola principale', percent: 45, resetLabel: 'Sostituita' },
  { key: 'side', label: 'Spazzola laterale', percent: 22, resetLabel: 'Sostituita' },
  { key: 'filter', label: 'Filtro', percent: 60, resetLabel: 'Sostituito' },
  { key: 'bag', label: 'Sacchetto base', percent: 80, resetLabel: 'Sostituito' },
]

interface RobotInput {
  readonly id: string
  readonly caption: string
  readonly name: string
  readonly integration: string
  readonly mower: boolean
  readonly activity: RobotActivity
  readonly battery: number
  readonly since: string | null
  readonly suction?: string | null
  readonly progress?: number | null
  readonly error?: string
  readonly orientation?: CardOrientation
}

function robot(input: RobotInput): RobotFixture {
  return {
    id: input.id,
    caption: input.caption,
    orientation: input.orientation ?? 'vertical',
    model: {
      common: {
        ...mockupCommon({
          name: input.name,
          integration: input.integration,
          watts: 0,
          supplyName: 'Presa base',
          consumables: input.mower ? [] : VACUUM_PARTS,
          remote: [],
          battery: input.battery,
        }),
        remote: null,
        supply: input.mower ? null : { name: 'Presa base', state: 'on' },
        consumables: input.mower ? null : VACUUM_PARTS,
      },
      mower: input.mower,
      activity: input.activity,
      errorLabel: input.error ?? null,
      since: input.since,
      suction:
        input.suction === undefined || input.suction === null
          ? null
          : { options: SUCTION, value: input.suction },
      progress: input.progress ?? null,
      controls: { start: true, pause: true, dock: true, stop: false, locate: !input.mower },
      mapUrl: null,
    },
  }
}

const cleaning = (orientation: CardOrientation): RobotFixture =>
  robot({
    id: orientation === 'horizontal' ? 'vacuum-clean-h' : 'vacuum-clean',
    caption: orientation === 'horizontal' ? 'Orizzontale' : 'Aspirapolvere · in pulizia',
    name: 'Robot',
    integration: 'Roborock',
    mower: false,
    activity: 'clean',
    battery: 64,
    since: 'Cucina · 12 m²',
    suction: 'Standard',
    orientation,
  })

export function robotFixtures(): readonly RobotFixture[] {
  return [
    cleaning('vertical'),
    robot({
      id: 'vacuum-charge',
      caption: 'Aspirapolvere · in carica',
      name: 'Robot piano terra',
      integration: 'Dreame',
      mower: false,
      activity: 'charge',
      battery: 82,
      since: 'da 1 h',
      suction: 'Turbo',
    }),
    robot({
      id: 'vacuum-error',
      caption: 'Aspirapolvere · errore',
      name: 'Robot camere',
      integration: 'Dreame',
      mower: false,
      activity: 'err',
      battery: 40,
      since: 'Camera · da 4 min',
      suction: 'Standard',
      error: 'Spazzola laterale bloccata',
    }),
    robot({
      id: 'vacuum-docked',
      caption: 'Aspirapolvere · in base, senza mappa',
      name: 'Robot taverna',
      integration: 'iRobot',
      mower: false,
      activity: 'sleep',
      battery: 100,
      since: 'da 1 h',
      suction: null,
    }),
    robot({
      id: 'mower-mowing',
      caption: 'Tagliaerba · al lavoro',
      name: 'Tagliaerba',
      integration: 'Segway',
      mower: true,
      activity: 'clean',
      battery: 70,
      since: 'Taglio in corso',
      progress: 45,
    }),
    robot({
      id: 'mower-docked',
      caption: 'Tagliaerba · in base',
      name: 'Tagliaerba retro',
      integration: 'Husqvarna',
      mower: true,
      activity: 'sleep',
      battery: 100,
      since: 'Parcheggiato fino alle 9:00',
      progress: null,
    }),
    robot({
      id: 'mower-error',
      caption: 'Tagliaerba · errore',
      name: 'Tagliaerba fronte',
      integration: 'Segway',
      mower: true,
      activity: 'err',
      battery: 38,
      since: 'da 4 min',
      progress: 62,
      error: 'Sollevato',
    }),
    cleaning('horizontal'),
  ]
}
