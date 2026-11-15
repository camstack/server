/**
 * The tag style registry as the UI reads it (D1054): the `tags` cap's list plus
 * its three writes. Every tag component goes through this one hook so the
 * pending / failed / absent states are decided once (D315): `entries` is
 * `undefined` until the list ANSWERED, and the writes are offered only when the
 * cap is known to be present.
 */
import type { IconKey, TagColorId, TagEntry } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import {
  useTagsList,
  useTagsRemove,
  useTagsRename,
  useTagsSetStyle,
} from '../../generated/system-hooks'
import { type CapabilityPresence, useCapabilityPresence } from '../../hooks/use-capability-presence'

export interface TagRegistry {
  /** Every styled or used tag; `undefined` until the list answered. */
  readonly entries: readonly TagEntry[] | undefined
  /** The list was asked and failed. */
  readonly failed: boolean
  /** Whether a `tags` provider exists — writes are offered only when `present`. */
  readonly presence: CapabilityPresence
  readonly setStyle: (name: string, color: TagColorId, icon: IconKey) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly remove: (name: string) => Promise<void>
}

export function useTagRegistry(): TagRegistry {
  const presence = useCapabilityPresence('tags')
  const list = useTagsList({}, { enabled: presence === 'present' })
  const queryClient = useQueryClient()
  const setStyleMutation = useTagsSetStyle()
  const renameMutation = useTagsRename()
  const removeMutation = useTagsRemove()

  // A rename or remove rewrites records of every kind, owned by several
  // sections with their own queries: refresh everything, not only the list.
  const refreshAll = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries()
  }, [queryClient])

  const setStyle = useCallback(
    async (name: string, color: TagColorId, icon: IconKey): Promise<void> => {
      await setStyleMutation.mutateAsync({ name, color, icon })
      await queryClient.invalidateQueries({ queryKey: [['tags']] })
    },
    [setStyleMutation, queryClient],
  )
  const rename = useCallback(
    async (from: string, to: string): Promise<void> => {
      await renameMutation.mutateAsync({ from, to })
      await refreshAll()
    },
    [renameMutation, refreshAll],
  )
  const remove = useCallback(
    async (name: string): Promise<void> => {
      await removeMutation.mutateAsync({ name })
      await refreshAll()
    },
    [removeMutation, refreshAll],
  )

  return {
    entries: list.data,
    failed: list.status === 'error',
    presence,
    setStyle,
    rename,
    remove,
  }
}
