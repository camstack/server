/**
 * Shared action sequences — named step lists rules and notification buttons
 * bind to by id. CRUD against `notificationRules.listSequences` / create /
 * update / delete.
 *
 * Managed list: DataTable + ItemFormDialog; open state in the URL via
 * `useItemFormUrl` (`?new=1` / `?sequence=<id>`), same contract as Scripts /
 * Automations.
 *
 * A Do step may multi-select same-family devices in the picker; the wire
 * schema stays one `deviceId` per `cap` step, so consecutive identical
 * cap/method/args rows are collapsed for editing and expanded on change
 * (same pattern as rule Do bindings).
 */

import type { NcRuleAction, NcSharedSequence } from '@camstack/types'
import {
  Button,
  ErrorBox,
  Input,
  ItemFormDialog,
  Select,
  useDeviceManagerListAll,
  useItemFormUrl,
  useNotificationRulesCreateSequence,
  useNotificationRulesDeleteSequence,
  useNotificationRulesListSequences,
  useNotificationRulesUpdateSequence,
  type DataColumn,
  type DeviceFleetView,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ListOrdered, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DeviceDoActionFields } from '../../components/device-do-action/DeviceDoActionFields'
import { AdminPage } from '../../components/AdminPage'
import { fleetViewOf } from './device-fleet-view'
import { collapseCapGroup, expandCapActions } from './NotificationRuleActions'
import { newStep } from './notification-rule-actions'
import {
  NcListDeleteButton,
  NcListEmpty,
  NcListLoading,
  NcListNameCell,
  NcListRowControls,
  NcListTable,
} from './notification-list-chrome'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const FIELD = 'mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs'
const LABEL = 'block text-[11px] font-medium text-foreground'
const STEP_KIND_OPTIONS = [
  { value: 'cap', labelKey: 'system.notificationSequences.stepDo' },
  { value: 'wait', labelKey: 'system.notificationSequences.stepWait' },
] as const
const SEQ_QUERY = [['notificationRules', 'listSequences']] as const

/** Query keys cleared when leaving the Sequences tab (`AdminTabs.ownedParams`). */
export const SEQUENCES_TAB_OWNED_PARAMS = ['sequence', 'new'] as const

interface SequenceDraft {
  readonly id?: string
  readonly name: string
  readonly minDelaySec: string
  readonly actions: NcRuleAction[]
}

interface SequenceDeviceOption {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly location: string | null
}

interface SequenceCard {
  readonly start: number
  readonly kind: 'wait' | 'cap'
  readonly length: number
}

interface SequenceStepRowProps {
  readonly step: Extract<NcRuleAction, { kind: 'wait' }>
  readonly devices: readonly SequenceDeviceOption[]
  readonly listState: DeviceFleetView['state']
  readonly fleet: DeviceFleetView
  readonly onChange: (next: NcRuleAction) => void
  readonly onRemove: () => void
}

interface SequenceFormBodyProps {
  readonly draft: SequenceDraft
  readonly devices: readonly SequenceDeviceOption[]
  readonly fleetView: DeviceFleetView
  readonly onChange: (next: SequenceDraft) => void
}

function emptyDraft(): SequenceDraft {
  return { name: '', minDelaySec: '', actions: [newStep()] }
}

function fromSequence(sequence: NcSharedSequence): SequenceDraft {
  return {
    id: sequence.id,
    name: sequence.name,
    minDelaySec: sequence.minDelaySec !== undefined ? String(sequence.minDelaySec) : '',
    actions: [...sequence.actions],
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Walk sequence steps collapsing consecutive same-family Do groups into one card. */
function sequenceCards(actions: readonly NcRuleAction[]): readonly SequenceCard[] {
  const cards: SequenceCard[] = []
  let i = 0
  while (i < actions.length) {
    const step = actions[i]!
    if (step.kind === 'wait') {
      cards.push({ start: i, kind: 'wait', length: 1 })
      i += 1
      continue
    }
    const group = collapseCapGroup(actions, i)
    cards.push({ start: i, kind: 'cap', length: group.length })
    i += group.length
  }
  return cards
}

function sequenceStepsLabel(sequence: NcSharedSequence): string {
  const steps = sequence.actions.length
  return sequence.minDelaySec !== undefined
    ? i18n.t('system.notificationSequences.stepsDelay', {
        count: steps,
        delay: sequence.minDelaySec,
      })
    : i18n.t('system.notificationSequences.stepsLabel', { count: steps })
}

function SequenceFormBody({ draft, devices, fleetView, onChange }: SequenceFormBodyProps) {
  const { t } = useTranslation()
  const cards = sequenceCards(draft.actions)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className={LABEL}>{t('system.notificationSequences.name', 'Name')}</label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </div>
        <div className="w-28">
          <label className={LABEL}>
            {t('system.notificationSequences.minDelayS', 'Min delay (s)')}
          </label>
          <input
            type="number"
            min={0}
            className={FIELD}
            value={draft.minDelaySec}
            onChange={(e) => onChange({ ...draft, minDelaySec: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-2 border-l-2 border-border-subtle pl-3">
        {cards.map((card) => {
          const step = draft.actions[card.start]!
          if (card.kind === 'wait' && step.kind === 'wait') {
            return (
              <SequenceStepRow
                key={`s-${String(card.start)}`}
                step={step}
                devices={devices}
                listState={fleetView.state}
                fleet={fleetView}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    actions: draft.actions.map((a, i) => (i === card.start ? next : a)),
                  })
                }
                onRemove={() =>
                  onChange({
                    ...draft,
                    actions: draft.actions.filter((_, i) => i !== card.start),
                  })
                }
              />
            )
          }
          const group = collapseCapGroup(draft.actions, card.start)
          return (
            <div key={`s-${String(card.start)}`} className="flex flex-wrap items-start gap-2">
              <div className="w-24">
                <label className={LABEL}>{t('system.notificationSequences.step', 'Step')}</label>
                <Select
                  className={FIELD}
                  value="cap"
                  options={STEP_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  onChange={(e) => {
                    if (e.target.value !== 'wait') return
                    onChange({
                      ...draft,
                      actions: [
                        ...draft.actions.slice(0, card.start),
                        { kind: 'wait', seconds: 5 },
                        ...draft.actions.slice(card.start + card.length),
                      ],
                    })
                  }}
                />
              </div>
              <DeviceDoActionFields
                value={group.wire}
                devices={devices}
                listState={fleetView.state}
                fleet={fleetView}
                allowMultiSameFamily
                onChange={(wire) => {
                  const expanded = expandCapActions(wire)
                  onChange({
                    ...draft,
                    actions: [
                      ...draft.actions.slice(0, card.start),
                      ...expanded,
                      ...draft.actions.slice(card.start + card.length),
                    ],
                  })
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                type="button"
                title={t('common.remove', 'Remove')}
                onClick={() =>
                  onChange({
                    ...draft,
                    actions: [
                      ...draft.actions.slice(0, card.start),
                      ...draft.actions.slice(card.start + card.length),
                    ],
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )
        })}
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => onChange({ ...draft, actions: [...draft.actions, newStep()] })}
        >
          <Plus className="h-3.5 w-3.5" /> {t('common.step')}
        </Button>
      </div>
    </div>
  )
}

export interface NotificationSequencesPageProps {
  /** Page-header New sequence — open the editor once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
  /** When true, New sequence lives on the Notifications header. */
  readonly headerOwnsCreate?: boolean
}

export function NotificationSequencesPage({
  createRequested = false,
  onCreateConsumed,
  headerOwnsCreate = false,
}: NotificationSequencesPageProps = {}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useNotificationRulesListSequences({})
  const create = useNotificationRulesCreateSequence()
  const update = useNotificationRulesUpdateSequence()
  const del = useNotificationRulesDeleteSequence()
  const {
    state: formState,
    openNew,
    openEdit,
    close: closeForm,
  } = useItemFormUrl({ editKey: 'sequence', newKey: 'new' })
  const [draft, setDraft] = useState<SequenceDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!createRequested) return
    setSaveError(null)
    openNew()
    onCreateConsumed?.()
    // Intentionally only react to the page-header request pulse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequested])
  const fleetQuery = useDeviceManagerListAll({ projection: 'slim' })
  const fleetView = fleetViewOf(fleetQuery)
  const devices = useMemo(
    (): readonly SequenceDeviceOption[] =>
      (fleetQuery.data ?? [])
        .map((d) => ({
          id: d.id,
          name: d.name,
          type: String(d.type),
          location: d.location ?? null,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [fleetQuery.data],
  )

  const sequences = list.data?.sequences ?? []
  const knowsThereAreNone = list.data !== undefined && sequences.length === 0
  const editingOpen = formState.mode !== 'closed'
  const saving = create.isPending || update.isPending

  // URL owns open/closed; draft is local so a list refetch does not wipe edits.
  useEffect(() => {
    if (formState.mode === 'closed') {
      setDraft(null)
      setSaveError(null)
      return
    }
    if (formState.mode === 'new') {
      setDraft((prev) => (prev !== null && prev.id === undefined ? prev : emptyDraft()))
      return
    }
    const sequence = sequences.find((s) => s.id === formState.id)
    if (sequence === undefined) return
    setDraft((prev) => (prev?.id === formState.id ? prev : fromSequence(sequence)))
  }, [formState, sequences])

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: SEQ_QUERY })
  }

  const closeEditor = (): void => {
    create.reset()
    update.reset()
    setSaveError(null)
    setDraft(null)
    closeForm()
  }

  const save = async (): Promise<void> => {
    if (draft === null || draft.name.trim() === '' || draft.actions.length === 0) return
    const body = {
      name: draft.name.trim(),
      ...(draft.minDelaySec !== '' ? { minDelaySec: Number(draft.minDelaySec) } : {}),
      actions: draft.actions,
    }
    try {
      if (draft.id !== undefined) {
        await update.mutateAsync({ sequenceId: draft.id, sequence: body })
      } else {
        await create.mutateAsync({ sequence: body })
      }
      closeEditor()
      invalidate()
    } catch (err: unknown) {
      setSaveError(errorMessage(err))
    }
  }

  const columns: DataColumn<NcSharedSequence>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('system.notificationSequences.name', 'Name'),
        nowrap: false,
        sortValue: (sequence) => sequence.name,
        render: (sequence) => (
          <NcListNameCell
            name={sequence.name}
            enabled
            onOpen={() => openEdit(sequence.id)}
            openTestId={`sequence-open-${sequence.id}`}
          />
        ),
      },
      {
        key: 'steps',
        header: t('system.notificationSequences.steps', 'Steps'),
        nowrap: true,
        sortValue: (sequence) => sequence.actions.length,
        render: (sequence) => (
          <span className="text-[11px] text-foreground-subtle">{sequenceStepsLabel(sequence)}</span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        nowrap: true,
        notSortableReason: 'Row actions',
        render: (sequence) => (
          <NcListRowControls className="flex items-center justify-end gap-1">
            <Button size="sm" variant="ghost" type="button" onClick={() => openEdit(sequence.id)}>
              {t('common.edit', 'Edit')}
            </Button>
            <NcListDeleteButton
              pending={del.isPending}
              title={t('system.notificationSequences.deleteThisSequence', 'Delete this sequence?')}
              message={t(
                'system.notificationSequences.willBeRemovedRulesAnd',
                '“{{name}}” will be removed. Rules and buttons that bind to it keep the id until you re-point them.',
                { name: sequence.name },
              )}
              ariaLabel={t('system.notificationSequences.delete', 'Delete {{name}}', {
                name: sequence.name,
              })}
              testId={`sequence-delete-${sequence.id}`}
              onConfirm={() => {
                void del.mutateAsync({ sequenceId: sequence.id }).then(invalidate)
              }}
            />
          </NcListRowControls>
        ),
      },
    ],
    [del, openEdit, t],
  )

  return (
    <AdminPage
      embedded
      icon={ListOrdered}
      title={t('system.notificationSequences.sequences', 'Sequences')}
      subtitle={t(
        'system.notificationSequences.namedStepListsSharedBy',
        'Named step lists shared by notification rules and buttons. A rule binds to one by id; two rules sharing a gate share its throttle.',
      )}
    >
      {!headerOwnsCreate ? (
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            type="button"
            onClick={() => {
              setSaveError(null)
              openNew()
            }}
          >
            <Plus className="h-3.5 w-3.5" /> {t('system.notificationSequences.newSequence')}
          </Button>
        </div>
      ) : null}
      {list.error != null && (
        <ErrorBox
          title={t(
            'system.notificationSequences.couldNotReadSequences',
            'Could not read sequences',
          )}
          message={errorMessage(list.error)}
          onRetry={() => void list.refetch()}
        />
      )}

      {list.isPending && <NcListLoading />}

      {knowsThereAreNone && (
        <NcListEmpty testId="sequences-empty">
          {t(
            'system.notificationSequences.noSequencesYetCreateOne',
            "No sequences yet. Create one, then bind it from a rule's Actions tab.",
          )}
        </NcListEmpty>
      )}

      {sequences.length > 0 && (
        <NcListTable
          columns={columns}
          rows={sequences}
          rowKey={(s) => s.id}
          minWidthPx={480}
          onRowClick={(sequence) => openEdit(sequence.id)}
        />
      )}

      <ItemFormDialog
        open={editingOpen && draft !== null}
        onClose={closeEditor}
        title={
          draft?.id !== undefined
            ? t('system.notificationSequences.edit', 'Edit {{value1}}', {
                value1: draft.name || 'sequence',
              })
            : t('system.notificationSequences.newSequence', 'New sequence')
        }
        icon={ListOrdered}
        width="xl"
        error={saveError}
        testId="sequence-editor-panel"
        footer={
          <Button
            size="sm"
            type="button"
            disabled={
              saving || draft === null || draft.name.trim() === '' || draft.actions.length === 0
            }
            onClick={() => void save()}
          >
            {saving
              ? t('system.notificationSequences.saving', 'Saving…')
              : t('common.save', 'Save')}
          </Button>
        }
      >
        {draft !== null && (
          <SequenceFormBody
            draft={draft}
            devices={devices}
            fleetView={fleetView}
            onChange={setDraft}
          />
        )}
      </ItemFormDialog>

      {del.error != null && <ErrorBox message={errorMessage(del.error)} />}
    </AdminPage>
  )
}

function SequenceStepRow({
  step,
  devices,
  listState,
  fleet,
  onChange,
  onRemove,
}: SequenceStepRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-start gap-2">
      <div className="w-24">
        <label className={LABEL}>{t('system.notificationSequences.step', 'Step')}</label>
        <Select
          className={FIELD}
          value="wait"
          options={STEP_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          onChange={(e) =>
            onChange(
              e.target.value === 'wait'
                ? { kind: 'wait', seconds: step.seconds }
                : { kind: 'cap', deviceId: devices[0]?.id ?? 0, cap: '', method: '' },
            )
          }
        />
      </div>
      <div className="w-28">
        <label className={LABEL}>{t('system.notificationSequences.seconds', 'Seconds')}</label>
        <input
          type="number"
          min={0}
          max={300}
          className={FIELD}
          value={step.seconds}
          onChange={(e) => onChange({ kind: 'wait', seconds: Number(e.target.value) })}
        />
      </div>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        onClick={onRemove}
        title={t('common.remove', 'Remove')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

export default NotificationSequencesPage
