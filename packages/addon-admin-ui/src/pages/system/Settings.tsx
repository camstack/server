/**
 * System → Settings — the installation's own settings: the site location, the
 * server (bootstrap) form, and the per-user group.
 *
 * Addon settings are NOT drawn here (#578). Each capability's cluster settings
 * live on the page about their subject — Pipeline, History, Notifications,
 * Nodes, a connection page — or in the addon's own settings dialog on the
 * Addons page; `lib/cluster-settings-claims.ts` says which, and
 * `scripts/check-cluster-settings-claimed.ts` keeps every schema claimed.
 *
 * The bootstrap form needs the hub: with no online hub yet (initial boot /
 * agent-only deployments) it shows an empty state rather than pretend.
 *
 * The last group is per-user, not per-hub: Units (an account preference) and
 * a read-only list of the active keyboard shortcuts.
 *
 * `DaylightPhaseCard` follows it: day or night, from the sun at that
 * location or from a light sensor.
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
import { BootstrapSettingsForm } from '../../components/system/BootstrapSettingsForm'
import { DaylightPhaseCard } from '../../components/settings/DaylightPhaseCard'
import { HotkeysCard } from '../../components/settings/HotkeysCard'
import { SiteLocationCard } from '../../components/settings/SiteLocationCard'
import { UnitsSection } from '../../components/settings/UnitsSection'
import { useTranslation } from 'react-i18next'

export function SettingsPage() {
  const { t } = useTranslation()
  const { nodes: clusterNodes, isLoading } = useClusterNodes()
  const hub = clusterNodes.find((n) => n.isHub && n.isOnline)

  return (
    <AdminPage embedded>
      <SiteLocationCard />
      <DaylightPhaseCard />
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
        <BootstrapSettingsForm
          emptyMessage={t(
            'admin.system.settings.bootstrapUnavailable',
            'Not available — the addon that owns the server settings did not answer.',
          )}
        />
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
