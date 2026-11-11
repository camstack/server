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
 * on the hub automatically surfaces its scoped forms (`listScopedSettings`) here
 * without touching this file. A section whose capability an InstancesTable
 * already shows is that page's: the panel drops it. The sign-in policy is a
 * bootstrap section, and the unscoped form leaves it on Identity → Authentication.
 *
 * The last group is per-user, not per-hub: Units (an account preference) and
 * a read-only list of the active keyboard shortcuts.
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
import { BootstrapSettingsForm } from '../../components/system/BootstrapSettingsForm'
import { HotkeysCard } from '../../components/settings/HotkeysCard'
import { SiteLocationCard } from '../../components/settings/SiteLocationCard'
import { UnitsSection } from '../../components/settings/UnitsSection'
import { useTranslation } from 'react-i18next'

/** The hub addon whose form is the bootstrap form, not an addon-settings pane. */
const SYSTEM_CONFIG_ADDON_ID = 'system-config'

export function SettingsPage() {
  const { t } = useTranslation()
  // Needs the hub's addon id list — the roster carries it (D317).
  const { nodes: clusterNodes, isLoading } = useClusterNodes()

  const hub = clusterNodes.find((n) => n.isHub && n.isOnline)
  // `system-config` is not an addon-settings addon: its form is the bootstrap form below.
  const addonIds = (hub?.addons.map((a) => a.addonId) ?? []).filter(
    (id) => id !== SYSTEM_CONFIG_ADDON_ID,
  )

  return (
    <AdminPage embedded>
      <SiteLocationCard />
      {isLoading ? (
        <div className="text-foreground-subtle text-sm py-12 text-center">
          {t('admin.system.settings.loadingHubTopology', 'Loading hub topology…')}
        </div>
      ) : !hub ? (
        <div className="flex flex-col items-center justify-center text-foreground-subtle text-sm gap-2 py-12">
          <SettingsIcon className="h-8 w-8 opacity-30" />
          <p>{t('admin.system.settings.noOnlineHubNodeFound', 'No online hub node found.')}</p>
          <p className="text-xs">
            {t(
              'admin.system.settings.settingsWillAppearOnceThe',
              'Settings will appear once the hub is reachable.',
            )}
          </p>
        </div>
      ) : (
        <>
          <BootstrapSettingsForm
            emptyMessage={t(
              'admin.system.settings.bootstrapUnavailable',
              'Not available — the addon that owns the server settings did not answer.',
            )}
          />
          {addonIds.length === 0 ? (
            <div className="text-foreground-subtle text-sm py-12 text-center">
              {t(
                'admin.system.settings.noAddonsInstalledOnThe',
                'No addons installed on the hub yet.',
              )}
            </div>
          ) : (
            <NodeAddonsSettingsPanel nodeId={hub.id} addonIds={addonIds} level="global" />
          )}
        </>
      )}
      <section aria-labelledby="settings-per-user" className="mt-3 sm:mt-4 space-y-3 sm:space-y-4">
        <h2
          id="settings-per-user"
          className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle"
        >
          {t('systemPage.settings.perUser', 'Your settings')}
        </h2>
        <UnitsSection />
        <HotkeysCard />
      </section>
    </AdminPage>
  )
}
