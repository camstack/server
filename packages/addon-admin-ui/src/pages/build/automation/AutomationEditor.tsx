/**
 * The vertical flow: WHEN → AND ONLY IF → THEN.
 *
 * The order is fixed and the sections cannot be reordered, because the vertical
 * axis IS the evaluation order — a trigger fires, the conditions are asked, the
 * actions run. A screen that let those three be dragged around would be
 * describing a machine that does not exist.
 *
 * **Save regenerates.** The recipe is the authored artefact; the code is
 * derived from it on every save and stored as the block's source, with the
 * recipe embedded so this editor can re-open it. Save is BLOCKED — not warned
 * about — when the recipe does not satisfy `AutomationRecipeSchema` or
 * `validateRecipeBounds`, because the generator refuses the same recipe and a
 * block stored broken fails at fork time, far from the person who wrote it.
 *
 * The bounds message is shown verbatim: it is the one that offers the De Morgan
 * rewrite, and re-wording it here would let this screen and the save path say
 * different things about the same tree.
 */

import {
  type AutomationRecipe,
  AutomationRecipeSchema,
  type CoreBlock,
  type CoreBlockInput,
  coreBlockAddonId,
  generateAutomationBlock,
  validateRecipeBounds,
} from '@camstack/types'
import { Badge, Button, Input, LogStream, useCoreBlocksGetTraces } from '@camstack/ui-library'
import { Loader2, ScrollText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActionList } from './ActionList'
import { useAutomationDevices } from './automation-data'
import { ConditionTree } from './ConditionTree'
import { GeneratedCodePanel } from './GeneratedCodePanel'
import { normalizeRecipe } from './recipe-ops'
import { prepareRecipeUnits } from './recipe-units'
import { withActions, withTriggers } from './recipe-parts'
import { TriggerEditor } from './TriggerEditor'
import { RunModeSelector, runModeOf, withRunMode } from './RunModeSelector'
import { RunsPanel, TraceBlock } from '../flow/RunsPanel'
import { triggerScopeVariables } from '../flow/scope-variables'
import { stepToneAt, traceView } from '../flow/trace-view'
import { Trans, useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

/** Blocks run on the hub only. The Scripts editor offers a node picker and then
 *  explains that anything else is stored-but-failed; an automation does not
 *  offer the choice at all, which is the same statement without the trap. */
const HUB = 'hub'
const TRACES_POLL_MS = 5_000

export interface AutomationEditorProps {
  /** `null` while creating. Re-read from the polled list by the caller so the
   *  logs pane and the eject gate follow the stored block, not a frozen copy. */
  readonly existing: CoreBlock | null
  readonly initialRecipe: AutomationRecipe
  readonly saving: boolean
  readonly saveError: string | null
  readonly ejecting: boolean
  readonly onSave: (input: CoreBlockInput) => void
  readonly onEject: () => void
  readonly onCancel: () => void
}

interface GeneratedSource {
  readonly code: string | null
  readonly error: string | null
}

export function AutomationEditor({
  existing,
  initialRecipe,
  saving,
  saveError,
  ejecting,
  onSave,
  onEject,
  onCancel,
}: AutomationEditorProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(existing?.name ?? '')
  const [recipe, setRecipe] = useState<AutomationRecipe>(() => normalizeRecipe(initialRecipe))
  const [showLogs, setShowLogs] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const traces = useCoreBlocksGetTraces(
    { blockId: existing?.id ?? 'none' },
    { enabled: existing !== null, refetchInterval: TRACES_POLL_MS },
  )
  const selectedRun = traces.data?.traces.find((tr) => tr.runId === runId) ?? null
  const view = useMemo(() => (selectedRun === null ? null : traceView(selectedRun)), [selectedRun])
  const scope = useMemo(() => triggerScopeVariables(recipe.triggers, t), [recipe.triggers, t])

  const devices = useAutomationDevices()

  const boundsError = validateRecipeBounds(recipe)
  const schemaError = useMemo(() => firstSchemaError(recipe), [recipe])
  const generated = useMemo(
    (): GeneratedSource =>
      generate(name.trim() === '' ? 'Untitled automation' : name.trim(), recipe),
    [name, recipe],
  )

  const nameMissing = name.trim() === ''
  const blocked =
    nameMissing || boundsError !== null || schemaError !== null || generated.code === null

  const save = (): void => {
    if (generated.code === null) return
    onSave({
      name: name.trim(),
      code: generated.code,
      enabled: existing?.enabled ?? true,
      placement: HUB,
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="automation-editor">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">
            {t('automation.automationEditor.runsOnTheHub', 'runs on the hub')}
          </Badge>
        </div>

        <label className="block max-w-md text-sm">
          <span className="text-foreground-subtle">
            {t('automation.automationEditor.name', 'Name')}
          </span>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(
              'automation.automationEditor.whatThisAutomationDoes',
              'What this automation does',
            )}
          />
        </label>

        <TraceBlock
          step="when"
          title={t('automation.automationEditor.when', 'When')}
          trace={view === null ? null : view.when}
          hint={t(
            'automation.automationEditor.anyOneOfTheseStarts',
            'Any one of these starts a run.',
          )}
        >
          <TriggerEditor
            triggers={recipe.triggers}
            devices={devices}
            onChange={(triggers) => setRecipe(withTriggers(recipe, triggers))}
          />
        </TraceBlock>

        <TraceBlock
          step="if"
          title={t('automation.automationEditor.andOnlyIf', 'And only if')}
          trace={view === null ? null : view.condition}
          hint={t(
            'automation.automationEditor.checkedAfterATriggerFires',
            'Checked after a trigger fires. Nothing runs unless this is true.',
          )}
        >
          <ConditionTree recipe={recipe} devices={devices} onChange={setRecipe} />
        </TraceBlock>

        <TraceBlock
          step="then"
          title={t('automation.automationEditor.then', 'Then')}
          trace={view === null ? null : view.thenBlock}
          hint={t(
            'automation.automationEditor.inThisOrderStoppingAt',
            'In this order, stopping at the first failure.',
          )}
        >
          <ActionList
            actions={recipe.actions}
            devices={devices}
            variables={scope}
            stepTones={
              view === null
                ? undefined
                : recipe.actions.map((_, index) => stepToneAt(view, index) ?? 'idle')
            }
            onChange={(actions) => setRecipe(withActions(recipe, actions))}
          />
        </TraceBlock>

        <TraceBlock
          step="mode"
          title={t('flow.runMode.title', 'Overlap')}
          trace={null}
          hint={t('flow.runMode.hint', 'What happens when a trigger arrives mid-run.')}
        >
          <RunModeSelector
            value={runModeOf(recipe)}
            onChange={(mode) => setRecipe(withRunMode(recipe, mode))}
          />
        </TraceBlock>

        <GeneratedCodePanel
          code={generated.code}
          error={generated.error}
          canEject={existing !== null}
          ejecting={ejecting}
          onEject={onEject}
        />

        {/* The refusals, in the order an operator can act on them: the bounds
            sentence first (it suggests the rewrite), then the schema's own
            complaint about the row that is still blank. */}
        {boundsError !== null && (
          <p className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            {boundsError}
          </p>
        )}
        {boundsError === null && schemaError !== null && (
          <p className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            {schemaError}
          </p>
        )}
        {saveError !== null && (
          <p className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
            {saveError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={saving || blocked}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowLogs(!showLogs)}
            disabled={existing === null}
            title={
              existing === null
                ? t(
                    'automation.automationEditor.logsAppearOnceTheAutomation',
                    'Logs appear once the automation has been saved and started',
                  )
                : t(
                    'automation.automationEditor.showThisAutomationSProcess',
                    "Show this automation's process logs",
                  )
            }
            data-testid="automation-logs-toggle"
          >
            <ScrollText className="h-4 w-4" /> {t('common.logs')} {showLogs ? '▾' : '▸'}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            {t('common.close', 'Close')}
          </Button>
          {nameMissing && (
            <Badge variant="warning">
              {t('automation.automationEditor.nameRequired', 'Name required')}
            </Badge>
          )}
        </div>

        {showLogs && existing !== null && (
          <div className="rounded border border-border" data-testid="automation-logs-panel">
            <div className="border-b border-border px-3 py-1.5 text-xs text-foreground-subtle">
              <Trans
                i18nKey="common.logsOf"
                values={{ id: coreBlockAddonId(existing.id) }}
                components={{ code: <code /> }}
              />
            </div>
            <LogStream
              addonId={coreBlockAddonId(existing.id)}
              maxHeight="max-h-64"
              showFilters={false}
            />
          </div>
        )}
      </div>
      <div className="order-first lg:order-last">
        <RunsPanel
          traces={existing === null ? [] : traces.data?.traces}
          selectedId={runId}
          onSelect={setRunId}
        />
      </div>
    </div>
  )
}

/**
 * The first thing the schema objects to, as a sentence naming where it is.
 *
 * Only the first: an operator fixing one blank field at a time, with the rest of
 * the form shouting, cannot tell which complaint their next edit answered.
 */
function firstSchemaError(recipe: AutomationRecipe): string | null {
  const parsed = AutomationRecipeSchema.safeParse(recipe)
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  if (issue === undefined) return i18n.t('helpers.automationEditor.incomplete')
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
  return `${where}${issue.message}`
}

function generate(name: string, recipe: AutomationRecipe): GeneratedSource {
  const prepared = prepareRecipeUnits(recipe)
  if (!prepared.ok) return { code: null, error: prepared.error }
  try {
    return { code: generateAutomationBlock({ name, recipe: prepared.recipe }), error: null }
  } catch (error: unknown) {
    return {
      code: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
