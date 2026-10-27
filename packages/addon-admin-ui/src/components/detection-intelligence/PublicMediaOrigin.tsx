/**
 * Resolves a PUBLIC origin (e.g. `https://camstack.example.top`) for building
 * shareable event-media URLs, by probing the hub's `network-access` providers.
 *
 * The event-media route lives on the hub; any active `network-access` tunnel
 * (Cloudflare, Tailscale Funnel, ngrok, …) fronts the whole hub, so its
 * `getStatus().endpoint.url` IS the public origin of the media route. We
 * enumerate the providers and probe each one's status; the first CONNECTED
 * endpoint wins. If no tunnel is up, there is no public origin and callers
 * fall back to the LAN origin + a copyable relative path.
 *
 * Provider count is dynamic, so — mirroring `RemoteAccess.tsx` — each provider
 * is probed by its own child component (stable hook order per child) that
 * lifts its endpoint origin to the parent.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useAddonsListCapabilityProviders, useNetworkAccessGetStatus } from '@camstack/ui-library'
import { NetworkAccessStatusSchema } from '@camstack/types'

const STATUS_POLL_INTERVAL_MS = 30_000

/** `{ publicOrigin, probes }` — render `probes` (invisible) to keep it fresh. */
export function usePublicMediaOrigin(enabled: boolean): {
  readonly publicOrigin: string | null
  readonly probes: ReactElement | null
} {
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null)

  // First connected endpoint wins; keep the earliest resolved origin stable.
  const reportOrigin = useCallback((origin: string) => {
    setPublicOrigin((prev) => prev ?? origin)
  }, [])

  // Reset when the consumer (the modal) closes so a stale origin never leaks
  // into the next opened track.
  useEffect(() => {
    if (!enabled) setPublicOrigin(null)
  }, [enabled])

  const probes = enabled ? <PublicOriginProbes onOrigin={reportOrigin} /> : null
  return { publicOrigin, probes }
}

function PublicOriginProbes({
  onOrigin,
}: {
  readonly onOrigin: (origin: string) => void
}): ReactElement {
  const { data } = useAddonsListCapabilityProviders({ capName: 'network-access' })
  const providers = data ?? []
  return (
    <>
      {providers.map((p) => (
        <EndpointProbe key={p.addonId} addonId={p.addonId} onOrigin={onOrigin} />
      ))}
    </>
  )
}

function EndpointProbe({
  addonId,
  onOrigin,
}: {
  readonly addonId: string
  readonly onOrigin: (origin: string) => void
}): null {
  const { data } = useNetworkAccessGetStatus(
    { addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  useEffect(() => {
    const parsed = data ? NetworkAccessStatusSchema.safeParse(data) : null
    const url = parsed?.success ? parsed.data.endpoint?.url : undefined
    if (!url) return
    try {
      onOrigin(new URL(url).origin)
    } catch {
      // Non-URL endpoint string — ignore; LAN origin remains the fallback.
    }
  }, [data, onOrigin])
  return null
}
