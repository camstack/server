/**
 * Wave D of the device-card fixture page: lock, alarm, humidifier, valve,
 * siren, pet (feeder + fountain), weather. Mounted by `device-card-preview.tsx`
 * for `?type=lock|alarm|humid|valve|siren|pet|weather`.
 */
import {
  AlarmCard,
  type AlarmCardActions,
  HumidifierCard,
  type HumidifierCardActions,
  LockCard,
  type LockCardActions,
  PetFeederCard,
  type PetFeederCardActions,
  PetFountainCard,
  type PetFountainCardActions,
  SirenCard,
  type SirenCardActions,
  ValveCard,
  type ValveCardActions,
  WeatherCard,
} from '@camstack/ui-library'
import type { ReactElement, ReactNode } from 'react'
import { alarmFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/alarm'
import { humidifierFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/humidifier'
import { lockFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/lock'
import {
  petFeederFixtures,
  petFountainFixtures,
} from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/pet'
import { sirenFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/siren'
import { valveFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/valve'
import { weatherFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/weather'

const noop = (): void => undefined

const LOCK_ACTIONS: LockCardActions = {
  onLock: noop,
  onUnlock: noop,
  onOpen: noop,
}
const ALARM_ACTIONS: AlarmCardActions = { onArm: noop, onDisarm: noop }
const HUMIDIFIER_ACTIONS: HumidifierCardActions = {
  onPower: noop,
  onTarget: noop,
  onMode: noop,
}
const VALVE_ACTIONS: ValveCardActions = {
  onOpen: noop,
  onClose: noop,
  onStop: noop,
  onPosition: noop,
}
const SIREN_ACTIONS: SirenCardActions = { onSound: noop }
const FEEDER_ACTIONS: PetFeederCardActions = {
  onFeed: noop,
  onCancelFeed: noop,
  onCallPet: noop,
  onMarkRefilled: noop,
  onChildLock: noop,
  onLight: noop,
  onFeedSound: noop,
  onVolume: noop,
}
const FOUNTAIN_ACTIONS: PetFountainCardActions = { onPump: noop }

export const WAVE_D_TYPES: ReadonlySet<string> = new Set([
  'lock',
  'alarm',
  'humid',
  'valve',
  'siren',
  'pet',
  'weather',
])

export interface WaveDCellProps {
  readonly id: string
  readonly caption: string
  readonly wide: boolean
  readonly children: ReactNode
}

export interface WaveDSceneProps {
  readonly type: string
  readonly Cell: (props: WaveDCellProps) => ReactElement
}

/** Wave D: one mockup page per `?type=`, each fixture in its cell. */
export function WaveDScene({ type, Cell }: WaveDSceneProps): ReactElement | null {
  const cell = (
    f: {
      readonly id: string
      readonly caption: string
      readonly orientation: string
    },
    card: ReactElement,
  ): ReactElement => (
    <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
      {card}
    </Cell>
  )
  switch (type) {
    case 'lock':
      return (
        <>
          {lockFixtures().map((f) =>
            cell(
              f,
              <LockCard model={f.model} actions={LOCK_ACTIONS} orientation={f.orientation} />,
            ),
          )}
        </>
      )
    case 'alarm':
      return (
        <>
          {alarmFixtures().map((f) =>
            cell(
              f,
              <AlarmCard model={f.model} actions={ALARM_ACTIONS} orientation={f.orientation} />,
            ),
          )}
        </>
      )
    case 'humid':
      return (
        <>
          {humidifierFixtures().map((f) =>
            cell(
              f,
              <HumidifierCard
                model={f.model}
                actions={HUMIDIFIER_ACTIONS}
                orientation={f.orientation}
              />,
            ),
          )}
        </>
      )
    case 'valve':
      return (
        <>
          {valveFixtures().map((f) =>
            cell(
              f,
              <ValveCard model={f.model} actions={VALVE_ACTIONS} orientation={f.orientation} />,
            ),
          )}
        </>
      )
    case 'siren':
      return (
        <>
          {sirenFixtures().map((f) =>
            cell(
              f,
              <SirenCard model={f.model} actions={SIREN_ACTIONS} orientation={f.orientation} />,
            ),
          )}
        </>
      )
    case 'pet':
      return (
        <>
          {petFeederFixtures().map((f) =>
            cell(
              f,
              <PetFeederCard
                model={f.model}
                actions={FEEDER_ACTIONS}
                orientation={f.orientation}
              />,
            ),
          )}
          {petFountainFixtures().map((f) =>
            cell(
              f,
              <PetFountainCard
                model={f.model}
                actions={FOUNTAIN_ACTIONS}
                orientation={f.orientation}
              />,
            ),
          )}
        </>
      )
    case 'weather':
      return (
        <>
          {weatherFixtures().map((f) =>
            cell(f, <WeatherCard model={f.model} orientation={f.orientation} />),
          )}
        </>
      )
    default:
      return null
  }
}
