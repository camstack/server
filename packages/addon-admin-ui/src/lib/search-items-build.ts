/**
 * "Build-your-self" elements as global-search items: automations, scripts,
 * schedulers, custom devices, templates and actions (D1054 — each carries
 * operator tags).
 *
 * Pure mappings over the lists the Build page already reads. The label is the
 * element's name; its tags go in as `keywords`, so the one shared matcher
 * (`searchRank`) finds a record by name AND by tag. `path` is the element's
 * own editor, so a selection is a redirect straight into it.
 */
import {
  coreBlockSourceKind,
  type ActionEntry,
  type CompositionView,
  type CoreBlock,
  type Scheduler,
  type TemplateRecord,
} from '@camstack/types'
import { templateEditPath } from '../components/remote/EditTemplateButton'
import { isPlainScript, looksLikeAutomation } from '../pages/build/automation/recipe-from-code'
import type { SearchItem } from './global-search'
import { compositionEditorPath } from './customization-routes'

/** The lists a search can draw BYS rows from; `undefined` = not answered yet. */
export interface BuildSearchSources {
  readonly blocks?: readonly CoreBlock[]
  readonly actions?: readonly ActionEntry[]
  readonly schedulers?: readonly Scheduler[]
  readonly templates?: readonly TemplateRecord[]
  readonly compositions?: readonly CompositionView[]
}

/** `/build` with one tab selected and the editor of one record open. */
export function buildEditorPath(tab: string, param: string, id: string): string {
  return `/build?tab=${tab}&${param}=${encodeURIComponent(id)}` // hub-path-ok: react-router path
}

function tagged(tags: readonly string[] | undefined): readonly string[] {
  return tags ?? []
}

export function buildBuildSearchItems(sources: BuildSearchSources): readonly SearchItem[] {
  const items: SearchItem[] = []
  for (const block of sources.blocks ?? []) {
    if (looksLikeAutomation(block.code)) {
      items.push({
        key: `automation:${block.id}`,
        domain: 'automation',
        label: block.name,
        keywords: tagged(block.tags),
        path: buildEditorPath('automations', 'block', block.id),
      })
    } else if (coreBlockSourceKind(block) === 'code' && isPlainScript(block)) {
      items.push({
        key: `script:${block.id}`,
        domain: 'script',
        label: block.name,
        keywords: tagged(block.tags),
        path: buildEditorPath('scripts', 'block', block.id),
      })
    }
  }
  for (const scheduler of sources.schedulers ?? []) {
    items.push({
      key: `scheduler:${scheduler.id}`,
      domain: 'scheduler',
      label: scheduler.name,
      keywords: tagged(scheduler.tags),
      path: buildEditorPath('schedulers', 'scheduler', scheduler.id),
    })
  }
  for (const action of sources.actions ?? []) {
    items.push({
      key: `action:${action.id}`,
      domain: 'action',
      label: action.name,
      keywords: tagged(action.tags),
      path: buildEditorPath('actions', 'action', action.id),
    })
  }
  for (const template of sources.templates ?? []) {
    items.push({
      key: `template:${template.id}`,
      domain: 'template',
      label: template.name,
      subtitle: template.kind,
      keywords: tagged(template.tags),
      path: templateEditPath(template.id),
    })
  }
  for (const view of sources.compositions ?? []) {
    items.push({
      key: `customDevice:${view.block.id}`,
      domain: 'customDevice',
      label: view.block.name,
      keywords: tagged(view.block.tags),
      path: compositionEditorPath(view.block.id),
    })
  }
  return items
}
