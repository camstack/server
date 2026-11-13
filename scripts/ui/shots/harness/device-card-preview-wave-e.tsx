/**
 * Wave E of the device-card fixture page — the mockup's `misc` page: button,
 * update, script, automation, control, event, image, notifier, gateway.
 * Mounted by `device-card-preview.tsx` for `?type=<one of them>`, or
 * `?type=misc` for all of them.
 */
import {
  AutomationCard,
  ButtonCard,
  ControlCard,
  EventCard,
  GatewayCard,
  ImageCard,
  NotifierCard,
  ScriptCard,
  UpdateCard,
} from '@camstack/ui-library'
import type { ReactElement, ReactNode } from 'react'
import {
  automationFixtures,
  buttonFixtures,
  controlFixtures,
  eventFixtures,
  gatewayFixtures,
  imageFixtures,
  notifierFixtures,
  scriptFixtures,
  updateFixtures,
  type WaveEFixture,
} from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/wave-e'

const noop = (): void => undefined

const KINDS = [
  'button',
  'update',
  'script',
  'automation',
  'control',
  'event',
  'image',
  'notifier',
  'gateway',
] as const

export const WAVE_E_TYPES: ReadonlySet<string> = new Set<string>([...KINDS, 'misc'])

export interface WaveECellProps {
  readonly id: string
  readonly caption: string
  readonly wide: boolean
  readonly children: ReactNode
}

export interface WaveESceneProps {
  readonly type: string
  readonly Cell: (props: WaveECellProps) => ReactElement
}

function cells<M>(
  list: readonly WaveEFixture<M>[],
  Cell: WaveESceneProps['Cell'],
  draw: (f: WaveEFixture<M>) => ReactElement,
): ReactElement[] {
  return list.map((f) => (
    <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
      {draw(f)}
    </Cell>
  ))
}

function kindCells(kind: (typeof KINDS)[number], Cell: WaveESceneProps['Cell']): ReactElement[] {
  switch (kind) {
    case 'button':
      return cells(buttonFixtures(), Cell, (f) => (
        <ButtonCard model={f.model} actions={{ onPress: noop }} orientation={f.orientation} />
      ))
    case 'update':
      return cells(updateFixtures(), Cell, (f) => (
        <UpdateCard model={f.model} actions={{ onInstall: noop }} orientation={f.orientation} />
      ))
    case 'script':
      return cells(scriptFixtures(), Cell, (f) => (
        <ScriptCard
          model={f.model}
          actions={{ onRun: noop, onStop: noop }}
          orientation={f.orientation}
        />
      ))
    case 'automation':
      return cells(automationFixtures(), Cell, (f) => (
        <AutomationCard
          model={f.model}
          actions={{ onEnabled: noop, onTrigger: noop }}
          orientation={f.orientation}
        />
      ))
    case 'control':
      return cells(controlFixtures(), Cell, (f) => (
        <ControlCard model={f.model} actions={{ onSet: noop }} orientation={f.orientation} />
      ))
    case 'event':
      return cells(eventFixtures(), Cell, (f) => (
        <EventCard model={f.model} orientation={f.orientation} />
      ))
    case 'image':
      return cells(imageFixtures(), Cell, (f) => (
        <ImageCard model={f.model} orientation={f.orientation} />
      ))
    case 'notifier':
      return cells(notifierFixtures(), Cell, (f) => (
        <NotifierCard model={f.model} actions={{ onTest: noop }} orientation={f.orientation} />
      ))
    case 'gateway':
      return cells(gatewayFixtures(), Cell, (f) => (
        <GatewayCard model={f.model} actions={{ onReboot: noop }} orientation={f.orientation} />
      ))
  }
}

/** Wave E: one mockup page per `?type=`, or every kind for `misc`. */
export function WaveEScene({ type, Cell }: WaveESceneProps): ReactElement | null {
  const kinds = KINDS.filter((kind) => type === 'misc' || kind === type)
  if (kinds.length === 0) return null
  return <>{kinds.flatMap((kind) => kindCells(kind, Cell))}</>
}
