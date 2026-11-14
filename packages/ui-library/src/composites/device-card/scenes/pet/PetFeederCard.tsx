import { type ReactElement, useState } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { PetFeederIllustration } from '../../illustrations/PetFeederIllustration'
import { ButtonGroup } from '../../parts/ButtonGroup'
import { CardButton } from '../../parts/CardButton'
import { type ColumnItem, columnButton, columnPopover, columnStep } from '../../shell/column-items'
import { type RowLevel, rowButtons, rowLevels, rowSelector, rowText } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import type {
  PetFeederActivity,
  PetFeederCardActions,
  PetFeederCardModel,
  PetFeederHopper,
} from './model'

export interface PetFeederCardProps {
  readonly model: PetFeederCardModel
  readonly actions: PetFeederCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** One press of the portion moves it by this many grams. */
export const PORTION_STEP = 5

const TONE: Readonly<Record<PetFeederActivity, CardTone>> = {
  feeding: 'primary',
  eating: 'info',
  low: 'warning',
  ready: 'success',
  fault: 'danger',
}

export function petFeederStateLabel(activity: PetFeederActivity, t: UiTextFn): string {
  switch (activity) {
    case 'feeding':
      return t('uiLibrary.deviceCard.petFeeder.feeding', 'Feeding…')
    case 'eating':
      return t('uiLibrary.deviceCard.petFeeder.eating', 'Eating')
    case 'low':
      return t('uiLibrary.deviceCard.petFeeder.low', 'Low food')
    case 'ready':
      return t('uiLibrary.deviceCard.petFeeder.ready', 'Ready')
    case 'fault':
      return t('uiLibrary.deviceCard.petFeeder.fault', 'Blocked')
  }
}

function settingsPanel(
  model: PetFeederCardModel,
  actions: PetFeederCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  const s = model.settings
  const toggles: readonly {
    readonly id: string
    readonly on: boolean | null
    readonly label: string
    readonly set: (on: boolean) => void
  }[] = [
    {
      id: 'lock',
      on: s.childLock,
      label: t('uiLibrary.deviceCard.petFeeder.childLock', 'Child lock'),
      set: actions.onChildLock,
    },
    {
      id: 'light',
      on: s.light,
      label: t('uiLibrary.deviceCard.petFeeder.light', 'Light'),
      set: actions.onLight,
    },
    {
      id: 'sound',
      on: s.feedSound,
      label: t('uiLibrary.deviceCard.petFeeder.feedSound', 'Feed sound'),
      set: actions.onFeedSound,
    },
  ]
  const shown = toggles.filter((toggle) => toggle.on !== null)
  if (shown.length === 0 && s.volume === null) return []
  const volume = s.volume
  const panel = (
    <>
      <div className="grid gap-1.5">
        {shown.map((toggle) => (
          <CardButton
            key={toggle.id}
            tone={toggle.on === true ? 'on' : 'default'}
            aria-pressed={toggle.on === true}
            data-testid={`dc-feeder-${toggle.id}`}
            onClick={() => toggle.set(toggle.on !== true)}
          >
            {toggle.label}
          </CardButton>
        ))}
        {volume === null ? null : (
          <span className="inline-flex items-center justify-between gap-1.5 text-sm">
            <CardButton
              glyph="minus"
              aria-label={t('uiLibrary.deviceCard.volumeDown', 'Volume down')}
              disabled={volume <= 0}
              onClick={() => actions.onVolume(volume - 1)}
            />
            <b className="tabular-nums">{volume}</b>
            <CardButton
              glyph="plus"
              aria-label={t('uiLibrary.deviceCard.volumeUp', 'Volume up')}
              onClick={() => actions.onVolume(volume + 1)}
            />
          </span>
        )}
      </div>
    </>
  )
  return [
    columnPopover('settings', {
      glyph: 'menu',
      label: t('uiLibrary.deviceCard.petFeeder.settings', 'Options'),
      align: 'end',
      testId: 'dc-feeder-settings',
      panel,
    }),
  ]
}

function levels(model: PetFeederCardModel, t: UiTextFn): readonly RowLevel[] {
  const food = t('uiLibrary.deviceCard.petFeeder.food', 'Food')
  if (model.hoppers === null) {
    return [
      {
        id: 'food',
        testId: 'dc-feeder-level',
        label: food,
        percent: model.foodLevel,
        warn: model.lowFood,
      },
    ]
  }
  return [
    { id: 'hopper1', label: `${food} 1`, percent: model.hoppers[0], warn: model.lowFood },
    { id: 'hopper2', label: `${food} 2`, percent: model.hoppers[1], warn: model.lowFood },
  ]
}

/**
 * A pet feeder: the portion on the left, the hopper emptying over the bowl in
 * the middle, Feed (Cancel while it feeds) and Call pet on the right, the
 * food level under it. A fault turns the scene red and holds Feed.
 */
export function PetFeederCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: PetFeederCardProps): ReactElement {
  const t = useUiText()
  const [portion, setPortion] = useState(model.portion)
  const [hopper, setHopper] = useState<PetFeederHopper>(
    model.hoppers === null ? 'single' : 'hopper1',
  )
  const fault = model.activity === 'fault'
  const feeding = model.activity === 'feeding'
  const step = (delta: number) => (): void =>
    setPortion((current) => Math.max(model.portionMin, Math.min(model.portionMax, current + delta)))
  return (
    <DeviceCard
      kind="pet-feeder"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label:
          model.powerNote === null
            ? petFeederStateLabel(model.activity, t)
            : `${petFeederStateLabel(model.activity, t)} · ${model.powerNote}`,
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        alert: fault,
        columns: {
          left: model.canFeed
            ? columnStep('portion', {
                testId: 'dc-feeder-portion',
                value: `${portion} g`,
                caption: t('uiLibrary.deviceCard.petFeeder.portion', 'portion'),
                up: {
                  glyph: 'plus',
                  label: t('uiLibrary.deviceCard.petFeeder.more', 'Larger portion'),
                  disabled: fault || portion >= model.portionMax,
                  onPress: step(PORTION_STEP),
                },
                down: {
                  glyph: 'minus',
                  label: t('uiLibrary.deviceCard.petFeeder.less', 'Smaller portion'),
                  disabled: fault || portion <= model.portionMin,
                  onPress: step(-PORTION_STEP),
                },
              })
            : [],
          right: [
            ...(feeding && model.canCancel
              ? [
                  columnButton('cancel', {
                    glyph: 'cancel',
                    label: t('uiLibrary.deviceCard.cancel', 'Cancel'),
                    testId: 'dc-feeder-cancel',
                    onPress: actions.onCancelFeed,
                  }),
                ]
              : model.canFeed
                ? [
                    columnButton('feed', {
                      glyph: 'feed',
                      tone: 'primary',
                      disabled: fault || feeding,
                      label: t('uiLibrary.deviceCard.petFeeder.feed', 'Feed'),
                      testId: 'dc-feeder-feed',
                      onPress: () => actions.onFeed(portion, hopper),
                    }),
                  ]
                : []),
            ...(model.canCallPet
              ? [
                  columnButton('call', {
                    glyph: 'bell',
                    disabled: fault,
                    label: t('uiLibrary.deviceCard.petFeeder.callPet', 'Call pet'),
                    testId: 'dc-feeder-call',
                    onPress: actions.onCallPet,
                  }),
                ]
              : []),
            ...settingsPanel(model, actions, t),
          ],
        },
        image: (
          <div className="grid w-full min-w-26 max-w-52 justify-items-center gap-0.5">
            <PetFeederIllustration
              food={model.foodLevel === null ? null : model.foodLevel / 100}
              bowlFull={model.bowlFull}
              low={model.lowFood}
              feeding={feeding}
              className="h-auto w-full"
            />
            <small data-testid="dc-feeder-bowl" className="text-xs text-foreground-muted">
              {t('uiLibrary.deviceCard.petFeeder.inBowl', 'In bowl')} {model.bowl ?? '—'}
            </small>
          </div>
        ),
        bottom: [
          ...(model.hoppers !== null && model.canFeed
            ? [
                rowSelector('hopper', {
                  control: (
                    <ButtonGroup
                      testId="dc-feeder-hopper"
                      ariaLabel={t('uiLibrary.deviceCard.petFeeder.hopper', 'Hopper')}
                      options={[
                        {
                          id: 'hopper1',
                          label: t('uiLibrary.deviceCard.petFeeder.hopper1', 'Hopper 1'),
                        },
                        {
                          id: 'hopper2',
                          label: t('uiLibrary.deviceCard.petFeeder.hopper2', 'Hopper 2'),
                        },
                      ]}
                      value={hopper}
                      onChange={(id) => setHopper(id === 'hopper2' ? 'hopper2' : 'hopper1')}
                    />
                  ),
                }),
              ]
            : []),
          rowLevels('levels', { levels: levels(model, t) }),
          ...(model.fault === null
            ? []
            : [rowText('fault', { text: model.fault, tone: 'danger', testId: 'dc-feeder-fault' })]),
          ...(model.canMarkRefilled
            ? [
                rowButtons('refilled', {
                  buttons: [
                    <CardButton
                      key="refilled"
                      glyph="package"
                      data-testid="dc-feeder-refilled"
                      onClick={actions.onMarkRefilled}
                    >
                      {t('uiLibrary.deviceCard.petFeeder.markRefilled', 'Mark refilled')}
                    </CardButton>,
                  ],
                }),
              ]
            : []),
        ],
      }}
    />
  )
}
