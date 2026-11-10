import type { DeviceSearchItem, DeviceValueOption } from '@camstack/types'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { humanizeIdentifier } from '../../lib/capability-label'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Badge } from '../../primitives/badge'
import { Checkbox } from '../../primitives/checkbox'
import { Radio } from '../../primitives/radio'
import { Skeleton } from '../../primitives/skeleton'
import { ErrorBox } from '../error-box'
import {
  isPicked,
  type ListSection,
  type PickedValue,
  type PickerState,
  pickedCountOfDevice,
  pickFromOption,
  pickFromRow,
  type PickKind,
  rowMode,
} from './device-value-picker-model'

const ROW =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none'
const SUB = 'truncate text-[11px] text-foreground-subtle'
const READING = 'shrink-0 text-xs tabular-nums text-foreground-muted'
const ROW_ATTR = { 'data-dvp-row': '' } as const

/** The reading on the right of a row; blank when unknown, never "0". */
function Reading({ value }: { readonly value: string | null | undefined }): JSX.Element | null {
  return value === null || value === undefined ? null : <span className={READING}>{value}</span>
}

function OfflineBadge(): JSX.Element {
  const t = useUiText()
  return (
    <Badge variant="warning" size="sm">
      {t('uiLibrary.deviceValuePicker.offline', 'offline')}
    </Badge>
  )
}

export interface DeviceRowsProps {
  readonly sections: readonly ListSection[]
  readonly kind: PickKind
  readonly multiple: boolean
  readonly picked: readonly PickedValue[]
  readonly onSelect: (value: PickedValue) => void
  /** Popover: values expand under the row. Inline: the row opens a second page. */
  readonly inPlace: boolean
  readonly expandedId: number | null
  readonly onDrill: (deviceId: number | null) => void
  readonly capLabel: string
}

function SectionHeading({ section }: { readonly section: ListSection }): JSX.Element {
  const t = useUiText()
  const text =
    section.kind === 'suggested'
      ? t('uiLibrary.deviceValuePicker.suggested', 'Suggested')
      : section.kind === 'recent'
        ? t('uiLibrary.deviceValuePicker.recent', 'Recently used')
        : humanizeIdentifier(section.heading ?? '')
  return (
    <div className="sticky top-0 z-10 border-b border-border-subtle bg-background-elevated px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
      {text}
    </div>
  )
}

/** Up / Down move between the rows of a list without leaving it. */
function moveFocusWithArrows(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-dvp-row]'))
  const at = rows.findIndex((r) => r === document.activeElement)
  const next = e.key === 'ArrowDown' ? at + 1 : at - 1
  const target = rows[Math.min(Math.max(next, 0), rows.length - 1)]
  if (target === undefined) return
  e.preventDefault()
  target.focus()
}

export function DeviceRows(props: DeviceRowsProps): JSX.Element {
  return (
    <div
      role="listbox"
      aria-multiselectable={props.multiple}
      aria-label={props.capLabel}
      onKeyDown={moveFocusWithArrows}
    >
      {props.sections.map((section) => (
        <div key={section.id}>
          <SectionHeading section={section} />
          {section.items.map((item) => (
            <DeviceRow key={item.id} item={item} {...props} />
          ))}
        </div>
      ))}
    </div>
  )
}

function DeviceRow({
  item,
  kind,
  multiple,
  picked,
  onSelect,
  inPlace,
  expandedId,
  onDrill,
}: DeviceRowsProps & { readonly item: DeviceSearchItem }): JSX.Element {
  const t = useUiText()
  const mode = rowMode(item, kind)
  const disabled = !item.compatible
  const own = pickFromRow(item, kind)
  const isOn = mode === 'pick' && isPicked(picked, own)
  const reading = item.values.length === 1 ? item.values[0]?.reading : null
  const body: ReactNode = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.name}</span>
        <span className={SUB}>{humanizeIdentifier(item.type)}</span>
      </span>
      {item.online === false && <OfflineBadge />}
      {disabled && (
        <span className={SUB}>
          {t('uiLibrary.deviceValuePicker.notCompatible', 'not compatible')}
        </span>
      )}
      {mode === 'pick' ? <Reading value={reading} /> : null}
    </>
  )

  if (mode === 'drill') {
    const open = inPlace && expandedId === item.id
    const count = pickedCountOfDevice(picked, item.id)
    return (
      <div role="presentation">
        <Button
          variant="unstyled"
          type="button"
          role="option"
          aria-selected={count > 0}
          aria-expanded={inPlace ? open : undefined}
          {...ROW_ATTR}
          className={cn(ROW, count > 0 && 'bg-primary/10')}
          onClick={() => onDrill(open ? null : item.id)}
        >
          {body}
          {count > 0 && (
            <Badge variant="info" size="sm">
              {count}
            </Badge>
          )}
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-foreground-muted">
            {item.values.length}
            <ChevronRight
              className={cn('h-3 w-3', open && 'rotate-90')}
              aria-label={t('uiLibrary.deviceValuePicker.chooseValue', 'Choose a value')}
            />
          </span>
        </Button>
        {open && (
          <ValueRows item={item} multiple={multiple} picked={picked} onSelect={onSelect} indented />
        )}
      </div>
    )
  }

  if (multiple) {
    return (
      <label
        role="option"
        aria-selected={isOn}
        aria-disabled={disabled}
        className={cn(ROW, 'cursor-pointer', disabled && 'cursor-not-allowed opacity-50')}
      >
        <Checkbox {...ROW_ATTR} checked={isOn} disabled={disabled} onChange={() => onSelect(own)} />
        {body}
      </label>
    )
  }

  return (
    <Button
      variant="unstyled"
      type="button"
      role="option"
      aria-selected={isOn}
      aria-disabled={disabled}
      disabled={disabled}
      {...ROW_ATTR}
      className={cn(ROW, isOn && 'bg-primary/10', disabled && 'cursor-not-allowed opacity-50')}
      onClick={() => onSelect(own)}
    >
      {body}
    </Button>
  )
}

/** The values of ONE device — only the required capabilities' fields, each with its reading. */
export function ValueRows({
  item,
  multiple,
  picked,
  onSelect,
  indented = false,
}: {
  readonly item: DeviceSearchItem
  readonly multiple: boolean
  readonly picked: readonly PickedValue[]
  readonly onSelect: (value: PickedValue) => void
  readonly indented?: boolean
}): JSX.Element {
  return (
    <div role="group" aria-label={item.name} className={cn(indented && 'bg-background')}>
      {item.values.map((option: DeviceValueOption) => {
        const value = pickFromOption(item, option)
        const on = isPicked(picked, value)
        return (
          <label
            key={`${option.cap}|${option.path}`}
            role="option"
            aria-selected={on}
            className={cn(ROW, 'cursor-pointer', indented && 'pl-9', on && 'bg-primary/10')}
          >
            {multiple ? (
              <Checkbox {...ROW_ATTR} checked={on} onChange={() => onSelect(value)} />
            ) : (
              <Radio {...ROW_ATTR} checked={on} onChange={() => onSelect(value)} />
            )}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <Reading value={option.reading} />
          </label>
        )
      })}
    </div>
  )
}

/** Inline variant's second page: the device's values under a way back. */
export function ValuesPage({
  item,
  multiple,
  picked,
  onSelect,
  onBack,
}: {
  readonly item: DeviceSearchItem
  readonly multiple: boolean
  readonly picked: readonly PickedValue[]
  readonly onSelect: (value: PickedValue) => void
  readonly onBack: () => void
}): JSX.Element {
  const t = useUiText()
  return (
    <div onKeyDown={moveFocusWithArrows}>
      <Button
        variant="unstyled"
        type="button"
        className="flex w-full items-center gap-1 border-b border-border-subtle px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-surface-hover"
        onClick={onBack}
        aria-label={t('uiLibrary.deviceValuePicker.back', 'Back to devices')}
      >
        <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{item.name}</span>
        {item.online === false && <OfflineBadge />}
      </Button>
      <ValueRows item={item} multiple={multiple} picked={picked} onSelect={onSelect} />
    </div>
  )
}

/** The states of a list that is not showing rows (D315: failed is not empty). */
export function ListState({
  state,
  capLabel,
  hasCap,
  query,
  onRetry,
}: {
  readonly state: Exclude<PickerState, { readonly kind: 'ready' }>
  readonly capLabel: string
  readonly hasCap: boolean
  readonly query: string
  readonly onRetry: () => void
}): JSX.Element {
  const t = useUiText()
  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col gap-2 p-3" aria-busy="true" data-testid="dvp-loading">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className="p-3">
        <ErrorBox
          message={t('uiLibrary.deviceValuePicker.failed', 'Could not load the devices.')}
          onRetry={onRetry}
        />
      </div>
    )
  }
  const text =
    state.kind === 'empty'
      ? hasCap
        ? t('uiLibrary.deviceValuePicker.empty', 'No device provides {{cap}}', { cap: capLabel })
        : t('uiLibrary.deviceValuePicker.emptyAny', 'No devices')
      : hasCap
        ? t(
            'uiLibrary.deviceValuePicker.searchMiss',
            'No device with {{cap}} matches “{{query}}”',
            {
              cap: capLabel,
              query,
            },
          )
        : t('uiLibrary.deviceValuePicker.searchMissAny', 'No device matches “{{query}}”', { query })
  return (
    <p className="px-3 py-8 text-center text-xs text-foreground-muted" role="status">
      {text}
    </p>
  )
}
