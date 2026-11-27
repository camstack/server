/**
 * Every mesh network of every provider of `device-mesh`.
 *
 * `device-mesh` is device-native: a provider registers it on the devices it
 * owns, and `getTopology` answers for the whole mesh the device sits in. So the
 * networks are enumerated from the devices that carry the cap
 * (`deviceManager.search` requiring it), reading one topology per network
 * (`collectMeshNetworks`).
 */
import { useQuery } from '@tanstack/react-query'
import { trpc } from '../../trpc-react'
import { useCapabilityPresence, type CapabilityPresence } from '../../hooks/use-capability-presence'
import { collectMeshNetworks, type MeshNetwork } from './device-mesh-model'

export const DEVICE_MESH_CAP = 'device-mesh'
/** `deviceManager.search` caps one page at this many devices. */
const SEARCH_LIMIT = 200
/** A topology older than this is re-read on window focus. */
const TOPOLOGY_STALE_MS = 15_000

export interface MeshNetworksResult {
  readonly presence: CapabilityPresence
  /** `undefined` until the enumeration answered; `[]` is a real "no mesh device". */
  readonly networks: readonly MeshNetwork[] | undefined
  /** More mesh devices exist than one search page returned. */
  readonly truncated: boolean
  readonly isError: boolean
  readonly isFetching: boolean
  readonly refetch: () => void
}

export function useMeshNetworks(): MeshNetworksResult {
  const presence = useCapabilityPresence(DEVICE_MESH_CAP)
  const utils = trpc.useUtils()
  const search = trpc.deviceManager.search.useQuery(
    { requires: { caps: [DEVICE_MESH_CAP] }, limit: SEARCH_LIMIT },
    { enabled: presence === 'present', staleTime: TOPOLOGY_STALE_MS, refetchOnWindowFocus: true },
  )
  const deviceIds = (search.data?.items ?? []).filter((i) => i.compatible).map((i) => i.id)
  const networks = useQuery({
    queryKey: ['device-mesh', 'networks', deviceIds.join(',')],
    enabled: search.data !== undefined,
    // A topology changes without the set of devices changing: re-read it when
    // the operator comes back to the tab, and on the section's Refresh.
    staleTime: TOPOLOGY_STALE_MS,
    refetchOnWindowFocus: true,
    queryFn: () =>
      collectMeshNetworks(deviceIds, (deviceId) =>
        utils.deviceMesh.getTopology.fetch({ deviceId }),
      ),
  })
  return {
    presence,
    networks: networks.data,
    truncated: search.data?.nextCursor != null,
    isError: search.isError || networks.isError,
    isFetching: search.isFetching || networks.isFetching,
    refetch: () => {
      void search.refetch()
      void networks.refetch()
    },
  }
}
