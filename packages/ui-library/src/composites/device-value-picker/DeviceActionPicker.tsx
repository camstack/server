import type { ActionTarget, AutomationCommandStep, DeviceType } from '@camstack/types'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { type JSX, type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import { Select } from '../../primitives/select'
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs'
import { INPUT_SHELL, SelectedChip } from '../device-picker/SelectedChip'
import { useDomainChoices } from './action-target-label'
import { DeviceValuePanel } from './device-value-panel'
import { useRecentDevices } from './use-recent-devices'

const NO_FILTER = undefined
const ANY = ''

/** What the caller draws on the second page: the action of the chosen target, and its args. */
export interface DeviceActionEditorProps {
  readonly target: ActionTarget
  readonly value: AutomationCommandStep | undefined
  readonly onChange: (next: AutomationCommandStep | undefined) => void
}

/** The text of one entry, "<action> · <target>", and whether the hub no longer offers it. */
export interface DeviceActionEntryLabel {
  readonly label: string
  readonly warning?: boolean
}

export interface DeviceActionPickerProps {
  /** Whole `command` steps, as the automation stores them. */
  readonly value: readonly AutomationCommandStep[]
  readonly onChange: (next: readonly AutomationCommandStep[]) => void
  /** The action select and its args for the chosen target (the library knows no action vocabulary). */
  readonly renderEditor: (props: DeviceActionEditorProps) => ReactNode
  /** A hook: names one entry through the shared resolvers. Called once per entry. */
  readonly useEntryLabel: (step: AutomationCommandStep) => DeviceActionEntryLabel
  readonly maxItems?: number
  readonly disabled?: boolean
  readonly placeholder?: string
  readonly recentKey?: string
  readonly id?: string
  readonly testId?: string
  readonly className?: string
}

type TargetMode = 'devices' | 'domain'

interface Draft {
  readonly mode: TargetMode
  readonly deviceIds: readonly number[]
  readonly deviceType: DeviceType | undefined
  readonly roomId: string | undefined
  readonly step: AutomationCommandStep | undefined
  /** The entry being edited, or null for a new one. */
  readonly index: number | null
  readonly page: 'target' | 'action'
}

function Entry({
  step,
  useEntryLabel,
  onEdit,
  onRemove,
}: {
  readonly step: AutomationCommandStep
  readonly useEntryLabel: DeviceActionPickerProps['useEntryLabel']
  readonly onEdit?: () => void
  readonly onRemove?: () => void
}): JSX.Element {
  const named = useEntryLabel(step)
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

const EMPTY_DRAFT: Draft = {
  mode: 'devices',
  deviceIds: [],
  deviceType: undefined,
  roomId: undefined,
  step: undefined,
  index: null,
  page: 'target',
}

/** The target a draft names; undefined while nothing is chosen yet. */
function draftTarget(draft: Pick<Draft, 'mode' | 'deviceIds' | 'deviceType' | 'roomId'>): ActionTarget | undefined {
  if (draft.mode === 'devices') {
    return draft.deviceIds.length === 0 ? undefined : { kind: 'devices', ids: [...draft.deviceIds] }
  }
  return {
    kind: 'domain',
    ...(draft.deviceType === undefined ? {} : { deviceType: draft.deviceType }),
    ...(draft.roomId === undefined ? {} : { roomId: draft.roomId }),
  }
}

function draftOfStep(step: AutomationCommandStep, index: number): Draft {
  const target = step.target
  if (target.kind === 'domain') {
    return { ...EMPTY_DRAFT, mode: 'domain', deviceType: target.deviceType, roomId: target.roomId, step, index, page: 'action' }
  }
  return {
    ...EMPTY_DRAFT,
    deviceIds: target.kind === 'devices' ? target.ids : [],
    step,
    index,
    page: 'action',
  }
}

/** The "By room/type" form: a type and a room, each optional. */
function DomainForm({
  draft,
  onChange,
}: {
  readonly draft: Draft
  readonly onChange: (next: Draft) => void
}): JSX.Element {
  const t = useUiText()
  const choices = useDomainChoices()
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="dap-domain">
      <Select
        aria-label={t('uiLibrary.deviceActionPicker.type', 'Device type')}
        value={draft.deviceType ?? ANY}
        onChange={(e) =>
          onChange({
            ...draft,
            step: undefined,
            deviceType: choices.types.find((c) => c.value === e.target.value)?.value,
          })
        }
        options={[
          { value: ANY, label: t('uiLibrary.deviceActionPicker.anyType', 'Any type') },
          ...choices.types.map((c) => ({ value: c.value, label: c.label })),
        ]}
      />
      <Select
        aria-label={t('uiLibrary.deviceActionPicker.room', 'Room')}
        value={draft.roomId ?? ANY}
        onChange={(e) =>
          onChange({
            ...draft,
            step: undefined,
            roomId: e.target.value === ANY ? undefined : e.target.value,
          })
        }
        options={[
          { value: ANY, label: t('uiLibrary.deviceActionPicker.anyRoom', 'Any room') },
          ...choices.rooms.map((room) => ({ value: room, label: room })),
        ]}
      />
    </div>
  )
}

/**
 * The device picker's action mode: one field picks WHICH action goes to WHICH
 * target. The closed field lists the entries one per line ("action · target",
 * a × each); "Add action…" opens the shared device panel (or, beside it, the
 * By room/type form), then a second page for the action the target offers and
 * its args. A click on an entry reopens the picker on it.
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
  const current: Draft = draft ?? EMPTY_DRAFT
  const target = draftTarget(current)
  const confirm = (): void => {
    if (current.step === undefined) return
    props.onChange(
      current.index === null
        ? [...props.value, current.step]
        : props.value.map((v, i) => (i === current.index ? current.step ?? v : v)),
    )
    close()
  }
  const toggleDevice = (deviceId: number): void => {
    const has = current.deviceIds.includes(deviceId)
    // A different set of devices offers a different set of actions.
    setDraft({
      ...current,
      step: undefined,
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
          {props.value.map((step, index) => (
            <Entry
              // The index is the entry's address (`buttons.0.do.1`); a step has no other identity.
              key={index}
              step={step}
              useEntryLabel={props.useEntryLabel}
              {...(props.disabled === true
                ? {}
                : {
                    onEdit: () => begin(draftOfStep(step, index)),
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
          {current.page === 'target' ? (
            <div className="flex flex-col" data-testid="dap-devices">
              <Tabs
                appearance="pills"
                value={current.mode}
                onValueChange={(mode) =>
                  setDraft({ ...current, step: undefined, mode: mode === 'domain' ? 'domain' : 'devices' })
                }
              >
                <TabsList className="px-3">
                  <TabsTrigger value="devices">
                    {t('uiLibrary.deviceActionPicker.byDevice', 'Devices')}
                  </TabsTrigger>
                  <TabsTrigger value="domain">
                    {t('uiLibrary.deviceActionPicker.byDomain', 'By room/type')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {current.mode === 'devices' ? (
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
              ) : (
                <DomainForm draft={current} onChange={setDraft} />
              )}
              <div className="flex justify-end border-t border-border-subtle px-3 py-2">
                <Button
                  size="sm"
                  type="button"
                  disabled={target === undefined}
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
                onClick={() => setDraft({ ...current, page: 'target' })}
                aria-label={t('uiLibrary.deviceValuePicker.back', 'Back to devices')}
              >
                <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {current.mode === 'devices'
                    ? t('uiLibrary.deviceActionPicker.devices', '{{count}} device(s)', {
                        count: current.deviceIds.length,
                      })
                    : t('uiLibrary.deviceActionPicker.byDomain', 'By room/type')}
                </span>
              </Button>
              <div className="flex flex-col gap-2 p-3">
                {target !== undefined &&
                  props.renderEditor({
                    target,
                    value: current.step,
                    onChange: (step) => setDraft({ ...current, step }),
                  })}
              </div>
              <div className="flex justify-end border-t border-border-subtle px-3 py-2">
                <Button
                  size="sm"
                  type="button"
                  data-testid="dap-confirm"
                  disabled={current.step === undefined}
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
