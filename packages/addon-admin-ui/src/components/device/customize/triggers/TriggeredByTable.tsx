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
  linkedTriggerParamsOf,
  linkedTriggerValues,
  type TemplateInstance,
} from '@camstack/types'
import {
  DeviceList,
  deviceTypeMetaOf,
  FormSaveBar,
  resolveDeviceLabel,
  useCoreBlocksCreate,
  useCoreBlocksDelete,
  useCoreBlocksListTemplateInstances,
  useCoreBlocksSetEnabled,
  useCoreBlocksUpdate,
  useDeviceNameIndex,
  useDeviceNameNouns,
  useUiText,
} from '@camstack/ui-library'
import { Zap } from 'lucide-react'
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
import { useCapIndex } from '../assignments/use-cap-index'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import {
  commandCapOf,
  editPickOf,
  LINKED_TRIGGER_COMMAND_CAPS,
  MOTION_CAP,
  newTriggerParams,
  rowSourceKindOf,
  sourceKindOf,
  triggerRows,
  type TriggerSourceKind,
  withConditions,
  withoutRow,
  withRowAction,
  withRowOnFor,
  withRowSource,
} from './linked-triggers-model'
import { TriggerRowCard, type TriggerRowView } from './TriggerRowCard'
import { TriggerDialog, type TriggerDialogInitial, type TriggerDialogResult } from './TriggerDialog'
import {
  draftOps,
  EMPTY_DRAFT,
  type TriggerDraft,
  withAdded,
  withEnabled,
  withParams,
  withRemoval,
  workingInstances,
} from './trigger-draft'

export interface TriggeredByTableProps {
  readonly device: DeviceInfo
}

/** What an edit of a stored trigger writes: its code, nothing else. */
interface TriggerCodePatch {
  readonly code: string | undefined
}

interface TriggerTableRow extends TriggerRowView {
  readonly type: string | null
}

type TriggerDialogState =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly row: TriggerTableRow }

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
  const [draft, setDraft] = useState<TriggerDraft>(EMPTY_DRAFT)
  /** The one dialog: absent, a new trigger, or the row being edited. */
  const [dialog, setDialog] = useState<TriggerDialogState | null>(null)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const instances = useCoreBlocksListTemplateInstances({
    templateId: LINKED_TRIGGER_TEMPLATE_ID,
    deviceId: device.id,
  })
  const commandCaps = useCapIndex(LINKED_TRIGGER_COMMAND_CAPS, true)
  const stored = instances.data?.instances ?? []
  const working = workingInstances(stored, draft)
  const read = instances.data === undefined ? null : triggerRows(working)
  const shown = read !== null && (read.rows.length > 0 || read.unreadable.length > 0)
  const fleet = useCandidateDevices(dialog !== null || shown)
  const sourceCaps = useCapIndex(SOURCE_CAPS, dialog !== null)
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

  const instanceOf = (blockId: string): TemplateInstance | undefined =>
    working.find((i) => i.blockId === blockId)
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
  // The devices already a source stay out, except the one being edited: it may keep itself.
  const sourceIds = new Set(
    read.rows.flatMap((r) =>
      dialog?.kind === 'edit' && dialog.row.key === r.key ? [] : [r.deviceId],
    ),
  )

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

  const ops = draftOps(stored, draft)

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
  const codeOf = (instance: TemplateInstance): TriggerCodePatch => {
    const params = linkedTriggerParamsOf(instance.values)
    if (params === null) throw new Error(t('customize.triggers.unreadableOne'))
    return { code: blockOf(params, instance.name, instance.enabled).code }
  }

  /** Every pending change, written once. A refusal keeps the draft and is shown. */
  const saveAll = async (): Promise<void> => {
    if (busy) {
      setRefusal(t('customize.saveInFlight'))
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      for (const op of ops) {
        if (op.kind === 'delete') await remove.mutateAsync({ blockId: op.blockId })
        else if (op.kind === 'update') {
          await update.mutateAsync({
            blockId: op.instance.blockId,
            block: codeOf(op.instance),
          })
        } else if (op.kind === 'enable') {
          await setEnabled.mutateAsync({
            blockId: op.blockId,
            enabled: op.enabled,
          })
        } else {
          const params = linkedTriggerParamsOf(op.instance.values)
          if (params === null) throw new Error(t('customize.triggers.unreadableOne'))
          await create.mutateAsync({
            block: blockOf(params, op.instance.name, op.instance.enabled),
          })
          setDraft((d) => ({
            ...d,
            added: d.added.filter((a) => a.blockId !== op.instance.blockId),
          }))
        }
      }
      await instances.refetch()
      setDraft(EMPTY_DRAFT)
    } catch (err: unknown) {
      setRefusal(messageOf(err))
      await instances.refetch()
    } finally {
      setBusy(false)
    }
  }

  const edit = (instance: TemplateInstance, params: LinkedTriggerParams | null): void => {
    if (params === null) {
      setRefusal(t('customize.triggers.unreadableOne'))
      return
    }
    setDraft((d) => withParams(d, instance, params))
  }

  const kindOf = (deviceId: number): TriggerSourceKind | null =>
    sourceKindOf(
      fleetById.get(deviceId)?.type ?? null,
      sourceCaps.kind === 'known' ? (sourceCaps.value.get(deviceId) ?? []) : [],
    )

  /** What an edit of a row starts the dialog from: its source, conditions and limits as stored. */
  const initialOf = (row: TriggerTableRow): TriggerDialogInitial => ({
    deviceId: row.deviceId,
    kind: rowSourceKindOf(row.filter),
    filter: row.filter,
    pick: editPickOf(instanceOf(row.blockId), row.deviceId),
    classes: row.filter.kind === 'detection' ? row.filter.classes : [],
    activeWindow: row.activeWindow,
    activeWhen: row.activeWhen,
  })

  /** A new trigger from the dialog: the source's defaults, then what the operator changed. */
  const addTrigger = (result: TriggerDialogResult): void => {
    const fresh =
      capability === null
        ? null
        : newTriggerParams(device.id, result.deviceId, capability, result.kind)
    if (fresh === null) {
      setRefusal(t('customize.triggers.notCommandable'))
      return
    }
    const source =
      candidates.kind === 'known'
        ? candidates.value.find((c) => c.deviceId === result.deviceId)
        : undefined
    const base: Omit<TemplateInstance, 'blockId'> = {
      name: t('customize.triggers.blockName', {
        source: source?.name ?? `#${String(result.deviceId)}`,
        target: device.name,
      }),
      enabled: true,
      templateId: LINKED_TRIGGER_TEMPLATE_ID,
      values: linkedTriggerValues(fresh),
    }
    const params = withConditions({ ...base, blockId: '' }, result.deviceId, result)
    if (params === null) {
      setRefusal(t('customize.triggers.unreadableOne'))
      return
    }
    setRefusal(null)
    setDraft((d) => withAdded(d, { ...base, values: linkedTriggerValues(params) }))
  }

  /** An edit: the source swapped when it changed, the conditions the operator touched, the limits. */
  const editTrigger = (row: TriggerTableRow, result: TriggerDialogResult): void => {
    const instance = instanceOf(row.blockId)
    if (instance === undefined) return
    const moved = withRowSource(
      instance,
      row.deviceId,
      result.deviceId,
      rowSourceKindOf(row.filter),
      result.kind,
    )
    const params =
      moved === null
        ? null
        : withConditions(
            { ...instance, values: linkedTriggerValues(moved) },
            result.deviceId,
            result,
          )
    if (params === null) {
      setRefusal(t('customize.triggers.unreadableOne'))
      return
    }
    setRefusal(null)
    edit(instance, params)
  }

  const saveDialog = (result: TriggerDialogResult): void => {
    const open = dialog
    setDialog(null)
    if (open?.kind === 'add') addTrigger(result)
    else if (open?.kind === 'edit') editTrigger(open.row, result)
  }

  const unlink = (row: TriggerTableRow): void => {
    const instance = instanceOf(row.blockId)
    if (instance === undefined) return
    setDraft((d) => withRemoval(d, instance, withoutRow(instance, row.deviceId)))
  }

  return (
    <>
      <AssignmentSection
        id="triggers"
        icon={Zap}
        title={t('customize.triggers.title')}
        addLabel={t('customize.triggers.add')}
        onAdd={busy || capability === null ? undefined : () => setDialog({ kind: 'add' })}
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
              renderItem={(r) => {
                const instance = instanceOf(r.blockId)
                return (
                  <TriggerRowCard
                    row={r}
                    disabled={busy}
                    maxOnForSeconds={Math.min(
                      ON_FOR_MAX_SECONDS,
                      switchRunLimitOf(device.type, device.role).maxSeconds,
                    )}
                    onAction={(choice) => {
                      if (instance !== undefined) edit(instance, withRowAction(instance, choice))
                    }}
                    onOnFor={(seconds) => {
                      if (instance !== undefined) edit(instance, withRowOnFor(instance, seconds))
                    }}
                    onEnabled={(enabled) => {
                      if (instance !== undefined) setDraft((d) => withEnabled(d, instance, enabled))
                    }}
                    onEdit={() => setDialog({ kind: 'edit', row: r })}
                    onRemove={() => unlink(r)}
                  />
                )
              }}
              searchPlaceholder={t('customize.assign.search')}
              emptyLabel={t('customize.assign.none')}
            />
          )}
        </li>
      </AssignmentSection>
      <FormSaveBar
        pendingCount={ops.length}
        saving={busy}
        onSave={() => void saveAll()}
        onDiscard={() => {
          setRefusal(null)
          setDraft(EMPTY_DRAFT)
        }}
      />
      {dialog !== null && (
        <TriggerDialog
          title={
            dialog.kind === 'add'
              ? t('customize.triggers.addTitle')
              : t('customize.triggers.editTitle', {
                  name: dialog.row.name ?? `#${String(dialog.row.deviceId)}`,
                })
          }
          candidates={candidates}
          kindOf={kindOf}
          initial={dialog.kind === 'edit' ? initialOf(dialog.row) : null}
          busy={busy}
          onSave={saveDialog}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}
