import type { DishwasherStatus } from '@camstack/types'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { ApplianceCard } from '../scenes/appliance/ApplianceCard'
import {
  cycleEndsAt,
  type DishwasherProgramName,
  dishwasherPhase,
  dishwasherPrograms,
  dishwasherStartBlocked,
  programNamesFromOptions,
} from './appliance-model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

interface ProgramCatalogue {
  readonly getOptions?: (input?: unknown) => Promise<unknown>
}

function isOptionsLoader(value: unknown): value is (input?: unknown) => Promise<unknown> {
  return typeof value === 'function'
}

function catalogueLoader(cap: object | undefined): ProgramCatalogue['getOptions'] {
  if (cap === undefined || !('getOptions' in cap)) return undefined
  const load = cap.getOptions
  if (!isOptionsLoader(load)) return undefined
  return (input?: unknown) => Promise.resolve(load(input))
}

/**
 * The cap's program names, when `getOptions` answers. A missing method or a
 * failed read leaves the catalogue empty: the card then derives the label
 * from the program key.
 */
function useDishwasherProgramCatalog(
  deviceId: number,
  cap: object | undefined,
): readonly DishwasherProgramName[] {
  const [programs, setPrograms] = useState<readonly DishwasherProgramName[]>([])
  const capRef = useRef(cap)
  capRef.current = cap
  const canLoad = catalogueLoader(cap) !== undefined
  useEffect(() => {
    const load = catalogueLoader(capRef.current)
    if (load === undefined) return
    let live = true
    void load({ deviceId }).then(
      (value) => {
        if (live) setPrograms(programNamesFromOptions(value))
      },
      () => {
        if (live) setPrograms([])
      },
    )
    return () => {
      live = false
    }
  }, [deviceId, canLoad])
  return programs
}

/**
 * A dishwasher that speaks for itself (the `dishwasher` cap): its programs,
 * the time left, power, start / pause / resume / stop — each drawn only when
 * the binding implements it, the start refused, with the machine's reason,
 * while the door is open or remote start is off. Its options and reminders are
 * not on the card: the device page shows them (`DishwasherOptionsPanel`).
 */
export function ConnectedDishwasherCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.dishwasher === undefined ? undefined : dev.state.dishwasher,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<DishwasherStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.dishwasher
  const catalog = useDishwasherProgramCatalog(deviceId, cap)
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, { fail: card.fail, succeed: card.succeed })
  const phase = dishwasherPhase(display)
  const remaining = display.remaining
  const cycle = phase === 'run' || phase === 'pause'
  const has = (method: string): boolean => card.implements('dishwasher', method)
  return (
    <ApplianceCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        kind: 'dish',
        phase,
        phaseLabel: null,
        since: null,
        power: display.powerOn === null || !has('setPower') ? null : { on: display.powerOn },
        program: dishwasherPrograms(display, true, catalog),
        controls: {
          start: has('start'),
          pause: has('pause'),
          resume: has('resume'),
          stop: has('stop'),
        },
        remainingMinutes: cycle && remaining !== null ? remaining / 60 : null,
        endsAt: phase === 'run' && remaining !== null ? cycleEndsAt(remaining) : null,
        progress: display.progress,
        startBlocked: dishwasherStartBlocked(display, t),
        errorLabel: display.errorLabel,
      }}
      actions={{
        ...card.actions,
        onPower: (on) => send({ powerOn: on }, () => cap.setPower({ on })),
        onProgram: (program) =>
          send({ selectedProgram: program }, () => cap.setProgram({ program })),
        onStart: () => send({ state: 'running' }, () => cap.start({})),
        onPause: () => send({ state: 'paused' }, () => cap.pause({})),
        onResume: () => send({ state: 'running' }, () => cap.resume({})),
        onStop: () => send({ state: 'idle' }, () => cap.stop({})),
      }}
    />
  )
}
