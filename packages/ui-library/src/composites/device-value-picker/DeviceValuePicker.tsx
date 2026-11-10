import type { DeviceSearchRequires } from '@camstack/types'
import { ChevronDown, X } from 'lucide-react'
import { type JSX, useCallback, useMemo, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { IconButton } from '../../primitives/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import { INPUT_SHELL, SelectedChip } from '../device-picker/SelectedChip'
import { DeviceValuePanel } from './device-value-panel'
import {
  CHIP_LIMIT,
  describePicked,
  indexResolved,
  type PickedDescription,
  type PickedValue,
  type PickKind,
  removeValue,
  splitChips,
  toggleValue,
} from './device-value-picker-model'
import { useRecentDevices } from './use-recent-devices'
import { useResolvedDevices } from './use-device-value-search'

interface DeviceValuePickerCommon {
  /** The capability(ies) the field wants a value of; absent = just a device. */
  readonly requires?: DeviceSearchRequires
  /**
   * `value` (default with `requires`): a device with several values opens a
   * second level. `device`: a row picks the whole device — for a form that
   * stores only a device id.
   */
  readonly pick?: PickKind
  /** The device the field belongs to; its room is suggested first. */
  readonly contextDeviceId?: number
  /** `inline`: dropdown under the field, "Browse all…" adds the filter rail. `popover`: rail from the start. */
  readonly variant?: 'inline' | 'popover'
  /** Device types the field is fixed to, narrowed by the Type facet. */
  readonly fixedTypes?: readonly string[]
  readonly excludeIds?: readonly number[]
  readonly excludeTypes?: readonly string[]
  /** Remembers what this field offered last time (per field). */
  readonly recentKey?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly className?: string
  readonly id?: string
}

export interface DeviceValuePickerSingleProps extends DeviceValuePickerCommon {
  readonly multiple?: false
  readonly value: PickedValue | null
  readonly onChange: (value: PickedValue | null) => void
  /** Show a clear button (default true). */
  readonly clearable?: boolean
}

export interface DeviceValuePickerMultiProps extends DeviceValuePickerCommon {
  readonly multiple: true
  readonly value: readonly PickedValue[]
  readonly onChange: (value: readonly PickedValue[]) => void
  readonly maxItems?: number
}

export type DeviceValuePickerProps = DeviceValuePickerSingleProps | DeviceValuePickerMultiProps

function describeLine(d: PickedDescription, t: ReturnType<typeof useUiText>): string {
  if (d.status === 'gone') {
    return t('uiLibrary.deviceValuePicker.gone', 'Device #{{id}} not found', { id: d.deviceId })
  }
  const name = d.deviceName ?? `#${d.deviceId}`
  const base = d.valueName === null ? name : `${name} › ${d.valueName}`
  const withReading = d.reading === null ? base : `${base} · ${d.reading}`
  return d.status === 'offline'
    ? `${withReading} (${t('uiLibrary.deviceValuePicker.offline', 'offline')})`
    : withReading
}

/**
 * The one device → value picker: a field asks for a VALUE of a capability
 * (or just a device), and only devices that can supply it are offered, from
 * `deviceManager.search`. One matching value is picked with its row; several
 * open a second level. A picked value reads `device › value · reading` — no
 * location, never the node; a device the hub no longer has stays in the value
 * with Pick another / Remove (D49), and an unanswered resolve never looks like
 * a deleted device (D315).
 */
export function DeviceValuePicker(props: DeviceValuePickerProps): JSX.Element {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const [chipsExpanded, setChipsExpanded] = useState(false)
  const recents = useRecentDevices(props.recentKey)
  const kind: PickKind = props.pick ?? (props.requires === undefined ? 'device' : 'value')

  const pickedList: readonly PickedValue[] = props.multiple
    ? props.value
    : props.value === null
      ? []
      : [props.value]
  const ids = useMemo(() => [...new Set(pickedList.map((p) => p.deviceId))], [pickedList])
  const resolved = useResolvedDevices(ids, props.requires)
  const { byId, missing } = useMemo(() => indexResolved(resolved.result), [resolved.result])
  const describe = (p: PickedValue) => describePicked(p, byId.get(p.deviceId), missing)

  const onSelect = useCallback(
    (value: PickedValue) => {
      recents.push(value.deviceId)
      if (props.multiple) {
        props.onChange(toggleValue(props.value, value, props.maxItems))
      } else {
        props.onChange(value)
        setOpen(false)
      }
    },
    // The props object changes with every render; the handler reads its latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props, recents],
  )

  const panel = (
    <PopoverContent className="w-[min(44rem,calc(100vw-1rem))] overflow-hidden p-0">
      <DeviceValuePanel
        requires={props.requires}
        contextDeviceId={props.contextDeviceId}
        fixedTypes={props.fixedTypes}
        excludeIds={props.excludeIds}
        excludeTypes={props.excludeTypes}
        kind={kind}
        multiple={props.multiple === true}
        picked={pickedList}
        onSelect={onSelect}
        railFirst={props.variant === 'popover'}
        recentIds={recents.ids}
      />
    </PopoverContent>
  )

  if (props.multiple) {
    const { shown, hidden } = chipsExpanded
      ? { shown: props.value, hidden: 0 }
      : splitChips(props.value, CHIP_LIMIT)
    return (
      <div id={props.id} className={cn('flex flex-col gap-1.5', props.className)}>
        {props.value.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {shown.map((p) => {
              const d = describe(p)
              return (
                <SelectedChip
                  key={`${p.deviceId}|${p.cap ?? ''}|${p.path ?? ''}`}
                  label={describeLine(d, t)}
                  warning={d.status !== 'ok'}
                  onRemove={
                    props.disabled ? undefined : () => props.onChange(removeValue(props.value, p))
                  }
                />
              )
            })}
            {hidden > 0 && (
              <Button
                variant="unstyled"
                type="button"
                className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-foreground-muted hover:bg-surface-hover"
                onClick={() => setChipsExpanded(true)}
              >
                {t('uiLibrary.deviceValuePicker.moreChips', '+{{count}}', { count: hidden })}
              </Button>
            )}
          </div>
        )}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            disabled={props.disabled}
            className={cn(
              INPUT_SHELL,
              'justify-between text-left text-xs text-foreground-subtle disabled:opacity-50',
            )}
          >
            <span className="truncate">
              {props.placeholder ?? t('uiLibrary.deviceValuePicker.add', 'Add device…')}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </PopoverTrigger>
          {panel}
        </Popover>
      </div>
    )
  }

  const current = props.value === null ? null : describe(props.value)
  const clearable = props.clearable !== false
  return (
    <div id={props.id} className={cn('flex flex-col gap-1', props.className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <div className={cn(INPUT_SHELL, 'justify-between')}>
          <PopoverTrigger
            disabled={props.disabled}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-xs disabled:opacity-50"
          >
            <span
              className={cn(
                'truncate',
                current === null
                  ? 'text-foreground-subtle'
                  : current.status === 'ok'
                    ? 'text-foreground'
                    : 'text-warning',
              )}
            >
              {current === null
                ? (props.placeholder ??
                  t(
                    kind === 'value'
                      ? 'uiLibrary.deviceValuePicker.selectValue'
                      : 'uiLibrary.deviceValuePicker.selectDevice',
                    kind === 'value' ? 'Select value…' : 'Select device…',
                  ))
                : describeLine(current, t)}
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-foreground-subtle"
              aria-hidden="true"
            />
          </PopoverTrigger>
          {clearable && current !== null && !props.disabled && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={X}
              aria-label={t('uiLibrary.deviceValuePicker.clear', 'Clear')}
              onClick={() => props.onChange(null)}
            />
          )}
        </div>
        {panel}
      </Popover>
      {current?.status === 'gone' && !props.disabled && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t('uiLibrary.deviceValuePicker.pickAnother', 'Pick another')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => props.onChange(null)}>
            {t('uiLibrary.deviceValuePicker.remove', 'Remove')}
          </Button>
        </div>
      )}
    </div>
  )
}
