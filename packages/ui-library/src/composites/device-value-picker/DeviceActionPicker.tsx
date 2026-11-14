import type { TemplateActionValue } from '@camstack/types'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { type JSX, type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import { INPUT_SHELL, SelectedChip } from '../device-picker/SelectedChip'
import { DeviceValuePanel } from './device-value-panel'
import { useRecentDevices } from './use-recent-devices'

const NO_FILTER = undefined

/** One picked action: the devices it goes to and the action they share. */
export interface PickedDeviceAction {
  readonly deviceIds: readonly number[]
  readonly action: TemplateActionValue
}

/** What the caller draws on the second page: the action of the chosen devices, and its args. */
export interface DeviceActionEditorProps {
  readonly deviceIds: readonly number[]
  readonly value: TemplateActionValue | undefined
  readonly onChange: (next: TemplateActionValue | undefined) => void
}

/** The text of one entry, "<action> · <devices>", and whether the hub no longer offers it. */
export interface DeviceActionEntryLabel {
  readonly label: string
  readonly warning?: boolean
}

export interface DeviceActionPickerProps {
  readonly value: readonly PickedDeviceAction[]
  readonly onChange: (next: readonly PickedDeviceAction[]) => void
  /** The action select and its args for the chosen devices (the library knows no action vocabulary). */
  readonly renderEditor: (props: DeviceActionEditorProps) => ReactNode
  /** A hook: names one entry through the shared resolvers. Called once per entry. */
  readonly useEntryLabel: (pick: PickedDeviceAction) => DeviceActionEntryLabel
  readonly maxItems?: number
  readonly disabled?: boolean
  readonly placeholder?: string
  readonly recentKey?: string
  readonly id?: string
  readonly testId?: string
  readonly className?: string
}

interface Draft {
  readonly deviceIds: readonly number[]
  readonly action: TemplateActionValue | undefined
  /** The entry being edited, or null for a new one. */
  readonly index: number | null
  readonly page: 'devices' | 'action'
}

function Entry({
  pick,
  useEntryLabel,
  onEdit,
  onRemove,
}: {
  readonly pick: PickedDeviceAction
  readonly useEntryLabel: DeviceActionPickerProps['useEntryLabel']
  readonly onEdit?: () => void
  readonly onRemove?: () => void
}): JSX.Element {
  const named = useEntryLabel(pick)
  return (
    <SelectedChip
      label={named.label}
      warning={named.warning === true}
      testId="dap-entry"
      {...(onEdit === undefined ? {} : { onSelect: onEdit })}
      {...(onRemove === undefined ? {} : { onRemove })}
    />
  )
}

/**
 * The device picker's action mode: one field picks WHICH action goes to WHICH
 * devices. The closed field lists the entries one per line ("action ·
 * devices", a × each); "Add action…" opens the shared device panel, then a
 * second page for the action the devices share and its args. A click on an
 * entry reopens the picker on it.
 */
export function DeviceActionPicker(props: DeviceActionPickerProps): JSX.Element {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const recents = useRecentDevices(props.recentKey)
  const full = props.maxItems !== undefined && props.value.length >= props.maxItems
  const close = (): void => {
    setOpen(false)
    setDraft(null)
  }
  const begin = (next: Draft): void => {
    recents.refresh()
    setDraft(next)
    setOpen(true)
  }
  const current: Draft = draft ?? { deviceIds: [], action: undefined, index: null, page: 'devices' }
  const confirm = (): void => {
    if (current.action === undefined || current.deviceIds.length === 0) return
    const entry: PickedDeviceAction = { deviceIds: current.deviceIds, action: current.action }
    props.onChange(
      current.index === null
        ? [...props.value, entry]
        : props.value.map((v, i) => (i === current.index ? entry : v)),
    )
    close()
  }
  const toggleDevice = (deviceId: number): void => {
    const has = current.deviceIds.includes(deviceId)
    // A different set of devices offers a different set of actions.
    setDraft({
      ...current,
      action: undefined,
      deviceIds: has
        ? current.deviceIds.filter((id) => id !== deviceId)
        : [...current.deviceIds, deviceId],
    })
  }
  return (
    <div
      id={props.id}
      data-testid={props.testId}
      className={cn('flex flex-col gap-1.5', props.className)}
    >
      {props.value.length > 0 && (
        <div className="flex flex-col items-start gap-1">
          {props.value.map((pick, index) => (
            <Entry
              // The index is the entry's address (`buttons.0.commands.1`); entries have no other identity.
              key={index}
              pick={pick}
              useEntryLabel={props.useEntryLabel}
              {...(props.disabled === true
                ? {}
                : {
                    onEdit: () =>
                      begin({
                        deviceIds: pick.deviceIds,
                        action: pick.action,
                        index,
                        page: 'action',
                      }),
                    onRemove: () => props.onChange(props.value.filter((_, i) => i !== index)),
                  })}
            />
          ))}
        </div>
      )}
      <Popover
        open={open}
        onOpenChange={(next) => (next ? begin(current) : close())}
        className="block w-full"
      >
        <PopoverTrigger
          disabled={props.disabled === true || full}
          className={cn(
            INPUT_SHELL,
            'h-7 w-full justify-between py-0 text-left text-xs text-foreground-subtle disabled:opacity-50',
          )}
        >
          <span className="truncate">
            {props.placeholder ?? t('uiLibrary.deviceActionPicker.add', 'Add action…')}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className="w-[min(44rem,calc(100vw-1rem))] overflow-hidden p-0">
          {current.page === 'devices' ? (
            <div className="flex flex-col" data-testid="dap-devices">
              <DeviceValuePanel
                requires={NO_FILTER}
                kind="device"
                multiple
                picked={current.deviceIds.map((deviceId) => ({ deviceId }))}
                onSelect={(picked) => {
                  recents.push(picked.deviceId)
                  toggleDevice(picked.deviceId)
                }}
                railFirst
                recentIds={recents.ids}
              />
              <div className="flex justify-end border-t border-border-subtle px-3 py-2">
                <Button
                  size="sm"
                  type="button"
                  disabled={current.deviceIds.length === 0}
                  onClick={() => setDraft({ ...current, page: 'action' })}
                >
                  {t('uiLibrary.deviceActionPicker.next', 'Next')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col" data-testid="dap-action">
              <Button
                variant="unstyled"
                type="button"
                className="flex w-full items-center gap-1 border-b border-border-subtle px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-surface-hover"
                onClick={() => setDraft({ ...current, page: 'devices' })}
                aria-label={t('uiLibrary.deviceValuePicker.back', 'Back to devices')}
              >
                <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {t('uiLibrary.deviceActionPicker.devices', '{{count}} device(s)', {
                    count: current.deviceIds.length,
                  })}
                </span>
              </Button>
              <div className="flex flex-col gap-2 p-3">
                {props.renderEditor({
                  deviceIds: current.deviceIds,
                  value: current.action,
                  onChange: (action) => setDraft({ ...current, action }),
                })}
              </div>
              <div className="flex justify-end border-t border-border-subtle px-3 py-2">
                <Button
                  size="sm"
                  type="button"
                  data-testid="dap-confirm"
                  disabled={current.action === undefined}
                  onClick={confirm}
                >
                  {current.index === null
                    ? t('uiLibrary.deviceActionPicker.confirmAdd', 'Add')
                    : t('uiLibrary.deviceActionPicker.confirmSave', 'Save')}
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
