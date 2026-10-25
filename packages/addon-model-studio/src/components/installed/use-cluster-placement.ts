/**
 * Every online node's view of the cluster models: its schema (builds + what is
 * on disk), its devices and its resident pools. One failed node is reported as
 * that node's error, never as "runs nowhere".
 */
import { useEffect, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import {
  listLoadedEngines,
  listNodeInferenceDevices,
  listPipelineCatalogBundle,
} from '../../ui/api.js'
import type { ClusterNodeInput } from '../../ui/installed-inventory.js'

async function loadNode(trpc: AddonPageProps['trpc'], nodeId: string): Promise<ClusterNodeInput> {
  try {
    const [bundle, devices, engines] = await Promise.all([
      listPipelineCatalogBundle(trpc, nodeId),
      listNodeInferenceDevices(trpc, nodeId),
      listLoadedEngines(trpc, nodeId).catch(() => null),
    ])
    return {
      nodeId,
      seeds: bundle.seeds,
      stepCatalogs: bundle.stepCatalogs,
      devices,
      engines,
    }
  } catch (err) {
    return { nodeId, error: err instanceof Error ? err.message : 'unreachable' }
  }
}

export function useClusterPlacementInputs(
  trpc: AddonPageProps['trpc'],
  nodeIds: readonly string[],
  refreshKey: number,
): readonly ClusterNodeInput[] | null {
  const [inputs, setInputs] = useState<readonly ClusterNodeInput[] | null>(null)
  const idsKey = nodeIds.join('\n')
  useEffect(() => {
    let cancelled = false
    const ids = idsKey.length === 0 ? [] : idsKey.split('\n')
    void Promise.all(ids.map((id) => loadNode(trpc, id))).then((loaded) => {
      if (!cancelled) setInputs(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [trpc, idsKey, refreshKey])
  return inputs
}
