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

/**
 * The routers whose queries return records that carry tags — the owners the
 * `tags` cap rewrites (automations and scripts are `coreBlocks`; devices and a
 * device's Customize page are `deviceManager`; notification rules are
 * `notificationRules`) — plus the tag list itself.
 */
const TAG_OWNER_ROUTERS: ReadonlySet<string> = new Set([
  'tags',
  'coreBlocks',
  'schedulers',
  'template',
  'actions',
  'deviceManager',
  'notificationRules',
])

/** The router a query belongs to: tRPC keys are `[[router, proc], …]`, hand-written ones `[router, …]`. */
function queryRouter(queryKey: readonly unknown[]): string | undefined {
  const head = queryKey[0]
  const first = Array.isArray(head) ? head[0] : head
  return typeof first === 'string' ? first : undefined
}

function isTagOwnerQuery(queryKey: readonly unknown[]): boolean {
  const router = queryRouter(queryKey)
  return router !== undefined && TAG_OWNER_ROUTERS.has(router)
}

export function useTagRegistry(): TagRegistry {
  const presence = useCapabilityPresence('tags')
  const list = useTagsList({}, { enabled: presence === 'present' })
  const queryClient = useQueryClient()
  const setStyleMutation = useTagsSetStyle()
  const renameMutation = useTagsRename()
  const removeMutation = useTagsRemove()

  // A rename or remove rewrites the records of every owner kind (D1054):
  // refresh the queries of those owners and the tag list, nothing else.
  const refreshOwners = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({
      predicate: (query) => isTagOwnerQuery(query.queryKey),
    })
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
      await refreshOwners()
    },
    [renameMutation, refreshOwners],
  )
  const remove = useCallback(
    async (name: string): Promise<void> => {
      await removeMutation.mutateAsync({ name })
      await refreshOwners()
    },
    [removeMutation, refreshOwners],
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
