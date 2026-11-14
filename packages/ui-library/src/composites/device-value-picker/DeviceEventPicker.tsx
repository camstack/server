import { ChevronDown, ChevronLeft } from 'lucide-react'
import { type JSX, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { useDeviceStateGetCapSlice } from '../../generated/system-hooks'
import { Button } from '../../primitives/button'
import { Checkbox } from '../../primitives/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import { INPUT_SHELL, SelectedChip } from '../device-picker/SelectedChip'
import { useDeviceLabelById } from '../device-name/use-device-label'
import {
  DEVICE_EVENT_CAP,
  type DeviceFiredEntry,
  describeDeviceEvent,
  type DeviceEventVocabulary,
  deviceEventVocabularyOf,
  groupDeviceEvents,
  isDeviceEventGone,
  type PickedDeviceEvent,
  pickOfEntry,
  pickOfFiredEntry,
  sameDeviceEvent,
  toggleFiredEntry,
} from './device-event-model'
import { DeviceValuePanel } from './device-value-panel'
import { useRecentDevices } from './use-recent-devices'

const REQUIRES = { caps: [DEVICE_EVENT_CAP] } as const
const NO_PICKS = [] as const

export interface DeviceEventPickerProps {
  /** Whole `device-fired` leaves, as the automation stores them; ids are generated on add and kept. */
  readonly value: readonly DeviceFiredEntry[]
  readonly onChange: (next: readonly DeviceFiredEntry[]) => void
  readonly maxItems?: number
  readonly disabled?: boolean
  readonly placeholder?: string
  /** Remember what this field picked last (per browser). */
  readonly recentKey?: string
  readonly id?: string
  readonly testId?: string
  readonly className?: string
}

function useDeviceEventVocabulary(deviceId: number): DeviceEventVocabulary {
  const query = useDeviceStateGetCapSlice(
    { deviceId, capName: DEVICE_EVENT_CAP },
    { enabled: deviceId > 0 },
  )
  return deviceEventVocabularyOf({ status: query.status, data: query.data })
}

/** One picked event: "device · part · event", the device named by the shared resolver. */
function EventChip({
  entry,
  onRemove,
}: {
  readonly entry: DeviceFiredEntry
  readonly onRemove?: () => void
}): JSX.Element {
  const device = useDeviceLabelById(entry.deviceId, 'compact')
  const vocabulary = useDeviceEventVocabulary(entry.deviceId)
  const pick = pickOfFiredEntry(entry)
  return (
    <SelectedChip
      label={pick === undefined ? device : `${device} · ${describeDeviceEvent(pick, vocabulary)}`}
      warning={pick !== undefined && isDeviceEventGone(pick, vocabulary)}
      {...(onRemove === undefined ? {} : { onRemove })}
    />
  )
}

interface EventsPageProps {
  readonly deviceId: number
  readonly value: readonly DeviceFiredEntry[]
  readonly onToggle: (pick: PickedDeviceEvent) => void
  readonly onBack: () => void
}

/** The second step: what the chosen device fires, by part, each event a checkbox. */
function EventsPage({ deviceId, value, onToggle, onBack }: EventsPageProps): JSX.Element {
  const t = useUiText()
  const device = useDeviceLabelById(deviceId, 'compact')
  const vocabulary = useDeviceEventVocabulary(deviceId)
  return (
    <div className="flex max-h-[min(70vh,34rem)] min-h-0 flex-col" data-testid="dep-events">
      <Button
        variant="unstyled"
        type="button"
        className="flex w-full items-center gap-1 border-b border-border-subtle px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-surface-hover"
        onClick={onBack}
        aria-label={t('uiLibrary.deviceValuePicker.back', 'Back to devices')}
      >
        <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{device}</span>
      </Button>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {vocabulary.kind === 'pending' && (
          <p className="px-3 py-2 text-xs text-foreground-subtle">
            {t('uiLibrary.deviceEventPicker.loading', 'Reading what this device can fire…')}
          </p>
        )}
        {vocabulary.kind === 'unknown' && (
          <p className="px-3 py-2 text-xs text-warning">
            {t(
              'uiLibrary.deviceEventPicker.unknown',
              'What this device can fire could not be read.',
            )}
          </p>
        )}
        {vocabulary.kind === 'known' && vocabulary.entries.length === 0 && (
          <p className="px-3 py-2 text-xs text-foreground-subtle">
            {t('uiLibrary.deviceEventPicker.none', 'This device declares no event.')}
          </p>
        )}
        {vocabulary.kind === 'known' &&
          groupDeviceEvents(vocabulary.entries).map((group) => (
            <div key={group.label ?? ''} role="group" aria-label={group.label ?? device}>
              {group.label !== null && (
                <div className="px-3 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
                  {group.label}
                </div>
              )}
              {group.entries.map((entry) => {
                const pick = pickOfEntry(deviceId, entry)
                return (
                  <label
                    key={`${entry.source?.id ?? ''}|${entry.id}`}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-surface-hover"
                  >
                    <Checkbox
                      checked={value.some((v) => {
                        const own = pickOfFiredEntry(v)
                        return own !== undefined && sameDeviceEvent(own, pick)
                      })}
                      onChange={() => onToggle(pick)}
                    />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  </label>
                )
              })}
            </div>
          ))}
      </div>
    </div>
  )
}

/**
 * The device picker's event mode: one field picks WHICH events of WHICH
 * devices — the device from the shared panel, then its parts and events on a
 * second page with a way back. Several events, of several devices, are chips
 * in the closed field: "device · part · event".
 */
export function DeviceEventPicker(props: DeviceEventPickerProps): JSX.Element {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const recents = useRecentDevices(props.recentKey)
  const full = props.maxItems !== undefined && props.value.length >= props.maxItems
  const openChange = (next: boolean): void => {
    if (next) recents.refresh()
    else setDeviceId(null)
    setOpen(next)
  }
  return (
    <div
      id={props.id}
      data-testid={props.testId}
      className={cn('flex flex-col gap-1.5', props.className)}
    >
      {props.value.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {props.value.map((entry, index) => (
            <EventChip
              key={entry.id ?? `${String(entry.deviceId)}-${String(index)}`}
              entry={entry}
              {...(props.disabled === true
                ? {}
                : {
                    onRemove: () => props.onChange(props.value.filter((v) => v !== entry)),
                  })}
            />
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={openChange} className="block w-full">
        <PopoverTrigger
          disabled={props.disabled === true || full}
          className={cn(
            INPUT_SHELL,
            'h-7 w-full justify-between py-0 text-left text-xs text-foreground-subtle disabled:opacity-50',
          )}
        >
          <span className="truncate">
            {props.placeholder ?? t('uiLibrary.deviceEventPicker.add', 'Add event…')}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className="w-[min(44rem,calc(100vw-1rem))] overflow-hidden p-0">
          {deviceId === null ? (
            <DeviceValuePanel
              requires={REQUIRES}
              kind="device"
              multiple={false}
              picked={NO_PICKS}
              onSelect={(picked) => {
                recents.push(picked.deviceId)
                setDeviceId(picked.deviceId)
              }}
              railFirst
              recentIds={recents.ids}
            />
          ) : (
            <EventsPage
              deviceId={deviceId}
              value={props.value}
              onToggle={(pick) =>
                props.onChange(toggleFiredEntry(props.value, pick, props.maxItems))
              }
              onBack={() => setDeviceId(null)}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
