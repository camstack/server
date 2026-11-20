import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import type { KindLabelSource } from './group-members-model'

/** The target-kind catalogue the notification targets list reads (same query key, one shared cache entry). */
export function useTargetKinds(): { readonly data: readonly KindLabelSource[] | undefined } {
  const system = useSystem()
  const kinds = useQuery({
    queryKey: ['notificationOutput', 'listTargetKinds'],
    queryFn: () => system.trpcClient.notificationOutput.listTargetKinds.query({}),
  })
  return { data: kinds.data }
}
