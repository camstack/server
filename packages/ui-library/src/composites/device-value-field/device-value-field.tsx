import type { DeviceSearchRequires } from '@camstack/types'
import { type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useIsPhone } from '../../hooks/use-is-mobile'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Radio } from '../../primitives/radio'
import { DeviceValuePanel } from '../device-value-picker/device-value-panel'
import { useRecentDevices } from '../device-value-picker/use-recent-devices'

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
  /**
   * The capabilities a fitting value comes from: only devices providing one
   * are listed (`deviceManager.search`). Absent = every device.
   */
  readonly requires?: DeviceSearchRequires | undefined
  /** The device the field belongs to: never listed, and its room is suggested first. */
  readonly contextDeviceId?: number
  readonly excludeIds?: readonly number[]
  readonly excludeTypes?: readonly string[]
  readonly fixedTypes?: readonly string[]
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
  /** The suggestion line under the transform (a proposed threshold with its Apply). */
  readonly proposal?: ReactNode
  /** The pre-save "would read" line. */
  readonly preview?: ReactNode
  /** Show the transform/preview region before a value is chosen (a declared value is never chosen). */
  readonly alwaysShowPreview?: boolean
  readonly heading: string
  readonly noDeviceText: string
  readonly noValuesText: string
  readonly rowTestId?: (row: DeviceValueRow) => string
  readonly deviceListTestId?: string
  readonly testId?: string
  /** The host gives a definite height: the columns scroll on their own. */
  readonly fillHeight?: boolean
}

/**
 * A device → value SOURCE editor (a Customize source, a fill, a formula input). With a
 * source already chosen (a device AND a value) it is one compact card at every width: the
 * source row with a Change button, the transform slot, the proposal slot and the "would
 * read" line. Without one, or after Change, it is two columns from `sm`: the device list
 * (the `DeviceValuePicker` panel over `deviceManager.search`, narrowed to `requires`) and
 * the picked device's fitting values, each with its fit; on a phone the values follow the
 * list. A value that does not fit is never offered. Adapters decide what fits and what is
 * done with the pick.
 */
export function DeviceValueField(props: DeviceValueFieldProps): ReactNode {
  const t = useUiText()
  const phone = useIsPhone()
  const [changing, setChanging] = useState(false)
  const testId = props.testId ?? 'device-value-field'
  const chosenRow = props.groups
    .flatMap((group) => group.rows)
    .find((row) => row.cap === props.value?.cap && row.path === props.value.path)
  const cardMode =
    props.deviceId !== null && props.value !== null && props.valuesOverride === undefined
  const recents = useRecentDevices(props.deviceListTestId ?? testId)
  const pickDevice = (id: number): void => {
    recents.push(id)
    if (id !== props.deviceId) props.onDeviceChange(id)
  }
  const pickValue = (pick: DeviceValuePick): void => {
    props.onValueChange(pick)
    setChanging(false)
  }
  if (cardMode && !changing) {
    return (
      <div
        data-testid={testId}
        data-mode="card"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
      >
        <div className="flex items-center gap-2" data-testid={`${testId}-source`}>
          <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-xs text-foreground">
            <span className="font-medium">{props.deviceLabel}</span>
            <span className="text-foreground-subtle">·</span>
            <span>{chosenRow?.label ?? props.value?.path}</span>
            {chosenRow !== undefined && (
              <span className="text-foreground-muted">{chosenRow.valueText}</span>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid={`${testId}-change`}
            onClick={() => setChanging(true)}
          >
            {t('uiLibrary.deviceValueField.change', 'Change')}
          </Button>
        </div>
        {props.transform != null && (
          <div data-testid={`${testId}-transform`}>{props.transform}</div>
        )}
        {props.proposal}
        {props.preview != null && <div data-testid={`${testId}-preview`}>{props.preview}</div>}
      </div>
    )
  }
  const hasPreviewContent = props.transform != null || props.preview != null
  const showLegacyPreview =
    props.valuesOverride !== undefined && hasPreviewContent && props.alwaysShowPreview === true
  const values = (
    <>
      {props.valuesBefore}
      {props.deviceId !== null && !phone && (
        <div className="text-[11px] font-medium text-foreground">{props.deviceLabel}</div>
      )}
      <ValuesBody {...props} onPick={pickValue} noDeviceText={props.noDeviceText} />
    </>
  )
  return (
    <div
      data-testid={testId}
      data-mode="picker"
      className={
        props.fillHeight === true
          ? 'flex min-h-0 flex-1 flex-col gap-3 sm:grid sm:grid-cols-2 sm:grid-rows-[minmax(0,1fr)] sm:gap-4'
          : 'flex flex-col gap-3 sm:grid sm:grid-cols-2 sm:gap-4'
      }
    >
      <div data-testid={`${testId}-devices`} className="flex min-h-0 flex-col gap-2">
        <h3 className="text-[11px] font-medium text-foreground-muted">{props.heading}</h3>
        {props.suggestions}
        <div
          data-testid={props.deviceListTestId ?? `${testId}-device-picker`}
          className={cn(
            'overflow-hidden rounded-md border border-border',
            props.fillHeight === true && 'flex min-h-0 flex-1 flex-col',
          )}
        >
          <DeviceValuePanel
            requires={props.requires}
            contextDeviceId={props.contextDeviceId}
            fixedTypes={props.fixedTypes}
            excludeIds={[
              ...(props.excludeIds ?? []),
              ...(props.contextDeviceId === undefined ? [] : [props.contextDeviceId]),
            ]}
            excludeTypes={props.excludeTypes}
            kind="device"
            multiple={false}
            picked={props.deviceId === null ? [] : [{ deviceId: props.deviceId }]}
            onSelect={(picked) => pickDevice(picked.deviceId)}
            railFirst={false}
            recentIds={recents.ids}
            autoFocus={false}
          />
        </div>
        {phone && props.deviceId !== null && (
          <div data-testid={`${testId}-values`} className="flex flex-col gap-2">
            {values}
          </div>
        )}
        {cardMode && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            data-testid={`${testId}-cancel`}
            onClick={() => setChanging(false)}
          >
            {t('uiLibrary.deviceValueField.cancel', 'Cancel')}
          </Button>
        )}
      </div>
      {!phone && (
        <div data-testid={`${testId}-values`} className="flex min-h-0 flex-col gap-2">
          {values}
        </div>
      )}
      {showLegacyPreview && (
        <div data-testid={`${testId}-preview`} className="flex flex-col gap-2 sm:col-span-2">
          {props.transform}
          {props.preview}
        </div>
      )}
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
