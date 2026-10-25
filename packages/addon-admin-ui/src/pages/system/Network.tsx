/**
 * Network — Local access (LAN HTTP) + Addresses + Remote Access + Mesh + TURN + Diagnostics.
 *
 * Shell is library `SectionedPage` (OSD template): sidebar title/icon, then
 * section Tabs. Each section body is embedded (no second page chrome).
 * Integration tabs keep `?integration=` / `?section=` via `ownedParams`.
 */
import { Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import { INTEGRATION_HUB_OWNED_PARAMS, INTEGRATION_HUB_PAGES } from '../../lib/integration-hub-url'
import { navChromeForPath } from '../../lib/nav-items'
import { RemoteAccessPage } from './RemoteAccess'
import { TurnServersPage } from './TurnServers'
import { NetworkAddressesPage } from './NetworkAddresses'
import { MeshNetworksPage } from './MeshNetworks'
import { HTTPS_CERTIFICATE_HREF, LocalAccessPage } from './LocalAccess'
import { NetworkDiagnosticsPage } from './NetworkDiagnostics'

/** Retired Network tabs: the HTTPS certificate now lives under Identity → Certificates. */
export const RETIRED_NETWORK_CERTIFICATE_TABS: readonly string[] = [
  'certificate',
  'certificates',
  'https',
]

export function NetworkPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  if (RETIRED_NETWORK_CERTIFICATE_TABS.includes(searchParams.get('tab') ?? '')) {
    return <Navigate to={HTTPS_CERTIFICATE_HREF} replace />
  }
  const chrome = navChromeForPath('/system/network', { t, isAdmin: true }) ?? {
    icon: Globe,
    title: t('system.network', 'Network'),
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      defaultSection="addresses"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'local-access',
          label: t('systemPage.network.localAccess', 'Local access'),
          content: <LocalAccessPage />,
        },
        {
          id: 'addresses',
          label: t('systemPage.network.networkAddresses', 'Network Addresses'),
          content: <NetworkAddressesPage />,
        },
        {
          id: INTEGRATION_HUB_PAGES.remoteAccess.tab,
          label: t('systemPage.network.remoteAccess', 'Remote Access'),
          content: <RemoteAccessPage />,
          ownedParams: INTEGRATION_HUB_OWNED_PARAMS,
        },
        {
          id: INTEGRATION_HUB_PAGES.mesh.tab,
          label: t('systemPage.network.meshNetworks', 'Mesh Networks'),
          content: <MeshNetworksPage />,
          ownedParams: INTEGRATION_HUB_OWNED_PARAMS,
        },
        {
          id: INTEGRATION_HUB_PAGES.turn.tab,
          label: t('systemPage.network.turnServers', 'TURN Servers'),
          content: <TurnServersPage />,
          ownedParams: INTEGRATION_HUB_OWNED_PARAMS,
        },
        {
          id: 'diagnostics',
          label: t('systemPage.network.diagnostics', 'Diagnostics'),
          content: <NetworkDiagnosticsPage />,
        },
      ]}
    />
  )
}
