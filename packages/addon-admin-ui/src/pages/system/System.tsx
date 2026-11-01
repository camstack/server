/**
 * System — Settings / Capabilities under SectionedPage (OSD template).
 */
import { Settings as SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import { navChromeForPath } from '../../lib/nav-items'
import { SYSTEM_PAGE_PATH, secretsTabHref, type SystemTab } from '../../lib/system-page-url'
import { CapabilitiesPage } from './Capabilities'
import { SettingsPage } from './Settings'

export function SystemPage() {
  const { t } = useTranslation()
  const chrome = navChromeForPath(SYSTEM_PAGE_PATH, { t, isAdmin: true }) ?? {
    icon: SettingsIcon,
    title: t('system.systemNav', 'System'),
  }

  const { search, hash } = useLocation()
  // `?tab=secrets` was this page's Secrets tab before it moved to Data.
  if (new URLSearchParams(search).get('tab') === 'secrets') {
    return <Navigate replace to={`${secretsTabHref(search)}${hash}`} />
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
          id: 'capabilities',
          label: t('system.system.capabilities', 'Capabilities'),
          content: <CapabilitiesPage />,
        },
      ]}
    />
  )
}
