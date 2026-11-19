import { type ReactElement, useState } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { SirenIllustration } from '../../illustrations/SirenIllustration'
import { ArmedButton } from '../../parts/ArmedButton'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { CountdownRing } from '../../parts/CountdownRing'
import { MenuButton } from '../../parts/MenuButton'
import { motionTriggerRow } from '../../parts/motion-trigger-row'
import { useCountdown } from '../../parts/use-countdown'
import { type BottomRow, rowButtons, rowText } from '../../shell/bottom-rows'
import { type ColumnItem, columnButton } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import {
  type SirenAmount,
  type SirenAmountChoices,
  type SirenAmountUnit,
  type SirenCardActions,
  type SirenCardModel,
  type SirenCountdown,
  sirenCountdownOf,
} from './model'

export interface SirenCardProps {
  readonly model: SirenCardModel
  readonly actions: SirenCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** The big round face at the centre of the ring. */
const FACE_CLASS = 'aspect-square w-2/5 flex-col gap-1 rounded-full text-base font-semibold'
const CANCEL_CLASS = 'min-h-8 px-2 py-1 text-xs'

function remainingText(countdown: SirenCountdown, t: UiTextFn): string | null {
  if (countdown.kind === 'open') return null
  const s = countdown.remainingSeconds
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return countdown.estimated
    ? t('uiLibrary.deviceCard.siren.remainingEstimated', '~{{clock}}', {
        clock,
      })
    : clock
}

function amountLabel(unit: SirenAmountUnit, value: number, t: UiTextFn): string {
  return unit === 'plays'
    ? t(
        'uiLibrary.deviceCard.siren.playCount',
        { one: '{{count}} play', other: '{{count}} plays' },
        { count: value },
      )
    : t('uiLibrary.deviceCard.siren.seconds', '{{seconds}} s', {
        seconds: value,
      })
}

interface AmountChipProps {
  readonly unit: SirenAmountUnit
  readonly choices: SirenAmountChoices
  readonly pick: SirenAmount | null
  readonly onPick: (amount: SirenAmount) => void
  readonly disabled: boolean
  readonly t: UiTextFn
}

/** One declared unit's chip: its picked value, its default while none is picked. */
function amountChip({ unit, choices, pick, onPick, disabled, t }: AmountChipProps): ReactElement {
  // Nothing picked: the trigger sends neither unit and the camera applies its
  // own default, so the chip says so rather than naming a value it will not send.
  const picked = pick !== null && pick.unit === unit ? pick.value : null
  const defaultLabel =
    unit === 'plays'
      ? t('uiLibrary.deviceCard.siren.defaultPlays', 'Default plays')
      : t('uiLibrary.deviceCard.siren.defaultDuration', 'Default duration')
  return (
    <MenuButton
      key={unit}
      testId={`dc-siren-${unit}`}
      ariaLabel={
        unit === 'plays'
          ? t('uiLibrary.deviceCard.siren.playsLabel', 'Plays')
          : t('uiLibrary.deviceCard.siren.durationLabel', 'Duration')
      }
      disabled={disabled}
      options={choices.values.map((value) => ({
        id: String(value),
        label: amountLabel(unit, value, t),
      }))}
      value={picked === null ? null : String(picked)}
      {...(pick === null ? { triggerLabel: defaultLabel } : {})}
      onChange={(id) => onPick({ unit, value: Number(id) })}
    />
  )
}

function bottomRows(
  model: SirenCardModel,
  actions: SirenCardActions,
  pick: SirenAmount | null,
  setPick: (amount: SirenAmount) => void,
  t: UiTextFn,
): readonly BottomRow[] {
  const rows: BottomRow[] = []
  const { durations, plays } = model.adjustable
  if (model.canTrigger && model.optionsUnavailable) {
    rows.push(
      rowText('options', {
        text: t('uiLibrary.deviceCard.siren.optionsUnavailable', 'Options unavailable'),
        tone: 'muted',
        testId: 'dc-siren-options-unavailable',
      }),
    )
  }
  if (model.canTrigger && (durations !== null || plays !== null)) {
    const disabled = model.activity === 'sounding' || model.commandPending
    rows.push(
      rowButtons('amount', {
        label: t('uiLibrary.deviceCard.siren.soundFor', 'Sound for'),
        testId: 'dc-siren-amount',
        buttons: [
          ...(durations === null
            ? []
            : [
                amountChip({
                  unit: 'seconds',
                  choices: durations,
                  pick,
                  onPick: setPick,
                  disabled,
                  t,
                }),
              ]),
          ...(plays === null
            ? []
            : [
                amountChip({
                  unit: 'plays',
                  choices: plays,
                  pick,
                  onPick: setPick,
                  disabled,
                  t,
                }),
              ]),
        ],
      }),
    )
  }
  const motion = motionTriggerRow({
    on: model.onMotion,
    pending: model.onMotionPending,
    label: t('uiLibrary.deviceCard.siren.onMotion', 'Sound on motion'),
    testId: 'dc-siren-motion',
    onToggle: actions.onMotion,
  })
  if (motion !== null) rows.push(motion)
  return rows
}

interface CentreProps {
  readonly model: SirenCardModel
  readonly actions: SirenCardActions
  readonly pick: SirenAmount | null
  readonly countdown: SirenCountdown | null
  readonly t: UiTextFn
}

/** The ring's centre: Stop while it sounds, the armed Sound otherwise. */
function centre({ model, actions, pick, countdown, t }: CentreProps): ReactElement {
  if (model.activity === 'sounding' && model.canStop) {
    const left = countdown === null ? null : remainingText(countdown, t)
    return (
      <CardButton
        tone="danger"
        className={FACE_CLASS}
        disabled={model.commandPending}
        aria-busy={model.commandPending}
        data-testid="dc-siren-stop"
        onClick={actions.onStop}
      >
        <CardIcon glyph="stop" />
        <span>{t('uiLibrary.deviceCard.siren.stop', 'Stop')}</span>
        {left === null ? null : (
          <span data-testid="dc-siren-remaining" className="text-xs font-normal tabular-nums">
            {left}
          </span>
        )}
      </CardButton>
    )
  }
  if (model.activity !== 'sounding' && model.canTrigger) {
    return (
      <ArmedButton
        stacked
        tone="primary"
        glyph="siren"
        label={t('uiLibrary.deviceCard.siren.sound', 'Sound')}
        disabled={model.commandPending}
        testId="dc-siren-sound"
        buttonClassName={FACE_CLASS}
        cancelClassName={CANCEL_CLASS}
        onConfirm={() => actions.onTrigger(pick)}
      >
        {t('uiLibrary.deviceCard.siren.sound', 'Sound')}
      </ArmedButton>
    )
  }
  return (
    <SirenIllustration
      sounding={model.activity === 'sounding'}
      className={`${SCENE_DRAWING_CLASS} w-3/5`}
    />
  )
}

/** While the state is unknown, Silence stays reachable beside the Sound in the centre. */
function sideCommands(
  model: SirenCardModel,
  actions: SirenCardActions,
  t: UiTextFn,
): readonly ColumnItem[] {
  if (model.activity !== 'unknown' || !model.canStop) return []
  return [
    columnButton('silence', {
      glyph: 'mute',
      label: t('uiLibrary.deviceCard.siren.silence', 'Silence'),
      testId: 'dc-siren-silence',
      disabled: model.commandPending,
      onPress: actions.onStop,
    }),
  ]
}

/**
 * A siren: one big Sound at the centre (armed — a second press confirms),
 * which becomes Stop while it sounds, inside a ring that counts the run down
 * from what the server reports and pulses when the end is unknown. The
 * duration and plays chips appear only when the siren declares more than one
 * value; "Sound on motion" only when the device offers it.
 */
export function SirenCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: SirenCardProps): ReactElement {
  const t = useUiText()
  const [pick, setPick] = useState<SirenAmount | null>(null)
  const remainingMs = useCountdown(model.run?.endsAt ?? null)
  const sounding = model.activity === 'sounding'
  const countdown = model.run === null ? null : sirenCountdownOf(model.run, remainingMs)
  return (
    <DeviceCard
      kind="siren"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: sounding
          ? t('uiLibrary.deviceCard.siren.sounding', 'Sounding')
          : model.activity === 'unknown'
            ? t('uiLibrary.deviceCard.siren.unknown', 'State unknown')
            : t('uiLibrary.deviceCard.siren.silent', 'Silent'),
        since: model.since,
        tone: sounding ? 'danger' : 'muted',
      }}
      scene={{
        alert: sounding,
        image: (
          <CountdownRing
            testId="dc-siren-ring"
            tone={sounding ? 'danger' : 'muted'}
            fraction={countdown?.kind === 'timed' ? countdown.fraction : null}
            busy={sounding || model.commandPending}
          >
            {centre({ model, actions, pick, countdown, t })}
          </CountdownRing>
        ),
        columns: { right: sideCommands(model, actions, t) },
        bottom: bottomRows(model, actions, pick, setPick, t),
      }}
    />
  )
}
