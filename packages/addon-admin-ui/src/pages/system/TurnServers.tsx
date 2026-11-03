/**
 * TURN servers page — Network → TURN Servers.
 *
 * A `<InstancesTable>` over `turn-provider`: a static (coturn) server is a row per
 * `integration-instances` record, created from a provider picker; Cloudflare TURN is one account
 * row. The ICE servers a WebRTC session receives are the union across the ENABLED rows (the
 * `turn-provider` auto-mount aggregates them); the "Combined ICE server list" card below the panel
 * shows exactly that union. Nothing about a provider is hard-coded here.
 */
import { Network } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  SECTION_BODY,
  SectionCard,
  useTurnProviderGetTurnServers,
} from '@camstack/ui-library'
import { InstancesTable } from '../../components/instances/InstancesTable'

export function TurnServersPage(): ReactElement {
  const { t } = useTranslation()
  // No `addonId` -> the auto-mount aggregate: union across enabled providers.
  const allServersQuery = useTurnProviderGetTurnServers()
  const allServers = allServersQuery.data ?? []
  return (
    <div className="flex flex-col gap-4">
      <InstancesTable
        functionCap="turn-provider"
        icon={Network}
        title={t('system.turnServers.turnServers', 'TURN Servers')}
        subtitle={t(
          'system.turnServers.iceServersUsedForWebrtc',
          'ICE servers used for WebRTC NAT traversal. Multiple providers can coexist — the WebRTC layer concatenates servers from all enabled providers per session.',
        )}
        emptyTitle={t('system.turnServers.noTurnProvidersInstalled', 'No TURN providers installed')}
        emptyDescription={t(
          'system.turnServers.installATurnAddonE',
          'Install a TURN addon (e.g. @camstack/addon-cloudflare) to enable WebRTC behind restrictive NATs.',
        )}
        addLabel={t('system.turnServers.addProvider', 'Add provider')}
      />
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
    </div>
  )
}
