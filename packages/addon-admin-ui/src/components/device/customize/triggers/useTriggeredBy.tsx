/**
 * "Triggered by", as rows of the Customize table: the linked triggers that
 * command this device, one row per source device. A row is stored as an
 * automation made from the built-in linked-trigger template; this hook is the
 * only place such an automation is created, changed or deleted. Every edit
 * lands in a local draft ({@link TriggerDraft}); Save writes the
 * {@link draftOps} once, each write carrying the stamp it read (D1098), and
 * Discard drops the draft. The table renders {@link TriggeredByState.lines}
 * through the cells of `TriggerRowCells`.
 */
import {
  builtinAutomationTemplate,
  type DeviceInfo,
  LINKED_TRIGGER_TEMPLATE_ID,
  type LinkedTriggerParams,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  ON_FOR_MAX_SECONDS,
  switchRunLimitOf,
  type TemplateInstance,
} from '@camstack/types'
import {
  deviceTypeMetaOf,
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
import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EVENT_EMITTER_CAP } from '../../../../pages/build/automation/fired-model'
import { expandInstance } from '../../../../pages/build/templates/template-values'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { useCapIndex } from '../assignments/use-cap-index'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { useDraftSection } from '../customize-draft'
import type { Known } from '../known'
import { useConfirmRemove } from '../use-confirm-remove'
import {
  commandCapOf,
  editPickOf,
  LINKED_TRIGGER_COMMAND_CAPS,
  MOTION_CAP,
  newTriggerParams,
  rowSourceKindOf,
  sourceKindOf,
  type TriggerActionChoice,
  type TriggerRow,
  triggerRows,
  type TriggerSourceKind,
  withConditions,
  withoutRow,
  withRowAction,
  withRowOnFor,
  withRowSource,
} from './linked-triggers-model'
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

/** A source device's trigger as the table shows it: the stored row plus what the fleet knows of the source. */
export interface TriggerTableRow extends TriggerRow {
  readonly name: string | null
  readonly detail: string | null
  readonly type: string | null
}

export type TriggerNoticeTone = 'warning' | 'danger'

export type TriggerTableLine =
  | { readonly kind: 'triggerSection' }
  | { readonly kind: 'triggerPending' }
  | { readonly kind: 'triggerEmpty' }
  | { readonly kind: 'triggerNotice'; readonly message: string; readonly tone: TriggerNoticeTone }
  | { readonly kind: 'triggerEntry'; readonly row: TriggerTableRow }

export function isTriggerLine(line: { readonly kind: string }): line is TriggerTableLine {
  return (
    line.kind === 'triggerSection' ||
    line.kind === 'triggerPending' ||
    line.kind === 'triggerEmpty' ||
    line.kind === 'triggerNotice' ||
    line.kind === 'triggerEntry'
  )
}

export interface TriggeredByState {
  /** Nothing while this device cannot be commanded and has no trigger. */
  readonly lines: readonly TriggerTableLine[]
  /** The device can be commanded and the triggers are read: "+ Add" offers a trigger. */
  readonly canAdd: boolean
  readonly busy: boolean
  /** The most the target may be held on for. */
  readonly maxOnForSeconds: number
  readonly openAdd: () => void
  readonly openEdit: (row: TriggerTableRow) => void
  readonly setAction: (row: TriggerTableRow, choice: TriggerActionChoice) => void
  readonly setOnFor: (row: TriggerTableRow, seconds: number) => void
  readonly setEnabled: (row: TriggerTableRow, enabled: boolean) => void
  /** Asks first, then drops the source from the draft. */
  readonly unlink: (row: TriggerTableRow) => void
  readonly dialog: ReactNode
}

/** What an edit of a stored trigger writes: its code, nothing else. */
interface TriggerCodePatch {
  readonly code: string | undefined
}

type TriggerDialogState =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly row: TriggerTableRow }

/** What a source device may carry: events it fires, or motion it reports. A camera needs neither. */
const SOURCE_CAPS: readonly string[] = [EVENT_EMITTER_CAP, MOTION_CAP]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The stamp a write on `blockId` carries. A block this table did not read is refused, never written blind. */
function stampOf(
  stamps: ReadonlyMap<string, number>,
  blockId: string,
  notRead: string,
): { readonly expectedUpdatedAt: number } {
  const stamp = stamps.get(blockId)
  if (stamp === undefined) throw new Error(notRead)
  return { expectedUpdatedAt: stamp }
}

export function useTriggeredBy(device: DeviceInfo): TriggeredByState {
  const { t } = useTranslation()
  const uiText = useUiText()
  const nameIndex = useDeviceNameIndex()
  const nameNouns = useDeviceNameNouns()
  const [draft, setDraft] = useState<TriggerDraft>(EMPTY_DRAFT)
  /** The one dialog: absent, a new trigger, or the row being edited. */
  const [dialogState, setDialogState] = useState<TriggerDialogState | null>(null)
  const confirmRemove = useConfirmRemove()
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
  const fleet = useCandidateDevices(dialogState !== null || shown)
  const sourceCaps = useCapIndex(SOURCE_CAPS, dialogState !== null)
  const create = useCoreBlocksCreate()
  const update = useCoreBlocksUpdate()
  const remove = useCoreBlocksDelete()
  const setEnabledMutation = useCoreBlocksSetEnabled()

  const capability =
    commandCaps.kind === 'known' ? commandCapOf(commandCaps.value.get(device.id) ?? []) : null
  const ops = draftOps(stored, draft)
  const saveRef = useRef<() => Promise<string | null>>(async () => null)
  useDraftSection('triggers', {
    label: t('customize.triggers.title'),
    pendingCount: ops.length,
    save: () => saveRef.current(),
    discard: () => {
      setRefusal(null)
      setDraft(EMPTY_DRAFT)
    },
  })

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
  const rows: readonly TriggerTableRow[] = (read?.rows ?? []).map((row) => {
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
    (read?.rows ?? []).flatMap((r) =>
      dialogState?.kind === 'edit' && dialogState.row.key === r.key ? [] : [r.deviceId],
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
  const saveAll = async (): Promise<string | null> => {
    if (busy) return t('customize.saveInFlight')
    setBusy(true)
    setRefusal(null)
    try {
      // Each write names the stamp it read and hands the next write on the same block the
      // stamp it returned (D1098): an edit followed by a toggle is two writes of one block.
      const stamps = new Map<string, number>(stored.map((i) => [i.blockId, i.updatedAt]))
      for (const op of ops) {
        if (op.kind === 'delete') {
          await remove.mutateAsync({
            blockId: op.blockId,
            ...stampOf(stamps, op.blockId, t('customize.triggers.notRead')),
          })
        } else if (op.kind === 'update') {
          const saved = await update.mutateAsync({
            blockId: op.instance.blockId,
            block: codeOf(op.instance),
            ...stampOf(stamps, op.instance.blockId, t('customize.triggers.notRead')),
          })
          stamps.set(op.instance.blockId, saved.block.updatedAt)
        } else if (op.kind === 'enable') {
          const saved = await setEnabledMutation.mutateAsync({
            blockId: op.blockId,
            enabled: op.enabled,
            ...stampOf(stamps, op.blockId, t('customize.triggers.notRead')),
          })
          stamps.set(op.blockId, saved.block.updatedAt)
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
      return null
    } catch (err: unknown) {
      await instances.refetch()
      return messageOf(err)
    } finally {
      setBusy(false)
    }
  }

  saveRef.current = saveAll

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
      updatedAt: 0,
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
    const open = dialogState
    setDialogState(null)
    if (open?.kind === 'add') addTrigger(result)
    else if (open?.kind === 'edit') editTrigger(open.row, result)
  }

  const unlink = (row: TriggerTableRow): void => {
    const instance = instanceOf(row.blockId)
    if (instance === undefined) return
    void confirmRemove(row.name ?? `#${String(row.deviceId)}`, false).then((accepted) => {
      if (accepted) setDraft((d) => withRemoval(d, instance, withoutRow(instance, row.deviceId)))
    })
  }

  // A device nothing can command lists the section only for triggers it already has.
  const visible = capability !== null || shown
  const notices: readonly TriggerTableLine[] = [
    ...(fleet.kind === 'unknown'
      ? [
          {
            kind: 'triggerNotice' as const,
            tone: 'warning' as const,
            message: t('customize.assign.devicesUnreadable', { reason: fleet.reason }),
          },
        ]
      : []),
    ...(read !== null && read.unreadable.length > 0
      ? [
          {
            kind: 'triggerNotice' as const,
            tone: 'warning' as const,
            message: t('customize.triggers.unreadable', {
              names: read.unreadable.map((u) => u.name).join(', '),
            }),
          },
        ]
      : []),
    ...(refusal === null
      ? []
      : [{ kind: 'triggerNotice' as const, tone: 'danger' as const, message: refusal }]),
  ]
  const body: readonly TriggerTableLine[] =
    read === null
      ? [
          instances.status === 'error'
            ? {
                kind: 'triggerNotice',
                tone: 'warning',
                message: t('customize.assign.unknown', { reason: instances.error.message }),
              }
            : { kind: 'triggerPending' },
        ]
      : [
          ...notices,
          ...(rows.length === 0
            ? [{ kind: 'triggerEmpty' as const }]
            : rows.map((row) => ({ kind: 'triggerEntry' as const, row }))),
        ]
  const lines: readonly TriggerTableLine[] = visible ? [{ kind: 'triggerSection' }, ...body] : []

  return {
    lines,
    canAdd: visible && read !== null && capability !== null && !busy,
    busy,
    maxOnForSeconds: Math.min(
      ON_FOR_MAX_SECONDS,
      switchRunLimitOf(device.type, device.role).maxSeconds,
    ),
    openAdd: () => setDialogState({ kind: 'add' }),
    openEdit: (row) => setDialogState({ kind: 'edit', row }),
    setAction: (row, choice) => {
      const instance = instanceOf(row.blockId)
      if (instance !== undefined) edit(instance, withRowAction(instance, choice))
    },
    setOnFor: (row, seconds) => {
      const instance = instanceOf(row.blockId)
      if (instance !== undefined) edit(instance, withRowOnFor(instance, seconds))
    },
    setEnabled: (row, enabled) => {
      const instance = instanceOf(row.blockId)
      if (instance !== undefined) setDraft((d) => withEnabled(d, instance, enabled))
    },
    unlink,
    dialog:
      dialogState === null ? null : (
        <TriggerDialog
          title={
            dialogState.kind === 'add'
              ? t('customize.triggers.addTitle')
              : t('customize.triggers.editTitle', {
                  name: dialogState.row.name ?? `#${String(dialogState.row.deviceId)}`,
                })
          }
          candidates={candidates}
          kindOf={kindOf}
          initial={dialogState.kind === 'edit' ? initialOf(dialogState.row) : null}
          busy={busy}
          onSave={saveDialog}
          onClose={() => setDialogState(null)}
        />
      ),
  }
}
