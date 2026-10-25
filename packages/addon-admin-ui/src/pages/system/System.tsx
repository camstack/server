/**
 * System — Settings / Secrets / Capabilities under SectionedPage (OSD template).
 */
import { Settings as SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import { navChromeForPath } from '../../lib/nav-items'
import { SYSTEM_PAGE_PATH, type SystemTab } from '../../lib/system-page-url'
import { CapabilitiesPage } from './Capabilities'
import { SecretsPage } from './Secrets'
import { SettingsPage } from './Settings'

export function SystemPage() {
  const { t } = useTranslation()
  const chrome = navChromeForPath(SYSTEM_PAGE_PATH, { t, isAdmin: true }) ?? {
    icon: SettingsIcon,
    title: t('system.systemNav', 'System'),
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      defaultSection={'settings' satisfies SystemTab}
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'settings',
          label: t('system.system.settings', 'Settings'),
          content: <SettingsPage />,
        },
        {
          id: 'secrets',
          label: t('system.system.secrets', 'Secrets'),
          content: <SecretsPage />,
          ownedParams: ['view'],
        },
        {
          id: 'capabilities',
          label: t('system.system.capabilities', 'Capabilities'),
          content: <CapabilitiesPage />,
        },
      ]}
    />
  )
}
