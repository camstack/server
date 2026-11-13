import {
  PET_FEEDER_MANUAL_FEED_MAX,
  PET_FEEDER_MANUAL_FEED_MIN,
  type PetFeederStatus,
} from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useUnitPreferences } from '../../../contexts/unit-preferences'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { resolveBowlReading } from '../../device-controls/pet-feeder-panel'
import { PetFeederCard } from '../scenes/pet/PetFeederCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { petFaultOf, petFeedInput, petFeederActivityOf } from './pet-model'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/** The portion the Feed button starts at when the feeder has not fed yet. */
const DEFAULT_PORTION = 20

/**
 * A pet feeder (`pet-feeder`): feed a portion (per hopper on a dual feeder),
 * cancel, call the pet, mark refilled and the four settings — each only when
 * the binding implements it. The desiccant is a consumable (D915), drawn by
 * the shell.
 */
export function ConnectedPetFeederCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const units = useUnitPreferences().system
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(dev?.petFeeder === undefined ? undefined : dev.state.petFeeder)
  const { display, applyOptimisticAction } = useOptimisticSlice<PetFeederStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.petFeeder
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const has = (method: string): boolean => card.implements('pet-feeder', method)
  const bowl = resolveBowlReading(display.bowlFood, units)
  return (
    <PetFeederCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity: petFeederActivityOf(display),
        since:
          display.lastFeedGrams === null
            ? null
            : t('uiLibrary.deviceCard.petFeeder.lastPortion', 'last {{grams}} g', {
                grams: display.lastFeedGrams,
              }),
        fault: petFaultOf(display.error),
        foodLevel: display.foodLevel,
        hoppers: display.isDualHopper ? [display.food1, display.food2] : null,
        bowl: bowl.grams === null ? null : bowl.label,
        bowlFull: bowl.grams !== null && bowl.grams > 0,
        lowFood: display.lowFood,
        portion: display.lastFeedGrams ?? DEFAULT_PORTION,
        portionMin: PET_FEEDER_MANUAL_FEED_MIN,
        portionMax: PET_FEEDER_MANUAL_FEED_MAX,
        canFeed: has('feed'),
        canCancel: has('cancelFeed'),
        canCallPet: has('callPet'),
        canMarkRefilled:
          display.lowFood && display.supportsMarkRefilled && has('markFoodReplenished'),
        settings: {
          childLock: has('setChildLock') ? display.childLock : null,
          light: has('setIndicatorLight') ? display.indicatorLight : null,
          feedSound: has('setFeedSound') ? display.feedSound : null,
          volume: has('setVolume') ? display.volume : null,
        },
      }}
      actions={{
        ...card.actions,
        onFeed: (grams, hopper) =>
          send({ feeding: true }, () => cap.feed(petFeedInput(grams, hopper))),
        onCancelFeed: () => send({ feeding: false }, () => cap.cancelFeed({})),
        onCallPet: () => send({}, () => cap.callPet({})),
        onMarkRefilled: () => send({ lowFood: false }, () => cap.markFoodReplenished({})),
        onChildLock: (on) => send({ childLock: on }, () => cap.setChildLock({ on })),
        onLight: (on) => send({ indicatorLight: on }, () => cap.setIndicatorLight({ on })),
        onFeedSound: (on) => send({ feedSound: on }, () => cap.setFeedSound({ on })),
        onVolume: (level) => send({ volume: level }, () => cap.setVolume({ level })),
      }}
    />
  )
}
