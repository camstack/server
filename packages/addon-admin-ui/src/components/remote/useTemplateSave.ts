/**
 * Saving one template draft (create or update), shared by the Templates page and
 * the remote modal's layout view so both write the same way and refuse the same way.
 */
import { useTemplateCreate, useTemplateUpdate } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { TemplateDraft } from './TemplateEditorDialog'

export interface TemplateSave {
  /** Resolves true when the template was written; false leaves `error` set. */
  readonly save: (draft: TemplateDraft) => Promise<boolean>
  readonly saving: boolean
  readonly error: string | null
  readonly clearError: () => void
}

export function useTemplateSave(): TemplateSave {
  const queryClient = useQueryClient()
  const create = useTemplateCreate()
  const update = useTemplateUpdate()
  const [error, setError] = useState<string | null>(null)

  const save = async (next: TemplateDraft): Promise<boolean> => {
    setError(null)
    try {
      const result =
        next.id === null
          ? await create.mutateAsync({
              kind: next.kind,
              name: next.name,
              payload: next.payload,
              ...tagsOf(next),
            })
          : await update.mutateAsync({
              id: next.id,
              name: next.name,
              payload: next.payload,
              ...tagsOf(next),
            })
      if (result.status === 'refused') {
        setError(result.detail)
        return false
      }
      await queryClient.invalidateQueries({ queryKey: [['template']] })
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  return {
    save,
    saving: create.isPending || update.isPending,
    error,
    clearError: () => setError(null),
  }
}

/** The tags of a save: sent only when the editor holds them (absent keeps the stored ones). */
function tagsOf(draft: TemplateDraft): { tags?: string[] } {
  return draft.tags === undefined ? {} : { tags: [...draft.tags] }
}
