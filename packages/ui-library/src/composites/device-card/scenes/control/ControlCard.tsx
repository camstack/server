import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import type { CardGlyph } from '../../icons'
import { CardIcon } from '../../parts/CardIcon'
import { MenuButton } from '../../parts/MenuButton'
import { HorizontalSlider } from '../../parts/sliders'
import { ValueEntry } from '../../parts/ValueEntry'
import { type ColumnItem, columnButton, columnValue } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  type ControlCardActions,
  type ControlCardModel,
  type ControlCardValue,
  type NumericControlValue,
  numericText,
  steppedValue,
} from './model'

export interface ControlCardProps {
  readonly model: ControlCardModel
  readonly actions: ControlCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const GLYPH: Readonly<Record<ControlCardValue['kind'], CardGlyph>> = {
  numeric: 'number',
  select: 'select',
  text: 'text', // i18n-ignore: a glyph id, not text
  datetime: 'date',
}

function kindLabel(kind: ControlCardValue['kind'], t: UiTextFn): string {
  switch (kind) {
    case 'numeric':
      return t('uiLibrary.deviceCard.control.numeric', 'number')
    case 'select':
      return t('uiLibrary.deviceCard.control.select', 'choice')
    case 'text':
      return t('uiLibrary.deviceCard.control.text', 'text')
    case 'datetime':
      return t('uiLibrary.deviceCard.control.datetime', 'date and time')
  }
}

function shownValue(control: ControlCardValue): string {
  switch (control.kind) {
    case 'numeric':
      return `${numericText(control)}${control.unit === null ? '' : ` ${control.unit}`}`
    case 'datetime':
      return control.shown ?? '—'
    default:
      return control.value === '' ? '—' : control.value
  }
}

interface ControlZones {
  readonly right?: readonly ColumnItem[]
  readonly bottom?: ReactNode
}

function numericZones(
  control: NumericControlValue,
  settable: boolean,
  onSet: (value: number) => void,
  t: UiTextFn,
): ControlZones {
  if (!settable) return {}
  const ranged = control.min !== null && control.max !== null
  return {
    right: [
      columnButton('up', {
        glyph: 'plus',
        label: t('uiLibrary.deviceCard.control.increase', 'Increase'),
        testId: 'dc-control-up',
        disabled: control.max !== null && control.value >= control.max,
        onPress: () => onSet(steppedValue(control, 1)),
      }),
      columnButton('down', {
        glyph: 'minus',
        label: t('uiLibrary.deviceCard.control.decrease', 'Decrease'),
        testId: 'dc-control-down',
        disabled: control.min !== null && control.value <= control.min,
        onPress: () => onSet(steppedValue(control, -1)),
      }),
    ],
    bottom:
      ranged && control.min !== null && control.max !== null ? (
        <HorizontalSlider
          value={control.value}
          min={control.min}
          max={control.max}
          step={control.step ?? 1}
          ariaLabel={t('uiLibrary.deviceCard.control.value', 'Value')}
          onCommit={onSet}
          testId="dc-control-slider"
          trailing={
            <small className="text-xs text-foreground-subtle">
              {`${control.min} – ${control.max}${control.unit === null ? '' : ` ${control.unit}`}`}
            </small>
          }
        />
      ) : null,
  }
}

function editorZones(
  model: ControlCardModel,
  onSet: (value: string) => void,
  t: UiTextFn,
): ControlZones {
  const control = model.control
  if (!model.settable) return {}
  const save = t('uiLibrary.deviceCard.control.save', 'Save')
  const label = t('uiLibrary.deviceCard.control.value', 'Value')
  switch (control.kind) {
    case 'select':
      return control.options.length < 2
        ? {}
        : {
            bottom: (
              <MenuButton
                layout="stacked"
                options={control.options.map((option) => ({ id: option, label: option }))}
                value={control.value}
                onChange={onSet}
                ariaLabel={label}
                triggerLabel={t('uiLibrary.deviceCard.control.change', 'Change')}
                testId="dc-control-select"
              />
            ),
          }
    case 'text':
      return {
        bottom: (
          <ValueEntry
            type="text"
            value={control.value}
            ariaLabel={label}
            saveLabel={save}
            onSave={onSet}
            testId="dc-control-entry"
          />
        ),
      }
    case 'datetime':
      return {
        bottom: (
          <ValueEntry
            type={control.editor}
            value={control.value}
            ariaLabel={label}
            saveLabel={save}
            onSave={onSet}
            testId="dc-control-entry"
          />
        ),
      }
    default:
      return {}
  }
}

/**
 * A settable value (`control`): a number with steps and its range, a choice
 * from a list, a text or a date — each with the editor its kind needs.
 */
export function ControlCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ControlCardProps): ReactElement {
  const t = useUiText()
  const control = model.control
  const zones =
    control.kind === 'numeric'
      ? numericZones(control, model.settable, actions.onSet, t)
      : editorZones(model, actions.onSet, t)
  const left: readonly ColumnItem[] =
    control.kind === 'numeric'
      ? [columnValue('value', { value: shownValue(control), testId: 'dc-control-value' })]
      : []
  return (
    <DeviceCard
      kind="control"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={control.kind}
      state={{
        label: shownValue(control),
        since: model.since === null ? kindLabel(control.kind, t) : model.since,
        tone: 'primary',
      }}
      scene={{
        columns: { left, right: zones.right },
        image: (
          <CardIcon
            glyph={GLYPH[control.kind]}
            className={cn(SCENE_ICON_CLASS, 'text-foreground-muted')}
          />
        ),
        bottom: zones.bottom,
      }}
    />
  )
}
