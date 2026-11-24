/**
 * The pending edits of the "Triggered by" section. Nothing here talks to the
 * server: the section keeps one draft, shows the stored instances with the draft
 * applied, and writes the {@link draftOps} once, when the operator presses Save.
 * Discard is dropping the draft.
 */
import {
  type LinkedTriggerParams,
  linkedTriggerValues,
  type TemplateInstance,
} from '@camstack/types'
import type { RowRemoval } from './linked-triggers-model'

/** Prefix of the block id a not-yet-saved trigger carries. */
const NEW_PREFIX = 'new:'

export interface TriggerDraft {
  /** Stored instances the operator changed, with the change applied. */
  readonly edited: ReadonlyMap<string, TemplateInstance>
  /** Stored instances the operator removed. */
  readonly deleted: ReadonlySet<string>
  /** Triggers the operator added; they have no stored block yet. */
  readonly added: readonly TemplateInstance[]
}

export const EMPTY_DRAFT: TriggerDraft = { edited: new Map(), deleted: new Set(), added: [] }

export type DraftOp =
  | { readonly kind: 'delete'; readonly blockId: string }
  | { readonly kind: 'update'; readonly instance: TemplateInstance }
  | { readonly kind: 'enable'; readonly blockId: string; readonly enabled: boolean }
  | { readonly kind: 'create'; readonly instance: TemplateInstance }

function isNew(blockId: string): boolean {
  return blockId.startsWith(NEW_PREFIX)
}

/** The stored instances with the draft applied: what the section shows. */
export function workingInstances(
  stored: readonly TemplateInstance[],
  draft: TriggerDraft,
): readonly TemplateInstance[] {
  return [
    ...stored
      .filter((i) => !draft.deleted.has(i.blockId))
      .map((i) => draft.edited.get(i.blockId) ?? i),
    ...draft.added,
  ]
}

/** Replace one working instance (stored or added) by its edited form. */
function withInstance(draft: TriggerDraft, instance: TemplateInstance): TriggerDraft {
  return isNew(instance.blockId)
    ? {
        ...draft,
        added: draft.added.map((a) => (a.blockId === instance.blockId ? instance : a)),
      }
    : { ...draft, edited: new Map(draft.edited).set(instance.blockId, instance) }
}

export function withParams(
  draft: TriggerDraft,
  instance: TemplateInstance,
  params: LinkedTriggerParams,
): TriggerDraft {
  return withInstance(draft, { ...instance, values: linkedTriggerValues(params) })
}

export function withEnabled(
  draft: TriggerDraft,
  instance: TemplateInstance,
  enabled: boolean,
): TriggerDraft {
  return withInstance(draft, { ...instance, enabled })
}

/** A removal that empties the automation deletes it (an added one just disappears). */
export function withRemoval(
  draft: TriggerDraft,
  instance: TemplateInstance,
  removal: RowRemoval,
): TriggerDraft {
  if (removal.kind === 'update') return withParams(draft, instance, removal.params)
  if (isNew(instance.blockId)) {
    return { ...draft, added: draft.added.filter((a) => a.blockId !== instance.blockId) }
  }
  const edited = new Map(draft.edited)
  edited.delete(instance.blockId)
  return { ...draft, edited, deleted: new Set(draft.deleted).add(instance.blockId) }
}

/** A trigger the operator added: no stored block until Save. */
export function withAdded(
  draft: TriggerDraft,
  added: Omit<TemplateInstance, 'blockId'>,
): TriggerDraft {
  const blockId = `${NEW_PREFIX}${String(draft.added.length)}-${String(Date.now())}`
  return { ...draft, added: [...draft.added, { ...added, blockId }] }
}

/** What Save writes: deletes, then changes to stored blocks, then creations. */
export function draftOps(
  stored: readonly TemplateInstance[],
  draft: TriggerDraft,
): readonly DraftOp[] {
  const ops: DraftOp[] = [...draft.deleted].map((blockId): DraftOp => ({ kind: 'delete', blockId }))
  for (const instance of stored) {
    const edit = draft.edited.get(instance.blockId)
    if (edit === undefined || draft.deleted.has(instance.blockId)) continue
    if (JSON.stringify(edit.values) !== JSON.stringify(instance.values)) {
      ops.push({ kind: 'update', instance: edit })
    }
    if (edit.enabled !== instance.enabled) {
      ops.push({ kind: 'enable', blockId: instance.blockId, enabled: edit.enabled })
    }
  }
  for (const instance of draft.added) ops.push({ kind: 'create', instance })
  return ops
}
