/**
 * One method a built capability serves (D967): its method name, the forward
 * that serves it, and an inline editor — the source device from the shared
 * picker (suggestions only, the operator picks, D356), then the source cap
 * and mutation, then the optional args template. The validator's refusals
 * are shown by code on the row they concern.
 */
import {
  type CapabilityDefinition,
  compositionSourceKey,
  type CompositionFieldsFeature,
  type CompositionForwardCommand,
  type CompositionProblem,
} from '@camstack/types'
import { Button, Select } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceBoundCaps } from '../device-do-action/use-device-bound-caps'
import type {
  AssignmentCandidate,
  CandidateDevice,
} from '../device/customize/assignments/assignment-candidates'
import { CustomizeDevicePickerDialog } from '../device/customize/assignments/CustomizeDevicePickerDialog'
import type { RoomSuggestions } from '../device/customize/assignments/room-suggestions'
import type { Known } from '../device/customize/known'
import type { CustomizationSaveOutcome } from '../device/customize/use-customization'
import { vocabularyCapTitle } from '../device/customize/vocabulary-field-label'
import {
  capabilityDefOf,
  type CommandRow,
  commandOfDraft,
  EMPTY_ROW_DRAFT,
  forwardableCaps,
  forwardableMethods,
  inputFieldsOf,
  type RowDraft,
  rowDraftOf,
  rowProblems,
} from './command-model'
import { fleetRowOf } from './command-sources'
import { ForwardArgsEditor } from './ForwardArgsEditor'
import { type RefusalLine, refusalFromMessage, refusalLines } from './helper-form-model'
import { RefusalList } from './RefusalList'

export interface CommandRowEditorProps {
  readonly def: CapabilityDefinition
  readonly feature: CompositionFieldsFeature
  readonly featureIndex: number
  readonly row: CommandRow
  /** The item's label, for a reset row. */
  readonly itemLabel: string | null
  readonly fleet: Known<readonly CandidateDevice[]>
  readonly names: ReadonlyMap<string, string>
  readonly candidates: Known<readonly AssignmentCandidate[]>
  readonly room: RoomSuggestions | null
  readonly saving: boolean
  readonly onApply: (
    row: CommandRow,
    command: CompositionForwardCommand | null,
  ) => Promise<CustomizationSaveOutcome>
}

function problemLines(problems: readonly CompositionProblem[]): readonly RefusalLine[] {
  return refusalLines(problems)
}

export function CommandRowEditor(props: CommandRowEditorProps): ReactNode {
  const { t } = useTranslation()
  const { def, feature, featureIndex, row, itemLabel, names, saving, onApply } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<RowDraft>(EMPTY_ROW_DRAFT)
  const [serverLines, setServerLines] = useState<readonly RefusalLine[]>([])
  const sourceName = (command: CompositionForwardCommand): string =>
    names.get(compositionSourceKey(command.source)) ?? command.source.stableId
  const stored = problemLines(rowProblems(def, feature, featureIndex, row, row.command))
  const label =
    row.kind === 'reset' ? t('commands.resetOf', { item: itemLabel ?? row.itemKey }) : row.method

  const open = (): void => {
    setDraft(rowDraftOf(row.command))
    setServerLines([])
    setEditing(true)
  }
  const remove = (): void => {
    void onApply(row, null).then((outcome) => {
      if (outcome.kind === 'refused') setServerLines(refusalFromMessage(outcome.reason))
    })
  }

  return (
    <li
      className="flex flex-col gap-2 border-b border-border-subtle pb-3 last:border-b-0 last:pb-0"
      data-testid={`command-row-${row.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs text-foreground break-words">{label}</div>
          <div className="text-[11px] text-foreground-muted break-words">
            {row.command === null
              ? t('commands.none')
              : t('commands.calls', {
                  device: sourceName(row.command),
                  call: `${row.command.cap}.${row.command.method}`,
                })}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={saving} onClick={open}>
              {row.command === null ? t('commands.set') : t('commands.change')}
            </Button>
            {row.command !== null && (
              <Button variant="ghost" size="sm" disabled={saving} onClick={remove}>
                {t('commands.remove')}
              </Button>
            )}
          </div>
        )}
      </div>
      <RefusalList lines={stored} testId={`command-refusals-${row.id}`} />
      {!editing && <RefusalList lines={serverLines} testId={`command-server-${row.id}`} />}
      {editing && (
        <RowEditor
          {...props}
          draft={draft}
          onDraft={setDraft}
          serverLines={serverLines}
          onClose={() => setEditing(false)}
          onServerLines={setServerLines}
        />
      )}
    </li>
  )
}

interface RowEditorProps extends CommandRowEditorProps {
  readonly draft: RowDraft
  readonly onDraft: (draft: RowDraft) => void
  readonly serverLines: readonly RefusalLine[]
  readonly onClose: () => void
  readonly onServerLines: (lines: readonly RefusalLine[]) => void
}

function RowEditor({
  def,
  feature,
  featureIndex,
  row,
  fleet,
  names,
  candidates,
  room,
  saving,
  onApply,
  draft,
  onDraft,
  serverLines,
  onClose,
  onServerLines,
}: RowEditorProps): ReactNode {
  const { t, i18n } = useTranslation()
  const [picking, setPicking] = useState(false)
  const deviceRow =
    draft.source === null || fleet.kind !== 'known' ? null : fleetRowOf(fleet.value, draft.source)
  const bound = useDeviceBoundCaps(deviceRow?.id ?? 0)
  const capOptions = forwardableCaps(bound.data ?? [])
  const cap =
    draft.cap !== '' ? draft.cap : capOptions.length === 1 ? (capOptions[0]?.name ?? '') : ''
  const sourceDef = cap === '' ? null : capabilityDefOf(cap)
  const methods = sourceDef === null ? [] : forwardableMethods(sourceDef)
  const method = draft.method !== '' ? draft.method : methods.length === 1 ? (methods[0] ?? '') : ''
  const effective: RowDraft = { ...draft, cap, method }
  const command = commandOfDraft(effective)
  const problems = problemLines(rowProblems(def, feature, featureIndex, row, command))
  const sourceFields = sourceDef === null || method === '' ? [] : inputFieldsOf(sourceDef, method)
  const builtFields =
    row.kind === 'reset' ? [] : inputFieldsOf(def, row.method).map((field) => field.name)
  const sourceLabel =
    draft.source === null
      ? t('commands.noDevice')
      : (names.get(compositionSourceKey(draft.source)) ?? draft.source.stableId)
  const capLabel = (name: string): string => vocabularyCapTitle(name, i18n.language)

  const apply = (): void => {
    if (command === null) return
    void onApply(row, command).then((outcome) => {
      if (outcome.kind === 'refused') onServerLines(refusalFromMessage(outcome.reason))
      else onClose()
    })
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border-subtle bg-background-elevated p-2 sm:p-3"
      data-testid={`command-editor-${row.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-foreground-muted">{t('commands.source')}</span>
        <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
          {draft.source === null ? t('commands.chooseDevice') : sourceLabel}
        </Button>
      </div>
      {draft.source !== null && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PickField label={t('commands.cap')}>
            {bound.isLoading ? (
              <span role="status" className="text-[11px] text-foreground-subtle">
                {t('commands.loadingCaps')}
              </span>
            ) : capOptions.length === 0 ? (
              <span className="text-[11px] text-warning">{t('commands.noCaps')}</span>
            ) : capOptions.length === 1 ? (
              <span className="text-xs text-foreground">{capLabel(capOptions[0]?.name ?? '')}</span>
            ) : (
              <Select
                aria-label={t('commands.cap')}
                value={cap}
                onChange={(event) =>
                  onDraft({ ...draft, cap: event.target.value, method: '', args: undefined })
                }
                options={[
                  { value: '', label: t('commands.pickCap') },
                  ...capOptions.map((c) => ({ value: c.name, label: capLabel(c.name) })),
                ]}
              />
            )}
          </PickField>
          {sourceDef !== null && (
            <PickField label={t('commands.method')}>
              {methods.length === 1 ? (
                <span className="font-mono text-xs text-foreground">{methods[0]}</span>
              ) : (
                <Select
                  aria-label={t('commands.method')}
                  value={method}
                  onChange={(event) =>
                    onDraft({ ...draft, cap, method: event.target.value, args: undefined })
                  }
                  options={[
                    { value: '', label: t('commands.pickMethod') },
                    ...methods.map((m) => ({ value: m, label: m })),
                  ]}
                />
              )}
            </PickField>
          )}
        </div>
      )}
      {method !== '' && (
        <ForwardArgsEditor
          testId={`command-args-${row.id}`}
          builtFields={builtFields}
          sourceFields={sourceFields}
          args={draft.args}
          onChange={(args) => onDraft({ ...draft, cap, method, args })}
        />
      )}
      <RefusalList lines={problems} testId={`command-draft-refusals-${row.id}`} />
      <RefusalList lines={serverLines} testId={`command-server-${row.id}`} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={command === null || problems.length > 0 || saving}
          onClick={apply}
        >
          {t('commands.apply')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('commands.cancel')}
        </Button>
      </div>
      <CustomizeDevicePickerDialog
        open={picking}
        title={t('commands.pickTitle', { method: row.method })}
        selection="single"
        candidates={candidates}
        room={room}
        confirmLabel={() => t('commands.pickConfirm')}
        onConfirm={(picked) => {
          const chosen = picked[0]
          setPicking(false)
          if (chosen !== undefined)
            onDraft({ source: chosen.ref, cap: '', method: '', args: undefined })
        }}
        onClose={() => setPicking(false)}
      />
      <span hidden>{names.size}</span>
    </div>
  )
}

function PickField({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-foreground-muted">
      {label}
      {children}
    </label>
  )
}
