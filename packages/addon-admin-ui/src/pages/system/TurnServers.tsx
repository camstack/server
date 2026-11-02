/**
 * TURN servers page — Network → TURN Servers.
 *
 * A `<ProviderInstancesPanel>` over `turn-provider`: a static (coturn) server is a row per
 * `integration-instances` record, created from a provider picker; Cloudflare TURN is one account
 * row. The ICE servers a WebRTC session receives are the union across the ENABLED rows (the
 * `turn-provider` auto-mount aggregates them). Nothing about a provider is hard-coded here.
 */
import { Network } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ProviderInstancesPanel } from '../../components/integration-hub/provider-instances/ProviderInstancesPanel'

export function TurnServersPage(): ReactElement {
  const { t } = useTranslation()
  return (
    <ProviderInstancesPanel
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
  )
}
