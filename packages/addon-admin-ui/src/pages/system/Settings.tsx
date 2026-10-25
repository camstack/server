/**
 * Settings page — shortcut to the hub node's addon settings.
 *
 * Equivalent to navigating Cluster → hub → Settings tab, but surfaced as
 * a dedicated top-level nav entry so hub-wide knobs are one click away.
 * The hub is selected automatically from `nodes.topology` (the single
 * entry whose `isHub` is true); when there is no hub yet (initial boot /
 * agent-only deployments) we render an empty state rather than pretend.
 *
 * Everything below re-uses `NodeAddonsSettingsPanel` at `level: 'global'`
 * — same component the cluster's Settings sub-tab uses. Adding an addon
 * on the hub automatically surfaces its `getGlobalSettings()` here
 * without touching this file.
 *
 * `SiteLocationCard` sits ABOVE that panel and is the one hand-written
 * section here: the site coordinates are a fact of the installation, not
 * of any addon, so they are not an addon setting to aggregate. It renders
 * unconditionally — a hub that is offline or has no addons still has a
 * location, and the cap is server-provided so it answers regardless.
 */

import { useClusterNodes } from '@camstack/ui-library'
import { Settings as SettingsIcon } from 'lucide-react'
import { AdminPage } from '../../components/AdminPage'
import { NodeAddonsSettingsPanel } from '../../components/settings/NodeAddonsSettingsPanel'
import { SiteLocationCard } from '../../components/settings/SiteLocationCard'
import { useTranslation } from 'react-i18next'

export function SettingsPage() {
  const { t } = useTranslation()
  // Needs the hub's addon id list — the roster carries it (D317).
  const { nodes: clusterNodes, isLoading } = useClusterNodes()

  const hub = clusterNodes.find((n) => n.isHub && n.isOnline)
  const addonIds = hub?.addons.map((a) => a.addonId) ?? []

  return (
    <AdminPage embedded>
      <SiteLocationCard />
      {isLoading ? (
        <div className="text-muted-foreground text-sm py-12 text-center">
          {t('admin.system.settings.loadingHubTopology', 'Loading hub topology…')}
        </div>
      ) : !hub ? (
        <div className="flex flex-col items-center justify-center text-muted-foreground text-sm gap-2 py-12">
          <SettingsIcon className="h-8 w-8 opacity-30" />
          <p>{t('admin.system.settings.noOnlineHubNodeFound', 'No online hub node found.')}</p>
          <p className="text-xs">
            {t(
              'admin.system.settings.settingsWillAppearOnceThe',
              'Settings will appear once the hub is reachable.',
            )}
          </p>
        </div>
      ) : addonIds.length === 0 ? (
        <div className="text-muted-foreground text-sm py-12 text-center">
          {t('admin.system.settings.noAddonsInstalledOnThe', 'No addons installed on the hub yet.')}
        </div>
      ) : (
        <NodeAddonsSettingsPanel nodeId={hub.id} addonIds={addonIds} level="global" />
      )}
    </AdminPage>
  )
}
