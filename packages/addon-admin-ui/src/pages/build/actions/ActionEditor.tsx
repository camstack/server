/**
 * The Action editor: name, variables, ordered steps, and the Runs panel.
 *
 * An internal action is edited here and saved through `actions.create` /
 * `actions.update`; an action an addon declares is shown read-only (its steps
 * live in the addon) with Run and its runs. The draft goes out only through
 * `checkDraft`, the same schema parse the hub applies.
 */

import {
  type ActionEntry,
  type ActionStep,
  type AutomationAction,
  type AutomationRunTrace,
} from '@camstack/types'
import {
  Badge,
  Button,
  ErrorBox,
  Input,
  useActionsCreate,
  useActionsDelete,
  useActionsGetTraces,
  useActionsRun,
  useActionsUpdate,
  useConfirm,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ListChecks, Loader2, Play, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionList } from '../automation/ActionList'
import { useAutomationDevices } from '../automation/automation-data'
import { RunsPanel, TraceBlock } from '../flow/RunsPanel'
import { actionScopeVariables } from '../flow/scope-variables'
import { traceView } from '../flow/trace-view'
import {
  type ActionDraft,
  checkDraft,
  type DraftProblem,
  draftOf,
  renameVariable,
} from './action-draft'
import { VariablesSection } from './VariablesSection'

const POLL_MS = 5_000

export interface ActionEditorProps {
  /** `null` while creating. */
  readonly entry: ActionEntry | null
  readonly onClose: () => void
  /** Called with the id after a create, so the URL follows the saved action. */
  readonly onSaved: (actionId: string) => void
}

function isActionStep(action: AutomationAction): action is ActionStep {
  return action.kind === 'cap' || action.kind === 'wait'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useProblemText(): (problem: DraftProblem) => string {
  const { t } = useTranslation()
  return (problem) => {
    switch (problem.kind) {
      case 'name':
        return t('actions.editor.problemName', 'Give the action a name.')
      case 'no-steps':
        return t('actions.editor.problemNoSteps', 'Add at least one step.')
      case 'undeclared':
        return t(
          'actions.editor.problemUndeclared',
          'A step uses {{name}}, which is not declared under Variables.',
          { name: problem.name },
        )
      case 'duplicate':
        return t('actions.editor.problemDuplicate', 'The variable {{name}} is declared twice.', {
          name: problem.name,
        })
      case 'bad-name':
        return t(
          'actions.editor.problemBadName',
          'The variable name "{{name}}" must start with a letter and use letters, digits or _.',
          { name: problem.name },
        )
      default:
        return problem.message
    }
  }
}

export function ActionEditor({ entry, onClose, onSaved }: ActionEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const devices = useAutomationDevices()
  const problemText = useProblemText()
  const [draft, setDraft] = useState<ActionDraft>(() => draftOf(entry))
  const [runId, setRunId] = useState<string | null>(null)
  const readOnly = entry !== null && entry.readOnly

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['actions']] })
  }
  const create = useActionsCreate({
    onSuccess: (result) => {
      refresh()
      onSaved(result.action.id)
    },
  })
  const update = useActionsUpdate({ onSuccess: refresh })
  const remove = useActionsDelete({
    onSuccess: () => {
      refresh()
      onClose()
    },
  })
  const run = useActionsRun({ onSuccess: refresh })
  const traces = useActionsGetTraces(
    { actionId: entry?.id ?? 'none' },
    { enabled: entry !== null, refetchInterval: POLL_MS },
  )

  const selected: AutomationRunTrace | null =
    traces.data?.traces.find((tr) => tr.runId === runId) ?? null
  const view = useMemo(() => (selected === null ? null : traceView(selected)), [selected])
  const check = checkDraft(draft)
  const scope = useMemo(() => actionScopeVariables(draft.variables, t), [draft.variables, t])
  const saving = create.isPending || update.isPending
  const saveError = create.error ?? update.error ?? remove.error ?? run.error
  const needsInput = (entry?.variables ?? []).some(
    (v) => v.required === true && v.default === undefined,
  )

  const save = (): void => {
    if (!check.ok) return
    if (entry === null) create.mutate({ action: check.input })
    else update.mutate({ actionId: entry.id, action: check.input })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="action-editor">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ListChecks className="h-4 w-4 text-foreground-muted" />
          <Input
            aria-label={t('actions.editor.name', 'Name')}
            className="max-w-xs flex-1"
            value={draft.name}
            disabled={readOnly}
            placeholder={t('actions.editor.namePlaceholder', 'What this action does')}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Badge variant={readOnly ? 'info' : 'primary'}>
            {readOnly ? (entry?.addonId ?? '') : t('actions.source.internal', 'Internal')}
          </Badge>
        </div>

        {readOnly ? (
          <p className="rounded-md border border-border bg-surface p-3 text-sm text-foreground-muted">
            {t(
              'actions.editor.readOnly',
              'This action is declared by {{addon}}. Edit it there; you can run it from here.',
              { addon: entry?.addonId ?? '' },
            )}
          </p>
        ) : (
          <>
            <VariablesSection
              variables={draft.variables}
              onChange={(variables) => setDraft({ ...draft, variables })}
              onRename={(index, name) => setDraft(renameVariable(draft, index, name))}
            />
            <TraceBlock
              step="steps"
              title={t('actions.editor.steps', 'Steps')}
              trace={view === null ? null : view.thenBlock}
            >
              <ActionList
                actions={draft.steps}
                devices={devices}
                allowedKinds={['cap', 'wait']}
                variables={scope}
                onChange={(steps) => setDraft({ ...draft, steps: steps.filter(isActionStep) })}
              />
            </TraceBlock>
          </>
        )}

        {!check.ok && !readOnly && draft.name !== '' && (
          <p className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            {problemText(check.reason)}
          </p>
        )}
        {saveError !== null && <ErrorBox message={errorMessage(saveError)} />}

        <div className="flex flex-wrap gap-2">
          {!readOnly && (
            <Button onClick={save} disabled={saving || !check.ok}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
            </Button>
          )}
          {entry !== null && (
            <Button
              variant="outline"
              disabled={run.isPending || needsInput}
              title={
                needsInput
                  ? t(
                      'actions.editor.runNeedsDefaults',
                      'Give each required variable a default to run it from here.',
                    )
                  : undefined
              }
              onClick={() => run.mutate({ actionId: entry.id })}
            >
              <Play className="h-4 w-4" /> {t('actions.editor.runNow', 'Run now')}
            </Button>
          )}
          {entry !== null && !readOnly && (
            <Button
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                void confirm({
                  title: t('actions.editor.deleteTitle', 'Delete this action?'),
                  message: t(
                    'actions.editor.deleteMessage',
                    '{{name}} will be deleted, and removed from every camera that links it.',
                    { name: entry.name },
                  ),
                  confirmLabel: t('common.delete', 'Delete'),
                  variant: 'danger',
                }).then((accepted) => {
                  if (accepted) remove.mutate({ actionId: entry.id })
                })
              }}
            >
              <Trash2 className="h-4 w-4" /> {t('common.delete', 'Delete')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        </div>
      </div>
      <div className="order-first lg:order-last">
        <RunsPanel
          traces={entry === null ? [] : traces.data?.traces}
          selectedId={runId}
          onSelect={setRunId}
        />
      </div>
    </div>
  )
}
