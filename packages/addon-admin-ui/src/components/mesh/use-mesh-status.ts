import { useMeshNetworkGetStatus } from '@camstack/ui-library'
import { MeshStatusSchema } from '@camstack/types'
import type { MeshStatus } from '@camstack/types'

export const STATUS_POLL_INTERVAL_MS = 5_000

const EMPTY_STATUS: MeshStatus = {
  joined: false,
  meshIp: '',
  magicDnsHostname: '',
  peerCount: 0,
  endpoints: [],
  tenantName: '',
  magicDnsSuffix: '',
  userLogin: null,
  controlPlaneUrl: '',
  keyExpiry: null,
}

/**
 * Live status of one provider, validated against `MeshStatusSchema`.
 * `getStatus`'s codegen'd wire output is `unknown`; the safeParse keeps
 * a typed value without a cast. Cold-start falls back to `EMPTY_STATUS`.
 */
export function useMeshStatus(addonId: string): { status: MeshStatus; isLoading: boolean } {
  const { data, isLoading } = useMeshNetworkGetStatus(
    { addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  const parsed = data ? MeshStatusSchema.safeParse(data) : null
  return {
    status: parsed?.success ? parsed.data : EMPTY_STATUS,
    isLoading,
  }
}
