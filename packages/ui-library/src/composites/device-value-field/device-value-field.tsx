import { ChevronLeft } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import { Radio } from '../../primitives/radio'
import { DevicePicker } from '../device-picker/DevicePicker'
import type { PickerItem } from '../device-picker/device-picker-model'
import type { DeviceListState } from '../device-picker/device-selection'
import {
  type DeviceValueStep,
  initialStep,
  stepAfterDevice,
  stepAfterValue,
  stepBack,
} from './device-value-steps'

/** One value a device offers. Only values that FIT are ever passed in. */
export interface DeviceValueRow {
  readonly cap: string
  readonly path: string
  readonly label: string
  /** The live value as text. */
  readonly valueText: string
  /** "as is", "with threshold"…: how the value fits; absent when it needs nothing. */
  readonly fitText?: string
}

export interface DeviceValueGroup {
  readonly cap: string
  readonly title: string
  readonly rows: readonly DeviceValueRow[]
}

export interface DeviceValuePick {
  readonly cap: string
  readonly path: string
}

/** What the picked device's values are doing: never `ready` with nothing read (D315). */
export type DeviceValuesState = 'ready' | 'loading' | 'failed'

export interface DeviceValueFieldProps {
  /** Only the devices that offer a fitting value: an incompatible device is not listed. */
  readonly devices: readonly PickerItem<number>[]
  readonly listState: DeviceListState
  /** Above the device list: same-room suggestions. */
  readonly suggestions?: ReactNode
  readonly deviceId: number | null
  readonly onDeviceChange: (id: number | null) => void
  /** The picked device's name, for the values heading and the way back. */
  readonly deviceLabel: ReactNode
  readonly valuesState: DeviceValuesState
  /** Only fitting values; empty groups are not drawn. */
  readonly groups: readonly DeviceValueGroup[]
  readonly value: DeviceValuePick | null
  readonly onValueChange: (pick: DeviceValuePick) => void
  /** Replaces the value list (a declared, not chosen, value). */
  readonly valuesOverride?: ReactNode
  /** Above the value list (what is already picked). */
  readonly valuesBefore?: ReactNode
  /** Transform (as is / scale / threshold / map) and its parameters. */
  readonly transform?: ReactNode
  /** The pre-save "would read" line. */
  readonly preview?: ReactNode
  /** Show the transform/preview region before a value is chosen (a declared value is never chosen). */
  readonly alwaysShowPreview?: boolean
  readonly heading: string
  readonly backLabel: string
  readonly noDeviceText: string
  readonly noValuesText: string
  readonly rowTestId?: (row: DeviceValueRow) => string
  readonly deviceListTestId?: string
  readonly testId?: string
  /** The host gives a definite height: the columns scroll on their own. */
  readonly fillHeight?: boolean
}

const HIDDEN_ON_PHONE = 'hidden sm:block'

function stepClass(step: DeviceValueStep, own: DeviceValueStep): string | undefined {
  return step === own ? undefined : HIDDEN_ON_PHONE
}

/**
 * The ONE device → value picker: a device list, the values that fit, and what the
 * pick will read. Two columns from `sm`; on a phone three steps (devices, values,
 * preview). A value or device that does not fit is never offered. Adapters decide
 * what fits and what is done with the pick (a Customize source binding, a template
 * token chip).
 */
export function DeviceValueField(props: DeviceValueFieldProps): ReactNode {
  const t = useUiText()
  // null until the operator navigates: until then the step follows the props, so a device or
  // value that resolves after mount (a change dialog waiting on the fleet) is still reached.
  const [navigated, setStep] = useState<DeviceValueStep | null>(null)
  const testId = props.testId ?? 'device-value-field'
  const pickDevice = (ids: readonly number[]): void => {
    const id = ids[0] ?? null
    if (id !== props.deviceId) props.onDeviceChange(id)
    setStep(stepAfterDevice(id !== null))
  }
  const hasPreviewContent = props.transform != null || props.preview != null
  const pickValue = (pick: DeviceValuePick): void => {
    props.onValueChange(pick)
    setStep(stepAfterValue())
  }
  const showPreview =
    hasPreviewContent && (props.value !== null || props.alwaysShowPreview === true)
  // The preview step exists only once there is something to preview: the transform and the
  // "would read" line appear with the pick, so the step is judged at render, not at click.
  const requested: DeviceValueStep =
    navigated ??
    (showPreview && props.deviceId !== null ? 'preview' : initialStep(props.deviceId !== null))
  const step: DeviceValueStep = requested === 'preview' && !showPreview ? 'values' : requested
  return (
    <div
      data-testid={testId}
      data-step={step}
      className={
        props.fillHeight === true
          ? 'flex min-h-0 flex-1 flex-col gap-3 sm:grid sm:grid-cols-2 sm:grid-rows-[minmax(0,1fr)] sm:gap-4'
          : 'flex flex-col gap-3 sm:grid sm:grid-cols-2 sm:gap-4'
      }
    >
      <div
        data-testid={`${testId}-devices`}
        className={
          step === 'devices'
            ? 'flex min-h-0 flex-col gap-2'
            : 'hidden min-h-0 flex-col gap-2 sm:flex'
        }
      >
        <h3 className="text-[11px] font-medium text-foreground-muted">{props.heading}</h3>
        {props.suggestions}
        <DevicePicker
          devices={props.devices}
          listState={props.listState}
          value={props.deviceId === null ? [] : [props.deviceId]}
          selection="single"
          groupBy="location"
          onChange={pickDevice}
          noun="device"
          showAll
          fillHeight={props.fillHeight === true}
          testId={props.deviceListTestId ?? `${testId}-device-picker`}
        />
      </div>
      <div
        data-testid={`${testId}-values`}
        className={step === 'devices' ? HIDDEN_ON_PHONE : 'flex min-h-0 flex-col gap-2'}
      >
        {props.deviceId !== null && step !== 'devices' && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-1 self-start sm:hidden"
            data-testid={`${testId}-back`}
            aria-label={props.backLabel}
            onClick={() => setStep(stepBack(step))}
          >
            <ChevronLeft className="size-3" />
            {props.deviceLabel}
          </Button>
        )}
        <div className={stepClass(step, 'values')}>
          {props.valuesBefore}
          {props.deviceId !== null && (
            <div className="text-[11px] font-medium text-foreground">{props.deviceLabel}</div>
          )}
          <ValuesBody {...props} onPick={pickValue} noDeviceText={props.noDeviceText} />
        </div>
        {showPreview && (
          <div
            data-testid={`${testId}-preview`}
            className={props.alwaysShowPreview === true ? undefined : stepClass(step, 'preview')}
          >
            <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-foreground-muted sm:mt-2">
              {t('uiLibrary.deviceValueField.preview', 'Preview')}
            </h4>
            <div className="flex flex-col gap-2">
              {props.transform}
              {props.preview}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ValuesBody(
  props: DeviceValueFieldProps & {
    readonly onPick: (pick: DeviceValuePick) => void
  },
): ReactNode {
  const t = useUiText()
  if (props.valuesOverride !== undefined && props.deviceId !== null) return props.valuesOverride
  if (props.deviceId === null) {
    return <p className="text-[11px] text-foreground-subtle">{props.noDeviceText}</p>
  }
  if (props.valuesState === 'loading') {
    return (
      <p role="status" className="text-[11px] text-foreground-subtle">
        {t('uiLibrary.deviceValueField.loading', 'Reading the values…')}
      </p>
    )
  }
  if (props.valuesState === 'failed') {
    return (
      <p role="alert" className="text-[11px] text-danger">
        {t('uiLibrary.deviceValueField.failed', 'The values could not be read.')}
      </p>
    )
  }
  if (props.groups.every((g) => g.rows.length === 0)) {
    return <p className="text-[11px] text-foreground-subtle">{props.noValuesText}</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {props.groups
        .filter((g) => g.rows.length > 0)
        .map((group) => (
          <section key={group.cap} aria-label={group.title}>
            <h4 className="text-[10px] font-medium uppercase tracking-wide text-foreground-muted">
              {group.title}
            </h4>
            <ul className="mt-1 flex flex-col gap-1">
              {group.rows.map((row) => {
                const selected = props.value?.cap === row.cap && props.value.path === row.path
                return (
                  <li key={`${row.cap}.${row.path}`}>
                    <label className="flex flex-wrap items-center gap-2 text-[11px] text-foreground">
                      <Radio
                        name="device-value"
                        checked={selected}
                        data-testid={
                          props.rowTestId?.(row) ?? `device-value-${row.cap}.${row.path}`
                        }
                        onChange={() => props.onPick({ cap: row.cap, path: row.path })}
                      />
                      <span>{row.label}</span>
                      <span className="text-foreground-muted">{row.valueText}</span>
                      {row.fitText !== undefined && row.fitText !== '' && (
                        <span className="text-foreground-subtle">{row.fitText}</span>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
    </div>
  )
}
