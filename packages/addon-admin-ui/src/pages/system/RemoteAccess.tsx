/**
 * Remote Access — the `network-access` providers registered on the hub
 * (Cloudflare Tunnel, ngrok, Tailscale Funnel, …), one at a time.
 *
 * An `<IntegrationHub>` page (Network → Remote Access): the pills, the
 * Enable/Disable toggle, Restart, the schema settings and the activity stream
 * are all the base's. This page only contributes what's genuinely
 * remote-access-specific:
 *   • The PRIMARY action — per-provider Start / Stop (`renderPrimaryAction`).
 *   • Connected/Disconnected + endpoint-link status badge.
 *   • Per-row start/stop error surfaced via `itemError`.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { Globe, Play, Square, Loader2, ExternalLink } from 'lucide-react'
import {
  Badge,
  Button,
  useAddonsList,
  useAddonsListCapabilityProviders,
  useNetworkAccessGetStatus,
  useNetworkAccessStart,
  useNetworkAccessStop,
} from '@camstack/ui-library'
import { NetworkAccessStatusSchema } from '@camstack/types'
import type { NetworkAccessStatus } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'
import { STATUS_BADGE_CLASS } from '../../components/integration-hub/addon-controls'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import { providerPillState, type IntegrationGroup } from '../../components/integration-hub/types'
import { buildAddonDisplayNameMap } from '../../lib/addon-display-names'
import { useTranslation } from 'react-i18next'

const STATUS_POLL_INTERVAL_MS = 5_000
const CAPABILITY = 'network-access'

/**
 * Input shape React-Query hands to a collection-cap mutation callback.
 * Codegen makes the whole `{ nodeId?, addonId? }` object optional, so
 * the variables may also be `void` / `undefined`.
 */
type MutationVariables = { readonly nodeId?: string; readonly addonId?: string } | void | undefined

const EMPTY_STATUS: NetworkAccessStatus = {
  connected: false,
  endpoint: null,
}

/**
 * One enumerated `network-access` provider; the live tunnel status is queried
 * per provider via `networkAccess.getStatus({ addonId })`.
 */
interface RemoteAccessProviderRow {
  readonly addonId: string
  readonly displayName: string
  readonly isActive: boolean
}

export function RemoteAccessPage(): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const providersQuery = useAddonsListCapabilityProviders(
    { capName: 'network-access' },
    { refetchInterval: STATUS_POLL_INTERVAL_MS },
  )
  const addonsQuery = useAddonsList(undefined, { refetchInterval: STATUS_POLL_INTERVAL_MS })

  const displayNames = useMemo(
    () => buildAddonDisplayNameMap(addonsQuery.data ?? []),
    [addonsQuery.data],
  )

  const providers = useMemo<readonly RemoteAccessProviderRow[]>(
    () =>
      (providersQuery.data ?? []).map((p) => ({
        addonId: p.addonId,
        displayName: displayNames.get(p.addonId) ?? p.addonId,
        isActive: p.isActive,
      })),
    [providersQuery.data, displayNames],
  )

  const [busyId, setBusyId] = useState<string | null>(null)
  // Per-row error state. Surfaces start/stop failures inline so the
  // operator sees WHY a tunnel didn't come up (e.g.
  // tailscale-ingress's "tailnet not joined — open Mesh Networks…").
  const [errorByAddon, setErrorByAddon] = useState<Record<string, string>>({})

  // The codegen'd collection-cap mutations accept an optional
  // `{ nodeId?, addonId? }` input, so React-Query types `variables` as
  // `void | { nodeId?, addonId? } | undefined`. Narrow it here.
  const onSuccess = (_data: unknown, variables: MutationVariables) => {
    // Invalidate ONLY the mutated provider's status query. The bare
    // `[['networkAccess']]` prefix matched every `getStatus` query in
    // the cache — including sibling rows — so starting one tunnel
    // force-refetched every row's status at once, which read as
    // "start/stop applied to all providers". Scope it to this addonId;
    // sibling rows keep their own 5 s poll.
    const addonId = variables?.addonId
    queryClient.invalidateQueries({
      queryKey: [['networkAccess', 'getStatus'], { input: { addonId }, type: 'query' as const }],
    })
    setBusyId(null)
    setErrorByAddon((prev) => {
      if (addonId === undefined || !(addonId in prev)) return prev
      const next = { ...prev }
      delete next[addonId]
      return next
    })
  }

  const onError = (err: unknown, variables: MutationVariables) => {
    setBusyId(null)
    const addonId = variables?.addonId
    if (addonId === undefined) return
    const message = err instanceof Error ? err.message : String(err)
    setErrorByAddon((prev) => ({ ...prev, [addonId]: message }))
  }

  const startMutation = useNetworkAccessStart({ onSuccess, onError })
  const stopMutation = useNetworkAccessStop({ onSuccess, onError })

  const groups: readonly IntegrationGroup[] = [
    {
      id: CAPABILITY,
      label: t('system.remoteAccess.remoteAccess', 'Remote access'),
      install: { capability: CAPABILITY, label: t('system.remoteAccess.addTunnel', 'Add tunnel') },
      entries: providers.map((p) => ({
        id: p.addonId,
        name: p.displayName,
        fallbackIcon: Globe,
        ...providerPillState(p.isActive),
        render: () => (
          <AddonIntegrationBody
            addonId={p.addonId}
            displayName={p.displayName}
            capName={CAPABILITY}
            isActive={p.isActive}
            badges={<ProviderStatusBadges addonId={p.addonId} />}
            error={errorByAddon[p.addonId] ?? null}
            primaryAction={
              <ProviderPrimaryAction
                addonId={p.addonId}
                busyId={busyId}
                onStart={(addonId) => {
                  setBusyId(addonId)
                  startMutation.mutate({ addonId })
                }}
                onStop={(addonId) => {
                  setBusyId(addonId)
                  stopMutation.mutate({ addonId })
                }}
              />
            }
          />
        ),
      })),
    },
  ]

  return (
    <IntegrationHub
      embedded
      icon={Globe}
      title={t('system.remoteAccess.remoteAccess2', 'Remote Access')}
      subtitle={t(
        'system.remoteAccess.publicFacingTunnelsThatExpose',
        'Public-facing tunnels that expose this hub to the internet (Cloudflare Tunnel, ngrok, …).',
      )}
      groups={groups}
      isLoading={providersQuery.isLoading}
      emptyTitle={t(
        'system.remoteAccess.noRemoteAccessProvidersInstalled',
        'No remote-access providers installed',
      )}
      emptyDescription={t(
        'system.remoteAccess.installATunnelAddonE',
        'Install a tunnel addon (e.g. @camstack/addon-cloudflare) to expose this hub publicly.',
      )}
    />
  )
}

/**
 * Live status of one provider, validated against
 * `NetworkAccessStatusSchema`. `getStatus`'s codegen'd wire output is
 * `unknown`; the safeParse keeps a typed value without a cast. Cold
 * start falls back to `EMPTY_STATUS`.
 */
function useNetworkAccessStatus(addonId: string): NetworkAccessStatus {
  const { data } = useNetworkAccessGetStatus(
    { addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  const parsed = data ? NetworkAccessStatusSchema.safeParse(data) : null
  return parsed?.success ? parsed.data : EMPTY_STATUS
}

// ── Status badges (Connected / endpoint link) ───────────────────────

function ProviderStatusBadges({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const status = useNetworkAccessStatus(addonId)
  return (
    <>
      <Badge variant={status.connected ? 'success' : 'default'} className={STATUS_BADGE_CLASS}>
        {status.connected
          ? t('system.remoteAccess.connected', 'Connected')
          : t('system.remoteAccess.disconnected', 'Disconnected')}
      </Badge>
      {status.endpoint && (
        <a
          href={status.endpoint.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-1 break-all text-[11px] text-success hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {status.endpoint.url}
        </a>
      )}
    </>
  )
}

// ── Primary action (Start / Stop) ───────────────────────────────────

interface ProviderPrimaryActionProps {
  readonly addonId: string
  readonly busyId: string | null
  readonly onStart: (addonId: string) => void
  readonly onStop: (addonId: string) => void
}

/**
 * The page-specific PRIMARY lifecycle action. The provider's live
 * `connected` state (queried via `networkAccess.getStatus({ addonId })`)
 * drives whether Start or Stop is shown.
 */
function ProviderPrimaryAction({
  addonId,
  busyId,
  onStart,
  onStop,
}: ProviderPrimaryActionProps): ReactElement {
  const { t } = useTranslation()
  const status = useNetworkAccessStatus(addonId)
  const isBusy = busyId === addonId
  return status.connected ? (
    <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => onStop(addonId)}>
      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
      {t('system.remoteAccess.stop', 'Stop')}
    </Button>
  ) : (
    <Button size="sm" variant="primary" disabled={isBusy} onClick={() => onStart(addonId)}>
      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
      {t('system.remoteAccess.start', 'Start')}
    </Button>
  )
}
