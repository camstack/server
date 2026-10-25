/**
 * The online nodes of the cluster, hub first — the roster the Cluster models
 * section reads every node's placement from. A module of its own so a spec can
 * replace the roster without a tRPC React provider.
 */
import { useMemo } from 'react'
import { useClusterNodes } from '@camstack/ui-library'

export function useOnlineNodeIds(): readonly string[] {
  const { nodes } = useClusterNodes()
  return useMemo(() => nodes.filter((n) => n.isOnline).map((n) => n.id), [nodes])
}
