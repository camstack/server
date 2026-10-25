/**
 * Data — Storage + Backup under one SectionedPage (OSD template).
 */
import { Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'
import { Navigate, useSearchParams } from 'react-router-dom'

import { navChromeForPath } from '../../lib/nav-items'
import { StoragePage } from './Storage'
import { BackupPage } from './Backup'
import { DataRecordsSection } from './DataRecordsSection'

/** Tabs that were merged into Records: `null` = the kinds view, else the `view` value. */
const LEGACY_TABS: Readonly<Record<string, string | null>> = {
  entries: null,
  'deleted-devices': 'deleted-devices',
}

export function DataPage() {
  const { t } = useTranslation()
  const chrome = navChromeForPath('/system/data', { t, isAdmin: true }) ?? {
    icon: Database,
    title: t('system.data', 'Data'),
  }

  const [params] = useSearchParams()
  const legacy = LEGACY_TABS[params.get('tab') ?? '']
  if (legacy !== undefined) {
    const next = new URLSearchParams(params)
    next.set('tab', 'records')
    if (legacy !== null) next.set('view', legacy)
    return <Navigate replace to={{ search: next.toString() }} />
  }

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      defaultSection="storage"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'storage',
          label: t('systemPage.data.storage', 'Storage'),
          content: <StoragePage />,
        },
        {
          id: 'records',
          label: t('systemPage.data.records', 'Records'),
          content: <DataRecordsSection />,
          ownedParams: ['view', 'recordsOwner', 'recordsKind', 'entryNew', 'entryEdit'],
        },
        {
          id: 'backup',
          label: t('systemPage.data.backup', 'Backup'),
          content: <BackupPage />,
        },
      ]}
    />
  )
}
