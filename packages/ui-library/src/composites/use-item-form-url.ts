/**
 * URL ownership for create/edit modals: `?new=1` or `?edit=<id>` (replace, or push with `push`).
 * Mutually exclusive — opening one clears the other.
 */
import { useCallback, useMemo } from 'react'
import { isFormOpenEntry, useUrlQueryParam, writeUrlParams } from '../hooks/use-url-query'

export type ItemFormUrlState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'new' }
  | { readonly mode: 'edit'; readonly id: string }

export interface UseItemFormUrlOptions {
  /** Query key for create (default `new`). Value is the literal `1` when open. */
  readonly newKey?: string
  /** Query key for edit id (default `edit`). */
  readonly editKey?: string
  /**
   * Opening adds a history entry, so Back returns to the previous view (the
   * list) instead of skipping past it; closing from that entry goes back.
   * Default false: the URL is replaced.
   */
  readonly push?: boolean
}

export interface UseItemFormUrlResult {
  readonly state: ItemFormUrlState
  readonly openNew: () => void
  readonly openEdit: (id: string) => void
  readonly close: () => void
}

export function useItemFormUrl(options: UseItemFormUrlOptions = {}): UseItemFormUrlResult {
  const newKey = options.newKey ?? 'new'
  const editKey = options.editKey ?? 'edit'
  const push = options.push === true
  const [newParam, setNewParam] = useUrlQueryParam(newKey)
  const [editParam, setEditParam] = useUrlQueryParam(editKey)

  const state = useMemo((): ItemFormUrlState => {
    if (editParam !== null && editParam !== '') {
      return { mode: 'edit', id: editParam }
    }
    if (newParam === '1') return { mode: 'new' }
    return { mode: 'closed' }
  }, [editParam, newParam])

  const openNew = useCallback((): void => {
    if (push) writeUrlParams({ [editKey]: null, [newKey]: '1' }, 'push')
    else {
      setEditParam(null)
      setNewParam('1')
    }
  }, [push, editKey, newKey, setEditParam, setNewParam])

  const openEdit = useCallback(
    (id: string): void => {
      if (push) writeUrlParams({ [newKey]: null, [editKey]: id }, 'push')
      else {
        setNewParam(null)
        setEditParam(id)
      }
    },
    [push, editKey, newKey, setEditParam, setNewParam],
  )

  const close = useCallback((): void => {
    if (push && isFormOpenEntry()) {
      window.history.back()
      return
    }
    setNewParam(null)
    setEditParam(null)
  }, [push, setEditParam, setNewParam])

  return { state, openNew, openEdit, close }
}
