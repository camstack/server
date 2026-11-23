/**
 * "Triggered by": the linked triggers that command this device, one row per
 * source device, in the same chrome as Linked devices (a generic
 * {@link DeviceList} and the shared device picker). A row is stored as an
 * automation made from the built-in linked-trigger template; this section is
 * the only place such an automation is created, changed or deleted.
 */
import {
  builtinAutomationTemplate,
  ON_FOR_MAX_SECONDS,
  switchRunLimitOf,
  type DeviceInfo,
  LINKED_TRIGGER_TEMPLATE_ID,
  type LinkedTriggerParams,
  linkedTriggerValues,
  type TemplateInstance,
} from '@camstack/types'
import {
  DeviceList,
  type DeviceListColumn,
  deviceTypeMetaOf,
  IconButton,
  resolveDeviceLabel,
  Select,
  Switch,
  useCoreBlocksCreate,
  useCoreBlocksDelete,
  useCoreBlocksListTemplateInstances,
  useCoreBlocksSetEnabled,
  useCoreBlocksUpdate,
  useDeviceNameIndex,
  useDeviceNameNouns,
  useUiText,
} from '@camstack/ui-library'
import { Clock, Pencil, X, Zap } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EVENT_EMITTER_CAP } from '../../../../pages/build/automation/fired-model'
import { expandInstance } from '../../../../pages/build/templates/template-values'
import { AssignmentSection } from '../assignments/AssignmentSection'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { SourceSelectorDevicesDialog } from '../source-selector/SourceSelectorDevicesDialog'
import { useCapIndex } from '../assignments/use-cap-index'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import { LinkedNameCell } from '../kinds/LinkedNameCell'
import { useConfirmRemove } from '../use-confirm-remove'
import {
  actionChoiceOf,
  commandCapOf,
  editPickOf,
  type DetectionClass,
  type FiredPick,
  filterSummary,
  isEditable,
  LINKED_TRIGGER_COMMAND_CAPS,
  MOTION_CAP,
  newTriggerParams,
  offeredChoices,
  replacesFilter,
  sourceKindOf,
  type TriggerRow,
  triggerRows,
  withActiveLimits,
  withoutRow,
  withRowAction,
  withRowClasses,
  withRowFilter,
  withRowOnFor,
} from './linked-triggers-model'
import { OnForField } from './OnForField'
import { TriggerClassesDialog } from './TriggerClassesDialog'
import { TriggerFilterDialog } from './TriggerFilterDialog'
import { TriggerWindowDialog } from './TriggerWindowDialog'

export interface TriggeredByTableProps {
  readonly device: DeviceInfo
}

/** What an edit of a stored trigger writes: its code, nothing else. */
interface TriggerCodePatch {
  readonly code: string | undefined
}

interface TriggerTableRow extends TriggerRow {
  readonly name: string | null
  readonly type: string | null
  readonly detail: string | null
}

/** What a source device may carry: events it fires, or motion it reports. A camera needs neither. */
const SOURCE_CAPS: readonly string[] = [EVENT_EMITTER_CAP, MOTION_CAP]
const CAMERA_TYPE = 'camera'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TriggeredByTable({ device }: TriggeredByTableProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const nameIndex = useDeviceNameIndex()
  const nameNouns = useDeviceNameNouns()
  const confirmRemove = useConfirmRemove()
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<TriggerTableRow | null>(null)
  const [timing, setTiming] = useState<TriggerTableRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const instances = useCoreBlocksListTemplateInstances({
    templateId: LINKED_TRIGGER_TEMPLATE_ID,
    deviceId: device.id,
  })
  const commandCaps = useCapIndex(LINKED_TRIGGER_COMMAND_CAPS, true)
  const read = instances.data === undefined ? null : triggerRows(instances.data.instances)
  const shown = read !== null && (read.rows.length > 0 || read.unreadable.length > 0)
  const fleet = useCandidateDevices(picking || shown)
  const sourceCaps = useCapIndex(SOURCE_CAPS, picking)
  const create = useCoreBlocksCreate()
  const update = useCoreBlocksUpdate()
  const remove = useCoreBlocksDelete()
  const setEnabled = useCoreBlocksSetEnabled()

  const capability =
    commandCaps.kind === 'known' ? commandCapOf(commandCaps.value.get(device.id) ?? []) : null
  // A device nothing can command shows the section only for triggers it already has.
  if (capability === null && !shown) return null

  if (read === null) {
    return (
      <AssignmentSection
        id="triggers"
        icon={Zap}
        title={t('customize.triggers.title')}
        notices={
          instances.status === 'error' ? (
            <p role="alert" className="text-xs text-warning break-words">
              {t('customize.assign.unknown', {
                reason: instances.error.message,
              })}
            </p>
          ) : (
            <p role="status" className="text-xs text-foreground-subtle">
              {t('customize.assign.checking')}
            </p>
          )
        }
      >
        {null}
      </AssignmentSection>
    )
  }

  const stored = instances.data?.instances ?? []
  const instanceOf = (blockId: string): TemplateInstance | undefined =>
    stored.find((i) => i.blockId === blockId)
  const fleetById = new Map<number, CandidateDevice>(
    fleet.kind === 'known' ? fleet.value.map((d) => [d.id, d]) : [],
  )
  /** The common device label (parent, noun), as every other device list shows it. */
  const labelOf = (d: CandidateDevice): string =>
    resolveDeviceLabel(
      {
        id: d.id,
        name: d.name,
        type: d.type,
        stableId: d.stableId,
        role: d.role ?? null,
        parentDeviceId: d.parentDeviceId ?? null,
        location: d.location,
        primaryChildEntityId: d.primaryChildEntityId ?? null,
        primaryChildPreference: d.primaryChildPreference ?? null,
      },
      'compact',
      nameIndex,
      nameNouns,
    )
  const rows: readonly TriggerTableRow[] = read.rows.map((row) => {
    const known = fleetById.get(row.deviceId)
    return {
      ...row,
      name: known === undefined ? null : labelOf(known),
      type: known?.type ?? null,
      detail: known === undefined ? null : candidateDetail(known.integration, known.location),
    }
  })
  const sourceIds = new Set(read.rows.map((r) => r.deviceId))

  const candidates: Known<readonly AssignmentCandidate[]> =
    fleet.kind !== 'known'
      ? fleet
      : sourceCaps.kind !== 'known'
        ? sourceCaps
        : {
            kind: 'known',
            value: fleet.value
              .filter(
                (d) =>
                  d.id !== device.id &&
                  !sourceIds.has(d.id) &&
                  sourceKindOf(d.type, sourceCaps.value.get(d.id) ?? []) !== null,
              )
              .map((d) => ({
                deviceId: d.id,
                ref: { addonId: d.addonId, stableId: d.stableId },
                name: labelOf(d),
                detail: candidateDetail(d.integration, d.location),
                meta: deviceTypeMetaOf(d.type, uiText).label,
                caps: sourceCaps.value.get(d.id) ?? [],
                value: null,
              })),
          }

  /** One write at a time; a refusal is shown, never swallowed. */
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) {
      setRefusal(t('customize.saveInFlight'))
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      await work()
      await instances.refetch()
    } catch (err: unknown) {
      setRefusal(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const blockOf = (params: LinkedTriggerParams, name: string, enabled: boolean) => {
    const template = builtinAutomationTemplate(LINKED_TRIGGER_TEMPLATE_ID)
    if (template === undefined) throw new Error(t('customize.triggers.templateMissing'))
    const block = expandInstance(
      LINKED_TRIGGER_TEMPLATE_ID,
      template.payload,
      linkedTriggerValues(params),
      name,
      enabled,
    )
    if (!block.ok) throw new Error(block.problems.map((p) => p.detail).join('; '))
    return block.input
  }

  // An edit owns the recipe only: the update is partial, so the block's name, tags,
  // integration and placement stay as stored.
  const codeOf = (params: LinkedTriggerParams, instance: TemplateInstance): TriggerCodePatch => ({
    code: blockOf(params, instance.name, instance.enabled).code,
  })

  const save = (instance: TemplateInstance, params: LinkedTriggerParams | null): Promise<void> =>
    run(async () => {
      if (params === null) throw new Error(t('customize.triggers.unreadableOne'))
      await update.mutateAsync({
        blockId: instance.blockId,
        block: codeOf(params, instance),
      })
    })

  const add = (picked: readonly AssignmentCandidate[]): Promise<void> =>
    run(async () => {
      if (capability === null) throw new Error(t('customize.triggers.notCommandable'))
      for (const candidate of picked) {
        const kind = sourceKindOf(fleetById.get(candidate.deviceId)?.type ?? null, candidate.caps)
        const params =
          kind === null ? null : newTriggerParams(device.id, candidate.deviceId, capability, kind)
        if (params === null) throw new Error(t('customize.triggers.notCommandable'))
        const name = t('customize.triggers.blockName', {
          source: candidate.name,
          target: device.name,
        })
        await create.mutateAsync({ block: blockOf(params, name, true) })
      }
    })

  const unlink = async (row: TriggerTableRow): Promise<void> => {
    const instance = instanceOf(row.blockId)
    if (instance === undefined) return
    const name = row.name ?? `#${String(row.deviceId)}`
    if (!(await confirmRemove(t('customize.triggers.removeWhat', { name }), false))) return
    const removal = withoutRow(instance, row.deviceId)
    await run(async () => {
      if (removal.kind === 'delete') await remove.mutateAsync({ blockId: instance.blockId })
      else {
        await update.mutateAsync({
          blockId: instance.blockId,
          block: codeOf(removal.params, instance),
        })
      }
    })
  }

  const columns: readonly DeviceListColumn<TriggerTableRow>[] = [
    {
      key: 'device',
      header: t('customize.triggers.source'),
      cell: (r) => (
        <LinkedNameCell name={r.name} deviceId={r.deviceId} detail={r.detail}>
          {r.flagged && (
            <span role="alert" className="text-[11px] text-warning">
              {t('customize.triggers.flagged')}
            </span>
          )}
        </LinkedNameCell>
      ),
    },
    {
      key: 'event',
      header: t('customize.triggers.event'),
      cellClassName: 'text-xs text-foreground-subtle',
      cell: (r) => {
        const summary = filterSummary(r.filter)
        return (
          <div className="flex flex-wrap items-center gap-1">
            <span className="break-words">
              {r.filter.kind === 'motion'
                ? t('customize.triggers.motionDetected')
                : r.filter.kind === 'detection'
                  ? r.filter.classes.map((c) => t(`customize.triggers.classes.${c}`)).join(', ')
                  : summary.custom
                    ? t('customize.triggers.customFilter')
                    : [
                        summary.events.length === 0
                          ? t('customize.triggers.anyEvent')
                          : summary.events.join(', '),
                        ...(summary.parts.length === 0
                          ? []
                          : [
                              t('customize.triggers.partsNamed', {
                                parts: summary.parts.join(', '),
                              }),
                            ]),
                      ].join(' · ')}
            </span>
            {(r.activeWindow !== null || r.activeWhen !== null) && (
              <span className="shrink-0 text-[11px] text-foreground-muted">
                {t('customize.triggers.windowSet')}
              </span>
            )}
            {isEditable(r.filter) && (
              <IconButton
                icon={Pencil}
                variant="ghost"
                size="sm"
                aria-label={t(
                  r.filter.kind === 'detection'
                    ? 'customize.triggers.editClasses'
                    : 'customize.triggers.editFilter',
                  { name: r.name ?? r.deviceId },
                )}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing(r)
                }}
              />
            )}
            <IconButton
              icon={Clock}
              variant="ghost"
              size="sm"
              aria-label={t('customize.triggers.editWindow', {
                name: r.name ?? r.deviceId,
              })}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                setTiming(r)
              }}
            />
          </div>
        )
      },
    },
    {
      key: 'action',
      header: t('customize.triggers.action'),
      cell: (r) => {
        const choice = actionChoiceOf(r)
        const choices = offeredChoices(r.capability)
        return (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-28">
              <Select
                aria-label={t('customize.triggers.actionFor', {
                  name: r.name ?? r.deviceId,
                })}
                value={choice}
                disabled={busy}
                options={choices.map((option) => ({
                  value: option,
                  label: t(`customize.triggers.actions.${option}`),
                }))}
                onChange={(e) => {
                  const instance = instanceOf(r.blockId)
                  const next = choices.find((option) => option === e.target.value)
                  if (instance !== undefined && next !== undefined && next !== choice) {
                    void save(instance, withRowAction(instance, next))
                  }
                }}
              />
            </div>
            {r.onForSeconds !== null && choice === 'on-for' && (
              <OnForField
                seconds={r.onForSeconds}
                label={t('customize.triggers.onForFor', {
                  name: r.name ?? r.deviceId,
                })}
                hint={t('customize.triggers.onForHint')}
                disabled={busy}
                testId={`trigger-on-for-${r.key}`}
                maxSeconds={Math.min(
                  ON_FOR_MAX_SECONDS,
                  switchRunLimitOf(device.type, device.role).maxSeconds,
                )}
                onCommit={(seconds) => {
                  const instance = instanceOf(r.blockId)
                  if (instance !== undefined) void save(instance, withRowOnFor(instance, seconds))
                }}
              />
            )}
          </div>
        )
      },
    },
    {
      key: 'enabled',
      header: t('customize.triggers.active'),
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      cell: (r) => (
        <Switch
          checked={r.enabled}
          disabled={busy}
          aria-label={t('customize.triggers.activeFor', {
            name: r.name ?? r.deviceId,
          })}
          onCheckedChange={(enabled) =>
            void run(async () => {
              await setEnabled.mutateAsync({ blockId: r.blockId, enabled })
            })
          }
        />
      ),
    },
    {
      key: 'remove',
      header: '',
      cellClassName: 'text-right w-10',
      cell: (r) => (
        <IconButton
          icon={X}
          variant="ghost"
          size="sm"
          aria-label={t('customize.assign.removeNamed', {
            name: r.name ?? r.deviceId,
          })}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            void unlink(r)
          }}
        />
      ),
    },
  ]

  const saveClasses = (row: TriggerTableRow, classes: readonly DetectionClass[]): void => {
    const instance = instanceOf(row.blockId)
    setEditing(null)
    if (instance !== undefined) void save(instance, withRowClasses(instance, row.deviceId, classes))
  }

  const saveFilter = (row: TriggerTableRow, pick: FiredPick): void => {
    const instance = instanceOf(row.blockId)
    setEditing(null)
    if (instance !== undefined) void save(instance, withRowFilter(instance, row.deviceId, pick))
  }

  return (
    <>
      <AssignmentSection
        id="triggers"
        icon={Zap}
        title={t('customize.triggers.title')}
        addLabel={t('customize.triggers.add')}
        onAdd={busy || capability === null ? undefined : () => setPicking(true)}
        notices={
          <>
            {fleet.kind === 'unknown' && (
              <p role="alert" className="text-xs text-warning break-words">
                {t('customize.assign.devicesUnreadable', {
                  reason: fleet.reason,
                })}
              </p>
            )}
            {read.unreadable.length > 0 && (
              <p role="alert" className="text-xs text-warning break-words">
                {t('customize.triggers.unreadable', {
                  names: read.unreadable.map((u) => u.name).join(', '),
                })}
              </p>
            )}
            {refusal !== null && (
              <p role="alert" className="text-xs text-danger break-words">
                {refusal}
              </p>
            )}
          </>
        }
      >
        <li className="list-none px-3 py-2 sm:px-4">
          {rows.length === 0 ? (
            <p className="text-[11px] text-foreground-subtle">{t('customize.assign.none')}</p>
          ) : (
            <DeviceList<TriggerTableRow>
              mode="generic"
              items={rows}
              getKey={(r) => r.key}
              getSearchText={(r) =>
                [r.name ?? '', r.detail ?? '', r.type ?? '', String(r.deviceId)].join(' ')
              }
              getFilterType={(r) =>
                r.type === null ? null : deviceTypeMetaOf(r.type, uiText).label
              }
              columns={columns}
              searchPlaceholder={t('customize.assign.search')}
              emptyLabel={t('customize.assign.none')}
            />
          )}
        </li>
      </AssignmentSection>
      <SourceSelectorDevicesDialog
        open={picking}
        title={t('customize.triggers.pickTitle')}
        selection="multi"
        candidates={candidates}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          void add(picked)
        }}
        onClose={() => setPicking(false)}
      />
      {editing !== null &&
        editing.filter.kind !== 'detection' &&
        editing.filter.kind !== 'motion' && (
          <TriggerFilterDialog
            deviceId={editing.deviceId}
            deviceName={editing.name ?? `#${String(editing.deviceId)}`}
            pick={editPickOf(instanceOf(editing.blockId), editing.deviceId)}
            replaces={replacesFilter(editing.filter)}
            busy={busy}
            onSave={(pick) => saveFilter(editing, pick)}
            onClose={() => setEditing(null)}
          />
        )}
      {editing !== null && editing.filter.kind === 'detection' && (
        <TriggerClassesDialog
          deviceName={editing.name ?? `#${String(editing.deviceId)}`}
          classes={editing.filter.classes}
          busy={busy}
          onSave={(classes) => saveClasses(editing, classes)}
          onClose={() => setEditing(null)}
        />
      )}
      {timing !== null && (
        <TriggerWindowDialog
          deviceName={timing.name ?? `#${String(timing.deviceId)}`}
          window={timing.activeWindow}
          state={timing.activeWhen}
          busy={busy}
          onSave={(window, state) => {
            const instance = instanceOf(timing.blockId)
            setTiming(null)
            if (instance !== undefined)
              void save(instance, withActiveLimits(instance, window, state))
          }}
          onClose={() => setTiming(null)}
        />
      )}
    </>
  )
}
