/**
 * TURN servers page — an `<IntegrationHub>` (Network → TURN Servers).
 *
 * `turn-orchestrator` was retired (2026-05-15) — this page now talks to
 * generic primitives:
 *   • `addons.listCapabilityProviders({ capName: 'turn-provider' })`
 *     enumerates providers and reports each one's `isActive` (enabled)
 *     state; `addons.list` resolves display names from the manifest.
 *   • `turnProvider.getTurnServers()` with no `addonId` returns the
 *     auto-mount's aggregate — the union of ICE servers across every
 *     ENABLED provider (what the WebRTC layer fetches per-session).
 *     The same query with an `addonId` returns just that provider's
 *     servers, driving the per-provider chip list.
 *
 * The pills, the Enable/Disable toggle, Restart, the schema settings and the
 * activity stream are all the base's — this page only contributes what's
 * genuinely TURN-specific:
 *   • Per-provider ICE URL chips (an `ice-servers` panel).
 *   • Trailing "Combined ICE server list" debugging card (all providers).
 */
import { useMemo, type ReactElement } from 'react'
import { Network } from 'lucide-react'
import {
  Button,
  SECTION_BODY,
  SectionCard,
  useAddonsList,
  useAddonsListCapabilityProviders,
  useTurnProviderGetTurnServers,
} from '@camstack/ui-library'
import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import { providerPillState, type IntegrationGroup } from '../../components/integration-hub/types'
import { buildAddonDisplayNameMap } from '../../lib/addon-display-names'
import { useTranslation } from 'react-i18next'

const PROVIDERS_POLL_INTERVAL_MS = 30_000
const CAPABILITY = 'turn-provider'

/**
 * One enumerated `turn-provider`; `isActive` mirrors the registry's
 * enabled-set.
 */
interface TurnProviderRow {
  readonly addonId: string
  readonly displayName: string
  readonly isActive: boolean
}

/** Flatten an ICE-server entry's `urls` field into a string list. */
function flattenUrls(servers: readonly { urls: string | readonly string[] }[]): readonly string[] {
  const flat: string[] = []
  for (const s of servers) {
    // Narrow via `typeof` rather than `Array.isArray` — the latter
    // widens the array branch to `any[]`, tripping no-unsafe-argument.
    if (typeof s.urls === 'string') flat.push(s.urls)
    else flat.push(...s.urls)
  }
  return flat
}

export function TurnServersPage() {
  const { t } = useTranslation()
  const providersQuery = useAddonsListCapabilityProviders(
    { capName: 'turn-provider' },
    { refetchInterval: PROVIDERS_POLL_INTERVAL_MS },
  )
  const addonsQuery = useAddonsList(undefined, { refetchInterval: PROVIDERS_POLL_INTERVAL_MS })
  // No `addonId` → the auto-mount aggregate: union across enabled providers.
  const allServersQuery = useTurnProviderGetTurnServers()
  const allServers = allServersQuery.data ?? []

  const displayNames = useMemo(
    () => buildAddonDisplayNameMap(addonsQuery.data ?? []),
    [addonsQuery.data],
  )

  const providers = useMemo<readonly TurnProviderRow[]>(
    () =>
      (providersQuery.data ?? []).map((p) => ({
        addonId: p.addonId,
        displayName: displayNames.get(p.addonId) ?? p.addonId,
        isActive: p.isActive,
      })),
    [providersQuery.data, displayNames],
  )

  const groups: readonly IntegrationGroup[] = [
    {
      id: CAPABILITY,
      label: t('system.turnServers.turnProviders', 'TURN providers'),
      install: {
        capability: CAPABILITY,
        label: t('system.turnServers.addProvider', 'Add provider'),
      },
      entries: providers.map((p) => ({
        id: p.addonId,
        name: p.displayName,
        fallbackIcon: Network,
        ...providerPillState(p.isActive),
        render: () => (
          <AddonIntegrationBody
            addonId={p.addonId}
            displayName={p.displayName}
            capName={CAPABILITY}
            isActive={p.isActive}
            panels={[
              {
                id: 'ice-servers',
                title: t('system.turnServers.discoveredIceServers', 'Discovered ICE servers'),
                icon: Network,
                content: <TurnProviderIceChips addonId={p.addonId} enabled={p.isActive} />,
              },
            ]}
          />
        ),
      })),
    },
  ]

  return (
    <IntegrationHub
      embedded
      icon={Network}
      title={t('system.turnServers.turnServers', 'TURN Servers')}
      subtitle={t(
        'system.turnServers.iceServersUsedForWebrtc',
        'ICE servers used for WebRTC NAT traversal. Multiple providers can coexist — the WebRTC layer concatenates servers from all enabled providers per session.',
      )}
      groups={groups}
      isLoading={providersQuery.isLoading}
      emptyTitle={t('system.turnServers.noTurnProvidersInstalled', 'No TURN providers installed')}
      emptyDescription={t(
        'system.turnServers.installATurnAddonE',
        'Install a TURN addon (e.g. @camstack/addon-cloudflare) to enable WebRTC behind restrictive NATs.',
      )}
      trailing={
        // Page-level, not the selected provider's: the union of every ENABLED
        // provider, which is what a WebRTC session actually receives.
        <SectionCard
          headingId="turn-combined-ice"
          title={t(
            'system.turnServers.combinedIceServerListAll',
            'Combined ICE server list — all enabled providers',
          )}
          icon={Network}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => allServersQuery.refetch()}
              disabled={allServersQuery.isFetching}
            >
              {t('common.refresh', 'Refresh')}
            </Button>
          }
        >
          <div className={SECTION_BODY}>
            {allServers.length === 0 ? (
              <div className="text-xs text-foreground-subtle">
                {t(
                  'system.turnServers.noServersFromEnabledProviders',
                  'No servers from enabled providers.',
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {allServers.map((s, groupIdx) => {
                  const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
                  return (
                    <div key={groupIdx} className="rounded border border-border bg-surface">
                      {(s.username || s.credential) && (
                        <div className="px-3 py-1.5 border-b border-border text-[10px] font-mono text-foreground-subtle flex items-center gap-3">
                          {s.username && (
                            <span>
                              <span className="text-foreground-subtle">user:</span>{' '}
                              <span className="text-foreground">{s.username}</span>
                            </span>
                          )}
                          {s.credential && (
                            <span>
                              {/* Never reveal the TURN credential (or its length/prefix) in the UI. */}
                              <span className="text-foreground-subtle">credential:</span>{' '}
                              <span className="text-foreground">••••••••</span>
                            </span>
                          )}
                        </div>
                      )}
                      <ul className="divide-y divide-border">
                        {urls.map((u) => (
                          <li
                            key={u}
                            className="px-3 py-1.5 font-mono text-xs text-foreground break-all"
                          >
                            {u}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </SectionCard>
      }
    />
  )
}

/**
 * The `ice-servers` panel of one TURN provider — a live ICE-URL chip list.
 * Enabled providers fetch `turnProvider.getTurnServers` scoped with
 * `{ addonId }`; a disabled provider is not asked (it should not make outbound
 * API calls just to render an admin page) and the panel says so.
 */
function TurnProviderIceChips({
  addonId,
  enabled,
}: {
  readonly addonId: string
  readonly enabled: boolean
}): ReactElement {
  const serversQuery = useTurnProviderGetTurnServers({ addonId }, { enabled, retry: false })
  const urls = useMemo(() => flattenUrls(serversQuery.data ?? []), [serversQuery.data])

  const note = !enabled
    ? 'Disabled — enable the provider to fetch its servers.'
    : serversQuery.isLoading
      ? 'Loading…'
      : urls.length === 0
        ? 'This provider returned no servers.'
        : null

  return (
    <div className="rounded-lg border border-border bg-surface p-2 sm:p-3">
      {note !== null ? (
        <div className="text-xs text-foreground-subtle">{note}</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {urls.map((u) => (
            <span
              key={u}
              className="inline-block break-all rounded bg-foreground-subtle/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            >
              {u}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
