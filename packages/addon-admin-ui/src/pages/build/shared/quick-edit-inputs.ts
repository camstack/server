/**
 * What each Build section writes when Quick edit changes only the name and the
 * tags. Every builder starts from the stored item and replaces those two fields,
 * so the save carries everything else untouched — a rename never drops a step,
 * a point, a file or a placement.
 */
import {
  type ActionEntry,
  type CoreBlock,
  type CoreBlockInput,
  generateAutomationBlock,
  type Scheduler,
  type SchedulerInput,
  type TemplateRecord,
} from '@camstack/types'
import { parseRecipeFromCode } from '../automation/recipe-from-code'
import { type DraftCheck, checkDraft, draftOf } from '../actions/action-draft'
import { schedulerInputOf } from '../schedulers/scheduler-model'
import type { TemplateDraft } from '../../../components/remote/TemplateEditorDialog'
import type { QuickEditValues } from './QuickEditDialog'

/** A script, or any core block whose source is kept as it is. */
export function blockQuickEditInput(block: CoreBlock, next: QuickEditValues): CoreBlockInput {
  return {
    name: next.name,
    code: block.code,
    ...(block.files === undefined ? {} : { files: block.files }),
    ...(block.entry === undefined ? {} : { entry: block.entry }),
    enabled: block.enabled,
    placement: block.placement,
    ...(block.integrationId === undefined ? {} : { integrationId: block.integrationId }),
    ...(block.settingsSchema === undefined ? {} : { settingsSchema: block.settingsSchema }),
    tags: [...next.tags],
  }
}

/**
 * An automation: the generated source names the automation, so a rename
 * regenerates it from the recipe it embeds. A recipe that cannot be read keeps
 * the stored source (the row is already flagged unreadable).
 */
export function automationQuickEditInput(block: CoreBlock, next: QuickEditValues): CoreBlockInput {
  const base = blockQuickEditInput(block, next)
  if (next.name === block.name) return base
  const parsed = parseRecipeFromCode(block.code)
  if (!parsed.ok) return base
  try {
    return { ...base, code: generateAutomationBlock({ name: next.name, recipe: parsed.recipe }) }
  } catch {
    return base
  }
}

export function actionQuickEditInput(entry: ActionEntry, next: QuickEditValues): DraftCheck {
  return checkDraft({ ...draftOf(entry), name: next.name, tags: next.tags })
}

export function schedulerQuickEditInput(entry: Scheduler, next: QuickEditValues): SchedulerInput {
  return { ...schedulerInputOf(entry), name: next.name, tags: [...next.tags] }
}

export function templateQuickEditDraft(row: TemplateRecord, next: QuickEditValues): TemplateDraft {
  return { id: row.id, kind: row.kind, name: next.name, payload: row.payload, tags: next.tags }
}

/** The values the modal opens with. */
export function quickEditValuesOf(item: {
  readonly name: string
  readonly tags?: readonly string[]
}): QuickEditValues {
  return { name: item.name, tags: item.tags ?? [] }
}
