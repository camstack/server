/**
 * Where each Build section's rows keep their tags and searchable text (D1054).
 * Module-level so the references are stable: `TaggedDataTable` keys its memos
 * on them.
 */
import type { ActionEntry, CoreBlock, Scheduler, TemplateRecord } from '@dominevo/types'

export const blockTags = (block: CoreBlock): readonly string[] | undefined => block.tags
export const blockSearchText = (block: CoreBlock): readonly string[] => [block.name]

export const actionTags = (action: ActionEntry): readonly string[] | undefined => action.tags
export const actionSearchText = (action: ActionEntry): readonly string[] => [action.name]

export const schedulerTags = (scheduler: Scheduler): readonly string[] | undefined => scheduler.tags
export const schedulerSearchText = (scheduler: Scheduler): readonly string[] => [scheduler.name]

export const templateTags = (template: TemplateRecord): readonly string[] | undefined =>
  template.tags
export const templateSearchText = (template: TemplateRecord): readonly string[] => [template.name]
