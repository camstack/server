/**
 * "Triggered by": the linked triggers that command this device, one row per
 * source device, in the same chrome as Linked devices (a generic
 * {@link DeviceList} and the shared device picker). A row is stored as an
 * automation made from the built-in linked-trigger template; this section is
 * the only place such an automation is created, changed or deleted.
 */
import {
  builtinAutomationTemplate,
  type DeviceInfo,
  LINKED_TRIGGER_TEMPLATE_ID,
  type LinkedTriggerAction,
  type LinkedTriggerParams,
  linkedTriggerValues,
  type TemplateInstance,
} from '@camstack/types'
import {
  DeviceList,
  type DeviceListColumn,
  deviceTypeMetaOf,
  IconButton,
  Select,
  Switch,
  useCoreBlocksCreate,
  useCoreBlocksDelete,
  useCoreBlocksListTemplateInstances,
  useCoreBlocksSetEnabled,
  useCoreBlocksUpdate,
  useUiText,
} from '@camstack/ui-library'
import { Pencil, X, Zap } from 'lucide-react'
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
import { CustomizeDevicePickerDialog } from '../assignments/CustomizeDevicePickerDialog'
import { useCapIndex } from '../assignments/use-cap-index'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import { LinkedNameCell } from '../kinds/LinkedNameCell'
import { useConfirmRemove } from '../use-confirm-remove'
import {
  commandCapOf,
  type FiredPick,
  filterSummary,
  LINKED_TRIGGER_COMMAND_CAPS,
  newTriggerParams,
  offeredActions,
  type TriggerRow,
  triggerRows,
  withoutRow,
  withRowAction,
  withRowFilter,
} from './linked-triggers-model'
import { TriggerFilterDialog } from './TriggerFilterDialog'

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

const EMITTER_CAPS: readonly string[] = [EVENT_EMITTER_CAP]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TriggeredByTable({ device }: TriggeredByTableProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const confirmRemove = useConfirmRemove()
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<TriggerTableRow | null>(null)
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
  const emitters = useCapIndex(EMITTER_CAPS, picking)
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
              {t('customize.assign.unknown', { reason: instances.error.message })}
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
  const rows: readonly TriggerTableRow[] = read.rows.map((row) => {
    const known = fleetById.get(row.deviceId)
    return {
      ...row,
      name: known?.name ?? null,
      type: known?.type ?? null,
      detail: known === undefined ? null : candidateDetail(known.integration, known.location),
    }
  })
  const sourceIds = new Set(read.rows.map((r) => r.deviceId))

  const candidates: Known<readonly AssignmentCandidate[]> =
    fleet.kind !== 'known'
      ? fleet
      : emitters.kind !== 'known'
        ? emitters
        : {
            kind: 'known',
            value: fleet.value
              .filter((d) => d.id !== device.id && !sourceIds.has(d.id) && emitters.value.has(d.id))
              .map((d) => ({
                deviceId: d.id,
                ref: { addonId: d.addonId, stableId: d.stableId },
                name: d.name,
                detail: candidateDetail(d.integration, d.location),
                meta: deviceTypeMetaOf(d.type, uiText).label,
                caps: EMITTER_CAPS,
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
        const params = newTriggerParams(device.id, candidate.deviceId, capability)
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
          <div className="flex items-center gap-1">
            <span className="min-w-0 break-words">
              {summary.custom
                ? t('customize.triggers.customFilter')
                : [
                    summary.events.length === 0
                      ? t('customize.triggers.anyEvent')
                      : summary.events.join(', '),
                    ...(summary.parts.length === 0
                      ? []
                      : [t('customize.triggers.partsNamed', { parts: summary.parts.join(', ') })]),
                  ].join(' · ')}
            </span>
            {r.filter.kind === 'fired' && (
              <IconButton
                icon={Pencil}
                variant="ghost"
                size="sm"
                aria-label={t('customize.triggers.editFilter', {
                  name: r.name ?? r.deviceId,
                })}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing(r)
                }}
              />
            )}
          </div>
        )
      },
    },
    {
      key: 'action',
      header: t('customize.triggers.action'),
      cell: (r) => (
        <Select
          aria-label={t('customize.triggers.actionFor', { name: r.name ?? r.deviceId })}
          value={r.action}
          disabled={busy}
          options={offeredActions(r.capability).map((action) => ({
            value: action,
            label: t(`customize.triggers.actions.${action}`),
          }))}
          onChange={(e) => {
            const instance = instanceOf(r.blockId)
            const action = offeredActions(r.capability).find((a) => a === e.target.value)
            if (instance !== undefined && action !== undefined && action !== r.action) {
              void save(instance, withRowAction(instance, action))
            }
          }}
        />
      ),
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
          aria-label={t('customize.triggers.activeFor', { name: r.name ?? r.deviceId })}
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
          aria-label={t('customize.assign.removeNamed', { name: r.name ?? r.deviceId })}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            void unlink(r)
          }}
        />
      ),
    },
  ]

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
                {t('customize.assign.devicesUnreadable', { reason: fleet.reason })}
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
      <CustomizeDevicePickerDialog
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
      {editing !== null && editing.filter.kind === 'fired' && (
        <TriggerFilterDialog
          deviceId={editing.deviceId}
          deviceName={editing.name ?? `#${String(editing.deviceId)}`}
          pick={{ events: editing.filter.events, parts: editing.filter.parts }}
          busy={busy}
          onSave={(pick) => saveFilter(editing, pick)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}
