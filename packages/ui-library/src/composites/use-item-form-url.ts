/**
 * URL ownership for create/edit modals: `?new=1` or `?edit=<id>` (replace).
 * Mutually exclusive — opening one clears the other.
 */
import { useCallback, useMemo } from 'react'
import { useUrlQueryParam } from '../hooks/use-url-query'

export type ItemFormUrlState =
  | { readonly mode: 'closed' }
  | { readonly mode: 'new' }
  | { readonly mode: 'edit'; readonly id: string }

export interface UseItemFormUrlOptions {
  /** Query key for create (default `new`). Value is the literal `1` when open. */
  readonly newKey?: string
  /** Query key for edit id (default `edit`). */
  readonly editKey?: string
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
    setEditParam(null)
    setNewParam('1')
  }, [setEditParam, setNewParam])

  const openEdit = useCallback(
    (id: string): void => {
      setNewParam(null)
      setEditParam(id)
    },
    [setEditParam, setNewParam],
  )

  const close = useCallback((): void => {
    setNewParam(null)
    setEditParam(null)
  }, [setEditParam, setNewParam])

  return { state, openNew, openEdit, close }
}
