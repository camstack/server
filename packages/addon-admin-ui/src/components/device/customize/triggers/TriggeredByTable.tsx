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
import { SourceSelectorDevicesDialog } from '../source-selector/SourceSelectorDevicesDialog'
import { useCapIndex } from '../assignments/use-cap-index'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import {
  commandCapOf,
  editPickOf,
  type DetectionClass,
  type FiredPick,
  LINKED_TRIGGER_COMMAND_CAPS,
  MOTION_CAP,
  newTriggerParams,
  replacesFilter,
  sourceKindOf,
  triggerRows,
  withActiveLimits,
  withoutRow,
  withRowAction,
  withRowClasses,
  withRowFilter,
  withRowOnFor,
} from './linked-triggers-model'
import { TriggerRowCard, type TriggerRowView } from './TriggerRowCard'
import { TriggerClassesDialog } from './TriggerClassesDialog'
import { TriggerFilterDialog } from './TriggerFilterDialog'
import { TriggerWindowDialog } from './TriggerWindowDialog'
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
  const stored = instances.data?.instances ?? []
  const working = workingInstances(stored, draft)
  const read = instances.data === undefined ? null : triggerRows(working)
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
          await update.mutateAsync({ blockId: op.instance.blockId, block: codeOf(op.instance) })
        } else if (op.kind === 'enable') {
          await setEnabled.mutateAsync({ blockId: op.blockId, enabled: op.enabled })
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

  const add = (picked: readonly AssignmentCandidate[]): void => {
    if (capability === null) {
      setRefusal(t('customize.triggers.notCommandable'))
      return
    }
    setRefusal(null)
    let next = draft
    for (const candidate of picked) {
      const kind = sourceKindOf(fleetById.get(candidate.deviceId)?.type ?? null, candidate.caps)
      const params =
        kind === null ? null : newTriggerParams(device.id, candidate.deviceId, capability, kind)
      if (params === null) {
        setRefusal(t('customize.triggers.notCommandable'))
        return
      }
      next = withAdded(next, {
        name: t('customize.triggers.blockName', { source: candidate.name, target: device.name }),
        enabled: true,
        templateId: LINKED_TRIGGER_TEMPLATE_ID,
        values: linkedTriggerValues(params),
      })
    }
    setDraft(next)
  }

  const unlink = (row: TriggerTableRow): void => {
    const instance = instanceOf(row.blockId)
    if (instance === undefined) return
    setDraft((d) => withRemoval(d, instance, withoutRow(instance, row.deviceId)))
  }

  const saveClasses = (row: TriggerTableRow, classes: readonly DetectionClass[]): void => {
    const instance = instanceOf(row.blockId)
    setEditing(null)
    if (instance !== undefined) edit(instance, withRowClasses(instance, row.deviceId, classes))
  }

  const saveFilter = (row: TriggerTableRow, pick: FiredPick): void => {
    const instance = instanceOf(row.blockId)
    setEditing(null)
    if (instance !== undefined) edit(instance, withRowFilter(instance, row.deviceId, pick))
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
                    onEditEvent={() => setEditing(r)}
                    onEditWindow={() => setTiming(r)}
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
      <SourceSelectorDevicesDialog
        open={picking}
        title={t('customize.triggers.pickTitle')}
        selection="multi"
        candidates={candidates}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          add(picked)
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
            if (instance !== undefined) edit(instance, withActiveLimits(instance, window, state))
          }}
          onClose={() => setTiming(null)}
        />
      )}
    </>
  )
}
