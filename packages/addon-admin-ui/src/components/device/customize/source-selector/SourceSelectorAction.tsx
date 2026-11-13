/**
 * `SourceSelector` with `intent: 'action'`: the same device modal, asking
 * "what should it DO" instead of "which value". Two ways in, one toggle:
 *
 *  - By device: devices left (one or several, plus "the device that triggered
 *    this run" / "the device of this round"), the commands they ALL offer right;
 *  - By action: every command at least one device offers left, grouped by cap
 *    and searchable; the devices that offer the picked one right.
 *
 * The host renders the command's open args (`args`) under the columns and
 * decides when Confirm is allowed. Controlled: the value is the draft target
 * and action id; the output step is `{ target, actionId, args }`.
 */
import { REPEAT_ITEM_VAR } from '@camstack/types'
import type { ActionTarget, ResolvedVocabAction } from '@camstack/types'
import {
  type DeviceListState,
  DeviceValueGroupList,
  type DeviceValueGroup,
  DeviceValuePanel,
  Input,
  type PickedValue,
  Radio,
  SegmentedChoice,
  useDeviceManagerListAll,
  useRecentDevices,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevicesBoundCaps } from '../../../device-do-action/use-device-bound-caps'
import { type PickerDevice, toPickerDevices } from '../source-picker-model'
import { vocabularyCapTitle } from '../vocabulary-field-label'
import { SourceSelectorColumns } from './source-selector-columns'
import {
  type ActionFleetDevice,
  type ActionPickMode,
  fleetActions,
  groupActionsByCap,
  keepCompatibleAction,
  keepOfferingDevices,
  matchesActionQuery,
  TRIGGER_DEVICE_VAR,
  targetActions,
  targetDeviceIds,
} from './source-selector-action-model'
import { type SourceSelectorStep, stepAfterBack, stepAfterDone } from './source-selector-steps'

/** What the operator has picked so far. */
export interface ActionPickDraft {
  readonly target: ActionTarget | null
  readonly actionId: string | null
}

export interface SourceSelectorActionProps {
  readonly kind: 'action'
  readonly intent: 'action'
  readonly value: ActionPickDraft
  readonly onChange: (next: ActionPickDraft) => void
  /** Offer "the device that triggered this run" (`{ $var: 'deviceId' }`). */
  readonly allowTriggerDevice?: boolean
  /** The devices of the repeat around the step: offers "the device of this round". */
  readonly roundDevices?: readonly number[]
  /** Several devices may be picked (default); false = exactly one. */
  readonly multiple?: boolean
  /** Device types this surface never offers. */
  readonly excludeTypes?: readonly string[]
  /** Step 3: the picked command's open args, drawn under the columns. */
  readonly args?: ReactNode
  readonly fillHeight?: boolean
}

type VocabLocaleKey = 'en' | 'it'

function localeOf(language: string): VocabLocaleKey {
  return language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

function listStateOf(devices: string, caps: string): DeviceListState {
  if (devices === 'error' || caps === 'error') return 'failed'
  if (devices === 'pending' || caps === 'pending') return 'pending'
  return 'answered'
}

/** The same fleet, with the binding answer folded in. */
function useActionFleet(excludeTypes: readonly string[] | undefined): {
  readonly rows: readonly PickerDevice[]
  readonly fleet: readonly ActionFleetDevice[]
  readonly listState: DeviceListState
} {
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const rows = useMemo(() => {
    const all = devices.status === 'success' ? toPickerDevices(devices.data) : []
    const excluded = new Set(excludeTypes ?? [])
    return all.filter((row) => !excluded.has(row.type))
  }, [devices.status, devices.data, excludeTypes])
  const caps = useDevicesBoundCaps(rows.map((row) => row.id))
  const fleet = useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        caps: caps.data?.get(row.id) ?? [],
      })),
    [rows, caps.data],
  )
  const capsStatus = rows.length === 0 && devices.status === 'success' ? 'success' : caps.status
  return {
    rows,
    fleet,
    listState: listStateOf(devices.status, capsStatus),
  }
}

function actionGroups(
  actions: readonly ResolvedVocabAction[],
  locale: VocabLocaleKey,
  language: string,
): readonly DeviceValueGroup[] {
  return groupActionsByCap(actions).map((group) => ({
    cap: group.cap,
    title: vocabularyCapTitle(group.cap, language),
    rows: group.actions.map((action) => ({
      cap: action.cap,
      path: action.id,
      label: action.label[locale],
      valueText: '',
    })),
  }))
}

interface PseudoTargetsProps {
  readonly target: ActionTarget | null
  readonly allowTriggerDevice: boolean
  readonly round: boolean
  readonly onPick: (target: ActionTarget) => void
}

/** "The device that triggered this run" / "the device of this round", above the list. */
function PseudoTargets({
  target,
  allowTriggerDevice,
  round,
  onPick,
}: PseudoTargetsProps): ReactNode {
  const { t } = useTranslation()
  const entries = [
    ...(allowTriggerDevice
      ? [
          {
            name: TRIGGER_DEVICE_VAR,
            label: t('customize.sourceSelector.action.triggerDevice'),
          },
        ]
      : []),
    ...(round
      ? [
          {
            name: REPEAT_ITEM_VAR,
            label: t('customize.sourceSelector.action.roundDevice'),
          },
        ]
      : []),
  ]
  if (entries.length === 0) return null
  return (
    <ul className="flex flex-col gap-1" data-testid="action-pseudo-targets">
      {entries.map((entry) => (
        <li key={entry.name}>
          <label className="flex items-center gap-2 text-[11px] text-foreground">
            <Radio
              name="action-pseudo-target"
              checked={target?.kind === 'var' && target.name === entry.name}
              data-testid={`action-target-var-${entry.name}`}
              onChange={() => onPick({ kind: 'var', name: entry.name })}
            />
            <span>{entry.label}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

/**
 * A command whose argument the device answers (a `dynamic` offer: its presets)
 * can be sent to one device only: picking another replaces the first.
 */
function oneDeviceForDynamic(
  target: ActionTarget | null,
  action: ResolvedVocabAction | undefined,
): ActionTarget | null {
  if (target?.kind !== 'devices' || target.ids.length <= 1 || action === undefined) return target
  if (!action.openArgs.some((arg) => arg.offer.kind === 'dynamic')) return target
  const last = target.ids[target.ids.length - 1]
  return last === undefined ? target : { kind: 'devices', ids: [last] }
}

export function SourceSelectorAction({
  value,
  onChange,
  allowTriggerDevice = false,
  roundDevices,
  multiple = true,
  excludeTypes,
  args,
  fillHeight = false,
}: SourceSelectorActionProps): ReactNode {
  const { t, i18n } = useTranslation()
  const locale = localeOf(i18n.language)
  const [mode, setMode] = useState<ActionPickMode>('by-device')
  const [step, setStep] = useState<SourceSelectorStep>('devices')
  const [query, setQuery] = useState('')
  const { fleet, listState } = useActionFleet(excludeTypes)
  const recents = useRecentDevices('command-devices')
  const context = useMemo(
    () => (roundDevices === undefined ? {} : { roundDevices }),
    [roundDevices],
  )
  const offered = useMemo(
    () => targetActions(fleet, value.target, context),
    [fleet, value.target, context],
  )
  const everyAction = useMemo(() => fleetActions(fleet), [fleet])
  const pickedAction = everyAction.find((a) => a.id === value.actionId)
  const setTarget = (picked: ActionTarget | null): void => {
    const target = oneDeviceForDynamic(picked, mode === 'by-action' ? pickedAction : undefined)
    // By device: a new target keeps the command only if it still offers it.
    // By action: the device list already offers only the picked command.
    const actionId =
      mode === 'by-device'
        ? keepCompatibleAction(fleet, target, value.actionId, context)
        : value.actionId
    onChange({ target, actionId })
  }
  const setAction = (actionId: string): void => {
    const target =
      mode === 'by-action' ? keepOfferingDevices(fleet, value.target, actionId) : value.target
    onChange({ target, actionId })
  }

  const deviceRequires =
    mode === 'by-action' && value.actionId !== null ? { actions: [value.actionId] } : undefined
  const pickedDevices = targetDeviceIds(value.target).map((deviceId): PickedValue => ({ deviceId }))
  const onSelectDevice = (next: PickedValue): void => {
    recents.push(next.deviceId)
    const ids = targetDeviceIds(value.target)
    const nextIds = multiple
      ? ids.includes(next.deviceId)
        ? ids.filter((id) => id !== next.deviceId)
        : [...ids, next.deviceId]
      : ids.length === 1 && ids[0] === next.deviceId
        ? []
        : [next.deviceId]
    setTarget(nextIds.length === 0 ? null : { kind: 'devices', ids: nextIds })
  }
  const deviceList = (
    <div
      className={fillHeight ? 'flex min-h-0 flex-1 flex-col gap-2' : 'flex min-h-0 flex-col gap-2'}
      data-testid="action-device-column"
    >
      <h3 className="text-[11px] font-medium text-foreground-muted">
        {t('customize.sourceSelector.action.devicesHeading')}
      </h3>
      <PseudoTargets
        target={value.target}
        allowTriggerDevice={allowTriggerDevice && (mode === 'by-device' || value.actionId !== null)}
        round={roundDevices !== undefined}
        onPick={setTarget}
      />
      {mode === 'by-action' && value.actionId === null ? (
        <p className="text-[11px] text-foreground-subtle">
          {t('customize.sourceSelector.action.pickActionFirst')}
        </p>
      ) : (
        <DeviceValuePanel
          requires={deviceRequires}
          excludeTypes={excludeTypes}
          kind="device"
          multiple={multiple}
          picked={pickedDevices}
          onSelect={onSelectDevice}
          railFirst={false}
          recentIds={recents.ids}
          autoFocus={mode === 'by-device'}
          fill={fillHeight}
        />
      )}
    </div>
  )

  const listed = mode === 'by-device' ? offered : everyAction
  const filtered = listed.filter((action) =>
    matchesActionQuery(action, locale, vocabularyCapTitle(action.cap, i18n.language), query),
  )
  const actionList = (
    <div className="flex min-h-0 flex-col gap-2" data-testid="action-command-column">
      <h3 className="text-[11px] font-medium text-foreground-muted">
        {t('customize.sourceSelector.action.actionsHeading')}
      </h3>
      {(mode === 'by-action' || listed.length >= 8) && (
        <Input
          type="search"
          value={query}
          aria-label={t('customize.sourceSelector.action.search')}
          placeholder={t('customize.sourceSelector.action.search')}
          data-testid="action-search"
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {mode === 'by-device' && value.target === null ? (
        <p className="text-[11px] text-foreground-subtle">
          {t('customize.sourceSelector.action.pickDeviceFirst')}
        </p>
      ) : listState === 'pending' ? (
        <p role="status" className="text-[11px] text-foreground-subtle">
          {t('customize.sourceSelector.action.loading')}
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle" data-testid="action-none">
          {query.trim() !== ''
            ? t('customize.sourceSelector.action.noMatch', { query })
            : targetDeviceIds(value.target).length > 1
              ? t('customize.sourceSelector.action.noCommon')
              : t('customize.sourceSelector.action.none')}
        </p>
      ) : (
        <DeviceValueGroupList
          name="action-command"
          groups={actionGroups(filtered, locale, i18n.language)}
          value={
            value.actionId === null
              ? null
              : {
                  cap: listed.find((a) => a.id === value.actionId)?.cap ?? '',
                  path: value.actionId,
                }
          }
          rowTestId={(row) => `action-row-${row.path}`}
          onPick={(pick) => setAction(pick.path)}
        />
      )}
    </div>
  )

  const leftPicked = mode === 'by-device' ? value.target !== null : value.actionId !== null
  const leftCount =
    mode === 'by-device'
      ? value.target?.kind === 'devices'
        ? value.target.ids.length
        : value.target === null
          ? 0
          : 1
      : value.actionId === null
        ? 0
        : 1
  return (
    <div className={fillHeight ? 'flex min-h-0 flex-1 flex-col gap-3' : 'flex flex-col gap-3'}>
      <SegmentedChoice<ActionPickMode>
        label={t('customize.sourceSelector.action.mode')}
        value={mode}
        options={[
          {
            value: 'by-device',
            label: t('customize.sourceSelector.action.byDevice'),
          },
          {
            value: 'by-action',
            label: t('customize.sourceSelector.action.byAction'),
          },
        ]}
        onChange={(next) => {
          if (next === 'by-device') {
            const actionId = keepCompatibleAction(fleet, value.target, value.actionId, context)
            if (actionId !== value.actionId) onChange({ target: value.target, actionId })
          }
          setMode(next)
          setStep('devices')
          setQuery('')
        }}
      />
      <SourceSelectorColumns
        step={step}
        devices={mode === 'by-device' ? deviceList : actionList}
        values={mode === 'by-device' ? actionList : deviceList}
        back={
          leftPicked
            ? {
                label: t('customize.sourceSelector.backToDevices'),
                ariaLabel: t('customize.sourceSelector.backToDevices'),
              }
            : null
        }
        onBack={() => setStep(stepAfterBack())}
        done={{
          countLabel: t('customize.sourceSelector.pickedCount', {
            count: leftCount,
          }),
          label: t('customize.sourceSelector.done'),
          disabled: !leftPicked,
        }}
        onDone={() => {
          const next = stepAfterDone(leftCount)
          if (next !== null) setStep(next)
        }}
        fillHeight={fillHeight}
      />
      {args !== undefined && args !== null && value.actionId !== null && value.target !== null && (
        <div
          data-testid="action-args"
          className="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto border-t border-border pt-3"
        >
          {args}
        </div>
      )}
    </div>
  )
}
